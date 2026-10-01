//! The layout tree of `LayoutMode::Full`: taffy's algorithms run over nodes of our
//! own, so that the tree can also resolve `calc()` and, later, run algorithms
//! taffy does not have (inline layout, tables).

use taffy::prelude::*;
use taffy::{
    compute_block_layout, compute_cached_layout, compute_flexbox_layout, compute_grid_layout,
    compute_hidden_layout, compute_leaf_layout, compute_root_layout, BlockContext, Cache,
    CacheTree, LayoutBlockContainer, LayoutFlexboxContainer, LayoutGridContainer, LayoutInput,
    LayoutOutput, LayoutPartialTree, RunMode, TraversePartialTree, TraverseTree,
};

use taffy::util::MaybeResolve;

use crate::css_values::types::length::{CalcContext, CalcExpr};
use crate::layout::full::ifc::{self, Frag, Ifc};
use crate::layout::full::table;

/// What a node is in a table.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum Role {
    #[default]
    None,
    Table,
    /// `thead`, `tbody` or `tfoot`.
    Group(GroupKind),
    Row,
    Cell,
    /// An empty box left in the flow where an out-of-flow box would have been.
    Marker,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GroupKind {
    Header,
    Body,
    Footer,
}

#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum VAlign {
    Top,
    #[default]
    Middle,
    Bottom,
}

/// The table-wide properties a table's layout reads.
#[derive(Clone, Copy, Debug)]
pub struct TableStyle {
    pub collapse: bool,
    pub spacing: (f32, f32),
}

pub struct Node {
    pub role: Role,
    /// `(colspan, rowspan)` of a cell.
    pub span: (usize, usize),
    pub valign: VAlign,
    pub table: Option<TableStyle>,
    /// A cell's own borders, before the table replaced them with its collapsed
    /// halves.
    pub orig_border: Option<taffy::Rect<taffy::LengthPercentage>>,
    pub style: Style,
    /// Inline content, laid out by [`ifc::compute`] instead of a taffy algorithm.
    pub ifc: Option<Ifc>,
    /// Where the inline content ended up, in this node's coordinates.
    pub frags: Vec<Frag>,
    /// Baseline of the last line of inline content, from the top of the node.
    pub baseline: Option<f32>,
    /// The baseline of a form control, which draws its own text.
    pub control_baseline: Option<f32>,
    /// `vertical-align`, for an atomic inline.
    pub lift: ifc::Lift,
    /// `order`, which sorts the items of a flex or grid container.
    pub order: i32,
    /// Laid out, so that it has rectangles, but not drawn: the contents of a closed
    /// disclosure.
    pub paint_hidden: bool,
    /// `transform`, applied to the rectangles the box reports.
    pub transform: Option<Vec<crate::css_values::types::transform::TransformFunction>>,
    cache: Cache,
    pub layout: Layout,
    pub children: Vec<usize>,
    pub parent: Option<usize>,
}

/// A `calc()` expression with what it needs to evaluate. The pointer to one of
/// these is what a taffy length carries; `f64` fields give it the alignment
/// taffy requires of the pointer.
pub struct CalcEntry {
    expr: CalcExpr,
    ctx: CalcContext,
}

#[derive(Default)]
pub struct Tree {
    pub nodes: Vec<Node>,
    #[allow(
        clippy::vec_box,
        reason = "taffy lengths carry raw pointers to these entries, so they must not move when the vector grows"
    )]
    calcs: Vec<Box<CalcEntry>>,
}

impl Tree {
    pub fn add(&mut self, style: Style, children: Vec<usize>) -> usize {
        self.add_node(style, None, children)
    }

    /// A block-level box holding inline content; `atomics` are the atomic inlines
    /// it contains, laid out as its children.
    pub fn add_ifc(&mut self, style: Style, ifc: Ifc, atomics: Vec<usize>) -> usize {
        self.add_node(style, Some(ifc), atomics)
    }

