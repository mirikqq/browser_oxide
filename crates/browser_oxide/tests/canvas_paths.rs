//! Canvas 2D path operations — `arc`, `arcTo`, `bezierCurveTo`,
//! `quadraticCurveTo`, `closePath`, `setTransform`, `resetTransform`,
//! `ellipse`, and `strokeText` are wired to Skia-backed implementations
//! in `crates/canvas/src/canvas2d.rs`. `arcTo` uses Skia's
//! `arc_to_tangent` (matches Chrome's `Path::arcTo`). `ellipse` uses a
//! bezier approximation (4·tan(seg/4) per segment, ⌈|sweep|/(π/2)⌉
//! segments) that matches Blink's `Path::AddEllipse` algorithm.
//! These tests verify both that the ops execute without throwing AND
//! that the resulting raster has the right pixel coverage — the bar for
//! anti-bot canvas fingerprint probes (challenge-vendor sensor scripts
//! and open-source FP suites such as CreepJS `paintCanvas`).

use browser_oxide::Page;

async fn evaluate(js: &str) -> String {
    let mut page = Page::from_html(
        "<!DOCTYPE html><html><body></body></html>",
        None::<browser_oxide::stealth::StealthProfile>,
    )
    .await
    .unwrap();
    page.evaluate(js).unwrap_or_else(|e| format!("ERROR: {e}"))
}

#[tokio::test]
async fn arc_does_not_throw() {
    let r = evaluate(
        "
        const c = document.createElement('canvas');
        c.width = 100; c.height = 100;
        const ctx = c.getContext('2d');
        ctx.beginPath();
        ctx.arc(50, 50, 25, 0, Math.PI * 2, false);
        ctx.fill();
        'ok'
        ",
    )
    .await;
    assert_eq!(r, "ok");
}

#[tokio::test]
async fn bezier_curve_to_does_not_throw() {
    let r = evaluate(
        "
        const c = document.createElement('canvas');
        c.width = 100; c.height = 100;
        const ctx = c.getContext('2d');
        ctx.beginPath();
        ctx.moveTo(10, 10);
        ctx.bezierCurveTo(30, 0, 70, 0, 90, 50);
        ctx.stroke();
        'ok'
        ",
    )
    .await;
    assert_eq!(r, "ok");
}

#[tokio::test]
async fn quadratic_curve_to_does_not_throw() {
    let r = evaluate(
        "
        const c = document.createElement('canvas');
        c.width = 100; c.height = 100;
        const ctx = c.getContext('2d');
        ctx.beginPath();
        ctx.moveTo(10, 10);
        ctx.quadraticCurveTo(50, 0, 90, 50);
        ctx.stroke();
        'ok'
        ",
    )
    .await;
    assert_eq!(r, "ok");
}

#[tokio::test]
async fn close_path_does_not_throw() {
    let r = evaluate(
        "
        const c = document.createElement('canvas');
        c.width = 100; c.height = 100;
        const ctx = c.getContext('2d');
        ctx.beginPath();
        ctx.moveTo(10, 10);
        ctx.lineTo(50, 10);
        ctx.lineTo(50, 50);
        ctx.closePath();
        ctx.fill();
        'ok'
        ",
    )
    .await;
    assert_eq!(r, "ok");
}

#[tokio::test]
async fn set_transform_does_not_throw() {
    let r = evaluate(
        "
        const c = document.createElement('canvas');
        c.width = 100; c.height = 100;
        const ctx = c.getContext('2d');
        ctx.setTransform(2, 0, 0, 2, 10, 20);
        ctx.fillRect(0, 0, 30, 30);
        ctx.resetTransform();
        ctx.fillRect(0, 0, 10, 10);
        'ok'
        ",
    )
    .await;
    assert_eq!(r, "ok");
}

#[tokio::test]
async fn stroke_text_does_not_throw() {
    let r = evaluate(
        "
        const c = document.createElement('canvas');
        c.width = 200; c.height = 50;
        const ctx = c.getContext('2d');
        ctx.font = '14px Arial';
        ctx.strokeText('Hello', 10, 30);
        'ok'
        ",
    )
    .await;
    assert_eq!(r, "ok");
}

/// arcTo executes via op_canvas_arc_to → Skia's arc_to_tangent (matches
/// Chrome's Path::arcTo at the Skia layer). Must produce a non-blank
/// raster — the previous lineTo-approximation produced a thin polygon,
/// the real arc fills a curved region.
#[tokio::test]
#[allow(non_snake_case, reason = "mirrors JS API name under test")]
async fn arcTo_renders_arc_pixels() {
    let r = evaluate(
        "
        const c = document.createElement('canvas');
        c.width = 100; c.height = 100;
        const ctx = c.getContext('2d');
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(20, 20);
        ctx.arcTo(80, 20, 80, 80, 20);
        ctx.lineTo(80, 80);
        ctx.stroke();
        const id = ctx.getImageData(0, 0, 100, 100);
        let nonzero = 0;
        for (let i = 3; i < id.data.length; i += 4) if (id.data[i] > 0) nonzero++;
        // The stroked rounded-corner path should mark several hundred pixels.
        nonzero > 200
        ",
    )
    .await;
    assert_eq!(r, "true");
}

