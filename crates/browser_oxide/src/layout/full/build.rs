//! The box tree of `LayoutMode::Full`, built from the DOM and its styles.
//!
//! Block containers get their block-level children as boxes; a run of inline
//! content between them — text, inline elements, atomic inlines — becomes one
//! anonymous block holding an [`Ifc`](super::ifc::Ifc). Inline elements have no
//! box of their own: they are part of the run that contains them.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use taffy::util::{MaybeResolve, ResolveOrZero};
use taffy::{Dimension, Size, Style};

use super::font::{line_height_px, FontSpec, Metrics};
use super::ifc::{self, InlineBox, Root};
use super::tree::{GroupKind, Role, TableStyle, Tree, VAlign};
use super::{apply_calc, grid};
use crate::css_cascade::ComputedStyle;
use crate::css_values::property::{CssValue, PropertyId};
use crate::css_values::types::content::ContentItem;
use crate::css_values::types::display::{
    Clear as CssClear, Display as CssDisplay, Float as CssFloat, Overflow, Position as CssPosition,
    TextAlign, WhiteSpace,
};
use crate::css_values::types::length::CalcContext;
use crate::dom::node::{NodeData, NodeId as DomId};
use crate::dom::Dom;
use crate::layout::resolve::ResolveContext;
use crate::layout::style_map::computed_to_taffy;
use crate::style::{Pseudo, StyleTree};
use crate::text::ParsedFont;

/// Step limit for the DOM walk: a cycle in the arena panics with a clear message
/// instead of running until the OS gives up.
const BUILD_LIMIT: usize = 100_000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Level {
    /// Has a box of its own and stands alone in a block flow.
    Block,
    /// Has a box of its own and sits in a line.
    Atomic,
    /// Has no box: its content joins the run that contains it.
    Inline,
}

/// One thing a box is made of.
enum Part {
    Node(DomId),
    /// Text a pseudo-element generates, in the style of the given pseudo-element.
    Text(DomId, String),
}

enum Work {
    Visit(DomId),
    /// The node, and how many out-of-flow boxes were pending when its subtree
    /// began: everything past that mark came from inside it.
    Finish(DomId, usize),
}

pub(super) struct Builder<'a> {
    pub dom: &'a Dom,
    pub styles: &'a StyleTree,
    pub ctx: &'a ResolveContext,
    pub os: &'a str,
    pub tree: Tree,
    pub dom_to_node: HashMap<u32, usize>,
    /// The blocks that cut each inline element in two.
    pub block_in_inline: HashMap<u32, Vec<usize>>,
    /// Out-of-flow boxes waiting for their containing block; the flag marks
    /// `position: fixed`.
    abs_pending: Vec<(usize, bool)>,
    css_position: HashMap<u32, CssPosition>,
    css_display: HashMap<u32, CssDisplay>,
    /// Boxes with a percentage vertical padding or margin, which taffy resolves
    /// against the parent's height instead of its width.
    pub vertical_percent: Vec<usize>,
    /// Parsed fonts and their metrics, by what makes them different.
    fonts: RefCell<HashMap<FontKey, (ParsedFont, Metrics)>>,
}

/// Families, size in bits, weight, italic.
type FontKey = (String, u32, u16, bool);

fn is_replaced(tag: &str) -> bool {
    matches!(
        tag,
        "img"
            | "canvas"
            | "video"
            | "audio"
            | "iframe"
            | "embed"
            | "object"
            | "svg"
            | "input"
            | "textarea"
            | "select"
            | "meter"
            | "progress"
    )
}

impl<'a> Builder<'a> {
    pub fn new(dom: &'a Dom, styles: &'a StyleTree, ctx: &'a ResolveContext, os: &'a str) -> Self {
        Self {
            dom,
            styles,
            ctx,
            os,
            tree: Tree::default(),
            dom_to_node: HashMap::new(),
            block_in_inline: HashMap::new(),
            abs_pending: Vec::new(),
            css_position: HashMap::new(),
            css_display: HashMap::new(),
            vertical_percent: Vec::new(),
            fonts: RefCell::new(HashMap::new()),
        }
    }

