//! Real font stack: the shared text pipeline for canvas and layout.
//!
//! Pipeline: [`font_shorthand`] parses `font` strings, [`FontDatabase`]
//! resolves families to concrete faces via the bundled font set, [`shaper`]
//! produces positioned glyph runs via rustybuzz, and [`raster`] rasterizes
//! individual glyphs via swash. `canvas::text` builds Canvas 2D's metrics and
//! drawing on top of it.

pub mod fallback;
pub mod font_database;
pub mod font_shorthand;
pub mod metrics_table;
pub mod raster;
pub mod shaper;

pub use font_database::FontDatabase;
pub use font_shorthand::ParsedFont;
pub use raster::GlyphBitmap;
pub use shaper::ShapedRun;

/// Resolve a parsed font to concrete face data. Walks the family
/// fallback chain and returns both the raw face bytes and the face
/// index (for TTC collections).
///
/// Always a bundled face. Reading the host's real font files would make the
/// rendered outlines match a real Chrome *on this machine* — but it also ties
/// the fingerprint to whatever the host happens to have installed, which the
/// generated profile is supposed to decide. Widths come from
/// `metrics_table` instead, so they follow the profile rather than the host.
pub fn resolve_face(font: &ParsedFont, os_name: &str) -> Option<(&'static [u8], u32)> {
    let db = FontDatabase::get();
    let id = db.query_chain(&font.families, font.weight, font.italic, os_name)?;
    db.face_data(id)
}

/// Whether `family` is a genuinely available font — a real host face
/// (`system_fonts`) or one of the bundled faces by its own name — as
/// opposed to `resolve_face`'s fallback chain, which always finds
/// *something* to render with. Backs `FontFace.load()`'s `local()`
/// source check: real browsers reject loading an uninstalled local
/// font, so a stub that resolves unconditionally is itself a
/// distinguishing tell (every probed name comes back "installed").
pub fn family_available(family: &str, weight: u16, italic: bool, os_name: &str) -> bool {
    metrics_table::is_claimed(family, os_name)
        || FontDatabase::get().has_bundled_family(family, weight, italic)
}

/// Re-advance a shaped run from `metrics_table`, so measured widths are the
/// ones a real Chrome reports for the claimed family rather than the bundled
/// substitute's. The substitute still draws the glyphs; only advances move.
///
/// ponytail: `bbox_right` is scaled by the width ratio rather than re-derived
/// per glyph — the per-glyph em boxes are gone by this point, and
/// `actualBoundingBoxRight` tracks the width closely for Latin text. Recompute
/// it properly if a probe ever reads it against a reference table.
pub fn apply_family_metrics(
    run: &mut shaper::ShapedRun,
    text: &str,
    font: &ParsedFont,
    os_name: &str,
) {
    let Some(m) = metrics_table::lookup(&font.families, os_name) else {
        return;
    };
    let bytes = text.as_bytes();
    let mut total = 0.0_f32;
    for glyph in &mut run.glyphs {
        if let Some(px) = bytes
            .get(glyph.cluster as usize)
            .and_then(|b| metrics_table::advance_px(m, *b, font.size_px))
        {
            glyph.x_advance = px;
        }
        total += glyph.x_advance;
    }
    if run.width > 0.0 && total > 0.0 {
        run.bbox_right *= total / run.width;
    }
    run.width = total;
}

/// Resolve the font face + shape `text` via rustybuzz, returning the
/// face bytes, TTC index, and the shaped run. Lets the canvas draw
/// glyphs through Skia's own rasterizer (Chrome-parity by
/// construction — Chrome's 2D-canvas text IS Skia) while keeping our
/// rustybuzz shaping so `measureText` stays consistent.
pub fn shape_run(
    text: &str,
    font: &ParsedFont,
    os_name: &str,
) -> Option<(&'static [u8], u32, shaper::ShapedRun)> {
    if text.is_empty() {
        return None;
    }
    let (data, idx) = resolve_face(font, os_name)?;
    let mut run = shaper::shape(text, data, idx, font.size_px);
    apply_family_metrics(&mut run, text, font, os_name);
    Some((data, idx, run))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn family_available_rejects_unknown_name() {
        // The bug this backs: a stub that always resolves a `local()`
        // FontFace source makes every probed name "installed", including
        // gibberish — the presence check must genuinely distinguish.
        assert!(!family_available("NonExistentXYZ123", 400, false, "Linux"));
        assert!(!family_available("NonExistentXYZ123", 400, false, "macOS"));
    }

    #[test]
    fn family_available_accepts_bundled_name() {
        assert!(family_available("Liberation Sans", 400, false, "Linux"));
    }

    #[test]
    fn family_available_does_not_count_alias_substitution() {
        // "Segoe UI" renders via a Liberation Sans substitute on a macOS
        // profile (resolve_face/query_chain) — but it isn't genuinely
        // installed there, so presence-checking it must say `false`,
        // unlike the rendering path which happily substitutes.
        assert!(resolve_face(&ParsedFont::parse("16px \"Segoe UI\"").unwrap(), "macOS").is_some());
        assert!(!family_available("Segoe UI", 400, false, "macOS"));
    }
}
