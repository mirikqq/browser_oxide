use crate::css_values::property::{CssValue, PropertyId};
use crate::css_values::types::display::{Display, Position};
use crate::dom::node::{NodeData, NodeId};
use crate::dom::Dom;
use crate::layout::full::FullLayout;
#[cfg(feature = "paint")]
use crate::layout::paint_tree::PaintStyle;
use crate::layout::query::DOMRect;
use crate::layout::resolve::ResolveContext;
use crate::layout::style_map::computed_to_taffy;
use crate::layout::viewport::Viewport;
use crate::layout::LayoutMode;
use crate::style::{StyleTree, Stylist};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use taffy::prelude::*;

/// Step limit for the iterative DOM walk in `build_node`. A correct DOM has
/// at most `nodes.len()` unique ids; if the walker takes more steps than this
/// it is iterating a cycle and we panic with a clear message rather than
/// running until OS abort. 100K is several orders of magnitude beyond any
/// real document.
const LAYOUT_BUILD_LIMIT: usize = 100_000;

/// What a text leaf needs to size itself.
#[derive(Debug, Clone, Copy)]
pub struct TextBox {
    chars: f32,
    longest_word: f32,
    font_size: f32,
}

/// Size a run of text, wrapping it into the width it is offered.
///
/// Advance width is approximated at 0.6em per character and the line box at
/// 1.2em, which is close enough for layout purposes; what matters is that the
/// run *wraps* rather than growing without bound.
pub(crate) fn measure_text(
    known: taffy::Size<Option<f32>>,
    available: taffy::Size<AvailableSpace>,
    _node: taffy::NodeId,
    ctx: Option<&mut TextBox>,
    _style: &taffy::Style,
) -> taffy::Size<f32> {
    let Some(tb) = ctx else {
        return taffy::Size {
            width: known.width.unwrap_or(0.0),
            height: known.height.unwrap_or(0.0),
        };
    };
    let char_w = tb.font_size * 0.6;
    let line_h = tb.font_size * 1.2;
    let full = (tb.chars * char_w).max(0.0);
    let min = (tb.longest_word * char_w).max(char_w);

    let limit = match known.width {
        Some(w) => w,
        None => match available.width {
            AvailableSpace::Definite(w) => w,
            AvailableSpace::MinContent => min,
            AvailableSpace::MaxContent => full,
        },
    };
    // A single word never splits, so the box cannot be narrower than the
    // longest one in it.
    let width = full.min(limit.max(min)).max(0.0);
    let lines = if width > 0.0 {
        (full / width).ceil().max(1.0)
    } else {
        1.0
    };
    taffy::Size {
        width,
        height: known.height.unwrap_or(lines * line_h),
    }
}

/// The layout engine. Converts a DOM + styles into positioned elements.
pub struct LayoutEngine {
    pub(super) tree: TaffyTree<TextBox>,
    pub(super) dom_to_taffy: HashMap<u32, taffy::NodeId>,
    viewport: Viewport,
    mode: LayoutMode,
    /// The platform the profile claims, which picks the fonts text is measured in.
    os_name: String,
    /// The result of the last `Full` layout; `None` in `Legacy` mode.
    pub(super) full: Option<FullLayout>,
    dirty: bool,
    /// Bumped on every mutation that sets `dirty`, and never reset by
    /// `compute()`. `dirty` alone can't back an external cache: `compute()`
    /// clears it independently of who asked (any layout query does), so a
    /// cache that only checks "is it dirty right now" can miss a mutation
    /// that happened and got cleared entirely between two of its own reads.
    /// A strictly-increasing counter can't be missed that way — a cache
    /// remains valid only while this value hasn't moved since it last
    /// checked.
    dirty_epoch: u64,
    pub(super) root_taffy: Option<taffy::NodeId>,
    /// What the painter reads from each element's cascaded style, keyed by DOM
    /// node. Rebuilt with the tree on every `compute()`.
    #[cfg(feature = "paint")]
    pub(super) paint_styles: HashMap<u32, PaintStyle>,
    /// Every style rule of the document, plus the user-agent sheet. Without the
    /// author rules every box falls back to UA defaults, which is what made
    /// `getBoundingClientRect` report full-viewport widths.
    stylist: Rc<Stylist>,
    /// The style pass, kept so `getComputedStyle` and layout share one result.
    /// Valid while `styles_epoch` equals `dirty_epoch`.
    styles: Option<StyleTree>,
    styles_epoch: u64,
    /// Out-of-flow boxes waiting to be attached to their containing block,
    /// with a flag for `position: fixed`.
    ///
    /// Taffy positions an absolute child against its parent. CSS positions it
    /// against the nearest *positioned* ancestor — and a fixed one against the
    /// viewport — so a box whose parent happens to be static picked up that
    /// parent's offset on top of its own. A widget that measures where to put
    /// its popup and writes the result into `top`/`left` landed that far away
    /// from where it meant to.
    abs_pending: Vec<(taffy::NodeId, bool)>,
    /// Each built node's `position`, so a parent can tell which of its children
    /// are out of flow. Filled as the post-order walk finishes each node.
    css_position: HashMap<u32, Position>,
    /// Each built node's `display`, so a parent can tell whether its children
    /// are inline-level and therefore share a line.
    css_display: HashMap<u32, Display>,
}

