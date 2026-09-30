//! Computed styles for a whole document, with inheritance.
//!
//! The style pass of a browser: walk the tree from the root, cascade each
//! element's declarations, and resolve them against the parent's computed style.
//! What that buys over cascading each element alone is that the inherited
//! properties — `color`, the `font-*` family, `line-height`, `visibility`,
//! `text-align`, `white-space` — reach the descendants, and that `em` and `%`
//! font sizes are computed against the size they inherit.
//!
//! `font-size` is the one property resolved to an absolute length here: it is
//! the base every other relative length is measured from, so it cannot stay
//! relative.

use crate::css_cascade::{CascadeEntry, ComputedStyle, Origin};
use crate::css_selectors::Specificity;
use crate::css_values::property::{CssValue, PropertyDeclaration, PropertyId};
use crate::css_values::types::display::Display;
use crate::css_values::types::length::{Length, LengthPercentage};
use crate::dom::node::{NodeData, NodeId};
use crate::dom::Dom;
use crate::layout::resolve::{resolve_length, ResolveContext};
use crate::style::hints::{presentational_declarations, svg_intrinsic_declarations};
use crate::style::stylist::{entries_for, parse_inline_style, Stylist, HINT_ORDER};

/// `font-size: medium`.
pub const DEFAULT_FONT_SIZE: f32 = 16.0;

/// Computed style of every element that generates a box.
///
/// Elements with `display: none` and everything beneath them have no entry: they
/// generate no box, and nothing in layout or paint reads their style.
pub struct StyleTree {
    styles: Vec<Option<ComputedStyle>>,
    root_font_size: f32,
}

impl StyleTree {
    /// Style `dom`. `viewport` is `(width, height)` in px, for `vw`/`vh` units.
    pub fn compute(dom: &Dom, stylist: &Stylist, viewport: (f32, f32)) -> Self {
        let mut styles: Vec<Option<ComputedStyle>> = vec![None; dom.len()];
        let mut root_font_size = DEFAULT_FONT_SIZE;
        // Pre-order, so a parent is always styled before its children.
        let mut stack = vec![dom.document()];
        while let Some(node) = stack.pop() {
            let Some(n) = dom.get(node) else { continue };
            match &n.data {
                NodeData::Element(elem) => {
                    let parent = n
                        .parent
                        .and_then(|p| styles.get(p.to_raw() as usize))
                        .and_then(|s| s.as_ref());
                    let is_root = n
                        .parent
                        .and_then(|p| dom.get(p))
                        .is_some_and(|p| matches!(p.data, NodeData::Document));

                    let style = compute_element(
                        dom,
                        stylist,
                        node,
                        elem,
                        parent,
                        root_font_size,
                        viewport,
                    );
                    if is_root {
                        root_font_size = font_px(&style).unwrap_or(DEFAULT_FONT_SIZE);
                    }
                    let hidden = matches!(
                        style.get(&PropertyId::Display),
                        Some(CssValue::Display(Display::None))
                    );
                    if hidden {
                        continue;
                    }
                    if let Some(slot) = styles.get_mut(node.to_raw() as usize) {
                        *slot = Some(style);
                    }
                }
                NodeData::Document | NodeData::DocumentFragment => {}
                _ => continue,
            }
            let children = dom.children(node);
            stack.extend(children.into_iter().rev());
        }
        Self {
            styles,
            root_font_size,
        }
    }

    /// The computed style of `node`, if it is an element that generates a box.
    pub fn get(&self, node: NodeId) -> Option<&ComputedStyle> {
        self.styles.get(node.to_raw() as usize)?.as_ref()
    }

    /// Computed `font-size` of `node` in px, or the default for a node with no style.
    pub fn font_size(&self, node: NodeId) -> f32 {
        self.get(node)
            .and_then(font_px)
            .unwrap_or(DEFAULT_FONT_SIZE)
    }

    /// `font-size` of the root element: what `rem` is measured against.
    pub fn root_font_size(&self) -> f32 {
        self.root_font_size
    }
}

/// A computed `font-size`, in px.
fn font_px(style: &ComputedStyle) -> Option<f32> {
    match style.get(&PropertyId::FontSize) {
        Some(CssValue::Length(Length::Px(v))) => Some(*v as f32),
        _ => None,
    }
}

