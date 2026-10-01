//! `grid-template-columns` / `grid-template-rows`: the track list as text, turned
//! into taffy's tracks. Line names are skipped; `subgrid` and `masonry` are not
//! understood and leave the template empty.

use taffy::prelude::{TaffyAuto, TaffyMaxContent, TaffyMinContent};
use taffy::style_helpers::{fit_content, fr, length, minmax, percent, repeat};
use taffy::{
    GridTemplateComponent, LengthPercentage, MaxTrackSizingFunction, MinTrackSizingFunction,
    RepetitionCount, TrackSizingFunction,
};

use crate::layout::resolve::{resolve_length, ResolveContext};

/// The tracks `text` describes; empty for `none` or anything not understood.
pub fn template(text: &str, ctx: &ResolveContext) -> Vec<GridTemplateComponent<String>> {
    let mut out = Vec::new();
    for tok in split_top_level(text) {
        if tok.starts_with('[') {
            continue;
        }
        if let Some(rest) = function_args(&tok, "repeat") {
            let Some((count, tracks)) = rest.split_once(',') else {
                return Vec::new();
            };
            let count = match count.trim() {
                "auto-fill" => RepetitionCount::AutoFill,
                "auto-fit" => RepetitionCount::AutoFit,
                n => match n.parse::<u16>() {
                    Ok(n) if n > 0 => RepetitionCount::Count(n),
                    _ => return Vec::new(),
                },
            };
            let tracks: Option<Vec<TrackSizingFunction>> = split_top_level(tracks)
                .iter()
                .filter(|t| !t.starts_with('['))
                .map(|t| track(t, ctx))
                .collect();
            match tracks {
                Some(tracks) if !tracks.is_empty() => out.push(repeat(count, tracks)),
                _ => return Vec::new(),
            }
        } else if let Some(t) = track(&tok, ctx) {
            out.push(GridTemplateComponent::Single(t));
        } else {
            return Vec::new();
        }
    }
    out
}

fn track(tok: &str, ctx: &ResolveContext) -> Option<TrackSizingFunction> {
    if let Some(args) = function_args(tok, "minmax") {
        let (min, max) = args.split_once(',')?;
        return Some(minmax(
            min_track(min.trim(), ctx)?,
            max_track(max.trim(), ctx)?,
        ));
    }
    if let Some(arg) = function_args(tok, "fit-content") {
        return Some(fit_content(length_percentage(arg.trim(), ctx)?));
    }
    Some(match tok {
        "auto" => TrackSizingFunction::AUTO,
        "min-content" => TrackSizingFunction::MIN_CONTENT,
        "max-content" => TrackSizingFunction::MAX_CONTENT,
        _ => {
            if let Some(n) = tok.strip_suffix("fr") {
                return Some(fr(n.parse::<f32>().ok()?));
            }
            let p = length_percentage(tok, ctx)?;
            return Some(minmax(
                MinTrackSizingFunction::from(p),
                MaxTrackSizingFunction::from(p),
            ));
        }
    })
}

fn min_track(tok: &str, ctx: &ResolveContext) -> Option<MinTrackSizingFunction> {
    Some(match tok {
        "auto" => MinTrackSizingFunction::AUTO,
        "min-content" => MinTrackSizingFunction::MIN_CONTENT,
        "max-content" => MinTrackSizingFunction::MAX_CONTENT,
        _ => MinTrackSizingFunction::from(length_percentage(tok, ctx)?),
    })
}

fn max_track(tok: &str, ctx: &ResolveContext) -> Option<MaxTrackSizingFunction> {
    Some(match tok {
        "auto" => MaxTrackSizingFunction::AUTO,
        "min-content" => MaxTrackSizingFunction::MIN_CONTENT,
        "max-content" => MaxTrackSizingFunction::MAX_CONTENT,
        _ => match tok.strip_suffix("fr") {
            Some(n) => fr(n.parse::<f32>().ok()?),
            None => MaxTrackSizingFunction::from(length_percentage(tok, ctx)?),
        },
    })
}

fn length_percentage(tok: &str, ctx: &ResolveContext) -> Option<LengthPercentage> {
    if let Some(n) = tok.strip_suffix('%') {
        return Some(percent(n.parse::<f32>().ok()? / 100.0));
    }
    let split = tok
        .find(|c: char| c.is_ascii_alphabetic())
        .unwrap_or(tok.len());
    let (num, unit) = tok.split_at(split);
    let n: f64 = num.parse().ok()?;
    use crate::css_values::types::length::Length;
    let l = match unit {
        "" if n == 0.0 => Length::Zero,
        "px" => Length::Px(n),
        "em" => Length::Em(n),
        "rem" => Length::Rem(n),
        "vw" => Length::Vw(n),
        "vh" => Length::Vh(n),
        "vmin" => Length::Vmin(n),
        "vmax" => Length::Vmax(n),
        "pt" => Length::Pt(n),
        "pc" => Length::Pc(n),
        "cm" => Length::Cm(n),
        "mm" => Length::Mm(n),
        "in" => Length::In(n),
        _ => return None,
    };
    Some(length(resolve_length(&l, ctx)))
}

/// `name(args)` → `args`.
fn function_args<'a>(tok: &'a str, name: &str) -> Option<&'a str> {
    let rest = tok.strip_prefix(name)?.strip_prefix('(')?;
    rest.strip_suffix(')')
}