    /// The font an element is set in, parsed, with its vertical metrics.
    fn font(&self, c: &ComputedStyle, size: f32) -> (ParsedFont, Metrics) {
        let spec = FontSpec::from_computed(c, size);
        let key = (
            spec.families.clone(),
            size.to_bits(),
            spec.weight,
            spec.italic,
        );
        self.fonts
            .borrow_mut()
            .entry(key)
            .or_insert_with(|| {
                let mut parsed = spec.parsed();
                if size <= 0.0 {
                    // `font-size: 0` takes no room at all.
                    parsed.size_px = 0.0;
                    let none = Metrics {
                        ascent: 0.0,
                        descent: 0.0,
                        line_gap: 0.0,
                    };
                    return (parsed, none);
                }
                let metrics = Metrics::of(&parsed, self.os);
                (parsed, metrics)
            })
            .clone()
    }

    pub fn build(&mut self, on_style: &mut dyn FnMut(DomId, &ComputedStyle)) {
        let mut stack = vec![Work::Visit(DomId::DOCUMENT)];
        let mut visited: HashSet<DomId> = HashSet::with_capacity(64);
        let mut steps = 0usize;
        while let Some(work) = stack.pop() {
            match work {
                Work::Visit(id) => {
                    if !visited.insert(id) {
                        continue;
                    }
                    steps += 1;
                    assert!(steps <= BUILD_LIMIT, "layout build cycle at {id:?}");
                    stack.push(Work::Finish(id, self.abs_pending.len()));
                    // An outer SVG is a replaced element: its graphics tree has its
                    // own viewport and must not size the box around it.
                    let is_svg = self
                        .dom
                        .get(id)
                        .and_then(|n| n.as_element())
                        .is_some_and(|e| e.name.local.eq_ignore_ascii_case("svg"));
                    if !is_svg {
                        for c in self.child_ids(id).into_iter().rev() {
                            stack.push(Work::Visit(c));
                        }
                    }
                }
                Work::Finish(id, mark) => self.finish(id, mark, on_style),
            }
        }
    }

    fn display_of(&self, id: DomId) -> CssDisplay {
        match self
            .styles
            .get(id)
            .and_then(|c| c.get(&PropertyId::Display))
        {
            Some(CssValue::Display(d)) => *d,
            _ => CssDisplay::Inline,
        }
    }

    fn position_of(&self, id: DomId) -> CssPosition {
        match self
            .styles
            .get(id)
            .and_then(|c| c.get(&PropertyId::Position))
        {
            Some(CssValue::Position(p)) => *p,
            _ => CssPosition::Static,
        }
    }

    fn float_of(&self, id: DomId) -> CssFloat {
        match self.styles.get(id).and_then(|c| c.get(&PropertyId::Float)) {
            Some(CssValue::Float(f)) => *f,
            _ => CssFloat::None,
        }
    }

    fn tag(&self, id: DomId) -> String {
        self.dom
            .get(id)
            .and_then(|n| n.as_element())
            .map(|e| e.name.local.to_ascii_lowercase())
            .unwrap_or_default()
    }

    fn level(&self, id: DomId) -> Level {
        let display = self.display_of(id);
        if matches!(
            self.position_of(id),
            CssPosition::Absolute | CssPosition::Fixed
        ) || self.float_of(id) != CssFloat::None
        {
            return Level::Block;
        }
        // Children of a flex or grid container are blockified.
        let parent_blockifies = self.parent_of(id).is_some_and(|p| {
            matches!(
                self.display_of(p),
                CssDisplay::Flex
                    | CssDisplay::InlineFlex
                    | CssDisplay::Grid
                    | CssDisplay::InlineGrid
            )
        });
        let level = match display {
            CssDisplay::Inline | CssDisplay::Contents => {
                if is_replaced(&self.tag(id)) {
                    Level::Atomic
                } else {
                    Level::Inline
                }
            }
            CssDisplay::InlineBlock
            | CssDisplay::InlineFlex
            | CssDisplay::InlineGrid
            | CssDisplay::InlineTable => Level::Atomic,
            _ => Level::Block,
        };
        if parent_blockifies && level != Level::Block {
            Level::Block
        } else {
            level
        }
    }

