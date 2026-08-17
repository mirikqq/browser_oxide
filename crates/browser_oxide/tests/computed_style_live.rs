//! `getComputedStyle` returns a live declaration, not a snapshot.
//!
//! Per spec the object reflects the element's current state on every read.
//! Memoising it freezes the element at whatever it looked like the first time
//! anything asked — and the usual shape of that bug is a modal that is revealed
//! by rewriting inline style and then still reads as hidden, which is
//! indistinguishable from "the reveal never happened".

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

async fn page() -> Page {
    Page::from_html(
        "<html><head><style>#box{visibility:hidden;opacity:0;z-index:-1;display:flex}</style></head>\
         <body><div id='box'></div></body></html>",
        Some(chrome_148_macos()),
    )
    .await
    .expect("page")
}

#[tokio::test]
async fn a_reveal_after_the_first_read_is_visible() {
    let mut p = page().await;

    // Read first, so any per-element memo is already populated — this is what
    // real pages do, and what made the bug invisible in isolation.
    let before = p
        .evaluate("getComputedStyle(document.getElementById('box')).visibility")
        .expect("eval");
    assert!(
        before.contains("hidden"),
        "исходно скрыт, получено: {before}"
    );

    let after = p
        .evaluate(
            "(function(){var b=document.getElementById('box');\
             b.setAttribute('style','visibility:visible;opacity:1;z-index:100000');\
             var c=getComputedStyle(b);\
             return c.visibility+'/'+c.opacity+'/'+c.zIndex;})()",
        )
        .expect("eval");
    assert!(
        after.contains("visible") && after.contains('1') && after.contains("100000"),
        "после раскрытия ожидались visible/1/100000, получено: {after}"
    );
}

#[tokio::test]
async fn the_same_declaration_object_tracks_later_changes() {
    let mut p = page().await;
    let v = p
        .evaluate(
            "(function(){var b=document.getElementById('box');\
             var c=getComputedStyle(b);\
             var first=c.visibility;\
             b.setAttribute('style','visibility:visible');\
             return first+'→'+c.visibility;})()",
        )
        .expect("eval");
    // Holding on to the declaration is normal usage; it must not go stale.
    assert_eq!(
        v, "hidden→visible",
        "живой объект должен отслеживать правку"
    );
}

#[tokio::test]
async fn get_property_value_is_live_too() {
    let mut p = page().await;
    let v = p
        .evaluate(
            "(function(){var b=document.getElementById('box');\
             var c=getComputedStyle(b);\
             c.getPropertyValue('visibility');\
             b.setAttribute('style','visibility:visible');\
             return c.getPropertyValue('visibility');})()",
        )
        .expect("eval");
    assert!(v.contains("visible"), "getPropertyValue устарел: {v}");
}
