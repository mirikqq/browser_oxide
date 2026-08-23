use crate::css_cascade::{ComputedStyle, StyleRule};
use crate::css_values::property::{CssValue, PropertyId};
use crate::css_values::types::display::{Display, Position};
use crate::dom::node::{NodeData, NodeId};
use crate::dom::Dom;
use crate::layout::query::DOMRect;
use crate::layout::resolve::ResolveContext;
use crate::layout::style_map::computed_to_taffy;
use crate::layout::viewport::Viewport;
use std::collections::{HashMap, HashSet};
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
fn measure_text(
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

/// Presentational size hints: `width` / `height` written as attributes.
///
/// `<svg width="44" height="46">` — and the same on `<img>`, `<canvas>`,
/// `<iframe>` and friends — is how a great deal of markup states its size.
/// Nothing mapped them into the cascade, so those elements computed
/// `height: auto` and laid out zero pixels tall: an inline SVG logo occupied
/// its width and no height at all, and everything drawn inside it collapsed
/// with it. They enter the cascade below author CSS, which is where the spec
/// puts presentational hints.
fn presentational_declarations(
    elem: &crate::dom::node::ElementData,
) -> HashMap<PropertyId, CssValue> {
    const SIZED: &[&str] = &[
        "img", "svg", "canvas", "iframe", "embed", "object", "video", "input",
    ];
    use crate::css_values::types::length::{Length as CssLength, LengthPercentageAuto as CssLpa};
    let mut out = HashMap::new();
    if !SIZED.contains(&&*elem.name.local) {
        return out;
    }
    for (attr, prop) in [("width", PropertyId::Width), ("height", PropertyId::Height)] {
        let Some(raw) = elem
            .attrs
            .iter()
            .find(|a| a.name.local == *attr)
            .map(|a| a.value.trim())
        else {
            continue;
        };
        let value = if let Some(pct) = raw.strip_suffix('%') {
            pct.trim()
                .parse::<f64>()
                .ok()
                .map(|n| CssValue::LengthPercentageAuto(CssLpa::Percentage(n)))
        } else {
            raw.parse::<f64>()
                .ok()
                .map(|n| CssValue::LengthPercentageAuto(CssLpa::Length(CssLength::Px(n))))
        };
        if let Some(v) = value {
            out.insert(prop, v);
        }
    }
    out
}

/// Intrinsic replaced-element size for an outer SVG. Author CSS and explicit
/// width/height attributes are appended later and therefore keep precedence.
fn svg_intrinsic_declarations(
    elem: &crate::dom::node::ElementData,
) -> HashMap<PropertyId, CssValue> {
    use crate::css_values::types::length::{Length as CssLength, LengthPercentageAuto as CssLpa};
    let mut out = HashMap::new();
    if !elem.name.local.eq_ignore_ascii_case("svg") {
        return out;
    }
    let attr = |name: &str| elem.attrs.iter().find(|a| a.name.local == name);
    let view_box = attr("viewBox").or_else(|| attr("viewbox")).map(|a| {
        a.value
            .split(|c: char| c.is_ascii_whitespace() || c == ',')
            .filter_map(|part| part.parse::<f64>().ok())
            .collect::<Vec<_>>()
    });
    let ratio = view_box
        .as_deref()
        .filter(|parts| parts.len() == 4 && parts[2] > 0.0 && parts[3] > 0.0)
        .map(|parts| parts[2] / parts[3]);
    let width = attr("width").and_then(|a| a.value.trim().parse::<f64>().ok());
    let height = attr("height").and_then(|a| a.value.trim().parse::<f64>().ok());
    let (fallback_width, fallback_height) = match (width, height, ratio) {
        (Some(w), None, Some(r)) => (w, w / r),
        (None, Some(h), Some(r)) => (h * r, h),
        (None, None, Some(r)) => (300.0, 300.0 / r),
        _ => (300.0, 150.0),
    };
    out.insert(
        PropertyId::Width,
        CssValue::LengthPercentageAuto(CssLpa::Length(CssLength::Px(fallback_width))),
    );
    out.insert(
        PropertyId::Height,
        CssValue::LengthPercentageAuto(CssLpa::Length(CssLength::Px(fallback_height))),
    );
    out
}

/// Elements the UA stylesheet hides.
///
/// Nothing supplied per-tag defaults, so `<head>` and everything in it was laid
/// out as ordinary blocks — the text of every `<style>`, `<script>` and
/// `<title>` was measured and given height, and `<body>` started that far down
/// the page. Inside a captcha's frame that pushed its whole interface past the
/// bottom edge, and every coordinate taken from it was off by the same amount.
///
/// The list is the `display: none` block of the HTML rendering spec:
/// <https://html.spec.whatwg.org/multipage/rendering.html#hidden-elements>
fn ua_declarations(tag: &str) -> HashMap<PropertyId, CssValue> {
    const HIDDEN: &[&str] = &[
        "head", "base", "basefont", "bgsound", "datalist", "link", "meta", "noembed", "noframes",
        "param", "rp", "script", "style", "template", "title",
    ];
    let mut out = HashMap::new();
    if HIDDEN.contains(&tag) {
        out.insert(PropertyId::Display, CssValue::Display(Display::None));
    }
    out
}

/// The layout engine. Converts a DOM + styles into positioned elements.
pub struct LayoutEngine {
    tree: TaffyTree<TextBox>,
    dom_to_taffy: HashMap<u32, taffy::NodeId>,
    viewport: Viewport,
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
    root_taffy: Option<taffy::NodeId>,
    /// Author rules to cascade onto each element. Empty until the document's
    /// stylesheets are parsed; without them every box falls back to UA defaults,
    /// which is what made `getBoundingClientRect` report full-viewport widths.
    rules: Vec<StyleRule>,
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
            viewport,
            dirty: true,
            dirty_epoch: 0,
            root_taffy: None,
            rules: Vec::new(),
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

    /// Install the document's author rules. Marks layout dirty: geometry computed
    /// before the stylesheets arrived is wrong by definition.
    pub fn set_style_rules(&mut self, rules: Vec<StyleRule>) {
        self.rules = rules;
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
        // Clear previous tree
        self.tree = TaffyTree::new();
        self.dom_to_taffy.clear();
        self.abs_pending.clear();
        self.css_position.clear();
        self.css_display.clear();

        let ctx = ResolveContext {
            font_size: 16.0,
            root_font_size: 16.0,
            viewport_w: self.viewport.width,
            viewport_h: self.viewport.height,
        };

        // Build taffy tree from DOM
        let root = self.build_node(dom, NodeId::DOCUMENT, &ctx);
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

        self.dirty = false;
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
                    self.finish_node(dom, node_id, ctx, mark);
                }
            }
        }
        self.dom_to_taffy.get(&root.to_raw()).copied()
    }

    /// Build the taffy node for `node_id` using already-built children
    /// recorded in `self.dom_to_taffy` (set by prior Finish calls in
    /// post-order). Returns nothing — the result lives in `dom_to_taffy`.
    fn finish_node(&mut self, dom: &Dom, node_id: NodeId, ctx: &ResolveContext, mark: usize) {
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
                        width: Dimension::length(ctx.viewport_w),
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
                // Author rules first (specificity, then source order), inline last —
                // inline always wins, matching the cascade.
                // UA defaults go in first so author rules and inline styles
                // still win over them.
                let mut declarations = ua_declarations(&elem.name.local);
                declarations.extend(svg_intrinsic_declarations(elem));
                declarations.extend(presentational_declarations(elem));
                declarations.extend(self.match_rules(dom, node_id));
                declarations.extend(self.parse_inline_style(elem));
                let computed = ComputedStyle::resolve(&declarations, None);
                if let Some(CssValue::Display(Display::None)) = computed.get(&PropertyId::Display) {
                    return;
                }
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
                    Some(CssValue::Display(d)) => *d,
                    _ => Display::Inline,
                };
                self.css_display.insert(node_id.to_raw(), display);
                let mut taffy_style = computed_to_taffy(&computed, ctx);

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
                    font_size: ctx.font_size,
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

    /// Declarations from author rules that match `node_id`, resolved in cascade
    /// order. Shorthands are expanded by `css_values::parse_property`, so a rule
    /// like `margin: 15vh auto` lands as the four longhands layout actually reads.
    fn match_rules(&self, dom: &Dom, node_id: NodeId) -> HashMap<PropertyId, CssValue> {
        let mut out: HashMap<PropertyId, CssValue> = HashMap::new();
        if self.rules.is_empty() {
            return out;
        }
        let Some(element) = crate::dom::DomElement::new(dom, node_id) else {
            return out;
        };
        // (specificity, source order) per property — later wins ties.
        let mut winner: HashMap<PropertyId, (u32, usize)> = HashMap::new();
        for (order, rule) in self.rules.iter().enumerate() {
            let Some(spec) = rule
                .selectors
                .iter()
                .filter(|sel| crate::css_selectors::matches_selector(&element, sel))
                .map(|sel| {
                    let s = crate::css_selectors::compute_specificity(sel);
                    s.a * 10000 + s.b * 100 + s.c
                })
                .max()
            else {
                continue;
            };
            // Re-serialise and parse through the same path as inline styles so
            // shorthands expand identically. `declarations` is a HashMap, so
            // within-rule source order is already lost upstream — a rule mixing
            // `margin` and `margin-top` can resolve either way.
            let text: String = rule
                .declarations
                .iter()
                .map(|(k, v)| format!("{k}:{v};"))
                .collect();
            let (decls, _) = crate::css_parser::parse_declaration_list(&text);
            for decl in &decls {
                let Ok(props) =
                    crate::css_values::parse_property(decl.name, &decl.value, decl.important)
                else {
                    continue;
                };
                for prop in props {
                    let beats = match winner.get(&prop.property) {
                        Some(&(w_spec, w_order)) => {
                            spec > w_spec || (spec == w_spec && order >= w_order)
                        }
                        None => true,
                    };
                    if beats {
                        winner.insert(prop.property.clone(), (spec, order));
                        out.insert(prop.property, prop.value);
                    }
                }
            }
        }
        out
    }

    fn parse_inline_style(
        &self,
        elem: &crate::dom::node::ElementData,
    ) -> HashMap<PropertyId, CssValue> {
        let mut map = HashMap::new();
        let style_attr = elem.attrs.iter().find(|a| a.name.local == "style");
        if let Some(attr) = style_attr {
            let (decls, _) = crate::css_parser::parse_declaration_list(&attr.value);
            for decl in &decls {
                if let Ok(props) =
                    crate::css_values::parse_property(decl.name, &decl.value, decl.important)
                {
                    for prop in props {
                        map.insert(prop.property, prop.value);
                    }
                }
            }
        }
        map
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