    /// What `id` is made of, in order: the box of its `::before`, its children, the
    /// box of its `::after`. A pseudo-element holds the text its `content` makes.
    fn parts(&self, id: DomId) -> Vec<Part> {
        if self.styles.is_pseudo(id) {
            return self.generated(id);
        }
        let mut out = Vec::new();
        out.extend(self.styles.pseudo(id, Pseudo::Before).map(Part::Node));
        out.extend(self.dom.children(id).into_iter().map(Part::Node));
        out.extend(self.styles.pseudo(id, Pseudo::After).map(Part::Node));
        out
    }

    /// The boxes below `id` that the walk visits.
    fn child_ids(&self, id: DomId) -> Vec<DomId> {
        if self.styles.is_pseudo(id) {
            return Vec::new();
        }
        self.parts(id)
            .into_iter()
            .filter_map(|p| match p {
                Part::Node(c) => Some(c),
                Part::Text(..) => None,
            })
            .collect()
    }

    fn parent_of(&self, id: DomId) -> Option<DomId> {
        if self.styles.is_pseudo(id) {
            return self.styles.owner(id);
        }
        self.dom.get(id).and_then(|n| n.parent)
    }

    /// The text of a pseudo-element's `content`. Images and counters are not
    /// generated: there is nothing to draw, and nothing counted.
    fn generated(&self, pseudo: DomId) -> Vec<Part> {
        let Some(CssValue::Content(items)) = self
            .styles
            .get(pseudo)
            .and_then(|c| c.get(&PropertyId::Content))
        else {
            return Vec::new();
        };
        let owner = self.styles.owner(pseudo).and_then(|o| self.dom.get(o));
        items
            .iter()
            .filter_map(|item| {
                let text = match item {
                    ContentItem::Str(s) => s.clone(),
                    ContentItem::Attr(name) => owner
                        .and_then(|n| n.as_element())
                        .and_then(|e| {
                            e.attrs
                                .iter()
                                .find(|a| a.name.local.eq_ignore_ascii_case(name))
                        })
                        .map(|a| a.value.to_string())
                        .unwrap_or_default(),
                    ContentItem::OpenQuote => "\u{201C}".to_string(),
                    ContentItem::CloseQuote => "\u{201D}".to_string(),
                    ContentItem::Url(_)
                    | ContentItem::NoOpenQuote
                    | ContentItem::NoCloseQuote
                    | ContentItem::Counter(_) => return None,
                };
                Some(Part::Text(pseudo, text))
            })
            .collect()
    }

    /// Move the out-of-flow children of `id` to the pending list.
    fn take_out_of_flow(&mut self, id: DomId) {
        for cid in self.child_ids(id) {
            let Some(child) = self.dom_to_node.get(&cid.to_raw()).copied() else {
                continue;
            };
            match self.css_position.get(&cid.to_raw()) {
                Some(CssPosition::Absolute) => self.abs_pending.push((child, false)),
                Some(CssPosition::Fixed) => self.abs_pending.push((child, true)),
                _ => {}
            }
        }
    }

