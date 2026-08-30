//! Last.fm scrobbling. Port of `lib/core/lastfm/*.dart`.
//!
//! The API key and shared secret are build-time values, exactly as the Dart
//! `String.fromEnvironment` constants were: a build without them reports
//! `is_configured() == false` and every call becomes a no-op rather than an
//! error, so the feature simply stays hidden.

use anyhow::{anyhow, Result};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};

pub const API_ROOT: &str = "https://ws.audioscrobbler.com/2.0/";

fn api_key() -> &'static str {
    option_env!("LASTFM_API_KEY").unwrap_or("")
}

fn shared_secret() -> &'static str {
    option_env!("LASTFM_SHARED_SECRET").unwrap_or("")
}

pub fn is_configured() -> bool {
    !api_key().is_empty() && !shared_secret().is_empty()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LastfmSession {
    pub key: String,
    pub name: String,
}

pub struct LastfmClient {
    http: reqwest::Client,
}

impl LastfmClient {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }

    /// Last.fm's `api_sig`: every parameter but `format`, sorted by name,
    /// concatenated as `keyvalue` with no separators, then the shared secret,
    /// hashed with MD5.
    fn sign(params: &[(String, String)]) -> String {
        let mut sorted: Vec<&(String, String)> = params.iter().collect();
        sorted.sort_by(|a, b| a.0.cmp(&b.0));

        let mut buf = String::new();
        for (k, v) in sorted {
            buf.push_str(k);
            buf.push_str(v);
        }
        buf.push_str(shared_secret());

        hex::encode(Md5::digest(buf.as_bytes()))
    }

    async fn get(&self, params: Vec<(String, String)>) -> Result<serde_json::Value> {
        let mut q = params;
        q.push(("api_key".into(), api_key().into()));
        q.push(("format".into(), "json".into()));
        Ok(self.http.get(API_ROOT).query(&q).send().await?.json().await?)
    }

    async fn post(&self, params: Vec<(String, String)>) -> Result<serde_json::Value> {
        let mut signed = params;
        signed.push(("api_key".into(), api_key().into()));
        // The signature covers everything except `format`, which is appended
        // only after signing.
        let sig = Self::sign(&signed);
        signed.push(("api_sig".into(), sig));
        signed.push(("format".into(), "json".into()));

        Ok(self
            .http
            .post(API_ROOT)
            .form(&signed)
            .send()
            .await?
            .json()
            .await?)
    }

    pub async fn get_auth_token(&self) -> Result<Option<String>> {
        if !is_configured() {
            return Ok(None);
        }
        let res = self
            .get(vec![("method".into(), "auth.getToken".into())])
            .await?;
        Ok(res
            .get("token")
            .and_then(|v| v.as_str())
            .map(str::to_string))
    }

    pub async fn get_session(&self, token: &str) -> Result<Option<LastfmSession>> {
        if !is_configured() {
            return Ok(None);
        }
        let res = self
            .post(vec![
                ("method".into(), "auth.getSession".into()),
                ("token".into(), token.into()),
            ])
            .await?;
        let session = res.get("session");
        let key = session
            .and_then(|s| s.get("key"))
            .and_then(|v| v.as_str());
        let name = session
            .and_then(|s| s.get("name"))
            .and_then(|v| v.as_str());
        Ok(match (key, name) {
            (Some(k), Some(n)) => Some(LastfmSession {
                key: k.into(),
                name: n.into(),
            }),
            _ => None,
        })
    }

    /// The authorisation URL the user opens to approve a request token.
    pub fn auth_url(token: &str) -> Result<String> {
        if !is_configured() {
            return Err(anyhow!("last.fm is not configured in this build"));
        }
        Ok(format!(
            "https://www.last.fm/api/auth/?api_key={}&token={}",
            urlencoding::encode(api_key()),
            urlencoding::encode(token)
        ))
    }

    pub async fn update_now_playing(
        &self,
        artist: &str,
        track: &str,
        duration_secs: i64,
        album: Option<&str>,
        session_key: &str,
    ) -> Result<()> {
        if !is_configured() {
            return Ok(());
        }
        let mut params = vec![
            ("method".into(), "track.updateNowPlaying".into()),
            ("artist".into(), artist.into()),
            ("track".into(), track.into()),
            ("duration".into(), duration_secs.to_string()),
            ("sk".into(), session_key.into()),
        ];
        if let Some(a) = album.filter(|a| !a.is_empty()) {
            params.push(("album".into(), a.into()));
        }
        self.post(params).await?;
        Ok(())
    }

    pub async fn scrobble(
        &self,
        artist: &str,
        track: &str,
        started_at_unix: i64,
        duration_secs: Option<i64>,
        album: Option<&str>,
        session_key: &str,
    ) -> Result<()> {
        if !is_configured() {
            return Ok(());
        }
        let mut params = vec![
            ("method".into(), "track.scrobble".into()),
            ("artist".into(), artist.into()),
            ("track".into(), track.into()),
            ("timestamp".into(), started_at_unix.to_string()),
            ("sk".into(), session_key.into()),
        ];
        if let Some(d) = duration_secs {
            params.push(("duration".into(), d.to_string()));
        }
        if let Some(a) = album.filter(|a| !a.is_empty()) {
            params.push(("album".into(), a.into()));
        }
        self.post(params).await?;
        Ok(())
    }
}

