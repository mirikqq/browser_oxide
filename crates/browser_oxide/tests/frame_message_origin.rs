//! Q10 / F5.1: cross-frame `postMessage` delivery.
//!
//! - A `srcdoc` document's origin is its parent's, not the opaque `"null"` an
//!   `about:srcdoc` URL parses to — both as `location.origin` inside it and as
//!   the `event.origin` its messages carry.
//! - Delivered `MessageEvent`s are trusted, as in Chrome, on every path: the
//!   host pump between isolates (both directions) and the in-isolate realm a
//!   srcdoc `contentWindow` resolves to.
//! - `targetOrigin` is checked against the engine's record of the receiver's
//!   origin, so a mismatched target is dropped and a matching one is not.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const PARENT: &str = "https://example.com/";

async fn pump(page: &mut Page, rounds: usize) {
    for _ in 0..rounds {
        page.pump_iframe_messages();
        page.drive_children(Duration::from_millis(30)).await;
        let _ = page.evaluate_async("0", Duration::from_millis(30)).await;
    }
}

#[tokio::test]
async fn srcdoc_frame_inherits_parent_origin_and_posts_trusted_messages_up() {
    let profile = chrome_148_macos();
    let client = browser_oxide::net::HttpClient::new(&profile).expect("client");
    let mut page = Page::from_html_with_url(
        r#"<html><body><script>
             globalThis.__got = [];
             addEventListener('message', e => __got.push({data: e.data, origin: e.origin,
               trusted: e.isTrusted, hasSource: !!e.source}));
           </script>
           <iframe id="f" srcdoc="<script>parent.postMessage({o: location.origin}, 'https://example.com')</script>"></iframe>
           </body></html>"#,
        PARENT,
        Some(profile.clone()),
    )
    .await
    .expect("page");
    page.rematerialize_iframes(PARENT, &client, &profile).await;
    assert_eq!(page.frame_realms().len(), 1);
    assert_eq!(
        {
            let r = page.frame_realms()[0].0;
            page.evaluate_in_frame_realm(r, "location.origin").unwrap()
        },
        "https://example.com"
    );
    assert_eq!(
        {
            let r = page.frame_realms()[0].0;
            page.evaluate_in_frame_realm(r, "location.href").unwrap()
        },
        "about:srcdoc"
    );

    pump(&mut page, 3).await;
    // Exactly one: the pump's `event.source` lookup touches the frame's
    // `contentWindow`, which used to run the srcdoc a second time in the
    // parent isolate and post a second, untrusted copy (blocker B2).
    let got = page.evaluate("JSON.stringify(__got)").unwrap();
    assert_eq!(
        got,
        r#"[{"data":{"o":"https://example.com"},"origin":"https://example.com","trusted":true,"hasSource":true}]"#
    );
}

#[tokio::test]
async fn platform_message_deliveries_are_trusted() {
    // `window.postMessage` to oneself and a `MessageChannel` port: both are
    // deliveries by the platform, and Chrome reports them `isTrusted`.
    let mut page = Page::from_html_with_url(
        r#"<html><body><script>
             globalThis.__got = [];
             addEventListener('message', e => __got.push('window:' + e.isTrusted + ':' + e.origin));
             const ch = new MessageChannel();
             ch.port1.onmessage = e => __got.push('port:' + e.isTrusted);
             ch.port2.postMessage('x');
             postMessage('y', '*');
           </script></body></html>"#,
        PARENT,
        Some(chrome_148_macos()),
    )
    .await
    .expect("page");
    let _ = page.evaluate_async("0", Duration::from_millis(200)).await;
    let mut got: Vec<String> =
        serde_json::from_str(&page.evaluate("JSON.stringify(__got)").unwrap()).unwrap();
    got.sort();
    assert_eq!(got, ["port:true", "window:true:https://example.com"]);
}

const ROUND_TRIP_CHILD: &str = "<script>addEventListener('message', function (e) {\
    e.source.postMessage({echo: e.data, trusted: e.isTrusted, origin: e.origin}, '*');\
  });</script>";

const ROUND_TRIP_EXPECTED: &str = r#"[{"data":{"echo":"ping","trusted":true,"origin":"https://example.com"},"origin":"https://example.com","trusted":true}]"#;