    fn finish(&mut self, id: DomId, mark: usize, on_style: &mut dyn FnMut(DomId, &ComputedStyle)) {
        let Some(node) = self.dom.get(id) else {
            if self.styles.is_pseudo(id) {
                if let Some(n) = self.finish_element(id, mark, None, on_style) {
                    self.dom_to_node.insert(id.to_raw(), n);
                }
            }
            return;
        };
        let built = match &node.data {
            NodeData::Document | NodeData::DocumentFragment => {
                let mut children = self.assemble(id);
                // The initial containing block holds whatever found no positioned
                // ancestor, `fixed` boxes included.
                self.take_out_of_flow(id);
                children.extend(self.abs_pending.drain(..).map(|(n, _)| n));
                let style = Style {
                    display: taffy::Display::Block,
                    // The initial containing block is the size of the viewport, and
                    // what `fixed` and unanchored `absolute` boxes are placed in.
                    size: Size {
                        width: Dimension::length(self.ctx.viewport_w),
                        height: Dimension::length(self.ctx.viewport_h),
                    },
                    ..Default::default()
                };
                self.tree.add(style, children)
            }
            NodeData::Element(elem) => match self.finish_element(id, mark, Some(elem), on_style) {
                Some(n) => n,
                None => return,
            },
            _ => return,
        };
        self.dom_to_node.insert(id.to_raw(), built);
    }

