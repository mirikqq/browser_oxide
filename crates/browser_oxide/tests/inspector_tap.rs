//! The inspector tap against a real V8, not a fixture of hand-written JSON.
//!
//! The point of the tap is that it sees what our own bookkeeping cannot: code
//! compiled through `eval` and `new Function`, code that failed to compile, and
//! the separate realm an iframe runs in. Each of those is asserted here, because
//! each is a case where the DOM and the network log both say "fine".

use browser_oxide::js_runtime::inspect;
use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

/// The tap is decided at isolate construction, so it must be on before the page
/// is built. Process-global and idempotent; tests run single-threaded.
fn tapped() {
    inspect::enable();
}

#[tokio::test]
async fn reports_scripts_v8_compiled_including_eval() {
    tapped();
    let mut page = Page::from_html(
        "<html><body><script>globalThis.__a = 1;</script></body></html>",
        Some(chrome_148_macos()),
    )
    .await
    .expect("page");

    page.evaluate("eval('globalThis.__b = 2')").expect("eval");
    page.evaluate("new Function('return 3')()").expect("fn");

    let log = page.inspect_snapshot().expect("тап включён");
    assert!(
        log.scripts.len() > 3,
        "V8 должен отчитаться о каждом скомпилированном юните, получено {}: {}",
        log.scripts.len(),
        log.summary()
    );
    // `eval` and `Function` produce records with no URL — the units that leave no
    // trace in the DOM or the network log at all.
    assert!(
        log.scripts.iter().any(|s| s.url.is_empty()),
        "eval/Function должны попасть в отчёт: {}",
        log.summary()
    );
}

#[tokio::test]
async fn separates_a_failed_compile_from_a_thrown_exception() {
    tapped();
    let mut page = Page::from_html(
        // Syntactically broken: V8 rejects it at compile time, so it never runs.
        "<html><body><script>function ( { syntax error</script></body></html>",
        Some(chrome_148_macos()),
    )
    .await
    .expect("page");

    let log = page.inspect_snapshot().expect("тап включён");
    assert!(
        !log.failures.is_empty(),
        "нескомпилировавшийся скрипт должен быть отдельно от исполнившихся: {}",
        log.summary()
    );
}

#[tokio::test]
async fn a_child_frame_is_its_own_realm() {
    tapped();
    let profile = chrome_148_macos();
    let mut page = Page::from_html("<html><body></body></html>", Some(profile.clone()))
        .await
        .expect("page");

    page.evaluate(
        "(function(){var f=document.createElement('iframe');\
         f.srcdoc='<html><body><script>globalThis.__inFrame=1;<\\/script></body></html>';\
         document.body.appendChild(f);})()",
    )
    .expect("append");

    let client = browser_oxide::net::HttpClient::new(&profile).expect("client");
    page.rematerialize_iframes("https://example.com/", &client, &profile)
        .await;

    let log = page.inspect_snapshot().expect("тап включён");
    // Two realms means the frame really got its own isolate rather than sharing
    // the page's — the distinction the whole frame lifecycle rests on.
    assert!(
        log.contexts.len() >= 2,
        "фрейм должен быть отдельным реалмом, реалмов: {} — {}",
        log.contexts.len(),
        log.summary()
    );
}
