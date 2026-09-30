//! Rasterising a laid-out page (`feature = "paint"`).
//!
//! The engine has always computed geometry without drawing anything. This module
//! is the first drawing: it walks [`PaintBox`]es — the flat, absolutely
//! positioned view of the layout tree — and paints backgrounds, borders and text
//! onto a [`Canvas2D`], which is the Skia surface the engine already uses for
//! `<canvas>`.
//!
//! What this is, honestly: a debugging-grade picture of what layout believes. It
//! draws exactly the boxes layout produced, at the sizes layout produced them,
//! so where layout is approximate (text measured at 0.6em per character, no line
//! boxes, no inheritance) the picture shows it. That is deliberate for now — see
//! `docs/GUI_PLAN.md`, milestone M1.
//!
//! Not painted yet: images, gradients, background shorthands and images, border
//! colours and radii, shadows, transforms, `z-index`, text decorations, form
//! control internals. `overflow` clipping is applied to boxes and to whole text
//! lines, not to partial lines.

use crate::canvas::canvas2d::Canvas2D;
use crate::layout::{PaintBox, Viewport};
use crate::text::fallback::{segments, Segment};
use crate::text::ParsedFont;

/// Tallest picture `Page::screenshot` will produce, so a runaway layout cannot
/// ask for a gigabyte bitmap.
pub const MAX_HEIGHT: u32 = 16_384;

/// Options for [`crate::Page::screenshot`].
#[derive(Debug, Clone, Copy, Default)]
pub struct ScreenshotOptions {
    /// Capture the whole document instead of just the viewport.
    pub full_page: bool,
}

