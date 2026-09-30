//! Presentational hints: markup attributes that act as style.
//!
//! They enter the cascade below author CSS — where the spec puts them — by way of
//! the user-agent origin, after the user-agent stylesheet's own rules.

use std::collections::HashMap;

use crate::css_values::property::{CssValue, PropertyId};

/// Presentational size hints: `width` / `height` written as attributes.
///
/// `<svg width="44" height="46">` — and the same on `<img>`, `<canvas>`,
/// `<iframe>` and friends — is how a great deal of markup states its size.
/// Nothing mapped them into the cascade, so those elements computed
/// `height: auto` and laid out zero pixels tall: an inline SVG logo occupied
/// its width and no height at all, and everything drawn inside it collapsed
/// with it. They enter the cascade below author CSS, which is where the spec
/// puts presentational hints.
pub(crate) fn presentational_declarations(
    elem: &crate::dom::node::ElementData,
) -> HashMap<PropertyId, CssValue> {
    const SIZED: &[&str] = &[
        "img", "svg", "canvas", "iframe", "embed", "object", "video", "input",
    ];
    use crate::css_values::types::length::{Length as CssLength, LengthPercentageAuto as CssLpa};
    let mut out = HashMap::new();
    if !SIZED.contains(&&*elem.name.local) {
        return out;
    }
    for (attr, prop) in [("width", PropertyId::Width), ("height", PropertyId::Height)] {
        let Some(raw) = elem
            .attrs
            .iter()
            .find(|a| a.name.local == *attr)
            .map(|a| a.value.trim())
        else {
            continue;
        };
        let value = if let Some(pct) = raw.strip_suffix('%') {
            pct.trim()
                .parse::<f64>()
                .ok()
                .map(|n| CssValue::LengthPercentageAuto(CssLpa::Percentage(n)))
        } else {
            raw.parse::<f64>()
                .ok()
                .map(|n| CssValue::LengthPercentageAuto(CssLpa::Length(CssLength::Px(n))))
        };
        if let Some(v) = value {
            out.insert(prop, v);
        }
    }
    out
}

/// Intrinsic replaced-element size for an outer SVG. Author CSS and explicit
/// width/height attributes are appended later and therefore keep precedence.
pub(crate) fn svg_intrinsic_declarations(
    elem: &crate::dom::node::ElementData,
) -> HashMap<PropertyId, CssValue> {
    use crate::css_values::types::length::{Length as CssLength, LengthPercentageAuto as CssLpa};
    let mut out = HashMap::new();
    if !elem.name.local.eq_ignore_ascii_case("svg") {
        return out;
    }
    let attr = |name: &str| elem.attrs.iter().find(|a| a.name.local == name);
    let view_box = attr("viewBox").or_else(|| attr("viewbox")).map(|a| {
        a.value
            .split(|c: char| c.is_ascii_whitespace() || c == ',')
            .filter_map(|part| part.parse::<f64>().ok())
            .collect::<Vec<_>>()
    });
    let ratio = view_box
        .as_deref()
        .filter(|parts| parts.len() == 4 && parts[2] > 0.0 && parts[3] > 0.0)
        .map(|parts| parts[2] / parts[3]);
    let width = attr("width").and_then(|a| a.value.trim().parse::<f64>().ok());
    let height = attr("height").and_then(|a| a.value.trim().parse::<f64>().ok());
    let (fallback_width, fallback_height) = match (width, height, ratio) {
        (Some(w), None, Some(r)) => (w, w / r),
        (None, Some(h), Some(r)) => (h * r, h),
        (None, None, Some(r)) => (300.0, 300.0 / r),
        _ => (300.0, 150.0),
    };
    out.insert(
        PropertyId::Width,
        CssValue::LengthPercentageAuto(CssLpa::Length(CssLength::Px(fallback_width))),
    );
    out.insert(
        PropertyId::Height,
        CssValue::LengthPercentageAuto(CssLpa::Length(CssLength::Px(fallback_height))),
    );
    out
}
