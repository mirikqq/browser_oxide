//! A script parsed out of markup never runs; one built with `createElement` does.
//!
//! HTML's "already started" flag: elements produced by `innerHTML`, `outerHTML`,
//! `insertAdjacentHTML`, `createContextualFragment` or `DOMParser` are created
//! already-started and must never execute, however they are inserted afterwards.
//! This engine ran them, which no browser does — `el.innerHTML = '<script>…'`
//! executed. Beyond the behaviour difference it aimed markup at the wrong realm:
//! an `<iframe srcdoc>` carrying a script had that script run in the *parent*
//! while the child realm was still being built.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

async fn page() -> Page {
    Page::from_html("<html><body></body></html>", Some(chrome_148_macos()))
        .await
        .expect("page")
}

#[tokio::test]
async fn inner_html_does_not_run_the_script_it_parses() {
    let mut page = page().await;
    let out = page
        .evaluate(
            "(function(){globalThis.__ran='нет';\
             var d=document.createElement('div');\
             d.innerHTML='<scr'+'ipt>globalThis.__ran=\"ДА\"</scr'+'ipt>';\
             document.body.appendChild(d);\
             return 'выполнился='+globalThis.__ran+' в DOM='+d.getElementsByTagName('script').length;})()",
        )
        .expect("innerHTML");
    assert!(
        out.contains("выполнился=нет"),
        "скрипт из innerHTML выполнился: {out}"
    );
    // Present in the tree, just inert — that is the browser's behaviour.
    assert!(
        out.contains("в DOM=1"),
        "элемент скрипта должен остаться в дереве: {out}"
    );
}

#[tokio::test]
async fn insert_adjacent_html_does_not_run_it_either() {
    let mut page = page().await;
    let out = page
        .evaluate(
            "(function(){globalThis.__ran2='нет';\
             var h=document.createElement('div');document.body.appendChild(h);\
             h.insertAdjacentHTML('beforeend','<scr'+'ipt>globalThis.__ran2=\"ДА\"</scr'+'ipt>');\
             return 'выполнился='+globalThis.__ran2;})()",
        )
        .expect("insertAdjacentHTML");
    assert!(
        out.contains("выполнился=нет"),
        "скрипт из insertAdjacentHTML выполнился: {out}"
    );
}

/// The other half of the rule — without it the engine would just never run
/// dynamic scripts, which breaks every loader on the web.
#[tokio::test]
async fn a_script_built_by_create_element_still_runs() {
    let mut page = page().await;
    let out = page
        .evaluate(
            "(function(){globalThis.__ran3='нет';\
             var s=document.createElement('script');\
             s.textContent='globalThis.__ran3=\"ДА\"';\
             document.body.appendChild(s);\
             return 'выполнился='+globalThis.__ran3;})()",
        )
        .expect("createElement script");
    assert!(
        out.contains("выполнился=ДА"),
        "динамический скрипт перестал выполняться: {out}"
    );
}

/// A frame's own document is searchable: markup written into it can be found
/// again through the same document.
#[tokio::test]
async fn a_frame_document_can_find_what_was_written_into_it() {
    let mut page = page().await;
    let out = page
        .evaluate(
            "(function(){var host=document.createElement('div');\
             document.body.appendChild(host);\
             host.innerHTML='<iframe id=\"ф\"></iframe>';\
             var doc=document.getElementById('ф').contentWindow.document;\
             doc.body.innerHTML='<div id=\"метка\" class=\"кл\">текст</div><span class=\"кл\"></span>';\
             return 'byId='+(doc.getElementById('метка')?'да':'нет')\
                    +' byClass='+doc.getElementsByClassName('кл').length\
                    +' qsa='+doc.querySelectorAll('div,span').length\
                    +' текст='+(doc.getElementById('метка')||{}).textContent;})()",
        )
        .expect("frame document");
    assert!(
        out.contains("byId=да") && out.contains("byClass=2") && out.contains("qsa=2"),
        "документ фрейма не находит собственную разметку: {out}"
    );
    assert!(out.contains("текст=текст"), "содержимое потерялось: {out}");
}
