//! Masked host functions are shaped like native ones, and carry no marker.
//!
//! The marker used to be an own symbol property, `Symbol.for('__browser_oxide_native__')`,
//! set on every function whose `toString` we report as native. Any script could
//! read this engine's own name straight off `fetch`:
//!
//!     Object.getOwnPropertySymbols(fetch)  // → Symbol(__browser_oxide_native__)
//!
//! It also broke the shape check fingerprinters run against natives — a real one
//! has exactly `length` and `name` — and made `Reflect.ownKeys(fn).toString()`
//! throw on the extra symbol. Measured on creepjs, that single extra key was what
//! marked `Navigator.webdriver` as tampered with and scored the engine as
//! headless; the tag now lives in a v8 private symbol, which no JS reflection
//! can see.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

async fn page() -> Page {
    Page::from_html("<html><body></body></html>", Some(chrome_148_macos()))
        .await
        .expect("page")
}

#[tokio::test]
async fn masked_functions_expose_no_marker() {
    let mut page = page().await;
    let out = page
        .evaluate(
            "(function(){var g=Object.getOwnPropertyDescriptor(Navigator.prototype,'webdriver').get;\
             return 'ключи='+Reflect.ownKeys(g).map(String).join(',')\
                    +' символыGetter='+Object.getOwnPropertySymbols(g).length\
                    +' символыFetch='+Object.getOwnPropertySymbols(globalThis.fetch).length;})()",
        )
        .expect("read shape");
    assert!(
        out.contains("ключи=length,name"),
        "у маскированной функции лишние собственные ключи: {out}"
    );
    assert!(
        out.contains("символыGetter=0") && out.contains("символыFetch=0"),
        "на функции остался видимый символ-метка: {out}"
    );
}

#[tokio::test]
async fn masking_still_reports_native_source() {
    let mut page = page().await;
    let out = page
        .evaluate(
            "(function(){var g=Object.getOwnPropertyDescriptor(Navigator.prototype,'webdriver').get;\
             return 'getter='+String(g)+' | fetch='+String(globalThis.fetch)\
                    +' | toString='+String(Function.prototype.toString);})()",
        )
        .expect("read toString");
    for part in ["get webdriver", "fetch", "toString"] {
        assert!(
            out.contains(&format!("function {part}() {{ [native code] }}")),
            "маскировка потеряна для {part}: {out}"
        );
    }
}

/// `Function.prototype.toString` rejects a receiver that is not a function, and
/// an object that merely *inherits* from one is not a function.
#[tokio::test]
async fn to_string_rejects_a_non_function_receiver() {
    let mut page = page().await;
    let out = page
        .evaluate(
            "(function(){var g=Object.getOwnPropertyDescriptor(Navigator.prototype,'webdriver').get;\
             function t(f){try{f();return 'НЕ бросил'}catch(e){return e.constructor.name}}\
             return 'create='+t(function(){return Object.create(g).toString()})\
                    +' proxy='+t(function(){return Object.create(new Proxy(g,{})).toString()})\
                    +' чужойThis='+t(function(){return Function.prototype.toString.call({})})\
                    +' обычныйОбъект='+Object.create({}).toString();})()",
        )
        .expect("read receivers");
    assert!(
        out.contains("create=TypeError")
            && out.contains("proxy=TypeError")
            && out.contains("чужойThis=TypeError"),
        "toString принял получателя, которого браузер отвергает: {out}"
    );
    // And an ordinary object still reaches Object.prototype.toString.
    assert!(
        out.contains("обычныйОбъект=[object Object]"),
        "обычный объект сломан: {out}"
    );
}

/// Navigator's attributes behave like platform-object attributes: nothing owned
/// by the instance, and a foreign receiver is rejected.
#[tokio::test]
async fn navigator_attributes_live_on_the_prototype_and_check_their_receiver() {
    let mut page = page().await;
    let out = page
        .evaluate(
            "(function(){function t(f){try{f();return 'НЕ бросил'}catch(e){return e.constructor.name}}\
             var g=Object.getOwnPropertyDescriptor(Navigator.prototype,'webdriver').get;\
             return 'своиСвойства='+Object.getOwnPropertyNames(navigator).length\
                    +' наПрототипе='+!!Object.getOwnPropertyDescriptor(Navigator.prototype,'webdriver')\
                    +' чужойThis='+t(function(){return g.call({})})\
                    +' черезПрототип='+t(function(){return Navigator.prototype.webdriver})\
                    +' prototype='+('prototype' in g)\
                    +' new='+t(function(){return new g()})\
                    +' значение='+navigator.webdriver;})()",
        )
        .expect("read navigator");
    assert!(
        out.contains("своиСвойства=0"),
        "у navigator появились собственные свойства (Chrome: ноль): {out}"
    );
    assert!(
        out.contains("наПрототипе=true") && out.contains("чужойThis=TypeError"),
        "геттер не проверяет получателя: {out}"
    );
    assert!(
        out.contains("черезПрототип=TypeError"),
        "Navigator.prototype.webdriver обязан бросать: {out}"
    );
    assert!(
        out.contains("prototype=false") && out.contains("new=TypeError"),
        "геттер конструируем — нативный таким не бывает: {out}"
    );
    assert!(out.contains("значение=false"), "webdriver изменился: {out}");
}

/// A freshly created `<iframe>` has no browsing context until it is inserted.
#[tokio::test]
async fn a_detached_iframe_has_no_content_window() {
    let mut page = page().await;
    let out = page
        .evaluate(
            "(function(){var f=document.createElement('iframe');\
             return 'window='+String(f.contentWindow)+' document='+String(f.contentDocument);})()",
        )
        .expect("read iframe");
    assert!(
        out.contains("window=null") && out.contains("document=null"),
        "у отсоединённого iframe есть контекст просмотра: {out}"
    );
}
