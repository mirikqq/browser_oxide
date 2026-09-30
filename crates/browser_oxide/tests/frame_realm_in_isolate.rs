//! F4 inside an isolate: a cross-origin frame's own same-origin frames are
//! realms of *that* frame's isolate — reachable synchronously from its
//! document, run once — not isolates of their own.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const OUTER: &str = r#"<html><body>
<iframe id="inner" srcdoc="<script>globalThis.v = 7; parent.__runs = (parent.__runs || 0) + 1;</script>"></iframe>
</body></html>"#;

async fn serve() -> u16 {
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
                    OUTER.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.write_all(OUTER.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    port
}

#[tokio::test]
async fn same_origin_frame_inside_an_isolate_is_its_realm() {
    let port = serve().await;
    // The page on `localhost`, its frame on `127.0.0.1`: cross-origin.
    let mut page = Page::from_html_with_url(
        &format!(
            r#"<html><body><iframe src="http://127.0.0.1:{port}/outer"></iframe></body></html>"#
        ),
        &format!("http://localhost:{port}/"),
        Some(chrome_148_macos()),
    )
    .await
    .expect("page");
    assert_eq!(
        page.child_frame_ids().len(),
        1,
        "the cross-origin frame is an isolate"
    );
    let outer = page.child_iframe(0).expect("isolate");
    assert_eq!(
        outer.children.len(),
        0,
        "its srcdoc frame is not an isolate"
    );
    assert_eq!(
        outer.event_loop.runtime_mut().frame_realms().len(),
        1,
        "its srcdoc frame is a realm of the isolate"
    );
    assert_eq!(
        outer
            .evaluate("document.getElementById('inner').contentWindow.v + '|' + window.__runs")
            .unwrap(),
        "7|1"
    );
}