/// Decides when a playing track has earned a scrobble. Port of the timing
/// rules in `scrobbler.dart`, kept pure so they are testable without a player.
#[derive(Debug, Clone, Default)]
pub struct ScrobbleGate {
    current_track_id: Option<String>,
    now_playing_sent: bool,
    scrobbled: bool,
}

/// Last.fm's own rule: half the track, or four minutes, whichever comes first.
const SCROBBLE_AFTER_MS: i64 = 4 * 60 * 1000;
/// Enough playback to be sure this is a real listen, not a scrub past.
const NOW_PLAYING_AFTER_SECS: i64 = 3;

#[derive(Debug, PartialEq, Eq)]
pub struct GateDecision {
    pub send_now_playing: bool,
    pub send_scrobble: bool,
}

impl ScrobbleGate {
    /// Feeds one player tick in. Returns which calls, if any, are now due;
    /// each fires at most once per track.
    pub fn observe(
        &mut self,
        track_id: Option<&str>,
        is_playing: bool,
        position_ms: i64,
        duration_ms: i64,
        elapsed_secs: i64,
    ) -> GateDecision {
        let mut out = GateDecision {
            send_now_playing: false,
            send_scrobble: false,
        };

        let Some(id) = track_id else {
            self.reset(None);
            return out;
        };
        if self.current_track_id.as_deref() != Some(id) {
            self.reset(Some(id.to_string()));
        }

        if !self.now_playing_sent && is_playing && elapsed_secs >= NOW_PLAYING_AFTER_SECS {
            self.now_playing_sent = true;
            out.send_now_playing = true;
        }

        if !self.scrobbled {
            let reached_half = duration_ms > 0 && position_ms >= duration_ms / 2;
            if reached_half || position_ms >= SCROBBLE_AFTER_MS {
                self.scrobbled = true;
                out.send_scrobble = true;
            }
        }
        out
    }

    fn reset(&mut self, id: Option<String>) {
        self.current_track_id = id;
        self.now_playing_sent = false;
        self.scrobbled = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_sorts_by_key_and_appends_the_secret() {
        // With no secret compiled in, the hash is of the sorted body alone -
        // which is exactly what makes the ordering assertion meaningful.
        let params = vec![
            ("track".to_string(), "b".to_string()),
            ("artist".to_string(), "a".to_string()),
            ("method".to_string(), "m".to_string()),
        ];
        let expected = hex::encode(Md5::digest(
            format!("artistamethodmtrackb{}", shared_secret()).as_bytes(),
        ));
        assert_eq!(LastfmClient::sign(&params), expected);

        // Order of the input must not matter.
        let reordered = vec![
            ("method".to_string(), "m".to_string()),
            ("artist".to_string(), "a".to_string()),
            ("track".to_string(), "b".to_string()),
        ];
        assert_eq!(LastfmClient::sign(&params), LastfmClient::sign(&reordered));
    }

    #[test]
    fn gate_sends_now_playing_once_after_three_seconds() {
        let mut g = ScrobbleGate::default();
        // Too early.
        assert!(!g.observe(Some("1"), true, 500, 200_000, 1).send_now_playing);
        // Paused at the threshold still does not count.
        assert!(!g.observe(Some("1"), false, 3_000, 200_000, 4).send_now_playing);
        // Playing and past the threshold.
        assert!(g.observe(Some("1"), true, 3_000, 200_000, 3).send_now_playing);
        // Never twice for the same track.
        assert!(!g.observe(Some("1"), true, 9_000, 200_000, 9).send_now_playing);
    }

    #[test]
    fn gate_scrobbles_at_half_the_track() {
        let mut g = ScrobbleGate::default();
        let dur = 200_000;
        assert!(!g.observe(Some("1"), true, 99_000, dur, 99).send_scrobble);
        assert!(g.observe(Some("1"), true, 100_000, dur, 100).send_scrobble);
        assert!(!g.observe(Some("1"), true, 150_000, dur, 150).send_scrobble);
    }

    #[test]
    fn gate_scrobbles_a_long_track_at_four_minutes() {
        let mut g = ScrobbleGate::default();
        let dur = 60 * 60 * 1000; // an hour-long mix: half would never arrive
        assert!(!g.observe(Some("1"), true, 3 * 60 * 1000, dur, 180).send_scrobble);
        assert!(g.observe(Some("1"), true, 4 * 60 * 1000, dur, 240).send_scrobble);
    }

    #[test]
    fn gate_resets_on_track_change_and_on_stop() {
        let mut g = ScrobbleGate::default();
        g.observe(Some("1"), true, 100_000, 200_000, 100);
        assert!(g.scrobbled);

        // A new track re-arms both.
        let d = g.observe(Some("2"), true, 100_000, 200_000, 100);
        assert!(d.send_scrobble, "the next track can scrobble too");

        // Clearing the track resets the gate entirely.
        g.observe(None, false, 0, 0, 0);
        assert!(g.current_track_id.is_none() && !g.scrobbled && !g.now_playing_sent);
    }

    #[test]
    fn a_zero_duration_track_still_scrobbles_on_the_four_minute_rule() {
        // Live streams report no duration; the half-track rule cannot apply.
        let mut g = ScrobbleGate::default();
        assert!(!g.observe(Some("1"), true, 1_000, 0, 1).send_scrobble);
        assert!(g.observe(Some("1"), true, SCROBBLE_AFTER_MS, 0, 240).send_scrobble);
    }
}