/// A finished picture: straight-alpha RGBA, `width * height * 4` bytes.
pub struct Bitmap {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Paint `boxes` onto a `width` x `height` surface.
///
/// `os_name` picks the font set, exactly as it does for canvas text, so the text
/// on screen is set in the faces the profile claims to have.
pub fn render(boxes: &[PaintBox], width: u32, height: u32, os_name: &str) -> Option<Bitmap> {
    let mut canvas = Canvas2D::new(width, height, os_name.to_string(), 0)?;
    let (w, h) = (width as f32, height as f32);

    // The root element's background (or, failing that, the body's) covers the
    // whole canvas, not just its own box — the propagation rule from CSS
    // Backgrounds. The default canvas is white.
    let canvas_bg = ["html", "body"]
        .iter()
        .find_map(|tag| {
            boxes
                .iter()
                .find(|b| b.tag.as_deref() == Some(tag))
                .and_then(|b| b.background)
        })
        .unwrap_or([255, 255, 255, 255]);
    fill(&mut canvas, [0.0, 0.0, w, h], [255, 255, 255, 255], 1.0);
    fill(&mut canvas, [0.0, 0.0, w, h], canvas_bg, 1.0);

    for b in boxes {
        if !b.visible || b.opacity <= 0.0 {
            continue;
        }
        match (&b.text, &b.tag) {
            (Some(text), _) => paint_text(&mut canvas, b, text, os_name),
            (None, Some(tag)) => paint_element(&mut canvas, b, tag),
            (None, None) => {}
        }
    }

    Some(Bitmap {
        width,
        height,
        rgba: canvas.get_image_data(0, 0, width, height),
    })
}

/// The size a screenshot of `viewport` should have for a document `doc_height`
/// tall.
pub fn surface_size(viewport: Viewport, doc_height: f32, full_page: bool) -> (u32, u32) {
    let w = viewport.width.max(1.0).round() as u32;
    let vh = viewport.height.max(1.0).round() as u32;
    let h = if full_page {
        (doc_height.ceil() as u32).max(vh)
    } else {
        vh
    };
    (w, h.min(MAX_HEIGHT))
}

fn set_fill(canvas: &mut Canvas2D, color: [u8; 4]) {
    canvas.set_fill_color(color[0], color[1], color[2], color[3] as f32 / 255.0);
}

/// Fill `rect` (`[x, y, w, h]`) at `alpha`.
fn fill(canvas: &mut Canvas2D, rect: [f32; 4], color: [u8; 4], alpha: f32) {
    if rect[2] <= 0.0 || rect[3] <= 0.0 {
        return;
    }
    set_fill(canvas, color);
    canvas.set_global_alpha(alpha);
    canvas.fill_rect(rect[0], rect[1], rect[2], rect[3]);
    canvas.set_global_alpha(1.0);
}

/// `rect` limited to `clip`; `None` if nothing is left.
fn clipped(rect: [f32; 4], clip: Option<[f32; 4]>) -> Option<[f32; 4]> {
    let Some(c) = clip else {
        return Some(rect);
    };
    let x0 = rect[0].max(c[0]);
    let y0 = rect[1].max(c[1]);
    let x1 = (rect[0] + rect[2]).min(c[0] + c[2]);
    let y1 = (rect[1] + rect[3]).min(c[1] + c[3]);
    (x1 > x0 && y1 > y0).then_some([x0, y0, x1 - x0, y1 - y0])
}

fn paint_element(canvas: &mut Canvas2D, b: &PaintBox, tag: &str) {
    let mut bg = b.background;
    let mut border = b.border;
    let mut border_color = b.border_color;

    // Native controls have no author styling to draw from yet; give them the
    // plain outline Chrome's own do, so a form reads as a form.
    let control = matches!(tag, "input" | "button" | "textarea" | "select");
    if control && border.iter().all(|w| *w == 0.0) {
        border = [1.0; 4];
        border_color = [[118, 118, 118, 255]; 4];
        bg = bg.or(Some(if tag == "button" {
            [239, 239, 239, 255]
        } else {
            [255, 255, 255, 255]
        }));
    }
    // An image is not decoded into the layout yet: mark where it goes.
    if tag == "img" {
        bg = bg.or(Some([238, 238, 238, 255]));
        border = [1.0; 4];
        border_color = [[204, 204, 204, 255]; 4];
    }

    let rect = [b.x, b.y, b.width, b.height];
    if let Some(color) = bg {
        if let Some(r) = clipped(rect, b.clip) {
            fill(canvas, r, color, b.opacity);
        }
    }
    let [t, r, bo, l] = border;
    let edges = [
        [b.x, b.y, b.width, t],
        [b.x + b.width - r, b.y, r, b.height],
        [b.x, b.y + b.height - bo, b.width, bo],
        [b.x, b.y, l, b.height],
    ];
    for (edge, color) in edges.into_iter().zip(border_color) {
        if let Some(e) = clipped(edge, b.clip) {
            fill(canvas, e, color, b.opacity);
        }
    }
}

/// Break `text` into lines no wider than `max_width` as measured by `measure`.
///
/// Whitespace collapses to single spaces first. A word wider than the limit gets
/// a line of its own rather than being split.
pub(crate) fn wrap_lines(
    text: &str,
    max_width: f32,
    mut measure: impl FnMut(&str) -> f32,
) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if line.is_empty() {
            line.push_str(word);
            continue;
        }
        let candidate = format!("{line} {word}");
        if measure(&candidate) <= max_width {
            line = candidate;
        } else {
            lines.push(std::mem::take(&mut line));
            line.push_str(word);
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

fn font_css(b: &PaintBox, family: &str) -> String {
    format!(
        "{}{}{}px {family}",
        if b.italic { "italic " } else { "" },
        if b.bold { "bold " } else { "" },
        b.font_size.max(1.0)
    )
}

/// `line` in the boxes' font, split into the stretches each face draws.
fn line_segments<'a>(b: &PaintBox, line: &'a str, os_name: &str) -> Vec<Segment<'a>> {
    match ParsedFont::parse(&font_css(b, &b.font_family)) {
        Some(font) => segments(line, &font, os_name),
        None => vec![Segment {
            text: line,
            face: None,
            covered: true,
        }],
    }
}