    /// The layout node of an element, or of a pseudo-element (`elem` is `None`).
    /// `None` when the element has no box of its own.
    fn finish_element(
        &mut self,
        id: DomId,
        mark: usize,
        elem: Option<&crate::dom::node::ElementData>,
        on_style: &mut dyn FnMut(DomId, &ComputedStyle),
    ) -> Option<usize> {
        let tag = self.tag(id);
        let attrs: &[crate::dom::node::Attribute] = elem.map_or(&[], |e| &e.attrs[..]);
        let computed = self.styles.get(id)?;
        let position = self.position_of(id);
        self.css_position.insert(id.to_raw(), position);
        self.css_display.insert(id.to_raw(), self.display_of(id));
        on_style(id, computed);
        self.take_out_of_flow(id);
        if self.level(id) == Level::Inline {
            return None;
        }
        let font_size = self.styles.font_size(id);
        let ctx = ResolveContext {
            font_size,
            ..*self.ctx
        };
        let replaced = is_replaced(&tag);
        let role = match self.display_of(id) {
            CssDisplay::Table | CssDisplay::InlineTable => Role::Table,
            CssDisplay::TableHeaderGroup => Role::Group(GroupKind::Header),
            CssDisplay::TableFooterGroup => Role::Group(GroupKind::Footer),
            CssDisplay::TableRowGroup => Role::Group(GroupKind::Body),
            CssDisplay::TableRow => Role::Row,
            CssDisplay::TableCell => Role::Cell,
            // Columns are not boxes; captions are not laid out yet.
            CssDisplay::TableColumn | CssDisplay::TableColumnGroup | CssDisplay::TableCaption => {
                return None
            }
            _ => Role::None,
        };
        let mut children = if replaced {
            Vec::new()
        } else if matches!(role, Role::Table | Role::Group(_) | Role::Row) {
            self.table_children(id)
        } else {
            self.assemble(id)
        };
        // A positioned box is a containing block for the absolutes beneath
        // it; `fixed` keeps rising to the viewport.
        if !matches!(position, CssPosition::Static) {
            let mut i = mark;
            while i < self.abs_pending.len() {
                if self.abs_pending[i].1 {
                    i += 1;
                } else {
                    children.push(self.abs_pending.remove(i).0);
                }
            }
        }

        let mut style = computed_to_taffy(computed, &ctx);
        // A box that starts a block formatting context keeps the margins of
        // its children inside; taffy does that for scroll containers.
        let clips = [PropertyId::OverflowX, PropertyId::OverflowY]
            .iter()
            .any(|p| {
                matches!(
                    computed.get(p),
                    Some(CssValue::Overflow(o)) if !matches!(o, Overflow::Visible | Overflow::Clip)
                )
            });
        if clips
            || tag == "html"
            || self.float_of(id) != CssFloat::None
            || matches!(position, CssPosition::Absolute | CssPosition::Fixed)
            || matches!(
                self.display_of(id),
                CssDisplay::FlowRoot
                    | CssDisplay::InlineBlock
                    | CssDisplay::InlineFlex
                    | CssDisplay::InlineGrid
                    | CssDisplay::TableCell
            )
        {
            style.overflow = taffy::Point {
                x: taffy::Overflow::Hidden,
                y: taffy::Overflow::Hidden,
            };
        }
        if !matches!(position, CssPosition::Absolute | CssPosition::Fixed) {
            style.float = match self.float_of(id) {
                CssFloat::Left | CssFloat::InlineStart => taffy::Float::Left,
                CssFloat::Right | CssFloat::InlineEnd => taffy::Float::Right,
                CssFloat::None => taffy::Float::None,
            };
            if let Some(CssValue::Clear(c)) = computed.get(&PropertyId::Clear) {
                style.clear = match c {
                    CssClear::Left | CssClear::InlineStart => taffy::Clear::Left,
                    CssClear::Right | CssClear::InlineEnd => taffy::Clear::Right,
                    CssClear::Both => taffy::Clear::Both,
                    CssClear::None => taffy::Clear::None,
                };
            }
        }
        let calc_ctx = CalcContext {
            viewport_w: f64::from(self.ctx.viewport_w),
            viewport_h: f64::from(self.ctx.viewport_h),
            root_font_size_px: f64::from(self.ctx.root_font_size),
            font_size_px: f64::from(font_size),
            container_w: f64::from(self.ctx.viewport_w),
            container_h: f64::from(self.ctx.viewport_h),
            percentage_base_px: 0.0,
        };
        apply_calc(&mut self.tree, computed, &mut style, calc_ctx);
        // Placement in a grid parent. Inert elsewhere.
        {
            let text = |p: PropertyId| match computed.get(&p) {
                Some(CssValue::CustomValue(s)) => s.as_str(),
                _ => "auto",
            };
            let (row, column) = grid::area(text(PropertyId::GridArea));
            style.grid_row = row;
            style.grid_column = column;
            if text(PropertyId::GridRow) != "auto" {
                style.grid_row = grid::placement(text(PropertyId::GridRow));
            }
            if text(PropertyId::GridColumn) != "auto" {
                style.grid_column = grid::placement(text(PropertyId::GridColumn));
            }
            for (prop, set) in [
                (PropertyId::GridRowStart, 0),
                (PropertyId::GridRowEnd, 1),
                (PropertyId::GridColumnStart, 2),
                (PropertyId::GridColumnEnd, 3),
            ] {
                let t = text(prop);
                if t == "auto" {
                    continue;
                }
                let p = grid::side(t, set % 2 == 1);
                match set {
                    0 => style.grid_row.start = p,
                    1 => style.grid_row.end = p,
                    2 => style.grid_column.start = p,
                    _ => style.grid_column.end = p,
                }
            }
        }
        if style.display == taffy::Display::Grid {
            let text = |p: PropertyId| match computed.get(&p) {
                Some(CssValue::CustomValue(s)) => s.as_str(),
                _ => "none",
            };
            style.grid_template_columns =
                grid::template(text(PropertyId::GridTemplateColumns), &ctx)
                    .into_iter()
                    .collect();
            style.grid_template_rows = grid::template(text(PropertyId::GridTemplateRows), &ctx)
                .into_iter()
                .collect();
            style.grid_template_areas = grid::areas(text(PropertyId::GridTemplateAreas))
                .into_iter()
                .collect();
            style.grid_auto_flow = grid::auto_flow(text(PropertyId::GridAutoFlow));
            style.grid_auto_rows = grid::auto_tracks(text(PropertyId::GridAutoRows), &ctx)
                .into_iter()
                .collect();
            style.grid_auto_columns = grid::auto_tracks(text(PropertyId::GridAutoColumns), &ctx)
                .into_iter()
                .collect();
        }

        let is_percent = |v: taffy::LengthPercentage| v.maybe_resolve(None, |_, _| 0.0).is_none();
        let is_percent_auto = |v: taffy::LengthPercentageAuto| {
            v.maybe_resolve(None, |_, _| 0.0).is_none() && !v.is_auto()
        };
        let has_vertical_percent = is_percent(style.padding.top)
            || is_percent(style.padding.bottom)
            || is_percent_auto(style.margin.top)
            || is_percent_auto(style.margin.bottom);

        // Quirks mode stretches the root boxes to the viewport.
        if self.dom.quirks() && matches!(&*tag, "html" | "body") && style.size.height.is_auto() {
            let margins = [style.margin.top, style.margin.bottom]
                .iter()
                .map(|m| {
                    m.resolve_to_option(ctx.viewport_h, |_, _| 0.0)
                        .unwrap_or(0.0)
                })
                .sum::<f32>();
            style.min_size.height = Dimension::length((ctx.viewport_h - margins).max(0.0));
        }
        let id_node = self.tree.add(style, children);
        self.tree.nodes[id_node].role = role;
        if role == Role::Table {
            self.tree.nodes[id_node].table = Some(self.table_style(computed));
        }
        if role == Role::Cell {
            let span = |name: &str| {
                attrs
                    .iter()
                    .find(|a| a.name.local.eq_ignore_ascii_case(name))
                    .and_then(|a| a.value.trim().parse::<usize>().ok())
                    .unwrap_or(1)
                    .clamp(1, 1000)
            };
            self.tree.nodes[id_node].span = (span("colspan"), span("rowspan"));
            self.tree.nodes[id_node].valign = self.valign_of(computed);
        }
        if has_vertical_percent {
            self.vertical_percent.push(id_node);
        }
        Some(id_node)
    }

