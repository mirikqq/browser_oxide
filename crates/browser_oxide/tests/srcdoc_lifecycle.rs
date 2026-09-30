//! Regression tests (Q9 / F3.2-F3.3): a `srcdoc` iframe's `<script src>`
//! must actually be fetched and run (it used to be silently skipped
//! entirely — B3), relative URLs resolve via `Url::join` against the
//! parent document's URL (not just absolute/root-relative, which the old
//! ad-hoc string concatenation handled), and the owning `<iframe>` element
//! gets a `load` event once its child context finishes.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Serve a tiny JS body for every request and count hits, on a local
/// ephemeral port. No external network — hermetic like `proxy_roundtrip.rs`.
async fn spawn_script_server(hits: Arc<AtomicUsize>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            let hits = hits.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf).await;
                hits.fetch_add(1, Ordering::SeqCst);
                let body = b"/* external srcdoc script ran */";
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/javascript\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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

#[tokio::test]
async fn srcdoc_iframe_fetches_relative_external_script() {
    let hits = Arc::new(AtomicUsize::new(0));
    let port = spawn_script_server(hits.clone()).await;
    let base_url = format!("http://127.0.0.1:{port}/page.html");

    let profile = chrome_148_macos();
    let client = browser_oxide::net::HttpClient::new(&profile).expect("client");

    let mut page = Page::from_html("<html><body></body></html>", Some(profile.clone()))
        .await
        .expect("page");
    page.evaluate(
        "(function(){var f=document.createElement('iframe');f.id='a';\
         f.srcdoc='<html><body><script src=\"widget.js\"></script></body></html>';\
         document.body.appendChild(f);})()",
    )
    .expect("append");

    page.rematerialize_iframes(&base_url, &client, &profile)
        .await;

    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "a relative <script src> inside srcdoc must be fetched exactly once, not skipped"
    );
}

#[tokio::test]
async fn owner_iframe_element_fires_load_after_srcdoc_materializes() {
    let profile = chrome_148_macos();
    let client = browser_oxide::net::HttpClient::new(&profile).expect("client");
    let mut page = Page::from_html("<html><body></body></html>", Some(profile.clone()))
        .await
        .expect("page");
    page.evaluate(
        "(function(){\
           globalThis.__loaded = false;\
           var f = document.createElement('iframe');\
           f.id = 'a';\
           f.addEventListener('load', function(){ __loaded = true; });\
           f.srcdoc = '<html><body>one</body></html>';\
           document.body.appendChild(f);\
         })()",
    )
    .expect("append");

    page.rematerialize_iframes("https://example.com/", &client, &profile)
        .await;

    assert_eq!(
        page.evaluate("String(__loaded)").unwrap(),
        "true",
        "the owning <iframe> element must fire `load` once its srcdoc document finishes"
    );
}
