use base64::Engine;
use browser_oxide::Page;

#[tokio::test]
async fn svg_graphics_do_not_size_the_html_parent() {
    let mut page = Page::from_html(
        r#"<div id="parent"><svg id="root" viewBox="0 0 200 100"><path style="width:99999px;height:88888px" d="M0 0 L99999 88888"/></svg></div>
           <svg id="attrs" width="80" height="40" viewBox="0 0 20 10"></svg>
           <svg id="css" style="width:120px;height:60px" viewBox="0 0 20 10"></svg>"#,
        None::<browser_oxide::stealth::StealthProfile>,
    )
    .await
    .unwrap();
    let sizes = page
        .evaluate(
            r#"JSON.stringify(['parent','root','attrs','css'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return [r.width,r.height]}))"#,
        )
        .unwrap();
    assert_eq!(sizes, "[[300,150],[300,150],[80,40],[120,60]]");
}

#[tokio::test]
async fn devview_png_keeps_backing_resolution_and_revision() {
    let mut page = Page::from_html(
        r#"<canvas id="c" width="1200" height="800" style="width:600px;height:400px"></canvas>
           <script>globalThis.ctx=document.getElementById('c').getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,1200,800)</script>"#,
        None::<browser_oxide::stealth::StealthProfile>,
    )
    .await
    .unwrap();
    let before_html = page.content();
    let first = page.devview_canvas_manifest().remove(0);
    assert_eq!(first.backing_size, [1200, 800]);
    assert_eq!([first.css_rect[2], first.css_rect[3]], [600.0, 400.0]);

    let url = page
        .devview_canvas_png(&first.key, first.revision)
        .expect("current revision must be readable");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(url.split_once(',').unwrap().1)
        .unwrap();
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(u32::from_be_bytes(bytes[16..20].try_into().unwrap()), 1200);
    assert_eq!(u32::from_be_bytes(bytes[20..24].try_into().unwrap()), 800);

    page.evaluate("ctx.fillStyle='blue';ctx.fillRect(5,5,10,10)")
        .unwrap();
    let second = page.devview_canvas_manifest().remove(0);
    assert!(second.revision > first.revision);
    assert!(page
        .devview_canvas_png(&first.key, first.revision)
        .is_none());
    assert_eq!(
        page.content(),
        before_html,
        "pixel-only draw must not rebuild DOM"
    );
}

#[tokio::test]
async fn normalized_points_use_current_css_rect_not_backing_pixels() {
    let mut page = Page::from_html(
        r#"<canvas width="1200" height="800" style="position:absolute;left:30px;top:20px;width:600px;height:400px"></canvas>
           <script>document.querySelector('canvas').getContext('2d').fillRect(0,0,1,1)</script>"#,
        None::<browser_oxide::stealth::StealthProfile>,
    )
    .await
    .unwrap();
    let meta = page.devview_canvas_manifest().remove(0);
    let point = |u: f64, v: f64| {
        [
            meta.css_rect[0] + u * meta.css_rect[2],
            meta.css_rect[1] + v * meta.css_rect[3],
        ]
    };
    assert_eq!(point(0.0, 0.0), [30.0, 20.0]);
    assert_eq!(point(0.5, 0.5), [330.0, 220.0]);
    assert_eq!(point(1.0, 1.0), [630.0, 420.0]);
}

#[tokio::test]
async fn same_srcdoc_replacement_gets_a_new_generation() {
    let profile = browser_oxide::stealth::presets::chrome_148_ru();
    let mut page = Page::from_html(
        r#"<iframe id="f" srcdoc="<p>first</p>"></iframe>"#,
        Some(profile),
    )
    .await
    .unwrap();
    let first = page.child_iframe(0).unwrap().generation;
    page.evaluate("document.getElementById('f').setAttribute('srcdoc', document.getElementById('f').getAttribute('srcdoc'))")
        .unwrap();
    page.materialize_new_iframes().await.unwrap();
    let second = page.child_iframe(0).unwrap().generation;
    assert_ne!(first, second);
}

#[tokio::test]
async fn nested_iframe_has_its_own_frame_path() {
    let profile = browser_oxide::stealth::presets::chrome_148_ru();
    let mut page = Page::from_html(
        r#"<iframe srcdoc="<iframe srcdoc='&lt;canvas width=&quot;20&quot; height=&quot;10&quot;&gt;&lt;/canvas&gt;'></iframe>"></iframe>"#,
        Some(profile),
    )
    .await
    .unwrap();
    page.materialize_new_iframes().await.unwrap();
    let frames = page.devview_frame_snapshots("document.documentElement.outerHTML");
    assert!(frames.iter().any(|frame| frame.frame_path.len() == 1));
    assert!(frames.iter().any(|frame| frame.frame_path.len() == 2));
}

#[tokio::test]
async fn self_postmessage_checks_target_and_reports_sender() {
    let mut page = Page::from_html_with_url(
        r#"<script>
          globalThis.seen=[];
          addEventListener('message',e=>seen.push([e.data,e.origin,e.source===window]));
          postMessage('blocked','https://other.example');
          postMessage('ok','https://example.com');
        </script>"#,
        "https://example.com/",
        None::<browser_oxide::stealth::StealthProfile>,
    )
    .await
    .unwrap();
    page.evaluate_async("void 0", std::time::Duration::from_millis(50))
        .await
        .unwrap();
    assert_eq!(
        page.evaluate("JSON.stringify(seen)").unwrap(),
        r#"[["ok","https://example.com",true]]"#
    );
}
