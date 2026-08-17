//! `innerText` reads *rendered* text, and exists at all.
//!
//! It was missing outright, which `'innerText' in document.body` finds in one
//! line. Returning `textContent` instead would be its own tell: that hands back
//! inline `<style>` rules and every `display:none` panel on the page, so a
//! scraper reading `innerText` sees text no user could.

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
async fn the_property_exists_on_the_prototype_with_both_accessors() {
    let mut page = page_with("<div id='d'>привет</div>").await;
    let shape = page
        .evaluate(
            "(function(){var d=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'innerText');\
             return 'in='+('innerText' in document.body)+\
                    ' get='+(d&&typeof d.get)+' set='+(d&&typeof d.set)+\
                    ' outer='+('outerText' in document.body);})()",
        )
        .expect("read descriptor");
    assert!(
        shape.contains("in=true")
            && shape.contains("get=function")
            && shape.contains("set=function"),
        "innerText не выглядит как в браузере: {shape}"
    );
    assert!(
        shape.contains("outer=true"),
        "outerText отсутствует: {shape}"
    );
}

#[tokio::test]
async fn hidden_subtrees_and_style_tags_do_not_contribute() {
    let mut page = page_with(
        "<div id='d'>a<span style='display:none'>скрыто</span>\
         <span style='visibility:hidden'>тоже</span>b\
         <style>.x{color:red}</style><script>var q=1</script></div>",
    )
    .await;
    let text = page
        .evaluate("document.getElementById('d').innerText")
        .expect("innerText");
    let content = page
        .evaluate("document.getElementById('d').textContent")
        .expect("textContent");

    assert!(
        !text.contains("скрыто") && !text.contains("тоже"),
        "скрытое попало в innerText: {text}"
    );
    assert!(
        !text.contains("color:red") && !text.contains("var q"),
        "style/script попали в innerText: {text}"
    );
    // The contrast that makes the property worth having.
    assert!(
        content.contains("скрыто") && content.contains("color:red"),
        "textContent должен был всё это вернуть: {content}"
    );
}

/// Chrome parity, and the reason the count matters: `<p>` asks for two line
/// breaks, every other block for one, `<br>` for one, and a block that ends the
/// element adds none.
#[tokio::test]
async fn line_breaks_follow_the_required_count_per_element() {
    let mut page = page_with(
        "<div id='p'><p>раз</p><p>два</p></div>\
         <div id='b'><div>раз</div><div>два</div></div>\
         <div id='r'>раз<br>два</div>",
    )
    .await;
    let read = |page: &mut Page, id: &str| {
        page.evaluate(&format!(
            "JSON.stringify(document.getElementById('{id}').innerText)"
        ))
        .expect("innerText")
    };

    let paragraphs = read(&mut page, "p");
    assert!(
        paragraphs.contains("раз\\n\\nдва") && !paragraphs.contains("\\n\\n\\n"),
        "два <p> должны разделяться ровно двумя переносами: {paragraphs}"
    );
    let blocks = read(&mut page, "b");
    assert!(
        blocks.contains("раз\\nдва") && !blocks.contains("\\n\\n"),
        "два <div> должны разделяться одним переносом: {blocks}"
    );
    let breaks = read(&mut page, "r");
    assert!(
        breaks.contains("раз\\nдва"),
        "<br> не дал перенос: {breaks}"
    );
}

#[tokio::test]
async fn runs_of_whitespace_collapse() {
    let mut page = page_with("<div id='d'>раз   \n\t  два</div>").await;
    let text = page
        .evaluate("JSON.stringify(document.getElementById('d').innerText)")
        .expect("innerText");
    assert!(text.contains("раз два"), "пробелы не схлопнулись: {text}");
}

#[tokio::test]
async fn assignment_turns_line_breaks_into_br_elements() {
    let mut page = page_with("<div id='d'>старое</div>").await;
    let shape = page
        .evaluate(
            "(function(){var d=document.getElementById('d');d.innerText='раз\\nдва';\
             return [].map.call(d.childNodes,function(n){return n.nodeName}).join('+')\
                    +' | textContent='+d.textContent;})()",
        )
        .expect("assign");
    assert!(
        shape.contains("#text+BR+#text"),
        "перевод строки не стал <br>: {shape}"
    );
    // Chrome parity: the newline lives in the element, not in the text.
    assert!(
        shape.contains("textContent=раздва"),
        "textContent после присваивания: {shape}"
    );
}
