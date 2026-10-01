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

/// The leading digits of an attribute value, as a CSS length: `85%` stays a
/// percentage, `100` and `100px` become pixels.
fn attr_length(value: &str) -> Option<String> {
    let v = value.trim();
    let digits: String = v
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if digits.is_empty() {
        return None;
    }
    Some(if v[digits.len()..].trim_start().starts_with('%') {
        format!("{digits}%")
    } else {
        format!("{digits}px")
    })
}

/// The presentational attributes of the old table markup, as CSS text:
/// `width`, `height`, `cellspacing`, `cellpadding`, `border`, `align`, `valign`,
/// `nowrap` and `bgcolor`. Only `LayoutMode::Full` has tables to apply them to.
pub(crate) fn table_hints_css(
    dom: &crate::dom::Dom,
    node: crate::dom::node::NodeId,
    elem: &crate::dom::node::ElementData,
) -> String {
    let attr = |e: &crate::dom::node::ElementData, name: &str| -> Option<String> {
        e.attrs
            .iter()
            .find(|a| a.name.local.eq_ignore_ascii_case(name))
            .map(|a| a.value.trim().to_string())
    };
    let tag = elem.name.local.to_ascii_lowercase();
    // The table a cell belongs to, for the attributes that live on it.
    let table_of = || {
        let mut up = dom.get(node).and_then(|n| n.parent);
        while let Some(p) = up {
            let n = dom.get(p)?;
            if let Some(e) = n.as_element() {
                if e.name.local.eq_ignore_ascii_case("table") {
                    return Some(e);
                }
            }
            up = n.parent;
        }
        None
    };
    let mut css = String::new();
    let mut push = |prop: &str, value: &str| {
        css.push_str(prop);
        css.push(':');
        css.push_str(value);
        css.push(';');
    };
    let align =
        |v: &str| matches!(v, "left" | "right" | "center" | "justify").then(|| v.to_string());
    match tag.as_str() {
        "table" => {
            for (a, p) in [("width", "width"), ("height", "height")] {
                if let Some(v) = attr(elem, a).as_deref().and_then(attr_length) {
                    push(p, &v);
                }
            }
            if let Some(v) = attr(elem, "cellspacing").as_deref().and_then(attr_length) {
                push("border-spacing", &v);
            }
            if let Some(b) = attr(elem, "border") {
                let n = if b.is_empty() {
                    Some("1px".to_string())
                } else {
                    attr_length(&b)
                };
                if let Some(n) = n.filter(|n| n != "0px") {
                    push("border-width", &n);
                    push("border-style", "outset");
                    push("border-color", "gray");
                }
            }
            match attr(elem, "align").as_deref() {
                Some("center") => {
                    push("margin-left", "auto");
                    push("margin-right", "auto");
                }
                Some("right") => push("float", "right"),
                Some("left") => push("float", "left"),
                _ => {}
            }
            if let Some(c) = attr(elem, "bgcolor") {
                push("background-color", &c);
            }
        }
        "td" | "th" => {
            for (a, p) in [("width", "width"), ("height", "height")] {
                if let Some(v) = attr(elem, a).as_deref().and_then(attr_length) {
                    push(p, &v);
                }
            }
            if let Some(table) = table_of() {
                if let Some(v) = attr(table, "cellpadding").as_deref().and_then(attr_length) {
                    push("padding", &v);
                }
                if attr(table, "border")
                    .is_some_and(|b| b.is_empty() || attr_length(&b).is_some_and(|n| n != "0px"))
                {
                    push("border-width", "1px");
                    push("border-style", "inset");
                    push("border-color", "gray");
                }
            }
            if let Some(a) = attr(elem, "align").as_deref().and_then(align) {
                push("text-align", &a);
            }
            if let Some(v) = attr(elem, "valign") {
                push("vertical-align", &v);
            }
            if attr(elem, "nowrap").is_some() {
                push("white-space", "nowrap");
            }
            if let Some(c) = attr(elem, "bgcolor") {
                push("background-color", &c);
            }
        }
        "tr" | "thead" | "tbody" | "tfoot" => {
            if let Some(a) = attr(elem, "align").as_deref().and_then(align) {
                push("text-align", &a);
            }
            if let Some(v) = attr(elem, "valign") {
                push("vertical-align", &v);
            }
            if let Some(c) = attr(elem, "bgcolor") {
                push("background-color", &c);
            }
        }
        _ => {}
    }
    css
}
