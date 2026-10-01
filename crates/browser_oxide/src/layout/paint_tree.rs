//! A flat, absolutely-positioned view of the laid-out document, for the painter.
//!
//! Layout keeps its results in a taffy tree whose node positions are relative to
//! their parent, and discards each element's style once it has been turned into a
//! taffy style. Painting needs both — where a box is, and what it looks like — so
//! [`PaintStyle`] is recorded per element while the tree is built, and
//! [`LayoutEngine::paint_boxes`] joins it with the geometry.
//!
//! Known limits: `font-size` is computed correctly by the style pass but text is
//! still measured by layout's rough 0.6em-per-character rule; `background`
//! shorthands and border colours are not parsed yet, so borders take the text
//! colour.

use std::collections::HashMap;

use crate::css_cascade::ComputedStyle;
use crate::css_values::property::{CssValue, PropertyId};
use crate::css_values::types::color::Color;
use crate::css_values::types::display::{Overflow, Visibility};
use crate::css_values::types::font::{FontStyle, FontWeight};
use crate::css_values::types::length::Length;
use crate::dom::node::{NodeData, NodeId};
use crate::dom::Dom;
use crate::layout::engine::LayoutEngine;
use crate::layout::full::ifc::{Frag, FragKind};

/// A colour as straight (non-premultiplied) RGBA bytes.
pub type Rgba = [u8; 4];

/// What the painter needs from one element's computed style. Inheritance has
/// already happened in the style pass, so these are the values in effect.
#[derive(Debug, Clone)]
pub struct PaintStyle {
    pub background: Option<Rgba>,
    pub color: Rgba,
    pub font_size: f32,
    /// `font-family` as a canvas `font` shorthand would take it.
    pub font_family: String,
    pub bold: bool,
    pub italic: bool,
    pub hidden: bool,
    /// This element's own `opacity`; the painter multiplies it down the tree.
    pub opacity: f32,
    /// `overflow` is anything but `visible` on either axis: descendants are
    /// clipped to this box.
    pub clips: bool,
    /// Border colours, top / right / bottom / left.
    pub border_color: [Rgba; 4],
}

fn rgba_of(color: &Color) -> Rgba {
    let (r, g, b, a) = color.to_rgba();
    [r, g, b, (a.clamp(0.0, 1.0) * 255.0).round() as u8]
}

impl PaintStyle {
    pub(crate) fn from_computed(c: &ComputedStyle) -> Self {
        let color = match c.get(&PropertyId::Color) {
            Some(CssValue::Color(Color::CurrentColor)) | None => [0, 0, 0, 255],
            Some(CssValue::Color(col)) => rgba_of(col),
            _ => [0, 0, 0, 255],
        };
        let background = match c.get(&PropertyId::BackgroundColor) {
            Some(CssValue::Color(Color::CurrentColor)) => Some(color),
            Some(CssValue::Color(col)) => Some(rgba_of(col)).filter(|rgba| rgba[3] > 0),
            _ => None,
        };
        let font_size = match c.get(&PropertyId::FontSize) {
            Some(CssValue::Length(Length::Px(v))) => *v as f32,
            _ => 16.0,
        };
        let bold = match c.get(&PropertyId::FontWeight) {
            Some(CssValue::FontWeight(FontWeight::Bold | FontWeight::Bolder)) => true,
            Some(CssValue::FontWeight(FontWeight::Numeric(n))) => *n >= 600.0,
            _ => false,
        };
        let italic = matches!(
            c.get(&PropertyId::FontStyle),
            Some(CssValue::FontStyle(s)) if *s != FontStyle::Normal
        );
        let hidden = matches!(
            c.get(&PropertyId::Visibility),
            Some(CssValue::Visibility(v)) if *v != Visibility::Visible
        );
        let opacity = match c.get(&PropertyId::Opacity) {
            Some(CssValue::Number(v)) => (*v as f32).clamp(0.0, 1.0),
            _ => 1.0,
        };
        let clips = [PropertyId::OverflowX, PropertyId::OverflowY]
            .iter()
            .any(|p| {
                matches!(
                    c.get(p),
                    Some(CssValue::Overflow(o)) if *o != Overflow::Visible
                )
            });
        let border_color = [
            PropertyId::BorderTopColor,
            PropertyId::BorderRightColor,
            PropertyId::BorderBottomColor,
            PropertyId::BorderLeftColor,
        ]
        .map(|p| match c.get(&p) {
            Some(CssValue::Color(Color::CurrentColor)) | None => color,
            Some(CssValue::Color(col)) => rgba_of(col),
            _ => color,
        });
        Self {
            background,
            color,
            font_size,
            font_family: crate::layout::full::font::family_list(c),
            bold,
            italic,
            hidden,
            opacity,
            clips,
            border_color,
        }
    }
}