fn compute_element(
    dom: &Dom,
    stylist: &Stylist,
    node: NodeId,
    elem: &crate::dom::node::ElementData,
    parent: Option<&ComputedStyle>,
    root_font_size: f32,
    viewport: (f32, f32),
) -> ComputedStyle {
    // Presentational hints sit above the user-agent sheet and below every
    // author rule; the `style` attribute sits above everything unimportant.
    let mut extra: Vec<CascadeEntry> = Vec::new();
    let as_decls = |map: std::collections::HashMap<PropertyId, CssValue>| {
        map.into_iter()
            .map(|(property, value)| PropertyDeclaration {
                property,
                value,
                important: false,
            })
            .collect::<Vec<_>>()
    };
    extra.extend(entries_for(
        as_decls(svg_intrinsic_declarations(elem)),
        Origin::UserAgent,
        Specificity::default(),
        HINT_ORDER,
    ));
    extra.extend(entries_for(
        as_decls(presentational_declarations(elem)),
        Origin::UserAgent,
        Specificity::default(),
        HINT_ORDER + 1,
    ));
    if let Some(attr) = elem.attrs.iter().find(|a| a.name.local == "style") {
        extra.extend(entries_for(
            parse_inline_style(&attr.value),
            Origin::Author,
            Specificity::new(u32::MAX, 0, 0),
            u32::MAX,
        ));
    }

    let cascaded = stylist.cascade(dom, node, extra);
    let mut style = ComputedStyle::resolve(&cascaded, parent);

    // Font size first: it is the base for every other relative length.
    let parent_px = parent.and_then(font_px).unwrap_or(DEFAULT_FONT_SIZE);
    let ctx = ResolveContext {
        font_size: parent_px,
        root_font_size,
        viewport_w: viewport.0,
        viewport_h: viewport.1,
    };
    let px = match cascaded.get(&PropertyId::FontSize) {
        None | Some(CssValue::Inherit | CssValue::Unset | CssValue::Revert | CssValue::RevertLayer) => {
            parent_px
        }
        Some(CssValue::Initial) => DEFAULT_FONT_SIZE,
        Some(CssValue::Length(l)) => resolve_length(l, &ctx),
        Some(CssValue::LengthPercentage(LengthPercentage::Length(l))) => resolve_length(l, &ctx),
        Some(CssValue::LengthPercentage(LengthPercentage::Percentage(p))) => {
            *p as f32 / 100.0 * parent_px
        }
        Some(_) => parent_px,
    };
    style.set(PropertyId::FontSize, CssValue::Length(Length::Px(px as f64)));
    style
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::css_cascade::MediaFeatures;
    use crate::css_values::types::color::Color;
    use crate::html_parser::parse_html;

    fn tree(html: &str, css: &str) -> (Dom, StyleTree) {
        let dom = parse_html(html);
        let mut s = Stylist::new(MediaFeatures::default());
        s.add_stylesheet(css, Origin::Author);
        let t = StyleTree::compute(&dom, &s, (1000.0, 800.0));
        (dom, t)
    }

    fn id(dom: &Dom, id: &str) -> NodeId {
        dom.get_element_by_id(id).expect("element")
    }

    #[test]
    fn color_and_font_size_inherit() {
        let (dom, t) = tree(
            "<div id=a><p id=b><span id=c>x</span></p></div>",
            "#a{color:rgb(9,8,7);font-size:20px}",
        );
        let c = t.get(id(&dom, "c")).unwrap();
        assert_eq!(
            c.get(&PropertyId::Color),
            Some(&CssValue::Color(Color::Rgba {
                r: 9,
                g: 8,
                b: 7,
                a: 1.0
            }))
        );
        assert_eq!(t.font_size(id(&dom, "c")), 20.0);
    }

    #[test]
    fn em_font_size_compounds_down_the_tree() {
        let (dom, t) = tree(
            "<div id=a><div id=b><div id=c>x</div></div></div>",
            "#a{font-size:10px} #b{font-size:2em} #c{font-size:150%}",
        );
        assert_eq!(t.font_size(id(&dom, "b")), 20.0);
        assert_eq!(t.font_size(id(&dom, "c")), 30.0);
    }

    #[test]
    fn rem_follows_the_root() {
        let (dom, t) = tree(
            "<html><body><p id=a>x</p></body></html>",
            "html{font-size:10px} #a{font-size:3rem}",
        );
        assert_eq!(t.root_font_size(), 10.0);
        assert_eq!(t.font_size(id(&dom, "a")), 30.0);
    }

    #[test]
    fn ua_sheet_sizes_headings_and_pads_paragraphs() {
        let (dom, t) = tree("<h1 id=a>x</h1><p id=b>y</p>", "");
        assert_eq!(t.font_size(id(&dom, "a")), 32.0);
        assert_eq!(
            t.get(id(&dom, "b")).unwrap().get(&PropertyId::Display),
            Some(&CssValue::Display(Display::Block))
        );
    }

    #[test]
    fn display_none_subtree_has_no_style() {
        let (dom, t) = tree(
            "<div id=a><span id=b>x</span></div><div id=c></div>",
            "#a{display:none}",
        );
        assert!(t.get(id(&dom, "a")).is_none());
        assert!(t.get(id(&dom, "b")).is_none());
        assert!(t.get(id(&dom, "c")).is_some());
    }

    #[test]
    fn inline_style_beats_author_rules_but_not_important() {
        let (dom, t) = tree(
            "<p id=a style='width:10px'>x</p><p id=b style='width:10px'>y</p>",
            "p{width:99px} #b{width:50px !important}",
        );
        let w = |n: &str| {
            t.get(id(&dom, n))
                .unwrap()
                .get(&PropertyId::Width)
                .cloned()
        };
        use crate::css_values::types::length::LengthPercentageAuto as Lpa;
        assert_eq!(
            w("a"),
            Some(CssValue::LengthPercentageAuto(Lpa::Length(Length::Px(10.0))))
        );
        assert_eq!(
            w("b"),
            Some(CssValue::LengthPercentageAuto(Lpa::Length(Length::Px(50.0))))
        );
    }
}
