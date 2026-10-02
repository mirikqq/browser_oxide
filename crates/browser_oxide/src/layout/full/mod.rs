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
mod image;
mod table;
pub mod tree;

use build::Builder;
use tree::Tree;

pub struct FullLayout {
    pub tree: Tree,
    pub dom_to_node: HashMap<u32, usize>,
    pub root: Option<usize>,
    block_in_inline: HashMap<u32, Vec<usize>>,
    /// Where each node's own coordinates land in the document, for a page that
    /// has a `transform` anywhere; empty otherwise.
    matrices: Vec<[f32; 6]>,
    /// Fragments of inline elements and text nodes, by DOM id: the owning node
    /// and the fragment's index in it.
    inline: HashMap<u32, Vec<(usize, usize)>>,
    /// See [`Builder::empty_inline`].
    empty_inline: HashMap<u32, (Option<usize>, u32)>,
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
        let mut b = Builder::new(dom, styles, &ctx, os, viewport.device_pixel_ratio);
        b.build(&mut on_style);
        let root = b.dom_to_node.get(&DomId::DOCUMENT.to_raw()).copied();
        let vertical_percent = std::mem::take(&mut b.vertical_percent);
        let static_pending = std::mem::take(&mut b.static_pending);
        let block_in_inline = std::mem::take(&mut b.block_in_inline);
        let empty_inline = std::mem::take(&mut b.empty_inline);
        let mut layout = Self {
            tree: b.tree,
            dom_to_node: b.dom_to_node,
            root,
            block_in_inline,
            matrices: Vec::new(),
            inline: HashMap::new(),
            empty_inline,
        };
        layout.tree.justify_blocks();
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
        if layout.root.is_some() && layout.place_out_of_flow(&static_pending) {
            if let Some(root) = layout.root {
                layout.tree.compute(
                    root,
                    Size {
                        width: AvailableSpace::Definite(viewport.width),
                        height: AvailableSpace::Definite(viewport.height),
                    },
                );
            }
        }
        layout.apply_sticky(viewport);
        layout.compute_matrices(viewport);
        for (n, node) in layout.tree.nodes.iter().enumerate() {
            for (f, frag) in node.frags.iter().enumerate() {
                layout.inline.entry(frag.dom).or_default().push((n, f));
            }
        }
        layout
    }

    /// Give each out-of-flow box whose offsets are `auto` the position of the empty
    /// box that marks where it would have been in the flow. Whether any changed.
    fn place_out_of_flow(&mut self, pending: &[(usize, usize)]) -> bool {
        let mut changed = false;
        for &(abs, mark) in pending {
            let Some(cb) = self.tree.nodes[abs].parent else {
                continue;
            };
            let (mx, my) = self.absolute_position(mark);
            let (cx, cy) = self.absolute_position(cb);
            let border = self.tree.nodes[cb].layout.border;
            let (ox, oy) = (cx + border.left, cy + border.top);
            let inset = &mut self.tree.nodes[abs].style.inset;
            if inset.left.is_auto() && inset.right.is_auto() {
                inset.left = LengthPercentageAuto::length(mx - ox);
                changed = true;
            }
            if inset.top.is_auto() && inset.bottom.is_auto() {
                inset.top = LengthPercentageAuto::length(my - oy);
                changed = true;
            }
        }
        if changed {
            self.tree.clear_caches();
        }
        changed
    }

    /// A sticky box stays inside the view when the page is at its top: one whose
    /// `top` is below where it sits is pushed down to it (and one whose `bottom` is
    /// above where its bottom edge sits is pulled up), within its parent.
    fn apply_sticky(&mut self, viewport: Viewport) {
        for n in 0..self.tree.nodes.len() {
            let Some([top, _, bottom, _]) = self.tree.nodes[n].sticky else {
                continue;
            };
            let Some(parent) = self.tree.nodes[n].parent else {
                continue;
            };
            let (_, y) = self.absolute_position(n);
            let (_, parent_y) = self.absolute_position(parent);
            let parent_h = self.tree.nodes[parent].layout.size.height;
            let h = self.tree.nodes[n].layout.size.height;
            let mut at = y;
            if let Some(b) = bottom {
                at = at.min(viewport.height - b - h);
            }
            if let Some(t) = top {
                at = at.max(t);
            }
            let at = at.min(parent_y + parent_h - h).max(parent_y.min(y));
            if (at - y).abs() > f32::EPSILON {
                self.tree.nodes[n].layout.location.y += at - y;
            }
        }
    }

    /// The matrix of every node, if any has a `transform`: the node's own
    /// coordinates (origin at its border box's corner) to the document's. A
    /// transform turns about the middle of the box.
    fn compute_matrices(&mut self, viewport: Viewport) {
        if self.tree.nodes.iter().all(|n| n.transform.is_none()) {
            return;
        }
        let ctx = ResolveContext {
            font_size: crate::style::tree::DEFAULT_FONT_SIZE,
            root_font_size: crate::style::tree::DEFAULT_FONT_SIZE,
            viewport_w: viewport.width,
            viewport_h: viewport.height,
        };
        let mut all = vec![IDENTITY; self.tree.nodes.len()];
        // Children are added before their parents: walk the nodes parents-first.
        for n in (0..self.tree.nodes.len()).rev() {
            let node = &self.tree.nodes[n];
            let parent = node.parent.map_or(IDENTITY, |p| all[p]);
            let (w, h) = (node.layout.size.width, node.layout.size.height);
            let at = translation(node.layout.location.x, node.layout.location.y);
            let own = match &node.transform {
                Some(t) => {
                    let m = transform_matrix(t, w, h, &ctx);
                    multiply(
                        translation(w / 2.0, h / 2.0),
                        multiply(m, translation(-w / 2.0, -h / 2.0)),
                    )
                }
                None => IDENTITY,
            };
            all[n] = multiply(parent, multiply(at, own));
        }
        self.matrices = all;
    }

    /// `rect` (`[x, y, w, h]`, in the coordinates of `node`'s border box) in the
    /// document's: the box that holds it once transformed.
    fn to_document(&self, node: usize, rect: [f32; 4]) -> [f32; 4] {
        if self.matrices.is_empty() {
            let (x, y) = self.absolute_position(node);
            return [x + rect[0], y + rect[1], rect[2], rect[3]];
        }
        let m = self.matrices[node];
        let corners = [
            (rect[0], rect[1]),
            (rect[0] + rect[2], rect[1]),
            (rect[0], rect[1] + rect[3]),
            (rect[0] + rect[2], rect[1] + rect[3]),
        ]
        .map(|(x, y)| (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]));
        let min = |f: fn(&(f32, f32)) -> f32| corners.iter().map(f).fold(f32::INFINITY, f32::min);
        let max =
            |f: fn(&(f32, f32)) -> f32| corners.iter().map(f).fold(f32::NEG_INFINITY, f32::max);
        let (x0, y0) = (min(|c| c.0), min(|c| c.1));
        [x0, y0, max(|c| c.0) - x0, max(|c| c.1) - y0]
    }

    /// The border box of a node in document coordinates, transforms applied.
    pub fn node_rect(&self, node: usize) -> [f32; 4] {
        let size = self.tree.nodes[node].layout.size;
        self.to_document(node, [0.0, 0.0, size.width, size.height])
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
        if out.is_empty() {
            out.extend(self.empty_inline_rect(dom_id));
        }
        out
    }

    /// An inline element with nothing to show and no line to be on is a zero-size box
    /// where the next box of its container would start: at the content edge, below the
    /// box before it and that box's margin.
    fn empty_inline_rect(&self, dom_id: u32) -> Option<[f32; 4]> {
        let &(prev, cont) = self.empty_inline.get(&dom_id)?;
        let c = *self.dom_to_node.get(&cont)?;
        let layout = &self.tree.nodes[c].layout;
        let y = match prev.map(|p| &self.tree.nodes[p]) {
            Some(p) if p.parent == Some(c) => {
                p.layout.location.y + p.layout.size.height + p.layout.margin.bottom
            }
            _ => layout.border.top + layout.padding.top,
        };
        Some(self.to_document(c, [layout.border.left + layout.padding.left, y, 0.0, 0.0]))
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
                let l = &parent.layout;
                let left = l.padding.left + l.border.left;
                let width = l.size.width - left - l.padding.right - l.border.right;
                let at = self.tree.nodes[n].layout.location.y;
                Some(self.to_document(
                    self.tree.nodes[n].parent?,
                    [
                        left,
                        at,
                        width.max(0.0),
                        self.tree.nodes[n].layout.size.height,
                    ],
                ))
            })
            .collect()
    }

    fn push_inline_rects(&self, dom_id: u32, out: &mut Vec<[f32; 4]>) {
        let Some(frags) = self.inline.get(&dom_id) else {
            return;
        };
        out.extend(frags.iter().filter_map(|&(n, f)| {
            let frag = &self.tree.nodes[n].frags[f];
            (frag.kind == ifc::FragKind::Box || self.is_text(dom_id))
                .then(|| self.to_document(n, frag.rect))
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
        if frags.is_none() && !self.block_in_inline.contains_key(&id.to_raw()) {
            if let Some(rect) = self.empty_inline_rect(id.to_raw()) {
                out.push(rect);
                return;
            }
        }
        let abs = |&(n, f): &(usize, usize)| self.to_document(n, self.tree.nodes[n].frags[f].rect);
        if own.iter().any(|f| f.kind == ifc::FragKind::Text) {
            // A text node: its line fragments.
            out.extend(frags.into_iter().flatten().map(abs));
            return;
        }
        if own.iter().any(|f| f.decorated) || (!own.is_empty() && dom.children(id).is_empty()) {
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
    /// A `calc()` that does not depend on its percentage basis is a plain length:
    /// taffy cannot resolve one where no basis is known, as in intrinsic sizing.
    enum Calc {
        Length(f32),
        Pointer(*const ()),
    }
    let mut handle = |p: PropertyId| {
        computed.get(&p).and_then(calc_of).map(|e| {
            let at = |base: f64| {
                e.evaluate(&CalcContext {
                    percentage_base_px: base,
                    ..cc
                })
            };
            let (a, b) = (at(0.0), at(1000.0));
            if (a - b).abs() < 1e-6 {
                Calc::Length(a as f32)
            } else {
                Calc::Pointer(tree.calc(e, cc))
            }
        })
    };
    macro_rules! set {
        ($field:expr, $prop:expr, $ty:ty) => {
            match handle($prop) {
                Some(Calc::Length(v)) => $field = <$ty>::length(v),
                Some(Calc::Pointer(ptr)) => $field = <$ty>::calc(ptr),
                None => {}
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

const IDENTITY: [f32; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

fn translation(x: f32, y: f32) -> [f32; 6] {
    [1.0, 0.0, 0.0, 1.0, x, y]
}

/// `a` after `b`: the matrix that applies `b` first.
fn multiply(a: [f32; 6], b: [f32; 6]) -> [f32; 6] {
    [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ]
}

/// The matrix of a `transform` list on a `w` by `h` box.
fn transform_matrix(
    list: &[crate::css_values::types::transform::TransformFunction],
    w: f32,
    h: f32,
    ctx: &ResolveContext,
) -> [f32; 6] {
    use crate::css_values::types::length::LengthPercentage as Lp;
    use crate::css_values::types::transform::TransformFunction as F;
    let px = |v: &Lp, of: f32| match v {
        Lp::Length(l) => crate::layout::resolve::resolve_length(l, ctx),
        Lp::Percentage(p) => *p as f32 / 100.0 * of,
        Lp::Calc(_) => 0.0,
    };
    let mut m = IDENTITY;
    for f in list {
        let step = match f {
            F::Translate(x, y) => translation(px(x, w), px(y, h)),
            F::TranslateX(x) => translation(px(x, w), 0.0),
            F::TranslateY(y) => translation(0.0, px(y, h)),
            F::Scale(x, y) => [*x as f32, 0.0, 0.0, *y as f32, 0.0, 0.0],
            F::ScaleX(x) => [*x as f32, 0.0, 0.0, 1.0, 0.0, 0.0],
            F::ScaleY(y) => [1.0, 0.0, 0.0, *y as f32, 0.0, 0.0],
            F::Rotate(a) => {
                let r = a.to_degrees().to_radians() as f32;
                [r.cos(), r.sin(), -r.sin(), r.cos(), 0.0, 0.0]
            }
            F::SkewX(a) => [
                1.0,
                0.0,
                (a.to_degrees().to_radians() as f32).tan(),
                1.0,
                0.0,
                0.0,
            ],
            F::SkewY(a) => [
                1.0,
                (a.to_degrees().to_radians() as f32).tan(),
                0.0,
                1.0,
                0.0,
                0.0,
            ],
            F::Matrix(a, b, c, d, e, f) => [
                *a as f32, *b as f32, *c as f32, *d as f32, *e as f32, *f as f32,
            ],
            _ => IDENTITY,
        };
        m = multiply(m, step);
    }
    m
}
