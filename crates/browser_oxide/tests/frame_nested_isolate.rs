//! F4: a cross-origin frame inside a same-origin frame is an isolate embedded
//! in that frame's realm — built, messaged both ways, and removed with it.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const NESTED: &str = r#"<html><body><script>
  addEventListener('message', function (e) {
    parent.postMessage('pong:' + e.data + ':' + e.isTrusted, '*');
  });
  parent.postMessage('hello-from-isolate', '*');
</script></body></html>"#;

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
                    NESTED.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.write_all(NESTED.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    port
}

async fn pump(page: &mut Page, rounds: usize) {
    for _ in 0..rounds {
        page.pump_iframe_messages();
        page.drive_children(Duration::from_millis(30)).await;
        let _ = page.evaluate_async("0", Duration::from_millis(30)).await;
    }
}

#[tokio::test]
async fn cross_origin_frame_inside_a_realm_frame() {
    let port = serve().await;
    // Page and its srcdoc frame on 127.0.0.1; the nested frame on localhost.
    let outer = format!(
        "<script>globalThis.__got = []; addEventListener('message', function (e) {{\
           __got.push(e.data + '|' + e.isTrusted + '|' + (e.source === document.getElementById('x').contentWindow));\
         }});</script><iframe id=x src=\"http://localhost:{port}/nested\"></iframe>"
    );
    let mut page = Page::from_html_with_url(
        &format!(
            "<html><body><iframe id=outer srcdoc=\"{}\"></iframe></body></html>",
            outer.replace('&', "&amp;").replace('"', "&quot;")
        ),
        &format!("http://127.0.0.1:{port}/"),
        Some(chrome_148_macos()),
    )
    .await
    .expect("page");
    assert_eq!(page.frame_realms().len(), 1, "the srcdoc frame is a realm");
    assert_eq!(
        page.child_frame_ids().len(),
        1,
        "the cross-origin frame inside it is an isolate"
    );
    pump(&mut page, 3).await;
    let realm = page.frame_realms()[0].0;
    assert_eq!(
        page.evaluate_in_frame_realm(realm, "JSON.stringify(__got)")
            .unwrap(),
        r#"["hello-from-isolate|true|true"]"#,
        "up: the isolate's message reaches the realm, trusted, with its source"
    );

    page.evaluate_in_frame_realm(
        realm,
        "document.getElementById('x').contentWindow.postMessage('ping', '*')",
    )
    .unwrap();
    pump(&mut page, 4).await;
    assert_eq!(
        page.evaluate_in_frame_realm(realm, "JSON.stringify(__got)")
            .unwrap(),
        r#"["hello-from-isolate|true|true","pong:ping:true|true|true"]"#,
        "down and back: the realm reaches the isolate and hears its answer"
    );

    // Removing the realm frame takes the isolate with it.
    let _ = page
        .evaluate_async(
            "document.getElementById('outer').remove()",
            Duration::from_millis(300),
        )
        .await;
    assert_eq!(page.frame_realms().len(), 0);
    assert_eq!(page.child_frame_ids().len(), 0);
}
