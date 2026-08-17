//! An `about:blank` iframe exposes a complete empty document.
//!
//! A blank same-origin frame is the standard way to get at untouched native
//! objects, so anti-bot and framework code reaches for one routinely — and the
//! first thing it touches is `contentDocument.body`. Handing back `null` there
//! reads as "not loaded yet" to code that then waits forever, with no error
//! anywhere.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

async fn probe(html: &str) -> String {
    let mut page = Page::from_html(html, Some(chrome_148_macos()))
        .await
        .expect("page");
    page.evaluate(
        "(function(){var f=document.querySelector('iframe');\
         var d=f.contentDocument, w=f.contentWindow;\
         return 'cw='+(w?'есть':'НЕТ')\
             +' doc='+(d?'есть':'НЕТ')\
             +' readyState='+(d&&d.readyState)\
             +' documentElement='+(d&&d.documentElement?d.documentElement.tagName:'НЕТ')\
             +' head='+(d&&d.head?d.head.tagName:'НЕТ')\
             +' body='+(d&&d.body?d.body.tagName:'НЕТ');})()",
    )
    .expect("eval")
}

#[tokio::test]
async fn blank_frame_has_html_head_and_body() {
    let v = probe("<html><body><iframe src='about:blank'></iframe></body></html>").await;
    assert!(v.contains("doc=есть"), "документ должен быть: {v}");
    assert!(v.contains("documentElement=HTML"), "нужен <html>: {v}");
    assert!(v.contains("head=HEAD"), "нужен <head>: {v}");
    assert!(v.contains("body=BODY"), "нужен <body>, а не null: {v}");
}

#[tokio::test]
async fn frame_without_src_also_has_a_body() {
    // No `src` at all is the same case: the frame is at about:blank.
    let v = probe("<html><body><iframe></iframe></body></html>").await;
    assert!(v.contains("body=BODY"), "нужен <body>: {v}");
}

#[tokio::test]
async fn srcdoc_frame_keeps_its_document() {
    let v = probe("<html><body><iframe srcdoc='<p>hi</p>'></iframe></body></html>").await;
    assert!(
        v.contains("body=BODY"),
        "srcdoc не должен потерять body: {v}"
    );
    assert!(v.contains("documentElement=HTML"), "и documentElement: {v}");
}
