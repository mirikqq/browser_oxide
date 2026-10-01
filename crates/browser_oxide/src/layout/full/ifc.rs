//! Inline formatting: lines of text, inline boxes and atomic inlines.
//!
//! A block container with inline content becomes one [`Ifc`] node. At build time
//! its content is flattened into atoms — a word, the edge of an inline box, an
//! atomic inline such as an `inline-block` or an image, a forced break — with the
//! text already shaped. Layout then only does arithmetic: greedy line breaking
//! against the width it is offered, the vertical metrics of each line as Blink
//! computes them, and the position of every fragment.
//!
//! Left to right, `vertical-align: baseline`, no floats inside lines.

use std::collections::BTreeMap;

use taffy::util::{MaybeResolve, ResolveOrZero};
use taffy::{AvailableSpace, BlockContext, BoxSizing};
use taffy::{
    Layout, LayoutInput, LayoutOutput, LayoutPartialTree, Line, NodeId, Point, Rect, RequestedAxis,
    RunMode, Size, SizingMode,
};

use crate::css_values::types::display::{TextAlign, WhiteSpace};
use crate::layout::full::tree::{resolve_calc, Role, Tree};
use crate::text::fallback::hermetic_segments;
use crate::text::{shaper, ParsedFont};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Brk {
    None,
    Allowed,
    Forced,
}

#[derive(Debug)]
pub enum AtomKind {
    Text { item: usize, unit: usize },
    Open(usize),
    Close(usize),
    Atomic { node: usize },
    Break,
}

#[derive(Debug)]
pub struct Atom {
    pub kind: AtomKind,
    /// Whether a line may end right after this atom.
    pub brk: Brk,
}

/// A stretch of a text item between two break opportunities.
#[derive(Debug)]
pub struct Unit {
    pub start: usize,
    /// End of the word, before any trailing spaces.
    pub content_end: usize,
    pub end: usize,
}

#[derive(Debug)]
pub struct TextItem {
    pub dom: u32,
    /// The inline box the text sits in; `None` for the container itself.
    pub owner: Option<usize>,
    /// The text as it is painted: whitespace already collapsed.
    pub text: String,
    /// `prefix[b]`: the advance of everything before byte `b`.
    pub prefix: Vec<f32>,
    pub units: Vec<Unit>,
}

/// An inline element that takes part in the line without being a box of its own.
#[derive(Debug, Clone, Default)]
pub struct InlineBox {
    pub dom: u32,
    /// The font's content area above and below the baseline.
    pub ascent: f32,
    pub descent: f32,
    /// The same with half-leading added: what the box claims of the line.
    pub asc_l: f32,
    pub desc_l: f32,
    pub margin_left: f32,
    pub margin_right: f32,
    pub border_left: f32,
    pub border_right: f32,
    pub padding_left: f32,
    pub padding_right: f32,
    pub border_top: f32,
    pub border_bottom: f32,
    pub padding_top: f32,
    pub padding_bottom: f32,
}

impl InlineBox {
    fn left(&self) -> f32 {
        self.margin_left + self.border_left + self.padding_left
    }

    fn right(&self) -> f32 {
        self.padding_right + self.border_right + self.margin_right
    }
}

#[derive(Debug, Clone)]
pub struct Root {
    pub dom: u32,
    pub align: TextAlign,
    pub ascent: f32,
    pub descent: f32,
    pub asc_l: f32,
    pub desc_l: f32,
    /// Quirks mode: a line with nothing but images has no strut.
    pub quirks: bool,
}

#[derive(Debug)]
pub struct Ifc {
    pub atoms: Vec<Atom>,
    pub texts: Vec<TextItem>,
    pub boxes: Vec<InlineBox>,
    pub root: Root,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FragKind {
    /// The border box of an inline element on one line.
    Box,
    Text,
}

/// What a line holds, in the coordinates of the node that owns the lines.
#[derive(Debug, Clone)]
#[cfg_attr(
    not(feature = "paint"),
    allow(
        dead_code,
        reason = "the style, text and border of a fragment are read only by painting"
    )
)]
pub struct Frag {
    /// The element (for a box) or the text node.
    pub dom: u32,
    /// The element whose style the fragment is drawn in.
    pub owner: u32,
    pub kind: FragKind,
    pub rect: [f32; 4],
    pub text: String,
    /// Absolute-to-the-node y of the baseline the text sits on.
    pub baseline: f32,
    /// Border widths drawn on this fragment (top, right, bottom, left): an inline
    /// box has its left border only on its first line and its right one on its last.
    pub border: [f32; 4],
    /// A box fragment of an element with padding, borders or margins. Without
    /// them the element has no box of its own for `getClientRects`: it reports
    /// its text instead.
    pub decorated: bool,
}

