//! SoundCloud OAuth (authorization code + PKCE). Port of
//! `lib/core/api/oauth_login.dart`, `oauth_config.dart` and the token half of
//! `soundcloud_auth.dart`.
//!
//! The Dart build spun up a `dart:io` HttpServer for the loopback callback;
//! this does the same with a one-shot tokio listener, so no extra HTTP crate
//! is pulled in for a server that handles exactly one request.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

use crate::core::storage::PrefsStore;

pub const AUTHORIZE_ENDPOINT: &str = "https://secure.soundcloud.com/authorize";
pub const TOKEN_ENDPOINT: &str = "https://secure.soundcloud.com/oauth/token";
const PREFS_CLIENT_ID: &str = "soundcloud_client_id";
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);

const UNRESERVED: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/// Compile-time overrides, matching the Dart `String.fromEnvironment` keys.
/// A build without them falls back to the id the user pastes into the sign-in
/// dialog, which is stored in prefs.
fn env_client_id() -> Option<&'static str> {
    option_env!("SOUNDCLOUD_CLIENT_ID").filter(|s| !s.is_empty())
}

fn client_secret() -> Option<&'static str> {
    option_env!("SOUNDCLOUD_CLIENT_SECRET").filter(|s| !s.is_empty())
}

pub fn redirect_port() -> u16 {
    option_env!("SOUNDCLOUD_REDIRECT_PORT")
        .and_then(|s| s.parse().ok())
        .unwrap_or(8080)
}

pub fn redirect_uri() -> String {
    format!("http://localhost:{}/callback", redirect_port())
}

/// True when the build carries its own client id and the user never has to
/// supply one.
pub fn is_compiled_in() -> bool {
    env_client_id().is_some()
}

pub async fn client_id(prefs: &PrefsStore) -> String {
    if let Some(id) = env_client_id() {
        return id.to_string();
    }
    prefs
        .read_string(PREFS_CLIENT_ID)
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

pub async fn save_client_id(prefs: &PrefsStore, id: &str) -> Result<()> {
    prefs.write_string(PREFS_CLIENT_ID, id.trim()).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthTokens {
    pub access_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
}

/// Runs the full browser sign-in and returns the exchanged tokens.
///
/// `open_url` is injected so the caller decides how a browser is launched -
/// the app hands in the Tauri opener plugin, tests hand in a closure that
/// drives the callback directly.
pub async fn sign_in<F, Fut>(
    http: &reqwest::Client,
    prefs: Arc<PrefsStore>,
    open_url: F,
) -> Result<OAuthTokens>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let cid = client_id(&prefs).await;
    if cid.is_empty() {
        bail!("no client_id set - add one in the sign-in dialog");
    }

    let verifier = random_string(64);
    let challenge = s256(&verifier);
    let state = random_string(24);
    let port = redirect_port();

    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .with_context(|| format!("port {port} is in use - free it and try again"))?;

    let auth_url = format!(
        "{AUTHORIZE_ENDPOINT}?client_id={}&redirect_uri={}&response_type=code\
         &code_challenge={}&code_challenge_method=S256&state={}",
        urlencoding::encode(&cid),
        urlencoding::encode(&redirect_uri()),
        urlencoding::encode(&challenge),
        urlencoding::encode(&state),
    );

    open_url(auth_url).await?;

    let code = tokio::time::timeout(CALLBACK_TIMEOUT, await_code(listener, &state))
        .await
        .map_err(|_| anyhow!("timed out waiting for the browser sign-in"))??;

    exchange(http, &cid, &code, &verifier).await
}

pub async fn refresh(
    http: &reqwest::Client,
    prefs: &PrefsStore,
    refresh_token: &str,
) -> Result<OAuthTokens> {
    let cid = client_id(prefs).await;
    if cid.is_empty() {
        bail!("no client_id set");
    }
    let mut form = vec![
        ("grant_type", "refresh_token".to_string()),
        ("client_id", cid),
        ("refresh_token", refresh_token.to_string()),
    ];
    if let Some(secret) = client_secret() {
        form.push(("client_secret", secret.to_string()));
    }
    post_token(http, form).await
}

async fn exchange(
    http: &reqwest::Client,
    client_id: &str,
    code: &str,
    verifier: &str,
) -> Result<OAuthTokens> {
    let mut form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("client_id", client_id.to_string()),
        ("redirect_uri", redirect_uri()),
        ("code_verifier", verifier.to_string()),
        ("code", code.to_string()),
    ];
    if let Some(secret) = client_secret() {
        form.push(("client_secret", secret.to_string()));
    }
    post_token(http, form).await
}

async fn post_token(
    http: &reqwest::Client,
    form: Vec<(&str, String)>,
) -> Result<OAuthTokens> {
    let res = http.post(TOKEN_ENDPOINT).form(&form).send().await?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.unwrap_or(serde_json::Value::Null);

    if !status.is_success() {
        // SoundCloud puts the useful part in error_description; surfacing the
        // bare status leaves the user with nothing to act on.
        let detail = body
            .get("error_description")
            .or_else(|| body.get("error"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("token exchange failed ({status})"));
        bail!(detail);
    }

    let access = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("token response had no access_token"))?;

    Ok(OAuthTokens {
        access_token: access.to_string(),
        refresh_token: body
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        expires_at: body
            .get("expires_in")
            .and_then(serde_json::Value::as_i64)
            .map(|s| Utc::now() + chrono::Duration::seconds(s)),
    })
}