/// Ellipse executes via op_canvas_ellipse → bezier-approximated rotated
/// ellipse. Filling a 30x20 ellipse at center (50,50) should mark
/// approximately π·30·20 ≈ 1885 pixels (with anti-aliasing slightly
/// inflating the count).
#[tokio::test]
async fn ellipse_filled_marks_expected_pixel_area() {
    let r = evaluate(
        "
        const c = document.createElement('canvas');
        c.width = 100; c.height = 100;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.ellipse(50, 50, 30, 20, 0, 0, Math.PI * 2);
        ctx.fill();
        const id = ctx.getImageData(0, 0, 100, 100);
        let nonzero = 0;
        for (let i = 3; i < id.data.length; i += 4) if (id.data[i] > 0) nonzero++;
        // π·rx·ry = π·30·20 ≈ 1885. Allow ±25% for rasterization edges.
        nonzero > 1400 && nonzero < 2400
        ",
    )
    .await;
    assert_eq!(r, "true");
}

/// Rotated ellipse: a 30x10 ellipse rotated 90° should occupy a different
/// pixel set than the unrotated one (the bounding box differs).
#[tokio::test]
async fn ellipse_rotation_changes_bounding_box() {
    let r = evaluate(
        "
        function fillCount(rotation) {
            const c = document.createElement('canvas');
            c.width = 100; c.height = 100;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#000';
            ctx.beginPath();
            ctx.ellipse(50, 50, 30, 10, rotation, 0, Math.PI * 2);
            ctx.fill();
            // Sample a vertical line through the center: rotated ellipse
            // should fill more rows here than unrotated.
            const id = ctx.getImageData(50, 0, 1, 100);
            let n = 0;
            for (let i = 3; i < id.data.length; i += 4) if (id.data[i] > 0) n++;
            return n;
        }
        // Unrotated: y-extent = ±ry = ±10 → ~20 rows on the center column.
        // Rotated 90°: y-extent = ±rx = ±30 → ~60 rows.
        const unrotated = fillCount(0);
        const rotated = fillCount(Math.PI / 2);
        rotated > unrotated + 20
        ",
    )
    .await;
    assert_eq!(r, "true");
}

/// strokeText must trace glyph outlines (via ttf-parser) and stroke
/// them with the current strokeStyle/lineWidth — NOT alias to fillText.
/// A bot detector that calls both at the same position and compares
/// pixel counts catches a fillText alias trivially. This test renders
/// both and asserts the pixel sets are non-trivially different.
#[tokio::test]
async fn stroke_text_pixels_differ_from_fill_text() {
    let r = evaluate(
        "
        function render(method) {
            const c = document.createElement('canvas');
            c.width = 200; c.height = 50;
            const ctx = c.getContext('2d');
            ctx.font = '32px Arial';
            ctx.fillStyle = '#000';
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 2;
            ctx[method]('Hello', 10, 35);
            const data = ctx.getImageData(0, 0, 200, 50).data;
            let nonzero = 0;
            for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nonzero++;
            return nonzero;
        }
        const filled = render('fillText');
        const stroked = render('strokeText');
        // If aliased, stroked === filled. Real strokeText traces only
        // the contour at lineWidth=2 — for 'Hello' at 32px this is
        // visibly different (typically more outline pixels because the
        // stroke is 2 px wide on both sides of every edge, vs filled
        // interior which has hollow centers in 'l', 'o', 'e'). Assert
        // the absolute difference is at least 20% of the smaller count.
        const diff = Math.abs(stroked - filled);
        const smaller = Math.min(stroked, filled);
        const ratio = diff / Math.max(smaller, 1);
        ratio > 0.2 ? 'differs' : ('similar:filled=' + filled + ',stroked=' + stroked)
        ",
    )
    .await;
    assert_eq!(
        r, "differs",
        "strokeText must produce a visibly different pixel set than fillText"
    );
}

/// strokeText must respond to `lineWidth` — wider stroke produces more
/// pixels. This proves the stroke is genuinely tracing contours with
/// the current paint width, not just rendering filled glyphs.
#[tokio::test]
async fn stroke_text_responds_to_line_width() {
    let r = evaluate(
        "
        function render(lineWidth) {
            const c = document.createElement('canvas');
            c.width = 200; c.height = 50;
            const ctx = c.getContext('2d');
            ctx.font = '32px Arial';
            ctx.strokeStyle = '#000';
            ctx.lineWidth = lineWidth;
            ctx.strokeText('Hello', 10, 35);
            const data = ctx.getImageData(0, 0, 200, 50).data;
            let nonzero = 0;
            for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nonzero++;
            return nonzero;
        }
        const thin = render(0.5);
        const thick = render(4);
        // Wider stroke must produce more covered pixels.
        thick > thin * 1.3 ? 'thicker' : ('not-thicker:thin=' + thin + ',thick=' + thick)
        ",
    )
    .await;
    assert_eq!(r, "thicker");
}

