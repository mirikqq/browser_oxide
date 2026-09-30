//! Regression test (Q8 / F2.1): `getBoundingClientRect` must subtract the
//! current scroll offset — the layout tree reports document-relative boxes,
//! but the DOM API is viewport-relative. Before this fix an element below
//! the first screenful always reported its `top` as if the page were
//! unscrolled, which also broke `elementFromPoint`/click hit-testing since
//! that compares viewport coordinates against `getBoundingClientRect()`
//! directly.

use browser_oxide::stealth::StealthProfile;
use browser_oxide::Page;

#[tokio::test]
async fn rect_top_shrinks_by_scroll_offset() {
    let mut page = Page::from_html(
        r#"<div style="height:2600px"></div>
           <div id="target" style="height:50px">below the fold</div>"#,
        None::<StealthProfile>,
    )
    .await
    .unwrap();

    let before = page
        .evaluate("document.getElementById('target').getBoundingClientRect().top")
        .unwrap();
    let before: f64 = before.parse().unwrap();
    assert!(
        before > 100.0,
        "expected the target below the viewport top, got {before}"
    );

    let scroll_by = (before - 50.0).max(0.0);
    page.evaluate(&format!("window.scrollTo(0, {scroll_by})"))
        .unwrap();
    let after = page
        .evaluate("document.getElementById('target').getBoundingClientRect().top")
        .unwrap();
    let after: f64 = after.parse().unwrap();
    assert!(
        (after - (before - scroll_by)).abs() < 1.0,
        "expected top to shrink by the scroll delta: before={before} after={after} scroll_by={scroll_by}"
    );
}

#[tokio::test]
async fn element_below_the_fold_is_clickable_after_scrolling_to_it() {
    let mut page = Page::from_html(
        r#"<div style="height:3000px"></div>
           <button id="go" style="position:relative;left:40px;width:90px;height:30px">go</button>
           <script>
             globalThis.__hits = 0;
             document.getElementById('go').addEventListener('click', () => { __hits++; });
           </script>"#,
        Some(browser_oxide::stealth::presets::chrome_148_macos()),
    )
    .await
    .unwrap();

    // `human_click` brings the target into view itself, but the hit-test
    // that confirms the press landed on the right element depends on
    // `getBoundingClientRect` agreeing with `elementFromPoint` post-scroll —
    // exactly what this regression covers.
    page.human_click("#go").await.expect("click runs");
    assert_eq!(page.evaluate("String(__hits)").unwrap(), "1");
}