/// One thing to paint: an element's box, or a text node's run.
#[derive(Debug, Clone)]
pub struct PaintBox {
    pub node: NodeId,
    /// Border box in document coordinates (not scrolled).
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    /// Lowercase tag name; `None` for a text node.
    pub tag: Option<String>,
    /// The text of a text-node run, whitespace as authored.
    pub text: Option<String>,
    /// Set for a line of text layout already broke: the absolute y of its
    /// baseline. The painter draws it as it is instead of wrapping it again.
    pub text_baseline: Option<f32>,
    pub background: Option<Rgba>,
    /// Text colour.
    pub color: Rgba,
    /// Font size in px.
    pub font_size: f32,
    pub font_family: String,
    pub bold: bool,
    pub italic: bool,
    /// Border widths, top / right / bottom / left.
    pub border: [f32; 4],
    /// Border colours, top / right / bottom / left.
    pub border_color: [Rgba; 4],
    /// `visibility` is visible: the box's own background, border and text paint.
    pub visible: bool,
    /// Product of this box's and its ancestors' `opacity`.
    pub opacity: f32,
    /// Ancestors' overflow clip in document coordinates, `[x, y, w, h]`.
    pub clip: Option<[f32; 4]>,
}

/// The tag of a box that belongs to a pseudo-element: it is drawn like an element.
const PSEUDO_TAG: &str = "::pseudo";

/// What flows from parent to child while the tree is walked: only what the
/// style pass cannot have done for us, because it is not inherited — `opacity`
/// compounds and `overflow` clips accumulate.
#[derive(Clone)]
struct Inherited {
    opacity: f32,
    clip: Option<[f32; 4]>,
}

fn intersect(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    let x0 = a[0].max(b[0]);
    let y0 = a[1].max(b[1]);
    let x1 = (a[0] + a[2]).min(b[0] + b[2]);
    let y1 = (a[1] + a[3]).min(b[1] + b[3]);
    [x0, y0, (x1 - x0).max(0.0), (y1 - y0).max(0.0)]
}

impl LayoutEngine {
    /// Every box of the document in paint order (a pre-order walk, so a parent's
    /// background precedes its children), with document coordinates.
    ///
    /// Out-of-flow boxes come after the in-flow content of the block they were
    /// attached to, which approximates stacking for the common case; `z-index` is
    /// not honoured yet.
    pub fn paint_boxes(&mut self, dom: &Dom) -> Vec<PaintBox> {
        self.ensure_computed(dom);
        if let Some(full) = self.full.as_ref() {
            let dom_of = full
                .dom_to_node
                .iter()
                .map(|(d, n)| (taffy::NodeId::from(*n), *d))
                .collect();
            return self.walk_paint(
                dom,
                full.root.map(taffy::NodeId::from),
                dom_of,
                |id| Some(full.tree.nodes[usize::from(id)].layout),
                |id| {
                    let node = &full.tree.nodes[usize::from(id)];
                    if node.paint_hidden {
                        return Vec::new();
                    }
                    node.children
                        .iter()
                        .map(|c| taffy::NodeId::from(*c))
                        .collect()
                },
                |id| full.tree.nodes[usize::from(id)].frags.clone(),
            );
        }
        let dom_of = self
            .dom_to_taffy
            .iter()
            .map(|(dom_id, taffy_id)| (*taffy_id, *dom_id))
            .collect();
        self.walk_paint(
            dom,
            self.root_taffy,
            dom_of,
            |id| self.tree.layout(id).copied().ok(),
            |id| self.tree.children(id).unwrap_or_default(),
            |_| Vec::new(),
        )
    }

