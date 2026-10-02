//! What layout needs to know about a font: which one, how tall, how far apart
//! its lines are.

use crate::css_cascade::ComputedStyle;
use crate::css_values::property::{CssValue, LineHeight, PropertyId};
use crate::css_values::types::font::{FontFamily, FontStyle, FontWeight, GenericFamily};
use crate::layout::resolve::{resolve_length, ResolveContext};
use crate::text::{resolve_face, shaper, ParsedFont};

/// `font-family` as a canvas `font` shorthand takes it: named families quoted,
/// generic keywords as they are, and never empty.
pub(crate) fn family_list(c: &ComputedStyle) -> String {
    let Some(CssValue::FontFamily(list)) = c.get(&PropertyId::FontFamily) else {
        return "serif".to_string();
    };
    let mut names: Vec<String> = list
        .iter()
        .filter_map(|f| match f {
            FontFamily::Named(n) => Some(format!("\"{}\"", n.replace('"', ""))),
            FontFamily::Generic(g) => match g {
                GenericFamily::Serif | GenericFamily::UiSerif => Some("serif".to_string()),
                GenericFamily::SansSerif
                | GenericFamily::UiSansSerif
                | GenericFamily::UiRounded => Some("sans-serif".to_string()),
                GenericFamily::Monospace | GenericFamily::UiMonospace => {
                    Some("monospace".to_string())
                }
                GenericFamily::SystemUi => Some("system-ui".to_string()),
                GenericFamily::Cursive => Some("cursive".to_string()),
                GenericFamily::Fantasy => Some("fantasy".to_string()),
                _ => None,
            },
        })
        .collect();
    if names.is_empty() {
        names.push("sans-serif".to_string());
    }
    names.join(", ")
}

/// A computed `font-weight` as the 100–900 number faces are chosen by.
pub(crate) fn weight_of(c: &ComputedStyle) -> u16 {
    match c.get(&PropertyId::FontWeight) {
        Some(CssValue::FontWeight(FontWeight::Bold | FontWeight::Bolder)) => 700,
        Some(CssValue::FontWeight(FontWeight::Lighter)) => 300,
        Some(CssValue::FontWeight(FontWeight::Numeric(n))) => n.clamp(1.0, 1000.0) as u16,
        _ => 400,
    }
}

pub(crate) fn is_italic(c: &ComputedStyle) -> bool {
    matches!(
        c.get(&PropertyId::FontStyle),
        Some(CssValue::FontStyle(s)) if *s != FontStyle::Normal
    )
}

/// The font an element is set in.
#[derive(Debug, Clone)]
pub struct FontSpec {
    pub families: String,
    pub size: f32,
    pub weight: u16,
    pub italic: bool,
}

impl FontSpec {
    pub fn from_computed(c: &ComputedStyle, size: f32) -> Self {
        Self {
            families: family_list(c),
            size,
            weight: weight_of(c),
            italic: is_italic(c),
        }
    }

    pub fn parsed(&self) -> ParsedFont {
        let css = format!(
            "{}{} {}px {}",
            if self.italic { "italic " } else { "" },
            self.weight,
            self.size.max(1.0),
            self.families
        );
        ParsedFont::parse(&css).unwrap_or_else(ParsedFont::default_font)
    }
}

/// A font's vertical metrics in px, each rounded the way Blink rounds them: the
/// content area of an inline box is `ascent + descent`, and `normal` line spacing
/// is that plus `line_gap`. Blink works in device pixels (a page at 2x is laid out at zoom 2),
/// so the rounding is to whole device pixels: half a px at 2x.
#[derive(Debug, Clone, Copy)]
pub struct Metrics {
    pub ascent: f32,
    pub descent: f32,
    pub line_gap: f32,
    /// Height of a lowercase `x`, what `vertical-align: middle` is measured by.
    pub x_height: f32,
    pub dpr: f32,
}

impl Metrics {
    pub fn of(font: &ParsedFont, os_name: &str, dpr: f32) -> Self {
        let size = font.size_px * dpr;
        let from_face = resolve_face(font, os_name)
            .and_then(|(data, index)| shaper::face(data, index))
            .and_then(|face| {
                let face: &rustybuzz::ttf_parser::Face = face;
                let upem = f32::from(face.units_per_em());
                (upem > 0.0).then(|| {
                    let scale = size / upem;
                    (
                        (f32::from(face.ascender()) * scale).round(),
                        (-f32::from(face.descender()) * scale).round(),
                        (f32::from(face.line_gap()) * scale).round(),
                        face.x_height().map_or(size * 0.5, |h| f32::from(h) * scale),
                    )
                })
            });
        let (mut ascent, mut descent, mut line_gap, x_height) =
            from_face.unwrap_or(((size * 0.8).round(), (size * 0.2).round(), 0.0, size * 0.5));
        // The profile's own numbers win over the bundled face's.
        if let Some((a, d, g)) = crate::text::metrics_table::vertical(&font.families, os_name, size)
        {
            (ascent, descent, line_gap) = (a, d, g);
        }
        let x_height =
            crate::text::metrics_table::x_height(&font.families, os_name, font.size_px, dpr)
                .unwrap_or(x_height);
        Self {
            ascent: ascent / dpr,
            descent: descent / dpr,
            line_gap: line_gap / dpr,
            x_height: x_height / dpr,
            dpr,
        }
    }

    /// `line-height: normal`.
    pub fn normal_line_height(&self) -> f32 {
        self.ascent + self.descent + self.line_gap
    }

    /// Ascent and descent once half-leading is added for `line_height`: what the
    /// inline box occupies above and below the baseline. The leading above is
    /// floored to a device pixel, as in Blink, so an odd leftover goes below.
    pub fn with_leading(&self, line_height: f32) -> (f32, f32) {
        let leading = line_height - (self.ascent + self.descent);
        let above = (leading * self.dpr / 2.0).floor() / self.dpr;
        (self.ascent + above, line_height - self.ascent - above)
    }
}

/// The computed `line-height` of an element in px.
pub fn line_height_px(
    c: &ComputedStyle,
    size: f32,
    metrics: &Metrics,
    ctx: &ResolveContext,
) -> f32 {
    let raw = match c.get(&PropertyId::LineHeight) {
        Some(CssValue::LineHeight(LineHeight::Number(n))) => *n as f32 * size,
        Some(CssValue::LineHeight(LineHeight::Length(l))) => resolve_length(
            l,
            &ResolveContext {
                font_size: size,
                ..*ctx
            },
        ),
        Some(CssValue::LineHeight(LineHeight::Percentage(p))) => *p as f32 / 100.0 * size,
        _ => return metrics.normal_line_height(),
    };
    // Blink keeps it in 1/64 device px (`LayoutUnit`), rounded to the nearest; over a long page
    // the difference from a plain float adds up to more than a pixel.
    let unit = 64.0 * metrics.dpr;
    (raw * unit).round() / unit
}
