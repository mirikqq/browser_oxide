//! Regression tests for the pointer/mouse event model (Q7 / F1.4): pointer
//! events dispatch before their compatibility mouse event, `MouseEvent`
//! coordinates are floored to integers while `PointerEvent`'s stay
//! fractional, `click` is a `PointerEvent`, and `pageX`/`pageY` account for
//! scroll instead of always equalling `clientX`/`clientY`.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::stealth::StealthProfile;
use browser_oxide::Page;

#[tokio::test]
async fn mouse_event_coords_are_floored_pointer_event_is_not() {
    let mut page = Page::from_html("<body></body>", None::<StealthProfile>)
        .await
        .unwrap();
    let result = page
        .evaluate(
            "(() => { \
               const m = new MouseEvent('click', { clientX: 10.7, clientY: 20.3 }); \
               const p = new PointerEvent('click', { clientX: 10.7, clientY: 20.3 }); \
               return JSON.stringify([m.clientX, m.clientY, p.clientX, p.clientY]); \
             })()",
        )
        .unwrap();
    assert_eq!(
        result, "[10,20,10.7,20.3]",
        "MouseEvent must floor, PointerEvent must stay fractional"
    );
}

#[tokio::test]
async fn negative_mouse_coords_floor_toward_negative_infinity() {
    // Chromium's mouse_event.h uses std::floor, not truncation — they
    // differ for negatives (a drag past the left/top viewport edge).
    let mut page = Page::from_html("<body></body>", None::<StealthProfile>)
        .await
        .unwrap();
    let result = page
        .evaluate("String(new MouseEvent('mousemove', { clientX: -1.5 }).clientX)")
        .unwrap();
    assert_eq!(result, "-2");
}

#[tokio::test]
async fn page_xy_accounts_for_scroll() {
    let mut page = Page::from_html(
        r#"<div style="height:3000px"></div>"#,
        None::<StealthProfile>,
    )
    .await
    .unwrap();
    page.evaluate("window.scrollTo(0, 500)").unwrap();
    let result = page
        .evaluate(
            "(() => { \
               const e = new MouseEvent('click', { clientX: 10, clientY: 20 }); \
               return JSON.stringify([e.pageX, e.pageY]); \
             })()",
        )
        .unwrap();
    assert_eq!(result, "[10,520]", "pageY must be clientY + scrollY");
}

#[tokio::test]
async fn human_click_dispatches_a_pointer_event_click() {
    let mut page = Page::from_html(
        r#"<button id="go" style="position:absolute;left:40px;top:40px;width:90px;height:30px">go</button>
           <script>
             globalThis.__isPointerEvent = null;
             document.getElementById('go').addEventListener('click', (e) => {
               __isPointerEvent = e instanceof PointerEvent;
             });
           </script>"#,
        Some(chrome_148_macos()),
    )
    .await
    .unwrap();
    page.human_click("#go").await.expect("click runs");
    assert_eq!(
        page.evaluate("String(__isPointerEvent)").unwrap(),
        "true",
        "click must be a PointerEvent"
    );
}

#[tokio::test]
async fn human_click_fires_pointermove_before_mousemove() {
    let mut page = Page::from_html(
        r#"<button id="go" style="position:absolute;left:300px;top:300px;width:90px;height:30px">go</button>
           <script>
             globalThis.__order = [];
             document.addEventListener('pointermove', () => __order.push('pointermove'));
             document.addEventListener('mousemove', () => __order.push('mousemove'));
           </script>"#,
        Some(chrome_148_macos()),
    )
    .await
    .unwrap();
    page.human_click("#go").await.expect("click runs");
    let order: Vec<String> =
        serde_json::from_str(&page.evaluate("JSON.stringify(__order)").unwrap()).unwrap();
    assert!(!order.is_empty(), "expected at least one move pair");
    assert_eq!(
        order[0], "pointermove",
        "the first move sample must dispatch pointermove before mousemove: {order:?}"
    );
    // Every mousemove must be preceded by at least as many pointermoves —
    // i.e. a running count never goes negative.
    let mut balance = 0i32;
    for kind in &order {
        if kind == "pointermove" {
            balance += 1;
        } else if kind == "mousemove" {
            balance -= 1;
            assert!(balance >= 0, "mousemove outran its pointermove: {order:?}");
        }
    }
}
