use crate::css_values::calc::{resolve_computed_value, resolve_length_to_px};
use crate::css_values::types::length::CalcContext;
use crate::dom::node::NodeId;
use crate::dom::DomElement;
use crate::js_runtime::realms::{op_frame_window, op_incumbent_window, op_realm_switch};
use crate::js_runtime::state::DomState;
use crate::js_runtime::utils::tokens_to_string;
use deno_core::op2;
use deno_core::v8;
use deno_core::JsRuntime;
use deno_core::OpState;
use std::collections::HashMap;

/// Build a `CalcContext` from the current DOM state's stealth profile.
/// Provides viewport + font-size + container dimensions so calc()
/// math functions can resolve relative units (vw, em, etc.) correctly
/// for `getComputedStyle` resolution.
fn calc_context_from(state: &DomState) -> CalcContext {
    let mut ctx = CalcContext::default();
    if let Some(p) = state.stealth_profile.as_ref() {
        ctx.viewport_w = p.inner_width as f64;
        ctx.viewport_h = p.inner_height as f64;
        ctx.container_w = p.inner_width as f64;
        ctx.container_h = p.inner_height as f64;
        // 16px is Chrome's default; profiles don't currently override.
        ctx.root_font_size_px = 16.0;
        ctx.font_size_px = 16.0;
    }
    ctx
}

/// Expand a shorthand into the longhands `getComputedStyle` must also report.
///
/// Chrome answers `backgroundColor` even when the sheet only said `background:#eee`,
/// and `marginTop` when it said `margin:15vh auto`. The engine stored declarations
/// verbatim, so every such longhand read back empty — which silently breaks any
/// script (and any diff against a real browser) that asks for the longhand.
///
/// Only the mechanical box shorthands are expanded, plus a plain-colour `background`.
/// `border`, `font` and friends need real value parsing and are left alone rather
/// than guessed at. The shorthand itself is always kept alongside.
fn expand_shorthand(name: &str, value: &str) -> Vec<(String, String)> {
    let lower = name.to_ascii_lowercase();
    let parts: Vec<&str> = value.split_whitespace().collect();
    // 1→all, 2→(block, inline), 3→(top, inline, bottom), 4→(top, right, bottom, left)
    let sides = |p: &[&str]| -> Option<[String; 4]> {
        let g = |i: usize| p[i].to_string();
        match p.len() {
            1 => Some([g(0), g(0), g(0), g(0)]),
            2 => Some([g(0), g(1), g(0), g(1)]),
            3 => Some([g(0), g(1), g(2), g(1)]),
            4 => Some([g(0), g(1), g(2), g(3)]),
            _ => None,
        }
    };
    let box_longhands = |prefix: &str, suffix: &str| -> Vec<(String, String)> {
        match sides(&parts) {
            Some([t, r, b, l]) => vec![
                (format!("{prefix}top{suffix}"), t),
                (format!("{prefix}right{suffix}"), r),
                (format!("{prefix}bottom{suffix}"), b),
                (format!("{prefix}left{suffix}"), l),
            ],
            None => Vec::new(),
        }
    };

    let mut out = match lower.as_str() {
        "margin" => box_longhands("margin-", ""),
        "padding" => box_longhands("padding-", ""),
        "inset" => match sides(&parts) {
            Some([t, r, b, l]) => vec![
                ("top".into(), t),
                ("right".into(), r),
                ("bottom".into(), b),
                ("left".into(), l),
            ],
            None => Vec::new(),
        },
        "border-width" => box_longhands("border-", "-width"),
        "border-style" => box_longhands("border-", "-style"),
        "border-color" => box_longhands("border-", "-color"),
        "overflow" => match parts.len() {
            1 => vec![
                ("overflow-x".into(), parts[0].into()),
                ("overflow-y".into(), parts[0].into()),
            ],
            2 => vec![
                ("overflow-x".into(), parts[0].into()),
                ("overflow-y".into(), parts[1].into()),
            ],
            _ => Vec::new(),
        },
        "gap" => match parts.len() {
            1 => vec![
                ("row-gap".into(), parts[0].into()),
                ("column-gap".into(), parts[0].into()),
            ],
            2 => vec![
                ("row-gap".into(), parts[0].into()),
                ("column-gap".into(), parts[1].into()),
            ],
            _ => Vec::new(),
        },
        // Only the single-token colour form; anything richer needs a real parser.
        "background" if parts.len() == 1 => {
            let v = parts[0];
            let is_colour = v.starts_with('#')
                || v.starts_with("rgb")
                || v.starts_with("hsl")
                || crate::css_values::types::color::named_color(&v.to_ascii_lowercase()).is_some();
            if is_colour {
                vec![("background-color".into(), v.to_string())]
            } else {
                Vec::new()
            }
        }
        _ => Vec::new(),
    };
    out.push((lower, value.to_string()));
    out
}

/// True when `id` is a `<style>` element, or an element containing one.
/// Mutating such a subtree changes the document's CSS, so the cascade must be
/// rebuilt — otherwise a `<style>` created and appended by script never applies.
fn touches_stylesheet(state: &DomState, id: NodeId) -> bool {
    if state
        .dom
        .get(id)
        .and_then(|n| n.as_element())
        .is_some_and(|e| e.name.local.eq_ignore_ascii_case("style"))
    {
        return true;
    }
    !state.dom.get_elements_by_tag_name(id, "style").is_empty()
}

fn refresh_stylesheets(state: &mut DomState) {
    let entries = crate::stylesheet_collector::find_stylesheets(&state.dom);
    let mut sheets = crate::stylesheet_collector::resolve_inline_only(&entries);
    sheets.extend(state.external_stylesheets.iter().cloned());
    state.stylesheets = sheets;
    state.update_cached_rules();
}

// Convention: ops that return "nullable NodeId" return i64.
// -1 means null/not found. JS bootstrap converts -1 → null.

// --- Read ops ---

#[op2(fast)]
#[smi]
pub fn op_dom_document_node() -> i32 {
    NodeId::DOCUMENT.to_raw() as i32
}

/// True when the parsed document had no doctype. `document.compatMode` used to
/// answer "CSS1Compat" unconditionally, which contradicts the served markup on
/// any doctype-less page — something a detector can check for free.
#[op2(fast)]
pub fn op_dom_is_quirks_mode(state: &mut OpState) -> bool {
    state.borrow::<DomState>().dom.quirks()
}

#[op2]
#[string]
pub fn op_dom_get_tag_name(state: &mut OpState, #[smi] node_id: i32) -> String {
    let state = state.borrow::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    state
        .dom
        .get(id)
        .and_then(|n| n.as_element())
        .map(|e| e.name.local.clone())
        .unwrap_or_default()
}

#[op2(fast)]
#[smi]
pub fn op_dom_get_node_type(state: &mut OpState, #[smi] node_id: i32) -> i32 {
    let state = state.borrow::<DomState>();
    state.dom.node_type(NodeId::from_raw(node_id as u32)) as i32
}

#[op2]
#[string]
pub fn op_dom_get_text_content(state: &mut OpState, #[smi] node_id: i32) -> String {
    let state = state.borrow::<DomState>();
    state.dom.text_content(NodeId::from_raw(node_id as u32))
}

