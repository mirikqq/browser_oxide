//! The vertical metrics of the fonts Chrome on macOS falls back to for characters its primary
//! font lacks. With `line-height: normal` a line is as tall as the fonts it used, so a line with
//! Japanese or Thai text in it is taller than one without. Which font Chrome takes depends on
//! the primary font, the character and the language; `data.rs` is generated from what Chrome
//! reports (`tests/layout_corpus/fonts/`).

mod data;

use data::{BLOCKS, CHOICE, FONTS, NONE};

/// The primary fonts Chrome picks fallbacks differently for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Primary {
    Arial,
    Sans,
    Serif,
    Mono,
    System,
}

/// The languages Chrome picks a different CJK font for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lang {
    #[default]
    None,
    Ja,
    Ko,
    ZhCn,
    ZhTw,
}

enum Font {
    Ratio(f32, f32, f32),
    Union(f32, f32),
    Table(usize),
    Named(&'static str),
}

static TABLE: &[u8] = include_bytes!("table.bin");
const STEPS: usize = 1681;

impl Primary {
    /// The class of the first of `families` this profile knows, else the default font's.
    pub fn of(families: &[String], os_name: &str) -> Option<Self> {
        if os_name != "macOS" {
            return None;
        }
        Some(match super::metrics_table::primary_key(families).as_str() {
            "arial" => Self::Arial,
            "times" | "times new roman" | "georgia" => Self::Serif,
            "menlo" | "monaco" | "courier" | "courier new" => Self::Mono,
            "system-ui" => Self::System,
            _ => Self::Sans,
        })
    }
}

impl Lang {
    /// The class of a BCP 47 language tag.
    pub fn of(tag: &str) -> Self {
        let tag = tag.trim().to_ascii_lowercase();
        let mut parts = tag.split(['-', '_']);
        match parts.next() {
            Some("ja") => Self::Ja,
            Some("ko") => Self::Ko,
            Some("zh") => {
                if parts.any(|p| matches!(p, "hant" | "tw" | "hk" | "mo")) {
                    Self::ZhTw
                } else {
                    Self::ZhCn
                }
            }
            _ => Self::None,
        }
    }
}

/// How far above and below the baseline the fallback fonts of `text` reach in a line of
/// `line-height: normal`, in device px: each font's ascent and descent with its half of the line
/// gap. `None` if no character needs a fallback font.
pub fn extent(text: &str, primary: Primary, lang: Lang, size_px: f32) -> Option<(f32, f32)> {
    let mut best: Option<(f32, f32)> = None;
    for ch in text.chars().filter(|c| !c.is_ascii()) {
        let cp = ch as u32;
        let Some(block) = BLOCKS.iter().position(|&(s, e)| (s..=e).contains(&cp)) else {
            continue;
        };
        let font = CHOICE[primary as usize][block][lang as usize];
        if font == NONE {
            continue;
        }
        let (a, d) = reach(&FONTS[usize::from(font)], size_px);
        best = Some(best.map_or((a, d), |(x, y)| (x.max(a), y.max(d))));
    }
    best
}

fn reach(font: &Font, size_px: f32) -> (f32, f32) {
    let round = |em: f32| (em * size_px).round();
    let (asc, desc, gap) = match font {
        Font::Ratio(a, d, g) => (round(*a), round(*d), round(*g)),
        Font::Union(a, d) => return (round(*a), round(*d)),
        Font::Table(row) => {
            let step = (((size_px - 4.0) * 12.0).round().max(0.0) as usize).min(STEPS - 1);
            let at = (row * STEPS + step) * 3;
            let scale = if size_px > 144.0 {
                size_px / 144.0
            } else {
                1.0
            };
            let v = |i: usize| (f32::from(TABLE[at + i]) * scale).round();
            (v(0), v(1), v(2))
        }
        Font::Named(name) => {
            super::metrics_table::vertical(&[(*name).to_string()], "macOS", size_px)
                .unwrap_or_default()
        }
    };
    let above = (gap / 2.0).floor();
    (asc + above, desc + gap - above)
}