    /// The children of a table, row group or row that are table parts.
    fn table_children(&self, id: DomId) -> Vec<usize> {
        self.dom
            .children(id)
            .into_iter()
            .filter_map(|c| self.dom_to_node.get(&c.to_raw()).copied())
            .filter(|&n| self.tree.nodes[n].role != Role::None)
            .collect()
    }

    fn table_style(&self, c: &ComputedStyle) -> TableStyle {
        let text = |p: PropertyId| match c.get(&p) {
            Some(CssValue::CustomValue(s)) => s.clone(),
            _ => String::new(),
        };
        let collapse = text(PropertyId::BorderCollapse).trim() == "collapse";
        let spacing = text(PropertyId::BorderSpacing);
        let mut lengths = spacing
            .split_whitespace()
            .filter_map(|t| t.strip_suffix("px").and_then(|n| n.parse::<f32>().ok()));
        let x = lengths.next().unwrap_or(0.0);
        let y = lengths.next().unwrap_or(x);
        TableStyle {
            collapse,
            spacing: (x, y),
        }
    }

    fn valign_of(&self, c: &ComputedStyle) -> VAlign {
        match c.get(&PropertyId::VerticalAlign) {
            Some(CssValue::CustomValue(s)) => match s.trim() {
                "top" => VAlign::Top,
                "bottom" => VAlign::Bottom,
                _ => VAlign::Middle,
            },
            _ => VAlign::Middle,
        }
    }