#[tokio::test]
async fn srcdoc_content_window_round_trip_is_trusted_with_parent_origin() {
    // The page builds its srcdoc frames as documents of their own, so a
    // message posted through `contentWindow` travels through the host pump to
    // that document, and the reply comes back the same way.
    let mut page = Page::from_html_with_url(
        &format!(
            r#"<html><body>
               <iframe id="f" srcdoc="{ROUND_TRIP_CHILD}"></iframe>
               <script>
                 globalThis.__got = [];
                 addEventListener('message', e => __got.push({{data: e.data, origin: e.origin, trusted: e.isTrusted}}));
               </script></body></html>"#
        ),
        PARENT,
        Some(chrome_148_macos()),
    )
    .await
    .expect("page");
    assert_eq!(page.frame_realms().len(), 1, "srcdoc frame materialized");
    page.evaluate(
        "document.getElementById('f').contentWindow.postMessage('ping', location.origin)",
    )
    .unwrap();
    pump(&mut page, 4).await;
    assert_eq!(
        page.evaluate("JSON.stringify(__got)").unwrap(),
        ROUND_TRIP_EXPECTED
    );
}

#[tokio::test]
async fn script_inserted_srcdoc_is_built_and_gets_messages_posted_before_it_loaded() {
    // The page appends a frame and posts to it in the same task, before any
    // document exists in it. The page builds the frame itself (no explicit
    // materialize call) and the message waits for it instead of being lost.
    let mut page = Page::from_html_with_url(
        r#"<html><body><script>
             globalThis.__got = [];
             addEventListener('message', e => __got.push({data: e.data, origin: e.origin, trusted: e.isTrusted}));
           </script></body></html>"#,
        PARENT,
        Some(chrome_148_macos()),
    )
    .await
    .expect("page");
    let _ = page
        .evaluate_async(
            &format!(
                "var f = document.createElement('iframe'); f.id = 'f'; f.srcdoc = {};\
                 document.body.appendChild(f);\
                 f.contentWindow.postMessage('ping', location.origin);",
                serde_json::to_string(ROUND_TRIP_CHILD).unwrap()
            ),
            Duration::from_secs(3),
        )
        .await;
    assert_eq!(page.frame_realms().len(), 1, "the page built the frame");
    assert_eq!(
        page.evaluate("JSON.stringify(__got)").unwrap(),
        ROUND_TRIP_EXPECTED
    );
}

/// Serve `child` for every request on a local port.
async fn spawn_child_server(child: &'static str) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    child.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.write_all(child.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    port
}

#[tokio::test]
async fn cross_origin_frame_messages_are_trusted_and_target_checked() {
    let port = spawn_child_server(
        r#"<html><body><script>
             globalThis.__got = [];
             addEventListener('message', function (e) {
               __got.push({data: e.data, origin: e.origin, trusted: e.isTrusted});
               e.source.postMessage('pong:' + e.data, '*');
             });
           </script></body></html>"#,
    )
    .await;
    // `localhost` vs the parent's `127.0.0.1`: a different origin, same server.
    let child_origin = format!("http://localhost:{port}");
    let parent_url = format!("http://127.0.0.1:{port}/");
    let profile = chrome_148_macos();
    let client = browser_oxide::net::HttpClient::new(&profile).expect("client");
    let mut page = Page::from_html_with_url(
        &format!(
            r#"<html><body><iframe id="f" src="{child_origin}/child"></iframe><script>
                 globalThis.__got = [];
                 addEventListener('message', e => __got.push({{data: e.data, origin: e.origin, trusted: e.isTrusted}}));
               </script></body></html>"#
        ),
        &parent_url,
        Some(profile.clone()),
    )
    .await
    .expect("page");
    page.rematerialize_iframes(&parent_url, &client, &profile)
        .await;
    assert_eq!(page.child_frame_ids().len(), 1, "child frame materialized");

    page.evaluate(&format!(
        "var w = document.getElementById('f').contentWindow;\
         w.postMessage('wrong-target', 'http://elsewhere.test');\
         w.postMessage('ping', '{child_origin}');"
    ))
    .unwrap();
    pump(&mut page, 4).await;

    let child_got = page
        .child_iframe(0)
        .unwrap()
        .evaluate("JSON.stringify(__got)")
        .unwrap();
    assert_eq!(
        child_got,
        format!(r#"[{{"data":"ping","origin":"http://127.0.0.1:{port}","trusted":true}}]"#)
    );
    let parent_got = page.evaluate("JSON.stringify(__got)").unwrap();
    assert_eq!(
        parent_got,
        format!(r#"[{{"data":"pong:ping","origin":"{child_origin}","trusted":true}}]"#)
    );
}
