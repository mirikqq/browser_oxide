//! Regression tests for `human_type`'s keyboard fidelity (Q6 / F1.7):
//! correct `code` for digits/space (not just letters), `keyCode`/`which`,
//! a `keypress`/`beforeinput` pair ahead of `input`, key telemetry actually
//! recorded, and typing refused into `readonly` fields, past `maxlength`,
//! or after a failed click (hidden/disabled).

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

#[tokio::test]
async fn human_type_uses_real_codes_for_digits_and_space() {
    let mut page = Page::from_html(
        r#"<input id="q" style="position:absolute;left:40px;top:40px;width:200px;height:24px">
           <script>
             globalThis.__codes = [];
             document.getElementById('q').addEventListener(
               'keydown', (e) => __codes.push(e.code)
             );
           </script>"#,
        Some(chrome_148_macos()),
    )
    .await
    .unwrap();

    page.human_type("#q", "a1 b").await.expect("typing runs");
    let codes: Vec<String> =
        serde_json::from_str(&page.evaluate("JSON.stringify(__codes)").unwrap()).unwrap();
    assert_eq!(
        codes,
        vec!["KeyA", "Digit1", "Space", "KeyB"],
        "digit/space must not get a letter's code"
    );
}

#[tokio::test]
async fn human_type_sets_legacy_key_code_and_which() {
    let mut page = Page::from_html(
        r#"<input id="q" style="position:absolute;left:40px;top:40px;width:200px;height:24px">
           <script>
             globalThis.__log = [];
             document.getElementById('q').addEventListener(
               'keydown', (e) => __log.push([e.keyCode, e.which])
             );
           </script>"#,
        Some(chrome_148_macos()),
    )
    .await
    .unwrap();

    page.human_type("#q", "a").await.expect("typing runs");
    let log: Vec<(u32, u32)> =
        serde_json::from_str(&page.evaluate("JSON.stringify(__log)").unwrap()).unwrap();
    assert_eq!(log, vec![(65, 65)], "'a' keyCode/which must be 65 (A)");
}

#[tokio::test]
async fn human_type_fires_keypress_and_beforeinput_before_input() {
    let mut page = Page::from_html(
        r#"<input id="q" style="position:absolute;left:40px;top:40px;width:200px;height:24px">
           <script>
             globalThis.__order = [];
             for (const t of ['keydown', 'keypress', 'beforeinput', 'input', 'keyup']) {
               document.getElementById('q').addEventListener(t, () => __order.push(t));
             }
           </script>"#,
        Some(chrome_148_macos()),
    )
    .await
    .unwrap();

    page.human_type("#q", "x").await.expect("typing runs");
    let order: Vec<String> =
        serde_json::from_str(&page.evaluate("JSON.stringify(__order)").unwrap()).unwrap();
    assert_eq!(
        order,
        vec!["keydown", "keypress", "beforeinput", "input", "keyup"],
        "wrong event order: {order:?}"
    );
}

#[tokio::test]
async fn human_type_records_key_telemetry() {
    let mut page = Page::from_html(
        r#"<input id="q" style="position:absolute;left:40px;top:40px;width:200px;height:24px">"#,
        Some(chrome_148_macos()),
    )
    .await
    .unwrap();

    page.human_type("#q", "hi").await.expect("typing runs");
    let ns_resolve = "(function(){try{var s=Object.getOwnPropertySymbols(globalThis,1);for(var i=0;i<s.length;i++){var v=globalThis[s[i]];if(v&&v.__bo)return v;}}catch(e){}return null;})()";
    let len = page
        .evaluate(&format!("({ns_resolve}).input.key.length"))
        .unwrap();
    assert_eq!(
        len, "4",
        "expected 2 keydown + 2 keyup telemetry entries, got {len}"
    );
}

#[tokio::test]
async fn human_type_refuses_readonly_field() {
    let mut page = Page::from_html(
        r#"<input id="q" readonly value="" style="position:absolute;left:40px;top:40px;width:200px;height:24px">
           <script>
             globalThis.__hits = 0;
             document.getElementById('q').addEventListener('input', () => { __hits++; });
           </script>"#,
        Some(chrome_148_macos()),
    )
    .await
    .unwrap();
    let result = page.human_type("#q", "hello").await.expect("call runs");
    assert!(
        result.contains("readonly") || result.to_lowercase().contains("read"),
        "expected a readonly refusal, got: {result}"
    );
    assert_eq!(page.evaluate("String(__hits)").unwrap(), "0");
    assert_eq!(
        page.evaluate("document.getElementById('q').value").unwrap(),
        ""
    );
}

#[tokio::test]
async fn human_type_truncates_at_maxlength() {
    let mut page = Page::from_html(
        r#"<input id="q" maxlength="3" style="position:absolute;left:40px;top:40px;width:200px;height:24px">"#,
        Some(chrome_148_macos()),
    )
    .await
    .unwrap();

    page.human_type("#q", "hello").await.expect("typing runs");
    assert_eq!(
        page.evaluate("document.getElementById('q').value").unwrap(),
        "hel"
    );
}

#[tokio::test]
async fn human_type_does_not_type_into_hidden_field() {
    let mut page = Page::from_html(
        r#"<input id="q" type="hidden" value="">"#,
        Some(chrome_148_macos()),
    )
    .await
    .unwrap();

    let result = page.human_type("#q", "hello").await.expect("call runs");
    assert!(
        !result.starts_with("введено"),
        "typed into a hidden field: {result}"
    );
    assert_eq!(
        page.evaluate("document.getElementById('q').value").unwrap(),
        ""
    );
}
