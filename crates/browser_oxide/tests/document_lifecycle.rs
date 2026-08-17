//! Document lifecycle as a script sees it.
//!
//! A third-party widget decides *when* to initialise by reading
//! `document.readyState` and, if the document is still loading, waiting for
//! `DOMContentLoaded`. hCaptcha's `api.js` auto-render works exactly this way, and
//! so does most of the embed ecosystem. Both halves have to be right: the state
//! observed *during* script execution, and the event arriving *after* it. Getting
//! either wrong produces a widget that loads, exposes its whole API, and then
//! silently never renders — which is indistinguishable from a network failure
//! unless you check this directly.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

/// A page whose inline script records what it saw and registers the usual
/// deferred-init listeners.
const PROBE: &str = r#"<!doctype html><html><body><script>
  globalThis.__seen = {
    readyStateAtRun: document.readyState,
    domContentLoaded: false,
    load: false,
    readyStateAtDcl: null
  };
  document.addEventListener('DOMContentLoaded', function () {
    globalThis.__seen.domContentLoaded = true;
    globalThis.__seen.readyStateAtDcl = document.readyState;
  });
  window.addEventListener('load', function () { globalThis.__seen.load = true; });
</script></body></html>"#;

async fn seen() -> serde_json::Value {
    let mut page = Page::from_html(PROBE, Some(chrome_148_macos()))
        .await
        .expect("page");
    let raw = page
        .evaluate("JSON.stringify(globalThis.__seen)")
        .expect("read");
    // `evaluate` hands back the JSON string still quoted and escaped.
    let unquoted = raw.trim_matches('"').replace("\\\"", "\"");
    serde_json::from_str(&unquoted).unwrap_or_else(|e| panic!("не JSON: {raw} ({e})"))
}

#[tokio::test]
async fn a_script_sees_the_document_still_loading_while_it_runs() {
    let v = seen().await;
    // Per spec a parser-inserted script runs while the document is "loading".
    // Reporting anything else sends a widget down its "already ready" branch,
    // where it expects the DOM it needs to be complete — or, worse, makes it skip
    // deferred init entirely.
    assert_eq!(
        v["readyStateAtRun"], "loading",
        "во время исполнения скрипта readyState должен быть loading, получено {}",
        v["readyStateAtRun"]
    );
}

#[tokio::test]
async fn deferred_initialisation_actually_runs() {
    let v = seen().await;
    assert_eq!(
        v["domContentLoaded"], true,
        "слушатель DOMContentLoaded должен сработать"
    );
    assert_eq!(v["load"], true, "слушатель load должен сработать");
    // Spec: readyState is already "interactive" by the time DOMContentLoaded is
    // dispatched. A widget that re-checks inside its own handler depends on it.
    assert_eq!(
        v["readyStateAtDcl"], "interactive",
        "внутри DOMContentLoaded readyState должен быть interactive, получено {}",
        v["readyStateAtDcl"]
    );
}