impl LayoutEngine {
    pub fn new(viewport: Viewport) -> Self {
        Self {
            tree: TaffyTree::new(),
            dom_to_taffy: HashMap::new(),
            abs_pending: Vec::new(),
            css_position: HashMap::new(),
            css_display: HashMap::new(),
            #[cfg(feature = "paint")]
            paint_styles: HashMap::new(),
            viewport,
            mode: crate::layout::default_mode(),
            os_name: "macOS".to_string(),
            full: None,
            dirty: true,
            dirty_epoch: 0,
            root_taffy: None,
            stylist: Rc::new(Stylist::new(crate::css_cascade::MediaFeatures::default())),
            styles: None,
            styles_epoch: 0,
        }
    }

    /// Point layout at the viewport the page believes it has. Without this the
    /// engine laid out against a compiled-in 1920x1080 while `window.innerWidth`
    /// reported the profile's size — so `vw`/`vh` and every percentage resolved
    /// against a viewport the page never sees, and the two disagreed observably.
    /// The viewport layout is currently computing against.
    pub fn viewport(&self) -> Viewport {
        self.viewport
    }

    pub fn set_viewport(&mut self, viewport: Viewport) {
        self.viewport = viewport;
        self.set_dirty();
    }

    pub fn set_os_name(&mut self, os_name: &str) {
        if self.os_name != os_name {
            self.os_name = os_name.to_string();
            self.set_dirty();
        }
    }

    pub fn mode(&self) -> LayoutMode {
        self.mode
    }

    /// Switch between the legacy and the full layout. Everything laid out so far
    /// is recomputed on the next query.
    pub fn set_mode(&mut self, mode: LayoutMode) {
        if self.mode != mode {
            self.mode = mode;
            self.set_dirty();
        }
    }

    /// Install the document's style rules. Marks layout dirty: geometry computed
    /// before the stylesheets arrived is wrong by definition.
    pub fn set_stylist(&mut self, stylist: Rc<Stylist>) {
        self.stylist = stylist;
        self.set_dirty();
    }

    /// Mark layout as dirty (needs recomputation).
    pub fn mark_dirty(&mut self) {
        self.set_dirty();
    }

    fn set_dirty(&mut self) {
        self.dirty = true;
        self.dirty_epoch += 1;
    }

    /// Monotonic counter bumped on every mutation, and never reset by
    /// `compute()` (unlike `dirty`). Callers outside this module use it to
    /// know when a value they derived from the DOM (e.g. a cached
    /// `getComputedStyle` result) is still valid: it's safe to reuse for as
    /// long as this value hasn't changed since they last checked it, and
    /// must be treated as invalid the moment it has.
    pub fn dirty_epoch(&self) -> u64 {
        self.dirty_epoch
    }

