//! In-memory log history. Replaces Talker, whose only real job here was
//! backing the in-app `LogsScreen`.
//!
//! A `tracing` layer feeds a capped ring buffer that the frontend reads over
//! IPC, so the logs view keeps working without the app having to write a file
//! or the developer having to attach a console.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

/// Matches the Dart `TalkerSettings(maxHistoryItems: 1000)`.
const MAX_ENTRIES: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// Milliseconds since the Unix epoch, so the frontend can format it.
    pub at: i64,
    pub level: String,
    pub target: String,
    pub message: String,
}

#[derive(Clone, Default)]
pub struct LogHistory(Arc<Mutex<Vec<LogEntry>>>);

impl LogHistory {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&self, entry: LogEntry) {
        let Ok(mut buf) = self.0.lock() else { return };
        if buf.len() >= MAX_ENTRIES {
            // Drop the oldest quarter at once rather than shifting the whole
            // vector on every single line past the cap.
            buf.drain(0..MAX_ENTRIES / 4);
        }
        buf.push(entry);
    }

    /// Newest first, which is the order the logs view renders.
    pub fn snapshot(&self) -> Vec<LogEntry> {
        let Ok(buf) = self.0.lock() else {
            return Vec::new();
        };
        buf.iter().rev().cloned().collect()
    }

    pub fn clear(&self) {
        if let Ok(mut buf) = self.0.lock() {
            buf.clear();
        }
    }
}

/// A `tracing` layer that mirrors every event into [`LogHistory`].
pub struct HistoryLayer(pub LogHistory);

impl<S: Subscriber> Layer<S> for HistoryLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut msg = MessageVisitor(String::new());
        event.record(&mut msg);
        self.0.push(LogEntry {
            at: chrono::Utc::now().timestamp_millis(),
            level: event.metadata().level().to_string(),
            target: event.metadata().target().to_string(),
            message: msg.0,
        });
    }
}

/// Pulls the `message` field out, falling back to appending any other fields
/// so a structured-only event still says something useful.
struct MessageVisitor(String);

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.0 = format!("{value:?}");
        } else {
            if !self.0.is_empty() {
                self.0.push(' ');
            }
            self.0.push_str(&format!("{}={value:?}", field.name()));
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.0 = value.to_string();
        } else {
            if !self.0.is_empty() {
                self.0.push(' ');
            }
            self.0.push_str(&format!("{}={value}", field.name()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(msg: &str) -> LogEntry {
        LogEntry {
            at: 0,
            level: "INFO".into(),
            target: "t".into(),
            message: msg.into(),
        }
    }

    #[test]
    fn snapshot_is_newest_first() {
        let h = LogHistory::new();
        h.push(entry("first"));
        h.push(entry("second"));
        let snap = h.snapshot();
        assert_eq!(snap[0].message, "second");
        assert_eq!(snap[1].message, "first");
    }

    #[test]
    fn history_is_capped_and_keeps_the_newest() {
        let h = LogHistory::new();
        for i in 0..(MAX_ENTRIES + 50) {
            h.push(entry(&i.to_string()));
        }
        let snap = h.snapshot();
        assert!(snap.len() <= MAX_ENTRIES, "the buffer must stay bounded");
        assert_eq!(
            snap[0].message,
            (MAX_ENTRIES + 49).to_string(),
            "the most recent line survives"
        );
    }

    #[test]
    fn clear_empties_the_buffer() {
        let h = LogHistory::new();
        h.push(entry("x"));
        h.clear();
        assert!(h.snapshot().is_empty());
    }

    #[test]
    fn clones_share_one_buffer() {
        let a = LogHistory::new();
        let b = a.clone();
        b.push(entry("via clone"));
        assert_eq!(a.snapshot().len(), 1, "a clone is a handle, not a copy");
    }
}
