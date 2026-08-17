//! Inserting a `DocumentFragment` inserts its children, not the fragment.
//!
//! DOM "pre-insert" step 6. Getting this wrong is uniquely nasty because the
//! contents are not lost — they are reachable through whole-tree walks like
//! `getElementsByTagName` while being invisible to every element-oriented view
//! (`children`, `querySelectorAll`, selector matching), so the DOM quietly
//! contradicts itself. Widgets that assemble markup in a fragment and append it
//! once then render nothing at all: hCaptcha's checkbox iframe is one.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

async fn page_with(js: &str) -> Page {
    let mut page = Page::from_html(
        "<html><body><div id='host'></div></body></html>",
        Some(chrome_148_macos()),
    )
    .await
    .expect("page");
    page.evaluate(js).expect("script");
    page
}

/// The three views that must agree, as one string.
fn views(page: &mut Page) -> String {
    page.evaluate(
        "(function(){var h=document.getElementById('host');\
         return 'children='+[].map.call(h.children,function(c){return c.tagName}).join('+')\
             +' childNodes='+[].map.call(h.childNodes,function(c){return c.tagName||('#'+c.nodeType)}).join('+')\
             +' qsa='+h.querySelectorAll('iframe').length\
             +' tags='+document.getElementsByTagName('iframe').length;})()",
    )
    .expect("read")
}

#[tokio::test]
async fn append_child_flattens_a_fragment() {
    let mut page = page_with(
        "(function(){var f=document.createDocumentFragment();\
         f.appendChild(document.createElement('iframe'));\
         f.appendChild(document.createElement('textarea'));\
         document.getElementById('host').appendChild(f);})()",
    )
    .await;

    let v = views(&mut page);
    assert!(
        v.contains("children=IFRAME+TEXTAREA"),
        "дети должны быть самими узлами фрагмента: {v}"
    );
    // No `#11` — the fragment must not survive as a child node.
    assert!(
        !v.contains("#11"),
        "сам фрагмент не должен остаться в дереве: {v}"
    );
    assert!(
        v.contains("qsa=1") && v.contains("tags=1"),
        "селекторы и обход дерева должны согласоваться: {v}"
    );
}

#[tokio::test]
async fn insert_before_flattens_a_fragment_in_order() {
    let mut page = page_with(
        "(function(){var h=document.getElementById('host');\
         var anchor=document.createElement('span');h.appendChild(anchor);\
         var f=document.createDocumentFragment();\
         f.appendChild(document.createElement('iframe'));\
         f.appendChild(document.createElement('textarea'));\
         h.insertBefore(f, anchor);})()",
    )
    .await;

    let v = views(&mut page);
    assert!(
        v.contains("children=IFRAME+TEXTAREA+SPAN"),
        "порядок вставки должен сохраниться перед якорем: {v}"
    );
    assert!(!v.contains("#11"), "фрагмент не должен остаться: {v}");
}

#[tokio::test]
async fn an_inserted_fragment_is_left_empty() {
    let mut page = page_with(
        "(function(){globalThis.__f=document.createDocumentFragment();\
         globalThis.__f.appendChild(document.createElement('iframe'));\
         document.getElementById('host').appendChild(globalThis.__f);})()",
    )
    .await;

    let left = page
        .evaluate("String(globalThis.__f.childNodes.length)")
        .expect("read");
    assert!(
        left.contains('0'),
        "после вставки фрагмент должен опустеть, осталось: {left}"
    );
}
