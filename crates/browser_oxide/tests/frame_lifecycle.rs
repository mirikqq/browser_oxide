//! A browsing context belongs to its `<iframe>` element, and DOM mutation is what
//! creates and destroys one.
//!
//! These cover the three transitions a periodic DOM rescan cannot express:
//! removing a frame (the realm must go), rewriting `src`/`srcdoc` (the old realm
//! must go and a new one take its place), and re-parenting (the realm must survive
//! the round trip). Getting this wrong is silent — a stale realm keeps answering
//! while the live element it no longer matches receives nothing — so it is checked
//! by counting realms rather than by observing behaviour.
//!
//! `srcdoc` throughout: no network, so these run in CI with the rest.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

/// Realm count after letting the page apply whatever the DOM recorded.
async fn sync(page: &mut Page) -> usize {
    let profile = chrome_148_macos();
    let client = browser_oxide::net::HttpClient::new(&profile).expect("client");
    page.rematerialize_iframes("https://example.com/", &client, &profile)
        .await;
    page.child_frame_ids().len()
}

async fn blank_page() -> Page {
    Page::from_html("<html><body></body></html>", Some(chrome_148_macos()))
        .await
        .expect("page")
}

#[tokio::test]
async fn appending_an_iframe_creates_a_realm() {
    let mut page = blank_page().await;
    assert_eq!(sync(&mut page).await, 0, "пустая страница — реалмов нет");

    let probe = page
        .evaluate(
            "(function(){var f=document.createElement('iframe');f.id='a';\
             f.srcdoc='<html><body>one</body></html>';document.body.appendChild(f);\
             return 'attr=' + JSON.stringify(f.getAttribute('srcdoc')||'');})()",
        )
        .expect("append");

    // Property assignment has to write the attribute: the host scans attributes,
    // so an unreflected `srcdoc` is a frame the engine never learns about.
    assert!(
        probe.contains("<html>"),
        "srcdoc должен отражаться в атрибут, получено: {probe}"
    );
    assert_eq!(sync(&mut page).await, 1, "после вставки — один реалм");
}

#[tokio::test]
async fn removing_an_iframe_discards_its_realm() {
    let mut page = blank_page().await;
    page.evaluate(
        "(function(){var f=document.createElement('iframe');f.id='a';\
         f.srcdoc='<html><body>one</body></html>';document.body.appendChild(f);})()",
    )
    .expect("append");
    assert_eq!(sync(&mut page).await, 1);

    page.evaluate("document.getElementById('a').remove()")
        .expect("remove");

    // Without a removal hook the realm outlives its element: nothing can address
    // it, but it still gets driven and still pushes messages at the embedder.
    assert_eq!(sync(&mut page).await, 0, "реалм снят вместе с элементом");
}

#[tokio::test]
async fn rewriting_srcdoc_renavigates_the_frame() {
    let mut page = blank_page().await;
    page.evaluate(
        "(function(){var f=document.createElement('iframe');f.id='a';\
         f.srcdoc='<html><body><p id=mark>one</p></body></html>';document.body.appendChild(f);})()",
    )
    .expect("append");
    assert_eq!(sync(&mut page).await, 1);

    page.evaluate(
        "document.getElementById('a').srcdoc='<html><body><p id=mark>two</p></body></html>'",
    )
    .expect("rewrite");
    assert_eq!(sync(&mut page).await, 1, "по-прежнему ровно один реалм");

    // The realm must hold the *new* document. Skipping the rebuild leaves the old
    // one in place, which reads as a frame that ignores every navigation.
    let mut page = page;
    let text = page
        .child_iframe(0)
        .expect("child")
        .evaluate("document.getElementById('mark').textContent")
        .expect("eval");
    assert_eq!(text, "two", "реалм содержит новый документ");
}

#[tokio::test]
async fn reparenting_keeps_one_realm() {
    let mut page = blank_page().await;
    page.evaluate(
        "(function(){var d=document.createElement('div');d.id='host';document.body.appendChild(d);\
         var f=document.createElement('iframe');f.id='a';\
         f.srcdoc='<html><body>one</body></html>';document.body.appendChild(f);})()",
    )
    .expect("append");
    assert_eq!(sync(&mut page).await, 1);

    // Widgets move their own frame into a container once it is ready. A lifecycle
    // driven by rescanning sees the gap and deletes a live context.
    page.evaluate(
        "(function(){var f=document.getElementById('a');\
         document.getElementById('host').appendChild(f);})()",
    )
    .expect("reparent");

    assert_eq!(
        sync(&mut page).await,
        1,
        "переезд не плодит и не теряет реалм"
    );
}

#[tokio::test]
async fn rebuilding_a_container_replaces_its_frames() {
    let mut page = blank_page().await;
    page.evaluate(
        "(function(){var d=document.createElement('div');d.id='host';document.body.appendChild(d);\
         d.innerHTML='<iframe srcdoc=\"<html><body>one</body></html>\"></iframe>';})()",
    )
    .expect("build");
    assert_eq!(sync(&mut page).await, 1, "innerHTML создал фрейм");

    // Rewriting a container wholesale is how a widget re-renders. It destroys the
    // frames that were inside and may bring new ones; neither shows up in a
    // mutation hook that only watches appendChild/removeChild.
    page.evaluate(
        "document.getElementById('host').innerHTML='<iframe srcdoc=\"<html><body>two</body></html>\"></iframe>'",
    )
    .expect("rebuild");
    assert_eq!(
        sync(&mut page).await,
        1,
        "ровно один реалм после перестройки"
    );

    page.evaluate("document.getElementById('host').innerHTML=''")
        .expect("clear");
    assert_eq!(sync(&mut page).await, 0, "очистка снимает реалм");
}
