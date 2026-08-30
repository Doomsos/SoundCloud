//! Lenient JSON accessors. Port of `lib/core/api/dto/json.dart`.
//!
//! SoundCloud is inconsistent about types across endpoints - ids arrive as
//! numbers in one payload and strings in another, counters go missing
//! entirely - so every read is total: it coerces what it can and falls back
//! rather than failing the whole parse.

use serde_json::{Map, Value};

pub fn as_i64(v: Option<&Value>) -> i64 {
    as_i64_or(v, 0)
}

pub fn as_i64_or(v: Option<&Value>, fallback: i64) -> i64 {
    match v {
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .unwrap_or(fallback),
        Some(Value::String(s)) => s.parse::<i64>().unwrap_or(fallback),
        _ => fallback,
    }
}

/// Mirrors Dart's `asStr`: a string passes through, anything else is
/// stringified, and null becomes the fallback. Numeric ids therefore render
/// as `"12345"`, which is what the domain models expect.
pub fn as_str(v: Option<&Value>) -> String {
    as_str_or(v, "")
}

pub fn as_str_or(v: Option<&Value>, fallback: &str) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => fallback.to_string(),
        Some(other) => other.to_string(),
    }
}

/// Only a real JSON string counts; absent and non-string values are `None`.
/// This is the `j['x'] as String?` cast from Dart.
pub fn opt_str(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// As `opt_str`, but an empty or whitespace-only string is also `None`.
pub fn opt_str_trimmed(v: Option<&Value>) -> Option<String> {
    opt_str(v).filter(|s| !s.trim().is_empty())
}

#[allow(dead_code)] // parity with Dart's asBool; used by tests and future readers
pub fn as_bool(v: Option<&Value>) -> bool {
    as_bool_or(v, false)
}

pub fn as_bool_or(v: Option<&Value>, fallback: bool) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        _ => fallback,
    }
}

static EMPTY: once_cell::sync::Lazy<Map<String, Value>> =
    once_cell::sync::Lazy::new(Map::new);

/// A borrowed object view, empty when the value is not an object.
pub fn as_map(v: Option<&Value>) -> &Map<String, Value> {
    match v {
        Some(Value::Object(m)) => m,
        _ => &EMPTY,
    }
}

/// Every object in a JSON array, skipping non-object entries exactly as
/// Dart's `whereType<Map>()` did.
pub fn as_map_list(v: Option<&Value>) -> Vec<&Value> {
    match v {
        Some(Value::Array(a)) => a.iter().filter(|e| e.is_object()).collect(),
        _ => Vec::new(),
    }
}

/// Convenience for the very common `asMap(j['a'])['b']` shape.
#[allow(dead_code)] // convenience accessor kept alongside the other json helpers
pub fn dig<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for key in path {
        cur = cur.get(key)?;
    }
    Some(cur)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coerces_numbers_and_strings_like_dart() {
        let v = json!({ "a": 5, "b": "7", "c": "nope", "d": 2.9, "e": null });
        assert_eq!(as_i64(v.get("a")), 5);
        assert_eq!(as_i64(v.get("b")), 7);
        assert_eq!(as_i64(v.get("c")), 0);
        assert_eq!(as_i64(v.get("d")), 2, "floats truncate toward zero");
        assert_eq!(as_i64_or(v.get("missing"), 42), 42);
        assert_eq!(as_i64_or(v.get("e"), 42), 42);
    }

    #[test]
    fn as_str_stringifies_numeric_ids() {
        let v = json!({ "id": 12345, "name": "x", "n": null });
        assert_eq!(as_str(v.get("id")), "12345");
        assert_eq!(as_str(v.get("name")), "x");
        assert_eq!(as_str(v.get("n")), "");
        assert_eq!(as_str_or(v.get("nope"), "fb"), "fb");
    }

    #[test]
    fn opt_str_rejects_non_strings_and_blanks() {
        let v = json!({ "s": "ok", "blank": "   ", "n": 5, "z": null });
        assert_eq!(opt_str(v.get("s")).as_deref(), Some("ok"));
        assert_eq!(opt_str(v.get("n")), None, "a number is not a String?");
        assert_eq!(opt_str(v.get("z")), None);
        assert_eq!(opt_str_trimmed(v.get("blank")), None);
        assert_eq!(opt_str(v.get("blank")).as_deref(), Some("   "));
    }

    #[test]
    fn map_helpers_are_total() {
        let v = json!({ "obj": { "k": 1 }, "arr": [{ "a": 1 }, 7, { "b": 2 }], "s": "x" });
        assert_eq!(as_map(v.get("obj")).len(), 1);
        assert!(as_map(v.get("s")).is_empty(), "non-objects read as empty");
        assert!(as_map(None).is_empty());
        assert_eq!(as_map_list(v.get("arr")).len(), 2, "the bare 7 is skipped");
        assert!(as_map_list(v.get("obj")).is_empty());
    }
}
