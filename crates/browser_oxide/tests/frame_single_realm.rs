//! Blocker B2 (partial, F4.2): once the engine runs a frame's document in a
//! realm of its own (`ChildIframe`), the parent isolate's `contentWindow`
//! realm for that frame is only a shell — it neither re-runs the frame's
//! scripts nor re-fetches its document, and a `postMessage` to it reaches the
//! real document.
//!
//! Before: touching `contentWindow` (the host's own message pump does, to
//! fill in `event.source`) ran the srcdoc a second time in the parent isolate;
//! a same-origin `src` document was fetched and run twice; and a message
//! posted through `contentWindow` landed in that copy, never in the document
//! the host drives. A relative `src` was also treated as cross-origin.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

async fn pump(page: &mut Page, rounds: usize) {
    for _ in 0..rounds {
        page.pump_iframe_messages();
        page.drive_children(Duration::from_millis(30)).await;
        let _ = page.evaluate_async("0", Duration::from_millis(30)).await;
    }
}

const PARENT_LISTENER: &str = r#"<script>
  globalThis.__got = [];
  addEventListener('message', e => __got.push(e.data));
</script>"#;

#[tokio::test]
async fn materialized_srcdoc_runs_once_and_receives_content_window_messages() {
    let profile = chrome_148_macos();
    let client = browser_oxide::net::HttpClient::new(&profile).expect("client");
    let parent = "https://example.com/";
    let mut page = Page::from_html_with_url(
        &format!(
            r#"<html><body>{PARENT_LISTENER}
               <iframe id="f" srcdoc="<script>
                 globalThis.__got = [];
                 addEventListener('message', function (e) {{ __got.push(e.data); }});
                 parent.postMessage('ran', '*');
               </script>"></iframe></body></html>"#
        ),
        parent,
        Some(profile.clone()),
    )
    .await
    .expect("page");
    page.rematerialize_iframes(parent, &client, &profile).await;
    assert_eq!(page.frame_realms().len(), 1);

    // Touch `contentWindow` the way page code and the pump both do, then post
    // through it.
    page.evaluate(
        "var w = document.getElementById('f').contentWindow; w.postMessage('ping', location.origin);",
    )
    .unwrap();
    pump(&mut page, 4).await;

    assert_eq!(
        page.evaluate("JSON.stringify(__got)").unwrap(),
        r#"["ran"]"#,
        "the frame's script must run exactly once"
    );
    assert_eq!(
        {
            let r = page.frame_realms()[0].0;
            page.evaluate_in_frame_realm(r, "JSON.stringify(__got)")
                .unwrap()
        },
        r#"["ping"]"#,
        "a message posted through contentWindow must reach the real document"
    );
}

