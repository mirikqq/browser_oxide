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
