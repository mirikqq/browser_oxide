//! `LayoutMode::Full`: the layout being built toward Chrome's.
//!
//! It starts from what the legacy layout does and replaces its approximations
//! one at a time, each checked against the corpus in `tests/layout_corpus`. The
//! legacy builder in `engine.rs` stays untouched until this one can replace it.

use std::collections::HashMap;

use taffy::{AvailableSpace, Dimension, LengthPercentage, LengthPercentageAuto, Size};

use crate::css_cascade::ComputedStyle;
use crate::css_values::property::{CssValue, PropertyId};
use crate::css_values::types::length::{
    CalcContext, CalcExpr, Length as CssLength, LengthPercentage as CssLp,
    LengthPercentageAuto as CssLpa,
};
use crate::dom::node::NodeId as DomId;
use crate::dom::Dom;
use crate::layout::resolve::ResolveContext;
use crate::layout::viewport::Viewport;
use crate::style::StyleTree;

mod build;
pub(crate) mod font;
mod grid;
pub mod ifc;
mod table;
pub mod tree;

use build::Builder;
use tree::Tree;

pub struct FullLayout {
    pub tree: Tree,
    pub dom_to_node: HashMap<u32, usize>,
    pub root: Option<usize>,
    block_in_inline: HashMap<u32, Vec<usize>>,
    /// Fragments of inline elements and text nodes, by DOM id: the owning node
    /// and the fragment's index in it.
    inline: HashMap<u32, Vec<(usize, usize)>>,
}

impl FullLayout {
    /// Lay `dom` out for `viewport`. `os` is the platform the profile claims, which
    /// decides the fonts text is measured in; `on_style` sees every element that
    /// has a style.
    pub fn compute(
        dom: &Dom,
        styles: &StyleTree,
        viewport: Viewport,
        os: &str,
        mut on_style: impl FnMut(DomId, &ComputedStyle),
    ) -> Self {
        let ctx = ResolveContext {
            font_size: crate::style::tree::DEFAULT_FONT_SIZE,
            root_font_size: styles.root_font_size(),
            viewport_w: viewport.width,
            viewport_h: viewport.height,
        };
        let mut b = Builder::new(dom, styles, &ctx, os);
        b.build(&mut on_style);
        let root = b.dom_to_node.get(&DomId::DOCUMENT.to_raw()).copied();
        let vertical_percent = std::mem::take(&mut b.vertical_percent);
        let block_in_inline = std::mem::take(&mut b.block_in_inline);
        let mut layout = Self {
            tree: b.tree,
            dom_to_node: b.dom_to_node,
            root,
            block_in_inline,
            inline: HashMap::new(),
        };
        if let Some(root) = layout.root {
            let available = Size {
                width: AvailableSpace::Definite(viewport.width),
                height: AvailableSpace::Definite(viewport.height),
            };
            layout.tree.compute(root, available);
            if !vertical_percent.is_empty() {
                // taffy resolves these against the parent's height; CSS says width.
                layout.tree.resolve_vertical_percent(&vertical_percent);
                layout.tree.compute(root, available);
            }
        }
        for (n, node) in layout.tree.nodes.iter().enumerate() {
            for (f, frag) in node.frags.iter().enumerate() {
                layout.inline.entry(frag.dom).or_default().push((n, f));
            }
        }
        layout
    }

    /// `(x, y)` of a node's border box in document coordinates.
    pub fn absolute_position(&self, node: usize) -> (f32, f32) {
        let (mut x, mut y) = (0.0, 0.0);
        let mut current = Some(node);
        while let Some(n) = current {
            x += self.tree.nodes[n].layout.location.x;
            y += self.tree.nodes[n].layout.location.y;
            current = self.tree.nodes[n].parent;
        }
        (x, y)
    }

    /// The boxes an inline element (or a text node) occupies, one per line, in
    /// document coordinates. Empty for anything that has a box of its own.
    pub fn inline_rects(&self, dom_id: u32) -> Vec<[f32; 4]> {
        let mut out = Vec::new();
        self.push_inline_rects(dom_id, &mut out);
        out.extend(self.block_rects(dom_id));
        out
    }

    /// What Chrome reports of the blocks inside an inline element: for each, the
    /// width of the container and the height of the block.
    fn block_rects(&self, dom_id: u32) -> Vec<[f32; 4]> {
        let Some(blocks) = self.block_in_inline.get(&dom_id) else {
            return Vec::new();
        };
        blocks
            .iter()
            .filter_map(|&n| {
                let parent = &self.tree.nodes[self.tree.nodes[n].parent?];
                let (px, _) = self.absolute_position(self.tree.nodes[n].parent?);
                let (_, y) = self.absolute_position(n);
                let l = &parent.layout;
                let left = l.padding.left + l.border.left;
                let width = l.size.width - left - l.padding.right - l.border.right;
                Some([
                    px + left,
                    y,
                    width.max(0.0),
                    self.tree.nodes[n].layout.size.height,
                ])
            })
            .collect()
    }