    /// Compute layout for the entire DOM tree.
    pub fn compute(&mut self, dom: &Dom) {
        if self.mode == LayoutMode::Full {
            self.compute_full(dom);
            return;
        }
        self.full = None;
        // Clear previous tree
        self.tree = TaffyTree::new();
        self.dom_to_taffy.clear();
        self.abs_pending.clear();
        self.css_position.clear();
        self.css_display.clear();
        #[cfg(feature = "paint")]
        self.paint_styles.clear();

        // The style pass: cascade and inheritance for the whole document, before
        // any box is built.
        self.style_tree(dom);
        let Some(styles) = self.styles.take() else {
            return;
        };
        let ctx = ResolveContext {
            font_size: crate::style::tree::DEFAULT_FONT_SIZE,
            root_font_size: styles.root_font_size(),
            viewport_w: self.viewport.width,
            viewport_h: self.viewport.height,
        };

        // Build taffy tree from DOM
        let root = self.build_node(dom, NodeId::DOCUMENT, &ctx, &styles);
        self.root_taffy = root;

        // Run layout
        if let Some(root_id) = self.root_taffy {
            let avail = taffy::Size {
                width: AvailableSpace::Definite(self.viewport.width),
                height: AvailableSpace::Definite(self.viewport.height),
            };
            self.tree
                .compute_layout_with_measure(root_id, avail, measure_text)
                .ok();
        }

        self.styles = Some(styles);
        self.dirty = false;
    }

    fn compute_full(&mut self, dom: &Dom) {
        #[cfg(feature = "paint")]
        self.paint_styles.clear();
        self.style_tree(dom);
        let Some(styles) = self.styles.take() else {
            return;
        };
        #[cfg(feature = "paint")]
        let paint_styles = &mut self.paint_styles;
        let layout = FullLayout::compute(
            dom,
            &styles,
            self.viewport,
            &self.os_name,
            |id, computed| {
                #[cfg(feature = "paint")]
                paint_styles.insert(id.to_raw(), PaintStyle::from_computed(computed));
                #[cfg(not(feature = "paint"))]
                let _ = (id, computed);
            },
        );
        self.styles = Some(styles);
        self.full = Some(layout);
        self.dirty = false;
    }

    /// The document's computed styles, recomputed only if something changed
    /// since they were last computed. Needs no layout.
    pub fn style_tree(&mut self, dom: &Dom) -> &StyleTree {
        if self.styles_epoch != self.dirty_epoch {
            self.styles = None;
            self.styles_epoch = self.dirty_epoch;
        }
        self.styles.get_or_insert_with(|| {
            StyleTree::compute(
                dom,
                &self.stylist,
                (self.viewport.width, self.viewport.height),
            )
        })
    }

    /// Ensure layout is computed (lazy).
    pub fn ensure_computed(&mut self, dom: &Dom) {
        if self.dirty {
            self.compute(dom);
        }
    }

    /// Get the bounding rect of a node.
    pub fn get_bounding_rect(&mut self, dom: &Dom, node_id: NodeId) -> DOMRect {
        self.ensure_computed(dom);

        if let Some(full) = &self.full {
            let Some(&n) = full.dom_to_node.get(&node_id.to_raw()) else {
                let rects = full.inline_rects(node_id.to_raw());
                let Some(first) = rects.first() else {
                    return DOMRect::default();
                };
                let (mut x0, mut y0) = (first[0], first[1]);
                let (mut x1, mut y1) = (first[0] + first[2], first[1] + first[3]);
                for r in &rects[1..] {
                    x0 = x0.min(r[0]);
                    y0 = y0.min(r[1]);
                    x1 = x1.max(r[0] + r[2]);
                    y1 = y1.max(r[1] + r[3]);
                }
                return DOMRect::new(
                    f64::from(x0),
                    f64::from(y0),
                    f64::from(x1 - x0),
                    f64::from(y1 - y0),
                );
            };
            let size = full.tree.nodes[n].layout.size;
            let (x, y) = full.absolute_position(n);
            return DOMRect::new(
                f64::from(x),
                f64::from(y),
                f64::from(size.width),
                f64::from(size.height),
            );
        }

        // Accumulate absolute position by walking up the taffy tree
        let taffy_id = match self.dom_to_taffy.get(&node_id.to_raw()) {
            Some(id) => *id,
            None => return DOMRect::default(),
        };

        let layout = match self.tree.layout(taffy_id) {
            Ok(l) => *l,
            Err(_) => return DOMRect::default(),
        };

        // Get absolute position by summing ancestor positions
        let (abs_x, abs_y) = self.absolute_position(taffy_id);

        // DOMRect::new quantizes to 1/64 px via LayoutUnit (Blink-coherent).
        DOMRect::new(
            abs_x as f64,
            abs_y as f64,
            layout.size.width as f64,
            layout.size.height as f64,
        )
    }