#[op2]
#[string]
pub fn op_dom_get_inner_html(state: &mut OpState, #[smi] node_id: i32) -> String {
    let state = state.borrow::<DomState>();
    state
        .dom
        .serialize_inner_html(NodeId::from_raw(node_id as u32))
}

#[op2]
#[string]
pub fn op_dom_get_outer_html(state: &mut OpState, #[smi] node_id: i32) -> String {
    let state = state.borrow::<DomState>();
    state.dom.serialize_html(NodeId::from_raw(node_id as u32))
}

/// `None` (JS `null`) when the attribute is absent — the DOM spec's return
/// value for `getAttribute`, and load-bearing: this used to answer `""` for
/// every missing attribute, so a bot detector probing
/// `documentElement.getAttribute("__webdriver_evaluate") !== null` — the
/// standard Selenium sweep over ~30 marker names — scored a hit on all of
/// them. An element carrying only `lang` reported every marker present.
#[op2]
#[string]
pub fn op_dom_get_attribute(
    state: &mut OpState,
    #[smi] node_id: i32,
    #[string] name: &str,
) -> Option<String> {
    let state = state.borrow::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    state
        .dom
        .get(id)
        .and_then(|n| n.as_element())
        .and_then(|e| {
            e.attrs
                .iter()
                .find(|a| a.name.local.eq_ignore_ascii_case(name))
                .map(|a| a.value.clone())
        })
}

#[op2(fast)]
pub fn op_dom_has_attribute(
    state: &mut OpState,
    #[smi] node_id: i32,
    #[string] name: &str,
) -> bool {
    let state = state.borrow::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    state
        .dom
        .get(id)
        .and_then(|n| n.as_element())
        .is_some_and(|e| {
            e.attrs
                .iter()
                .any(|a| a.name.local.eq_ignore_ascii_case(name))
        })
}

/// Returns the names of all attributes on `node_id`, in source order.
/// Used by Proxy ownKeys traps for `element.attributes` and `element.dataset`.
#[op2]
#[serde]
pub fn op_dom_get_attribute_names(state: &mut OpState, #[smi] node_id: i32) -> Vec<String> {
    let state = state.borrow::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    state
        .dom
        .get(id)
        .and_then(|n| n.as_element())
        .map(|e| e.attrs.iter().map(|a| a.name.local.clone()).collect())
        .unwrap_or_default()
}

/// Returns parent NodeId or -1 if no parent.
#[op2(fast)]
#[smi]
pub fn op_dom_get_parent(state: &mut OpState, #[smi] node_id: i32) -> i32 {
    let state = state.borrow::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    state
        .dom
        .get(id)
        .and_then(|n| n.parent)
        .map(|p| p.to_raw() as i32)
        .unwrap_or(-1)
}

#[op2]
#[serde]
pub fn op_dom_get_children(state: &mut OpState, #[smi] node_id: i32) -> Vec<i32> {
    let state = state.borrow::<DomState>();
    state
        .dom
        .children(NodeId::from_raw(node_id as u32))
        .iter()
        .map(|id| id.to_raw() as i32)
        .collect()
}

#[op2]
#[serde]
pub fn op_dom_get_children_with_types(state: &mut OpState, #[smi] node_id: i32) -> Vec<i32> {
    let state = state.borrow::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    let children = state.dom.children(id);
    let mut res = Vec::with_capacity(children.len() * 2);
    for cid in children {
        res.push(cid.to_raw() as i32);
        res.push(state.dom.node_type(cid) as i32);
    }
    res
}

#[op2]
#[serde]
pub fn op_dom_get_child_elements(state: &mut OpState, #[smi] node_id: i32) -> Vec<i32> {
    let state = state.borrow::<DomState>();
    state
        .dom
        .child_elements(NodeId::from_raw(node_id as u32))
        .iter()
        .map(|id| id.to_raw() as i32)
        .collect()
}

#[op2]
#[serde]
pub fn op_dom_get_child_elements_with_types(state: &mut OpState, #[smi] node_id: i32) -> Vec<i32> {
    let state = state.borrow::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    let children = state.dom.child_elements(id);
    let mut res = Vec::with_capacity(children.len() * 2);
    for cid in children {
        res.push(cid.to_raw() as i32);
        res.push(state.dom.node_type(cid) as i32);
    }
    res
}

#[op2(fast)]
#[smi]
pub fn op_dom_get_first_child(state: &mut OpState, #[smi] node_id: i32) -> i32 {
    let state = state.borrow::<DomState>();
    state
        .dom
        .get(NodeId::from_raw(node_id as u32))
        .and_then(|n| n.first_child)
        .map(|id| id.to_raw() as i32)
        .unwrap_or(-1)
}

#[op2(fast)]
#[smi]
pub fn op_dom_get_last_child(state: &mut OpState, #[smi] node_id: i32) -> i32 {
    let state = state.borrow::<DomState>();
    state
        .dom
        .get(NodeId::from_raw(node_id as u32))
        .and_then(|n| n.last_child)
        .map(|id| id.to_raw() as i32)
        .unwrap_or(-1)
}

#[op2(fast)]
#[smi]
pub fn op_dom_get_next_sibling(state: &mut OpState, #[smi] node_id: i32) -> i32 {
    let state = state.borrow::<DomState>();
    state
        .dom
        .get(NodeId::from_raw(node_id as u32))
        .and_then(|n| n.next_sibling)
        .map(|id| id.to_raw() as i32)
        .unwrap_or(-1)
}

#[op2(fast)]
#[smi]
pub fn op_dom_get_prev_sibling(state: &mut OpState, #[smi] node_id: i32) -> i32 {
    let state = state.borrow::<DomState>();
    state
        .dom
        .get(NodeId::from_raw(node_id as u32))
        .and_then(|n| n.prev_sibling)
        .map(|id| id.to_raw() as i32)
        .unwrap_or(-1)
}

#[op2(fast)]
#[smi]
pub fn op_dom_query_selector(
    state: &mut OpState,
    #[smi] node_id: i32,
    #[string] selector: &str,
) -> i32 {
    let state = state.borrow::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    let element = match DomElement::new(&state.dom, id) {
        Some(el) => el,
        None => {
            // For Document node, search from first element child
            let children = state.dom.child_elements(id);
            if children.is_empty() {
                return -1;
            }
            match DomElement::new(&state.dom, children[0]) {
                Some(el) => {
                    // `document.querySelector` matches every descendant of the document
                    // node, and that set INCLUDES the document element — so `html`,
                    // `:root` and `*` must be able to return <html> itself. Since
                    // `query_selector` only walks descendants of the root it is given,
                    // test the root separately first (it is also first in document order).
                    if let Ok(list) = crate::css_selectors::parse_selector_list(selector) {
                        if crate::css_selectors::matches_any(&el, &list) {
                            return el.node_id().to_raw() as i32;
                        }
                    }
                    if let Ok(Some(found)) = crate::css_selectors::query_selector(&el, selector) {
                        return found.node_id().to_raw() as i32;
                    }
                    return -1;
                }
                None => return -1,
            }
        }
    };
    match crate::css_selectors::query_selector(&element, selector) {
        Ok(Some(found)) => found.node_id().to_raw() as i32,
        _ => -1,
    }
}

