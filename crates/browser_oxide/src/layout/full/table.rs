//! Tables: the automatic layout algorithm of CSS 2.1 §17.5.2, simplified.
//!
//! Columns are as wide as their widest cell wants when there is room, as narrow as
//! their narrowest allows when there is not, and in between share the difference
//! in proportion. `border-collapse: collapse` replaces cell borders by half of the
//! collapsed line they sit on; `border-spacing` separates the cells otherwise.
//! Captions go above or below the grid. Not handled: column elements, `table-layout: fixed`, a baseline
//! for `vertical-align: baseline`.

use taffy::util::ResolveOrZero;
use taffy::{
    AvailableSpace, Layout, LayoutInput, LayoutOutput, LayoutPartialTree, LengthPercentage, Line,
    NodeId, Point, Rect, RequestedAxis, RunMode, Size, SizingMode,
};

use crate::layout::full::tree::{resolve_calc, GroupKind, Role, Tree, VAlign};

struct Cell {
    node: usize,
    row: usize,
    col: usize,
    cs: usize,
    rs: usize,
    min: f32,
    max: f32,
    h: f32,
    /// What the row needs of this cell: its content, or the `height` it asked for.
    need: f32,
    want: Want,
}

/// The width a cell asks for with `width`.
#[derive(Clone, Copy, PartialEq, Default)]
enum Want {
    #[default]
    Auto,
    /// A length, as the cell's outer width.
    Fixed(f32),
    /// A fraction of the table.
    Percent(f32),
}

fn want_of(tree: &Tree, node: usize) -> Want {
    let style = &tree.nodes[node].style;
    let w = style.size.width;
    match w.tag() {
        taffy::CompactLength::LENGTH_TAG => {
            let edges = if style.box_sizing == taffy::BoxSizing::BorderBox {
                0.0
            } else {
                px(style.padding.left)
                    + px(style.padding.right)
                    + px(style.border.left)
                    + px(style.border.right)
            };
            Want::Fixed(w.value() + edges)
        }
        taffy::CompactLength::PERCENT_TAG => Want::Percent(w.value()),
        _ => Want::Auto,
    }
}

fn input(
    run_mode: RunMode,
    known: Size<Option<f32>>,
    available: Size<AvailableSpace>,
) -> LayoutInput {
    LayoutInput {
        run_mode,
        sizing_mode: SizingMode::InherentSize,
        axis: RequestedAxis::Both,
        known_dimensions: known,
        parent_size: Size {
            width: known.width,
            height: None,
        },
        available_space: available,
        vertical_margins_are_collapsible: Line::FALSE,
    }
}

fn px(v: LengthPercentage) -> f32 {
    v.resolve_or_zero(None, resolve_calc)
}

/// The rows of the table in rendering order — header groups first, footer groups
/// last — each with the group it sits in.
fn rows_of(tree: &Tree, table: usize) -> Vec<(usize, Option<usize>)> {
    let (mut head, mut body, mut foot) = (Vec::new(), Vec::new(), Vec::new());
    for &c in &tree.nodes[table].children {
        match tree.nodes[c].role {
            Role::Row => body.push((c, None)),
            Role::Group(kind) => {
                for &r in &tree.nodes[c].children {
                    if tree.nodes[r].role == Role::Row {
                        match kind {
                            GroupKind::Header => head.push((r, Some(c))),
                            GroupKind::Footer => foot.push((r, Some(c))),
                            GroupKind::Body => body.push((r, Some(c))),
                        }
                    }
                }
            }
            _ => {}
        }
    }
    head.into_iter().chain(body).chain(foot).collect()
}

fn place_cells(tree: &Tree, rows: &[(usize, Option<usize>)]) -> (Vec<Cell>, usize) {
    let mut occupied: Vec<Vec<bool>> = vec![Vec::new(); rows.len()];
    let mut cells = Vec::new();
    let mut ncols = 0;
    for (ri, &(row, _)) in rows.iter().enumerate() {
        let mut col = 0;
        for &cell in &tree.nodes[row].children {
            if tree.nodes[cell].role != Role::Cell {
                continue;
            }
            while occupied[ri].get(col).copied().unwrap_or(false) {
                col += 1;
            }
            let (cs, rs) = tree.nodes[cell].span;
            let (cs, rs) = (cs.max(1), rs.max(1).min(rows.len() - ri));
            for occ in occupied.iter_mut().skip(ri).take(rs) {
                if occ.len() < col + cs {
                    occ.resize(col + cs, false);
                }
                occ[col..col + cs].fill(true);
            }
            cells.push(Cell {
                node: cell,
                row: ri,
                col,
                cs,
                rs,
                min: 0.0,
                max: 0.0,
                h: 0.0,
                need: 0.0,
                want: want_of(tree, cell),
            });
            col += cs;
            ncols = ncols.max(col);
        }
    }
    (cells, ncols)
}