    /// One rectangle per line box the node occupies: a box of its own has one, an
    /// inline element that wraps has one for each line, and an element with no box
    /// has none. `Legacy` always reports the one bounding rectangle.
    pub fn get_client_rects(&mut self, dom: &Dom, node_id: NodeId) -> Vec<DOMRect> {
        self.ensure_computed(dom);
        if let Some(full) = &self.full {
            if !full.dom_to_node.contains_key(&node_id.to_raw()) {
                return full
                    .client_rects(dom, node_id)
                    .into_iter()
                    .map(|r| {
                        DOMRect::new(
                            f64::from(r[0]),
                            f64::from(r[1]),
                            f64::from(r[2]),
                            f64::from(r[3]),
                        )
                    })
                    .collect();
            }
        }
        vec![self.get_bounding_rect(dom, node_id)]
    }

    /// Get offsetWidth (width including padding + border).
    pub fn get_offset_width(&mut self, dom: &Dom, node_id: NodeId) -> f64 {
        self.ensure_computed(dom);
        self.taffy_size(node_id).0
    }

    /// Get offsetHeight.
    pub fn get_offset_height(&mut self, dom: &Dom, node_id: NodeId) -> f64 {
        self.ensure_computed(dom);
        self.taffy_size(node_id).1
    }

    /// Get offsetTop (position relative to offsetParent).
    pub fn get_offset_top(&mut self, dom: &Dom, node_id: NodeId) -> f64 {
        self.ensure_computed(dom);
        self.taffy_position(node_id).1
    }

    /// Get offsetLeft.
    pub fn get_offset_left(&mut self, dom: &Dom, node_id: NodeId) -> f64 {
        self.ensure_computed(dom);
        self.taffy_position(node_id).0
    }

    // --- Internal ---

    /// Build a taffy subtree rooted at `root`. Iterative post-order DFS:
    /// each node is "visited" first to enqueue its children, then "finished"
    /// after all descendants are processed so children's taffy IDs are
    /// available via `self.dom_to_taffy` when we call `tree.new_with_children`.
    /// `visited` + step counter guard against arena cycles (impossible given
    /// the cycle assertions in `Dom::append_child`/`insert_before`, but
    /// provides a clear panic if state ever becomes corrupt).
    fn build_node(
        &mut self,
        dom: &Dom,
        root: NodeId,
        ctx: &ResolveContext,
        styles: &StyleTree,
    ) -> Option<taffy::NodeId> {
        enum Work {
            Visit(NodeId),
            /// The node plus how many out-of-flow boxes were already pending
            /// when its subtree began: everything past that mark came from
            /// inside it, and only those may attach here.
            Finish(NodeId, usize),
        }
        let mut stack: Vec<Work> = vec![Work::Visit(root)];
        let mut visited: HashSet<NodeId> = HashSet::with_capacity(64);
        let mut steps: usize = 0;
        while let Some(work) = stack.pop() {
            match work {
                Work::Visit(node_id) => {
                    if !visited.insert(node_id) {
                        continue;
                    }
                    steps += 1;
                    if steps > LAYOUT_BUILD_LIMIT {
                        panic!(
                            "Layout build cycle from {:?} — visited {} unique nodes",
                            root,
                            visited.len()
                        );
                    }
                    // Schedule Finish first so it pops after all children.
                    stack.push(Work::Finish(node_id, self.abs_pending.len()));
                    // An outer SVG is a replaced element in HTML layout. Its
                    // graphics tree has its own viewport and must not size the
                    // surrounding flex/grid box (including foreignObject).
                    if dom
                        .get(node_id)
                        .and_then(|n| n.as_element())
                        .is_some_and(|e| e.name.local.eq_ignore_ascii_case("svg"))
                    {
                        continue;
                    }
                    // Push children in reverse for document order on pop.
                    let kids = dom.children(node_id);
                    for c in kids.into_iter().rev() {
                        stack.push(Work::Visit(c));
                    }
                }
                Work::Finish(node_id, mark) => {
                    self.finish_node(dom, node_id, ctx, styles, mark);
                }
            }
        }
        self.dom_to_taffy.get(&root.to_raw()).copied()
    }

