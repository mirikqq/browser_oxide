//! Shorthand properties that expand into longhands the engine models, and the
//! logical (`inline`/`block`) properties that are aliases of physical ones.
//!
//! Every expansion goes back through [`parse_property`] for each longhand, so a
//! longhand's value is parsed by exactly the code that parses it on its own.
//!
//! Logical properties are mapped for a horizontal, left-to-right writing mode —
//! the only one the engine lays out.

use crate::css_parser::{ComponentValue, Token, TokenKind};
use crate::css_values::error::ValueError;
use crate::css_values::parse::{
    parse_color, parse_font_family, parse_font_size, parse_font_style, parse_font_weight,
    parse_line_height, parse_property, try_ident,
};
use crate::css_values::property::{CssValue, PropertyDeclaration, PropertyId};
use crate::css_values::types::color::Color;
use crate::css_values::types::length::LengthPercentageAuto;

type Parsed = Result<Vec<PropertyDeclaration>, ValueError>;

/// The physical property a logical one stands for, in a horizontal LTR mode.
pub(crate) fn logical_alias(name: &str) -> Option<&'static str> {
    Some(match name {
        "inline-size" => "width",
        "block-size" => "height",
        "min-inline-size" => "min-width",
        "min-block-size" => "min-height",
        "max-inline-size" => "max-width",
        "max-block-size" => "max-height",
        "margin-inline-start" => "margin-left",
        "margin-inline-end" => "margin-right",
        "margin-block-start" => "margin-top",
        "margin-block-end" => "margin-bottom",
        "padding-inline-start" => "padding-left",
        "padding-inline-end" => "padding-right",
        "padding-block-start" => "padding-top",
        "padding-block-end" => "padding-bottom",
        "inset-inline-start" => "left",
        "inset-inline-end" => "right",
        "inset-block-start" => "top",
        "inset-block-end" => "bottom",
        "border-inline-start-width" => "border-left-width",
        "border-inline-end-width" => "border-right-width",
        "border-block-start-width" => "border-top-width",
        "border-block-end-width" => "border-bottom-width",
        "border-inline-start-style" => "border-left-style",
        "border-inline-end-style" => "border-right-style",
        "border-block-start-style" => "border-top-style",
        "border-block-end-style" => "border-bottom-style",
        "border-inline-start-color" => "border-left-color",
        "border-inline-end-color" => "border-right-color",
        "border-block-start-color" => "border-top-color",
        "border-block-end-color" => "border-bottom-color",
        _ => return None,
    })
}

/// The longhands a shorthand sets, for the CSS-wide keywords (`font: inherit`
/// means every one of them inherits). `None` for a name that is not one of the
/// shorthands handled here or in `parse.rs`.
pub(crate) fn longhands_of(name: &str) -> Option<Vec<String>> {
    const SIDES: [&str; 4] = ["top", "right", "bottom", "left"];
    let sided = |prefix: &str, suffix: &str| -> Vec<String> {
        SIDES
            .iter()
            .map(|s| {
                if suffix.is_empty() {
                    format!("{prefix}-{s}")
                } else {
                    format!("{prefix}-{s}-{suffix}")
                }
            })
            .collect()
    };
    let names = |list: &[&str]| -> Vec<String> { list.iter().map(|s| (*s).to_string()).collect() };
    Some(match name {
        "margin" => sided("margin", ""),
        "padding" => sided("padding", ""),
        "inset" => names(&["top", "right", "bottom", "left"]),
        "border-width" => sided("border", "width"),
        "border-style" => sided("border", "style"),
        "border-color" => sided("border", "color"),
        "gap" => names(&["row-gap", "column-gap"]),
        "columns" => names(&["column-width", "column-count"]),
        "flex" => names(&["flex-grow", "flex-shrink", "flex-basis"]),
        "flex-flow" => names(&["flex-direction", "flex-wrap"]),
        "overflow" => names(&["overflow-x", "overflow-y"]),
        "background" => names(&["background-color"]),
        "place-items" => names(&["align-items", "justify-items"]),
        "place-content" => names(&["align-content", "justify-content"]),
        "place-self" => names(&["align-self", "justify-self"]),
        "margin-inline" => names(&["margin-left", "margin-right"]),
        "margin-block" => names(&["margin-top", "margin-bottom"]),
        "padding-inline" => names(&["padding-left", "padding-right"]),
        "padding-block" => names(&["padding-top", "padding-bottom"]),
        "inset-inline" => names(&["left", "right"]),
        "inset-block" => names(&["top", "bottom"]),
        "list-style" => names(&["list-style-type"]),
        "grid-template" => names(&[
            "grid-template-rows",
            "grid-template-columns",
            "grid-template-areas",
        ]),
        "font" => names(&[
            "font-style",
            "font-weight",
            "font-size",
            "line-height",
            "font-family",
        ]),
        "border" => {
            let mut v = sided("border", "width");
            v.extend(sided("border", "style"));
            v.extend(sided("border", "color"));
            v
        }
        "border-top" | "border-right" | "border-bottom" | "border-left" => {
            vec![
                format!("{name}-width"),
                format!("{name}-style"),
                format!("{name}-color"),
            ]
        }
        _ => return None,
    })
}

