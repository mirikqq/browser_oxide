//! `Page::screenshot` draws what layout produced.
#![cfg(feature = "paint")]

use browser_oxide::paint::{Bitmap, ScreenshotOptions};
use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

fn pixel(bmp: &Bitmap, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * bmp.width + x) * 4) as usize;
    [
        bmp.rgba[i],
        bmp.rgba[i + 1],
        bmp.rgba[i + 2],
        bmp.rgba[i + 3],
    ]
}

async fn page(html: &str) -> Page {
    Page::from_html_with_url(html, "https://example.test/", Some(chrome_148_macos()))
        .await
        .expect("page")
}

#[tokio::test]
async fn paints_a_background_box() {
    let mut p = page(
        "<!doctype html><body style='margin:0'>\
         <div style='width:100px;height:50px;background-color:rgb(255,0,0)'></div>",
    )
    .await;
    let bmp = p.screenshot(&ScreenshotOptions::default()).unwrap();
    assert_eq!(pixel(&bmp, 50, 25), [255, 0, 0, 255], "inside the box");
    assert_eq!(pixel(&bmp, 150, 25), [255, 255, 255, 255], "outside it");
    assert_eq!(pixel(&bmp, 50, 80), [255, 255, 255, 255], "below it");
}

#[tokio::test]
async fn body_background_fills_the_canvas() {
    let mut p = page("<!doctype html><body style='background-color:rgb(0,0,255)'><p>x</p>").await;
    let bmp = p.screenshot(&ScreenshotOptions::default()).unwrap();
    assert_eq!(pixel(&bmp, bmp.width - 1, bmp.height - 1), [0, 0, 255, 255]);
}

#[tokio::test]
async fn text_leaves_ink() {
    let mut p = page("<!doctype html><body style='margin:0'>Hello world").await;
    let bmp = p.screenshot(&ScreenshotOptions::default()).unwrap();
    let inked = bmp
        .rgba
        .as_chunks::<4>()
        .0
        .iter()
        .take(bmp.width as usize * 40)
        .filter(|px| px[0] < 128)
        .count();
    assert!(inked > 20, "expected dark glyph pixels, got {inked}");
}

#[tokio::test]
async fn full_page_is_taller_than_the_viewport() {
    let mut p = page(
        "<!doctype html><body style='margin:0'>\
         <div style='height:5000px;background-color:rgb(0,128,0)'></div>",
    )
    .await;
    let short = p.screenshot(&ScreenshotOptions::default()).unwrap();
    let full = p
        .screenshot(&ScreenshotOptions { full_page: true })
        .unwrap();
    assert!(full.height >= 5000 && full.height > short.height);
    assert_eq!(pixel(&full, 10, 4990), [0, 128, 0, 255]);
}
