//! Evaluating a `<script type="module">` finishes with the module, not with the page.
//!
//! The engine used to drive `run_event_loop` to completion around module
//! evaluation. That call returns only once the loop has *no* pending work,
//! which no real document ever reaches — a page always holds a timer, a poll,
//! or an open connection. Measured on a live login page, a 2.8 MB module bundle
//! "executed" for 24.7 s with the process idle the whole time, and
//! `DOMContentLoaded` landed past the 15 s watchdogs third-party SDKs arm on
//! themselves.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;
use std::time::{Duration, Instant};

#[tokio::test(flavor = "current_thread")]
async fn a_pending_interval_does_not_hold_up_module_evaluation() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let mut page = Page::from_html(
                "<html><body><div id='host'></div></body></html>",
                Some(chrome_148_macos()),
            )
            .await
            .expect("page");

            // The kind of work a live page always has outstanding.
            page.evaluate("globalThis.__ticks = 0; setInterval(function(){ globalThis.__ticks++; }, 10); void 0;")
                .expect("arm interval");

            // The outer bound is what makes a regression *fail* rather than
            // hang: waiting for idle never returns while the interval is armed.
            let started = Instant::now();
            tokio::time::timeout(
                Duration::from_secs(2),
                page.event_loop().eval_module_code(
                    "https://example.test/bundle.js",
                    "globalThis.__moduleRan = true; export default 1;".to_string(),
                ),
            )
            .await
            .expect("вычисление модуля ждало опустошения цикла событий")
            .expect("module evaluates");
            let elapsed = started.elapsed();

            assert!(
                page.evaluate("String(globalThis.__moduleRan)")
                    .expect("read flag")
                    .contains("true"),
                "модуль не выполнился"
            );
            assert!(
                elapsed < Duration::from_secs(2),
                "вычисление модуля ждало опустошения цикла событий: {elapsed:?}"
            );
        })
        .await;
}