#[op2]
#[serde]
pub fn op_dom_query_selector_all(
    state: &mut OpState,
    #[smi] node_id: i32,
    #[string] selector: String,
) -> Vec<i32> {
    let state = state.borrow::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    // For document or element, try to build a DomElement for querying
    let self_el = DomElement::new(&state.dom, id);
    // No DomElement for this id means it is the Document node, whose match set
    // includes the document element itself (see op_dom_query_selector).
    let from_document = self_el.is_none();
    let root_el = self_el.or_else(|| {
        let children = state.dom.child_elements(id);
        children
            .first()
            .and_then(|&c| DomElement::new(&state.dom, c))
    });
    match root_el {
        Some(el) => {
            let mut out = Vec::new();
            if from_document {
                if let Ok(list) = crate::css_selectors::parse_selector_list(&selector) {
                    if crate::css_selectors::matches_any(&el, &list) {
                        // Document order: the root precedes all of its descendants.
                        out.push(el.node_id().to_raw() as i32);
                    }
                }
            }
            out.extend(
                crate::css_selectors::query_selector_all(&el, &selector)
                    .unwrap_or_default()
                    .iter()
                    .map(|e| e.node_id().to_raw() as i32),
            );
            out
        }
        None => vec![],
    }
}

#[op2(fast)]
#[smi]
pub fn op_dom_get_element_by_id(state: &mut OpState, #[string] id: &str) -> i32 {
    let state = state.borrow::<DomState>();
    state
        .dom
        .get_element_by_id(id)
        .map(|n| n.to_raw() as i32)
        .unwrap_or(-1)
}

#[op2]
#[serde]
pub fn op_dom_get_elements_by_tag_name(
    state: &mut OpState,
    #[smi] node_id: i32,
    #[string] tag: String,
) -> Vec<i32> {
    let state = state.borrow::<DomState>();
    state
        .dom
        .get_elements_by_tag_name(NodeId::from_raw(node_id as u32), &tag)
        .iter()
        .map(|id| id.to_raw() as i32)
        .collect()
}

#[op2]
#[serde]
pub fn op_dom_get_elements_by_class_name(
    state: &mut OpState,
    #[smi] node_id: i32,
    #[string] class: String,
) -> Vec<i32> {
    let state = state.borrow::<DomState>();
    state
        .dom
        .get_elements_by_class_name(NodeId::from_raw(node_id as u32), &class)
        .iter()
        .map(|id| id.to_raw() as i32)
        .collect()
}

// --- Mutation ops ---

#[op2(fast)]
#[smi]
pub fn op_dom_create_element(state: &mut OpState, #[string] tag: &str) -> i32 {
    let state = state.borrow_mut::<DomState>();
    state
        .dom
        .create_element(crate::dom::node::QualName::new(tag), vec![])
        .to_raw() as i32
}

#[op2(fast)]
#[smi]
pub fn op_dom_create_text_node(state: &mut OpState, #[string] text: &str) -> i32 {
    let state = state.borrow_mut::<DomState>();
    state.dom.create_text(text.to_string()).to_raw() as i32
}

/// A real comment node. `document.createComment` used to allocate a *text*
/// node, so every comment read back `nodeType` 3 and serialised as bare text —
/// visible to anything that walks `childNodes`, and it puts the comment's
/// contents into the document's text.
#[op2(fast)]
#[smi]
pub fn op_dom_create_comment(state: &mut OpState, #[string] text: &str) -> i32 {
    let state = state.borrow_mut::<DomState>();
    state.dom.create_comment(text.to_string()).to_raw() as i32
}

#[op2(fast)]
#[smi]
pub fn op_dom_create_document_fragment(state: &mut OpState) -> i32 {
    let state = state.borrow_mut::<DomState>();
    state.dom.create_document_fragment().to_raw() as i32
}

/// Node ids of `<iframe>` elements in the subtree rooted at `id`, `id` included.
///
/// A subtree move or removal takes every browsing context inside it with it, so
/// the whole subtree is walked rather than just the node named by the mutation.
fn frames_in_subtree(dom: &crate::dom::Dom, id: NodeId, out: &mut Vec<u32>) {
    if let Some(node) = dom.get(id) {
        if let crate::dom::node::NodeData::Element(elem) = &node.data {
            if elem.name.local.eq_ignore_ascii_case("iframe") {
                out.push(id.to_raw());
            }
        }
    }
    for child in dom.children(id) {
        frames_in_subtree(dom, child, out);
    }
}

/// Queue every frame in the subtree for rebuild. See `DomState::invalidated_frames`.
fn invalidate_frames(state: &mut DomState, id: NodeId) {
    let mut found = Vec::new();
    frames_in_subtree(&state.dom, id, &mut found);
    state.invalidated_frames.extend(found);
}

#[op2(fast)]
pub fn op_dom_append_child(state: &mut OpState, #[smi] parent: i32, #[smi] child: i32) {
    let state = state.borrow_mut::<DomState>();
    let child_id = NodeId::from_raw(child as u32);
    state
        .dom
        .append_child(NodeId::from_raw(parent as u32), child_id);
    state.layout_engine.mark_dirty();
    invalidate_frames(state, child_id);
    if touches_stylesheet(state, child_id) {
        refresh_stylesheets(state);
    }
}

#[op2(fast)]
pub fn op_dom_insert_before(
    state: &mut OpState,
    #[smi] parent: i32,
    #[smi] child: i32,
    #[smi] reference: i32,
) {
    let state = state.borrow_mut::<DomState>();
    let child_id = NodeId::from_raw(child as u32);
    state.dom.insert_before(
        NodeId::from_raw(parent as u32),
        child_id,
        NodeId::from_raw(reference as u32),
    );
    state.layout_engine.mark_dirty();
    invalidate_frames(state, child_id);
}

#[op2(fast)]
pub fn op_dom_remove_child(state: &mut OpState, #[smi] _parent: i32, #[smi] child: i32) {
    let state = state.borrow_mut::<DomState>();
    let child_id = NodeId::from_raw(child as u32);
    // Collected before the detach: afterwards the subtree is unreachable.
    invalidate_frames(state, child_id);
    state.dom.detach(child_id);
    state.layout_engine.mark_dirty();
}

#[op2(fast)]
pub fn op_dom_set_attribute(
    state: &mut OpState,
    #[smi] node_id: i32,
    #[string] name: &str,
    #[string] value: &str,
) {
    let state = state.borrow_mut::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    if let Some(node) = state.dom.get_mut(id) {
        if let Some(elem) = node.as_element_mut() {
            if let Some(attr) = elem
                .attrs
                .iter_mut()
                .find(|a| a.name.local.eq_ignore_ascii_case(name))
            {
                attr.value = value.to_string();
            } else {
                elem.attrs.push(crate::dom::node::Attribute {
                    name: crate::dom::node::QualName::new(name),
                    value: value.to_string(),
                });
            }
        }
    }
    if name.eq_ignore_ascii_case("style") || name.eq_ignore_ascii_case("class") {
        state.layout_engine.mark_dirty();
    }
    // Rewriting `src`/`srcdoc` navigates the frame: the old browsing context is
    // discarded and a new one is created for the new document.
    if name.eq_ignore_ascii_case("src") || name.eq_ignore_ascii_case("srcdoc") {
        invalidate_frames(state, id);
    }
}

