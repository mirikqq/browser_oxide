//! Multi-column containers (`column-count`, `column-width`): the content is laid out as one
//! tall column as wide as a column, then cut into columns of equal height at the places a
//! break may go — between boxes, and between the lines of a paragraph (never leaving fewer
//! than two on either side), unless `break-inside: avoid` keeps a box whole — and the pieces
//! are moved side by side. A box cut in two is reported as the union of its pieces, as
//! Chrome does.

use taffy::util::ResolveOrZero;
use taffy::{
    compute_block_layout, AvailableSpace, BlockContext, Display, LayoutInput, LayoutOutput, NodeId,
    Position, RunMode, Size,
};

use crate::layout::full::tree::{resolve_calc, Role, Tree};

/// What a container with columns asked for.
#[derive(Clone, Copy, Debug)]
pub struct MultiCol {
    pub count: Option<usize>,
    pub width: Option<f32>,
    pub gap: f32,
}

/// A place where a column may end: what is above it ends at `end`, what is below it starts at
/// `start` (the margin between is dropped), both counted from the top of the content.
#[derive(Clone, Copy)]
struct Break {
    end: f32,
    start: f32,
}

/// The columns' contents, each from `starts[k]` to `ends[k]` of the one tall column.
struct Cut {
    starts: Vec<f32>,
    ends: Vec<f32>,
}

impl Cut {
    fn height(&self) -> f32 {
        self.starts
            .iter()
            .zip(&self.ends)
            .map(|(s, e)| e - s)
            .fold(0.0, f32::max)
    }

    /// The column the content at `u` is in.
    fn at(&self, u: f32) -> usize {
        self.starts.iter().rposition(|&s| s <= u + EPS).unwrap_or(0)
    }

    /// The column that content ending at `u` ends in.
    fn at_bottom(&self, u: f32) -> usize {
        self.starts.iter().rposition(|&s| s < u - EPS).unwrap_or(0)
    }
}

const EPS: f32 = 0.01;

/// How many columns there are, and how wide each is, in `inner` px.
fn used(mc: MultiCol, inner: f32) -> (usize, f32) {
    let fit = |width: f32| ((inner + mc.gap) / (width + mc.gap)).floor().max(1.0) as usize;
    let n = match (mc.count, mc.width) {
        (Some(count), Some(width)) => count.min(fit(width)),
        (Some(count), None) => count,
        (None, Some(width)) => fit(width),
        (None, None) => 1,
    }
    .max(1);
    (n, ((inner - mc.gap * (n - 1) as f32) / n as f32).max(0.0))
}

pub fn compute(
    tree: &mut Tree,
    node_id: NodeId,
    inputs: LayoutInput,
    block_ctx: Option<&mut BlockContext<'_>>,
) -> LayoutOutput {
    let idx = usize::from(node_id);
    let (Some(mc), Some(outer)) = (tree.nodes[idx].multicol, inputs.known_dimensions.width) else {
        return compute_block_layout(tree, node_id, inputs, block_ctx);
    };
    let style = tree.nodes[idx].style.clone();
    let lp = |v: taffy::LengthPercentage| v.resolve_or_zero(None, resolve_calc);
    let (el, er) = (
        lp(style.padding.left) + lp(style.border.left),
        lp(style.padding.right) + lp(style.border.right),
    );
    let (et, eb) = (
        lp(style.padding.top) + lp(style.border.top),
        lp(style.padding.bottom) + lp(style.border.bottom),
    );
    let (columns, width) = used(mc, (outer - el - er).max(0.0));
    if columns < 2 {
        return compute_block_layout(tree, node_id, inputs, block_ctx);
    }

    // One column's worth of width, laid out in full: the pieces come from this.
    let probe = LayoutInput {
        known_dimensions: Size {
            width: Some(width + el + er),
            height: None,
        },
        available_space: Size {
            width: AvailableSpace::Definite(width + el + er),
            height: AvailableSpace::MaxContent,
        },
        run_mode: RunMode::PerformLayout,
        ..inputs
    };
    let flow = compute_block_layout(tree, node_id, probe, block_ctx);
    let total = (flow.size.height - et - eb).max(0.0);

    let mut breaks = Vec::new();
    gather(tree, idx, (0.0, 0.0), et, &mut breaks);
    breaks.sort_by(|a, b| a.end.total_cmp(&b.end));
    let fixed = inputs
        .known_dimensions
        .height
        .map(|h| (h - et - eb).max(0.0));
    let cut = fixed
        .and_then(|h| cut(&breaks, total, h, columns))
        .unwrap_or_else(|| balance(&breaks, total, columns));
    let height = fixed.unwrap_or_else(|| cut.height());

    if inputs.run_mode == RunMode::PerformLayout {
        let step = width + mc.gap;
        for c in tree.nodes[idx].children.clone() {
            reposition(tree, c, (0.0, 0.0), (0.0, 0.0), &cut, step, et, height);
        }
    }
    LayoutOutput::from_outer_size(Size {
        width: outer,
        height: height + et + eb,
    })
}