    fn walk_paint(
        &self,
        dom: &Dom,
        root: Option<taffy::NodeId>,
        dom_of: HashMap<taffy::NodeId, u32>,
        layout_of: impl Fn(taffy::NodeId) -> Option<taffy::Layout>,
        children_of: impl Fn(taffy::NodeId) -> Vec<taffy::NodeId>,
        frags_of: impl Fn(taffy::NodeId) -> Vec<Frag>,
    ) -> Vec<PaintBox> {
        let Some(root) = root else {
            return Vec::new();
        };
        let base = Inherited {
            opacity: 1.0,
            clip: None,
        };
        let mut out = Vec::new();
        // (taffy node, parent's absolute origin, inherited state)
        let mut stack = vec![(root, (0.0f32, 0.0f32), base)];
        while let Some((tid, (px, py), inh)) = stack.pop() {
            let Some(layout) = layout_of(tid) else {
                continue;
            };
            let (x, y) = (px + layout.location.x, py + layout.location.y);
            let (w, h) = (layout.size.width, layout.size.height);
            let mut child_inh = inh.clone();

            let dom_id_of = dom_of.get(&tid).copied();
            let node_data = dom_id_of
                .map(|dom_id| (dom_id, NodeId::from_raw(dom_id)))
                .and_then(|(dom_id, node)| dom.get(node).map(|n| (dom_id, node, n)));
            // A pseudo-element has a style and a box but no node in the document.
            if let (None, Some(dom_id)) = (&node_data, dom_id_of) {
                if let Some(style) = self.paint_styles.get(&dom_id) {
                    child_inh.opacity = inh.opacity * style.opacity;
                    out.push(PaintBox {
                        node: NodeId::from_raw(dom_id),
                        x,
                        y,
                        width: w,
                        height: h,
                        tag: Some(PSEUDO_TAG.to_string()),
                        text: None,
                        text_baseline: None,
                        background: style.background,
                        color: style.color,
                        font_size: style.font_size,
                        font_family: style.font_family.clone(),
                        bold: style.bold,
                        italic: style.italic,
                        border: [
                            layout.border.top,
                            layout.border.right,
                            layout.border.bottom,
                            layout.border.left,
                        ],
                        border_color: style.border_color,
                        visible: !style.hidden,
                        opacity: child_inh.opacity,
                        clip: inh.clip,
                    });
                    if style.clips {
                        let own = [x, y, w, h];
                        child_inh.clip = Some(match inh.clip {
                            Some(c) => intersect(c, own),
                            None => own,
                        });
                    }
                }
            }
            if let Some((dom_id, node, n)) = node_data {
                match &n.data {
                    NodeData::Element(elem) => {
                        if let Some(style) = self.paint_styles.get(&dom_id) {
                            child_inh.opacity = inh.opacity * style.opacity;
                            out.push(PaintBox {
                                node,
                                x,
                                y,
                                width: w,
                                height: h,
                                tag: Some(elem.name.local.to_ascii_lowercase()),
                                text: None,
                                text_baseline: None,
                                background: style.background,
                                color: style.color,
                                font_size: style.font_size,
                                font_family: style.font_family.clone(),
                                bold: style.bold,
                                italic: style.italic,
                                border: [
                                    layout.border.top,
                                    layout.border.right,
                                    layout.border.bottom,
                                    layout.border.left,
                                ],
                                border_color: style.border_color,
                                visible: !style.hidden,
                                opacity: child_inh.opacity,
                                clip: inh.clip,
                            });
                            if style.clips {
                                let own = [x, y, w, h];
                                child_inh.clip = Some(match inh.clip {
                                    Some(c) => intersect(c, own),
                                    None => own,
                                });
                            }
                        }
                    }
                    NodeData::Text(text) => {
                        // A text run is painted in its parent's style.
                        if let Some(style) =
                            n.parent.and_then(|p| self.paint_styles.get(&p.to_raw()))
                        {
                            out.push(PaintBox {
                                node,
                                x,
                                y,
                                width: w,
                                height: h,
                                tag: None,
                                text: Some(text.to_string()),
                                text_baseline: None,
                                background: None,
                                color: style.color,
                                font_size: style.font_size,
                                font_family: style.font_family.clone(),
                                bold: style.bold,
                                italic: style.italic,
                                border: [0.0; 4],
                                border_color: [style.color; 4],
                                visible: !style.hidden,
                                opacity: inh.opacity,
                                clip: inh.clip,
                            });
                        }
                    }
                    _ => {}
                }
            }

            // Inline content: the boxes of inline elements first, so their
            // backgrounds sit under the text, then the lines of text.
            let mut frags = frags_of(tid);
            frags.sort_by_key(|f| f.kind == FragKind::Text);
            for f in frags {
                let Some(style) = self.paint_styles.get(&f.owner) else {
                    continue;
                };
                let (fx, fy) = (x + f.rect[0], y + f.rect[1]);
                match f.kind {
                    FragKind::Box => {
                        let tag = match dom.get(NodeId::from_raw(f.dom)) {
                            Some(n) => match n.as_element() {
                                Some(elem) => Some(elem.name.local.to_ascii_lowercase()),
                                None => continue,
                            },
                            None => Some(PSEUDO_TAG.to_string()),
                        };
                        out.push(PaintBox {
                            node: NodeId::from_raw(f.dom),
                            x: fx,
                            y: fy,
                            width: f.rect[2],
                            height: f.rect[3],
                            tag,
                            text: None,
                            text_baseline: None,
                            background: style.background,
                            color: style.color,
                            font_size: style.font_size,
                            font_family: style.font_family.clone(),
                            bold: style.bold,
                            italic: style.italic,
                            border: f.border,
                            border_color: style.border_color,
                            visible: !style.hidden,
                            opacity: inh.opacity * style.opacity,
                            clip: inh.clip,
                        });
                    }
                    FragKind::Text => out.push(PaintBox {
                        node: NodeId::from_raw(f.dom),
                        x: fx,
                        y: fy,
                        width: f.rect[2],
                        height: f.rect[3],
                        tag: None,
                        text: Some(f.text.clone()),
                        text_baseline: Some(y + f.baseline),
                        background: None,
                        color: style.color,
                        font_size: style.font_size,
                        font_family: style.font_family.clone(),
                        bold: style.bold,
                        italic: style.italic,
                        border: [0.0; 4],
                        border_color: [style.color; 4],
                        visible: !style.hidden,
                        opacity: inh.opacity * style.opacity,
                        clip: inh.clip,
                    }),
                }
            }

            for child in children_of(tid).into_iter().rev() {
                stack.push((child, (x, y), child_inh.clone()));
            }
        }
        out
    }

    /// Height of the whole document: the lowest edge of anything laid out.
    pub fn document_height(&mut self, dom: &Dom) -> f32 {
        self.paint_boxes(dom)
            .iter()
            .map(|b| b.y + b.height)
            .fold(0.0, f32::max)
    }
}
