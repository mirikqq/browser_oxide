//! Scripts inserted from JS must run, and must see their own element.
//!
//! Both halves are load-bearing for third-party widgets. A library recovers the
//! parameters it was configured with by reading its own `<script>` tag through
//! `document.currentScript` — hCaptcha's `api.js` finds `?onload=<name>` that way
//! and calls the callback its embedder is waiting on. And `blob:` sources are how
//! runtime-built code is loaded; routing them at the network stack fetches
//! nothing, so the script never runs and nothing reports an error.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

async fn blank() -> Page {
    Page::from_html(
        "<html><head></head><body></body></html>",
        Some(chrome_148_macos()),
    )
    .await
    .expect("page")
}

#[tokio::test]
async fn an_inserted_inline_script_sees_its_own_element() {
    let mut p = blank().await;
    let v = p
        .evaluate(
            "(function(){var s=document.createElement('script');s.id='probe';\
             s.textContent=\"globalThis.__seen = document.currentScript ? document.currentScript.id : 'NULL';\";\
             document.head.appendChild(s);return String(globalThis.__seen);})()",
        )
        .expect("eval");
    assert_eq!(v, "probe", "currentScript должен указывать на сам тег: {v}");
}

#[tokio::test]
async fn current_script_is_restored_afterwards() {
    let mut p = blank().await;
    let v = p
        .evaluate(
            "(function(){var s=document.createElement('script');\
             s.textContent='void 0;';document.head.appendChild(s);\
             return String(document.currentScript);})()",
        )
        .expect("eval");
    // Outside any script execution it is null again — leaving it set would be a
    // lie for everything that runs later.
    assert_eq!(v, "null", "после выполнения должен вернуться в null: {v}");
}

#[tokio::test]
async fn a_blob_sourced_script_runs() {
    let mut p = blank().await;
    let v = p
        .evaluate(
            "(function(){\
             var b=new Blob(['globalThis.__ran = 42;'],{type:'text/javascript'});\
             var s=document.createElement('script');s.src=URL.createObjectURL(b);\
             document.head.appendChild(s);\
             return String(globalThis.__ran);})()",
        )
        .expect("eval");
    assert_eq!(v, "42", "скрипт из blob: должен выполниться: {v}");
}