    /// The boxes inside the container `cont`: its block-level children, and an
    /// anonymous block for each run of inline content between them.
    fn assemble(&mut self, cont: DomId) -> Vec<usize> {
        let mut out = Vec::new();
        let mut run: Option<(ifc::Builder, Vec<usize>)> = None;
        for part in self.parts(cont) {
            let c = match part {
                Part::Text(owner, text) => {
                    let (b, _) = run.get_or_insert_with(|| (self.run_builder(cont), Vec::new()));
                    self.add_text(b, owner, &text, cont);
                    continue;
                }
                Part::Node(c) => c,
            };
            let text = match self.dom.get(c).map(|n| &n.data) {
                Some(NodeData::Text(text)) => Some(text),
                Some(NodeData::Element(_)) => None,
                None if self.styles.is_pseudo(c) => None,
                _ => continue,
            };
            if let Some(text) = text {
                let (b, _) = run.get_or_insert_with(|| (self.run_builder(cont), Vec::new()));
                self.add_text(b, c, text, cont);
                continue;
            }
            if self.styles.get(c).is_none() {
                continue;
            }
            if matches!(
                self.position_of(c),
                CssPosition::Absolute | CssPosition::Fixed
            ) {
                continue;
            }
            match self.level(c) {
                Level::Block => {
                    self.flush(&mut run, &mut out);
                    if let Some(&n) = self.dom_to_node.get(&c.to_raw()) {
                        out.push(n);
                    }
                }
                Level::Atomic | Level::Inline => {
                    run.get_or_insert_with(|| (self.run_builder(cont), Vec::new()));
                    self.collect(cont, &mut run, &mut out, &mut Vec::new(), c);
                }
            }
        }
        self.flush(&mut run, &mut out);
        out
    }

    fn flush(&mut self, run: &mut Option<(ifc::Builder, Vec<usize>)>, out: &mut Vec<usize>) {
        let Some((builder, atomics)) = run.take() else {
            return;
        };
        if let Some(ifc) = builder.finish() {
            out.push(self.tree.add_ifc(Style::default(), ifc, atomics));
        }
    }

    fn run_builder(&self, cont: DomId) -> ifc::Builder {
        let c = self.styles.get(cont);
        let size = self.styles.font_size(cont);
        let (metrics, lh, align) = match c {
            Some(c) => {
                let (_, m) = self.font(c, size);
                let ctx = ResolveContext {
                    font_size: size,
                    ..*self.ctx
                };
                let lh = line_height_px(c, size, &m, &ctx);
                let align = match c.get(&PropertyId::TextAlign) {
                    Some(CssValue::TextAlign(a)) => *a,
                    _ => TextAlign::Start,
                };
                (m, lh, align)
            }
            None => {
                let font = FontSpec {
                    families: "serif".into(),
                    size,
                    weight: 400,
                    italic: false,
                }
                .parsed();
                let m = Metrics::of(&font, self.os);
                let lh = m.normal_line_height();
                (m, lh, TextAlign::Start)
            }
        };
        let (asc_l, desc_l) = metrics.with_leading(lh);
        ifc::Builder::new(
            Root {
                dom: cont.to_raw(),
                align,
                ascent: metrics.ascent,
                descent: metrics.descent,
                asc_l,
                desc_l,
                quirks: self.dom.quirks(),
            },
            self.os,
        )
    }

    fn add_text(&self, b: &mut ifc::Builder, text_id: DomId, text: &str, parent: DomId) {
        let Some(c) = self.styles.get(parent) else {
            return;
        };
        let (font, _) = self.font(c, self.styles.font_size(parent));
        let white = match c.get(&PropertyId::WhiteSpace) {
            Some(CssValue::WhiteSpace(w)) => *w,
            _ => WhiteSpace::Normal,
        };
        b.text(text_id.to_raw(), text, &font, white);
    }

