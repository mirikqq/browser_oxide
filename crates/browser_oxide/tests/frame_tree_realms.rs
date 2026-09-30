//! F4: same-origin frames are realms of the page's isolate — full documents
//! reached synchronously; cross-origin frames are isolates of their own.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

async fn page_with(body: &str) -> Page {
    Page::from_html_with_url(
        &format!("<html><body>{body}</body></html>"),
        "https://example.com/",
        Some(chrome_148_macos()),
    )
    .await
    .expect("page")
}

/// A same-origin srcdoc frame is a document in the page's isolate: its globals
/// and its DOM are reachable synchronously, its links point at the page, and
/// its script ran exactly once.
#[tokio::test]
async fn srcdoc_frame_is_reachable_synchronously() {
    let mut page = page_with(
        r#"<iframe id="f" srcdoc="<p id=x>hi</p><script>
             globalThis.childVar = 42; parent.__runs = (parent.__runs || 0) + 1;
           </script>"></iframe>"#,
    )
    .await;
    assert_eq!(page.frame_realms().len(), 1, "one frame realm");
    let probe = page
        .evaluate(
            "(function(){var f=document.getElementById('f'),w=f.contentWindow;\
              return [w.childVar, f.contentDocument.getElementById('x').textContent,\
                      w.parent===window, w.top===window, w.frameElement===f,\
                      w.location.href, w.location.origin, window.__runs,\
                      w.Array!==Array, w.navigator.userAgent===navigator.userAgent].join('|');})()",
        )
        .unwrap();
    assert_eq!(
        probe,
        "42|hi|true|true|true|about:srcdoc|https://example.com|1|true|true"
    );
}

/// `contentWindow` taken the moment the frame is appended is the same window
/// once the frame's document has loaded into it — the initial about:blank's
/// window is reused, as the HTML spec does.
#[tokio::test]
async fn content_window_identity_survives_the_document_loading() {
    let mut page = page_with("").await;
    page.evaluate(
        "var f=document.createElement('iframe'); f.id='f';\
         f.srcdoc='<script>globalThis.loaded=true<\\/script>';\
         document.body.appendChild(f); globalThis.early=f.contentWindow;\
         globalThis.earlyLoaded=String(early.loaded);",
    )
    .unwrap();
    let _ = page.evaluate_async("0", Duration::from_secs(2)).await;
    assert_eq!(
        page.evaluate(
            "earlyLoaded + '|' + (early === document.getElementById('f').contentWindow) + '|' + early.loaded"
        )
        .unwrap(),
        "undefined|true|true"
    );
}

/// A message to a realm frame and the reply through `event.source`: trusted,
/// with the sender's window and origin.
#[tokio::test]
async fn postmessage_round_trip_with_a_realm_frame() {
    let mut page = page_with(
        r#"<iframe id="f" srcdoc="<script>addEventListener('message', function (e) {
             e.source.postMessage({echo: e.data, trusted: e.isTrusted, fromParent: e.source === parent}, '*');
           });</script>"></iframe>
           <script>
             globalThis.__got = [];
             addEventListener('message', e => __got.push({data: e.data, origin: e.origin,
               trusted: e.isTrusted, fromFrame: e.source === document.getElementById('f').contentWindow}));
           </script>"#,
    )
    .await;
    let _ = page
        .evaluate_async(
            "document.getElementById('f').contentWindow.postMessage('ping', location.origin)",
            Duration::from_millis(300),
        )
        .await;
    assert_eq!(
        page.evaluate("JSON.stringify(__got)").unwrap(),
        r#"[{"data":{"echo":"ping","trusted":true,"fromParent":true},"origin":"https://example.com","trusted":true,"fromFrame":true}]"#
    );
}

/// Frames nested in frames are realms too, and `top` is the page.
#[tokio::test]
async fn nested_srcdoc_frames_are_realms() {
    let inner =
        "<script>globalThis.depth = 2; globalThis.topIsPage = (top.__isPage === true);</script>";
    let outer = format!(
        "<iframe id=inner srcdoc=\"{}\"></iframe><script>globalThis.depth = 1;</script>",
        inner.replace('"', "&quot;")
    );
    let mut page = page_with(&format!(
        "<script>globalThis.__isPage = true;</script><iframe id=outer srcdoc=\"{}\"></iframe>",
        outer.replace('&', "&amp;").replace('"', "&quot;")
    ))
    .await;
    assert_eq!(page.frame_realms().len(), 2, "{:?}", page.frame_realms());
    assert_eq!(
        page.evaluate(
            "(function(){var o=document.getElementById('outer').contentWindow;\
              var i=o.document.getElementById('inner').contentWindow;\
              return [o.depth, i.depth, i.topIsPage, i.parent===o, i.top===window].join('|');})()"
        )
        .unwrap(),
        "1|2|true|true|true"
    );
}