/// Split on whitespace outside parentheses and brackets.
fn split_top_level(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut depth = 0i32;
    for ch in text.chars() {
        match ch {
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            _ => {}
        }
        if ch.is_whitespace() && depth == 0 {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push(ch);
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    if out == ["none"] {
        out.clear();
    }
    out
}

/// `grid-template-areas`: `"a a" "b c"` → the rectangle each name covers.
pub fn areas(text: &str) -> Vec<taffy::GridTemplateArea<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('"') {
        let Some(len) = rest[open + 1..].find('"') else {
            break;
        };
        rows.push(
            rest[open + 1..open + 1 + len]
                .split_whitespace()
                .map(str::to_string)
                .collect(),
        );
        rest = &rest[open + len + 2..];
    }
    let mut out: Vec<taffy::GridTemplateArea<String>> = Vec::new();
    for (r, row) in rows.iter().enumerate() {
        for (c, name) in row.iter().enumerate() {
            if name.chars().all(|ch| ch == '.') {
                continue;
            }
            let (r, c) = (r as u16, c as u16);
            match out.iter_mut().find(|a| a.name == *name) {
                Some(a) => {
                    a.row_start = a.row_start.min(r + 1);
                    a.row_end = a.row_end.max(r + 2);
                    a.column_start = a.column_start.min(c + 1);
                    a.column_end = a.column_end.max(c + 2);
                }
                None => out.push(taffy::GridTemplateArea {
                    name: name.clone(),
                    row_start: r + 1,
                    row_end: r + 2,
                    column_start: c + 1,
                    column_end: c + 2,
                }),
            }
        }
    }
    out
}

pub fn auto_flow(text: &str) -> taffy::GridAutoFlow {
    let (mut column, mut dense) = (false, false);
    for word in text.split_whitespace() {
        match word {
            "column" => column = true,
            "dense" => dense = true,
            _ => {}
        }
    }
    match (column, dense) {
        (false, false) => taffy::GridAutoFlow::Row,
        (false, true) => taffy::GridAutoFlow::RowDense,
        (true, false) => taffy::GridAutoFlow::Column,
        (true, true) => taffy::GridAutoFlow::ColumnDense,
    }
}

/// `grid-auto-rows` / `-columns`: the sizes of implicit tracks.
pub fn auto_tracks(text: &str, ctx: &ResolveContext) -> Vec<TrackSizingFunction> {
    split_top_level(text)
        .iter()
        .map(|t| track(t, ctx))
        .collect::<Option<Vec<_>>>()
        .unwrap_or_default()
}

#[derive(Clone, Copy, PartialEq)]
enum Edge {
    Start,
    End,
}

/// One side of a placement: `auto`, a line number, `span n`, or an area name.
fn line_placement(text: &str, edge: Edge) -> taffy::GridPlacement<String> {
    use taffy::GridPlacement;
    let text = text.trim();
    if text.is_empty() || text == "auto" {
        return GridPlacement::Auto;
    }
    if let Some(rest) = text.strip_prefix("span") {
        return match rest.trim().parse::<u16>() {
            Ok(n) if n > 0 => taffy::style_helpers::span(n),
            _ => GridPlacement::Auto,
        };
    }
    if let Ok(n) = text.parse::<i16>() {
        return if n == 0 {
            GridPlacement::Auto
        } else {
            taffy::style_helpers::line(n)
        };
    }
    let suffix = if edge == Edge::Start { "start" } else { "end" };
    GridPlacement::NamedLine(format!("{text}-{suffix}"), 1)
}

/// `grid-row` / `grid-column`: `start / end`, or one value.
pub fn placement(text: &str) -> taffy::Line<taffy::GridPlacement<String>> {
    use taffy::GridPlacement;
    let mut parts = text.splitn(2, '/');
    let start = parts.next().unwrap_or("").trim();
    match parts.next() {
        Some(end) => taffy::Line {
            start: line_placement(start, Edge::Start),
            end: line_placement(end, Edge::End),
        },
        // A single name stands for the whole area; a number or span for its start.
        None => taffy::Line {
            start: line_placement(start, Edge::Start),
            end: if start.parse::<i16>().is_ok() || start.starts_with("span") || start == "auto" {
                GridPlacement::Auto
            } else {
                line_placement(start, Edge::End)
            },
        },
    }
}

/// `grid-area`: one name, or `row-start / column-start / row-end / column-end`.
pub fn area(
    text: &str,
) -> (
    taffy::Line<taffy::GridPlacement<String>>,
    taffy::Line<taffy::GridPlacement<String>>,
) {
    use taffy::GridPlacement;
    let parts: Vec<&str> = text.split('/').map(str::trim).collect();
    if parts.len() == 1 {
        let one = placement(parts[0]);
        return (one.clone(), one);
    }
    let get = |i: usize, edge| {
        parts
            .get(i)
            .map_or(GridPlacement::Auto, |p| line_placement(p, edge))
    };
    (
        taffy::Line {
            start: get(0, Edge::Start),
            end: get(2, Edge::End),
        },
        taffy::Line {
            start: get(1, Edge::Start),
            end: get(3, Edge::End),
        },
    )
}

/// One side of a placement given on its own (`grid-row-start`, …).
pub fn side(text: &str, end: bool) -> taffy::GridPlacement<String> {
    line_placement(text, if end { Edge::End } else { Edge::Start })
}
