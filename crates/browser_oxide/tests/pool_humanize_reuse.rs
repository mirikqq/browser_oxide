//! Regression tests for `PagePool` + `humanize.js` install correctness.
//!
//! `PagePool::navigate_with_init` used to reinstall `js/humanize.js`
//! unconditionally on top of `navigate_warm_with_init`'s own reinstall, in
//! the same navigation — the second install always found the single-use
//! `inputApi` trajectory bridge already captured-and-deleted by the first,
//! silently downgrading `human_click`/`human_type`. That double-install is
//! fixed and covered by `pooled_page_first_navigation_click_is_trusted`.
//!
//! Separately, the `markTrusted`/`inputApi` bootstrap handles used to be
//! single-use: humanize.js captured-and-deleted them on its first-ever
//! install, so a warm-reused page's second-and-later navigations fell back to
//! untrusted events / linear mouse paths. They are now lifted into Rust-held
//! handles at isolate creation (`js_runtime/privileged.rs`) and handed to
//! humanize.js as a call argument on every install, which
//! `pooled_page_second_navigation_click_is_trusted` covers.
//!
//! No external network: a local TCP listener serves the fixture, like
//! `proxy_roundtrip.rs`. The passing test is hermetic, not `#[ignore]`.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::PagePool;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const HTML: &str = r#"<!doctype html><html><body>
<button id="go" style="position:absolute;left:40px;top:40px;width:90px;height:30px">go</button>
<script>
  globalThis.__log = [];
  document.getElementById('go').addEventListener('click', (e) => {
    __log.push(e.isTrusted);
  });
</script>
</body></html>"#;

/// Serve `HTML` for every request that arrives, indefinitely, on a local
/// ephemeral port.
async fn spawn_html_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                // Don't care about the request line/headers — always serve
                // the same fixture.
                let _ = sock.read(&mut buf).await;
                let body = HTML.as_bytes();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.write_all(body).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    port
}

/// The double-install bug (`pool.rs` reinstalling `humanize.js` on top of
/// `navigate_warm_with_init`'s own reinstall) is fixed: the very first
/// pooled navigation's click is trusted.
#[tokio::test]
async fn pooled_page_first_navigation_click_is_trusted() {
    let port = spawn_html_server().await;
    let url = format!("http://127.0.0.1:{port}/");
    let pool = PagePool::new(1);

    let mut page = pool
        .navigate(&url, chrome_148_macos())
        .await
        .expect("first navigation");
    page.human_click("#go").await.expect("first click runs");
    let log: Vec<bool> =
        serde_json::from_str(&page.evaluate("JSON.stringify(__log)").unwrap()).unwrap();
    assert_eq!(log, vec![true], "first navigation: click not trusted");
}

/// A warm-reused page's SECOND navigation gets trusted clicks too: the
/// capabilities live in Rust for the isolate's lifetime.
#[tokio::test]
async fn pooled_page_second_navigation_click_is_trusted() {
    let port = spawn_html_server().await;
    let url = format!("http://127.0.0.1:{port}/");
    let pool = PagePool::new(1);

    let page = pool
        .navigate(&url, chrome_148_macos())
        .await
        .expect("first navigation");
    pool.release(page);

    let mut page = pool
        .navigate(&url, chrome_148_macos())
        .await
        .expect("second (warm) navigation");
    page.human_click("#go").await.expect("second click runs");
    let log: Vec<bool> =
        serde_json::from_str(&page.evaluate("JSON.stringify(__log)").unwrap()).unwrap();
    assert_eq!(
        log,
        vec![true],
        "second navigation on a warm-reused page: click not trusted"
    );
}