    fn add_node(&mut self, style: Style, ifc: Option<Ifc>, children: Vec<usize>) -> usize {
        let id = self.nodes.len();
        for &c in &children {
            self.nodes[c].parent = Some(id);
        }
        self.nodes.push(Node {
            role: Role::None,
            span: (1, 1),
            valign: VAlign::default(),
            table: None,
            orig_border: None,
            style,
            ifc,
            frags: Vec::new(),
            baseline: None,
            control_baseline: None,
            lift: ifc::Lift::default(),
            order: 0,
            transform: None,
            paint_hidden: false,
            cache: Cache::new(),
            layout: Layout::with_order(0),
            children,
            parent: None,
        });
        id
    }

    /// A handle for taffy to carry in a length; it resolves through
    /// [`LayoutPartialTree::resolve_calc_value`] while this tree lives.
    pub fn calc(&mut self, expr: &CalcExpr, ctx: CalcContext) -> *const () {
        let entry = Box::new(CalcEntry {
            expr: expr.clone(),
            ctx,
        });
        let ptr = &*entry as *const CalcEntry as *const ();
        self.calcs.push(entry);
        ptr
    }

    /// Replace percentage vertical paddings and margins of `nodes` with lengths
    /// resolved against the width of their parent's content box, as CSS does, and
    /// drop the cached layout. Needs a computed layout to read those widths from.
    pub fn resolve_vertical_percent(&mut self, nodes: &[usize]) {
        for &n in nodes {
            let Some(parent) = self.nodes[n].parent else {
                continue;
            };
            let p = &self.nodes[parent].layout;
            let width =
                (p.size.width - p.padding.left - p.padding.right - p.border.left - p.border.right)
                    .max(0.0);
            let style = &mut self.nodes[n].style;
            for side in [&mut style.padding.top, &mut style.padding.bottom] {
                if let Some(v) = side.maybe_resolve(Some(width), resolve_calc) {
                    *side = taffy::LengthPercentage::length(v);
                }
            }
            for side in [&mut style.margin.top, &mut style.margin.bottom] {
                if !side.is_auto() {
                    if let Some(v) = side.maybe_resolve(Some(width), resolve_calc) {
                        *side = taffy::LengthPercentageAuto::length(v);
                    }
                }
            }
        }
        self.clear_caches();
    }

    pub(super) fn clear_cache(&mut self, node: usize) {
        self.nodes[node].cache.clear();
    }

    /// Forget every cached result, after styles changed under the tree.
    pub fn clear_caches(&mut self) {
        for node in &mut self.nodes {
            node.cache.clear();
        }
    }

    pub fn compute(&mut self, root: usize, available: Size<AvailableSpace>) {
        compute_root_layout(self, NodeId::from(root), available);
    }

    fn compute_node(
        &mut self,
        node_id: NodeId,
        inputs: LayoutInput,
        block_ctx: Option<&mut BlockContext<'_>>,
    ) -> LayoutOutput {
        if inputs.run_mode == RunMode::PerformHiddenLayout {
            return compute_hidden_layout(self, node_id);
        }
        compute_cached_layout(self, node_id, inputs, |tree, node_id, inputs| {
            let idx = usize::from(node_id);
            if tree.nodes[idx].ifc.is_some() {
                return ifc::compute(tree, node_id, inputs, block_ctx.as_deref());
            }
            if tree.nodes[idx].role == Role::Table {
                return table::compute(tree, node_id, inputs);
            }
            let display = tree.nodes[idx].style.display;
            let has_children = !tree.nodes[idx].children.is_empty();
            match (display, has_children) {
                (Display::None, _) => compute_hidden_layout(tree, node_id),
                (Display::Block, true) => compute_block_layout(tree, node_id, inputs, block_ctx),
                (Display::Flex, true) => compute_flexbox_layout(tree, node_id, inputs),
                (Display::Grid, true) => compute_grid_layout(tree, node_id, inputs),
                (_, false) => {
                    compute_leaf_layout(inputs, &tree.nodes[idx].style, resolve_calc, |known, _| {
                        Size {
                            width: known.width.unwrap_or(0.0),
                            height: known.height.unwrap_or(0.0),
                        }
                    })
                }
            }
        })
    }
}