fn line_width(canvas: &mut Canvas2D, b: &PaintBox, line: &str, os_name: &str) -> f32 {
    canvas.set_font(&font_css(b, &b.font_family));
    line_segments(b, line, os_name)
        .iter()
        .map(|seg| match seg.face {
            Some(f) => canvas.measure_text_with_face(seg.text, f.data, f.index),
            None => canvas.measure_text(seg.text),
        } as f32)
        .sum()
}

fn draw_line(
    canvas: &mut Canvas2D,
    b: &PaintBox,
    line: &str,
    x: f32,
    baseline: f32,
    os_name: &str,
) {
    let mut x = x;
    for seg in line_segments(b, line, os_name) {
        let width = match seg.face {
            Some(f) => {
                canvas.fill_text_with_face(seg.text, x, baseline, f.data, f.index);
                canvas.measure_text_with_face(seg.text, f.data, f.index)
            }
            None => {
                canvas.fill_text(seg.text, x, baseline);
                canvas.measure_text(seg.text)
            }
        };
        x += width as f32;
    }
}

fn paint_text(canvas: &mut Canvas2D, b: &PaintBox, text: &str, os_name: &str) {
    let size = b.font_size.max(1.0);
    canvas.set_font(&font_css(b, &b.font_family));
    set_fill(canvas, b.color);
    canvas.set_global_alpha(b.opacity);

    // A line layout already broke is drawn where layout put it.
    if let Some(baseline) = b.text_baseline {
        if clipped([b.x, b.y, b.width, b.height], b.clip).is_some() {
            draw_line(canvas, b, text, b.x, baseline, os_name);
        }
        canvas.set_global_alpha(1.0);
        return;
    }

    // Layout sized this run at 1.2em per line; paint on the same grid so the
    // lines land inside the box layout gave them.
    let line_height = size * 1.2;
    let lines = wrap_lines(text, b.width.max(1.0), |s| {
        line_width(canvas, b, s, os_name)
    });
    for (i, line) in lines.iter().enumerate() {
        let top = b.y + i as f32 * line_height;
        // Whole-line clipping: a line only partly inside an overflow box still
        // draws whole. Good enough until the canvas grows a clip stack.
        if clipped([b.x, top, b.width, line_height], b.clip).is_none() {
            continue;
        }
        draw_line(canvas, b, line, b.x, top + size, os_name);
    }
    canvas.set_global_alpha(1.0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_breaks_at_the_limit() {
        // One unit per character.
        let lines = wrap_lines("aa bb cc dd", 5.0, |s| s.len() as f32);
        assert_eq!(lines, vec!["aa bb", "cc dd"]);
    }

    #[test]
    fn wrap_keeps_an_overlong_word_whole() {
        let lines = wrap_lines("abcdefgh ij", 4.0, |s| s.len() as f32);
        assert_eq!(lines, vec!["abcdefgh", "ij"]);
    }

    #[test]
    fn wrap_collapses_whitespace() {
        let lines = wrap_lines("  a \n\t b  ", 100.0, |s| s.len() as f32);
        assert_eq!(lines, vec!["a b"]);
    }

    #[test]
    fn clip_intersects_and_rejects() {
        let c = Some([0.0, 0.0, 10.0, 10.0]);
        assert_eq!(
            clipped([5.0, 5.0, 10.0, 10.0], c),
            Some([5.0, 5.0, 5.0, 5.0])
        );
        assert_eq!(clipped([20.0, 0.0, 5.0, 5.0], c), None);
        assert_eq!(
            clipped([1.0, 1.0, 2.0, 2.0], None),
            Some([1.0, 1.0, 2.0, 2.0])
        );
    }

    #[test]
    fn surface_size_caps_full_page() {
        let vp = Viewport::new(800.0, 600.0);
        assert_eq!(surface_size(vp, 100.0, false), (800, 600));
        assert_eq!(surface_size(vp, 5000.0, true), (800, 5000));
        assert_eq!(surface_size(vp, 100.0, true), (800, 600));
        assert_eq!(surface_size(vp, 1e9, true).1, MAX_HEIGHT);
    }
}
