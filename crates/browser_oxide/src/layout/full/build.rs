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

use super::font::{family_list, line_height_px, FontSpec, Metrics};
use super::ifc::{self, InlineBox, Lift, Root};
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
    /// An image a pseudo-element generates, with its natural size.
    Image(f32, f32),
}

enum Work {
    Visit(DomId),
    /// The node, how many out-of-flow boxes were pending when its subtree began
    /// (everything past that mark came from inside it), and how many counters were
    /// in scope once the node had made its own: those made inside end with it.
    Finish(DomId, usize, usize),
}

/// A counter of CSS counters, in scope.
struct Counter {
    name: String,
    value: i32,
}

/// What a pseudo-element's `content` made.
enum Generated {
    Text(String),
    Image(f32, f32),
}

/// A counter value as text, in a `list-style-type`.
fn format_counter(n: i32, style: &str) -> String {
    let alpha = |upper: bool| {
        if n < 1 {
            return n.to_string();
        }
        let (mut out, mut k) = (Vec::new(), n as u32);
        while k > 0 {
            k -= 1;
            out.push(((k % 26) as u8 + if upper { b'A' } else { b'a' }) as char);
            k /= 26;
        }
        out.iter().rev().collect::<String>()
    };
    let roman = |upper: bool| {
        if !(1..4000).contains(&n) {
            return n.to_string();
        }
        let table = [
            (1000, "m"),
            (900, "cm"),
            (500, "d"),
            (400, "cd"),
            (100, "c"),
            (90, "xc"),
            (50, "l"),
            (40, "xl"),
            (10, "x"),
            (9, "ix"),
            (5, "v"),
            (4, "iv"),
            (1, "i"),
        ];
        let mut rest = n;
        let mut out = String::new();
        for (v, s) in table {
            while rest >= v {
                out.push_str(s);
                rest -= v;
            }
        }
        if upper {
            out.to_uppercase()
        } else {
            out
        }
    };
    match style.trim().to_ascii_lowercase().as_str() {
        "lower-alpha" | "lower-latin" => alpha(false),
        "upper-alpha" | "upper-latin" => alpha(true),
        "lower-roman" => roman(false),
        "upper-roman" => roman(true),
        "decimal-leading-zero" => format!("{n:02}"),
        "disc" => "\u{2022}".to_string(),
        "circle" => "\u{25E6}".to_string(),
        "square" => "\u{25AA}".to_string(),
        "none" => String::new(),
        _ => n.to_string(),
    }
}

