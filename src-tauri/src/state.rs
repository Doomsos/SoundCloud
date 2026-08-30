//! Process-wide services, assembled once at startup.
//!
//! This is what Riverpod's provider graph did in the Dart build: one place
//! that wires the HTTP client, the stores and the API together, with the
//! sharing rules made explicit instead of implied by provider scope.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use tokio::sync::RwLock;

use crate::api::client::{AuthState, SoundcloudApi};
use crate::api::client_id::ClientIdResolver;
use crate::core::cache::{AudioCache, DEFAULT_MAX_BYTES};
use crate::core::lastfm::LastfmClient;
use crate::core::log::LogHistory;
use crate::core::storage::{PrefsStore, StoredToken, TokenStore};

/// SoundCloud rejects requests from clients it does not recognise, and the
/// media CDN is picky about the same. This is the string the web player sends.
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

pub struct AppState {
    pub http: reqwest::Client,
    pub prefs: Arc<PrefsStore>,
    pub tokens: Arc<TokenStore>,
    pub ids: Arc<ClientIdResolver>,
    pub auth: Arc<RwLock<AuthState>>,
    pub api: Arc<SoundcloudApi>,
    pub cache: Arc<AudioCache>,
    pub lastfm: Arc<LastfmClient>,
    pub logs: LogHistory,
    pub data_dir: PathBuf,
}

impl AppState {
    pub fn new(data_dir: PathBuf, logs: LogHistory) -> Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(std::time::Duration::from_secs(30))
            // The API is chatty and mostly to one host; pooling keeps the
            // home screen's six parallel calls on one connection.
            .pool_max_idle_per_host(8)
            .build()?;

        let prefs = Arc::new(PrefsStore::new(&data_dir));
        let tokens = Arc::new(TokenStore::new(&data_dir));
        let ids = Arc::new(ClientIdResolver::new(http.clone(), prefs.clone()));
        let auth = Arc::new(RwLock::new(AuthState::default()));
        let api = Arc::new(SoundcloudApi::new(http.clone(), ids.clone(), auth.clone()));
        let cache = Arc::new(AudioCache::new(http.clone(), &data_dir, DEFAULT_MAX_BYTES));
        let lastfm = Arc::new(LastfmClient::new(http.clone()));

        Ok(Self {
            http,
            prefs,
            tokens,
            ids,
            auth,
            api,
            cache,
            lastfm,
            logs,
            data_dir,
        })
    }

    /// Loads a stored token into the live auth state. Returns whether the app
    /// starts signed in.
    pub async fn restore_auth(&self) -> bool {
        let Some(stored) = self.tokens.read().await else {
            tracing::info!("auth: no stored token");
            return false;
        };

        let expired = stored.is_expired();
        self.apply_token(&stored).await;
        tracing::info!("auth: restored token {}", mask(&stored.access_token));

        if expired && stored.refresh_token.is_some() {
            // Expired but refreshable: try once now rather than letting the
            // first API call fail.
            if let Err(e) = self.refresh_token().await {
                tracing::warn!("auth: refresh failed: {e}");
                self.sign_out().await;
                return false;
            }
        }
        true
    }

    pub async fn apply_token(&self, stored: &StoredToken) {
        {
            let mut a = self.auth.write().await;
            a.user_token = Some(stored.access_token.clone());
            a.refresh_token = stored.refresh_token.clone();
            a.expires_at = stored.expires_at;
        }
        // The memoised /me id belongs to whoever was signed in before.
        self.api.reset_identity().await;
    }

    pub async fn sign_in(&self, stored: StoredToken) -> Result<()> {
        self.apply_token(&stored).await;
        tracing::info!("auth: signIn token {}", mask(&stored.access_token));
        self.tokens.write(&stored).await
    }

    pub async fn sign_out(&self) {
        tracing::info!("auth: signOut");
        {
            let mut a = self.auth.write().await;
            a.user_token = None;
            a.refresh_token = None;
            a.expires_at = None;
        }
        self.api.reset_identity().await;
        if let Err(e) = self.tokens.delete().await {
            tracing::warn!("auth: could not delete the stored token: {e}");
        }
    }

    pub async fn refresh_token(&self) -> Result<()> {
        let refresh = self.auth.read().await.refresh_token.clone();
        let Some(refresh) = refresh else {
            anyhow::bail!("no refresh token");
        };
        let fresh = crate::api::auth::refresh(&self.http, &self.prefs, &refresh).await?;
        tracing::info!("auth: token refreshed");
        self.sign_in(StoredToken {
            access_token: fresh.access_token,
            // SoundCloud may or may not rotate the refresh token; keeping the
            // old one when it does not is what makes long sessions survive.
            refresh_token: fresh.refresh_token.or(Some(refresh)),
            expires_at: fresh.expires_at,
        })
        .await
    }

    pub async fn is_authenticated(&self) -> bool {
        self.auth.read().await.is_authenticated()
    }
}

/// Tokens end up in the in-app log view, so they are never printed whole.
fn mask(token: &str) -> String {
    if token.len() <= 10 {
        "***".into()
    } else {
        format!("{}...{}", &token[..6], &token[token.len() - 3..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masking_never_leaks_a_usable_token() {
        assert_eq!(mask("short"), "***");
        assert_eq!(mask("0123456789"), "***", "ten chars is still too short");
        let masked = mask("2-294538-abcdefghijklmnop");
        assert_eq!(masked, "2-2945...nop");
        assert!(!masked.contains("abcdefghij"));
    }

    #[tokio::test]
    async fn sign_out_clears_the_token_and_the_stored_file() {
        let dir = std::env::temp_dir().join(format!("wf-state-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = AppState::new(dir.clone(), LogHistory::new()).unwrap();

        assert!(!state.is_authenticated().await);

        state
            .sign_in(StoredToken::new("a-real-looking-token"))
            .await
            .unwrap();
        assert!(state.is_authenticated().await);
        assert!(state.tokens.read().await.is_some());

        state.sign_out().await;
        assert!(!state.is_authenticated().await);
        assert!(state.tokens.read().await.is_none(), "the file goes too");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn restore_reports_signed_out_when_there_is_no_token() {
        let dir = std::env::temp_dir().join(format!("wf-state-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = AppState::new(dir.clone(), LogHistory::new()).unwrap();
        assert!(!state.restore_auth().await);
        std::fs::remove_dir_all(&dir).ok();
    }
}