/// Removing the `<iframe>` destroys its realm on the next settle.
#[tokio::test]
async fn removing_the_frame_destroys_its_realm() {
    let mut page = page_with(r#"<iframe id="f" srcdoc="<p>x</p>"></iframe>"#).await;
    assert_eq!(page.frame_realms().len(), 1);
    let _ = page
        .evaluate_async(
            "document.getElementById('f').remove()",
            Duration::from_millis(300),
        )
        .await;
    assert_eq!(page.frame_realms().len(), 0);
}

/// The fingerprinting pattern: an `about:blank` frame written into
/// synchronously, whose window is a separate realm with the page's platform.
#[tokio::test]
async fn blank_frame_is_a_realm_written_synchronously() {
    let mut page = page_with("").await;
    assert_eq!(
        page.evaluate(
            "(function(){var f=document.createElement('iframe'); document.body.appendChild(f);\
              var d=f.contentDocument; d.open(); d.write('<p id=q>w</p>'); d.close();\
              var w=f.contentWindow;\
              return [d.getElementById('q') ? d.getElementById('q').textContent : 'none',\
                      w.Function!==Function, typeof w.WebGLRenderingContext,\
                      w.screen.width===screen.width, w.location.href].join('|');})()"
        )
        .unwrap(),
        "w|true|function|true|about:blank"
    );
}

async fn serve(body: &'static str) -> u16 {
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
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.write_all(body.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    port
}

/// A same-origin `src` frame is a realm with its fetched document; a
/// cross-origin one is an isolate behind the cross-origin proxy.
#[tokio::test]
async fn src_frames_split_by_origin() {
    let port =
        serve("<html><body><p id=d>doc</p><script>globalThis.fetched = 1;</script></body></html>")
            .await;
    let mut page = Page::from_html_with_url(
        &format!(
            r#"<html><body><iframe id="same" src="child"></iframe>
               <iframe id="cross" src="http://localhost:{port}/child"></iframe></body></html>"#
        ),
        &format!("http://127.0.0.1:{port}/"),
        Some(chrome_148_macos()),
    )
    .await
    .expect("page");
    assert_eq!(page.frame_realms().len(), 1, "same-origin frame is a realm");
    assert_eq!(
        page.child_frame_ids().len(),
        1,
        "cross-origin frame is an isolate"
    );
    assert_eq!(
        page.evaluate(
            "(function(){var s=document.getElementById('same');\
              var c=document.getElementById('cross');\
              var xo; try { c.contentWindow.document; xo='open'; } catch (e) { xo=e.name; }\
              return [s.contentDocument.getElementById('d').textContent, s.contentWindow.fetched,\
                      s.contentWindow.location.href.endsWith('/child'), xo].join('|');})()"
        )
        .unwrap(),
        "doc|1|true|SecurityError"
    );
}

/// A frame navigating itself navigates the frame, never the page.
#[tokio::test]
async fn frame_navigation_does_not_navigate_the_page() {
    let mut page = page_with(r#"<iframe id="f" srcdoc="<p>x</p>"></iframe>"#).await;
    let _ = page
        .evaluate_async(
            "document.getElementById('f').contentWindow.location.href = 'https://example.com/elsewhere'",
            Duration::from_millis(300),
        )
        .await;
    assert_eq!(
        page.evaluate("location.href").unwrap(),
        "https://example.com/"
    );
}

/// A script a frame inserts into its own document runs in that frame, not in
/// the page (an op runs in the page's context whoever calls it).
#[tokio::test]
async fn a_script_a_frame_inserts_runs_in_the_frame() {
    let mut page = page_with(
        r#"<iframe id="f" srcdoc="<script>
             var s = document.createElement('script');
             s.textContent = &quot;globalThis.where = (window.frameElement ? 'frame' : 'page');&quot;;
             document.head.appendChild(s);
           </script>"></iframe>"#,
    )
    .await;
    assert_eq!(
        page.evaluate("String(document.getElementById('f').contentWindow.where) + '|' + String(globalThis.where)")
            .unwrap(),
        "frame|undefined"
    );
}

/// A cross-origin frame's window is one object for the frame's life.
#[tokio::test]
async fn a_cross_origin_window_keeps_its_identity() {
    let mut page = page_with(r#"<iframe id="x" src="http://127.0.0.1:1/"></iframe>"#).await;
    assert_eq!(
        page.evaluate(
            "var f=document.getElementById('x'); String(f.contentWindow === f.contentWindow)"
        )
        .unwrap(),
        "true"
    );
}

/// Same-origin documents share their storage: what a frame stores, the page
/// reads, and the other way round.
#[tokio::test]
async fn a_frame_shares_the_page_storage() {
    let mut page = page_with(
        r#"<script>localStorage.setItem('fromPage', 'p');</script>
           <iframe id="f" srcdoc="<script>
             localStorage.setItem('fromFrame', 'f');
             globalThis.seen = localStorage.getItem('fromPage');
           </script>"></iframe>"#,
    )
    .await;
    assert_eq!(
        page.evaluate(
            "localStorage.getItem('fromFrame') + '|' + document.getElementById('f').contentWindow.seen"
        )
        .unwrap(),
        "f|p"
    );
}