#[op2(fast)]
pub fn op_dom_remove_attribute(state: &mut OpState, #[smi] node_id: i32, #[string] name: &str) {
    let state = state.borrow_mut::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    if let Some(node) = state.dom.get_mut(id) {
        if let Some(elem) = node.as_element_mut() {
            elem.attrs
                .retain(|a| !a.name.local.eq_ignore_ascii_case(name));
        }
    }
    if name.eq_ignore_ascii_case("style") || name.eq_ignore_ascii_case("class") {
        state.layout_engine.mark_dirty();
    }
}

#[op2(fast)]
pub fn op_dom_set_text_content(state: &mut OpState, #[smi] node_id: i32, #[string] text: &str) {
    let state = state.borrow_mut::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    // Replacing the contents destroys every frame under this node.
    invalidate_frames(state, id);
    state.dom.set_text_content(id, text);
    state.layout_engine.mark_dirty();
    if touches_stylesheet(state, id) {
        refresh_stylesheets(state);
    }
}

/// Queue a `postMessage` for a child iframe realm.
///
/// Cross-realm delivery cannot happen in JS: each iframe is its own V8 isolate.
/// The payload is parked here and `Page::pump_iframe_messages` hands it to the
/// matching `ChildIframe`.
#[op2(fast)]
pub fn op_iframe_post_to_child(state: &mut OpState, #[smi] node_id: i32, #[string] json: &str) {
    let state = state.borrow_mut::<DomState>();
    state
        .messages_to_children
        .push((node_id as u32, json.to_string()));
}

/// Queue a `parent.postMessage` from inside a child realm.
#[op2(fast)]
pub fn op_iframe_post_to_parent(state: &mut OpState, #[string] json: &str) {
    let state = state.borrow_mut::<DomState>();
    state.messages_to_parent.push(json.to_string());
}

/// Drain queued child-bound messages: `[node_id, json, node_id, json, …]`.
#[op2]
#[serde]
pub fn op_iframe_take_child_messages(state: &mut OpState) -> Vec<String> {
    let state = state.borrow_mut::<DomState>();
    let mut out = Vec::with_capacity(state.messages_to_children.len() * 2);
    for (id, json) in std::mem::take(&mut state.messages_to_children) {
        out.push(id.to_string());
        out.push(json);
    }
    out
}

/// Drain queued parent-bound messages from this (child) realm.
#[op2]
#[serde]
pub fn op_iframe_take_parent_messages(state: &mut OpState) -> Vec<String> {
    let state = state.borrow_mut::<DomState>();
    std::mem::take(&mut state.messages_to_parent)
}

/// Re-collect `<style>` content from the live DOM and rebuild the cascade.
///
/// The document's stylesheets are gathered once at parse time, so anything a page
/// injects afterwards — `sheet.insertRule` (how emotion/MUI ship *all* of their CSS),
/// or a `<style>` whose text is set from script — never reached the cascade or layout.
/// JS calls this after any such mutation.
#[op2(fast)]
pub fn op_dom_refresh_stylesheets(state: &mut OpState) {
    refresh_stylesheets(state.borrow_mut::<DomState>());
}

#[op2(fast)]
pub fn op_dom_set_inner_html(state: &mut OpState, #[smi] node_id: i32, #[string] html: &str) {
    let state = state.borrow_mut::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    let fragment_dom = crate::html_parser::parse_html(&format!("<body>{}</body>", html));
    let body = fragment_dom
        .get_elements_by_tag_name(NodeId::DOCUMENT, "body")
        .into_iter()
        .next();

    // Remove existing children. Every frame under them loses its browsing
    // context — this is the path a widget takes when it rebuilds its container
    // wholesale rather than mutating it, and skipping it strands the realm.
    invalidate_frames(state, id);
    let old_children: Vec<NodeId> = state.dom.children(id);
    for child in old_children {
        state.dom.remove(child);
    }

    // Merge fragment children
    if let Some(body_id) = body {
        for child_id in fragment_dom.children(body_id) {
            let new_child = state.dom.merge_subtree(&fragment_dom, child_id);
            state.dom.append_child(id, new_child);
        }
    }
    // …and whatever frames the new markup brought with it need one.
    invalidate_frames(state, id);
    state.layout_engine.mark_dirty();
}

/// Clone a node. If deep=true, clone all descendants too.
#[op2(fast)]
#[smi]
pub fn op_dom_clone_node(state: &mut OpState, #[smi] node_id: i32, deep: bool) -> i32 {
    let state = state.borrow_mut::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    if deep {
        // merge_subtree does a deep copy from the same DOM
        let cloned = {
            // We need to read from &self and write to &mut self.
            // merge_subtree takes &Dom for source. Build a snapshot of the subtree.
            // Actually, we can use a two-pass: first collect the tree shape, then rebuild.
            clone_subtree_deep(&mut state.dom, id)
        };
        cloned.to_raw() as i32
    } else {
        // Shallow: copy just this node (no children)
        let node = match state.dom.get(id) {
            Some(n) => n,
            None => return -1,
        };
        let new_id = match &node.data {
            crate::dom::node::NodeData::Element(elem) => state
                .dom
                .create_element(elem.name.clone(), elem.attrs.clone()),
            crate::dom::node::NodeData::Text(t) => state.dom.create_text(t.clone()),
            crate::dom::node::NodeData::Comment(t) => state.dom.create_comment(t.clone()),
            _ => state.dom.create_document_fragment(),
        };
        new_id.to_raw() as i32
    }
}

/// Deep clone a subtree within the same Dom.
fn clone_subtree_deep(dom: &mut crate::dom::Dom, root: NodeId) -> NodeId {
    // Collect the tree structure first (read phase)
    let snapshot = collect_subtree(dom, root);
    // Rebuild from snapshot (write phase)
    rebuild_from_snapshot(dom, &snapshot)
}

#[derive(Debug)]
enum SnapshotNode {
    Element {
        name: crate::dom::node::QualName,
        attrs: Vec<crate::dom::node::Attribute>,
        children: Vec<SnapshotNode>,
    },
    Text(String),
    Comment(String),
    Fragment(Vec<SnapshotNode>),
}

fn collect_subtree(dom: &crate::dom::Dom, id: NodeId) -> SnapshotNode {
    let node = match dom.get(id) {
        Some(n) => n,
        None => return SnapshotNode::Fragment(vec![]),
    };
    let children: Vec<SnapshotNode> = dom
        .children(id)
        .iter()
        .map(|&child_id| collect_subtree(dom, child_id))
        .collect();
    match &node.data {
        crate::dom::node::NodeData::Element(elem) => SnapshotNode::Element {
            name: elem.name.clone(),
            attrs: elem.attrs.clone(),
            children,
        },
        crate::dom::node::NodeData::Text(t) => SnapshotNode::Text(t.clone()),
        crate::dom::node::NodeData::Comment(t) => SnapshotNode::Comment(t.clone()),
        _ => SnapshotNode::Fragment(children),
    }
}

