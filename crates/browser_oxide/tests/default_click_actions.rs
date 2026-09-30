//! Regression tests for click default actions (Q5 / F1.5): checkbox toggle,
//! radio-group exclusivity, `<label>` forwarding, `<a href>` navigation,
//! `<details>/<summary>` toggling, and disabled elements receiving no click
//! at all. Before this fix `_runActivation` only handled submit/reset/image
//! buttons — everything else silently did nothing.

use browser_oxide::stealth::StealthProfile;
use browser_oxide::Page;

async fn page(html: &str) -> Page {
    Page::from_html(html, None::<StealthProfile>)
        .await
        .expect("page builds")
}

#[tokio::test]
async fn click_toggles_checkbox_and_resets_indeterminate() {
    let mut page = page(
        r#"<input id="c" type="checkbox">
        <script>document.getElementById('c').indeterminate = true;</script>"#,
    )
    .await;
    assert_eq!(
        page.evaluate("document.getElementById('c').checked")
            .unwrap(),
        "false"
    );
    page.evaluate("document.getElementById('c').click()")
        .unwrap();
    assert_eq!(
        page.evaluate("document.getElementById('c').checked")
            .unwrap(),
        "true"
    );
    assert_eq!(
        page.evaluate("document.getElementById('c').indeterminate")
            .unwrap(),
        "false",
        "activation must clear indeterminate"
    );
    page.evaluate("document.getElementById('c').click()")
        .unwrap();
    assert_eq!(
        page.evaluate("document.getElementById('c').checked")
            .unwrap(),
        "false"
    );
}

#[tokio::test]
async fn click_fires_input_and_change_on_checkbox() {
    let mut page = page(
        r#"<input id="c" type="checkbox">
        <script>
          globalThis.__log = [];
          document.getElementById('c').addEventListener('input', () => __log.push('input'));
          document.getElementById('c').addEventListener('change', () => __log.push('change'));
        </script>"#,
    )
    .await;
    page.evaluate("document.getElementById('c').click()")
        .unwrap();
    assert_eq!(
        page.evaluate("JSON.stringify(__log)").unwrap(),
        r#"["input","change"]"#
    );
}

#[tokio::test]
async fn click_makes_radio_group_mutually_exclusive() {
    let mut page = page(
        r#"<input id="a" type="radio" name="g" checked>
           <input id="b" type="radio" name="g">"#,
    )
    .await;
    assert_eq!(
        page.evaluate("document.getElementById('a').checked")
            .unwrap(),
        "true"
    );
    page.evaluate("document.getElementById('b').click()")
        .unwrap();
    assert_eq!(
        page.evaluate("document.getElementById('a').checked")
            .unwrap(),
        "false",
        "clicking b must uncheck a"
    );
    assert_eq!(
        page.evaluate("document.getElementById('b').checked")
            .unwrap(),
        "true"
    );
}

#[tokio::test]
async fn click_on_label_forwards_to_its_control() {
    let mut page = page(
        r#"<label id="lbl" for="c">click me</label>
           <input id="c" type="checkbox">"#,
    )
    .await;
    page.evaluate("document.getElementById('lbl').click()")
        .unwrap();
    assert_eq!(
        page.evaluate("document.getElementById('c').checked")
            .unwrap(),
        "true",
        "label click must forward to its `for` control"
    );
}

#[tokio::test]
async fn click_on_wrapping_label_forwards_to_descendant_control() {
    let mut page = page(r#"<label id="lbl">text <input id="c" type="checkbox"></label>"#).await;
    page.evaluate("document.getElementById('lbl').click()")
        .unwrap();
    assert_eq!(
        page.evaluate("document.getElementById('c').checked")
            .unwrap(),
        "true",
        "label with no `for` must forward to its first labelable descendant"
    );
}

#[tokio::test]
async fn click_on_link_navigates() {
    let mut page = page(r##"<a id="go" href="#section2">jump</a><div id="section2"></div>"##).await;
    let before = page.evaluate("location.href").unwrap();
    page.evaluate("document.getElementById('go').click()")
        .unwrap();
    let after = page.evaluate("location.href").unwrap();
    assert!(
        after.ends_with("#section2"),
        "expected hash navigation, got {after}"
    );
    assert_ne!(before, after);
}

#[tokio::test]
async fn click_on_link_with_download_does_not_navigate() {
    let mut page = page(r#"<a id="go" href="/file.zip" download>get</a>"#).await;
    let before = page.evaluate("location.href").unwrap();
    page.evaluate("document.getElementById('go').click()")
        .unwrap();
    let after = page.evaluate("location.href").unwrap();
    assert_eq!(before, after, "a[download] click must not navigate");
}

#[tokio::test]
async fn click_on_summary_toggles_parent_details() {
    let mut page = page(r#"<details id="d"><summary id="s">more</summary>content</details>"#).await;
    assert_eq!(
        page.evaluate("document.getElementById('d').hasAttribute('open')")
            .unwrap(),
        "false"
    );
    page.evaluate("document.getElementById('s').click()")
        .unwrap();
    assert_eq!(
        page.evaluate("document.getElementById('d').hasAttribute('open')")
            .unwrap(),
        "true"
    );
    page.evaluate("document.getElementById('s').click()")
        .unwrap();
    assert_eq!(
        page.evaluate("document.getElementById('d').hasAttribute('open')")
            .unwrap(),
        "false"
    );
}

#[tokio::test]
async fn click_on_disabled_button_fires_no_event_at_all() {
    let mut page = page(
        r#"<button id="b" disabled>go</button>
           <script>
             globalThis.__hits = 0;
             document.getElementById('b').addEventListener('click', () => { __hits++; });
           </script>"#,
    )
    .await;
    page.evaluate("document.getElementById('b').click()")
        .unwrap();
    assert_eq!(
        page.evaluate("String(__hits)").unwrap(),
        "0",
        "disabled element must not even dispatch click"
    );
}

/// The public `human_click` entry point must apply the same default
/// actions — this exercises `_runActivation` via `_boNs.activate`, the
/// separate code path humanize.js uses (it never calls `.click()`).
#[tokio::test]
async fn human_click_toggles_checkbox_via_activation() {
    let mut page = Page::from_html(
        r#"<input id="c" type="checkbox" style="position:absolute;left:40px;top:40px;width:20px;height:20px">"#,
        Some(browser_oxide::stealth::presets::chrome_148_macos()),
    )
    .await
    .unwrap();
    page.human_click("#c").await.expect("click runs");
    assert_eq!(
        page.evaluate("document.getElementById('c').checked")
            .unwrap(),
        "true"
    );
}
