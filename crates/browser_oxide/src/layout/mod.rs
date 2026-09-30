//! Layout engine for browser_oxide.
//!
//! Uses taffy for CSS Block, Flexbox, and Grid layout computation.
//! Provides getBoundingClientRect(), offsetWidth, getComputedStyle, etc.

pub mod engine;
pub(crate) mod full;
pub mod layout_unit;
#[cfg(feature = "paint")]
pub mod paint_tree;
pub mod query;
pub mod resolve;
pub mod style_map;
pub mod viewport;

use std::sync::atomic::{AtomicU8, Ordering};

pub use engine::LayoutEngine;
pub use layout_unit::LayoutUnit;
#[cfg(feature = "paint")]
pub use paint_tree::{PaintBox, PaintStyle};
pub use query::DOMRect;
pub use viewport::Viewport;

/// Which layout a page gets.
///
/// `Legacy` is the approximate layout the engine has always had: it keeps
/// `getBoundingClientRect` and friends exactly as headless users see them today.
/// `Full` is the layout being built toward Chrome's (`docs/GUI_PLAN.md`, stage 3);
/// it changes geometry, so nothing that shares a fingerprint with `Legacy` may
/// pick it by default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LayoutMode {
    #[default]
    Legacy,
    Full,
}

static DEFAULT_MODE: AtomicU8 = AtomicU8::new(0);

/// The mode every new layout engine starts in. A window or a screenshot tool
/// sets it once at startup, before any page exists, so pages and their frames
/// are laid out the same way from the first script onward.
pub fn set_default_mode(mode: LayoutMode) {
    DEFAULT_MODE.store(mode as u8, Ordering::Relaxed);
}

pub fn default_mode() -> LayoutMode {
    match DEFAULT_MODE.load(Ordering::Relaxed) {
        1 => LayoutMode::Full,
        _ => LayoutMode::Legacy,
    }
}
