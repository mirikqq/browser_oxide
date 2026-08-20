use crate::dom::node::NodeId;
use crate::js_runtime::state::DomState;
use deno_core::op2;
use deno_core::OpState;
use serde::Serialize;

#[derive(Serialize)]
pub struct DOMRectJson {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// Get bounding rect using real taffy layout computation.
#[op2]
#[serde]
pub fn op_layout_get_bounding_rect(state: &mut OpState, #[smi] node_id: i32) -> DOMRectJson {
    let state = state.borrow_mut::<DomState>();
    let nid = NodeId::from_raw(node_id as u32);
    let rect = state.layout_engine.get_bounding_rect(&state.dom, nid);
    DOMRectJson {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.y,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
        left: rect.x,
    }
}

#[op2(fast)]
#[smi]
pub fn op_layout_get_offset_width(state: &mut OpState, #[smi] node_id: i32) -> i32 {
    let state = state.borrow_mut::<DomState>();
    let nid = NodeId::from_raw(node_id as u32);
    state
        .layout_engine
        .get_offset_width(&state.dom, nid)
        .round() as i32
}

#[op2(fast)]
#[smi]
pub fn op_layout_get_offset_height(state: &mut OpState, #[smi] node_id: i32) -> i32 {
    let state = state.borrow_mut::<DomState>();
    let nid = NodeId::from_raw(node_id as u32);
    state
        .layout_engine
        .get_offset_height(&state.dom, nid)
        .round() as i32
}

#[op2(fast)]
#[smi]
pub fn op_layout_get_offset_top(state: &mut OpState, #[smi] node_id: i32) -> i32 {
    let state = state.borrow_mut::<DomState>();
    let nid = NodeId::from_raw(node_id as u32);
    state.layout_engine.get_offset_top(&state.dom, nid).round() as i32
}

#[op2(fast)]
#[smi]
pub fn op_layout_get_offset_left(state: &mut OpState, #[smi] node_id: i32) -> i32 {
    let state = state.borrow_mut::<DomState>();
    let nid = NodeId::from_raw(node_id as u32);
    state.layout_engine.get_offset_left(&state.dom, nid).round() as i32
}

/// Get computed style — reads from inline style attribute first, falls back to defaults.
/// This op needs DomState but lives here for historical reasons.
/// It's actually registered in dom_ext now — see op_dom_get_computed_style.
/// Kept as fallback for the JS bridge that still calls this name.
#[op2]
#[string]
pub fn op_get_computed_style(#[smi] _node_id: i32, #[string] property: &str) -> String {
    css_default(property)
}

pub fn css_default(property: &str) -> String {
    // The value `getComputedStyle` reports for a property nothing has set.
    //
    // Returning `""` for the unlisted majority — which is what this did — is
    // not a harmless gap: page code reads these and does arithmetic on them,
    // and `parseFloat("")` is `NaN`. That `NaN` then propagates into the styles
    // the page writes back, so an element ends up with `height: NaN` and
    // `background-size: 120px NaNpx` and simply does not paint. Measured on
    // hCaptcha's tile grid, whose tiles are sized from computed metrics.
    //
    // Values below are the initial values Chrome reports on a plain element.
    match property {
        // Box
        "display" => "block".into(),
        "visibility" => "visible".into(),
        "opacity" => "1".into(),
        "position" => "static".into(),
        "float" => "none".into(),
        "clear" => "none".into(),
        "box-sizing" => "content-box".into(),
        "width" | "height" => "auto".into(),
        "min-width" | "min-height" => "0px".into(),
        "max-width" | "max-height" => "none".into(),
        "aspect-ratio" => "auto".into(),
        "top" | "right" | "bottom" | "left" | "inset" => "auto".into(),
        "z-index" => "auto".into(),
        "overflow" | "overflow-x" | "overflow-y" => "visible".into(),
        "resize" => "none".into(),
        "zoom" => "1".into(),

        // Spacing
        "margin" | "margin-top" | "margin-right" | "margin-bottom" | "margin-left" => "0px".into(),
        "padding" | "padding-top" | "padding-right" | "padding-bottom" | "padding-left" => {
            "0px".into()
        }
        "gap" | "row-gap" | "column-gap" => "normal".into(),

        // Borders and outline
        "border-width"
        | "border-top-width"
        | "border-right-width"
        | "border-bottom-width"
        | "border-left-width"
        | "outline-width" => "0px".into(),
        "border-style"
        | "border-top-style"
        | "border-right-style"
        | "border-bottom-style"
        | "border-left-style"
        | "outline-style" => "none".into(),
        "border-color"
        | "border-top-color"
        | "border-right-color"
        | "border-bottom-color"
        | "border-left-color"
        | "outline-color" => "rgb(0, 0, 0)".into(),
        "border-radius"
        | "border-top-left-radius"
        | "border-top-right-radius"
        | "border-bottom-left-radius"
        | "border-bottom-right-radius" => "0px".into(),
        "outline-offset" => "0px".into(),

        // Colour and background
        "color" => "rgb(0, 0, 0)".into(),
        "background-color" => "rgba(0, 0, 0, 0)".into(),
        "background-image" => "none".into(),
        "background-size" => "auto".into(),
        "background-position" => "0% 0%".into(),
        "background-position-x" | "background-position-y" => "0%".into(),
        "background-repeat" => "repeat".into(),
        "background-attachment" => "scroll".into(),
        "background-clip" => "border-box".into(),
        "background-origin" => "padding-box".into(),
        "background-blend-mode" | "mix-blend-mode" => "normal".into(),
        "isolation" => "auto".into(),
        "box-shadow" | "text-shadow" | "filter" | "backdrop-filter" | "clip-path" | "mask" => {
            "none".into()
        }

        // Text
        "font-size" => "16px".into(),
        "font-family" => "\"Times New Roman\"".into(),
        "font-style" => "normal".into(),
        "font-weight" => "400".into(),
        "font-stretch" => "100%".into(),
        "font-variant" => "normal".into(),
        "line-height" => "normal".into(),
        "letter-spacing" => "normal".into(),
        "word-spacing" => "0px".into(),
        "text-align" => "start".into(),
        "text-indent" => "0px".into(),
        "text-transform" => "none".into(),
        "text-decoration" => "none solid rgb(0, 0, 0)".into(),
        "text-decoration-line" => "none".into(),
        "text-decoration-style" => "solid".into(),
        "text-decoration-color" => "rgb(0, 0, 0)".into(),
        "white-space" => "normal".into(),
        "word-break" => "normal".into(),
        "overflow-wrap" | "word-wrap" => "normal".into(),
        "vertical-align" => "baseline".into(),
        "direction" => "ltr".into(),
        "writing-mode" => "horizontal-tb".into(),
        "text-overflow" => "clip".into(),

        // Flex and grid
        "flex-direction" => "row".into(),
        "flex-wrap" => "nowrap".into(),
        "flex-grow" | "order" => "0".into(),
        "flex-shrink" => "1".into(),
        "flex-basis" => "auto".into(),
        "justify-content" | "align-items" | "align-content" | "justify-items" => "normal".into(),
        "align-self" | "justify-self" => "auto".into(),
        "grid-template-columns" | "grid-template-rows" | "grid-template-areas" => "none".into(),
        "grid-auto-flow" => "row".into(),
        "grid-auto-columns" | "grid-auto-rows" => "auto".into(),

        // Transform, transition, animation
        "transform" => "none".into(),
        "transform-origin" => "50% 50%".into(),
        "transform-style" => "flat".into(),
        "perspective" => "none".into(),
        "perspective-origin" => "50% 50%".into(),
        "backface-visibility" => "visible".into(),
        "transition" => "all 0s ease 0s".into(),
        "transition-duration" | "transition-delay" => "0s".into(),
        "transition-property" => "all".into(),
        "transition-timing-function" => "ease".into(),
        "animation" => "none 0s ease 0s 1 normal none running".into(),
        "animation-name" => "none".into(),
        "animation-duration" | "animation-delay" => "0s".into(),
        "animation-iteration-count" => "1".into(),
        "will-change" => "auto".into(),

        // Replaced content and interaction
        "object-fit" => "fill".into(),
        "object-position" => "50% 50%".into(),
        "cursor" => "auto".into(),
        "pointer-events" => "auto".into(),
        "touch-action" => "auto".into(),
        "user-select" => "auto".into(),
        "appearance" => "none".into(),
        "content" => "normal".into(),
        "list-style-type" => "disc".into(),
        "list-style-position" => "outside".into(),
        "list-style-image" => "none".into(),
        "table-layout" => "auto".into(),
        "border-collapse" => "separate".into(),
        "border-spacing" => "0px 0px".into(),
        "caption-side" => "top".into(),
        "empty-cells" => "show".into(),

        _ => "".into(),
    }
}

deno_core::extension!(
    layout_extension,
    ops = [
        op_layout_get_bounding_rect,
        op_layout_get_offset_width,
        op_layout_get_offset_height,
        op_layout_get_offset_top,
        op_layout_get_offset_left,
        op_get_computed_style,
    ],
);