pub(super) struct Builder<'a> {
    /// Device pixels per CSS pixel: border widths are whole device pixels.
    dpr: f32,
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
    /// Each out-of-flow box with the empty box that stands where it would have
    /// been in the flow of its parent, for finding its static position.
    pub static_pending: Vec<(usize, usize)>,
    /// Parsed fonts and their metrics, by what makes them different.
    fonts: RefCell<HashMap<FontKey, (ParsedFont, Metrics)>>,
    /// The CSS counters in scope where the walk is.
    counters: Vec<Counter>,
    /// The content of each pseudo-element, made where the walk met it.
    pseudo_parts: HashMap<u32, Vec<Generated>>,
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
    pub fn new(
        dom: &'a Dom,
        styles: &'a StyleTree,
        ctx: &'a ResolveContext,
        os: &'a str,
        dpr: f32,
    ) -> Self {
        Self {
            dpr,
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
            static_pending: Vec::new(),
            fonts: RefCell::new(HashMap::new()),
            counters: Vec::new(),
            pseudo_parts: HashMap::new(),
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
                        x_height: 0.0,
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
                    self.enter_counters(id);
                    if self.styles.is_pseudo(id) {
                        self.fill_generated(id);
                    }
                    stack.push(Work::Finish(
                        id,
                        self.abs_pending.len(),
                        self.counters.len(),
                    ));
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
                Work::Finish(id, mark, counters) => {
                    self.finish(id, mark, on_style);
                    self.counters.truncate(counters);
                }
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

    /// A replaced box of a given size, for an image in generated content.
    fn image_box(&mut self, w: f32, h: f32) -> usize {
        let style = Style {
            display: taffy::Display::Block,
            size: Size {
                width: Dimension::length(w),
                height: Dimension::length(h),
            },
            ..Default::default()
        };
        self.tree.add(style, Vec::new())
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
                Part::Text(..) | Part::Image(..) => None,
            })
            .collect()
    }

    fn parent_of(&self, id: DomId) -> Option<DomId> {
        if self.styles.is_pseudo(id) {
            return self.styles.owner(id);
        }
        self.dom.get(id).and_then(|n| n.parent)
    }

    /// What a pseudo-element's `content` made when the walk reached it.
    fn generated(&self, pseudo: DomId) -> Vec<Part> {
        self.pseudo_parts
            .get(&pseudo.to_raw())
            .map(|parts| {
                parts
                    .iter()
                    .map(|p| match p {
                        Generated::Text(t) => Part::Text(pseudo, t.clone()),
                        Generated::Image(w, h) => Part::Image(*w, *h),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The counters of `id`: `counter-reset` makes new ones, `counter-increment`
    /// adds to the innermost of that name (making one if there is none), and
    /// `counter-set` sets it.
    fn enter_counters(&mut self, id: DomId) {
        let Some(c) = self.styles.get(id) else { return };
        let ops = |prop: PropertyId, default: i32| -> Vec<(String, i32)> {
            let Some(CssValue::CustomValue(text)) = c.get(&prop) else {
                return Vec::new();
            };
            let words: Vec<&str> = text.split_whitespace().collect();
            let (mut out, mut i) = (Vec::new(), 0);
            while i < words.len() {
                let name = words[i];
                let value = words.get(i + 1).and_then(|w| w.parse::<i32>().ok());
                i += if value.is_some() { 2 } else { 1 };
                if name != "none" {
                    out.push((name.to_string(), value.unwrap_or(default)));
                }
            }
            out
        };
        let (reset, increment, set) = (
            ops(PropertyId::CounterReset, 0),
            ops(PropertyId::CounterIncrement, 1),
            ops(PropertyId::CounterSet, 0),
        );
        for (name, value) in reset {
            self.counters.push(Counter { name, value });
        }
        for (name, by) in increment {
            match self.counters.iter_mut().rev().find(|c| c.name == name) {
                Some(c) => c.value += by,
                None => self.counters.push(Counter { name, value: by }),
            }
        }
        for (name, to) in set {
            match self.counters.iter_mut().rev().find(|c| c.name == name) {
                Some(c) => c.value = to,
                None => self.counters.push(Counter { name, value: to }),
            }
        }
    }

    /// Work out the `content` of the pseudo-element `pseudo` where the walk is:
    /// the counters are what they are here.
    fn fill_generated(&mut self, pseudo: DomId) {
        let Some(CssValue::Content(items)) = self
            .styles
            .get(pseudo)
            .and_then(|c| c.get(&PropertyId::Content))
        else {
            return;
        };
        let owner = self.styles.owner(pseudo).and_then(|o| self.dom.get(o));
        let parts: Vec<Generated> = items
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
                    ContentItem::Url(url) => {
                        return super::image::natural_size(url).map(|(w, h)| Generated::Image(w, h))
                    }
                    ContentItem::NoOpenQuote | ContentItem::NoCloseQuote => return None,
                    ContentItem::Counter { name, style } => {
                        let value = self
                            .counters
                            .iter()
                            .rev()
                            .find(|c| &c.name == name)
                            .map_or(0, |c| c.value);
                        format_counter(value, style)
                    }
                    ContentItem::Counters { name, sep, style } => {
                        let values: Vec<String> = self
                            .counters
                            .iter()
                            .filter(|c| &c.name == name)
                            .map(|c| format_counter(c.value, style))
                            .collect();
                        if values.is_empty() {
                            format_counter(0, style)
                        } else {
                            values.join(sep)
                        }
                    }
                };
                Some(Generated::Text(text))
            })
            .collect();
        self.pseudo_parts.insert(pseudo.to_raw(), parts);
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
        // The contents of a closed disclosure are laid out, so that they have
        // rectangles, in a box of no height after the summary (which also keeps
        // the summary's bottom margin from collapsing out of the element).
        if tag == "details" && elem.is_some() {
            let open = attrs
                .iter()
                .any(|a| a.name.local.eq_ignore_ascii_case("open"));
            let summary = self
                .dom
                .children(id)
                .into_iter()
                .find(|&c| self.tag(c) == "summary")
                .and_then(|c| self.dom_to_node.get(&c.to_raw()).copied());
            let (kept, contents): (Vec<usize>, Vec<usize>) =
                children.iter().partition(|&&c| Some(c) == summary);
            // Closed, the slot has no height; either way it is a block formatting
            // context, so the margins of its contents stay inside the element.
            let slot = Style {
                display: taffy::Display::Block,
                size: Size {
                    width: Dimension::auto(),
                    height: if open {
                        Dimension::auto()
                    } else {
                        Dimension::length(0.0)
                    },
                },
                overflow: taffy::Point {
                    x: taffy::Overflow::Hidden,
                    y: taffy::Overflow::Hidden,
                },
                ..Default::default()
            };
            let slot = self.tree.add(slot, contents);
            self.tree.nodes[slot].paint_hidden = !open;
            children = kept;
            children.push(slot);
        }
        // The marker of a list item is a line of its own when the item holds nothing.
        let marker_shown = !matches!(
            computed.get(&PropertyId::ListStyleType),
            Some(CssValue::CustomValue(t)) if t.trim() == "none"
        );
        if elem.is_some()
            && marker_shown
            && children.is_empty()
            && self.display_of(id) == CssDisplay::ListItem
        {
            let mut b = self.run_builder(id);
            b.line_break();
            if let Some(ifc) = b.finish() {
                let block = Style {
                    display: taffy::Display::Block,
                    ..Default::default()
                };
                children.push(self.tree.add_ifc(block, ifc, Vec::new()));
            }
        }
        // A button centres its content vertically: the content is one block in a
        // column the button centres.
        let is_button = elem.is_some() && tag == "button";
        if is_button && !children.is_empty() {
            let inner = Style {
                display: taffy::Display::Block,
                ..Default::default()
            };
            children = vec![self.tree.add(inner, std::mem::take(&mut children))];
        }
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
        self.snap_borders(&mut style);
        if position == CssPosition::Sticky {
            // At the top of the page a sticky box has not moved: it is where it
            // would be if static, whatever its offsets.
            style.inset = taffy::Rect {
                left: taffy::LengthPercentageAuto::auto(),
                right: taffy::LengthPercentageAuto::auto(),
                top: taffy::LengthPercentageAuto::auto(),
                bottom: taffy::LengthPercentageAuto::auto(),
            };
        }
        let control_baseline = if elem.is_some() {
            self.size_control(id, &tag, attrs, computed, font_size, &mut style)
        } else {
            None
        };
        if is_button && style.display == taffy::Display::Block {
            style.display = taffy::Display::Flex;
            style.flex_direction = taffy::FlexDirection::Column;
            style.justify_content = Some(taffy::AlignContent::CENTER);
        }
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
        // A fieldset's legend sits where the top border is, as wide as it needs: a
        // float pulled up over the border and padding, with a clearing box of the
        // padding's height after it.
        if tag == "fieldset" && elem.is_some() {
            let legend = self
                .dom
                .children(id)
                .into_iter()
                .find(|&c| self.dom.get(c).is_some_and(|n| n.as_element().is_some()))
                .filter(|&c| self.tag(c) == "legend")
                .and_then(|c| self.dom_to_node.get(&c.to_raw()).copied())
                .filter(|n| children.contains(n));
            if let Some(legend) = legend {
                let lp = |v: taffy::LengthPercentage| v.resolve_or_zero(None, |_, _| 0.0);
                let (border, padding) = (lp(style.border.top), lp(style.padding.top));
                let item = &mut self.tree.nodes[legend].style;
                item.float = taffy::Float::Left;
                let margin = item
                    .margin
                    .top
                    .maybe_resolve(Some(0.0), |_, _| 0.0)
                    .unwrap_or(0.0);
                item.margin.top = taffy::LengthPercentageAuto::length(margin - border - padding);
                let clear = Style {
                    display: taffy::Display::Block,
                    clear: taffy::Clear::Both,
                    size: Size {
                        width: Dimension::auto(),
                        height: Dimension::length(padding),
                    },
                    ..Default::default()
                };
                let clear = self.tree.add(clear, Vec::new());
                let at = children
                    .iter()
                    .position(|&c| c == legend)
                    .map_or(0, |i| i + 1);
                children.insert(at, clear);
            }
        }
        let style_display = style.display;
        // A percentage height needs a container whose height is known; a flex or
        // grid container that takes its height from its items has none, so its
        // items' percentages count as `auto` (taffy would use the height it finds).
        if matches!(style_display, taffy::Display::Flex | taffy::Display::Grid)
            && style.size.height.is_auto()
            && style.position != taffy::Position::Absolute
        {
            for &c in &children {
                let item = &mut self.tree.nodes[c].style;
                if item.size.height.tag() == taffy::CompactLength::PERCENT_TAG {
                    item.size.height = Dimension::auto();
                }
            }
        }
        let id_node = self.tree.add(style, children);
        self.tree.nodes[id_node].role = role;
        self.tree.nodes[id_node].control_baseline = control_baseline;
        if self.level(id) == Level::Atomic {
            self.tree.nodes[id_node].lift = self.lift_of(id, computed);
        }
        if let Some(CssValue::Transform(t)) = computed.get(&PropertyId::Transform) {
            if !t.is_empty() {
                self.tree.nodes[id_node].transform = Some(t.clone());
            }
        }
        if let Some(CssValue::CustomValue(o)) = computed.get(&PropertyId::Order) {
            self.tree.nodes[id_node].order = o.trim().parse().unwrap_or(0);
        }
        if matches!(style_display, taffy::Display::Flex | taffy::Display::Grid) {
            // `order` sorts the items; equal ones keep their place.
            let mut kids = std::mem::take(&mut self.tree.nodes[id_node].children);
            kids.sort_by_key(|&c| self.tree.nodes[c].order);
            self.tree.nodes[id_node].children = kids;
        }
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

    /// The size of a form control that sets none of its own, as Blink works it out:
    /// a text field is as wide as `size` average characters, a textarea as `cols`
    /// plus its scrollbar and as high as `rows` lines, a button as its label.
    fn size_control(
        &self,
        id: DomId,
        tag: &str,
        attrs: &[crate::dom::node::Attribute],
        computed: &ComputedStyle,
        font_size: f32,
        style: &mut Style,
    ) -> Option<f32> {
        let attr = |name: &str| {
            attrs
                .iter()
                .find(|a| a.name.local.eq_ignore_ascii_case(name))
                .map(|a| a.value.trim().to_string())
        };
        let kind = match tag {
            "input" => attr("type").unwrap_or_default().to_ascii_lowercase(),
            "textarea" => "textarea".to_string(),
            "select" => "select".to_string(),
            _ => return None,
        };
        let ctx = ResolveContext {
            font_size,
            ..*self.ctx
        };
        let (font, metrics) = self.font(computed, font_size);
        let lh = line_height_px(computed, font_size, &metrics, &ctx);
        let lp = |v: taffy::LengthPercentage| v.resolve_or_zero(None, |_, _| 0.0);
        let edges_w = lp(style.padding.left)
            + lp(style.padding.right)
            + lp(style.border.left)
            + lp(style.border.right);
        let edges_h = lp(style.padding.top)
            + lp(style.padding.bottom)
            + lp(style.border.top)
            + lp(style.border.bottom);
        let border_box = style.box_sizing == taffy::BoxSizing::BorderBox;
        // Blink sets a field's width from the average width of a character, which
        // it takes as half an em for the usual faces and 0.6 em for monospace.
        let mono = {
            let f = family_list(computed).to_ascii_lowercase();
            ["mono", "courier", "consolas", "menlo"]
                .iter()
                .any(|m| f.contains(m))
        };
        // Menlo, the `monospace` of macOS, is wider than Courier New by a little more
        // than a pixel on a field.
        let menlo = {
            let f = family_list(computed).to_ascii_lowercase();
            (f.contains("menlo") || f.contains("monospace")) && !f.contains("courier")
        };
        let (avg, extra) = if menlo {
            ((0.6 * font_size).round(), (0.375 * font_size).round())
        } else if mono {
            ((0.6 * font_size).round(), (0.25 * font_size).round())
        } else {
            ((0.5 * font_size).round(), (0.4 * font_size).round())
        };
        let count = |name: &str, default: f32| {
            attr(name)
                .and_then(|v| v.parse::<f32>().ok())
                .filter(|n| *n > 0.0)
                .map_or(default, f32::floor)
        };
        let label = |default: &str| {
            let text = attr("value").filter(|v| !v.is_empty());
            ifc::text_width(text.as_deref().unwrap_or(default), &font, self.os)
        };
        // Border-box width and height the control asks for.
        let (w, h) = match kind.as_str() {
            // A checkbox or a radio button stands on its bottom border edge; its
            // bottom margin hangs below the baseline.
            "checkbox" | "radio" => return style.size.height.into_option(),
            "hidden" | "image" | "range" | "color" | "file" | "date" | "datetime-local"
            | "month" | "week" | "time" => return None,
            "button" | "submit" | "reset" => {
                let default = match kind.as_str() {
                    "submit" => "Submit",
                    "reset" => "Reset",
                    _ => "",
                };
                (label(default) + edges_w, lh + edges_h)
            }
            // A drop-down is as wide as its widest option and the arrow.
            "select" if attr("multiple").is_none() && count("size", 1.0) <= 1.0 => {
                let widest = self
                    .option_texts(id)
                    .iter()
                    .map(|t| ifc::text_width(t, &font, self.os))
                    .fold(0.0f32, f32::max);
                (widest.ceil() + 18.0, metrics.ascent + metrics.descent + 4.0)
            }
            "select" => return None,
            "textarea" => (
                count("cols", 20.0) * avg + if menlo { 17.0 } else { 16.0 } + edges_w,
                count("rows", 2.0) * lh + edges_h,
            ),
            _ => (count("size", 20.0) * avg + extra + edges_w, lh + edges_h),
        };
        let (w, h) = if border_box {
            (w, h)
        } else {
            (w - edges_w, h - edges_h)
        };
        if style.size.width.is_auto() {
            style.size.width = Dimension::length(w);
        }
        if style.size.height.is_auto() {
            style.size.height = Dimension::length(h);
        }
        // The baseline of the text inside: at the top edge of a field and its
        // first line, centred in a button or a drop-down.
        let (asc_l, _) = metrics.with_leading(lh);
        let total_h = if border_box { h } else { h + edges_h };
        Some(match kind.as_str() {
            "button" | "submit" | "reset" | "select" => {
                (total_h - (metrics.ascent + metrics.descent)) / 2.0 + metrics.ascent
            }
            // A text area stands on its bottom edge, as a box with no line of its own.
            "textarea" => return None,
            _ => lp(style.border.top) + lp(style.padding.top) + asc_l,
        })
    }

    /// The text of every `<option>` under the `<select>` `id`.
    fn option_texts(&self, id: DomId) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = self.dom.children(id);
        stack.reverse();
        while let Some(n) = stack.pop() {
            let Some(e) = self.dom.get(n).and_then(|n| n.as_element()) else {
                continue;
            };
            match &*e.name.local.to_ascii_lowercase() {
                "option" => out.push(
                    self.dom
                        .text_content(n)
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" "),
                ),
                "optgroup" => stack.extend(self.dom.children(n).into_iter().rev()),
                _ => {}
            }
        }
        out
    }

    /// Leave an empty box where the out-of-flow `c` would have been in the flow of
    /// `cont`; once laid out, it says where `c` goes when its offsets are `auto`.
    /// In a flex or grid container the box is itself out of flow, so that those
    /// algorithms pick the position; table containers get none.
    fn mark_static_position(
        &mut self,
        cont: DomId,
        c: DomId,
        run: &mut Option<(ifc::Builder, Vec<usize>)>,
        out: &mut Vec<usize>,
    ) {
        let Some(&abs) = self.dom_to_node.get(&c.to_raw()) else {
            return;
        };
        let document = self
            .dom
            .get(cont)
            .is_some_and(|n| matches!(n.data, NodeData::Document | NodeData::DocumentFragment));
        let display = self.display_of(cont);
        let flex_or_grid = matches!(
            display,
            CssDisplay::Flex | CssDisplay::InlineFlex | CssDisplay::Grid | CssDisplay::InlineGrid
        );
        let in_flow = document
            || matches!(
                display,
                CssDisplay::Block
                    | CssDisplay::Inline
                    | CssDisplay::InlineBlock
                    | CssDisplay::FlowRoot
                    | CssDisplay::ListItem
            );
        if !in_flow && !flex_or_grid {
            return;
        }
        let empty = Style {
            display: taffy::Display::Block,
            position: if flex_or_grid {
                taffy::Position::Absolute
            } else {
                taffy::Position::Relative
            },
            size: Size {
                width: Dimension::length(0.0),
                height: Dimension::length(0.0),
            },
            ..Default::default()
        };
        let mark = self.tree.add(empty, Vec::new());
        self.tree.nodes[mark].role = Role::Marker;
        self.static_pending.push((abs, mark));
        match run {
            Some((b, atomics)) if !flex_or_grid && b.is_visible() => {
                atomics.push(mark);
                b.marker(mark);
            }
            _ => out.push(mark),
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
                Part::Image(w, h) => {
                    let n = self.image_box(w, h);
                    let (b, atomics) =
                        run.get_or_insert_with(|| (self.run_builder(cont), Vec::new()));
                    atomics.push(n);
                    b.atomic(n);
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
                self.mark_static_position(cont, c, &mut run, &mut out);
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
            // A block of its own kind: taffy would lay a flex node out as a box that
            // keeps clear of floats, instead of leaving them to the lines.
            let style = Style {
                display: taffy::Display::Block,
                ..Default::default()
            };
            out.push(self.tree.add_ifc(style, ifc, atomics));
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
                        Part::Image(w, h) => {
                            let n = self.image_box(w, h);
                            if let Some((b, atomics)) = run.as_mut() {
                                atomics.push(n);
                                b.atomic(n);
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
            // A float inside inline content goes before the lines that hold it, as
            // if it came first: the text then wraps around it.
            Level::Block if self.float_of(id) != CssFloat::None => {
                if let Some(&n) = self.dom_to_node.get(&id.to_raw()) {
                    out.push(n);
                }
            }
            // An atomic inline sits in the line as an atom.
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

    /// Border widths come out in whole device pixels, at least one if there is a
    /// border: Blink floors them (`1.7px` is `1.5px` at 2x).
    fn snap_borders(&self, ts: &mut Style) {
        self.quantize(ts);
        let dpr = if self.dpr > 0.0 { self.dpr } else { 1.0 };
        let snap = |w: taffy::LengthPercentage| {
            let v = w.resolve_or_zero(None, |_, _| 0.0);
            if v <= 0.0 {
                w
            } else {
                taffy::LengthPercentage::length((v * dpr).floor().max(1.0) / dpr)
            }
        };
        ts.border.top = snap(ts.border.top);
        ts.border.right = snap(ts.border.right);
        ts.border.bottom = snap(ts.border.bottom);
        ts.border.left = snap(ts.border.left);
    }

    /// Blink keeps lengths in 1/64 px (`LayoutUnit`), rounded down; kept as plain
    /// floats the differences add up to pixels over a long page.
    fn quantize(&self, ts: &mut Style) {
        let q = |v: f32| (v * 64.0).floor() / 64.0;
        let length = taffy::CompactLength::LENGTH_TAG;
        let lp = |v: taffy::LengthPercentage| {
            let r = v.into_raw();
            if r.tag() == length {
                taffy::LengthPercentage::length(q(r.value()))
            } else {
                v
            }
        };
        let lpa = |v: taffy::LengthPercentageAuto| {
            let r = v.into_raw();
            if r.tag() == length {
                taffy::LengthPercentageAuto::length(q(r.value()))
            } else {
                v
            }
        };
        let dim = |v: Dimension| {
            let r = v.into_raw();
            if r.tag() == length {
                Dimension::length(q(r.value()))
            } else {
                v
            }
        };
        ts.margin = taffy::Rect {
            left: lpa(ts.margin.left),
            right: lpa(ts.margin.right),
            top: lpa(ts.margin.top),
            bottom: lpa(ts.margin.bottom),
        };
        ts.padding = taffy::Rect {
            left: lp(ts.padding.left),
            right: lp(ts.padding.right),
            top: lp(ts.padding.top),
            bottom: lp(ts.padding.bottom),
        };
        ts.inset = taffy::Rect {
            left: lpa(ts.inset.left),
            right: lpa(ts.inset.right),
            top: lpa(ts.inset.top),
            bottom: lpa(ts.inset.bottom),
        };
        ts.size = Size {
            width: dim(ts.size.width),
            height: dim(ts.size.height),
        };
        ts.min_size = Size {
            width: dim(ts.min_size.width),
            height: dim(ts.min_size.height),
        };
        ts.max_size = Size {
            width: dim(ts.max_size.width),
            height: dim(ts.max_size.height),
        };
    }

    /// `vertical-align` of an inline box or an atomic inline.
    fn lift_of(&self, id: DomId, c: &ComputedStyle) -> Lift {
        let Some(CssValue::CustomValue(raw)) = c.get(&PropertyId::VerticalAlign) else {
            return Lift::Baseline;
        };
        let raw = raw.trim().to_ascii_lowercase();
        let parent = self
            .parent_of(id)
            .and_then(|p| self.styles.get(p).map(|s| (p, s)));
        let (parent_size, parent_metrics) = match parent {
            Some((p, s)) => {
                let size = self.styles.font_size(p);
                (size, self.font(s, size).1)
            }
            None => {
                let size = crate::style::tree::DEFAULT_FONT_SIZE;
                (size, self.font(c, size).1)
            }
        };
        match raw.as_str() {
            "baseline" => Lift::Baseline,
            "sub" => Lift::Shift(-(parent_size / 5.0 + 1.0)),
            "super" => Lift::Shift(parent_size / 3.0 + 1.0),
            "middle" => Lift::Middle(parent_metrics.x_height),
            "text-top" => Lift::TextTop(parent_metrics.ascent),
            "text-bottom" => Lift::TextBottom(parent_metrics.descent),
            "top" => Lift::Top,
            "bottom" => Lift::Bottom,
            other => {
                let own = self.styles.font_size(id);
                let split = other
                    .find(|ch: char| ch.is_ascii_alphabetic() || ch == '%')
                    .unwrap_or(other.len());
                let Ok(n) = other[..split].trim().parse::<f32>() else {
                    return Lift::Baseline;
                };
                match &other[split..] {
                    "px" | "" => Lift::Shift(n),
                    "pt" => Lift::Shift(n * 4.0 / 3.0),
                    "em" => Lift::Shift(n * own),
                    "rem" => Lift::Shift(n * self.ctx.root_font_size),
                    "%" => {
                        let ctx = ResolveContext {
                            font_size: own,
                            ..*self.ctx
                        };
                        let (_, m) = self.font(c, own);
                        Lift::Shift(n / 100.0 * line_height_px(c, own, &m, &ctx))
                    }
                    _ => Lift::Baseline,
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
        let mut ts = computed_to_taffy(c, &ctx);
        self.snap_borders(&mut ts);
        let lp = |v: taffy::LengthPercentage| v.resolve_or_zero(None, |_, _| 0.0);
        let margin =
            |v: taffy::LengthPercentageAuto| v.maybe_resolve(Some(0.0), |_, _| 0.0).unwrap_or(0.0);
        InlineBox {
            dom: id.to_raw(),
            lift: self.lift_of(id, c),
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