// ---------------------------------------------------------------- building

pub struct Builder {
    atoms: Vec<Atom>,
    texts: Vec<TextItem>,
    boxes: Vec<InlineBox>,
    stack: Vec<usize>,
    root: Root,
    os: String,
    /// The last thing emitted ended with a collapsible space.
    prev_space: bool,
    visible: bool,
}

impl Builder {
    pub fn new(root: Root, os: &str) -> Self {
        Self {
            atoms: Vec::new(),
            texts: Vec::new(),
            boxes: Vec::new(),
            stack: Vec::new(),
            root,
            os: os.to_string(),
            prev_space: true,
            visible: false,
        }
    }

    /// Whether anything that takes room has been added.
    pub fn is_visible(&self) -> bool {
        self.visible
    }

    pub fn open(&mut self, b: InlineBox) {
        if b.left() > 0.0 || b.right() > 0.0 {
            self.visible = true;
        }
        let id = self.boxes.len();
        self.boxes.push(b);
        self.stack.push(id);
        self.atoms.push(Atom {
            kind: AtomKind::Open(id),
            brk: Brk::None,
        });
    }

    pub fn close(&mut self) {
        if let Some(id) = self.stack.pop() {
            self.atoms.push(Atom {
                kind: AtomKind::Close(id),
                brk: Brk::None,
            });
        }
    }

    /// Close the innermost box because a block interrupts it: it has no right edge
    /// on this side of the break.
    pub fn close_sliced(&mut self) {
        if let Some(&id) = self.stack.last() {
            let b = &mut self.boxes[id];
            b.margin_right = 0.0;
            b.border_right = 0.0;
            b.padding_right = 0.0;
        }
        self.close();
    }

    pub fn atomic(&mut self, node: usize) {
        self.visible = true;
        self.prev_space = false;
        self.atoms.push(Atom {
            kind: AtomKind::Atomic { node },
            brk: Brk::Allowed,
        });
    }

    /// `<wbr>`: a place where the line may end, and nothing else.
    pub fn break_opportunity(&mut self) {
        if let Some(last) = self.atoms.last_mut() {
            if last.brk == Brk::None && !matches!(last.kind, AtomKind::Open(_)) {
                last.brk = Brk::Allowed;
            }
        }
    }

    pub fn line_break(&mut self) {
        self.visible = true;
        self.prev_space = true;
        self.atoms.push(Atom {
            kind: AtomKind::Break,
            brk: Brk::Forced,
        });
    }

    pub fn text(&mut self, dom: u32, raw: &str, parsed: &ParsedFont, white: WhiteSpace) {
        let text = collapse(raw, white, &mut self.prev_space);
        if text.is_empty() {
            return;
        }
        if text.chars().any(|c| !c.is_whitespace()) {
            self.visible = true;
        }
        let prefix = prefix_widths(&text, parsed, &self.os);
        let preserve = matches!(
            white,
            WhiteSpace::Pre | WhiteSpace::PreWrap | WhiteSpace::BreakSpaces
        );
        let wraps = !matches!(white, WhiteSpace::Nowrap | WhiteSpace::Pre);
        let units = units_of(&text, preserve);
        let item = self.texts.len();
        let count = units.len();
        for (i, u) in units.iter().enumerate() {
            let ends_line = text[u.start..u.end].ends_with('\n');
            let last = i + 1 == count;
            let brk = if ends_line {
                Brk::Forced
            } else if last {
                if wraps && text[u.start..u.end].ends_with(' ') {
                    Brk::Allowed
                } else {
                    Brk::None
                }
            } else if wraps {
                Brk::Allowed
            } else {
                Brk::None
            };
            self.atoms.push(Atom {
                kind: AtomKind::Text { item, unit: i },
                brk,
            });
        }
        self.texts.push(TextItem {
            dom,
            owner: self.stack.last().copied(),
            text,
            prefix,
            units,
        });
    }

