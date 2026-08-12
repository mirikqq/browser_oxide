//! CSS cascade, specificity, inheritance, @layer, @media evaluation.
//!
//! MIT/Apache-2.0 licensed. Part of the browser_oxide project.

pub mod cascade;
pub mod computed;
pub mod inheritance;
pub mod initial;
pub mod layers;
pub mod media;

pub use cascade::{cascade_sort, CascadeEntry, Origin};
pub use computed::ComputedStyle;
pub use inheritance::is_inherited;
pub use initial::initial_value;
pub use layers::{LayerId, LayerOrder};
pub use media::{evaluate_media_query, MediaFeatures};

/// One parsed author rule, ready to be matched against elements.
///
/// Lives here rather than in `js_runtime` because both the JS-facing
/// `getComputedStyle` op and the layout engine need to cascade the same rules —
/// layout previously resolved every element from an empty declaration map, which
/// is why author CSS reached `getComputedStyle` but never reached geometry.
#[derive(Debug, Clone)]
pub struct StyleRule {
    pub selectors: crate::css_selectors::SelectorList,
    /// Raw `name: value` pairs; expanded into longhands at resolve time by
    /// `css_values::parse_property`.
    pub declarations: std::collections::HashMap<String, String>,
}
