//! The engine host paints: `load_html` + `screenshot` across the thread boundary,
//! which is the path the desktop shell's worker takes.
#![cfg(feature = "paint")]

use browser_oxide::host::{EngineHandle, HostError};
use browser_oxide::stealth::presets::chrome_148_macos;

#[test]
fn screenshot_before_any_page_is_an_error() {
    let engine = EngineHandle::spawn();
    assert!(matches!(engine.screenshot(false), Err(HostError::NoPage)));
}

#[test]
fn load_html_then_screenshot() {
    let engine = EngineHandle::spawn();
    let snap = engine
        .load_html(
            "<!doctype html><title>Hi</title><body style='margin:0'>\
             <div style='height:30px;background-color:rgb(0,200,0)'></div>",
            "https://example.test/",
            chrome_148_macos(),
        )
        .expect("load");
    assert_eq!(snap.title, "Hi");

    let bmp = engine.screenshot(false).expect("screenshot");
    let px = &bmp.rgba[((10 * bmp.width + 10) * 4) as usize..][..4];
    assert_eq!(px, [0, 200, 0, 255]);
}