    /// `None` when there is nothing to lay out: only collapsible whitespace and
    /// empty inline boxes.
    pub fn finish(mut self) -> Option<Ifc> {
        if !self.visible {
            return None;
        }
        // A line may end before an atomic inline, unless an inline box opens there.
        for i in 0..self.atoms.len().saturating_sub(1) {
            let next_atomic = matches!(self.atoms[i + 1].kind, AtomKind::Atomic { .. });
            let open = matches!(self.atoms[i].kind, AtomKind::Open(_));
            if next_atomic && !open && self.atoms[i].brk == Brk::None {
                self.atoms[i].brk = Brk::Allowed;
            }
        }
        Some(Ifc {
            atoms: self.atoms,
            texts: self.texts,
            boxes: self.boxes,
            root: self.root,
        })
    }
}

/// CSS whitespace processing for one text node, given whether what came before
/// ended in a space.
fn collapse(raw: &str, white: WhiteSpace, prev_space: &mut bool) -> String {
    let mut out = String::with_capacity(raw.len());
    match white {
        WhiteSpace::Pre | WhiteSpace::PreWrap | WhiteSpace::BreakSpaces => {
            for c in raw.chars() {
                match c {
                    '\r' => {}
                    '\t' => out.push_str("        "),
                    c => out.push(c),
                }
            }
            if let Some(last) = out.chars().last() {
                *prev_space = last == ' ' || last == '\n';
            }
        }
        WhiteSpace::PreLine => {
            for c in raw.chars() {
                match c {
                    '\n' => {
                        while out.ends_with(' ') {
                            out.pop();
                        }
                        out.push('\n');
                        *prev_space = true;
                    }
                    ' ' | '\t' | '\r' | '\u{c}' => {
                        if !*prev_space {
                            out.push(' ');
                            *prev_space = true;
                        }
                    }
                    c => {
                        out.push(c);
                        *prev_space = false;
                    }
                }
            }
        }
        WhiteSpace::Normal | WhiteSpace::Nowrap => {
            for c in raw.chars() {
                if matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{c}') {
                    if !*prev_space {
                        out.push(' ');
                        *prev_space = true;
                    }
                } else {
                    out.push(c);
                    *prev_space = false;
                }
            }
        }
    }
    out
}

fn units_of(text: &str, preserve: bool) -> Vec<Unit> {
    let mut units = Vec::new();
    let mut start = 0;
    let mut cuts: Vec<usize> = unicode_linebreak::linebreaks(text)
        .map(|(i, _)| i)
        .filter(|&i| i > 0)
        .collect();
    if cuts.last() != Some(&text.len()) {
        cuts.push(text.len());
    }
    cuts.dedup();
    for end in cuts {
        if end <= start {
            continue;
        }
        let piece = &text[start..end];
        let content = if preserve {
            piece.trim_end_matches('\n')
        } else {
            piece.trim_end_matches([' ', '\n'])
        };
        units.push(Unit {
            start,
            content_end: start + content.len(),
            end,
        });
        start = end;
    }
    units
}

/// `prefix[b]`: the advance of the first `b` bytes of `text`. Measured with the
/// bundled faces only, and with fixed advances for what no bundled face draws, so
/// geometry never depends on which fonts the host has.
/// The width of `text` set in `font` on one line, as lines are measured.
pub(super) fn text_width(text: &str, font: &ParsedFont, os: &str) -> f32 {
    prefix_widths(text, font, os).last().copied().unwrap_or(0.0)
}

