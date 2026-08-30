//! On-disk state. Port of `lib/core/storage/prefs_store.dart` and
//! `token_store.dart`.
//!
//! Both stores take their base directory by construction rather than reaching
//! for the platform path themselves, so they are testable against a tempdir
//! and the app resolves the real location once at startup.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, Duration, Utc};
use serde_json::{Map, Value};
use tokio::sync::Mutex;

const PREFS_FILE: &str = "prefs.json";
const TOKEN_FILE: &str = "sc_oauth_token";

/// A flat JSON object of small settings, rewritten whole on every change.
pub struct PrefsStore {
    path: PathBuf,
    /// Serialises read-modify-write so two concurrent writes cannot drop one
    /// another's key. The Dart original raced here.
    lock: Mutex<()>,
}

impl PrefsStore {
    pub fn new(base: impl AsRef<Path>) -> Self {
        Self {
            path: base.as_ref().join(PREFS_FILE),
            lock: Mutex::new(()),
        }
    }

    async fn load(&self) -> Map<String, Value> {
        let Ok(raw) = tokio::fs::read_to_string(&self.path).await else {
            return Map::new();
        };
        match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(m)) => m,
            _ => Map::new(),
        }
    }

    pub async fn read_string(&self, key: &str) -> Option<String> {
        match self.load().await.get(key) {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        }
    }

    pub async fn read_bool(&self, key: &str) -> Option<bool> {
        match self.load().await.get(key) {
            Some(Value::Bool(b)) => Some(*b),
            _ => None,
        }
    }

    pub async fn read_i64(&self, key: &str) -> Option<i64> {
        match self.load().await.get(key) {
            Some(Value::Number(n)) => n.as_i64(),
            Some(Value::String(s)) => s.parse().ok(),
            _ => None,
        }
    }

    pub async fn write_string(&self, key: &str, value: &str) -> Result<()> {
        self.write(key, Value::String(value.to_string())).await
    }

    pub async fn write_bool(&self, key: &str, value: bool) -> Result<()> {
        self.write(key, Value::Bool(value)).await
    }

    pub async fn write_i64(&self, key: &str, value: i64) -> Result<()> {
        self.write(key, Value::Number(value.into())).await
    }

    async fn write(&self, key: &str, value: Value) -> Result<()> {
        let _guard = self.lock.lock().await;
        let mut m = self.load().await;
        m.insert(key.to_string(), value);
        self.flush(&m).await
    }

    pub async fn remove(&self, key: &str) -> Result<()> {
        let _guard = self.lock.lock().await;
        let mut m = self.load().await;
        if m.remove(key).is_none() {
            return Ok(());
        }
        self.flush(&m).await
    }

    async fn flush(&self, m: &Map<String, Value>) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        let body = serde_json::to_vec(m)?;
        // Write-then-rename: a crash mid-write leaves the old prefs intact
        // rather than a truncated file that parses as empty.
        let tmp = self.path.with_extension("json.tmp");
        tokio::fs::write(&tmp, &body)
            .await
            .with_context(|| format!("writing {}", tmp.display()))?;
        tokio::fs::rename(&tmp, &self.path)
            .await
            .with_context(|| format!("replacing {}", self.path.display()))?;
        Ok(())
    }
}

/// An OAuth token as persisted. Port of `StoredToken`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredToken {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
}

impl StoredToken {
    pub fn new(access_token: impl Into<String>) -> Self {
        Self {
            access_token: access_token.into(),
            refresh_token: None,
            expires_at: None,
        }
    }

    /// Treated as expired a minute early so a request in flight cannot land
    /// on a token that dies mid-call.
    pub fn is_expired(&self) -> bool {
        match self.expires_at {
            None => false,
            Some(at) => Utc::now() > at - Duration::minutes(1),
        }
    }

    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("access_token".into(), Value::String(self.access_token.clone()));
        if let Some(r) = &self.refresh_token {
            m.insert("refresh_token".into(), Value::String(r.clone()));
        }
        if let Some(e) = self.expires_at {
            m.insert("expires_at".into(), Value::String(e.to_rfc3339()));
        }
        Value::Object(m)
    }

    /// Accepts both shapes the app has written: a bare token string from the
    /// early builds, and the JSON envelope written since refresh landed.
    pub fn parse(raw: &str) -> Option<Self> {
        let text = raw.trim();
        if text.is_empty() {
            return None;
        }
        if !text.starts_with('{') {
            return Some(Self::new(text));
        }
        let v: Value = serde_json::from_str(text).ok()?;
        let access = v.get("access_token")?.as_str()?.trim().to_string();
        if access.is_empty() {
            return None;
        }
        Some(Self {
            access_token: access,
            refresh_token: v
                .get("refresh_token")
                .and_then(Value::as_str)
                .map(str::to_string),
            expires_at: v
                .get("expires_at")
                .and_then(Value::as_str)
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.with_timezone(&Utc)),
        })
    }
}

pub struct TokenStore {
    path: PathBuf,
}

impl TokenStore {
    pub fn new(base: impl AsRef<Path>) -> Self {
        Self {
            path: base.as_ref().join(TOKEN_FILE),
        }
    }

