//! Render a page to a PNG with the engine's own painter.
//!
//!   cargo run --release -p browser_oxide --features paint --example screenshot -- <url|file.html> [out.png] [--full]
//!
//! The picture is drawn from the engine's layout, not by a browser, so it shows
//! what the engine believes about the page — gaps included. See docs/GUI_PLAN.md.

use browser_oxide::paint::ScreenshotOptions;
use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let full_page = args.iter().any(|a| a == "--full");
    args.retain(|a| a != "--full");
    let target = args
        .first()
        .cloned()
        .unwrap_or_else(|| "https://example.com".to_string());
    let out = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| "screenshot.png".to_string());

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let local = tokio::task::LocalSet::new();
    local.block_on(&rt, async move {
        let profile = chrome_148_macos();
        let mut page = if std::path::Path::new(&target).is_file() {
            let html = std::fs::read_to_string(&target).expect("read html");
            Page::from_html_with_url(&html, "file:///local.html", Some(profile))
                .await
                .expect("load html")
        } else {
            Page::navigate(&target, profile, 5)
                .await
                .expect("navigation failed")
        };
        let bmp = page
            .screenshot(&ScreenshotOptions { full_page })
            .expect("screenshot");

        let file = std::fs::File::create(&out).expect("create output");
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), bmp.width, bmp.height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header()
            .and_then(|mut w| w.write_image_data(&bmp.rgba))
            .expect("write png");
        println!("{}x{} -> {out}", bmp.width, bmp.height);
    });
}