pub(super) fn resolve_calc(val: *const (), basis: f32) -> f32 {
    // SAFETY: `val` was made by `Tree::calc`, which points into a `Box<CalcEntry>`
    // held in `Tree::calcs` for as long as the tree lives, and nothing moves or
    // frees those boxes while layout runs.
    let entry = unsafe { &*(val as *const CalcEntry) };
    let ctx = CalcContext {
        percentage_base_px: f64::from(basis),
        ..entry.ctx
    };
    entry.expr.evaluate(&ctx) as f32
}

pub struct ChildIter<'a>(std::slice::Iter<'a, usize>);

impl Iterator for ChildIter<'_> {
    type Item = NodeId;
    fn next(&mut self) -> Option<NodeId> {
        self.0.next().copied().map(NodeId::from)
    }
}

impl TraversePartialTree for Tree {
    type ChildIter<'a> = ChildIter<'a>;

    fn child_ids(&self, node_id: NodeId) -> ChildIter<'_> {
        ChildIter(self.nodes[usize::from(node_id)].children.iter())
    }

    fn child_count(&self, node_id: NodeId) -> usize {
        self.nodes[usize::from(node_id)].children.len()
    }

    fn get_child_id(&self, node_id: NodeId, index: usize) -> NodeId {
        NodeId::from(self.nodes[usize::from(node_id)].children[index])
    }
}

impl TraverseTree for Tree {}

impl LayoutPartialTree for Tree {
    type CustomIdent = String;
    type CoreContainerStyle<'a> = &'a Style;

    fn get_core_container_style(&self, node_id: NodeId) -> &Style {
        &self.nodes[usize::from(node_id)].style
    }

    fn set_unrounded_layout(&mut self, node_id: NodeId, layout: &Layout) {
        self.nodes[usize::from(node_id)].layout = *layout;
    }

    fn resolve_calc_value(&self, val: *const (), basis: f32) -> f32 {
        resolve_calc(val, basis)
    }

    fn compute_child_layout(&mut self, node_id: NodeId, inputs: LayoutInput) -> LayoutOutput {
        self.compute_node(node_id, inputs, None)
    }
}

impl CacheTree for Tree {
    fn cache_get(&self, node_id: NodeId, inputs: &LayoutInput) -> Option<LayoutOutput> {
        self.nodes[usize::from(node_id)].cache.get(inputs)
    }

    fn cache_store(&mut self, node_id: NodeId, inputs: &LayoutInput, output: LayoutOutput) {
        self.nodes[usize::from(node_id)].cache.store(inputs, output)
    }

    fn cache_clear(&mut self, node_id: NodeId) {
        self.nodes[usize::from(node_id)].cache.clear();
    }
}

impl LayoutBlockContainer for Tree {
    type BlockContainerStyle<'a> = &'a Style;
    type BlockItemStyle<'a> = &'a Style;

    fn get_block_container_style(&self, node_id: NodeId) -> &Style {
        &self.nodes[usize::from(node_id)].style
    }

    fn get_block_child_style(&self, child_node_id: NodeId) -> &Style {
        &self.nodes[usize::from(child_node_id)].style
    }

    fn compute_block_child_layout(
        &mut self,
        node_id: NodeId,
        inputs: LayoutInput,
        block_ctx: Option<&mut BlockContext<'_>>,
    ) -> LayoutOutput {
        self.compute_node(node_id, inputs, block_ctx)
    }
}

impl LayoutFlexboxContainer for Tree {
    type FlexboxContainerStyle<'a> = &'a Style;
    type FlexboxItemStyle<'a> = &'a Style;

    fn get_flexbox_container_style(&self, node_id: NodeId) -> &Style {
        &self.nodes[usize::from(node_id)].style
    }

    fn get_flexbox_child_style(&self, child_node_id: NodeId) -> &Style {
        &self.nodes[usize::from(child_node_id)].style
    }
}

impl LayoutGridContainer for Tree {
    type GridContainerStyle<'a> = &'a Style;
    type GridItemStyle<'a> = &'a Style;

    fn get_grid_container_style(&self, node_id: NodeId) -> &Style {
        &self.nodes[usize::from(node_id)].style
    }

    fn get_grid_child_style(&self, child_node_id: NodeId) -> &Style {
        &self.nodes[usize::from(child_node_id)].style
    }
}