    /// Build the taffy node for `node_id` using already-built children
    /// recorded in `self.dom_to_taffy` (set by prior Finish calls in
    /// post-order). Returns nothing — the result lives in `dom_to_taffy`.
    fn finish_node(
        &mut self,
        dom: &Dom,
        node_id: NodeId,
        doc_ctx: &ResolveContext,
        styles: &StyleTree,
        mark: usize,
    ) {
        let node = match dom.get(node_id) {
            Some(n) => n,
            None => return,
        };

        // Collect already-built children's taffy IDs in document order.
        // Children that returned None (e.g. display:none, unsupported node
        // type) are absent from dom_to_taffy and naturally filtered out.
        // In-flow children only. An `absolute` or `fixed` child does not belong
        // to its parent's box — it waits for whichever ancestor actually is its
        // containing block, which is found below.
        let mut children: Vec<taffy::NodeId> = Vec::new();
        for cid in dom.children(node_id) {
            let Some(tid) = self.dom_to_taffy.get(&cid.to_raw()).copied() else {
                continue;
            };
            match self.css_position.get(&cid.to_raw()) {
                Some(Position::Absolute) => self.abs_pending.push((tid, false)),
                Some(Position::Fixed) => self.abs_pending.push((tid, true)),
                _ => children.push(tid),
            }
        }

        let taffy_id = match &node.data {
            NodeData::Document | NodeData::DocumentFragment => {
                // The initial containing block: whatever never found a
                // positioned ancestor belongs here, `fixed` boxes included.
                for (tid, _) in self.abs_pending.drain(..) {
                    children.push(tid);
                }
                let style = taffy::Style {
                    display: taffy::Display::Block,
                    size: taffy::Size {
                        width: Dimension::length(doc_ctx.viewport_w),
                        height: Dimension::auto(),
                    },
                    ..Default::default()
                };
                match self.tree.new_with_children(style, &children) {
                    Ok(id) => id,
                    Err(_) => return,
                }
            }
            NodeData::Element(elem) => {
                // No entry means `display: none` on this element or an ancestor:
                // no box.
                let Some(computed) = styles.get(node_id) else {
                    return;
                };
                // Relative lengths on this element resolve against its own font size.
                let ctx = &ResolveContext {
                    font_size: styles.font_size(node_id),
                    ..*doc_ctx
                };
                let position = match computed.get(&PropertyId::Position) {
                    Some(CssValue::Position(p)) => *p,
                    _ => Position::Static,
                };
                // A positioned box is a containing block for the absolutes
                // beneath it. `fixed` keeps rising: only the viewport holds it.
                if !matches!(position, Position::Static) {
                    let mut i = mark;
                    while i < self.abs_pending.len() {
                        if self.abs_pending[i].1 {
                            i += 1;
                        } else {
                            children.push(self.abs_pending.remove(i).0);
                        }
                    }
                }
                self.css_position.insert(node_id.to_raw(), position);
                let display = match computed.get(&PropertyId::Display) {
                    // These did not parse before, and the legacy layout keeps
                    // treating them as the initial `inline`.
                    Some(CssValue::Display(
                        Display::TableRowGroup
                        | Display::TableHeaderGroup
                        | Display::TableFooterGroup
                        | Display::TableColumn
                        | Display::TableColumnGroup
                        | Display::TableCaption,
                    )) => Display::Inline,
                    Some(CssValue::Display(d)) => *d,
                    _ => Display::Inline,
                };
                self.css_display.insert(node_id.to_raw(), display);
                #[cfg(feature = "paint")]
                self.paint_styles
                    .insert(node_id.to_raw(), PaintStyle::from_computed(computed));
                let mut taffy_style = computed_to_taffy(computed, ctx);

                // Quirks mode stretches the root boxes to the viewport. Chrome
                // 153 on a doctype-less page: `documentElement.offsetHeight` is
                // the full viewport and `body.offsetHeight` is the viewport
                // minus the body's own margins (413 / 397 on a 413px viewport),
                // where the same page with a doctype reports 8 / 0. Without
                // this every such page measured its body at zero height.
                if dom.quirks()
                    && matches!(&*elem.name.local, "html" | "body")
                    && taffy_style.size.height.is_auto()
                {
                    let margins = [taffy_style.margin.top, taffy_style.margin.bottom]
                        .iter()
                        .map(|m| {
                            m.resolve_to_option(ctx.viewport_h, |_, _| 0.0)
                                .unwrap_or(0.0)
                        })
                        .sum::<f32>();
                    taffy_style.min_size.height =
                        Dimension::length((ctx.viewport_h - margins).max(0.0));
                }

                // Inline-level children share a line.
                //
                // Every box is a taffy block, so a container holding
                // `display: inline-block` children stacked them vertically —
                // a captcha's checkbox, its label and its logo came out in a
                // column, and the last of them fell outside the widget's own
                // box. Laying such a container out as a wrapping row is not a
                // line-box implementation, but it puts inline-level siblings
                // where they belong instead of under each other.
                if taffy_style.display == taffy::Display::Block && children.len() > 1 {
                    let inline_kids = dom
                        .children(node_id)
                        .into_iter()
                        .filter_map(|c| self.css_display.get(&c.to_raw()))
                        .filter(|d| {
                            matches!(
                                d,
                                Display::Inline | Display::InlineBlock | Display::InlineFlex
                            )
                        })
                        .count();
                    if inline_kids > 0 {
                        taffy_style.display = taffy::Display::Flex;
                        taffy_style.flex_direction = taffy::FlexDirection::Row;
                        taffy_style.flex_wrap = taffy::FlexWrap::Wrap;
                        taffy_style.align_items = Some(taffy::AlignItems::CENTER);
                    }
                }
                match self.tree.new_with_children(taffy_style, &children) {
                    Ok(id) => id,
                    Err(_) => return,
                }
            }
            NodeData::Text(text) => {
                // Whitespace between block-level tags collapses away and
                // generates no box. Giving it one put a line's worth of height
                // between every pair of blocks — including the newline between
                // `</head>` and `<body>`, which pushed the whole document down.
                if text.trim().is_empty() {
                    return;
                }
                // Text under a `display: none` element has no style to inherit,
                // and no box.
                if let Some(parent) = node.parent {
                    if dom.get(parent).is_some_and(|p| p.as_element().is_some())
                        && styles.get(parent).is_none()
                    {
                        return;
                    }
                }
                // Sized by the measure function, which can wrap it. A fixed
                // width of `chars × 0.6em` never wrapped, so one long run of
                // text made its container thousands of pixels wide and pushed
                // everything laid out beside it far off-screen — inside a 302px
                // captcha frame, its own links ended up at x = 2482.
                let ctx_box = TextBox {
                    chars: text.chars().count() as f32,
                    longest_word: text
                        .split_whitespace()
                        .map(|w| w.chars().count())
                        .max()
                        .unwrap_or(0) as f32,
                    font_size: node
                        .parent
                        .map_or(doc_ctx.font_size, |p| styles.font_size(p)),
                };
                match self
                    .tree
                    .new_leaf_with_context(taffy::Style::default(), ctx_box)
                {
                    Ok(id) => id,
                    Err(_) => return,
                }
            }
            _ => return,
        };
        self.dom_to_taffy.insert(node_id.to_raw(), taffy_id);
    }