fn rebuild_from_snapshot(dom: &mut crate::dom::Dom, snapshot: &SnapshotNode) -> NodeId {
    match snapshot {
        SnapshotNode::Element {
            name,
            attrs,
            children,
        } => {
            let id = dom.create_element(name.clone(), attrs.clone());
            for child in children {
                let child_id = rebuild_from_snapshot(dom, child);
                dom.append_child(id, child_id);
            }
            id
        }
        SnapshotNode::Text(t) => dom.create_text(t.clone()),
        SnapshotNode::Comment(t) => dom.create_comment(t.clone()),
        SnapshotNode::Fragment(children) => {
            let id = dom.create_document_fragment();
            for child in children {
                let child_id = rebuild_from_snapshot(dom, child);
                dom.append_child(id, child_id);
            }
            id
        }
    }
}

/// Insert HTML at a position relative to an element.
/// position: "beforebegin", "afterbegin", "beforeend", "afterend"
#[op2(fast)]
pub fn op_dom_insert_adjacent_html(
    state: &mut OpState,
    #[smi] node_id: i32,
    #[string] position: &str,
    #[string] html: &str,
) {
    let state = state.borrow_mut::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    let fragment_dom = crate::html_parser::parse_html(&format!("<body>{}</body>", html));
    let frag_body = fragment_dom
        .get_elements_by_tag_name(NodeId::DOCUMENT, "body")
        .into_iter()
        .next();
    let frag_children: Vec<NodeId> = frag_body
        .map(|b| fragment_dom.children(b))
        .unwrap_or_default();
    if frag_children.is_empty() {
        return;
    }

    match position {
        "beforebegin" => {
            // Insert before this element (as previous sibling)
            if let Some(parent) = state.dom.get(id).and_then(|n| n.parent) {
                for &child_id in &frag_children {
                    let new_child = state.dom.merge_subtree(&fragment_dom, child_id);
                    state.dom.insert_before(parent, new_child, id);
                }
            }
        }
        "afterbegin" => {
            // Insert as first child
            let first = state.dom.get(id).and_then(|n| n.first_child);
            for child_id in frag_children.iter().rev() {
                let new_child = state.dom.merge_subtree(&fragment_dom, *child_id);
                if let Some(ref_child) = first {
                    state.dom.insert_before(id, new_child, ref_child);
                } else {
                    state.dom.append_child(id, new_child);
                }
            }
        }
        "beforeend" => {
            // Append as last child (same as appendChild)
            for &child_id in &frag_children {
                let new_child = state.dom.merge_subtree(&fragment_dom, child_id);
                state.dom.append_child(id, new_child);
            }
        }
        "afterend" => {
            // Insert after this element (as next sibling)
            if let Some(parent) = state.dom.get(id).and_then(|n| n.parent) {
                let next = state.dom.get(id).and_then(|n| n.next_sibling);
                for &child_id in &frag_children {
                    let new_child = state.dom.merge_subtree(&fragment_dom, child_id);
                    if let Some(ref_child) = next {
                        state.dom.insert_before(parent, new_child, ref_child);
                    } else {
                        state.dom.append_child(parent, new_child);
                    }
                }
            }
        }
        _ => {}
    }
    state.layout_engine.mark_dirty();
}

#[op2]
#[serde]
pub fn op_dom_document_write(state: &mut OpState, #[string] html: &str) -> Vec<i32> {
    let state = state.borrow_mut::<DomState>();
    let body_id = state
        .dom
        .get_elements_by_tag_name(NodeId::DOCUMENT, "body")
        .into_iter()
        .next();
    let body_id = match body_id {
        Some(id) => id,
        None => return vec![],
    };
    let fragment_dom = crate::html_parser::parse_html(&format!("<body>{}</body>", html));
    let frag_body = fragment_dom
        .get_elements_by_tag_name(NodeId::DOCUMENT, "body")
        .into_iter()
        .next();
    let mut new_ids = Vec::new();
    if let Some(frag_body_id) = frag_body {
        for child_id in fragment_dom.children(frag_body_id) {
            let new_child = state.dom.merge_subtree(&fragment_dom, child_id);
            state.dom.append_child(body_id, new_child);
            new_ids.push(new_child.to_raw() as i32);
        }
    }
    state.layout_engine.mark_dirty();
    new_ids
}

/// `document.write` from a script, inserted where that script sits.
///
/// A browser writes into the parser's own insertion point, which is exactly
/// where the `<script>` element is. This engine runs inline scripts after the
/// parse rather than interleaved with it, so there is no parser to write into —
/// and appending to `<body>` instead sends the markup to the bottom of the page.
/// The observable damage is not subtle: `<td><script>document.write(v)</script></td>`
/// leaves the cell empty and piles every written value up at the end of the
/// document, which is what a whole class of legacy pages is built out of.
///
/// Anchoring on the script element reproduces the placement for that shape. It
/// does not reproduce a write that opens a tag the later markup closes — that
/// needs the parse and the scripts to interleave for real.
#[op2]
#[serde]
pub fn op_dom_document_write_after(
    state: &mut OpState,
    #[smi] anchor_id: i32,
    #[string] html: &str,
) -> Vec<i32> {
    let state = state.borrow_mut::<DomState>();
    let anchor = NodeId::from_raw(anchor_id as u32);
    let Some(parent) = state.dom.get(anchor).and_then(|n| n.parent) else {
        return vec![];
    };
    let fragment_dom = crate::html_parser::parse_html(&format!("<body>{html}</body>"));
    let Some(frag_body) = fragment_dom
        .get_elements_by_tag_name(NodeId::DOCUMENT, "body")
        .into_iter()
        .next()
    else {
        return vec![];
    };

    // The cursor walks forward so several nodes from one call keep their source
    // order; the caller passes the last one back to keep order across calls too.
    let mut new_ids = Vec::new();
    let mut cursor = anchor;
    for child_id in fragment_dom.children(frag_body) {
        let new_child = state.dom.merge_subtree(&fragment_dom, child_id);
        let siblings = state.dom.children(parent);
        let next = siblings
            .iter()
            .position(|&s| s == cursor)
            .and_then(|i| siblings.get(i + 1).copied());
        match next {
            Some(reference) => state.dom.insert_before(parent, new_child, reference),
            None => state.dom.append_child(parent, new_child),
        }
        cursor = new_child;
        new_ids.push(new_child.to_raw() as i32);
    }
    state.layout_engine.mark_dirty();
    new_ids
}

#[op2(fast)]
pub fn op_dom_class_list_add(state: &mut OpState, #[smi] node_id: i32, #[string] class: &str) {
    let state = state.borrow_mut::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    if let Some(node) = state.dom.get_mut(id) {
        if let Some(elem) = node.as_element_mut() {
            let current = elem
                .attrs
                .iter()
                .find(|a| a.name.local == "class")
                .map(|a| a.value.clone())
                .unwrap_or_default();
            if !current.split_whitespace().any(|c| c == class) {
                let new_val = if current.is_empty() {
                    class.to_string()
                } else {
                    format!("{} {}", current, class)
                };
                if let Some(attr) = elem.attrs.iter_mut().find(|a| a.name.local == "class") {
                    attr.value = new_val;
                } else {
                    elem.attrs.push(crate::dom::node::Attribute {
                        name: crate::dom::node::QualName::new("class"),
                        value: new_val,
                    });
                }
            }
        }
    }
}