fn prefix_widths(text: &str, font: &ParsedFont, os: &str) -> Vec<f32> {
    let size = font.size_px;
    let mut prefix = vec![0.0f32; text.len() + 1];
    let mut base = 0.0f32;
    for seg in hermetic_segments(text, font, os) {
        let offset = seg.text.as_ptr() as usize - text.as_ptr() as usize;
        let mut adv: BTreeMap<usize, f32> = BTreeMap::new();
        let run = match seg.face {
            Some(f) => Some(shaper::shape(seg.text, f.data, f.index, size)),
            // The profile's metrics table describes the regular weight.
            None if font.weight >= 600 || font.italic => crate::text::resolve_face(font, os)
                .map(|(data, index)| shaper::shape(seg.text, data, index, size)),
            None => crate::text::shape_run_kerned(seg.text, font, os),
        };
        if let Some(run) = &run {
            for g in &run.glyphs {
                *adv.entry(g.cluster as usize).or_default() += g.x_advance;
            }
        }
        if !seg.covered || run.as_ref().is_none_or(|r| r.glyphs.is_empty()) {
            // No glyph to measure: ideographs are one em wide, the rest of what
            // nothing draws takes the missing-glyph box's width.
            for (i, ch) in seg.text.char_indices() {
                let wide = unicode_width::UnicodeWidthChar::width(ch) == Some(2);
                let entry = adv.entry(i).or_insert(size * 0.5);
                if wide {
                    *entry = size;
                }
            }
        }
        let mut clusters = adv.into_iter().peekable();
        let mut cum = 0.0f32;
        for b in 0..=seg.text.len() {
            while let Some(&(c, w)) = clusters.peek() {
                if c < b {
                    cum += w;
                    clusters.next();
                } else {
                    break;
                }
            }
            prefix[offset + b] = base + cum;
        }
        base += cum;
    }
    prefix
}

// ------------------------------------------------------------------ layout

/// An atomic inline once sized: border box and margins, in px.
#[derive(Clone, Copy, Default)]
struct AtomicBox {
    w: f32,
    h: f32,
    ml: f32,
    mr: f32,
    mt: f32,
    mb: f32,
    /// Distance from the top of the border box to its baseline, if it has one.
    baseline: Option<f32>,
    /// Stands for an out-of-flow box: it sits at the top of its line, which is
    /// where the box's static position is.
    marker: bool,
}

impl AtomicBox {
    fn margin_width(&self) -> f32 {
        self.ml + self.w + self.mr
    }

    fn ascent(&self) -> f32 {
        match self.baseline {
            Some(b) => self.mt + b,
            None => self.mt + self.h + self.mb,
        }
    }

    fn descent(&self) -> f32 {
        match self.baseline {
            Some(b) => self.h - b + self.mb,
            None => 0.0,
        }
    }
}

struct LineBox {
    atoms: std::ops::Range<usize>,
    width: f32,
    /// Where the line may go when floats narrow it: the offset of its left edge
    /// and the room it has.
    slot: Option<(f32, f32)>,
}

fn input(
    run_mode: RunMode,
    known: Size<Option<f32>>,
    parent_w: f32,
    available: Size<AvailableSpace>,
) -> LayoutInput {
    LayoutInput {
        run_mode,
        sizing_mode: SizingMode::InherentSize,
        axis: RequestedAxis::Both,
        known_dimensions: known,
        parent_size: Size {
            width: parent_w.is_finite().then_some(parent_w),
            height: None,
        },
        available_space: available,
        vertical_margins_are_collapsible: Line::FALSE,
    }
}

fn size_atomic(tree: &mut Tree, node: usize, fit: f32, basis: f32) -> AtomicBox {
    let style = tree.nodes[node].style.clone();
    let basis_opt = basis.is_finite().then_some(basis);
    let b = basis_opt.unwrap_or(0.0);
    let margin =
        |m: taffy::LengthPercentageAuto| m.maybe_resolve(Some(b), resolve_calc).unwrap_or(0.0);
    let lp = |v: taffy::LengthPercentage| v.resolve_or_zero(Some(b), resolve_calc);
    let (ml, mr) = (margin(style.margin.left), margin(style.margin.right));
    let (mt, mb) = (margin(style.margin.top), margin(style.margin.bottom));
    let extra_w = lp(style.padding.left)
        + lp(style.padding.right)
        + lp(style.border.left)
        + lp(style.border.right);
    let extra_h = lp(style.padding.top)
        + lp(style.padding.bottom)
        + lp(style.border.top)
        + lp(style.border.bottom);
    let content_box = style.box_sizing == BoxSizing::ContentBox;
    let known_w = style
        .size
        .width
        .maybe_resolve(basis_opt, resolve_calc)
        .map(|w| if content_box { w + extra_w } else { w });
    let known_h = style
        .size
        .height
        .maybe_resolve(None, resolve_calc)
        .map(|h| if content_box { h + extra_h } else { h });

    let id = NodeId::from(node);
    let space = |w: AvailableSpace| Size {
        width: w,
        height: AvailableSpace::MaxContent,
    };
    let w = match known_w {
        Some(w) => w,
        None => {
            let max = tree
                .compute_child_layout(
                    id,
                    input(
                        RunMode::ComputeSize,
                        Size::NONE,
                        basis,
                        space(AvailableSpace::MaxContent),
                    ),
                )
                .size
                .width;
            let min = tree
                .compute_child_layout(
                    id,
                    input(
                        RunMode::ComputeSize,
                        Size::NONE,
                        basis,
                        space(AvailableSpace::MinContent),
                    ),
                )
                .size
                .width;
            let room = (fit - ml - mr).max(0.0);
            max.min(min.max(room))
        }
    };
    // Laid out in full rather than only measured: taffy loses the collapsed
    // margins of nested blocks when it only measures, and the baseline is known
    // only once the content has been laid out.
    let out = tree.compute_child_layout(
        id,
        input(
            RunMode::PerformLayout,
            Size {
                width: Some(w),
                height: known_h,
            },
            basis,
            space(AvailableSpace::Definite(w)),
        ),
    );
    let h = known_h.unwrap_or(out.size.height);
    AtomicBox {
        w,
        h,
        ml,
        mr,
        mt,
        mb,
        baseline: baseline_of(tree, node),
        marker: tree.nodes[node].role == Role::Marker,
    }
}