pub fn compute(tree: &mut Tree, node_id: NodeId, inputs: LayoutInput) -> LayoutOutput {
    let t = usize::from(node_id);
    let style = tree.nodes[t].style.clone();
    let Some(ts) = tree.nodes[t].table else {
        return LayoutOutput::HIDDEN;
    };
    let rows = rows_of(tree, t);
    let captions: Vec<usize> = tree.nodes[t]
        .children
        .iter()
        .copied()
        .filter(|&c| tree.nodes[c].role == Role::Caption)
        .collect();
    let (mut cells, ncols) = place_cells(tree, &rows);
    let nrows = rows.len();
    if ncols == 0 || nrows == 0 {
        let (bl, br) = (px(style.border.left), px(style.border.right));
        let (bt, bb) = (px(style.border.top), px(style.border.bottom));
        return LayoutOutput::from_outer_size(Size {
            width: bl + br,
            height: bt + bb,
        });
    }
    let (sx, sy) = if ts.collapse { (0.0, 0.0) } else { ts.spacing };

    // Borders. Collapsed: one line between neighbours, as wide as the widest of
    // the borders that meet on it; each cell takes half of each of its four.
    let (tb_l, tb_r) = (px(style.border.left), px(style.border.right));
    let (tb_t, tb_b) = (px(style.border.top), px(style.border.bottom));
    let mut v_lines = vec![0.0f32; ncols + 1];
    let mut h_lines = vec![0.0f32; nrows + 1];
    if ts.collapse {
        v_lines[0] = tb_l;
        v_lines[ncols] = tb_r;
        h_lines[0] = tb_t;
        h_lines[nrows] = tb_b;
        for c in &cells {
            let own = tree.nodes[c.node]
                .orig_border
                .unwrap_or(tree.nodes[c.node].style.border);
            v_lines[c.col] = v_lines[c.col].max(px(own.left));
            v_lines[c.col + c.cs] = v_lines[c.col + c.cs].max(px(own.right));
            h_lines[c.row] = h_lines[c.row].max(px(own.top));
            h_lines[c.row + c.rs] = h_lines[c.row + c.rs].max(px(own.bottom));
        }
        for c in &cells {
            let node = &mut tree.nodes[c.node];
            if node.orig_border.is_none() {
                node.orig_border = Some(node.style.border);
            }
            node.style.border = Rect {
                left: LengthPercentage::length(v_lines[c.col] / 2.0),
                right: LengthPercentage::length(v_lines[c.col + c.cs] / 2.0),
                top: LengthPercentage::length(h_lines[c.row] / 2.0),
                bottom: LengthPercentage::length(h_lines[c.row + c.rs] / 2.0),
            };
            tree.clear_cache(c.node);
        }
    }
    let (pad_l, pad_r, pad_t, pad_b) = if ts.collapse {
        (0.0, 0.0, 0.0, 0.0)
    } else {
        (
            px(style.padding.left),
            px(style.padding.right),
            px(style.padding.top),
            px(style.padding.bottom),
        )
    };
    let (edge_l, edge_r, edge_t, edge_b) = if ts.collapse {
        (
            v_lines[0] / 2.0,
            v_lines[ncols] / 2.0,
            h_lines[0] / 2.0,
            h_lines[nrows] / 2.0,
        )
    } else {
        (
            tb_l + pad_l + sx,
            tb_r + pad_r + sx,
            tb_t + pad_t + sy,
            tb_b + pad_b + sy,
        )
    };
    let fixed_w = edge_l + edge_r + sx * ncols.saturating_sub(1) as f32;

    // What each cell wants: its narrowest and widest.
    let space = |w: AvailableSpace| Size {
        width: w,
        height: AvailableSpace::MaxContent,
    };
    for c in &mut cells {
        let id = NodeId::from(c.node);
        let mut measure = |w: AvailableSpace| {
            let mut inputs = input(RunMode::ComputeSize, Size::NONE, space(w));
            inputs.sizing_mode = SizingMode::ContentSize;
            tree_width(tree, id, inputs)
        };
        c.min = measure(AvailableSpace::MinContent);
        c.max = measure(AvailableSpace::MaxContent).max(c.min);
    }
    let mut cmin = vec![0.0f32; ncols];
    let mut cmax = vec![0.0f32; ncols];
    for c in cells.iter().filter(|c| c.cs == 1) {
        cmin[c.col] = cmin[c.col].max(c.min);
        cmax[c.col] = cmax[c.col].max(c.max);
    }
    for c in cells.iter().filter(|c| c.cs > 1) {
        let spans = c.col..c.col + c.cs;
        let inner = sx * (c.cs - 1) as f32;
        // What a spanning cell wants beyond its columns goes to them in proportion to how
        // much room each has between its narrowest and widest (for the narrowest), or to
        // its width (for the widest).
        let slack: Vec<f32> = spans
            .clone()
            .map(|i| (cmax[i] - cmin[i]).max(0.0))
            .collect();
        for (want, narrowest) in [(c.min, true), (c.max, false)] {
            let col = if narrowest { &mut cmin } else { &mut cmax };
            let have: f32 = col[spans.clone()].iter().sum::<f32>() + inner;
            if want > have {
                let weights: Vec<f32> = if narrowest && slack.iter().sum::<f32>() > 0.0 {
                    slack.clone()
                } else {
                    col[spans.clone()].to_vec()
                };
                let own: f32 = weights.iter().sum();
                let extra = want - have;
                for (w, weight) in col[spans.clone()].iter_mut().zip(weights) {
                    let share = if own > 0.0 {
                        weight / own
                    } else {
                        1.0 / c.cs as f32
                    };
                    *w += extra * share;
                }
            }
        }
    }
    // `width` on a cell: a length sets what the column wants, a percentage what
    // share of the table it takes.
    let mut fixed = vec![false; ncols];
    let mut percent = vec![0.0f32; ncols];
    for c in cells.iter().filter(|c| c.cs == 1) {
        match c.want {
            Want::Fixed(w) => {
                fixed[c.col] = true;
                cmax[c.col] = w.max(cmin[c.col]);
            }
            Want::Percent(p) => percent[c.col] = percent[c.col].max(p),
            Want::Auto => {}
        }
    }
    for i in 0..ncols {
        cmax[i] = cmax[i].max(cmin[i]);
    }
    let (sum_min, sum_max) = (cmin.iter().sum::<f32>(), cmax.iter().sum::<f32>());
    // A caption is as wide as the table, which it keeps from being narrower than its own
    // narrowest.
    let caption_min = captions
        .iter()
        .map(|&c| {
            let mut inputs = input(
                RunMode::ComputeSize,
                Size::NONE,
                space(AvailableSpace::MinContent),
            );
            inputs.sizing_mode = SizingMode::ContentSize;
            tree_width(tree, NodeId::from(c), inputs)
        })
        .fold(0.0f32, f32::max);
    let natural_min = (sum_min + fixed_w).max(caption_min);
    let natural_max = (sum_max + fixed_w).max(natural_min);

    // The table's own width: what it asked for, or as much as it wants and there
    // is room for.
    let specified = (!style.size.width.is_auto())
        .then_some(inputs.known_dimensions.width)
        .flatten();
    let width = match (
        specified,
        inputs.known_dimensions.width,
        inputs.available_space.width,
    ) {
        (Some(w), _, _) => w.max(natural_min),
        (None, Some(room), _) | (None, None, AvailableSpace::Definite(room)) => {
            natural_max.min(natural_min.max(room))
        }
        (None, None, AvailableSpace::MinContent) => natural_min,
        (None, None, AvailableSpace::MaxContent) => natural_max,
    };
    let content = (width - fixed_w).max(sum_min);
    let cols: Vec<f32> = if content >= sum_max {
        // Room beyond what the columns want goes first to the percentages, then
        // to the columns without a width of their own, and only without any such
        // column to the rest.
        let mut cols = cmax.clone();
        let mut extra = content - sum_max;
        for i in (0..ncols).filter(|&i| percent[i] > 0.0) {
            let give = (percent[i] * content - cols[i]).clamp(0.0, extra);
            cols[i] += give;
            extra -= give;
        }
        let mut takers: Vec<usize> = (0..ncols)
            .filter(|&i| !fixed[i] && percent[i] == 0.0)
            .collect();
        if takers.is_empty() {
            takers = (0..ncols).filter(|&i| percent[i] == 0.0).collect();
        }
        if takers.is_empty() {
            takers = (0..ncols).collect();
        }
        let total: f32 = takers.iter().map(|&i| cmax[i]).sum();
        for &i in &takers {
            let share = if total > 0.0 {
                cmax[i] / total
            } else {
                1.0 / takers.len() as f32
            };
            cols[i] += extra * share;
        }
        cols
    } else {
        let t = if sum_max > sum_min {
            (content - sum_min) / (sum_max - sum_min)
        } else {
            0.0
        };
        (0..ncols)
            .map(|i| cmin[i] + t * (cmax[i] - cmin[i]))
            .collect()
    };
    let col_x: Vec<f32> = cols
        .iter()
        .scan(edge_l, |x, w| {
            let at = *x;
            *x += w + sx;
            Some(at)
        })
        .collect();

    // Heights, given those widths.
    let cell_w = |c: &Cell| cols[c.col..c.col + c.cs].iter().sum::<f32>() + sx * (c.cs - 1) as f32;
    if inputs.run_mode == RunMode::ComputeSize && inputs.axis == RequestedAxis::Horizontal {
        return LayoutOutput::from_outer_size(Size { width, height: 0.0 });
    }
    // A cell is laid out in full to find its height: taffy loses the collapsed
    // margins of nested blocks when it only measures. The same layout is the one
    // that stays; only the cell's box grows to the height of its row.
    let cell_inputs = |w: f32| {
        let mut inputs = input(
            RunMode::PerformLayout,
            Size {
                width: Some(w),
                height: None,
            },
            Size {
                width: AvailableSpace::Definite(w),
                height: AvailableSpace::MaxContent,
            },
        );
        inputs.sizing_mode = SizingMode::ContentSize;
        inputs
    };
    for c in &mut cells {
        let w = cell_w(c);
        c.h = tree_height(tree, NodeId::from(c.node), cell_inputs(w));
        let style = &tree.nodes[c.node].style;
        c.need = match style.size.height.into_option() {
            Some(h) if style.box_sizing == taffy::BoxSizing::BorderBox => c.h.max(h),
            Some(h) => c.h.max(
                h + px(style.padding.top)
                    + px(style.padding.bottom)
                    + px(style.border.top)
                    + px(style.border.bottom),
            ),
            None => c.h,
        };
    }
    let mut row_h = vec![0.0f32; nrows];
    for (r, &(row, _)) in rows.iter().enumerate() {
        if let Some(h) = tree.nodes[row].style.size.height.into_option() {
            row_h[r] = h;
        }
    }
    for c in cells.iter().filter(|c| c.rs == 1) {
        row_h[c.row] = row_h[c.row].max(c.need);
    }
    for c in cells.iter().filter(|c| c.rs > 1) {
        let have: f32 = row_h[c.row..c.row + c.rs].iter().sum::<f32>() + sy * (c.rs - 1) as f32;
        if c.need > have {
            row_h[c.row + c.rs - 1] += c.need - have;
        }
    }
    let caption_h: Vec<f32> = captions
        .iter()
        .map(|&c| tree_height(tree, NodeId::from(c), cell_inputs(width)))
        .collect();
    let caption_total: f32 = caption_h.iter().sum();
    let caption_above: f32 = captions
        .iter()
        .zip(&caption_h)
        .filter(|(&c, _)| !tree.nodes[c].caption_below)
        .map(|(_, h)| h)
        .sum();
    let row_y: Vec<f32> = row_h
        .iter()
        .scan(caption_above + edge_t, |y, h| {
            let at = *y;
            *y += h + sy;
            Some(at)
        })
        .collect();
    let height = caption_total
        + edge_t
        + edge_b
        + row_h.iter().sum::<f32>()
        + sy * nrows.saturating_sub(1) as f32;
    let height = style
        .size
        .height
        .into_option()
        .map_or(height, |h| h.max(height));
    let out = LayoutOutput::from_outer_size(Size { width, height });
    if inputs.run_mode != RunMode::PerformLayout {
        return out;
    }

    let grid_bottom = height - (caption_total - caption_above);
    let (mut above_y, mut below_y) = (0.0, grid_bottom);
    for (&c, &h) in captions.iter().zip(&caption_h) {
        let caption_y = if tree.nodes[c].caption_below {
            below_y
        } else {
            above_y
        };
        let done = tree.compute_child_layout(NodeId::from(c), cell_inputs(width));
        let style = tree.nodes[c].style.clone();
        tree.set_unrounded_layout(
            NodeId::from(c),
            &Layout {
                order: 0,
                location: Point {
                    x: 0.0,
                    y: caption_y,
                },
                size: Size { width, height: h },
                content_size: done.content_size,
                scrollbar_size: Size::ZERO,
                border: Rect {
                    left: px(style.border.left),
                    right: px(style.border.right),
                    top: px(style.border.top),
                    bottom: px(style.border.bottom),
                },
                padding: Rect {
                    left: px(style.padding.left),
                    right: px(style.padding.right),
                    top: px(style.padding.top),
                    bottom: px(style.padding.bottom),
                },
                margin: Rect::ZERO,
            },
        );
        if tree.nodes[c].caption_below {
            below_y += h;
        } else {
            above_y += h;
        }
    }

    // Placement: rows and groups are boxes of their own, cells sit in rows.
    let grid_w = cols.iter().sum::<f32>() + sx * (ncols - 1) as f32;
    let mut group_span: Vec<(usize, f32, f32)> = Vec::new();
    for (r, &(row, group)) in rows.iter().enumerate() {
        let (ry, rh) = (row_y[r], row_h[r]);
        set_box(tree, row, (edge_l, ry), (grid_w, rh));
        if let Some(g) = group {
            match group_span.iter_mut().find(|(n, _, _)| *n == g) {
                Some((_, top, bottom)) => {
                    *top = top.min(ry);
                    *bottom = bottom.max(ry + rh);
                }
                None => group_span.push((g, ry, ry + rh)),
            }
        }
    }
    for &(g, top, bottom) in &group_span {
        set_box(tree, g, (edge_l, top), (grid_w, bottom - top));
        for &r in &tree.nodes[g].children.clone() {
            if tree.nodes[r].role == Role::Row {
                tree.nodes[r].layout.location.x -= edge_l;
                tree.nodes[r].layout.location.y -= top;
            }
        }
    }
    for c in &cells {
        let w = cell_w(c);
        let h = row_h[c.row..c.row + c.rs].iter().sum::<f32>() + sy * (c.rs - 1) as f32;
        let id = NodeId::from(c.node);
        let done = tree.compute_child_layout(id, cell_inputs(w));
        let free = (h - c.h).max(0.0);
        let shift = match tree.nodes[c.node].valign {
            VAlign::Top => 0.0,
            VAlign::Middle => free / 2.0,
            VAlign::Bottom => free,
        };
        if shift > 0.0 {
            for k in tree.nodes[c.node].children.clone() {
                tree.nodes[k].layout.location.y += shift;
            }
        }
        let style = tree.nodes[c.node].style.clone();
        // A cell sits at the top of its row.
        tree.set_unrounded_layout(
            id,
            &Layout {
                order: 0,
                location: Point {
                    x: col_x[c.col] - edge_l,
                    y: 0.0,
                },
                size: Size {
                    width: done.size.width,
                    height: h,
                },
                content_size: done.content_size,
                scrollbar_size: Size::ZERO,
                border: Rect {
                    left: px(style.border.left),
                    right: px(style.border.right),
                    top: px(style.border.top),
                    bottom: px(style.border.bottom),
                },
                padding: Rect {
                    left: px(style.padding.left),
                    right: px(style.padding.right),
                    top: px(style.padding.top),
                    bottom: px(style.padding.bottom),
                },
                margin: Rect::ZERO,
            },
        );
    }
    out
}

fn set_box(tree: &mut Tree, node: usize, at: (f32, f32), size: (f32, f32)) {
    let layout = &mut tree.nodes[node].layout;
    layout.location = Point { x: at.0, y: at.1 };
    layout.size = Size {
        width: size.0,
        height: size.1,
    };
}

fn tree_width(tree: &mut Tree, id: NodeId, inputs: LayoutInput) -> f32 {
    tree.compute_child_layout(id, inputs).size.width
}

fn tree_height(tree: &mut Tree, id: NodeId, inputs: LayoutInput) -> f32 {
    tree.compute_child_layout(id, inputs).size.height
}