#[op2(fast)]
pub fn op_dom_class_list_remove(state: &mut OpState, #[smi] node_id: i32, #[string] class: &str) {
    let state = state.borrow_mut::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    if let Some(node) = state.dom.get_mut(id) {
        if let Some(elem) = node.as_element_mut() {
            if let Some(attr) = elem.attrs.iter_mut().find(|a| a.name.local == "class") {
                let new_val: String = attr
                    .value
                    .split_whitespace()
                    .filter(|c| *c != class)
                    .collect::<Vec<_>>()
                    .join(" ");
                attr.value = new_val;
            }
        }
    }
}

/// A declared value in the form `getComputedStyle` reports: math functions
/// evaluated and relative lengths (`2em`, `60vw`) turned into pixels.
/// Percentages stay as authored — resolving them needs the containing block,
/// which is layout's job, not this op's.
fn computed_value_text(value: &str, ctx: &CalcContext) -> String {
    let resolved = resolve_computed_value(value, ctx);
    resolve_length_to_px(&resolved, ctx).unwrap_or(resolved)
}

/// A length in Chrome's `getComputedStyle` form: no trailing zeros, at most three
/// decimals.
fn format_px(v: f32) -> String {
    let rounded = (f64::from(v) * 1000.0).round() / 1000.0;
    if rounded.fract() == 0.0 {
        format!("{}px", rounded as i64)
    } else {
        format!("{rounded}px")
    }
}

/// Get computed style for an element.
/// Checks: 1) inline style attribute, 2) `<style>` block rules, 3) CSS defaults.
/// Uses selector matching for style block rules. Higher specificity wins.
#[op2]
#[serde]
pub fn op_dom_get_all_computed_styles(
    state: &mut OpState,
    #[smi] node_id: i32,
) -> HashMap<String, String> {
    let state = state.borrow_mut::<DomState>();
    if state.cached_rules.is_empty() && !state.stylesheets.is_empty() {
        state.update_cached_rules();
    }
    let id = NodeId::from_raw(node_id as u32);
    if DomElement::new(&state.dom, id).is_none() {
        return HashMap::new();
    }

    let mut declarations: HashMap<String, (u32, u32, String)> = HashMap::new();

    // Weakest first, so a later declaration overwrites an earlier one. Expanding
    // at insertion makes the generated longhands take part in the same contest as
    // explicit ones — a later `margin-top` still beats an earlier `margin`.
    for decl in state.stylist.matching_declarations(&state.dom, id) {
        for (prop, pval) in expand_shorthand(&decl.name, &decl.value) {
            declarations.insert(prop, (0, 0, pval));
        }
    }

    // Add inline styles (highest specificity)
    if let Some(el) = state.dom.get(id).and_then(|n| n.as_element()) {
        if let Some(style) = el
            .attrs
            .iter()
            .find(|a| a.name.local.eq_ignore_ascii_case("style"))
        {
            for decl in style.value.split(';') {
                if let Some(colon) = decl.find(':') {
                    let name = decl[..colon].trim();
                    let val = decl[colon + 1..].trim();
                    for (prop, pval) in expand_shorthand(name, val) {
                        declarations.insert(prop, (999999, 999999, pval));
                    }
                }
            }
        }
    }

    // Resolve calc() and CSS Values 4 math functions to their used
    // pixel value before returning — Chrome's getComputedStyle does
    // this. Otherwise scripts that compute via calc(... sin(pi) ...)
    // and read the result back would see the unresolved expression
    // text instead of the resolved value real Chrome returns.
    let ctx = calc_context_from(state);
    let res: HashMap<String, String> = declarations
        .into_iter()
        .map(|(k, v)| {
            let resolved = resolve_computed_value(&v.2, &ctx);
            // Then relative lengths: Chrome reports used pixels, not the authored
            // `60vw`/`2rem`. Percentages stay as authored — resolving them needs the
            // containing block, which is layout's job, not this op's.
            let px = resolve_length_to_px(&resolved, &ctx).unwrap_or(resolved);
            (k, px)
        })
        .collect();
    res
}

#[op2]
#[string]
pub fn op_dom_get_computed_style(
    state: &mut OpState,
    #[smi] node_id: i32,
    #[string] property: &str,
) -> String {
    let state = state.borrow_mut::<DomState>();
    if state.cached_rules.is_empty() && !state.stylesheets.is_empty() {
        state.update_cached_rules();
    }
    let id = NodeId::from_raw(node_id as u32);
    let mut ctx = calc_context_from(state);

    // The style pass knows what the cascade alone cannot: the font size an
    // element really has (inherited, `em`/`%` compounded), and the `display` its
    // tag gives it. `None` for an element with no box (`display: none` above it).
    let styled = {
        let tree = state.layout_engine.style_tree(&state.dom);
        tree.get(id).map(|style| {
            let display = match style.get(&crate::css_values::property::PropertyId::Display) {
                Some(crate::css_values::property::CssValue::Display(d)) => Some(d.as_css()),
                _ => None,
            };
            (tree.font_size(id), tree.root_font_size(), display)
        })
    };
    if let Some((font_size, root_font_size, _)) = styled {
        ctx.font_size_px = font_size as f64;
        ctx.root_font_size_px = root_font_size as f64;
        if property == "font-size" {
            return format_px(font_size);
        }
    }

    // 0. UA defaults that differ from the generic initial value. Layout hides
    //    `<head>` and its contents; `getComputedStyle` has to say the same
    //    thing, or the two disagree about what is on the page.
    if property == "display" {
        if let Some(crate::dom::node::NodeData::Element(elem)) = state.dom.get(id).map(|n| &n.data)
        {
            const HIDDEN: &[&str] = &[
                "head", "base", "basefont", "bgsound", "datalist", "link", "meta", "noembed",
                "noframes", "param", "rp", "script", "style", "template", "title",
            ];
            if HIDDEN.contains(&&*elem.name.local) {
                let inline = get_inline_style_value(&state.dom, id, property);
                if inline.as_deref().unwrap_or("").is_empty() {
                    return "none".into();
                }
            }
        }
    }

    // 1. Check inline style (highest specificity)
    let inline_val = get_inline_style_value(&state.dom, id, property);
    if let Some(val) = &inline_val {
        if !val.is_empty() {
            return resolve_computed_value(val, &ctx);
        }
    }

    // 2. Check <style> block rules (matched by selector)
    if let Some(val) = get_stylesheet_value(state, id, property) {
        return computed_value_text(&val, &ctx);
    }

    // 3. CSS inheritance — walk up the DOM for inherited properties
    const INHERITED: &[&str] = &[
        "color",
        "font-family",
        "font-size",
        "font-style",
        "font-weight",
        "font-variant",
        "line-height",
        "letter-spacing",
        "word-spacing",
        "text-align",
        "text-indent",
        "text-transform",
        "white-space",
        "direction",
        "visibility",
        "cursor",
        // Inherited per CSS: a floating `<label style="pointer-events:none">`
        // over a field passes clicks through its own `<span>` children too.
        // Missing here, the span reported `auto`, hit-testing landed on it,
        // and every click on the field underneath read as covered.
        "pointer-events",
        "list-style-type",
        "list-style-position",
        "list-style-image",
        "list-style",
        "border-collapse",
        "border-spacing",
        "caption-side",
        "empty-cells",
        "quotes",
        "orphans",
        "widows",
        "text-decoration-color",
    ];

    if INHERITED.contains(&property) {
        let mut current = id;
        while let Some(parent_id) = state.dom.get(current).and_then(|n| n.parent) {
            if let Some(val) = get_inline_style_value(&state.dom, parent_id, property) {
                if !val.is_empty() {
                    return computed_value_text(&val, &ctx);
                }
            }
            if let Some(val) = get_stylesheet_value(state, parent_id, property) {
                return computed_value_text(&val, &ctx);
            }
            current = parent_id;
        }
    }

    // 4. CSS default. `display` is the exception: what an element's display is
    //    depends on its tag, and only the style pass has applied that.
    if property == "display" {
        if let Some((_, _, Some(display))) = styled {
            return display.to_string();
        }
    }
    crate::js_runtime::extensions::layout_ext::css_default(property)
}