/// Where the last line of text inside `node` sits, from the top of its border
/// box: the baseline an `inline-block` takes. `None` if it holds no text.
fn baseline_of(tree: &Tree, node: usize) -> Option<f32> {
    let n = &tree.nodes[node];
    if n.control_baseline.is_some() {
        return n.control_baseline;
    }
    if n.ifc.is_some() {
        return n.baseline;
    }
    n.children
        .iter()
        .rev()
        .filter(|&&c| tree.nodes[c].style.position != taffy::Position::Absolute)
        .find_map(|&c| baseline_of(tree, c).map(|b| tree.nodes[c].layout.location.y + b))
}

impl Ifc {
    fn weights(&self, i: usize, atomics: &[AtomicBox]) -> (f32, f32) {
        match self.atoms[i].kind {
            AtomKind::Text { item, unit } => {
                let t = &self.texts[item];
                let u = &t.units[unit];
                (
                    t.prefix[u.content_end] - t.prefix[u.start],
                    t.prefix[u.end] - t.prefix[u.content_end],
                )
            }
            AtomKind::Open(b) => (self.boxes[b].left(), 0.0),
            AtomKind::Close(b) => (self.boxes[b].right(), 0.0),
            AtomKind::Atomic { .. } => (atomics[i].margin_width(), 0.0),
            AtomKind::Break => (0.0, 0.0),
        }
    }

    /// The line that starts at atom `start`, broken greedily against `avail`.
    fn break_line(&self, start: usize, atomics: &[AtomicBox], avail: f32) -> LineBox {
        let n = self.atoms.len();
        let mut i = start;
        let (mut used, mut trailing) = (0.0f32, 0.0f32);
        let mut has_content = false;
        while i < n {
            let (mut j, mut chunk, mut space) = (i, 0.0f32, 0.0f32);
            loop {
                let (w, s) = self.weights(j, atomics);
                chunk += w + space;
                space = s;
                if self.atoms[j].brk != Brk::None || j + 1 >= n {
                    break;
                }
                j += 1;
            }
            let forced = self.atoms[j].brk == Brk::Forced;
            let fits = !has_content || used + trailing + chunk <= avail + 0.001;
            if !fits {
                break;
            }
            used += if has_content { trailing } else { 0.0 } + chunk;
            trailing = space;
            has_content = true;
            i = j + 1;
            if forced {
                break;
            }
        }
        LineBox {
            atoms: start..i,
            width: used,
            slot: None,
        }
    }
}

/// Lay the content out for a node `width` wide (`None`: as wide as it needs).
struct Placed {
    lines: Vec<LineBox>,
    /// Top and height of each line, and the baseline's distance from the top.
    metrics: Vec<(f32, f32, f32)>,
    height: f32,
}