    fn absolute_position(&self, taffy_id: taffy::NodeId) -> (f32, f32) {
        let mut x = 0.0f32;
        let mut y = 0.0f32;
        let mut current = taffy_id;
        loop {
            if let Ok(layout) = self.tree.layout(current) {
                x += layout.location.x;
                y += layout.location.y;
            }
            match self.tree.parent(current) {
                Some(parent) => current = parent,
                None => break,
            }
        }
        (x, y)
    }

    fn taffy_size(&self, node_id: NodeId) -> (f64, f64) {
        if let Some(full) = &self.full {
            return full
                .dom_to_node
                .get(&node_id.to_raw())
                .map(|&n| {
                    let size = full.tree.nodes[n].layout.size;
                    (
                        crate::layout::layout_unit::LayoutUnit::from_taffy_f32(size.width)
                            .to_f64_px(),
                        crate::layout::layout_unit::LayoutUnit::from_taffy_f32(size.height)
                            .to_f64_px(),
                    )
                })
                .unwrap_or((0.0, 0.0));
        }
        match self.dom_to_taffy.get(&node_id.to_raw()) {
            Some(taffy_id) => match self.tree.layout(*taffy_id) {
                Ok(layout) => (
                    crate::layout::layout_unit::LayoutUnit::from_taffy_f32(layout.size.width)
                        .to_f64_px(),
                    crate::layout::layout_unit::LayoutUnit::from_taffy_f32(layout.size.height)
                        .to_f64_px(),
                ),
                Err(_) => (0.0, 0.0),
            },
            None => (0.0, 0.0),
        }
    }