    /// Add the inline-level element `id` to the run being built. `open` holds the
    /// inline elements around it; a block among them ends the run, goes to `out`,
    /// and the elements open again in a new run after it.
    fn collect(
        &mut self,
        cont: DomId,
        run: &mut Option<(ifc::Builder, Vec<usize>)>,
        out: &mut Vec<usize>,
        open: &mut Vec<DomId>,
        id: DomId,
    ) {
        let Some(computed) = self.styles.get(id) else {
            return;
        };
        if matches!(
            self.position_of(id),
            CssPosition::Absolute | CssPosition::Fixed
        ) {
            return;
        }
        match self.level(id) {
            Level::Inline => {
                match self.tag(id).as_str() {
                    "br" => {
                        if let Some((b, _)) = run.as_mut() {
                            b.line_break();
                        }
                        return;
                    }
                    "wbr" => {
                        if let Some((b, _)) = run.as_mut() {
                            b.break_opportunity();
                        }
                        return;
                    }
                    _ => {}
                }
                let boxed = self.inline_box(id, computed);
                if let Some((b, _)) = run.as_mut() {
                    b.open(boxed);
                }
                open.push(id);
                for part in self.parts(id) {
                    match part {
                        Part::Text(owner, t) => {
                            if let Some((b, _)) = run.as_mut() {
                                self.add_text(b, owner, &t, id);
                            }
                        }
                        Part::Node(c) => match self.dom.get(c).map(|n| &n.data) {
                            Some(NodeData::Text(t)) => {
                                if let Some((b, _)) = run.as_mut() {
                                    self.add_text(b, c, t, id);
                                }
                            }
                            Some(NodeData::Element(_)) => self.collect(cont, run, out, open, c),
                            None if self.styles.is_pseudo(c) => {
                                self.collect(cont, run, out, open, c)
                            }
                            _ => {}
                        },
                    }
                }
                open.pop();
                if let Some((b, _)) = run.as_mut() {
                    b.close();
                }
            }
            Level::Block if self.float_of(id) == CssFloat::None && !open.is_empty() => {
                let Some(&n) = self.dom_to_node.get(&id.to_raw()) else {
                    return;
                };
                if let Some((b, _)) = run.as_mut() {
                    for _ in open.iter() {
                        b.close_sliced();
                    }
                }
                self.flush(run, out);
                out.push(n);
                for a in open.iter() {
                    self.block_in_inline.entry(a.to_raw()).or_default().push(n);
                }
                let mut next = (self.run_builder(cont), Vec::new());
                for &ancestor in open.iter() {
                    if let Some(c) = self.styles.get(ancestor) {
                        let continued = InlineBox {
                            margin_left: 0.0,
                            border_left: 0.0,
                            padding_left: 0.0,
                            ..self.inline_box(ancestor, c)
                        };
                        next.0.open(continued);
                    }
                }
                *run = Some(next);
            }
            // A float or an atomic inline sits in the line as an atom.
            Level::Atomic | Level::Block => {
                if let (Some(&n), Some((b, atomics))) =
                    (self.dom_to_node.get(&id.to_raw()), run.as_mut())
                {
                    atomics.push(n);
                    b.atomic(n);
                }
            }
        }
    }

    fn inline_box(&self, id: DomId, c: &ComputedStyle) -> InlineBox {
        let size = self.styles.font_size(id);
        let ctx = ResolveContext {
            font_size: size,
            ..*self.ctx
        };
        let (_, m) = self.font(c, size);
        let lh = line_height_px(c, size, &m, &ctx);
        let (asc_l, desc_l) = m.with_leading(lh);
        let ts = computed_to_taffy(c, &ctx);
        let lp = |v: taffy::LengthPercentage| v.resolve_or_zero(None, |_, _| 0.0);
        let margin =
            |v: taffy::LengthPercentageAuto| v.maybe_resolve(Some(0.0), |_, _| 0.0).unwrap_or(0.0);
        InlineBox {
            dom: id.to_raw(),
            ascent: m.ascent,
            descent: m.descent,
            asc_l,
            desc_l,
            margin_left: margin(ts.margin.left),
            margin_right: margin(ts.margin.right),
            border_left: lp(ts.border.left),
            border_right: lp(ts.border.right),
            padding_left: lp(ts.padding.left),
            padding_right: lp(ts.padding.right),
            border_top: lp(ts.border.top),
            border_bottom: lp(ts.border.bottom),
            padding_top: lp(ts.padding.top),
            padding_bottom: lp(ts.padding.bottom),
        }
    }
}