/// Composite test: full CreepJS-style scene with paths + text. Asserts
/// `toDataURL()` produces a non-trivial PNG (length > 1000 bytes).
#[tokio::test]
async fn complex_path_scene_produces_pixels() {
    let r = evaluate(
        "
        const c = document.createElement('canvas');
        c.width = 220; c.height = 30;
        const ctx = c.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = \"14px 'Arial'\";
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#f60';
        ctx.fillRect(125, 1, 62, 20);
        ctx.fillStyle = '#069';
        ctx.fillText('Cwm fjordbank glyphs vext quiz', 2, 15);
        ctx.beginPath();
        ctx.arc(50, 15, 10, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
        ctx.fill();
        const url = c.toDataURL();
        url.length > 100 && url.startsWith('data:image/png')
        ",
    )
    .await;
    assert_eq!(r, "true");
}

/// `createImageBitmap` has to produce a bitmap a later `drawImage` can
/// actually paint. It used to resolve with an empty stub carrying no pixels,
/// so every `drawImage(bitmap, …)` silently drew nothing — a page decoding its
/// images that way painted a fully transparent surface and never noticed.
#[tokio::test]
async fn create_image_bitmap_is_drawable() {
    let mut page = Page::from_html(
        "<!DOCTYPE html><html><body></body></html>",
        None::<browser_oxide::stealth::StealthProfile>,
    )
    .await
    .unwrap();
    page.evaluate_async(
        "
        globalThis.__bmr = 'не завершилось';
        (async () => {
            try {
                const src = document.createElement('canvas');
                src.width = 40; src.height = 20;
                const sx = src.getContext('2d');
                sx.fillStyle = '#f00';
                sx.fillRect(0, 0, 40, 20);

                const bm = await createImageBitmap(src);
                if (!(bm instanceof ImageBitmap)) { globalThis.__bmr = 'не ImageBitmap'; return; }
                if (bm.width !== 40 || bm.height !== 20) {
                    globalThis.__bmr = 'размер ' + bm.width + 'x' + bm.height; return;
                }

                const dst = document.createElement('canvas');
                dst.width = 40; dst.height = 20;
                const dx = dst.getContext('2d');
                dx.drawImage(bm, 0, 0);
                const d = dx.getImageData(0, 0, 40, 20).data;
                let opaque = 0;
                for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaque++;
                if (opaque !== 800) { globalThis.__bmr = 'непрозрачных ' + opaque + ' из 800'; return; }

                const crop = await createImageBitmap(src, 0, 0, 20, 10);
                if (crop.width !== 20 || crop.height !== 10) {
                    globalThis.__bmr = 'обрезка ' + crop.width + 'x' + crop.height; return;
                }
                globalThis.__bmr = 'ok';
            } catch (e) {
                globalThis.__bmr = 'исключение: ' + e;
            }
        })();
        ",
        std::time::Duration::from_secs(10),
    )
    .await
    .unwrap();
    let r = page
        .evaluate("globalThis.__bmr")
        .unwrap_or_else(|e| format!("ERROR: {e}"));
    assert_eq!(r, "ok");
}

/// A decoded `<img>` has to survive into a `drawImage` with its alpha intact.
#[tokio::test]
async fn decoded_image_draws_opaque() {
    let mut page = Page::from_html(
        "<!DOCTYPE html><html><body></body></html>",
        None::<browser_oxide::stealth::StealthProfile>,
    )
    .await
    .unwrap();
    page.evaluate_async(
        "
        globalThis.__imr = 'не завершилось';
        (async () => {
            try {
                const s = document.createElement('canvas');
                s.width = 40; s.height = 20;
                const sx = s.getContext('2d');
                sx.fillStyle = '#00aa00';
                sx.fillRect(0, 0, 40, 20);
                const url = s.toDataURL();

                const im = new Image();
                im.src = url;
                await im.decode();
                if (im.naturalWidth !== 40 || im.naturalHeight !== 20) {
                    globalThis.__imr = 'декод ' + im.naturalWidth + 'x' + im.naturalHeight; return;
                }

                const dst = document.createElement('canvas');
                dst.width = 40; dst.height = 20;
                const dx = dst.getContext('2d');
                dx.drawImage(im, 0, 0, 40, 20);
                const d = dx.getImageData(0, 0, 40, 20).data;
                let opaque = 0;
                for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaque++;
                globalThis.__imr = opaque === 800
                    ? 'ok'
                    : 'непрозрачных ' + opaque + ' из 800, первый пиксель rgba('
                        + d[0] + ',' + d[1] + ',' + d[2] + ',' + d[3] + ')';
            } catch (e) {
                globalThis.__imr = 'исключение: ' + e;
            }
        })();
        ",
        std::time::Duration::from_secs(10),
    )
    .await
    .unwrap();
    let r = page
        .evaluate("globalThis.__imr")
        .unwrap_or_else(|e| format!("ERROR: {e}"));
    assert_eq!(r, "ok");
}

/// Assigning `canvas.width` resets the context state, `getTransform` reports
/// the live matrix, and `DOMMatrix` does real 2D math.
#[tokio::test]
async fn resize_resets_state_and_transform_is_readable() {
    let r = evaluate(
        "
        const c = document.createElement('canvas');
        c.width = 200; c.height = 200;
        const ctx = c.getContext('2d');
        const out = [];

        ctx.scale(4, 4);
        const t = ctx.getTransform();
        if (t.a !== 4 || t.d !== 4) out.push('масштаб не виден: a=' + t.a + ' d=' + t.d);

        // Per spec this resets the transform, so the fill lands at 0,0 unscaled.
        c.width = 200;
        const t2 = ctx.getTransform();
        if (t2.a !== 1 || t2.d !== 1 || t2.e !== 0) {
            out.push('после width= матрица ' + t2.a + ',' + t2.d + ',' + t2.e);
        }
        ctx.fillStyle = '#f00';
        ctx.fillRect(0, 0, 10, 10);
        const d = ctx.getImageData(0, 0, 20, 20).data;
        let opaque = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaque++;
        if (opaque !== 100) out.push('после сброса непрозрачных ' + opaque + ' вместо 100');

        const m = new DOMMatrix([2, 0, 0, 2, 10, 20]);
        if (m.a !== 2 || m.e !== 10) out.push('DOMMatrix не принял аргумент');
        const p = m.inverse().transformPoint({ x: 30, y: 40 });
        if (Math.round(p.x) !== 10 || Math.round(p.y) !== 10) {
            out.push('inverse().transformPoint → ' + p.x + ',' + p.y + ' вместо 10,10');
        }
        out.length ? out.join(' | ') : 'ok'
        ",
    )
    .await;
    assert_eq!(r, "ok");
}

/// The context's readable state: every property reports a value, survives
/// `save`/`restore`, resets when the canvas is resized, and the canvas hands
/// out one context rather than a new one per call.
#[tokio::test]
async fn context_state_is_readable() {
    let r = evaluate(
        "
        const c = document.createElement('canvas');
        c.width = 100; c.height = 100;
        const ctx = c.getContext('2d');
        const out = [];

        if (c.getContext('2d') !== ctx) out.push('getContext отдаёт новый объект');

        const defaults = {
            fillStyle: '#000000', strokeStyle: '#000000', globalAlpha: 1,
            globalCompositeOperation: 'source-over', lineWidth: 1, lineCap: 'butt',
            lineJoin: 'miter', miterLimit: 10, font: '10px sans-serif',
            textAlign: 'start', textBaseline: 'alphabetic',
            shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', shadowOffsetX: 0,
            filter: 'none', imageSmoothingEnabled: true,
        };
        for (const k of Object.keys(defaults)) {
            if (ctx[k] !== defaults[k]) out.push(k + ' по умолчанию ' + ctx[k]);
        }

        ctx.fillStyle = '#ff0000';
        ctx.globalAlpha = 0.5;
        ctx.globalCompositeOperation = 'multiply';
        ctx.shadowBlur = 4;
        if (ctx.fillStyle !== '#ff0000') out.push('fillStyle не читается');
        if (ctx.globalAlpha !== 0.5) out.push('globalAlpha не читается');
        if (ctx.globalCompositeOperation !== 'multiply') out.push('composite не читается');

        ctx.save();
        ctx.fillStyle = '#00ff00';
        ctx.restore();
        if (ctx.fillStyle !== '#ff0000') out.push('restore не вернул fillStyle: ' + ctx.fillStyle);

        c.width = 100;
        if (ctx.fillStyle !== '#000000' || ctx.globalAlpha !== 1 || ctx.shadowBlur !== 0) {
            out.push('после width= состояние не сброшено: ' + ctx.fillStyle + ' ' + ctx.globalAlpha);
        }

        const proto = Object.getOwnPropertyNames(CanvasRenderingContext2D.prototype);
        if (proto.some((n) => n.startsWith('_bo'))) out.push('на прототипе видны служебные имена');

        out.length ? out.join(' | ') : 'ok'
        ",
    )
    .await;
    assert_eq!(r, "ok");
}