/// Serves exactly the redirect, then closes. Anything without a `code` or
/// `error` gets a 404 so a stray favicon request cannot end the wait.
async fn await_code(listener: TcpListener, expect_state: &str) -> Result<String> {
    loop {
        let (stream, _) = listener.accept().await?;
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        if reader.read_line(&mut line).await.is_err() || line.is_empty() {
            continue;
        }

        let target = line.split_whitespace().nth(1).unwrap_or("/");
        let q = parse_query(target);
        let err = q.get("error");
        let code = q.get("code");

        if err.is_none() && code.is_none() {
            let mut stream = reader.into_inner();
            stream
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .ok();
            stream.shutdown().await.ok();
            continue;
        }

        let state_ok = q.get("state").map(String::as_str) == Some(expect_state);
        let ok = err.is_none() && state_ok && code.map(|c| !c.is_empty()).unwrap_or(false);
        let page = if ok {
            landing_page("signed in", "you can close this tab and go back to the app")
        } else {
            landing_page(
                "sign-in failed",
                err.map(String::as_str).unwrap_or("unexpected callback"),
            )
        };

        let mut stream = reader.into_inner();
        let res = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{}",
            page.len(),
            page
        );
        stream.write_all(res.as_bytes()).await.ok();
        stream.flush().await.ok();
        stream.shutdown().await.ok();

        return match (err, code) {
            (Some(e), _) => Err(anyhow!("SoundCloud returned \"{e}\"")),
            _ if !state_ok => Err(anyhow!("state mismatch - try signing in again")),
            (_, Some(c)) if !c.is_empty() => Ok(c.clone()),
            _ => Err(anyhow!("callback had no authorization code")),
        };
    }
}

fn parse_query(target: &str) -> HashMap<String, String> {
    let Some((_, qs)) = target.split_once('?') else {
        return HashMap::new();
    };
    qs.split('&')
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            Some((
                urlencoding::decode(k).ok()?.into_owned(),
                urlencoding::decode(v).ok()?.into_owned(),
            ))
        })
        .collect()
}

fn random_string(len: usize) -> String {
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| UNRESERVED[rng.gen_range(0..UNRESERVED.len())] as char)
        .collect()
}

fn s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn landing_page(title: &str, subtitle: &str) -> String {
    format!(
        "<!doctype html><meta charset=\"utf-8\">\
         <title>SoundCloud</title>\
         <body style=\"margin:0;display:grid;place-items:center;height:100vh;\
         background:#0A0A0A;color:#F5F5F5;\
         font-family:-apple-system,Segoe UI,Roboto,sans-serif\">\
         <div style=\"text-align:center\">\
         <div style=\"display:flex;gap:4px;justify-content:center;align-items:flex-end;\
         height:32px;margin-bottom:20px\">\
         <i style=\"width:4px;height:12px;background:#FF5500\"></i>\
         <i style=\"width:4px;height:26px;background:#FF5500\"></i>\
         <i style=\"width:4px;height:18px;background:#FF5500\"></i>\
         <i style=\"width:4px;height:32px;background:#FF5500\"></i>\
         <i style=\"width:4px;height:9px;background:#FF5500\"></i>\
         </div>\
         <h1 style=\"font-size:18px;margin:0 0 6px\">{}</h1>\
         <p style=\"font-size:12px;color:#888;margin:0;font-family:ui-monospace,\
         SFMono-Regular,Menlo,monospace\">{}</p>\
         </div></body>",
        html_escape(title),
        html_escape(subtitle)
    )
}

/// The subtitle can carry a server-supplied `error`, so it never goes into the
/// page raw.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_the_rfc7636_vector() {
        // RFC 7636 appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(s256(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn random_strings_are_unreserved_and_unique() {
        let a = random_string(64);
        let b = random_string(64);
        assert_eq!(a.len(), 64);
        assert_ne!(a, b, "two verifiers must not collide");
        assert!(a.bytes().all(|c| UNRESERVED.contains(&c)));
        // Unreserved means no percent-encoding is needed in the auth URL.
        assert_eq!(urlencoding::encode(&a), a);
    }

    #[test]
    fn query_parsing_handles_the_real_callback_shapes() {
        let q = parse_query("/callback?code=abc123&state=xyz");
        assert_eq!(q.get("code").map(String::as_str), Some("abc123"));
        assert_eq!(q.get("state").map(String::as_str), Some("xyz"));

        let e = parse_query("/callback?error=access_denied&state=xyz");
        assert_eq!(e.get("error").map(String::as_str), Some("access_denied"));
        assert!(e.get("code").is_none());

        // Percent-encoded values decode.
        let enc = parse_query("/callback?error=needs%20consent");
        assert_eq!(enc.get("error").map(String::as_str), Some("needs consent"));

        assert!(parse_query("/favicon.ico").is_empty());
    }

    #[test]
    fn landing_page_escapes_the_server_supplied_error() {
        let page = landing_page("sign-in failed", "<script>alert(1)</script>");
        assert!(!page.contains("<script>alert"));
        assert!(page.contains("&lt;script&gt;"));
    }

    #[test]
    fn redirect_uri_tracks_the_configured_port() {
        assert_eq!(redirect_uri(), format!("http://localhost:{}/callback", redirect_port()));
    }
}
