//! Per-character font fallback, for drawing.
//!
//! A run is set in the font the page asked for; a character that font has no
//! glyph for is taken from the first face of the fallback list that has one, the
//! way a browser falls back glyph by glyph. The list is whatever the embedding
//! application registered with [`register_fallback_face`], then the bundled faces
//! that cover other scripts.
//!
//! Only painting uses this. Canvas text keeps its single-face behaviour, and
//! none of these faces is in the font database: page script cannot see them
//! through `document.fonts`, `FontFace.load` or `measureText`.

use std::sync::RwLock;

use crate::text::{FontDatabase, ParsedFont};
use rustybuzz::Face;

use crate::text::shaper;

const NOTO_SANS_THAI: &[u8] = include_bytes!("fonts/NotoSansThai.ttf");
const NOTO_SANS_DEVANAGARI: &[u8] = include_bytes!("fonts/NotoSansDevanagari.ttf");

/// Faces of the font database tried first: they cover Latin Extended, Cyrillic,
/// Greek, Arabic, Hebrew, Armenian, Georgian and many symbols.
const DATABASE_FALLBACK: [&str; 2] = ["Noto Sans", "DejaVu Sans"];

static REGISTERED: RwLock<Vec<FaceRef>> = RwLock::new(Vec::new());

/// A font face: its file's bytes and the index within a collection.
#[derive(Clone, Copy)]
pub struct FaceRef {
    pub data: &'static [u8],
    pub index: u32,
}

/// A stretch of text and the face it is set in.
pub struct Segment<'a> {
    pub text: &'a str,
    /// `None`: the font the page asked for.
    pub face: Option<FaceRef>,
    /// False when no face has a glyph for these characters: they are drawn as the
    /// requested font's missing-glyph box.
    pub covered: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pick {
    Primary,
    Fallback(usize),
    Missing,
}

/// Add a face to the end of the fallback list. The bytes live for the rest of the
/// process. Returns false, registering nothing, if they are not a font.
///
/// This is how an application that wants to draw scripts the bundled faces do not
/// cover (CJK, colour emoji) supplies its own: the engine never reads font files
/// itself.
pub fn register_fallback_face(data: Vec<u8>, index: u32) -> bool {
    let data: &'static [u8] = Box::leak(data.into_boxed_slice());
    if shaper::face(data, index).is_none() {
        return false;
    }
    if let Ok(mut faces) = REGISTERED.write() {
        faces.push(FaceRef { data, index });
        return true;
    }
    false
}

fn load_fallbacks(
    font: &ParsedFont,
    os_name: &str,
    registered: bool,
) -> Vec<(FaceRef, &'static Face<'static>)> {
    let db = FontDatabase::get();
    let mut refs: Vec<FaceRef> = if registered {
        REGISTERED
            .read()
            .map(|faces| faces.clone())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    refs.extend(DATABASE_FALLBACK.iter().filter_map(|name| {
        let id = db.query(name, font.weight, font.italic, os_name)?;
        let (data, index) = db.face_data(id)?;
        Some(FaceRef { data, index })
    }));
    refs.extend([NOTO_SANS_THAI, NOTO_SANS_DEVANAGARI].map(|data| FaceRef { data, index: 0 }));
    refs.into_iter()
        .filter_map(|r| Some((r, shaper::face(r.data, r.index)?)))
        .collect()
}

/// Split `text` into stretches that each have one face for all their characters.
/// Whitespace, punctuation and combining marks stay with the stretch they are in.
pub fn segments<'a>(text: &'a str, font: &ParsedFont, os_name: &str) -> Vec<Segment<'a>> {
    split(text, font, os_name, true)
}

/// [`segments`] with the bundled faces only, for measuring: what the application
/// registered is for drawing, and must not change a page's geometry.
pub fn hermetic_segments<'a>(text: &'a str, font: &ParsedFont, os_name: &str) -> Vec<Segment<'a>> {
    split(text, font, os_name, false)
}

fn split<'a>(
    text: &'a str,
    font: &ParsedFont,
    os_name: &str,
    registered: bool,
) -> Vec<Segment<'a>> {
    let db = FontDatabase::get();
    let primary = db
        .query_chain(&font.families, font.weight, font.italic, os_name)
        .and_then(|id| db.face_data(id))
        .and_then(|(data, index)| shaper::face(data, index));
    let mut fallbacks: Option<Vec<(FaceRef, &'static Face<'static>)>> = None;

    let mut out: Vec<Segment<'a>> = Vec::new();
    let mut current = Pick::Primary;
    let mut start = 0;
    let segment =
        |fb: &Option<Vec<(FaceRef, &'static Face<'static>)>>, text: &'a str, pick: Pick| {
            let face = match pick {
                Pick::Fallback(k) => fb.as_ref().and_then(|v| v.get(k)).map(|(r, _)| *r),
                _ => None,
            };
            Segment {
                text,
                face,
                covered: pick != Pick::Missing,
            }
        };
    for (i, ch) in text.char_indices() {
        if ch.is_whitespace() || ch.is_ascii_punctuation() || is_combining(ch) {
            continue;
        }
        let in_primary = primary
            .as_ref()
            .is_some_and(|f| f.glyph_index(ch).is_some());
        let pick = if in_primary {
            Pick::Primary
        } else {
            fallbacks
                .get_or_insert_with(|| load_fallbacks(font, os_name, registered))
                .iter()
                .position(|(_, f)| f.glyph_index(ch).is_some())
                .map_or(Pick::Missing, Pick::Fallback)
        };
        if pick != current {
            if i > start {
                out.push(segment(&fallbacks, &text[start..i], current));
            }
            start = i;
            current = pick;
        }
    }
    if start < text.len() {
        out.push(segment(&fallbacks, &text[start..], current));
    }
    out
}

fn is_combining(ch: char) -> bool {
    matches!(
        ch as u32,
        0x0300..=0x036F | 0x0610..=0x061A | 0x064B..=0x065F | 0x200C | 0x200D | 0xFE00..=0xFE0F
    )
}
