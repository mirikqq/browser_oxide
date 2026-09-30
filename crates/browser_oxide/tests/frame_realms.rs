//! F4: frames as realms of the page's isolate — each a full document with its
//! own DOM, running the page's bootstraps, reachable synchronously from the
//! page.

use browser_oxide::html_parser::parse_html;
use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

async fn page() -> Page {
    Page::from_html_with_url(
        r#"<html><body><p id="m">main</p></body></html>"#,
        "https://example.com/",
        Some(chrome_148_macos()),
    )
    .await
    .expect("page")
}

#[tokio::test]
async fn a_frame_realm_is_a_document_of_its_own() {
    let mut page = page().await;
    let rt = page.event_loop().runtime_mut();
    let id = rt
        .create_frame_realm(
            parse_html("<html><body><p id=x>hi</p></body></html>"),
            vec![],
        )
        .expect("realm");

    assert_eq!(
        rt.execute_in_realm(id, "document.getElementById('x').textContent")
            .unwrap(),
        "hi"
    );
    assert_eq!(
        rt.execute_in_realm(id, "String(document.getElementById('m'))")
            .unwrap(),
        "null",
        "the realm sees its own document, not the page's"
    );
    assert_eq!(
        page.evaluate(
            "document.getElementById('m').textContent + '|' + document.getElementById('x')"
        )
        .unwrap(),
        "main|null",
        "the page's document is untouched"
    );
}

#[tokio::test]
async fn interleaved_calls_keep_each_realm_on_its_own_document() {
    let mut page = page().await;
    let id = page
        .event_loop()
        .runtime_mut()
        .create_frame_realm(parse_html("<html><body></body></html>"), vec![])
        .expect("realm");
    for i in 0..5 {
        page.event_loop()
            .runtime_mut()
            .execute_in_realm(
                id,
                &format!("var d = document.createElement('div'); d.id = 'f{i}'; document.body.appendChild(d); 1"),
            )
            .unwrap();
        page.evaluate(&format!(
            "var d = document.createElement('span'); d.id = 'p{i}'; document.body.appendChild(d); 1"
        ))
        .unwrap();
    }
    assert_eq!(
        page.event_loop()
            .runtime_mut()
            .execute_in_realm(
                id,
                "document.body.children.length + ':' + document.querySelectorAll('span').length"
            )
            .unwrap(),
        "5:0"
    );
    assert_eq!(
        page.evaluate("document.querySelectorAll('span').length + ':' + document.querySelectorAll('div').length")
            .unwrap(),
        "5:0"
    );
}

#[tokio::test]
async fn a_frame_realm_has_the_full_platform() {
    let mut page = page().await;
    let rt = page.event_loop().runtime_mut();
    let id = rt
        .create_frame_realm(parse_html("<html><body></body></html>"), vec![])
        .expect("realm");
    let probe = rt
        .execute_in_realm(
            id,
            "[typeof MouseEvent, typeof fetch, typeof setTimeout, typeof navigator.userAgent,\
              typeof Deno, typeof document.createElement('canvas').getContext,\
              Object.getPrototypeOf(window) === Window.prototype].join(',')",
        )
        .unwrap();
    assert_eq!(
        probe,
        "function,function,function,string,undefined,function,true"
    );
}
