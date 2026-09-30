//! Frame churn: frames removed and re-added across many rescans must never
//! crash the process.
//!
//! Cross-origin frames are isolates of their own (`ChildIframe`), and V8
//! requires isolates to be destroyed in strict reverse-of-creation order on a
//! thread. Dropping an older frame's isolate while a younger one survives is a
//! V8 fatal error (process abort, not a catchable panic): `Fatal error in
//! v8::HandleScope::CreateHandle()`. The isolate graveyard in `iframe.rs`
//! (`bury_frame` / `sweep_graveyard`) parks a removed isolate until it is
//! provably the youngest. Same-origin frames are realms of the page's own
//! isolate (F4) and have no such ordering constraint — but churning them must
//! destroy and rebuild their realms just as cleanly.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A small, deterministic xorshift32 PRNG — self-contained so this stress
/// test doesn't need to reason about which `rand` API version/constructor
/// this workspace pins.
struct Xorshift32(u32);
impl Xorshift32 {
    fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    fn below(&mut self, n: u32) -> u32 {
        self.next() % n.max(1)
    }
}

fn top_level_realms(page: &mut Page) -> usize {
    page.frame_realms()
        .into_iter()
        .filter(|(_, parent, _)| *parent == 0)
        .count()
}

/// Serve a tiny document for every request, on a local port.
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
                let body = "<html><body>frame</body></html>";
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

/// The original B1 crash: two cross-origin frames (isolates), the OLDER one
/// removed while the younger survives, then a rescan.
#[tokio::test]
async fn removing_an_older_isolate_frame_survives_a_rescan() {
    let port = serve().await;
    let profile = chrome_148_macos();
    let client = browser_oxide::net::HttpClient::new(&profile).expect("client");
    // The page is on `localhost`, the frames on `127.0.0.1`: cross-origin.
    let base = format!("http://localhost:{port}/");
    let mut page =
        Page::from_html_with_url("<html><body></body></html>", &base, Some(profile.clone()))
            .await
            .expect("page");
    page.evaluate(&format!(
        "(function(){{\
           var a=document.createElement('iframe'); a.id='a'; a.src='http://127.0.0.1:{port}/a';\
           var b=document.createElement('iframe'); b.id='b'; b.src='http://127.0.0.1:{port}/b';\
           document.body.appendChild(a); document.body.appendChild(b);\
         }})()"
    ))
    .expect("append both frames");
    page.rematerialize_iframes(&base, &client, &profile).await;
    assert_eq!(page.child_frame_ids().len(), 2, "both isolates built");

    page.evaluate("document.getElementById('a').remove()")
        .expect("remove a");
    page.rematerialize_iframes(&base, &client, &profile).await;

    // Reaching this line at all (rather than the process aborting above) is
    // the assertion.
    assert_eq!(page.child_frame_ids().len(), 1, "only b remains");
}

/// Churn same-origin frames — each a realm with a nested realm of its own —
/// by removing and re-adding random ones across many rescans.
#[tokio::test]
async fn random_realm_frame_churn_across_many_rescans() {
    const TOP_LEVEL: usize = 5;
    const ITERATIONS: usize = 200;

    let profile = chrome_148_macos();
    let client = browser_oxide::net::HttpClient::new(&profile).expect("client");
    let mut page = Page::from_html_with_url(
        "<html><body></body></html>",
        "https://example.com/",
        Some(profile.clone()),
    )
    .await
    .expect("page");

    let nested_srcdoc = |n: u32| -> String {
        format!(
            "<html><body>{n}<iframe srcdoc=\"&lt;html&gt;&lt;body&gt;nested {n}&lt;/body&gt;&lt;/html&gt;\"></iframe></body></html>"
        )
    };

    for i in 0..TOP_LEVEL {
        page.evaluate(&format!(
            "(function(){{var f=document.createElement('iframe');f.id='f{i}';\
             f.setAttribute('srcdoc', {srcdoc});document.body.appendChild(f);}})()",
            srcdoc = serde_json::to_string(&nested_srcdoc(i as u32)).unwrap()
        ))
        .expect("append top-level frame");
    }
    page.rematerialize_iframes("https://example.com/", &client, &profile)
        .await;
    assert_eq!(top_level_realms(&mut page), TOP_LEVEL);
    assert_eq!(
        page.frame_realms().len(),
        TOP_LEVEL * 2,
        "each with its nested frame"
    );

    let mut rng = Xorshift32(0x9E3779B9);
    for iter in 0..ITERATIONS {
        let slot = rng.below(TOP_LEVEL as u32) as usize;
        let fresh = rng.next();
        page.evaluate(&format!(
            "(function(){{\
               var old=document.getElementById('f{slot}'); if(old) old.remove();\
               var f=document.createElement('iframe'); f.id='f{slot}';\
               f.setAttribute('srcdoc', {srcdoc});\
               document.body.appendChild(f);\
             }})()",
            srcdoc = serde_json::to_string(&nested_srcdoc(fresh)).unwrap()
        ))
        .unwrap_or_else(|e| panic!("iteration {iter}: replace frame f{slot}: {e}"));
        page.rematerialize_iframes("https://example.com/", &client, &profile)
            .await;
    }

    assert_eq!(top_level_realms(&mut page), TOP_LEVEL);
    assert_eq!(
        page.frame_realms().len(),
        TOP_LEVEL * 2,
        "removed frames' realms (and their nested ones) are gone"
    );
    // Every slot resolves to a live document with its nested frame.
    for i in 0..TOP_LEVEL {
        assert_eq!(
            page.evaluate(&format!(
                "String(document.getElementById('f{i}').contentDocument.querySelectorAll('iframe').length)"
            ))
            .unwrap(),
            "1"
        );
    }
}