fn in_flow(tree: &Tree, n: usize) -> bool {
    let node = &tree.nodes[n];
    node.style.position == Position::Relative
        && node.style.display != Display::None
        && node.style.float == taffy::Float::None
        && node.role != Role::Marker
}

/// Where a column may end inside the box `n`, whose border box is at `abs` in the container:
/// between its in-flow children, and between the lines of its inline content.
fn gather(tree: &Tree, n: usize, abs: (f32, f32), et: f32, out: &mut Vec<Break>) {
    let node = &tree.nodes[n];
    if node.ifc.is_some() {
        let lines = node.lines.len();
        for (i, &(top, _)) in node.lines.iter().enumerate() {
            if i >= 2 && lines - i >= 2 {
                let y = abs.1 + top - et;
                out.push(Break { end: y, start: y });
            }
        }
        return;
    }
    if node.break_avoid || node.role == Role::Table {
        return;
    }
    let kids: Vec<usize> = node
        .children
        .iter()
        .copied()
        .filter(|&c| in_flow(tree, c))
        .collect();
    for (i, &c) in kids.iter().enumerate() {
        let layout = &tree.nodes[c].layout;
        let at = (abs.0 + layout.location.x, abs.1 + layout.location.y);
        if let Some(&p) = i.checked_sub(1).and_then(|j| kids.get(j)) {
            let before = &tree.nodes[p].layout;
            let end = abs.1 + before.location.y + before.size.height - et;
            let start = at.1 - et;
            if end <= start + EPS {
                out.push(Break { end, start });
            }
        }
        gather(tree, c, at, et, out);
    }
}

/// The columns of height `limit` when each ends at the last break that fits, if the content
/// fits in `columns` of them.
fn cut(breaks: &[Break], total: f32, limit: f32, columns: usize) -> Option<Cut> {
    let (mut starts, mut ends) = (vec![0.0f32], Vec::new());
    for k in 0..columns {
        let start = starts[k];
        if total <= start + limit + EPS {
            ends.push(total);
            return Some(Cut { starts, ends });
        }
        let best = breaks
            .iter()
            .filter(|b| b.end <= start + limit + EPS && b.end > start + EPS)
            .max_by(|a, b| a.end.total_cmp(&b.end))?;
        ends.push(best.end);
        starts.push(best.start);
    }
    None
}

/// The shortest columns the content fits in, as Chrome balances them.
fn balance(breaks: &[Break], total: f32, columns: usize) -> Cut {
    let (mut lo, mut hi) = (total / columns as f32, total);
    if let Some(cut) = cut(breaks, total, lo, columns) {
        return cut;
    }
    for _ in 0..48 {
        let mid = (lo + hi) / 2.0;
        if cut(breaks, total, mid, columns).is_some() {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    cut(breaks, total, hi, columns).unwrap_or(Cut {
        starts: vec![0.0],
        ends: vec![total],
    })
}

/// Move the box `n` and what is in it into its column. `virt` is where its border box is in the
/// tall column, `parent` where its parent now is, `column` how tall the columns are (a box that
/// goes on in the next column fills the one it is in).
fn reposition(
    tree: &mut Tree,
    n: usize,
    virt: (f32, f32),
    parent: (f32, f32),
    cut: &Cut,
    step: f32,
    et: f32,
    column: f32,
) {
    let layout = tree.nodes[n].layout;
    let at = (virt.0 + layout.location.x, virt.1 + layout.location.y);
    let (top, bottom) = (at.1 - et, at.1 - et + layout.size.height);
    let first = cut.at(top);
    let last = cut.at_bottom(bottom).max(first);
    let (new, size) = if first == last {
        (
            (at.0 + first as f32 * step, et + top - cut.starts[first]),
            layout.size,
        )
    } else {
        // Cut in two or more: the union of the pieces.
        let reach = (first..=last)
            .map(|k| {
                if k == last {
                    bottom - cut.starts[k]
                } else {
                    column
                }
            })
            .fold(0.0, f32::max);
        (
            (at.0 + first as f32 * step, et),
            Size {
                width: layout.size.width + (last - first) as f32 * step,
                height: reach,
            },
        )
    };
    {
        let node = &mut tree.nodes[n];
        node.layout.location = taffy::Point {
            x: new.0 - parent.0,
            y: new.1 - parent.1,
        };
        node.layout.size = size;
        for frag in &mut node.frags {
            let y = at.1 + frag.rect[1] - et;
            let k = cut.at(y);
            let moved = (
                at.0 + frag.rect[0] + k as f32 * step,
                et + y - cut.starts[k],
            );
            let base = et + (at.1 + frag.baseline - et) - cut.starts[k];
            frag.rect[0] = moved.0 - new.0;
            frag.rect[1] = moved.1 - new.1;
            frag.baseline = base - new.1;
        }
    }
    for c in tree.nodes[n].children.clone() {
        reposition(tree, c, at, new, cut, step, et, column);
    }
}
