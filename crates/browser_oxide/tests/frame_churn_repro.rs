//! Frames are created and removed in any order on real pages — a widget reloads
//! its challenge frame, an ad slot swaps its creative — so the engine has to
//! survive losing a frame that is older than one still alive. Each child frame
//! is its own V8 isolate on the page's thread, and rusty_v8 only allows those to
//! be dropped in reverse creation order; see `docs/INTERACTION_FRAMES_PLAN.md`,
//! task F0.2.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

const TWO_FRAMES: &str = r#"<!doctype html><html><body>
<iframe id="a" srcdoc="<p>a</p>"></iframe><iframe id="b" srcdoc="<p>b</p>"></iframe>
</body></html>"#;

async fn two_frames() -> Page {
    let page =
        Page::from_html_with_url(TWO_FRAMES, "http://127.0.0.1:9/", Some(chrome_148_macos()))
            .await
            .unwrap();
    assert_eq!(page.child_iframe_count(), 2);
    page
}

/// The newest frame goes first, which is the one order the isolates tolerate.
#[tokio::test]
async fn removing_the_newest_frame_survives_a_rescan() {
    let mut page = two_frames().await;
    page.evaluate("document.getElementById('b').remove()")
        .unwrap();
    assert_eq!(page.materialize_new_iframes().await, Some(0));
    assert_eq!(page.child_iframe_count(), 1);
}

/// Currently kills the whole process: `Fatal error in
/// v8::HandleScope::CreateHandle()` once the rescan drops frame `a` while the
/// younger `b` is still alive.
#[tokio::test]
#[ignore = "known crash: out-of-order isolate drop (INTERACTION_FRAMES_PLAN F0.2)"]
async fn removing_an_older_frame_survives_a_rescan() {
    let mut page = two_frames().await;
    page.evaluate("document.getElementById('a').remove()")
        .unwrap();
    assert_eq!(page.materialize_new_iframes().await, Some(0));
    assert_eq!(page.child_iframe_count(), 1);
}
