//! Process-wide network record log for debugging front-ends (`examples/devview`).
//!
//! Recording happens in `HttpClient::build_response*`, the single point every
//! response funnels through — JS `fetch`/XHR (via `op_fetch`), `<script src>`,
//! stylesheets and iframe documents all land here. Instrumenting the 13 public
//! request methods instead would miss whichever one a future path uses.
//!
//! Disabled unless `BROWSER_OXIDE_NETLOG` is set: production runs pay one
//! relaxed atomic load per response and nothing else. Bodies are capped and the
//! ring is bounded, so a long-running page cannot grow this without limit.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

/// Bodies above this are truncated — a DevTools-style preview, not an archive.
const MAX_BODY: usize = 16 * 1024;
/// Oldest records are dropped past this.
const MAX_RECORDS: usize = 600;

/// One completed HTTP exchange.
#[derive(Clone, Debug)]
pub struct NetRecord {
    pub seq: u64,
    pub method: String,
    pub url: String,
    pub status: u16,
    /// DevTools-style resource category: `doc`, `script`, `css`, `xhr`, `img`,
    /// `font`, `media`, `other`.
    pub kind: &'static str,
    pub mime: String,
    /// Decompressed body length in bytes, before truncation.
    pub size: usize,
    pub headers: Vec<(String, String)>,
    /// Body preview, truncated to [`MAX_BODY`]. Empty for binary types.
    pub body: String,
}

static ENABLED: OnceLock<bool> = OnceLock::new();
static SEQ: AtomicU64 = AtomicU64::new(0);
static RECORDS: OnceLock<Mutex<Vec<NetRecord>>> = OnceLock::new();
/// Set by `enable()` so a host process can turn recording on without the env var.
static FORCED: AtomicBool = AtomicBool::new(false);

fn enabled() -> bool {
    FORCED.load(Ordering::Relaxed)
        || *ENABLED.get_or_init(|| std::env::var_os("BROWSER_OXIDE_NETLOG").is_some())
}

/// Turn recording on for this process regardless of the environment.
pub fn enable() {
    FORCED.store(true, Ordering::Relaxed);
}

/// Classify a response the way DevTools' "Type" column does: MIME first,
/// because a `.php` that returns JSON is XHR, then the URL as a fallback for
/// servers that omit or lie about `Content-Type`.
fn classify(url: &str, mime: &str) -> &'static str {
    let m = mime.to_ascii_lowercase();
    if m.contains("html") {
        return "doc";
    }
    if m.contains("javascript") || m.contains("ecmascript") {
        return "script";
    }
    if m.contains("css") {
        return "css";
    }
    if m.contains("json") || m.contains("xml") || m.contains("x-www-form-urlencoded") {
        return "xhr";
    }
    if m.starts_with("image/") {
        return "img";
    }
    if m.starts_with("font/") || m.contains("woff") || m.contains("ttf") {
        return "font";
    }
    if m.starts_with("video/") || m.starts_with("audio/") {
        return "media";
    }

    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    match path.rsplit('.').next().unwrap_or("") {
        "js" | "mjs" => "script",
        "css" => "css",
        "json" => "xhr",
        "html" | "htm" => "doc",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico" => "img",
        "woff" | "woff2" | "ttf" | "otf" | "eot" => "font",
        "mp4" | "webm" | "mp3" | "wav" => "media",
        _ => "other",
    }
}

/// Text types get a body preview; binary ones would only produce mojibake.
fn is_text(kind: &str, mime: &str) -> bool {
    matches!(kind, "doc" | "script" | "css" | "xhr") || mime.starts_with("text/")
}

/// Record one exchange. Cheap no-op when recording is off.
pub fn record(
    method: &str,
    url: &str,
    status: u16,
    headers: &std::collections::HashMap<String, String>,
    body: &[u8],
) {
    if !enabled() {
        return;
    }
    let mime = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.split(';').next().unwrap_or(v).trim().to_string())
        .unwrap_or_default();
    let kind = classify(url, &mime);

    let preview = if is_text(kind, &mime) {
        let cut = body.len().min(MAX_BODY);
        // Truncating mid-codepoint is possible, so lose the partial tail
        // rather than the whole preview.
        String::from_utf8_lossy(&body[..cut]).into_owned()
    } else {
        String::new()
    };

    let mut hdrs: Vec<(String, String)> = headers
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    hdrs.sort_by(|a, b| a.0.cmp(&b.0));

    let rec = NetRecord {
        seq: SEQ.fetch_add(1, Ordering::Relaxed),
        method: method.to_string(),
        url: url.to_string(),
        status,
        kind,
        mime,
        size: body.len(),
        headers: hdrs,
        body: preview,
    };

    if let Ok(mut guard) = RECORDS.get_or_init(|| Mutex::new(Vec::new())).lock() {
        if guard.len() >= MAX_RECORDS {
            guard.remove(0);
        }
        guard.push(rec);
    }
}

/// Every record with `seq >= after`, oldest first. `after` lets a poller fetch
/// only what it has not seen instead of re-serialising the whole ring.
pub fn since(after: u64) -> Vec<NetRecord> {
    match RECORDS.get() {
        Some(m) => m
            .lock()
            .map(|g| g.iter().filter(|r| r.seq >= after).cloned().collect())
            .unwrap_or_default(),
        None => Vec::new(),
    }
}

/// Drop every record. Used when a debugging front-end starts a fresh flow.
pub fn clear() {
    if let Some(m) = RECORDS.get() {
        if let Ok(mut g) = m.lock() {
            g.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn classifies_by_mime_then_extension() {
        assert_eq!(classify("https://x/a.php", "application/json"), "xhr");
        assert_eq!(classify("https://x/a.js?v=2", ""), "script");
        assert_eq!(classify("https://x/logo.png", ""), "img");
        assert_eq!(classify("https://x/", "text/html; charset=utf-8"), "doc");
        assert_eq!(classify("https://x/thing", ""), "other");
    }

    #[test]
    fn records_and_reads_back_when_enabled() {
        enable();
        clear();
        let mut h = HashMap::new();
        h.insert("Content-Type".into(), "application/json".into());
        record("POST", "https://api.example/x", 403, &h, b"{\"a\":1}");
        let got = since(0);
        let last = got.last().expect("record was stored");
        assert_eq!(last.status, 403);
        assert_eq!(last.kind, "xhr");
        assert_eq!(last.body, "{\"a\":1}");
        assert_eq!(last.method, "POST");
    }

    #[test]
    fn binary_bodies_are_not_previewed() {
        enable();
        clear();
        let mut h = HashMap::new();
        h.insert("content-type".into(), "image/png".into());
        record("GET", "https://x/logo.png", 200, &h, &[0x89, 0x50, 0x4e]);
        let got = since(0);
        let last = got.last().expect("record was stored");
        assert_eq!(last.kind, "img");
        assert!(last.body.is_empty());
        assert_eq!(last.size, 3);
    }
}
