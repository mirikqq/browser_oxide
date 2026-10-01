//! One style engine for the document.
//!
//! Layout used to cascade on its own — no inheritance, a fixed 16px font size,
//! `!important` and `@layer` ignored — while `getComputedStyle` did it again a
//! different way. Both now read from here: a [`Stylist`] decides which
//! declarations win, and a [`StyleTree`] turns the winners into computed styles
//! with inheritance, the way a browser's style pass does.

pub mod custom;
pub(crate) mod hints;
pub mod stylist;
pub mod tree;

pub use stylist::{parse_inline_style, Pseudo, RawDecl, Rule, Stylist};
pub use tree::StyleTree;