fn place(
    ifc: &Ifc,
    atomics: &[AtomicBox],
    avail: f32,
    floats: Option<&BlockContext<'_>>,
) -> Placed {
    let floats = floats.filter(|c| c.has_floats());
    let mut lines: Vec<LineBox> = Vec::new();
    let mut metrics = Vec::new();
    let mut open: Vec<usize> = Vec::new();
    let mut top = 0.0f32;
    let mut start = 0;
    while start < ifc.atoms.len() {
        // With floats about, the line goes where there is room: beside them if its
        // first word fits there, below them if not.
        let mut broken = ifc.break_line(start, atomics, avail);
        if let Some(ctx) = floats {
            let mut after = None;
            loop {
                let mut slot = ctx.find_content_slot(top, taffy::Clear::None, after);
                if slot.segment_id.is_none() && after.is_some() {
                    // Not even a word fits beside the floats: below the lowest.
                    let below = ctx.cleared_threshold(taffy::Clear::Both).unwrap_or(slot.y);
                    slot = ctx.find_content_slot(below.max(slot.y), taffy::Clear::None, None);
                }
                broken = ifc.break_line(start, atomics, slot.width.min(avail));
                top = slot.y;
                broken.slot = Some((slot.x, slot.width));
                let fits = broken.width <= slot.width + 0.001;
                if fits || slot.segment_id.is_none() || slot.width >= avail - 0.001 {
                    break;
                }
                after = slot.segment_id;
            }
        }
        start = broken.atoms.end;
        let line = &broken;
        // Leading can be negative, so nothing starts from zero.
        let (mut asc, mut desc) = (f32::NEG_INFINITY, f32::NEG_INFINITY);
        let mut touched: Vec<usize> = open.clone();
        // Text of the block itself, and of each inline box.
        let mut root_text = false;
        let mut root_break = false;
        let mut content = false;
        let mut boxes_with_text: Vec<usize> = Vec::new();
        for i in line.atoms.clone() {
            match ifc.atoms[i].kind {
                AtomKind::Open(b) => {
                    open.push(b);
                    touched.push(b);
                }
                AtomKind::Close(b) => {
                    touched.push(b);
                    open.retain(|&x| x != b);
                }
                AtomKind::Text { .. } | AtomKind::Break => {
                    let is_break = matches!(ifc.atoms[i].kind, AtomKind::Break);
                    root_text |= open.is_empty() && !is_break;
                    root_break |= open.is_empty() && is_break;
                    content |= !is_break;
                    boxes_with_text.extend(open.iter().copied());
                    touched.extend(open.iter().copied());
                }
                AtomKind::Atomic { .. } => {
                    content = true;
                    touched.extend(open.iter().copied());
                    asc = asc.max(atomics[i].ascent());
                    desc = desc.max(atomics[i].descent());
                }
            }
        }
        // Quirks mode: the strut counts only on a line with text of the block
        // itself, and an inline box counts only if it holds text or has edges.
        // A line of nothing but a break keeps the strut: it is an empty line.
        if root_text || (root_break && !content) || !ifc.root.quirks {
            asc = asc.max(ifc.root.asc_l);
            desc = desc.max(ifc.root.desc_l);
        }
        for b in touched {
            let bx = &ifc.boxes[b];
            if !ifc.root.quirks
                || boxes_with_text.contains(&b)
                || bx.left() > 0.0
                || bx.right() > 0.0
            {
                asc = asc.max(bx.asc_l);
                desc = desc.max(bx.desc_l);
            }
        }
        if asc == f32::NEG_INFINITY {
            (asc, desc) = (0.0, 0.0);
        }
        metrics.push((top, asc + desc, asc));
        top += asc + desc;
        lines.push(broken);
    }
    Placed {
        lines,
        metrics,
        height: top,
    }
}

