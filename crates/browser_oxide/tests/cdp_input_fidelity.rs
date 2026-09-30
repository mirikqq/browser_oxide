//! Regression tests (Q13 / F1.10): CDP `Input.dispatchMouseEvent`'s
//! `mouseReleased` must synthesize an actual `click` (with default
//! activation), and `Input.dispatchKeyEvent`'s `keyDown` must insert text
//! when it carries one — Puppeteer/Playwright's `keyboard.type()` sends
//! `keyDown` with `text`, never CDP's `'char'` type, so gating insertion on
//! `'char'` alone meant CDP-driven typing inserted nothing.

use browser_oxide::protocol::session::CdpSession;
use browser_oxide::protocol::types::CdpRequest;
use browser_oxide::stealth::StealthProfile;
use browser_oxide::Page;
use serde_json::json;

fn req(method: &str, params: serde_json::Value) -> CdpRequest {
    CdpRequest {
        id: 1,
        method: method.to_string(),
        params,
    }
}

#[tokio::test]
async fn mouse_pressed_then_released_fires_click() {
    let mut page = Page::from_html(
        r#"<button id="go" style="position:absolute;left:10px;top:10px;width:90px;height:30px">go</button>
           <script>
             globalThis.__clicks = 0;
             document.getElementById('go').addEventListener('click', () => { __clicks++; });
           </script>"#,
        None::<StealthProfile>,
    )
    .await
    .unwrap();

    let mut session = CdpSession::new();
    session
        .handle_request(
            &mut page,
            &req(
                "Input.dispatchMouseEvent",
                json!({ "type": "mousePressed", "x": 30.0, "y": 20.0, "button": "left", "clickCount": 1 }),
            ),
            None,
        )
        .await;
    session
        .handle_request(
            &mut page,
            &req(
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseReleased", "x": 30.0, "y": 20.0, "button": "left", "clickCount": 1 }),
            ),
            None,
        )
        .await;

    assert_eq!(
        page.evaluate("String(__clicks)").unwrap(),
        "1",
        "mousePressed + mouseReleased at the same point must fire click"
    );
}

#[tokio::test]
async fn mouse_released_click_runs_default_activation() {
    let mut page = Page::from_html(
        r#"<input id="c" type="checkbox" style="position:absolute;left:10px;top:10px;width:20px;height:20px">"#,
        None::<StealthProfile>,
    )
    .await
    .unwrap();

    let mut session = CdpSession::new();
    session
        .handle_request(
            &mut page,
            &req(
                "Input.dispatchMouseEvent",
                json!({ "type": "mousePressed", "x": 15.0, "y": 15.0, "button": "left", "clickCount": 1 }),
            ),
            None,
        )
        .await;
    session
        .handle_request(
            &mut page,
            &req(
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseReleased", "x": 15.0, "y": 15.0, "button": "left", "clickCount": 1 }),
            ),
            None,
        )
        .await;

    assert_eq!(
        page.evaluate("document.getElementById('c').checked")
            .unwrap(),
        "true",
        "CDP click must run the target's default activation, not just fire the event"
    );
}

#[tokio::test]
async fn key_down_with_text_inserts_the_character() {
    let mut page = Page::from_html(
        r#"<input id="q" style="position:absolute;left:10px;top:10px;width:200px;height:24px">
           <script>document.getElementById('q').focus();</script>"#,
        None::<StealthProfile>,
    )
    .await
    .unwrap();

    let mut session = CdpSession::new();
    session
        .handle_request(
            &mut page,
            &req(
                "Input.dispatchKeyEvent",
                json!({ "type": "keyDown", "key": "a", "code": "KeyA", "text": "a" }),
            ),
            None,
        )
        .await;

    assert_eq!(
        page.evaluate("document.getElementById('q').value").unwrap(),
        "a",
        "keyDown carrying `text` must insert it — this is what Puppeteer's keyboard.type() sends"
    );
}

/// Chrome's own input pipeline fires these events for `Input.dispatch*`, so
/// they are `isTrusted` there; a page that gates on it ignored every
/// CDP-driven click and keystroke here.
#[tokio::test]
async fn cdp_input_events_are_trusted() {
    let mut page = Page::from_html(
        r#"<input id="f" style="position:absolute;left:10px;top:10px;width:120px;height:24px">
           <script>
             globalThis.__seen = [];
             for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'keydown', 'input', 'keyup'])
               document.getElementById('f').addEventListener(t, e => __seen.push(t + ':' + e.isTrusted));
           </script>"#,
        None::<StealthProfile>,
    )
    .await
    .unwrap();

    let mut session = CdpSession::new();
    for (method, params) in [
        (
            "Input.dispatchMouseEvent",
            json!({ "type": "mousePressed", "x": 30.0, "y": 20.0, "button": "left", "clickCount": 1 }),
        ),
        (
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseReleased", "x": 30.0, "y": 20.0, "button": "left", "clickCount": 1 }),
        ),
    ] {
        session
            .handle_request(&mut page, &req(method, params), None)
            .await;
    }
    page.evaluate("document.getElementById('f').focus()")
        .unwrap();
    for params in [
        json!({ "type": "keyDown", "key": "a", "code": "KeyA", "text": "a" }),
        json!({ "type": "keyUp", "key": "a", "code": "KeyA" }),
    ] {
        session
            .handle_request(&mut page, &req("Input.dispatchKeyEvent", params), None)
            .await;
    }

    let seen: Vec<String> =
        serde_json::from_str(&page.evaluate("JSON.stringify(__seen)").unwrap()).unwrap();
    assert!(!seen.is_empty(), "no events reached the field");
    assert!(
        seen.iter().all(|e| e.ends_with(":true")),
        "untrusted CDP events: {seen:?}"
    );
    for kind in ["click:true", "keydown:true", "input:true", "keyup:true"] {
        assert!(seen.iter().any(|e| e == kind), "missing {kind}: {seen:?}");
    }
}
