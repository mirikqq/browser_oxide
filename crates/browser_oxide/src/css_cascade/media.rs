use crate::css_parser::{ComponentValue, Token, TokenKind};

/// Media feature values for @media evaluation.
#[derive(Debug, Clone)]
pub struct MediaFeatures {
    pub width: f64,
    pub height: f64,
    pub device_pixel_ratio: f64,
    pub prefers_color_scheme: ColorScheme,
    pub prefers_reduced_motion: ReducedMotion,
    pub pointer: PointerType,
    pub hover: HoverCapability,
    pub scripting: Scripting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorScheme {
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReducedMotion {
    NoPreference,
    Reduce,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerType {
    None,
    Coarse,
    Fine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoverCapability {
    None,
    Hover,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scripting {
    None,
    Enabled,
}

impl Default for MediaFeatures {
    fn default() -> Self {
        Self {
            width: 1920.0,
            height: 1080.0,
            device_pixel_ratio: 1.0,
            prefers_color_scheme: ColorScheme::Light,
            prefers_reduced_motion: ReducedMotion::NoPreference,
            pointer: PointerType::Fine,
            hover: HoverCapability::Hover,
            scripting: Scripting::Enabled,
        }
    }
}

/// Evaluate a @media prelude against the current features.
///
/// This is a simplified evaluator that handles common media queries:
/// `screen`, `print`, `(min-width: Xpx)`, `(max-width: Xpx)`,
/// `(prefers-color-scheme: dark)`, etc.
pub fn evaluate_media_query(prelude: &[ComponentValue<'_>], features: &MediaFeatures) -> bool {
    let text = prelude_to_text(prelude);
    let text = text.trim().to_ascii_lowercase();

    // Empty media query = all = true
    if text.is_empty() || text == "all" {
        return true;
    }

    // "screen" matches (we're always screen)
    if text == "screen" {
        return true;
    }

    // "print" never matches
    if text == "print" {
        return false;
    }

    // Handle comma-separated media queries (OR logic)
    if text.contains(',') {
        return text
            .split(',')
            .any(|part| evaluate_single_query(part.trim(), features));
    }

    evaluate_single_query(&text, features)
}

/// [`evaluate_media_query`], to the letter of Media Queries 4: a media type with
/// `only`/`not`, conditions joined by `and`, range syntax, and a feature nobody
/// knows is false rather than true. Used by `LayoutMode::Full`; the lenient one
/// stays for the legacy layout.
pub fn evaluate_media_query_strict(prelude: &[ComponentValue<'_>], f: &MediaFeatures) -> bool {
    let text = prelude_to_text(prelude).to_ascii_lowercase();
    if text.trim().is_empty() {
        return true;
    }
    split_top_level(&text, ',')
        .iter()
        .any(|q| strict_query(q, f))
}

fn split_top_level(text: &str, sep: char) -> Vec<String> {
    let (mut out, mut cur, mut depth) = (Vec::new(), String::new(), 0i32);
    for c in text.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        if c == sep && depth == 0 {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
    }
    out.push(cur);
    out
}

fn strict_query(query: &str, f: &MediaFeatures) -> bool {
    let mut rest = query.trim();
    if rest.is_empty() {
        return false;
    }
    let mut negate = false;
    if let Some(r) = rest.strip_prefix("not ") {
        negate = true;
        rest = r.trim_start();
    } else if let Some(r) = rest.strip_prefix("only ") {
        rest = r.trim_start();
    }
    let mut matches = true;
    if !rest.starts_with('(') {
        let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
        matches = matches!(&rest[..end], "all" | "screen");
        rest = rest[end..].trim_start();
        if let Some(r) = rest.strip_prefix("and") {
            rest = r.trim_start();
        } else if !rest.is_empty() {
            return false;
        }
    }
    while !rest.is_empty() {
        if !rest.starts_with('(') {
            return false;
        }
        let mut depth = 0;
        let mut close = None;
        for (i, c) in rest.char_indices() {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(i);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(close) = close else { return false };
        matches &= strict_condition(&rest[1..close], f);
        rest = rest[close + 1..].trim_start();
        if let Some(r) = rest.strip_prefix("and") {
            rest = r.trim_start();
        } else if !rest.is_empty() {
            return false;
        }
    }
    matches != negate
}

/// Length, in px, of a media-query value (`600px`, `40em`).
fn media_length(v: &str) -> Option<f64> {
    let v = v.trim();
    for (suffix, factor) in [("px", 1.0), ("rem", 16.0), ("em", 16.0), ("pt", 4.0 / 3.0)] {
        if let Some(n) = v.strip_suffix(suffix) {
            return n.trim().parse::<f64>().ok().map(|n| n * factor);
        }
    }
    (v == "0").then_some(0.0)
}

fn media_ratio(v: &str) -> Option<f64> {
    match v.split_once('/') {
        Some((a, b)) => Some(a.trim().parse::<f64>().ok()? / b.trim().parse::<f64>().ok()?),
        None => v.trim().parse::<f64>().ok(),
    }
}

fn media_resolution(v: &str) -> Option<f64> {
    let v = v.trim();
    if let Some(n) = v.strip_suffix("dppx").or_else(|| v.strip_suffix('x')) {
        return n.trim().parse().ok();
    }
    if let Some(n) = v.strip_suffix("dpi") {
        return n.trim().parse::<f64>().ok().map(|n| n / 96.0);
    }
    if let Some(n) = v.strip_suffix("dpcm") {
        return n.trim().parse::<f64>().ok().map(|n| n * 2.54 / 96.0);
    }
    None
}

/// The number a range feature has, and how to read a value for it.
/// How a range feature's operand is read: a length, a resolution or a ratio, as a number.
type Operand = fn(&str) -> Option<f64>;

fn range_feature(name: &str, f: &MediaFeatures) -> Option<(f64, Operand)> {
    Some(match name {
        "width" | "device-width" => (f.width, media_length),
        "height" | "device-height" => (f.height, media_length),
        "aspect-ratio" | "device-aspect-ratio" => (f.width / f.height, media_ratio),
        "resolution" => (f.device_pixel_ratio, media_resolution),
        "-webkit-device-pixel-ratio" | "device-pixel-ratio" => {
            (f.device_pixel_ratio, |v| v.trim().parse().ok())
        }
        _ => return None,
    })
}

fn strict_condition(cond: &str, f: &MediaFeatures) -> bool {
    let cond = cond.trim();
    // `not (...)`, nested conditions and `or` are not supported: not matching.
    if cond.starts_with('(') || cond.starts_with("not ") || cond.contains(" or ") {
        return false;
    }
    // Range syntax: `width >= 600px`, `400px <= width <= 700px`.
    for op in ["<=", ">=", "<", ">", "="] {
        if cond.contains(op) && !cond.contains(':') {
            let parts: Vec<&str> = split_ops(cond);
            return match parts.as_slice() {
                [name, op, value] => range_compare(name, op, value, f),
                [low, op1, name, op2, high] => {
                    range_compare(name, flip(op1), low, f) && range_compare(name, op2, high, f)
                }
                _ => false,
            };
        }
    }
    if let Some((name, value)) = cond.split_once(':') {
        let (name, value) = (name.trim(), value.trim());
        for (prefix, op) in [("min-", ">="), ("max-", "<=")] {
            if let Some(base) = name.strip_prefix(prefix) {
                let base = base.strip_prefix("-webkit-").unwrap_or(base);
                return range_compare(base, op, value, f);
            }
        }
        if let Some(rest) = name.strip_prefix("-webkit-min-") {
            return range_compare(rest, ">=", value, f);
        }
        if let Some(rest) = name.strip_prefix("-webkit-max-") {
            return range_compare(rest, "<=", value, f);
        }
        if range_feature(name, f).is_some() {
            return range_compare(name, "=", value, f);
        }
        return discrete(name, Some(value), f);
    }
    if range_feature(cond, f).is_some() {
        return f.width > 0.0;
    }
    discrete(cond, None, f)
}

fn split_ops(cond: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut start, bytes) = (0, cond.as_bytes());
    let mut i = 0;
    while i < bytes.len() {
        if matches!(bytes[i], b'<' | b'>' | b'=') {
            parts.push(cond[start..i].trim());
            let len = if bytes.get(i + 1) == Some(&b'=') {
                2
            } else {
                1
            };
            parts.push(&cond[i..i + len]);
            i += len;
            start = i;
        } else {
            i += 1;
        }
    }
    parts.push(cond[start..].trim());
    parts
}

fn flip(op: &str) -> &str {
    match op {
        "<" => ">",
        "<=" => ">=",
        ">" => "<",
        ">=" => "<=",
        o => o,
    }
}

fn range_compare(name: &str, op: &str, value: &str, f: &MediaFeatures) -> bool {
    let Some((have, parse)) = range_feature(name, f) else {
        return false;
    };
    let Some(want) = parse(value) else {
        return false;
    };
    match op {
        ">=" => have >= want,
        "<=" => have <= want,
        ">" => have > want,
        "<" => have < want,
        _ => (have - want).abs() < 0.001,
    }
}

/// Features that take a keyword.
fn discrete(name: &str, value: Option<&str>, f: &MediaFeatures) -> bool {
    let is = |v: &str| value == Some(v);
    match name {
        "orientation" => {
            (is("landscape") && f.width >= f.height) || (is("portrait") && f.width < f.height)
        }
        "prefers-color-scheme" => {
            (is("light") && f.prefers_color_scheme == ColorScheme::Light)
                || (is("dark") && f.prefers_color_scheme == ColorScheme::Dark)
        }
        "prefers-reduced-motion" => {
            (is("reduce") && f.prefers_reduced_motion == ReducedMotion::Reduce)
                || (is("no-preference") && f.prefers_reduced_motion == ReducedMotion::NoPreference)
        }
        "hover" | "any-hover" => match value {
            None => f.hover == HoverCapability::Hover,
            Some(v) => (v == "hover") == (f.hover == HoverCapability::Hover),
        },
        "pointer" | "any-pointer" => match value {
            None => f.pointer != PointerType::None,
            Some("fine") => f.pointer == PointerType::Fine,
            Some("coarse") => f.pointer == PointerType::Coarse,
            Some("none") => f.pointer == PointerType::None,
            _ => false,
        },
        "scripting" => match value {
            None => f.scripting == Scripting::Enabled,
            Some("enabled") => f.scripting == Scripting::Enabled,
            Some("none") => f.scripting == Scripting::None,
            _ => false,
        },
        "color" => value.is_none_or(|v| v.parse::<u32>().is_ok_and(|n| n <= 8)),
        "monochrome" => value.is_some_and(|v| v == "0"),
        "color-index" => value.is_some_and(|v| v == "0"),
        "display-mode" => is("browser"),
        "update" => is("fast"),
        "forced-colors" => is("none"),
        "prefers-contrast" => is("no-preference"),
        "prefers-reduced-transparency" | "prefers-reduced-data" => is("no-preference"),
        "inverted-colors" => is("none"),
        "grid" => is("0"),
        _ => false,
    }
}

fn evaluate_single_query(query: &str, features: &MediaFeatures) -> bool {
    let query = query.trim();

    // Strip "screen and " or "all and " prefix
    let query = query
        .strip_prefix("screen and ")
        .or_else(|| query.strip_prefix("all and "))
        .unwrap_or(query);

    // Handle "not (...)"
    if let Some(inner) = query.strip_prefix("not ") {
        return !evaluate_single_query(inner.trim(), features);
    }

    // Handle parenthesized feature: (feature: value) or (feature > value)
    let query = query.trim_start_matches('(').trim_end_matches(')');

    if let Some((feature, value)) = query.split_once(':') {
        return evaluate_feature(feature.trim(), value.trim(), features);
    }

    // Range syntax: (width > 768px), (width >= 768px)
    if let Some((feature, value)) = query.split_once(">=") {
        return evaluate_range(feature.trim(), ">=", value.trim(), features);
    }
    if let Some((feature, value)) = query.split_once("<=") {
        return evaluate_range(feature.trim(), "<=", value.trim(), features);
    }
    if let Some((feature, value)) = query.split_once('>') {
        return evaluate_range(feature.trim(), ">", value.trim(), features);
    }
    if let Some((feature, value)) = query.split_once('<') {
        return evaluate_range(feature.trim(), "<", value.trim(), features);
    }

    // Boolean feature: just the name
    match query {
        "hover" => features.hover == HoverCapability::Hover,
        "pointer" => features.pointer != PointerType::None,
        "color" => true,
        "scripting" => features.scripting == Scripting::Enabled,
        _ => true, // Unknown features default to true (forward-compat)
    }
}

fn evaluate_feature(feature: &str, value: &str, features: &MediaFeatures) -> bool {
    match feature {
        "min-width" => parse_px(value).is_some_and(|v| features.width >= v),
        "max-width" => parse_px(value).is_some_and(|v| features.width <= v),
        "min-height" => parse_px(value).is_some_and(|v| features.height >= v),
        "max-height" => parse_px(value).is_some_and(|v| features.height <= v),
        "width" => parse_px(value).is_some_and(|v| (features.width - v).abs() < 0.01),
        "height" => parse_px(value).is_some_and(|v| (features.height - v).abs() < 0.01),
        "prefers-color-scheme" => match value {
            "dark" => features.prefers_color_scheme == ColorScheme::Dark,
            "light" => features.prefers_color_scheme == ColorScheme::Light,
            _ => false,
        },
        "prefers-reduced-motion" => match value {
            "reduce" => features.prefers_reduced_motion == ReducedMotion::Reduce,
            "no-preference" => features.prefers_reduced_motion == ReducedMotion::NoPreference,
            _ => false,
        },
        "pointer" => match value {
            "fine" => features.pointer == PointerType::Fine,
            "coarse" => features.pointer == PointerType::Coarse,
            "none" => features.pointer == PointerType::None,
            _ => false,
        },
        "hover" => match value {
            "hover" => features.hover == HoverCapability::Hover,
            "none" => features.hover == HoverCapability::None,
            _ => false,
        },
        _ => true,
    }
}

fn evaluate_range(feature: &str, op: &str, value: &str, features: &MediaFeatures) -> bool {
    let feature_val = match feature {
        "width" => features.width,
        "height" => features.height,
        _ => return true,
    };
    let target = match parse_px(value) {
        Some(v) => v,
        None => return true,
    };
    match op {
        ">" => feature_val > target,
        ">=" => feature_val >= target,
        "<" => feature_val < target,
        "<=" => feature_val <= target,
        _ => true,
    }
}

fn parse_px(s: &str) -> Option<f64> {
    let s = s.trim().trim_end_matches("px").trim();
    s.parse::<f64>().ok()
}

fn prelude_to_text(prelude: &[ComponentValue<'_>]) -> String {
    let mut s = String::new();
    for cv in prelude {
        match cv {
            ComponentValue::Token(Token { kind, .. }) => match kind {
                TokenKind::Ident(v) => s.push_str(v),
                TokenKind::Number { value, .. } => s.push_str(&value.to_string()),
                TokenKind::Dimension { value, unit, .. } => {
                    s.push_str(&value.to_string());
                    s.push_str(unit);
                }
                TokenKind::Whitespace => s.push(' '),
                TokenKind::Colon => s.push(':'),
                TokenKind::Comma => s.push(','),
                TokenKind::Delim(c) => s.push(*c),
                _ => {}
            },
            ComponentValue::SimpleBlock(b) => {
                s.push(b.token);
                s.push_str(&prelude_to_text(&b.value));
                match b.token {
                    '{' => s.push('}'),
                    '[' => s.push(']'),
                    '(' => s.push(')'),
                    _ => {}
                }
            }
            ComponentValue::Function(f) => {
                s.push_str(f.name);
                s.push('(');
                s.push_str(&prelude_to_text(&f.arguments));
                s.push(')');
            }
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn features() -> MediaFeatures {
        MediaFeatures::default() // 1920x1080, light, fine pointer
    }

    fn eval(css: &str) -> bool {
        let input = format!("@media {} {{}}", css);
        let (stylesheet, _) = crate::css_parser::parse_stylesheet(&input);
        if let Some(crate::css_parser::Rule::At(at)) = stylesheet.rules.first() {
            evaluate_media_query(&at.prelude, &features())
        } else {
            panic!("Expected @media rule");
        }
    }

    #[test]
    fn screen() {
        assert!(eval("screen"));
    }

    #[test]
    fn print_false() {
        assert!(!eval("print"));
    }

    #[test]
    fn min_width_matches() {
        assert!(eval("(min-width: 768px)"));
    }

    #[test]
    fn min_width_no_match() {
        assert!(!eval("(min-width: 2000px)"));
    }

    #[test]
    fn max_width_matches() {
        assert!(eval("(max-width: 2000px)"));
    }

    #[test]
    fn prefers_color_scheme_light() {
        assert!(eval("(prefers-color-scheme: light)"));
    }

    #[test]
    fn prefers_color_scheme_dark_no_match() {
        assert!(!eval("(prefers-color-scheme: dark)"));
    }

    #[test]
    fn range_syntax() {
        assert!(eval("(width > 768px)"));
    }
}