/// Extract a property value from an element's inline style attribute.
fn get_inline_style_value(dom: &crate::dom::Dom, id: NodeId, property: &str) -> Option<String> {
    let style_attr = dom.get(id).and_then(|n| n.as_element()).and_then(|e| {
        e.attrs
            .iter()
            .find(|a| a.name.local.eq_ignore_ascii_case("style"))
            .map(|a| a.value.clone())
    })?;

    for decl in style_attr.split(';') {
        let decl = decl.trim();
        if decl.is_empty() {
            continue;
        }
        if let Some(colon) = decl.find(':') {
            let prop = decl[..colon].trim();
            let val = decl[colon + 1..].trim();
            if prop.eq_ignore_ascii_case(property) {
                return Some(val.to_string());
            }
        }
    }
    None
}

/// Search the style rules (the user-agent sheet included) for a matching
/// declaration. Returns the value of the cascade's winner.
fn get_stylesheet_value(state: &mut DomState, id: NodeId, property: &str) -> Option<String> {
    // Safe only while nothing has mutated since the cache was filled. The
    // epoch only ever increases, so a mismatch here reliably means *some*
    // mutation happened since — including one that set-then-cleared layout's
    // `dirty` bit entirely between two of our own reads, via an unrelated
    // layout query's `compute()`. A mutation we can't attribute to one
    // entry, so any mismatch just drops the whole cache.
    let current_epoch = state.layout_engine.dirty_epoch();
    if state.computed_style_cache_epoch != current_epoch {
        state.computed_style_cache.clear();
        state.computed_style_cache_epoch = current_epoch;
    }
    let cache_key = (id, property.to_string());
    if let Some(cached) = state.computed_style_cache.get(&cache_key) {
        return cached.clone();
    }

    let result = state.stylist.winning_raw(&state.dom, id, property);
    state.computed_style_cache.insert(cache_key, result.clone());
    result
}

// --- Shadow DOM ops ---

/// Attach a shadow root to an element. Returns the shadow root node ID.
#[op2(fast)]
#[smi]
pub fn op_dom_attach_shadow(state: &mut OpState, #[smi] node_id: i32, #[string] mode: &str) -> i32 {
    let state = state.borrow_mut::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    let shadow_mode = match mode {
        "closed" => crate::dom::node::ShadowRootMode::Closed,
        _ => crate::dom::node::ShadowRootMode::Open,
    };
    let shadow_id = state.dom.create_shadow_root(id, shadow_mode);
    shadow_id.to_raw() as i32
}

/// Get shadow root of an element (-1 if none).
#[op2(fast)]
#[smi]
pub fn op_dom_get_shadow_root(state: &mut OpState, #[smi] node_id: i32) -> i32 {
    let state = state.borrow::<DomState>();
    let id = NodeId::from_raw(node_id as u32);
    state
        .dom
        .get(id)
        .and_then(|n| n.as_element())
        .and_then(|e| e.shadow_root)
        .map(|sr| sr.to_raw() as i32)
        .unwrap_or(-1)
}

// --- CSSOM ops ---

#[op2(fast)]
pub fn op_dom_get_stylesheet_count(state: &mut OpState) -> i32 {
    let state = state.borrow::<DomState>();
    state.stylesheets.len() as i32
}

#[derive(serde::Serialize)]
pub struct CSSRuleJson {
    pub selector_text: String,
    pub css_text: String,
    pub rule_type: u8,
}

/// One `@font-face` rule, flattened to the descriptors `FontFace` exposes.
#[derive(serde::Serialize)]
pub struct FontFaceJson {
    pub family: String,
    pub style: String,
    pub weight: String,
    pub stretch: String,
    pub unicode_range: String,
    pub variant: String,
    pub feature_settings: String,
    pub display: String,
    pub ascent_override: String,
    pub descent_override: String,
    pub line_gap_override: String,
    pub size_adjust: String,
    pub variation_settings: String,
}

/// Walk a rule list, flattening every `@font-face` into `out`.
///
/// Recursive because a `@font-face` nested in `@media`/`@supports` is still a
/// face the document declares.
fn collect_font_faces(rules: &[crate::css_parser::ast::Rule], out: &mut Vec<FontFaceJson>) {
    use crate::css_parser::ast::{Block, Rule};
    for rule in rules {
        let Rule::At(at) = rule else { continue };
        match &at.block {
            Some(Block::RuleList(inner)) => collect_font_faces(inner, out),
            Some(Block::DeclarationBlock {
                declarations,
                rules: inner,
            }) => {
                if at.name.eq_ignore_ascii_case("font-face") {
                    let desc = |name: &str, fallback: &str| -> String {
                        declarations
                            .iter()
                            .rev()
                            .find(|d| d.name.eq_ignore_ascii_case(name))
                            .map(|d| {
                                crate::js_runtime::utils::tokens_to_string(&d.value)
                                    .trim()
                                    .trim_matches(['"', '\''])
                                    .to_string()
                            })
                            .filter(|v| !v.is_empty())
                            .unwrap_or_else(|| fallback.to_string())
                    };
                    // A face with no family is not addressable and Chrome drops it.
                    let family = desc("font-family", "");
                    if !family.is_empty() {
                        out.push(FontFaceJson {
                            family,
                            style: desc("font-style", "normal"),
                            weight: desc("font-weight", "normal"),
                            stretch: desc("font-stretch", "normal"),
                            unicode_range: desc("unicode-range", "U+0-10FFFF"),
                            variant: desc("font-variant", "normal"),
                            feature_settings: desc("font-feature-settings", "normal"),
                            display: desc("font-display", "auto"),
                            ascent_override: desc("ascent-override", "normal"),
                            descent_override: desc("descent-override", "normal"),
                            line_gap_override: desc("line-gap-override", "normal"),
                            size_adjust: desc("size-adjust", "100%"),
                            variation_settings: desc("font-variation-settings", "normal"),
                        });
                    }
                }
                collect_font_faces(inner, out);
            }
            None => {}
        }
    }
}

/// Every `@font-face` the document's stylesheets declare, in document order.
///
/// Backs `document.fonts`, whose contents in a real browser are the document's
/// own faces — NOT the installed system fonts. `op_dom_get_stylesheet_rules`
/// cannot serve this: it emits qualified rules only and drops every at-rule.
#[op2]
#[serde]
pub fn op_dom_font_faces(state: &mut OpState) -> Vec<FontFaceJson> {
    let state = state.borrow::<DomState>();
    let mut out = Vec::new();
    for sheet in &state.stylesheets {
        let (parsed, _errors) = crate::css_parser::parse_stylesheet(sheet);
        collect_font_faces(&parsed.rules, &mut out);
    }
    out
}