/// Positions of everything on the lines, and the lines' results.
fn fragments(
    ifc: &Ifc,
    placed: &Placed,
    atomics: &[AtomicBox],
    width: f32,
) -> (Vec<Frag>, Vec<(usize, f32, f32)>) {
    let mut frags = Vec::new();
    let mut atomic_at = Vec::new();
    let mut carried: Vec<usize> = Vec::new();
    for (line, &(top, _, asc)) in placed.lines.iter().zip(&placed.metrics) {
        let (left, room) = line.slot.unwrap_or((0.0, width));
        let free = (room - line.width).max(0.0);
        let x0 = left
            + match ifc.root.align {
                TextAlign::Right | TextAlign::End => free,
                TextAlign::Center => free / 2.0,
                _ => 0.0,
            };
        let baseline = top + asc;
        let mut x = x0;
        let mut starts: Vec<(usize, f32, bool)> = carried.iter().map(|&b| (b, x0, false)).collect();
        let mut text: Option<(usize, usize, usize, f32)> = None;
        let flush =
            |text: &mut Option<(usize, usize, usize, f32)>, end_x: f32, frags: &mut Vec<Frag>| {
                if let Some((item, from, to, sx)) = text.take() {
                    let t = &ifc.texts[item];
                    let (ascent, descent, owner_dom) = match t.owner {
                        Some(b) => (ifc.boxes[b].ascent, ifc.boxes[b].descent, ifc.boxes[b].dom),
                        None => (ifc.root.ascent, ifc.root.descent, ifc.root.dom),
                    };
                    frags.push(Frag {
                        dom: t.dom,
                        owner: owner_dom,
                        kind: FragKind::Text,
                        rect: [sx, baseline - ascent, end_x - sx, ascent + descent],
                        text: t.text[from..to].to_string(),
                        baseline,
                        border: [0.0; 4],
                        decorated: false,
                    });
                }
            };
        let mut end_x = x;
        for i in line.atoms.clone() {
            match ifc.atoms[i].kind {
                AtomKind::Open(b) => {
                    flush(&mut text, x, &mut frags);
                    let bx = &ifc.boxes[b];
                    x += bx.left();
                    starts.push((b, x - bx.border_left - bx.padding_left, true));
                    carried.push(b);
                }
                AtomKind::Close(b) => {
                    flush(&mut text, x, &mut frags);
                    let bx = &ifc.boxes[b];
                    x += bx.right();
                    if let Some(p) = starts.iter().rposition(|&(id, _, _)| id == b) {
                        let (_, sx, left) = starts.remove(p);
                        frags.push(box_frag(
                            ifc,
                            b,
                            sx,
                            x - bx.margin_right,
                            baseline,
                            left,
                            true,
                        ));
                    }
                    carried.retain(|&c| c != b);
                }
                AtomKind::Text { item, unit } => {
                    let t = &ifc.texts[item];
                    let u = &t.units[unit];
                    let (w, _) = ifc.weights(i, atomics);
                    let space = t.prefix[u.end] - t.prefix[u.content_end];
                    let last_on_line = i + 1 == line.atoms.end;
                    let shown_end = if last_on_line { u.content_end } else { u.end };
                    let advance = if last_on_line { w } else { w + space };
                    match &mut text {
                        Some((it, _, to, _)) if *it == item && *to == u.start => *to = shown_end,
                        _ => {
                            flush(&mut text, x, &mut frags);
                            text = Some((item, u.start, shown_end, x));
                        }
                    }
                    x += advance;
                }
                AtomKind::Atomic { .. } => {
                    flush(&mut text, x, &mut frags);
                    let a = atomics[i];
                    let AtomKind::Atomic { node } = ifc.atoms[i].kind else {
                        continue;
                    };
                    let y = if a.marker {
                        top
                    } else {
                        baseline - a.ascent() + a.mt
                    };
                    atomic_at.push((node, x + a.ml, y));
                    x += a.margin_width();
                }
                AtomKind::Break => flush(&mut text, x, &mut frags),
            }
            end_x = x;
        }
        flush(&mut text, end_x, &mut frags);
        // Boxes still open at the end of the line end with it.
        for (b, sx, left) in starts {
            frags.push(box_frag(ifc, b, sx, end_x, baseline, left, false));
        }
    }
    (frags, atomic_at)
}

fn box_frag(
    ifc: &Ifc,
    b: usize,
    start: f32,
    end: f32,
    baseline: f32,
    left_edge: bool,
    right_edge: bool,
) -> Frag {
    let bx = &ifc.boxes[b];
    let top = baseline - bx.ascent - bx.padding_top - bx.border_top;
    let height = bx.ascent
        + bx.descent
        + bx.padding_top
        + bx.padding_bottom
        + bx.border_top
        + bx.border_bottom;
    Frag {
        dom: bx.dom,
        owner: bx.dom,
        kind: FragKind::Box,
        rect: [start, top, (end - start).max(0.0), height],
        text: String::new(),
        baseline,
        border: [
            bx.border_top,
            if right_edge { bx.border_right } else { 0.0 },
            bx.border_bottom,
            if left_edge { bx.border_left } else { 0.0 },
        ],
        decorated: bx.left() > 0.0
            || bx.right() > 0.0
            || bx.padding_top > 0.0
            || bx.padding_bottom > 0.0
            || bx.border_top > 0.0
            || bx.border_bottom > 0.0,
    }
}

