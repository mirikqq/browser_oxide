//! An `<iframe>` whose document is the initial `about:blank` fires `load` while
//! the insertion that connects it is still running — before `appendChild`
//! returns — as in Chrome and the HTML spec ("process the iframe attributes",
//! initial insertion). Nothing is fetched for such a frame, so nothing else
//! fires it; a script that builds a scratch frame and waits for its `load`
//! hung forever.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

async fn blank_page() -> Page {
    Page::from_html("<html><body></body></html>", Some(chrome_148_macos()))
        .await
        .expect("page")
}

/// Appends a frame set up by `setup` and reports `<sync loads>/<loads after a
/// turn>`, counting the `onload` property and a listener separately.
async fn loads(page: &mut Page, setup: &str) -> String {
    page.evaluate(&format!(
        "(function(){{var f=document.createElement('iframe');{setup}\
         window.__r={{prop:0,ev:0}};f.onload=function(){{__r.prop++}};\
         f.addEventListener('load',function(){{__r.ev++}});\
         document.body.appendChild(f);window.__sync=__r.prop+','+__r.ev;}})()"
    ))
    .expect("append");
    page.evaluate_async("void 0", std::time::Duration::from_millis(50))
        .await
        .expect("turn");
    page.evaluate("__sync + '/' + __r.prop + ',' + __r.ev")
        .expect("read")
}

#[tokio::test]
async fn a_frame_without_src_loads_during_insertion() {
    let mut page = blank_page().await;
    assert_eq!(loads(&mut page, "").await, "1,1/1,1");
}

#[tokio::test]
async fn about_blank_and_empty_src_load_during_insertion() {
    let mut page = blank_page().await;
    assert_eq!(loads(&mut page, "f.src='about:blank';").await, "1,1/1,1");
    assert_eq!(
        loads(&mut page, "f.setAttribute('src','');").await,
        "1,1/1,1"
    );
    assert_eq!(
        loads(&mut page, "f.setAttribute('src',' ABOUT:BLANK ');").await,
        "1,1/1,1"
    );
}

#[tokio::test]
async fn a_frame_in_a_detached_tree_does_not_load() {
    let mut page = blank_page().await;
    let got = page
        .evaluate(
            "(function(){var d=document.createElement('div');var f=document.createElement('iframe');\
             var n=0;f.onload=function(){n++};d.appendChild(f);return String(n);})()",
        )
        .expect("append");
    assert_eq!(got, "0", "no browsing context outside a document");
}

#[tokio::test]
async fn a_blank_frame_from_inner_html_loads() {
    let mut page = blank_page().await;
    let got = page
        .evaluate(
            "(function(){var n=0;document.addEventListener('load',function(e){\
             if(e.target.tagName==='IFRAME')n++},true);\
             document.body.innerHTML='<iframe></iframe><iframe src=\"about:blank\"></iframe>';\
             return String(n);})()",
        )
        .expect("innerHTML");
    assert_eq!(got, "2");
}

#[tokio::test]
async fn the_loaded_blank_frame_is_usable_from_its_handler() {
    let mut page = blank_page().await;
    let got = page
        .evaluate(
            "(function(){var f=document.createElement('iframe');var out='none';\
             f.onload=function(){var w=f.contentWindow;out=typeof w.Array+'|'+\
             (w.Array!==Array)+'|'+w.document.readyState;};\
             document.body.appendChild(f);return out;})()",
        )
        .expect("append");
    assert_eq!(got, "function|true|complete");
}
