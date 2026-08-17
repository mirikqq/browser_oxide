//! Node classes that a page constructs itself, and `<template>` contents.
//!
//! Both were shells: `new DocumentFragment()` produced an object with no node
//! behind it — `nodeType` 0, every mutation a silent no-op — and
//! `HTMLTemplateElement` had no `content` at all. Together they break the two
//! most common ways a script builds markup off-document, and they do it without
//! raising anything: the fragment simply inserts nothing.
//!
//! Measured on creepjs, which uses both: it builds its measurement iframe inside
//! a fragment, finds no frame where it expects one, falls back to the *main*
//! window, and overwrites the real page with its own probe markup — 246 elements
//! down to 13, rendering blank.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

async fn page_with(body: &str) -> Page {
    Page::from_html(
        &format!("<html><body>{body}</body></html>"),
        Some(chrome_148_macos()),
    )
    .await
    .expect("page")
}

#[tokio::test]
async fn a_constructed_fragment_is_a_real_node() {
    let mut page = page_with("<div id='host'></div>").await;
    let shape = page
        .evaluate(
            "(function(){var f=new DocumentFragment();\
             f.appendChild(document.createElement('b'));\
             return 'nodeType='+f.nodeType+' детей='+f.childNodes.length;})()",
        )
        .expect("fragment");
    assert!(
        shape.contains("nodeType=11") && shape.contains("детей=1"),
        "конструктор фрагмента не даёт живой узел: {shape}"
    );
}

#[tokio::test]
async fn a_constructed_text_node_carries_its_data() {
    let mut page = page_with("<div id='host'></div>").await;
    let shape = page
        .evaluate("(function(){var t=new Text('привет');return 'nodeType='+t.nodeType+' data='+t.data;})()")
        .expect("text");
    assert!(
        shape.contains("nodeType=3") && shape.contains("data=привет"),
        "конструктор текстового узла: {shape}"
    );
}

/// The exact shape creepjs uses, and the one that silently inserted nothing.
#[tokio::test]
async fn a_subtree_built_in_a_fragment_reaches_the_document() {
    let mut page = page_with("<div id='host'></div>").await;
    let shape = page
        .evaluate(
            "(function(){var frag=new DocumentFragment();\
             var div=document.createElement('div');\
             frag.appendChild(div);\
             div.innerHTML='<div><span id=\\'глубоко\\'>тут</span></div>';\
             document.body.appendChild(frag);\
             var found=document.getElementById('глубоко');\
             return 'нашли='+!!found+' текст='+(found&&found.textContent);})()",
        )
        .expect("insert");
    assert!(
        shape.contains("нашли=true") && shape.contains("текст=тут"),
        "поддерево из фрагмента не доехало до документа: {shape}"
    );
}

#[tokio::test]
async fn template_contents_live_in_a_fragment_not_in_the_tree() {
    let mut page = page_with("<div id='host'></div>").await;
    let shape = page
        .evaluate(
            "(function(){var t=document.createElement('template');\
             t.innerHTML='<b>жир</b><i>кур</i>';\
             var c=t.content;\
             var copy=document.importNode(c,true);\
             return 'content='+c.nodeType+' детей='+c.childNodes.length\
                    +' самShablon='+t.childNodes.length\
                    +' innerHTML='+t.innerHTML\
                    +' копия='+(copy&&copy.childNodes.length);})()",
        )
        .expect("template");
    assert!(
        shape.contains("content=11") && shape.contains("детей=2"),
        "template.content не фрагмент: {shape}"
    );
    // Spec: the contents are *not* children of the element itself.
    assert!(
        shape.contains("самShablon=0"),
        "содержимое шаблона осталось в дереве: {shape}"
    );
    assert!(
        shape.contains("<b>жир</b><i>кур</i>"),
        "innerHTML шаблона не читается из content: {shape}"
    );
    // `document.importNode(t.content, true)` is the idiom this exists for.
    assert!(
        shape.contains("копия=2"),
        "importNode по content не сработал: {shape}"
    );
}

/// A `<template>` written by the parser, not by script.
#[tokio::test]
async fn parsed_template_contents_are_reachable_too() {
    let mut page = page_with("<template id='t'><p>раз</p><p>два</p></template>").await;
    let shape = page
        .evaluate(
            "(function(){var t=document.getElementById('t');\
             return 'детей content='+t.content.childNodes.length\
                    +' вДереве='+t.childNodes.length\
                    +' | qsa на документе='+document.querySelectorAll('p').length;})()",
        )
        .expect("parsed template");
    assert!(
        shape.contains("детей content=2") && shape.contains("вДереве=0"),
        "разобранный шаблон не переехал в content: {shape}"
    );
    // Contents are inert: selectors over the document must not see them.
    assert!(
        shape.contains("qsa на документе=0"),
        "содержимое шаблона видно селекторам документа: {shape}"
    );
}