/// Lay out the `Ifc` of `node_id`.
pub fn compute(
    tree: &mut Tree,
    node_id: NodeId,
    inputs: LayoutInput,
    floats: Option<&BlockContext<'_>>,
) -> LayoutOutput {
    let idx = usize::from(node_id);
    let Some(ifc) = tree.nodes[idx].ifc.take() else {
        return LayoutOutput::HIDDEN;
    };
    let out = run(tree, idx, &ifc, inputs, floats);
    tree.nodes[idx].ifc = Some(ifc);
    out
}

fn run(
    tree: &mut Tree,
    idx: usize,
    ifc: &Ifc,
    inputs: LayoutInput,
    floats: Option<&BlockContext<'_>>,
) -> LayoutOutput {
    let avail = match inputs.known_dimensions.width {
        Some(w) => w,
        None => match inputs.available_space.width {
            AvailableSpace::Definite(w) => w,
            AvailableSpace::MinContent => 0.0,
            AvailableSpace::MaxContent => f32::INFINITY,
        },
    };
    let mut atomics = vec![AtomicBox::default(); ifc.atoms.len()];
    for (i, atom) in ifc.atoms.iter().enumerate() {
        if let AtomKind::Atomic { node } = atom.kind {
            atomics[i] = size_atomic(tree, node, avail, avail);
        }
    }
    let placed = place(ifc, &atomics, avail, floats);
    let content_w = placed.lines.iter().map(|l| l.width).fold(0.0f32, f32::max);
    let width = inputs.known_dimensions.width.unwrap_or(content_w);
    let height = inputs.known_dimensions.height.unwrap_or(placed.height);

    if inputs.run_mode == RunMode::PerformLayout {
        let (frags, atomic_at) = fragments(ifc, &placed, &atomics, width);
        for (node, x, y) in atomic_at {
            let Some(i) = ifc
                .atoms
                .iter()
                .position(|a| matches!(a.kind, AtomKind::Atomic { node: n } if n == node))
            else {
                continue;
            };
            let a = atomics[i];
            let id = NodeId::from(node);
            let out = tree.compute_child_layout(
                id,
                input(
                    RunMode::PerformLayout,
                    Size {
                        width: Some(a.w),
                        height: Some(a.h),
                    },
                    avail,
                    Size {
                        width: AvailableSpace::Definite(a.w),
                        height: AvailableSpace::Definite(a.h),
                    },
                ),
            );
            let style = tree.nodes[node].style.clone();
            let b = if avail.is_finite() { avail } else { 0.0 };
            let lp = |v: taffy::LengthPercentage| v.resolve_or_zero(Some(b), resolve_calc);
            tree.set_unrounded_layout(
                id,
                &Layout {
                    order: 0,
                    location: Point { x, y },
                    size: out.size,
                    content_size: out.content_size,
                    scrollbar_size: Size::ZERO,
                    border: Rect {
                        left: lp(style.border.left),
                        right: lp(style.border.right),
                        top: lp(style.border.top),
                        bottom: lp(style.border.bottom),
                    },
                    padding: Rect {
                        left: lp(style.padding.left),
                        right: lp(style.padding.right),
                        top: lp(style.padding.top),
                        bottom: lp(style.padding.bottom),
                    },
                    margin: Rect {
                        left: a.ml,
                        right: a.mr,
                        top: a.mt,
                        bottom: a.mb,
                    },
                },
            );
        }
        tree.nodes[idx].frags = frags;
    }
    // A line with no height has no baseline to speak of: an inline-block holding
    // only such lines sits on its bottom edge instead.
    tree.nodes[idx].baseline = placed
        .metrics
        .last()
        .filter(|&&(_, height, _)| height > 0.0)
        .map(|&(top, _, asc)| top + asc);
    let first_baseline = placed.metrics.first().map(|&(_, _, asc)| asc);
    LayoutOutput::from_sizes_and_baselines(
        Size { width, height },
        Size {
            width: content_w,
            height: placed.height,
        },
        Point {
            x: None,
            y: first_baseline,
        },
    )
}
