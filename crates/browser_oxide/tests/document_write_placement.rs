//! `document.write` lands where the script sits, not at the end of `<body>`.
//!
//! Inline scripts run after the parse here rather than interleaved with it, so
//! there is no parser insertion point and the written markup used to be appended
//! to the document. Every legacy `<td><script>document.write(v)</script></td>`
//! table therefore rendered its cells empty and stacked the values at the bottom
//! of the page — visible on `bot.sannysoft.com`, where a dozen navigator
//! properties are printed exactly that way.

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
async fn a_write_lands_inside_the_cell_that_holds_the_script() {
    let mut page = page_with(
        "<table><tr>\
           <td id='a'><script>document.write('раз')</script></td>\
           <td id='b'><script>document.write('два')</script></td>\
         </tr></table>",
    )
    .await;

    // By structure, not by text: a cell's `textContent` also returns the source
    // of the `<script>` it holds, and that source contains the written string —
    // which is exactly what made the old, broken behaviour look correct.
    let shape = |page: &mut Page, id: &str| {
        page.evaluate(&format!(
            "(function(){{var c=document.getElementById('{id}');\
             return [].map.call(c.childNodes,function(n){{return n.nodeName}}).join('+')\
                    +'|last='+String(c.lastChild&&c.lastChild.textContent||'');}})()"
        ))
        .expect("cell")
    };
    let a = shape(&mut page, "a");
    let b = shape(&mut page, "b");
    assert!(
        a.contains("SCRIPT+#text") && a.contains("last=раз"),
        "в ячейке a нет написанного узла: {a}"
    );
    assert!(
        b.contains("SCRIPT+#text") && b.contains("last=два"),
        "в ячейке b нет написанного узла: {b}"
    );

    // The regression this replaces: everything was appended to <body> instead,
    // which showed up as a pile of stray values under the page.
    let strays = page
        .evaluate(
            "(function(){var out=[];\
             for(var n=document.body.firstChild;n;n=n.nextSibling)\
               if(n.nodeType===3&&String(n.data||'').trim())out.push(n.data.trim());\
             return out.join('|');})()",
        )
        .expect("strays");
    assert!(
        !strays.contains("раз") && !strays.contains("два"),
        "написанное осело прямо в body: {strays}"
    );
}

#[tokio::test]
async fn repeated_writes_from_one_script_keep_their_order() {
    let mut page = page_with(
        "<div id='d'><script>\
           document.write('раз');document.write('два');document.writeln('три');\
         </script></div>",
    )
    .await;
    let text = page
        .evaluate("document.getElementById('d').textContent")
        .expect("read");
    let order = |needle: &str| text.find(needle);
    assert!(
        order("раз") < order("два") && order("два") < order("три"),
        "порядок записей нарушен: {text}"
    );
}

#[tokio::test]
async fn written_markup_becomes_elements_not_text() {
    let mut page =
        page_with("<div id='d'><script>document.write('<b id=\\'w\\'>жирный</b>')</script></div>")
            .await;
    let shape = page
        .evaluate(
            "(function(){var w=document.getElementById('w');\
             return 'тег='+(w&&w.tagName)+' внутри='+(w&&w.parentNode&&w.parentNode.id);})()",
        )
        .expect("read");
    assert!(
        shape.contains("тег=B") && shape.contains("внутри=d"),
        "разметка не разобралась на месте: {shape}"
    );
}

/// The reason the placement was wrong in the first place.
///
/// The host runs each of the document's scripts itself, so `currentScript` can
/// only be set from outside — and the bridge it was set through is a named
/// global that the cleanup pass deletes, so every call threw into a discarded
/// result. `document.write` then had no anchor, and any library that locates its
/// own `<script>` tag to read `data-` attributes off it found nothing.
#[tokio::test]
async fn current_script_is_set_while_a_parser_inserted_script_runs() {
    let mut page = page_with(
        "<div id='d'><script id='s' data-key='значение'>\
           globalThis.__seen = document.currentScript\
             ? document.currentScript.id + '/' + document.currentScript.getAttribute('data-key')\
             : 'null';\
         </script></div>",
    )
    .await;

    let seen = page
        .evaluate("String(globalThis.__seen)")
        .expect("read currentScript");
    assert!(
        seen.contains("s/значение"),
        "скрипт не видит сам себя: {seen}"
    );

    // And it is null again once nothing is running.
    let after = page
        .evaluate("String(document.currentScript)")
        .expect("read after");
    assert!(after.contains("null"), "currentScript не сброшен: {after}");
}