    fn push_inline_rects(&self, dom_id: u32, out: &mut Vec<[f32; 4]>) {
        let Some(frags) = self.inline.get(&dom_id) else {
            return;
        };
        out.extend(frags.iter().filter_map(|&(n, f)| {
            let frag = &self.tree.nodes[n].frags[f];
            let (x, y) = self.absolute_position(n);
            (frag.kind == ifc::FragKind::Box || self.is_text(dom_id)).then(|| {
                [
                    x + frag.rect[0],
                    y + frag.rect[1],
                    frag.rect[2],
                    frag.rect[3],
                ]
            })
        }));
    }

    /// What `getClientRects` reports for an inline element: one rectangle per line
    /// for an element with box decorations, otherwise one per text fragment of its
    /// content (an element without decorations has no box of its own).
    pub fn client_rects(&self, dom: &Dom, id: DomId) -> Vec<[f32; 4]> {
        let mut out = Vec::new();
        self.collect_client_rects(dom, id, &mut out);
        out
    }

    fn collect_client_rects(&self, dom: &Dom, id: DomId, out: &mut Vec<[f32; 4]>) {
        let frags = self.inline.get(&id.to_raw());
        let own: Vec<&ifc::Frag> = frags
            .into_iter()
            .flatten()
            .map(|&(n, f)| &self.tree.nodes[n].frags[f])
            .collect();
        let abs = |&(n, f): &(usize, usize)| {
            let frag = &self.tree.nodes[n].frags[f];
            let (x, y) = self.absolute_position(n);
            [
                x + frag.rect[0],
                y + frag.rect[1],
                frag.rect[2],
                frag.rect[3],
            ]
        };
        if own.iter().any(|f| f.kind == ifc::FragKind::Text) {
            // A text node: its line fragments.
            out.extend(frags.into_iter().flatten().map(abs));
            return;
        }
        if own.iter().any(|f| f.decorated) {
            out.extend(frags.into_iter().flatten().map(abs));
            out.extend(self.block_rects(id.to_raw()));
            return;
        }
        for child in dom.children(id) {
            self.collect_client_rects(dom, child, out);
        }
        out.extend(self.block_rects(id.to_raw()));
    }

    fn is_text(&self, dom_id: u32) -> bool {
        self.inline.get(&dom_id).is_some_and(|v| {
            v.iter()
                .any(|&(n, f)| self.tree.nodes[n].frags[f].kind == ifc::FragKind::Text)
                && v.iter()
                    .all(|&(n, f)| self.tree.nodes[n].frags[f].kind == ifc::FragKind::Text)
        })
    }
}

/// The `calc()` expression a computed value holds, if it is one.
fn calc_of(v: &CssValue) -> Option<&CalcExpr> {
    match v {
        CssValue::LengthPercentageAuto(CssLpa::Calc(e))
        | CssValue::LengthPercentage(CssLp::Calc(e))
        | CssValue::Length(CssLength::Calc(e))
        | CssValue::LengthPercentageAuto(CssLpa::Length(CssLength::Calc(e)))
        | CssValue::LengthPercentage(CssLp::Length(CssLength::Calc(e))) => Some(e),
        _ => None,
    }
}

/// The legacy mapping turns `calc()` into `auto` or zero; put the expressions
/// back, for taffy to resolve against the box they belong to.
fn apply_calc(tree: &mut Tree, computed: &ComputedStyle, ts: &mut taffy::Style, cc: CalcContext) {
    let mut handle = |p: PropertyId| computed.get(&p).and_then(calc_of).map(|e| tree.calc(e, cc));
    macro_rules! set {
        ($field:expr, $prop:expr, $ty:ty) => {
            if let Some(ptr) = handle($prop) {
                $field = <$ty>::calc(ptr);
            }
        };
    }
    set!(ts.size.width, PropertyId::Width, Dimension);
    set!(ts.size.height, PropertyId::Height, Dimension);
    set!(ts.min_size.width, PropertyId::MinWidth, Dimension);
    set!(ts.min_size.height, PropertyId::MinHeight, Dimension);
    set!(ts.max_size.width, PropertyId::MaxWidth, Dimension);
    set!(ts.max_size.height, PropertyId::MaxHeight, Dimension);
    set!(ts.flex_basis, PropertyId::FlexBasis, Dimension);
    set!(ts.margin.top, PropertyId::MarginTop, LengthPercentageAuto);
    set!(
        ts.margin.right,
        PropertyId::MarginRight,
        LengthPercentageAuto
    );
    set!(
        ts.margin.bottom,
        PropertyId::MarginBottom,
        LengthPercentageAuto
    );
    set!(ts.margin.left, PropertyId::MarginLeft, LengthPercentageAuto);
    set!(ts.inset.top, PropertyId::Top, LengthPercentageAuto);
    set!(ts.inset.right, PropertyId::Right, LengthPercentageAuto);
    set!(ts.inset.bottom, PropertyId::Bottom, LengthPercentageAuto);
    set!(ts.inset.left, PropertyId::Left, LengthPercentageAuto);
    set!(ts.padding.top, PropertyId::PaddingTop, LengthPercentage);
    set!(ts.padding.right, PropertyId::PaddingRight, LengthPercentage);
    set!(
        ts.padding.bottom,
        PropertyId::PaddingBottom,
        LengthPercentage
    );
    set!(ts.padding.left, PropertyId::PaddingLeft, LengthPercentage);
    set!(ts.gap.height, PropertyId::RowGap, LengthPercentage);
    set!(ts.gap.width, PropertyId::ColumnGap, LengthPercentage);
}