    fn taffy_position(&self, node_id: NodeId) -> (f64, f64) {
        if let Some(full) = &self.full {
            return full
                .dom_to_node
                .get(&node_id.to_raw())
                .map(|&n| {
                    let at = full.tree.nodes[n].layout.location;
                    (
                        crate::layout::layout_unit::LayoutUnit::from_taffy_f32(at.x).to_f64_px(),
                        crate::layout::layout_unit::LayoutUnit::from_taffy_f32(at.y).to_f64_px(),
                    )
                })
                .unwrap_or((0.0, 0.0));
        }
        match self.dom_to_taffy.get(&node_id.to_raw()) {
            Some(taffy_id) => match self.tree.layout(*taffy_id) {
                Ok(layout) => (
                    crate::layout::layout_unit::LayoutUnit::from_taffy_f32(layout.location.x)
                        .to_f64_px(),
                    crate::layout::layout_unit::LayoutUnit::from_taffy_f32(layout.location.y)
                        .to_f64_px(),
                ),
                Err(_) => (0.0, 0.0),
            },
            None => (0.0, 0.0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::node::{Attribute, QualName};

    fn make_dom_with_styled_div(style: &str) -> Dom {
        let mut dom = Dom::new();
        let html = dom.create_element(QualName::new("html"), vec![]);
        dom.append_child(NodeId::DOCUMENT, html);
        let body = dom.create_element(QualName::new("body"), vec![]);
        dom.append_child(html, body);
        let div = dom.create_element(
            QualName::new("div"),
            vec![Attribute {
                name: QualName::new("style"),
                value: style.to_string(),
            }],
        );
        dom.append_child(body, div);
        dom
    }

    #[test]
    fn layout_basic_div() {
        let dom = make_dom_with_styled_div("width: 200px; height: 100px");
        let viewport = Viewport::new(1920.0, 1080.0);
        let mut engine = LayoutEngine::new(viewport);
        engine.compute(&dom);

        // Find the div (it's the child of body, which is child of html, which is child of document)
        let html = dom.child_elements(NodeId::DOCUMENT)[0];
        let body = dom.child_elements(html)[0];
        let div = dom.child_elements(body)[0];

        let rect = engine.get_bounding_rect(&dom, div);
        // Width includes border (default 3px medium border on each side)
        // Content: 200px + border: 3+3 = 206px (content-box)
        assert!(
            rect.width >= 200.0,
            "width should be >= 200, got {}",
            rect.width
        );
        assert!(
            rect.height >= 100.0,
            "height should be >= 100, got {}",
            rect.height
        );
    }

    #[test]
    fn layout_text_node_has_size() {
        let mut dom = Dom::new();
        let html = dom.create_element(QualName::new("html"), vec![]);
        dom.append_child(NodeId::DOCUMENT, html);
        let body = dom.create_element(QualName::new("body"), vec![]);
        dom.append_child(html, body);
        let text = dom.create_text("Hello world".to_string());
        dom.append_child(body, text);

        let viewport = Viewport::new(1920.0, 1080.0);
        let mut engine = LayoutEngine::new(viewport);
        engine.compute(&dom);

        let (w, h) = engine.taffy_size(text);
        assert!(w > 0.0, "text width should be > 0, got {}", w);
        assert!(h > 0.0, "text height should be > 0, got {}", h);
    }

    #[test]
    fn layout_offset_width() {
        let dom = make_dom_with_styled_div("width: 300px; height: 150px");
        let viewport = Viewport::new(1920.0, 1080.0);
        let mut engine = LayoutEngine::new(viewport);

        let html = dom.child_elements(NodeId::DOCUMENT)[0];
        let body = dom.child_elements(html)[0];
        let div = dom.child_elements(body)[0];

        let w = engine.get_offset_width(&dom, div);
        assert!(w >= 300.0, "offsetWidth should be >= 300, got {}", w);
        let h = engine.get_offset_height(&dom, div);
        assert!(h >= 150.0, "offsetHeight should be >= 150, got {}", h);
    }

    #[test]
    fn dirty_tracking() {
        let dom = make_dom_with_styled_div("width: 100px");
        let viewport = Viewport::new(1920.0, 1080.0);
        let mut engine = LayoutEngine::new(viewport);

        assert!(engine.dirty);
        engine.compute(&dom);
        assert!(!engine.dirty);
        engine.mark_dirty();
        assert!(engine.dirty);
    }

    #[test]
    fn dom_rect_from_layout() {
        let layout = taffy::Layout::new();
        let rect = DOMRect::from_taffy_layout(&layout);
        assert_eq!(rect.width, 0.0);
    }
}
