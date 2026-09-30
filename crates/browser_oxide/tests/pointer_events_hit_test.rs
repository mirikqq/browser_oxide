//! `pointer-events: none` passes a click through to what is underneath — and
//! it is inherited, so a floating `<label>` that sets it on itself passes
//! clicks through its own text too. The label's `<span>` reported `auto`,
//! hit-testing landed on it, and humanized input refused the field below as
//! covered ("нет видимой точки").

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

const FORM: &str = r#"<html><body>
  <div style="position:relative;width:300px;height:40px;margin:40px">
    <input id="email" style="position:absolute;left:0;top:0;width:300px;height:40px">
    <label for="email" style="position:absolute;left:0;top:0;width:300px;height:40px;pointer-events:none">
      <span id="hint" style="display:block;width:300px;height:40px">Email</span>
    </label>
  </div>
</body></html>"#;

#[tokio::test]
async fn pointer_events_none_is_inherited() {
    let mut page = Page::from_html(FORM, Some(chrome_148_macos()))
        .await
        .unwrap();
    assert_eq!(
        page.evaluate("getComputedStyle(document.getElementById('hint')).pointerEvents")
            .unwrap(),
        "none"
    );
    let r = page
        .evaluate(
            "(function(){var r=document.getElementById('email').getBoundingClientRect();\
              var e=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);\
              return e ? e.id : 'null';})()",
        )
        .unwrap();
    assert_eq!(r, "email", "the click lands on the field under the label");
}

#[tokio::test]
async fn human_type_reaches_a_field_under_a_click_through_label() {
    let mut page = Page::from_html(FORM, Some(chrome_148_macos()))
        .await
        .unwrap();
    let status = page.human_type("#email", "a@b.c").await.expect("typed");
    assert!(!status.contains("нет видимой точки"), "{status}");
    assert_eq!(
        page.evaluate("document.getElementById('email').value")
            .unwrap(),
        "a@b.c"
    );
}

/// When the field really is covered, the status says by what — a driver
/// should not have to guess between "clipped, zero-sized or covered".
#[tokio::test]
async fn a_covered_field_is_reported_with_what_covers_it() {
    let mut page = Page::from_html(
        r#"<html><body>
          <input id="email" style="position:absolute;left:40px;top:40px;width:300px;height:40px">
          <div id="overlay" style="position:absolute;left:0;top:0;width:800px;height:600px"></div>
        </body></html>"#,
        Some(chrome_148_macos()),
    )
    .await
    .unwrap();
    let status = page.human_type("#email", "x").await.expect("ran");
    assert!(
        status.contains("перекрыт") && status.contains("div#overlay"),
        "{status}"
    );
}

/// Material UI's text field: a `position: relative` wrapper around a static
/// `<input>`. The input paints inside its wrapper's layer, so it — not the
/// wrapper — is what a click on it hits.
#[tokio::test]
async fn a_static_input_inside_a_positioned_wrapper_is_hit() {
    let mut page = Page::from_html(
        r#"<html><body><div style="margin:40px">
          <div class="MuiInputBase-root" style="position:relative;display:inline-flex;width:300px;height:48px">
            <input id="email" style="width:100%;height:48px;border:0;padding:0">
          </div>
        </div></body></html>"#,
        Some(chrome_148_macos()),
    )
    .await
    .unwrap();
    assert_eq!(
        page.evaluate(
            "(function(){var r=document.getElementById('email').getBoundingClientRect();\
              var e=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);\
              return e ? (e.id || e.className) : 'null';})()"
        )
        .unwrap(),
        "email"
    );
    let status = page.human_type("#email", "a@b.c").await.expect("typed");
    assert!(!status.contains("нет видимой точки"), "{status}");
    assert_eq!(
        page.evaluate("document.getElementById('email').value")
            .unwrap(),
        "a@b.c"
    );
}