/// Get parsed rules for a stylesheet by index.
#[op2]
#[serde]
pub fn op_dom_get_stylesheet_rules(state: &mut OpState, #[smi] index: i32) -> Vec<CSSRuleJson> {
    let state = state.borrow::<DomState>();
    let idx = index as usize;
    if idx >= state.stylesheets.len() {
        return vec![];
    }
    let (stylesheet, _errors) = crate::css_parser::parse_stylesheet(&state.stylesheets[idx]);
    let mut rules = Vec::new();
    for rule in &stylesheet.rules {
        if let crate::css_parser::ast::Rule::Qualified(qr) = rule {
            let selector_text = tokens_to_string(&qr.prelude);
            if selector_text.is_empty() {
                continue;
            }
            let decl_parts: Vec<String> = qr
                .declarations
                .iter()
                .map(|d| {
                    let val = tokens_to_string(&d.value).trim().to_string();
                    if d.important {
                        format!("{}: {} !important", d.name, val)
                    } else {
                        format!("{}: {}", d.name, val)
                    }
                })
                .collect();
            let css_text = format!("{} {{ {} }}", selector_text, decl_parts.join("; "));
            rules.push(CSSRuleJson {
                selector_text: selector_text.trim().to_string(),
                css_text,
                rule_type: 1, // CSSStyleRule
            });
        }
    }
    rules
}

#[op2]
#[string]
pub fn op_dom_get_base_url(state: &mut OpState) -> String {
    let state = state.borrow::<DomState>();
    state
        .base_url
        .as_ref()
        .map(|u| u.to_string())
        .unwrap_or_else(|| "about:blank".to_string())
}

/// `localStorage`/`sessionStorage` live with the page's document: every frame
/// realm is same-origin with the page (see `realms`), and same-origin documents
/// share their storage — a value a frame stores is one the page reads.
fn page_storage(
    state: &mut OpState,
) -> &mut std::collections::HashMap<String, std::collections::HashMap<String, String>> {
    crate::js_runtime::realms::page_storage(state)
}

#[op2]
#[string]
pub fn op_dom_storage_get(
    state: &mut OpState,
    #[string] area: String,
    #[string] key: String,
) -> Option<String> {
    page_storage(state)
        .get(&area)
        .and_then(|m| m.get(&key))
        .cloned()
}

#[op2(fast)]
pub fn op_dom_storage_set(
    state: &mut OpState,
    #[string] area: String,
    #[string] key: String,
    #[string] value: String,
) {
    if let Some(m) = page_storage(state).get_mut(&area) {
        m.insert(key, value);
    }
}

#[op2(fast)]
pub fn op_dom_storage_remove(state: &mut OpState, #[string] area: String, #[string] key: String) {
    if let Some(m) = page_storage(state).get_mut(&area) {
        m.remove(&key);
    }
}

#[op2(fast)]
pub fn op_dom_storage_clear(state: &mut OpState, #[string] area: String) {
    if let Some(m) = page_storage(state).get_mut(&area) {
        m.clear();
    }
}

#[op2]
#[serde]
pub fn op_dom_storage_keys(state: &mut OpState, #[string] area: String) -> Vec<String> {
    page_storage(state)
        .get(&area)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

/// Run a dynamically inserted classic script under its own URL.
///
/// The JS side used to reach for `(0, eval)(code)`, which V8 attributes to
/// `eval (<anonymous>:…)`. Talon ships `new Error().stack` verbatim in its XAL
/// payload, so its own SDK showed up there as anonymous eval where a real
/// Chrome names the file — a difference visible in one string compare.
/// Compiling with a `ScriptOrigin` gives the frames the script's URL, exactly
/// as the document's own scripts already get from `execute_script_with_name`.
///
/// The script runs in the document that inserted it: an op runs in the page's
/// context whoever calls it, so a script a same-origin frame inserts is
/// compiled in that frame's realm (the active one — see `realms`), not the
/// page's.
///
/// Exceptions propagate to the caller, as they do out of `eval`.
#[op2(nofast, reentrant)]
pub fn op_run_classic_script<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    #[string] code: String,
    #[string] url: String,
) {
    let op_state = JsRuntime::op_state_from(scope);
    let realm_ctx = crate::js_runtime::realms::active_context(scope, &op_state);
    let ctx = match realm_ctx {
        Some(c) => v8::Local::new(scope, &c),
        None => scope.get_current_context(),
    };
    let cs = &mut v8::ContextScope::new(scope, ctx);
    let Some(src) = v8::String::new(cs, &code) else {
        return;
    };
    let origin = v8::String::new(cs, &url).map(|name| {
        v8::ScriptOrigin::new(
            cs,
            name.into(),
            0,
            0,
            false,
            0,
            None,
            false,
            false,
            false,
            None,
        )
    });
    if let Some(script) = v8::Script::compile(cs, src, origin.as_ref()) {
        script.run(cs);
    }
}

deno_core::extension!(
    dom_extension,
    ops = [
        op_dom_document_node,
        op_dom_is_quirks_mode,
        op_dom_get_tag_name,
        op_dom_get_node_type,
        op_dom_get_text_content,
        op_dom_get_inner_html,
        op_dom_get_outer_html,
        op_dom_get_attribute,
        op_dom_has_attribute,
        op_dom_get_attribute_names,
        op_dom_get_parent,
        op_dom_get_children,
        op_dom_get_children_with_types,
        op_dom_get_child_elements,
        op_dom_get_child_elements_with_types,
        op_dom_get_first_child,
        op_dom_get_last_child,
        op_dom_get_next_sibling,
        op_dom_get_prev_sibling,
        op_dom_query_selector,
        op_dom_query_selector_all,
        op_dom_get_element_by_id,
        op_dom_get_elements_by_tag_name,
        op_dom_get_elements_by_class_name,
        op_dom_create_element,
        op_dom_create_text_node,
        op_dom_create_comment,
        op_dom_create_document_fragment,
        op_dom_append_child,
        op_dom_insert_before,
        op_dom_remove_child,
        op_dom_set_attribute,
        op_dom_remove_attribute,
        op_dom_set_text_content,
        op_dom_set_inner_html,
        op_dom_document_write,
        op_dom_document_write_after,
        op_dom_clone_node,
        op_dom_insert_adjacent_html,
        op_dom_class_list_add,
        op_dom_class_list_remove,
        op_dom_get_computed_style,
        op_dom_get_all_computed_styles,
        op_dom_refresh_stylesheets,
        op_iframe_post_to_child,
        op_iframe_post_to_parent,
        op_realm_switch,
        op_frame_window,
        op_incumbent_window,
        op_iframe_take_child_messages,
        op_iframe_take_parent_messages,
        op_dom_get_stylesheet_count,
        op_dom_get_stylesheet_rules,
        op_dom_font_faces,
        op_dom_attach_shadow,
        op_dom_get_shadow_root,
        op_dom_get_base_url,
        op_dom_storage_get,
        op_dom_storage_set,
        op_dom_storage_remove,
        op_dom_storage_clear,
        op_dom_storage_keys,
        op_run_classic_script,
    ],
);