fn is_space(v: &ComponentValue<'_>) -> bool {
    matches!(
        v,
        ComponentValue::Token(Token {
            kind: TokenKind::Whitespace,
            ..
        })
    )
}

/// The space-separated parts of a value.
fn parts<'a, 'b>(value: &'a [ComponentValue<'b>]) -> Vec<&'a ComponentValue<'b>> {
    value.iter().filter(|v| !is_space(v)).collect()
}

fn is_number(v: &ComponentValue<'_>) -> Option<f64> {
    match v {
        ComponentValue::Token(Token {
            kind: TokenKind::Number { value, .. },
            ..
        }) => Some(*value),
        _ => None,
    }
}

fn is_delim(v: &ComponentValue<'_>, c: char) -> bool {
    matches!(
        v,
        ComponentValue::Token(Token {
            kind: TokenKind::Delim(d),
            ..
        }) if *d == c
    )
}

/// Parse `value` as the longhand `name`.
fn longhand(name: &str, value: &[ComponentValue<'_>], important: bool) -> Parsed {
    parse_property(name, value, important)
}

fn decl(name: &str, value: CssValue, important: bool) -> PropertyDeclaration {
    PropertyDeclaration {
        property: PropertyId::from_name(name),
        value,
        important,
    }
}

/// `a` → all four sides; `a b` → vertical, horizontal; `a b c`; `a b c d`.
fn four<'a, 'b>(p: &[&'a ComponentValue<'b>]) -> Option<[&'a ComponentValue<'b>; 4]> {
    Some(match p.len() {
        1 => [p[0], p[0], p[0], p[0]],
        2 => [p[0], p[1], p[0], p[1]],
        3 => [p[0], p[1], p[2], p[1]],
        4 => [p[0], p[1], p[2], p[3]],
        _ => return None,
    })
}

fn bad(what: &str) -> ValueError {
    ValueError::InvalidValue(format!("invalid {what}"))
}

/// Expand `name` if it is one of the shorthands handled here. `None` means the
/// name is not one of them and parsing should carry on as usual.
pub(crate) fn expand(name: &str, value: &[ComponentValue<'_>], important: bool) -> Option<Parsed> {
    let p = parts(value);
    Some(match name {
        "gap" => pair(&p, ["row-gap", "column-gap"], important, "gap"),
        "columns" => columns(&p, important),
        "margin-inline" => pair(&p, ["margin-left", "margin-right"], important, name),
        "margin-block" => pair(&p, ["margin-top", "margin-bottom"], important, name),
        "padding-inline" => pair(&p, ["padding-left", "padding-right"], important, name),
        "padding-block" => pair(&p, ["padding-top", "padding-bottom"], important, name),
        "inset-inline" => pair(&p, ["left", "right"], important, name),
        "inset-block" => pair(&p, ["top", "bottom"], important, name),
        "place-items" => pair(&p, ["align-items", "justify-items"], important, name),
        "place-content" => pair(&p, ["align-content", "justify-content"], important, name),
        "place-self" => pair(&p, ["align-self", "justify-self"], important, name),
        "border-width" | "border-style" | "border-color" => {
            let kind = &name["border-".len()..];
            match four(&p) {
                Some(vals) => {
                    let mut out = Vec::new();
                    for (side, v) in ["top", "right", "bottom", "left"].iter().zip(vals) {
                        match longhand(
                            &format!("border-{side}-{kind}"),
                            std::slice::from_ref(v),
                            important,
                        ) {
                            Ok(d) => out.extend(d),
                            Err(e) => return Some(Err(e)),
                        }
                    }
                    Ok(out)
                }
                None => Err(bad(name)),
            }
        }
        "flex" => flex(&p, important),
        "flex-flow" => flex_flow(&p, important),
        "background" => background(value, important),
        "font" => font(&p, important),
        "list-style" => Ok(vec![PropertyDeclaration {
            property: PropertyId::ListStyleType,
            value: CssValue::CustomValue(list_style_type(value)),
            important,
        }]),
        _ => return None,
    })
}

/// The `list-style-type` a `list-style` shorthand sets: `none`, a named type, or the
/// initial `disc` when it names none (`inside` and `outside` are the position).
fn list_style_type(value: &[ComponentValue<'_>]) -> String {
    let idents: Vec<String> = value
        .iter()
        .filter_map(try_ident)
        .map(|i| i.to_ascii_lowercase())
        .collect();
    if idents.iter().any(|i| i == "none") {
        return "none".to_string();
    }
    idents
        .into_iter()
        .find(|i| i != "inside" && i != "outside")
        .unwrap_or_else(|| "disc".to_string())
}

/// A one- or two-value shorthand: the second value defaults to the first.
fn pair(p: &[&ComponentValue<'_>], names: [&str; 2], important: bool, what: &str) -> Parsed {
    let (a, b) = match p.len() {
        1 => (p[0], p[0]),
        2 => (p[0], p[1]),
        _ => return Err(bad(what)),
    };
    let mut out = longhand(names[0], std::slice::from_ref(a), important)?;
    out.extend(longhand(names[1], std::slice::from_ref(b), important)?);
    Ok(out)
}

/// `columns: [ <width> || <count> ]`: a number is the count, anything else the width.
fn columns(p: &[&ComponentValue<'_>], important: bool) -> Parsed {
    if p.is_empty() || p.len() > 2 {
        return Err(bad("columns"));
    }
    let (mut width, mut count) = (None, None);
    for v in p {
        let is_count =
            matches!(v, ComponentValue::Token(t) if matches!(t.kind, TokenKind::Number { .. }));
        if is_count {
            count = Some(*v);
        } else if width.is_none() && try_ident(v).is_none_or(|w| !w.eq_ignore_ascii_case("auto")) {
            width = Some(*v);
        }
    }
    let mut out = Vec::new();
    for (name, v) in [("column-width", width), ("column-count", count)] {
        match v {
            Some(v) => out.extend(longhand(name, std::slice::from_ref(v), important)?),
            None => out.push(decl(
                name,
                CssValue::CustomValue("auto".to_string()),
                important,
            )),
        }
    }
    Ok(out)
}

/// `flex: none | auto | initial | [ <grow> <shrink>? || <basis> ]`.
fn flex(p: &[&ComponentValue<'_>], important: bool) -> Parsed {
    let number = |n: f64| CssValue::Number(n);
    let basis_auto = CssValue::LengthPercentageAuto(LengthPercentageAuto::Auto);
    if p.len() == 1 {
        if let Some(word) = try_ident(p[0]) {
            let (g, s, b) = match word.to_ascii_lowercase().as_str() {
                "none" => (0.0, 0.0, basis_auto),
                "auto" => (1.0, 1.0, basis_auto),
                "initial" => (0.0, 1.0, basis_auto),
                _ => return Err(bad("flex")),
            };
            return Ok(vec![
                decl("flex-grow", number(g), important),
                decl("flex-shrink", number(s), important),
                decl("flex-basis", b, important),
            ]);
        }
    }
    // Unitless numbers are grow then shrink; the one other part is the basis.
    let mut nums: Vec<f64> = Vec::new();
    let mut basis: Option<&ComponentValue<'_>> = None;
    for part in p {
        match is_number(part) {
            Some(n) if nums.len() < 2 => nums.push(n),
            Some(_) => basis = Some(part),
            None if basis.is_none() => basis = Some(part),
            None => return Err(bad("flex")),
        }
    }
    if nums.is_empty() && basis.is_none() {
        return Err(bad("flex"));
    }
    let grow = nums.first().copied().unwrap_or(1.0);
    let shrink = nums.get(1).copied().unwrap_or(1.0);
    let basis_value = match basis {
        Some(b) => match longhand("flex-basis", std::slice::from_ref(b), important)?.pop() {
            Some(d) => d.value,
            None => return Err(bad("flex")),
        },
        // `flex: 1` is `1 1 0%`: the item starts from nothing and grows.
        None => CssValue::LengthPercentageAuto(LengthPercentageAuto::Percentage(0.0)),
    };
    Ok(vec![
        decl("flex-grow", number(grow), important),
        decl("flex-shrink", number(shrink), important),
        decl("flex-basis", basis_value, important),
    ])
}

fn flex_flow(p: &[&ComponentValue<'_>], important: bool) -> Parsed {
    if p.is_empty() || p.len() > 2 {
        return Err(bad("flex-flow"));
    }
    let mut out = Vec::new();
    for part in p {
        let one = std::slice::from_ref(*part);
        if let Ok(d) = longhand("flex-direction", one, important) {
            out.extend(d);
        } else if let Ok(d) = longhand("flex-wrap", one, important) {
            out.extend(d);
        } else {
            return Err(bad("flex-flow"));
        }
    }
    Ok(out)
}

/// `background`: only the colour is modelled. The colour belongs to the last
/// layer; everything else (images, gradients, position, repeat) is skipped, and
/// the colour resets to `transparent` when the shorthand names none.
fn background(value: &[ComponentValue<'_>], important: bool) -> Parsed {
    let last_layer = value
        .rsplit(|v| {
            matches!(
                v,
                ComponentValue::Token(Token {
                    kind: TokenKind::Comma,
                    ..
                })
            )
        })
        .next()
        .unwrap_or(value);
    let mut color = CssValue::Color(Color::Transparent);
    for part in parts(last_layer) {
        if let Ok(CssValue::Color(c)) = parse_color(std::slice::from_ref(part)) {
            color = CssValue::Color(c);
        }
    }
    Ok(vec![decl("background-color", color, important)])
}

/// `font: [ <style> || <weight> ]? <size> [ / <line-height> ]? <family>#`.
fn font(p: &[&ComponentValue<'_>], important: bool) -> Parsed {
    let mut style = CssValue::FontStyle(crate::css_values::types::font::FontStyle::Normal);
    let mut weight = CssValue::FontWeight(crate::css_values::types::font::FontWeight::Normal);
    let mut i = 0;
    let size = loop {
        let part = *p.get(i).ok_or_else(|| bad("font"))?;
        let one = std::slice::from_ref(part);
        if let Some(word) = try_ident(part) {
            let lower = word.to_ascii_lowercase();
            match lower.as_str() {
                // `normal` and the keywords for properties not modelled.
                "normal" | "small-caps" | "ultra-condensed" | "extra-condensed" | "condensed"
                | "semi-condensed" | "semi-expanded" | "expanded" | "extra-expanded"
                | "ultra-expanded" => {
                    i += 1;
                    continue;
                }
                "italic" | "oblique" => {
                    style = parse_font_style(one)?;
                    i += 1;
                    continue;
                }
                "bold" | "bolder" | "lighter" => {
                    weight = parse_font_weight(one)?;
                    i += 1;
                    continue;
                }
                _ => {}
            }
        }
        // A unitless number ahead of the size is the weight.
        if is_number(part).is_some() {
            weight = parse_font_weight(one)?;
            i += 1;
            continue;
        }
        break parse_font_size(one)?;
    };
    i += 1;
    let mut line_height = CssValue::LineHeight(crate::css_values::property::LineHeight::Normal);
    if p.get(i).is_some_and(|v| is_delim(v, '/')) {
        let lh = *p.get(i + 1).ok_or_else(|| bad("font"))?;
        line_height = parse_line_height(std::slice::from_ref(lh))?;
        i += 2;
    }
    if i >= p.len() {
        return Err(bad("font: missing family"));
    }
    // The family list keeps its commas, so hand it the rest of the tokens.
    let rest: Vec<ComponentValue<'_>> = p[i..].iter().map(|v| (*v).clone()).collect();
    let family = parse_font_family(&rest)?;
    Ok(vec![
        decl("font-style", style, important),
        decl("font-weight", weight, important),
        decl("font-size", size, important),
        decl("line-height", line_height, important),
        decl("font-family", family, important),
    ])
}

/// The colour part of a `border`/`border-<side>` shorthand, as a declaration per
/// side. `currentcolor` when the shorthand names none, as the spec resets it.
pub(crate) fn border_colors(
    colour: Option<CssValue>,
    sides: &[&str],
    important: bool,
) -> Vec<PropertyDeclaration> {
    let value = colour.unwrap_or(CssValue::Color(Color::CurrentColor));
    sides
        .iter()
        .map(|side| decl(&format!("border-{side}-color"), value.clone(), important))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::css_values::types::font::FontWeight;
    use crate::css_values::types::length::{Length, LengthPercentage};

    fn parse(css: &str) -> Vec<PropertyDeclaration> {
        let (decls, _) = crate::css_parser::parse_declaration_list(css);
        let mut out = Vec::new();
        for d in &decls {
            out.extend(parse_property(d.name, &d.value, d.important).expect("parses"));
        }
        out
    }

    fn get<'a>(decls: &'a [PropertyDeclaration], name: &str) -> &'a CssValue {
        let id = PropertyId::from_name(name);
        &decls
            .iter()
            .rev()
            .find(|d| d.property == id)
            .unwrap_or_else(|| panic!("no {name} in {decls:?}"))
            .value
    }

    fn px(v: f64) -> CssValue {
        CssValue::LengthPercentage(LengthPercentage::Length(Length::Px(v)))
    }

    #[test]
    fn gap_sets_row_and_column() {
        let d = parse("gap: 8px");
        assert_eq!(get(&d, "row-gap"), &px(8.0));
        assert_eq!(get(&d, "column-gap"), &px(8.0));
        let d = parse("gap: 4px 10px");
        assert_eq!(get(&d, "row-gap"), &px(4.0));
        assert_eq!(get(&d, "column-gap"), &px(10.0));
    }

    #[test]
    fn flex_shorthand_forms() {
        let zero_pct = CssValue::LengthPercentageAuto(LengthPercentageAuto::Percentage(0.0));
        let d = parse("flex: 1");
        assert_eq!(get(&d, "flex-grow"), &CssValue::Number(1.0));
        assert_eq!(get(&d, "flex-shrink"), &CssValue::Number(1.0));
        assert_eq!(get(&d, "flex-basis"), &zero_pct);

        let d = parse("flex: none");
        assert_eq!(get(&d, "flex-grow"), &CssValue::Number(0.0));
        assert_eq!(get(&d, "flex-shrink"), &CssValue::Number(0.0));

        let d = parse("flex: 2 3 100px");
        assert_eq!(get(&d, "flex-grow"), &CssValue::Number(2.0));
        assert_eq!(get(&d, "flex-shrink"), &CssValue::Number(3.0));
        assert_eq!(
            get(&d, "flex-basis"),
            &CssValue::LengthPercentageAuto(LengthPercentageAuto::Length(Length::Px(100.0)))
        );

        let d = parse("flex: 0 0 auto");
        assert_eq!(get(&d, "flex-grow"), &CssValue::Number(0.0));
    }

    #[test]
    fn background_keeps_only_the_colour() {
        let red = CssValue::Color(Color::Rgba {
            r: 255,
            g: 0,
            b: 0,
            a: 1.0,
        });
        assert_eq!(
            get(
                &parse("background: red url(a.png) no-repeat"),
                "background-color"
            ),
            &red
        );
        assert_eq!(
            get(&parse("background: url(a.png), red"), "background-color"),
            &red
        );
        assert_eq!(
            get(
                &parse("background: linear-gradient(red, blue)"),
                "background-color"
            ),
            &CssValue::Color(Color::Transparent),
            "a gradient alone leaves the colour transparent"
        );
    }

    #[test]
    fn border_colour_shorthand_and_longhands() {
        let d = parse("border-color: red blue");
        let red = CssValue::Color(Color::Rgba {
            r: 255,
            g: 0,
            b: 0,
            a: 1.0,
        });
        let blue = CssValue::Color(Color::Rgba {
            r: 0,
            g: 0,
            b: 255,
            a: 1.0,
        });
        assert_eq!(get(&d, "border-top-color"), &red);
        assert_eq!(get(&d, "border-bottom-color"), &red);
        assert_eq!(get(&d, "border-left-color"), &blue);
        assert_eq!(get(&d, "border-right-color"), &blue);

        let d = parse("border: 1px solid #ccc");
        let grey = CssValue::Color(Color::Rgba {
            r: 204,
            g: 204,
            b: 204,
            a: 1.0,
        });
        assert_eq!(get(&d, "border-left-color"), &grey);
        assert_eq!(
            get(&d, "border-top-width"),
            &CssValue::Length(Length::Px(1.0))
        );

        let d = parse("border-top: 2px dashed");
        assert_eq!(
            get(&d, "border-top-color"),
            &CssValue::Color(Color::CurrentColor),
            "no colour named means currentcolor"
        );
    }

    #[test]
    fn border_width_and_style_shorthands() {
        let d = parse("border-width: 1px 2px; border-style: solid none");
        assert_eq!(
            get(&d, "border-top-width"),
            &CssValue::Length(Length::Px(1.0))
        );
        assert_eq!(
            get(&d, "border-left-width"),
            &CssValue::Length(Length::Px(2.0))
        );
        assert_eq!(
            get(&d, "border-top-style"),
            &CssValue::BorderStyle(crate::css_values::types::display::BorderStyle::Solid)
        );
        assert_eq!(
            get(&d, "border-right-style"),
            &CssValue::BorderStyle(crate::css_values::types::display::BorderStyle::None)
        );
    }

    #[test]
    fn logical_properties_are_their_physical_twins() {
        let d = parse("margin-inline: auto; padding-block: 4px 8px; inline-size: 10px; inset-inline-start: 3px");
        assert_eq!(
            get(&d, "margin-left"),
            &CssValue::LengthPercentageAuto(LengthPercentageAuto::Auto)
        );
        assert_eq!(get(&d, "padding-top"), &px(4.0));
        assert_eq!(get(&d, "padding-bottom"), &px(8.0));
        assert_eq!(
            get(&d, "width"),
            &CssValue::LengthPercentageAuto(LengthPercentageAuto::Length(Length::Px(10.0)))
        );
        assert_eq!(
            get(&d, "left"),
            &CssValue::LengthPercentageAuto(LengthPercentageAuto::Length(Length::Px(3.0)))
        );
    }

    #[test]
    fn font_shorthand() {
        let d = parse("font: italic bold 14px/1.5 Arial, sans-serif");
        assert_eq!(
            get(&d, "font-weight"),
            &CssValue::FontWeight(FontWeight::Bold)
        );
        assert_eq!(
            get(&d, "font-style"),
            &CssValue::FontStyle(crate::css_values::types::font::FontStyle::Italic)
        );
        assert_eq!(
            get(&d, "font-size"),
            &CssValue::LengthPercentage(LengthPercentage::Length(Length::Px(14.0)))
        );
        let CssValue::FontFamily(f) = get(&d, "font-family") else {
            panic!("family")
        };
        assert_eq!(f.len(), 2);
        assert!(matches!(get(&d, "line-height"), CssValue::LineHeight(_)));

        let d = parse("font: 12px serif");
        assert_eq!(
            get(&d, "font-weight"),
            &CssValue::FontWeight(FontWeight::Normal),
            "the shorthand resets what it does not name"
        );
    }

    #[test]
    fn css_wide_keywords_reach_every_longhand() {
        let d = parse("font: inherit");
        assert_eq!(d.len(), 5);
        assert!(d.iter().all(|x| x.value == CssValue::Inherit));
        let d = parse("margin: unset");
        assert_eq!(d.len(), 4);
    }
}