async fn spawn_counting_server(body: &'static str, hits: Arc<AtomicUsize>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            let hits = hits.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                hits.fetch_add(1, Ordering::SeqCst);
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

#[tokio::test]
async fn relative_src_frame_is_same_origin_fetched_once_and_runs_once() {
    let hits = Arc::new(AtomicUsize::new(0));
    let port = spawn_counting_server(
        "<html><body><script>parent.postMessage('ran', '*');</script></body></html>",
        hits.clone(),
    )
    .await;
    let parent = format!("http://127.0.0.1:{port}/");
    let profile = chrome_148_macos();
    let client = browser_oxide::net::HttpClient::new(&profile).expect("client");
    let mut page = Page::from_html_with_url(
        &format!(
            r#"<html><body>{PARENT_LISTENER}<iframe id="f" src="child"></iframe></body></html>"#
        ),
        &parent,
        Some(profile.clone()),
    )
    .await
    .expect("page");
    page.rematerialize_iframes(&parent, &client, &profile).await;
    assert_eq!(page.frame_realms().len(), 1);
    let fetched = hits.load(Ordering::SeqCst);

    // Same origin: the document is reachable, not behind the cross-origin
    // proxy's SecurityError.
    assert_eq!(
        page.evaluate(
            "(function(){try{var d=document.getElementById('f').contentWindow.document;\
               return d?'ok':'null';}catch(e){return e.name;}})()"
        )
        .unwrap(),
        "ok"
    );
    pump(&mut page, 3).await;

    assert_eq!(
        hits.load(Ordering::SeqCst),
        fetched,
        "touching contentWindow must not fetch the document again"
    );
    assert_eq!(
        page.evaluate("JSON.stringify(__got)").unwrap(),
        r#"["ran"]"#,
        "the frame's script must run exactly once"
    );
}

/// Touching `contentWindow` before the engine has built the frame — in the
/// same task that appended it — used to run the srcdoc right there, in the
/// parent isolate, and again once the frame was built. In Chrome the srcdoc
/// has not loaded at that point either: `contentWindow` is still the initial
/// empty document.
#[tokio::test]
async fn content_window_touched_before_the_frame_is_built_runs_nothing() {
    let mut page = Page::from_html_with_url(
        &format!("<html><body>{PARENT_LISTENER}</body></html>"),
        "https://example.com/",
        Some(chrome_148_macos()),
    )
    .await
    .expect("page");
    let early = page
        .evaluate(
            "var f = document.createElement('iframe');\
             f.srcdoc = \"<script>globalThis.__ran = 1; parent.postMessage('ran', '*');</script>\";\
             document.body.appendChild(f);\
             String(f.contentWindow.__ran)",
        )
        .unwrap();
    assert_eq!(
        early, "undefined",
        "the srcdoc ran inside the parent isolate"
    );
    let _ = page.evaluate_async("0", Duration::from_secs(2)).await;
    assert_eq!(page.frame_realms().len(), 1);
    assert_eq!(
        page.evaluate("JSON.stringify(__got)").unwrap(),
        r#"["ran"]"#
    );
}

const INSERTS_FRAME_AFTER_LOAD: &str = r#"<html><body><script>
  globalThis.__got = [];
  addEventListener('message', e => __got.push(e.data));
  addEventListener('load', () => setTimeout(() => {
    const f = document.createElement('iframe');
    f.srcdoc = "<script>parent.postMessage('ran', '*');<\/script>";
    document.body.appendChild(f);
  }, 0));
</script></body></html>"#;

/// A frame the page's own script inserts after `load` is built by an ordinary
/// navigation — cold and warm alike — not only when it started as a challenge.
#[tokio::test]
async fn navigations_build_frames_inserted_after_load() {
    let hits = Arc::new(AtomicUsize::new(0));
    let port = spawn_counting_server(INSERTS_FRAME_AFTER_LOAD, hits).await;
    let url = format!("http://127.0.0.1:{port}/");

    let mut cold = Page::navigate(&url, chrome_148_macos(), 1)
        .await
        .expect("cold navigation");
    assert_eq!(cold.frame_realms().len(), 1, "cold: frame not built");
    assert_eq!(
        cold.evaluate("JSON.stringify(__got)").unwrap(),
        r#"["ran"]"#
    );

    let pool = browser_oxide::PagePool::new(1);
    for round in 0..2 {
        let mut warm = pool
            .navigate(&url, chrome_148_macos())
            .await
            .expect("pooled navigation");
        assert_eq!(
            warm.frame_realms().len(),
            1,
            "pooled navigation {round}: frame not built"
        );
        assert_eq!(
            warm.evaluate("JSON.stringify(__got)").unwrap(),
            r#"["ran"]"#,
            "pooled navigation {round}"
        );
        pool.release(warm);
    }
}

/// Settling runs on every `evaluate_async` now; a frame that cannot load is
/// tried once, not refetched on every turn.
#[tokio::test]
async fn a_frame_that_fails_to_load_is_not_refetched_every_turn() {
    let hits = Arc::new(AtomicUsize::new(0));
    // Not HTML: the frame "loads" but a 404-ish empty answer is what the
    // counting server gives any path; point the frame at a closed port
    // instead so the fetch itself fails.
    let port = spawn_counting_server("", hits.clone()).await;
    let closed = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let mut page = Page::from_html_with_url(
        &format!(
            r#"<html><body><iframe src="http://127.0.0.1:{closed}/x"></iframe></body></html>"#
        ),
        &format!("http://127.0.0.1:{port}/"),
        Some(chrome_148_macos()),
    )
    .await
    .expect("page");
    assert_eq!(page.child_frame_ids().len(), 0);
    let started = std::time::Instant::now();
    for _ in 0..5 {
        let _ = page.evaluate_async("0", Duration::from_millis(50)).await;
    }
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "each turn retried the failed frame: {:?}",
        started.elapsed()
    );
    assert_eq!(page.child_frame_ids().len(), 0);
}
