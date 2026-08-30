//! Anonymous `client_id` discovery. Port of
//! `lib/core/api/client_id_resolver.dart`.
//!
//! SoundCloud's v2 API needs a `client_id` that is not published anywhere; the
//! web player embeds one in its JS bundles, so we scrape it from there and
//! cache it in prefs. Hitting `soundcloud.com` repeatedly gets the caller
//! throttled with bare, bodyless 400s, so every path through here is
//! single-flighted and the disk cache is preferred over a refetch.

use std::sync::Arc;

use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use regex::Regex;
use tokio::sync::Mutex;

use crate::core::storage::PrefsStore;

const PREFS_KEY: &str = "sc_client_id";

static VALID: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[0-9a-zA-Z]{32}$").unwrap());
static SCRIPT_SRC: Lazy<Regex> = Lazy::new(|| Regex::new(r#"<script[^>]+src="([^"]+)""#).unwrap());
static CLIENT_ID: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"client_id\s*:\s*"([0-9a-zA-Z]{32})""#).unwrap());

pub struct ClientIdResolver {
    http: reqwest::Client,
    prefs: Arc<PrefsStore>,
    /// Held across the whole resolve so concurrent callers queue behind one
    /// fetch instead of each scraping the homepage.
    cached: Mutex<Option<String>>,
}

impl ClientIdResolver {
    pub fn new(http: reqwest::Client, prefs: Arc<PrefsStore>) -> Self {
        Self {
            http,
            prefs,
            cached: Mutex::new(None),
        }
    }

    /// The current id, resolving it once if needed.
    pub async fn get(&self) -> Result<String> {
        let mut slot = self.cached.lock().await;
        if let Some(id) = slot.as_ref() {
            return Ok(id.clone());
        }
        let id = self.resolve(true).await?;
        *slot = Some(id.clone());
        Ok(id)
    }

    /// Drops the cached id and scrapes a fresh one. Called after a 401, which
    /// is how an expired id shows up.
    pub async fn refresh(&self) -> Result<String> {
        let mut slot = self.cached.lock().await;
        *slot = None;
        let id = self.resolve(false).await?;
        *slot = Some(id.clone());
        Ok(id)
    }

    async fn resolve(&self, use_stored: bool) -> Result<String> {
        if use_stored {
            if let Some(stored) = self.read_stored().await {
                return Ok(stored);
            }
        }
        let id = self.fetch().await?;
        // A failed write only costs us the next cold start.
        self.prefs.write_string(PREFS_KEY, &id).await.ok();
        Ok(id)
    }

    async fn read_stored(&self) -> Option<String> {
        let saved = self.prefs.read_string(PREFS_KEY).await?;
        let saved = saved.trim().to_string();
        VALID.is_match(&saved).then_some(saved)
    }

    /// Walks the homepage's script tags newest-last: the id lives in one of
    /// the trailing bundles, so scanning in reverse finds it in one or two
    /// requests instead of a dozen.
    async fn fetch(&self) -> Result<String> {
        let home = self
            .http
            .get("https://soundcloud.com/")
            .send()
            .await?
            .text()
            .await?;

        let scripts: Vec<&str> = SCRIPT_SRC
            .captures_iter(&home)
            .filter_map(|c| c.get(1).map(|m| m.as_str()))
            .filter(|src| src.starts_with("http"))
            .collect();

        for src in scripts.iter().rev() {
            let Ok(res) = self.http.get(*src).send().await else {
                continue;
            };
            let Ok(js) = res.text().await else { continue };
            if let Some(c) = CLIENT_ID.captures(&js) {
                if let Some(m) = c.get(1) {
                    return Ok(m.as_str().to_string());
                }
            }
        }
        Err(anyhow!("client_id not found in the soundcloud.com bundles"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_32_char_alphanumerics_are_accepted() {
        assert!(VALID.is_match("abcdefghij0123456789ABCDEFGHIJKL"));
        assert!(!VALID.is_match("too-short"));
        assert!(!VALID.is_match("has-a-dash-in-it-0123456789abcdef"));
        // 33 chars must not pass.
        assert!(!VALID.is_match("abcdefghij0123456789ABCDEFGHIJKLM"));
    }

    #[test]
    fn script_and_id_patterns_match_the_real_bundle_shape() {
        let html = r#"<script crossorigin src="https://a-v2.sndcdn.com/assets/0-a.js"></script>
                      <script src="/local/skip.js"></script>
                      <script crossorigin src="https://a-v2.sndcdn.com/assets/9-z.js"></script>"#;
        let found: Vec<&str> = SCRIPT_SRC
            .captures_iter(html)
            .filter_map(|c| c.get(1).map(|m| m.as_str()))
            .filter(|s| s.starts_with("http"))
            .collect();
        assert_eq!(found.len(), 2, "the relative src is skipped");
        assert!(found[1].ends_with("9-z.js"));

        let js = r#"...,client_id:"aBcDeFgHiJkLmNoPqRsTuVwXyZ012345",foo..."#;
        let id = CLIENT_ID.captures(js).unwrap().get(1).unwrap().as_str();
        assert_eq!(id, "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345");
        assert!(VALID.is_match(id));

        // Spaced variant that also appears in minified output.
        let spaced = r#"client_id : "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345""#;
        assert!(CLIENT_ID.is_match(spaced));
    }

    #[tokio::test]
    async fn a_valid_stored_id_is_used_without_touching_the_network() {
        let dir = std::env::temp_dir().join(format!("wf-cid-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let prefs = Arc::new(PrefsStore::new(&dir));
        prefs
            .write_string(PREFS_KEY, "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345")
            .await
            .unwrap();

        let r = ClientIdResolver::new(reqwest::Client::new(), prefs.clone());
        assert_eq!(
            r.get().await.unwrap(),
            "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345",
            "a cached id must not trigger a scrape"
        );

        // A malformed stored id is ignored rather than sent to the API.
        prefs.write_string(PREFS_KEY, "garbage").await.unwrap();
        let r2 = ClientIdResolver::new(reqwest::Client::new(), prefs);
        assert!(r2.read_stored().await.is_none());

        std::fs::remove_dir_all(&dir).ok();
    }
}
