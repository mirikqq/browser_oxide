//! A third-party captcha widget renders end to end.
//!
//! This is a whole-pipeline check, and it exists because the pipeline it covers
//! was assembled from defects that each looked like "the captcha does not work":
//! a `DocumentFragment` that was linked in instead of flattened, a memoised
//! `getComputedStyle`, an `about:blank` frame with no `body`, a null
//! `document.currentScript`, and script ordering that ignored download
//! completion. Any one of them regressing puts the widget back to invisible, and
//! none of them is visible in a unit test.
//!
//! `#[ignore]`: needs the network and a live third party. Run locally with
//! `cargo test -p browser_oxide --test captcha_render -- --ignored --test-threads=1`.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::PagePool;

#[tokio::test(flavor = "current_thread")]
#[ignore = "network: renders a live hCaptcha widget"]
async fn hcaptcha_widget_renders_into_its_container() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let profile = chrome_148_macos();
            let pool = PagePool::new(1);
            if let Ok(seed) = pool.acquire(Some(profile.clone())).await {
                pool.release(seed);
            }
            let mut page = pool
                .navigate("https://nopecha.com/demo/hcaptcha", profile)
                .await
                .expect("navigate");

            // The widget arrives on its own clock: the library is an async script,
            // and it attaches only after the page's own DOMContentLoaded handler
            // has built the container.
            for _ in 0..40 {
                let _ = page
                    .evaluate_async("void 0", std::time::Duration::from_millis(250))
                    .await;
                let ready = page
                    .evaluate(
                        "(function(){var c=document.querySelector('.g-recaptcha,[data-sitekey]');\
                         return c && [].some.call(c.children, function(x){return x.tagName==='IFRAME'})\
                           ? 'да' : 'нет';})()",
                    )
                    .unwrap_or_default();
                if ready.contains("да") {
                    break;
                }
            }

            let shape = page
                .evaluate(
                    "(function(){var c=document.querySelector('.g-recaptcha,[data-sitekey]');\
                     if(!c) return 'контейнера нет';\
                     return [].map.call(c.children, function(x){return x.tagName}).join('+');})()",
                )
                .expect("read container");

            // Chrome renders IFRAME + the two response textareas.
            assert!(
                shape.contains("IFRAME"),
                "виджет не отрисовался, в контейнере: {shape}"
            );

            let frames = page
                .evaluate("String(document.querySelectorAll('iframe').length)")
                .expect("count frames");
            assert!(
                frames.trim_matches('"').parse::<u32>().unwrap_or(0) >= 1,
                "фреймов капчи нет: {frames}"
            );
        })
        .await;
}