    pub async fn read(&self) -> Option<StoredToken> {
        let raw = tokio::fs::read_to_string(&self.path).await.ok()?;
        StoredToken::parse(&raw)
    }

    pub async fn write(&self, token: &StoredToken) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        tokio::fs::write(&self.path, serde_json::to_vec(&token.to_json())?)
            .await
            .with_context(|| format!("writing {}", self.path.display()))?;
        Ok(())
    }

    pub async fn delete(&self) -> Result<()> {
        match tokio::fs::remove_file(&self.path).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e).context("deleting the stored token"),
        }
    }

    /// Carries a session over from the Flutter build, which kept its state in
    /// `%APPDATA%\SoundCloud Desktop\SoundCloud Desktop\`. Runs once: if this
    /// build already has a token, the old one is ignored.
    pub async fn migrate_from(&self, legacy_dir: &Path) -> bool {
        if tokio::fs::metadata(&self.path).await.is_ok() {
            return false;
        }
        let legacy = legacy_dir.join(TOKEN_FILE);
        let Ok(raw) = tokio::fs::read_to_string(&legacy).await else {
            return false;
        };
        let Some(token) = StoredToken::parse(&raw) else {
            return false;
        };
        self.write(&token).await.is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wf-store-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn prefs_round_trip_and_survive_a_corrupt_file() {
        let dir = tmpdir("prefs");
        let store = PrefsStore::new(&dir);

        assert_eq!(store.read_string("missing").await, None);
        store.write_string("sc_client_id", "abc").await.unwrap();
        store.write_bool("flag", true).await.unwrap();
        store.write_i64("playback_crossfade_ms", 2500).await.unwrap();

        assert_eq!(store.read_string("sc_client_id").await.as_deref(), Some("abc"));
        assert_eq!(store.read_bool("flag").await, Some(true));
        assert_eq!(store.read_i64("playback_crossfade_ms").await, Some(2500));
        // Wrong-typed reads are None rather than an error.
        assert_eq!(store.read_bool("sc_client_id").await, None);

        store.remove("flag").await.unwrap();
        assert_eq!(store.read_bool("flag").await, None);
        // Removing what is not there is a no-op, not a failure.
        store.remove("flag").await.unwrap();

        // Garbage on disk reads as empty, and a later write repairs it.
        tokio::fs::write(dir.join(PREFS_FILE), b"{not json").await.unwrap();
        assert_eq!(store.read_string("sc_client_id").await, None);
        store.write_string("k", "v").await.unwrap();
        assert_eq!(store.read_string("k").await.as_deref(), Some("v"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stored_token_parses_both_legacy_and_json_shapes() {
        let bare = StoredToken::parse("  raw-token-value  ").unwrap();
        assert_eq!(bare.access_token, "raw-token-value");
        assert!(bare.refresh_token.is_none() && !bare.is_expired());

        let full = StoredToken::parse(
            r#"{"access_token":"a","refresh_token":"r","expires_at":"2030-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        assert_eq!(full.access_token, "a");
        assert_eq!(full.refresh_token.as_deref(), Some("r"));
        assert!(!full.is_expired(), "2030 is not expired yet");

        assert!(StoredToken::parse("").is_none());
        assert!(StoredToken::parse("   ").is_none());
        assert!(StoredToken::parse(r#"{"access_token":""}"#).is_none());
        assert!(StoredToken::parse("{broken").is_none());
    }

    #[test]
    fn expiry_has_a_one_minute_safety_margin() {
        let almost = StoredToken {
            access_token: "a".into(),
            refresh_token: None,
            expires_at: Some(Utc::now() + Duration::seconds(30)),
        };
        assert!(almost.is_expired(), "inside the margin counts as expired");

        let fine = StoredToken {
            access_token: "a".into(),
            refresh_token: None,
            expires_at: Some(Utc::now() + Duration::minutes(10)),
        };
        assert!(!fine.is_expired());
    }

    #[tokio::test]
    async fn token_store_round_trip_and_legacy_migration() {
        let dir = tmpdir("token");
        let legacy = tmpdir("token-legacy");
        let store = TokenStore::new(&dir);

        assert!(store.read().await.is_none());
        // Deleting nothing is fine.
        store.delete().await.unwrap();

        // A Flutter-era bare token file is adopted.
        tokio::fs::write(legacy.join(TOKEN_FILE), b"legacy-token").await.unwrap();
        assert!(store.migrate_from(&legacy).await);
        assert_eq!(store.read().await.unwrap().access_token, "legacy-token");

        // Migration never overwrites a token this build already has.
        assert!(!store.migrate_from(&legacy).await);

        let t = StoredToken {
            access_token: "new".into(),
            refresh_token: Some("r".into()),
            expires_at: Some(Utc::now() + Duration::hours(1)),
        };
        store.write(&t).await.unwrap();
        let back = store.read().await.unwrap();
        assert_eq!(back.access_token, "new");
        assert_eq!(back.refresh_token.as_deref(), Some("r"));

        store.delete().await.unwrap();
        assert!(store.read().await.is_none());

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&legacy).ok();
    }
}
