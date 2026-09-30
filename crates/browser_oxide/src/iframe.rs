//! Iframe support for browser_oxide.
//!
//! Each iframe with `srcdoc` gets its own DOM tree, V8 runtime, and event loop.
//! Communication between parent and child is via serialized postMessage.

use crate::dom::node::{NodeData, NodeId};
use crate::dom::Dom;
use crate::event_loop::BrowserEventLoop;
use crate::js_runtime::runtime::BrowserRuntimeOptions;
use crate::js_runtime::BrowserJsRuntime;
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::time::Duration;
use tracing;

static NEXT_FRAME_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

// ---- Isolate graveyard (B1 / Q3 / F0.2) ------------------------------
//
// Each `ChildIframe` owns its own V8 isolate, and V8 requires isolates on
// one thread be destroyed in STRICT reverse-of-creation order — disposing
// an older one while a younger one (a surviving sibling elsewhere in the
// tree, or even one of the dropped frame's own descendants) is still alive
// is a fatal error, not a catchable panic: `Fatal error in
// v8::HandleScope::CreateHandle() — Cannot create a handle without a
// HandleScope`, aborting the process. `Page::rematerialize_iframes` /
// `ChildIframe::materialize_descendants` used to drop a frame the instant
// its element left the DOM, via `Vec::retain`, without regard for whether
// a younger isolate survived elsewhere — reproduced by
// `tests/frame_churn_repro.rs`.
//
// Fix: a frame that needs to go is DETACHED (its subtree is harvested into
// independent entries — a grandchild's generation has no relation to its
// parent's) and parked in a thread-local graveyard instead of being
// dropped immediately. It is only actually destroyed once it becomes
// provably the thread's youngest still-live isolate. This is deliberately
// thread-local, not scoped to one `Page`: the constraint itself is
// per-thread, and multiple `Page`s (e.g. inside a pool) can share one.
//
// This does NOT make isolate-per-frame free to churn arbitrarily — a
// permanently growing graveyard (nothing ever again becomes the youngest)
// still leaks. It only stops the crash; §4.1/Stage 4 of the interaction
// frames plan (separate agents/threads per site) is the real fix for the
// underlying model.
thread_local! {
    /// Generation of every `ChildIframe` isolate currently alive on this
    /// thread — registered at construction (`next_frame_generation`),
    /// unregistered at actual drop (`impl Drop for ChildIframe`).
    static LIVE_FRAME_GENERATIONS: RefCell<BTreeSet<u64>> = const { RefCell::new(BTreeSet::new()) };
    /// Frames logically removed from their parent's tree but not yet safe
    /// to destroy. Swept on every unregistration, since freeing the
    /// current max can unblock the next-oldest entry.
    static FRAME_GRAVEYARD: RefCell<Vec<ChildIframe>> = const { RefCell::new(Vec::new()) };
}

/// Allocate the next isolate-creation-order generation and register it as
/// live. Pairs with `impl Drop for ChildIframe`, which unregisters it.
fn next_frame_generation() -> u64 {
    let generation = NEXT_FRAME_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    LIVE_FRAME_GENERATIONS.with(|live| {
        live.borrow_mut().insert(generation);
    });
    generation
}

fn max_live_frame_generation() -> Option<u64> {
    LIVE_FRAME_GENERATIONS.with(|live| live.borrow().iter().next_back().copied())
}

/// Move a frame — and, recursively, every descendant it still owns — into
/// the graveyard instead of dropping it directly, then destroy whatever in
/// the graveyard has become provably safe to destroy.
///
/// Every call site that removes a frame from a live tree (a selective
/// `retain`, or tearing an entire subtree down together) must route
/// through this rather than dropping a `ChildIframe` directly — a direct
/// drop recurses into its `children` field in plain front-to-back `Vec`
/// order, which is not creation order and not safe.
pub(crate) fn bury_frame(mut frame: ChildIframe) {
    let descendants = std::mem::take(&mut frame.children);
    for descendant in descendants {
        bury_frame(descendant);
    }
    FRAME_GRAVEYARD.with(|graveyard| graveyard.borrow_mut().push(frame));
    sweep_graveyard();
}

fn sweep_graveyard() {
    while let Some(top) = max_live_frame_generation() {
        let dug_up = FRAME_GRAVEYARD.with(|graveyard| {
            let mut graveyard = graveyard.borrow_mut();
            let idx = graveyard.iter().position(|f| f.generation == top)?;
            Some(graveyard.remove(idx))
        });
        match dug_up {
            // Provably the thread's youngest live isolate — safe to
            // actually destroy now. Its own `Drop` unregisters `top`, so
            // the next loop iteration may unlock another graveyard entry.
            Some(frame) => drop(frame),
            // The current max belongs to something still in active use
            // (not in the graveyard) — nothing more to sweep right now.
            None => break,
        }
    }
}

impl Drop for ChildIframe {
    fn drop(&mut self) {
        LIVE_FRAME_GENERATIONS.with(|live| {
            live.borrow_mut().remove(&self.generation);
        });
    }
}

/// Fire `load` on the owning `<iframe>`/`<frame>` element, in the PARENT
/// document's own event loop, after its child context finishes loading.
/// Per spec every framed document's `load` (fired inside the child on its
/// own `window`, separately) is followed by one on the owner element too —
/// the signal a page's own "widget ready" check actually polls for
/// (`iframe.addEventListener('load', ...)`) — which nothing in this engine
/// fired before this.
pub(crate) fn fire_owner_load(event_loop: &mut BrowserEventLoop, node_id: NodeId) {
    let raw = node_id.to_raw();
    let js = format!(
        "(function(){{try{{var s=Object.getOwnPropertySymbols(globalThis,1);\
         for(var i=0;i<s.length;i++){{var v=globalThis[s[i]];\
         if(v&&v.__bo){{v.frames.fireLoad({raw});break;}}}}}}catch(e){{}}}})()"
    );
    let _ = event_loop.execute_script(&js);
}

/// The page document's record of `<iframe>`s whose document could not be
/// built (`DomState::frame_load_failures`): the page materializes frames on
/// its own, on every settle, so without it a frame that cannot load would be
/// refetched on every turn.
fn with_failures<R>(
    event_loop: &mut BrowserEventLoop,
    f: impl FnOnce(&mut std::collections::HashSet<u32>) -> R,
) -> R {
    let op_state = event_loop.runtime_mut().op_state();
    let mut state = op_state.borrow_mut();
    let dom_state = state.borrow_mut::<crate::js_runtime::state::DomState>();
    f(&mut dom_state.frame_load_failures)
}

/// Whether building a frame for `node` already failed.
pub(crate) fn frame_load_failed(event_loop: &mut BrowserEventLoop, node: NodeId) -> bool {
    with_failures(event_loop, |f| f.contains(&node.to_raw()))
}

/// Remember that building a frame for `node` failed.
pub(crate) fn record_frame_load_failure(event_loop: &mut BrowserEventLoop, node: NodeId) {
    with_failures(event_loop, |f| {
        f.insert(node.to_raw());
    });
}

/// Forget failures for frames whose browsing context was invalidated.
pub(crate) fn forget_frame_load_failures(event_loop: &mut BrowserEventLoop, nodes: &[u32]) {
    if nodes.is_empty() {
        return;
    }
    with_failures(event_loop, |f| {
        for n in nodes {
            f.remove(n);
        }
    });
}

/// How many messages may wait for one frame that has not been built yet.
const MAX_PENDING_PER_FRAME: usize = 32;

/// The document a set of frames is embedded in: the page (or a separate-isolate
/// frame's own document), or a same-origin frame realm of the page's isolate.
/// The message pump reads and writes it through this, so it serves both.
pub(crate) enum ParentDoc<'a> {
    Loop(&'a mut BrowserEventLoop),
    Realm(&'a mut BrowserEventLoop, u32),
}

impl ParentDoc<'_> {
    fn exec(&mut self, js: &str) -> Result<String, deno_core::error::AnyError> {
        match self {
            Self::Loop(l) => l.execute_script(js),
            Self::Realm(l, r) => l.runtime_mut().execute_in_realm(*r, js),
        }
    }

    fn privileged(&mut self, js: &str) -> Result<String, deno_core::error::AnyError> {
        match self {
            Self::Loop(l) => l.runtime_mut().call_privileged(js),
            Self::Realm(l, r) => l.runtime_mut().call_privileged_in_realm(*r, js),
        }
    }

    fn with_dom<R>(
        &mut self,
        f: impl FnOnce(&mut crate::js_runtime::state::DomState) -> R,
    ) -> Option<R> {
        match self {
            Self::Loop(l) => {
                let op_state = l.runtime_mut().op_state();
                let mut state = op_state.borrow_mut();
                state
                    .try_borrow_mut::<crate::js_runtime::state::DomState>()
                    .map(f)
            }
            Self::Realm(l, r) => l.runtime_mut().with_realm_dom(*r, f),
        }
    }
}

/// Put messages posted to frames that have no realm yet back on the parent's
/// queue, so they are delivered once the frame is built instead of lost.
///
/// A widget loader commonly appends its frame and posts to it in the same
/// task; the engine builds the frame a turn later. Messages for a frame whose
/// document failed to load are dropped, and each frame keeps only its most
/// recent [`MAX_PENDING_PER_FRAME`].
fn retain_undelivered(parent: &mut ParentDoc, undelivered: Vec<(u32, String)>) {
    if undelivered.is_empty() {
        return;
    }
    parent.with_dom(|dom_state| {
        let mut kept: Vec<(u32, String)> = Vec::new();
        for (node, json) in undelivered.into_iter().rev() {
            if dom_state.frame_load_failures.contains(&node) {
                continue;
            }
            if kept.iter().filter(|(n, _)| *n == node).count() >= MAX_PENDING_PER_FRAME {
                continue;
            }
            kept.push((node, json));
        }
        kept.reverse();
        // Ahead of anything posted since: they were posted first.
        let newer = std::mem::take(&mut dom_state.messages_to_children);
        dom_state.messages_to_children = kept;
        dom_state.messages_to_children.extend(newer);
    });
}

/// The serialized origin of `url`; `"null"` (opaque) when it has none.
pub(crate) fn origin_of(url: &str) -> String {
    url::Url::parse(url)
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_else(|_| "null".to_string())
}

/// Whether a message posted with `target_origin` may reach a document whose
/// origin is `receiver`; `sender` is the posting document's origin. `"*"`
/// admits anything, `"/"` means the sender's own origin, and anything else is
/// compared by origin — never matching an opaque receiver, as in the spec.
fn target_origin_admits(target_origin: &str, sender: &str, receiver: &str) -> bool {
    match target_origin {
        "*" => true,
        "/" => sender == receiver && receiver != "null",
        target => receiver != "null" && origin_of(target) == receiver,
    }
}

const NS_EXPR: &str = "(function(){try{var s=Object.getOwnPropertySymbols(globalThis,1);for(var i=0;i<s.length;i++){var v=globalThis[s[i]];if(v&&v.__bo)return v;}}catch(e){}return null;})()";

/// One queued `postMessage`: the payload and the target origin its sender
/// named. The sender's own claim about its origin is ignored — see
/// [`pump_frame_messages`].
struct QueuedMessage {
    /// `None` for a posted `undefined`, which JSON drops.
    data: Option<serde_json::Value>,
    target_origin: String,
}

fn parse_queued(json: &str) -> Option<QueuedMessage> {
    let mut value: serde_json::Value = serde_json::from_str(json).ok()?;
    let target_origin = value
        .get("targetOrigin")
        .and_then(|t| t.as_str())
        .unwrap_or("*")
        .to_string();
    Some(QueuedMessage {
        data: value.as_object_mut().and_then(|m| m.remove("data")),
        target_origin,
    })
}

/// Dispatch a `message` event in `event_loop`'s realm, marked trusted — a
/// delivered `postMessage` is a trusted event in Chrome, and a widget that
/// checks `event.isTrusted` on its handshake otherwise never answers.
fn deliver_message(
    target: &mut ParentDoc,
    data: Option<&serde_json::Value>,
    origin: &str,
    source_js: &str,
) -> bool {
    let data = data
        .and_then(|d| serde_json::to_string(d).ok())
        .unwrap_or_else(|| "undefined".into());
    let origin = serde_json::to_string(origin).unwrap_or_else(|_| "\"null\"".into());
    let js = format!(
        "(function (caps) {{\n\
           var ev = new MessageEvent('message', {{ data: {data}, origin: {origin}, source: {source_js} }});\n\
           if (caps.markTrusted) caps.markTrusted(ev);\n\
           globalThis.dispatchEvent(ev);\n\
         }})"
    );
    target.privileged(&js).is_ok()
}

/// Carry every queued `postMessage` one level: from the document in `parent`
/// down into its direct `children`, and from each child up into `parent`.
/// Returns `(delivered down, delivered up)`.
///
/// Origins come from the engine's own records — `parent_origin` and each
/// child's [`ChildIframe::origin`] — not from the `origin` field the sending
/// realm wrote into its queue. That field read `location.origin`, which for a
/// `srcdoc` frame said `"null"` instead of the parent's origin, and the
/// receiving side checked `targetOrigin` against the same wrong value, so a
/// parent posting to its srcdoc widget with its own origin as the target was
/// dropped.
///
/// `children` may hold frames of other documents too; only those whose
/// [`ChildIframe::parent_realm`] is `realm` belong to `parent`.
pub(crate) fn pump_frame_messages(
    parent: &mut ParentDoc,
    parent_origin: &str,
    children: &mut [ChildIframe],
    realm: u32,
) -> (usize, usize) {
    let outbound: Vec<String> = parent
        .exec(&format!(
            "JSON.stringify({NS_EXPR}.frames.takeChildMessages())"
        ))
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    let mut down = 0;
    let mut undelivered: Vec<(u32, String)> = Vec::new();
    for pair in outbound.chunks(2) {
        let (Some(node), Some(json)) = (pair.first(), pair.get(1)) else {
            continue;
        };
        let (Ok(node), Some(msg)) = (node.parse::<u32>(), parse_queued(json)) else {
            continue;
        };
        let Some(child) = children
            .iter_mut()
            .find(|c| c.parent_realm == realm && c.node_id.to_raw() == node)
        else {
            undelivered.push((node, json.clone()));
            continue;
        };
        if !target_origin_admits(&msg.target_origin, parent_origin, &child.origin) {
            continue;
        }
        // `source` is the embedder's window: a frame that answers via
        // `event.source` must be able to reach back.
        down += usize::from(deliver_message(
            &mut ParentDoc::Loop(&mut child.event_loop),
            msg.data.as_ref(),
            parent_origin,
            "(globalThis.parent || null)",
        ));
    }
    retain_undelivered(parent, undelivered);

    // The sending frame's node id travels with each message: the embedder
    // replies with `event.source.postMessage(...)`, and without a source it has
    // no handle on the frame that spoke to it. hCaptcha's widget ends its
    // handshake with `site-setup` and then waits for exactly that reply, so a
    // null source stalls the challenge with no error anywhere.
    let mut inbound: Vec<(u32, String, String)> = Vec::new();
    for child in children.iter_mut().filter(|c| c.parent_realm == realm) {
        let node = child.node_id.to_raw();
        let Ok(raw) = child.event_loop.execute_script(&format!(
            "JSON.stringify({NS_EXPR}.frames.takeParentMessages())"
        )) else {
            continue;
        };
        if let Ok(list) = serde_json::from_str::<Vec<String>>(&raw) {
            inbound.extend(list.into_iter().map(|j| (node, child.origin.clone(), j)));
        }
    }
    let mut up = 0;
    for (node, child_origin, json) in inbound {
        let Some(msg) = parse_queued(&json) else {
            continue;
        };
        if !target_origin_admits(&msg.target_origin, &child_origin, parent_origin) {
            continue;
        }
        let source = format!(
            "(function(){{try{{return {NS_EXPR}.frames.windowForNode({node});}}catch(_){{return null;}}}})()"
        );
        up += usize::from(deliver_message(
            parent,
            msg.data.as_ref(),
            &child_origin,
            &source,
        ));
    }
    (down, up)
}

/// Info about an iframe found in the DOM.
pub struct IframeInfo {
    pub node_id: NodeId,
    pub srcdoc: Option<String>,
    pub src: Option<String>,
}

/// Point a child realm's `parent`/`top` at a bridge that queues `postMessage`
/// upward, and revoke the privileged setter.
///
/// Without this a child's `parent.postMessage(...)` resolves to its own window
/// (the frame-tree globals are self-referential), so a widget's handshake with
/// its embedder never leaves the child isolate.
const INSTALL_PARENT_BRIDGE: &str = r#"
(function () {
    // The engine's symbol-keyed namespace, not `Deno.core.ops`: this runs after
    // cleanup_bootstrap has removed `Deno`, so the ops lookup would be null and
    // every postMessage from this frame would silently vanish.
    var ns = (function(){try{var s=Object.getOwnPropertySymbols(globalThis,1);for(var i=0;i<s.length;i++){var v=globalThis[s[i]];if(v&&v.__bo)return v;}}catch(e){}return null;})();
    var frames = (ns && ns.frames) || null;
    var bridge = {
        postMessage: function (data, targetOrigin) {
            if (!frames) return;
            var json;
            try {
                json = JSON.stringify({
                    data: data,
                    origin: (globalThis.location && globalThis.location.origin) || '',
                    targetOrigin: String(targetOrigin == null ? '*' : targetOrigin),
                });
            } catch (_) {
                // Degrade the payload, never the audience.
                json = JSON.stringify({
                    data: String(data), origin: '',
                    targetOrigin: String(targetOrigin == null ? '*' : targetOrigin),
                });
            }
            frames.postToParent(json);
        },
        closed: false,
        get frames() { return bridge; },
        get self() { return bridge; },
        get window() { return bridge; },
        blur: function () {}, focus: function () {}, close: function () {},
    };
    try { ns.setFrameLinks(bridge, bridge); } catch (_) {}
    try { delete ns.setFrameLinks; } catch (_) {}
})()
"#;

/// A child iframe with its own V8 runtime and DOM.
pub struct ChildIframe {
    pub node_id: NodeId,
    pub generation: u64,
    pub children: Vec<ChildIframe>,
    pub event_loop: BrowserEventLoop,
    /// The `src` or `srcdoc` value this realm was built from, exactly as the
    /// attribute held it.
    ///
    /// A DOM mutation says the frame *may* have navigated, not that it did:
    /// widgets re-append and re-attribute their own frames constantly, and
    /// rebuilding on every such signal is an unbounded fetch loop that starves
    /// the event loop. Comparing against this decides whether the realm is
    /// actually stale.
    pub source: String,
    /// The document's origin, decided by the engine rather than read back
    /// from the realm: a `src` frame's own URL's, a `srcdoc` frame's parent's.
    /// A message this frame posts is stamped with it, and a message posted to
    /// it is checked against it.
    pub origin: String,
    /// The frame realm whose document holds this frame's `<iframe>`: 0 for
    /// the page (or, for a frame's own descendants, that frame's document), a
    /// frame realm's id for a cross-origin frame inside a same-origin one.
    pub parent_realm: u32,
    /// What the document's relative URLs resolve against — for a `srcdoc`
    /// frame its parent's base, since its own URL is `about:srcdoc`.
    base_url: String,
    /// The frame's box in the top-level viewport, as last pushed into the realm.
    /// Kept so an unchanged layout does not re-enter the child runtime.
    frame_box: Option<(f64, f64, f64, f64)>,
}

impl ChildIframe {
    /// Publish the frame's measured box into the child realm.
    ///
    /// `x`/`y` are the frame's offset inside the top-level viewport, so the
    /// realm can turn its local coordinates into top-level ones; `w`/`h` become
    /// the realm's `innerWidth`/`innerHeight`.
    pub fn set_frame_geometry(&mut self, x: f64, y: f64, w: f64, h: f64) {
        let next = (x, y, w, h);
        if self.frame_box == Some(next) {
            return;
        }
        self.frame_box = Some(next);
        // The realm's *layout* viewport is the frame's box too, not just the
        // number JS reports. Leaving layout on the profile's window size gave a
        // 302x76 frame an initial containing block thousands of pixels wide, so
        // anything positioned against it — a widget pinning its links to the
        // bottom-right corner — was laid out against that phantom width and
        // landed far outside the frame.
        {
            let op_state = self.event_loop.runtime_mut().op_state();
            let mut state = op_state.borrow_mut();
            if let Some(dom_state) = state.try_borrow_mut::<crate::js_runtime::state::DomState>() {
                let dpr = dom_state.layout_engine.viewport().device_pixel_ratio;
                dom_state
                    .layout_engine
                    .set_viewport(crate::layout::Viewport::with_dpr(w as f32, h as f32, dpr));
            }
        }
        let js = FRAME_GEOMETRY_JS
            .replace("__X__", &format!("{:.2}", x))
            .replace("__Y__", &format!("{:.2}", y))
            .replace("__W__", &format!("{:.2}", w))
            .replace("__H__", &format!("{:.2}", h));
        let _ = self.event_loop.execute_script(&js);
    }
}

/// Tell a child realm where its frame sits and how big it is.
///
/// A realm cannot measure its own frame: `window.frameElement` crosses the
/// realm boundary and `parent` is not reachable, so the numbers have to come
/// from the embedder, which is the side that laid the frame out. Without them a
/// frame reported the top-level viewport as its own and placed events in the
/// wrong coordinate space.
const FRAME_GEOMETRY_JS: &str = r#"(function(){
  try {
    var syms = Object.getOwnPropertySymbols(globalThis,1);
    for (var i = 0; i < syms.length; i++) {
      var v = globalThis[syms[i]];
      if (v && v.__bo) { v.frame = { x: __X__, y: __Y__, w: __W__, h: __H__ }; return 'ок'; }
    }
  } catch (e) {}
  return 'нет неймспейса';
})()"#;

/// Install the per-frame diagnostic tape, before the frame's own scripts.
///
/// A widget that rebuilds its browsing context — hCaptcha does this on every
/// challenge reload — carries away any probe attached from outside, so hooks
/// installed by hand never survive to the moment worth watching. Injecting from
/// here means every realm, including each rebuilt one, starts with the tape
/// already running.
///
/// Both constructors need it: a frame's document arrives either inline
/// (`srcdoc`) or over the network (`src`), and the interesting ones are the
/// second kind.
fn install_frame_trace(event_loop: &mut BrowserEventLoop) {
    if std::env::var_os("BROWSER_OXIDE_FRAME_TRACE").is_some() {
        event_loop
            .execute_script(include_str!("js/frame_trace.js"))
            .ok();
    }
}

impl ChildIframe {
    pub fn materialize_descendants<'a>(
        &'a mut self,
        client: &'a crate::net::HttpClient,
        profile: &'a crate::stealth::StealthProfile,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = usize> + 'a>> {
        Box::pin(async move {
            // The live URL for a frame that navigated itself; the recorded base
            // for a `srcdoc` one, whose `about:srcdoc` resolves nothing.
            let base_url = self
                .evaluate("String(location.href)")
                .ok()
                .filter(|href| !href.starts_with("about:"))
                .unwrap_or_else(|| self.base_url.clone());
            // This frame's own document settles its frames exactly as the page's
            // does: same-origin ones become realms of this isolate, cross-origin
            // ones isolates of their own (see `frames`).
            let mut created = Box::pin(crate::frames::settle_document(
                &mut self.event_loop,
                &mut self.children,
                &base_url,
                client,
                profile,
            ))
            .await;
            for child in &mut self.children {
                created += child.materialize_descendants(client, profile).await;
            }
            self.sync_descendant_geometry();
            created
        })
    }

    pub fn sync_descendant_geometry(&mut self) {
        let boxes: Vec<(usize, f64, f64, f64, f64)> = {
            let op_state = self.event_loop.runtime_mut().op_state();
            let mut state = op_state.borrow_mut();
            let Some(dom_state) = state.try_borrow_mut::<crate::js_runtime::state::DomState>()
            else {
                return;
            };
            self.children
                .iter()
                .enumerate()
                .filter(|(_, child)| child.parent_realm == 0)
                .map(|(index, child)| {
                    let rect = dom_state
                        .layout_engine
                        .get_bounding_rect(&dom_state.dom, child.node_id);
                    (index, rect.x, rect.y, rect.width, rect.height)
                })
                .collect()
        };
        for (index, x, y, width, height) in boxes {
            if let Some(child) = self.children.get_mut(index) {
                if width > 0.0 && height > 0.0 {
                    child.set_frame_geometry(x, y, width, height);
                }
                child.sync_descendant_geometry();
            }
        }
    }

    pub fn drive_descendants<'a>(
        &'a mut self,
        slice: Duration,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = usize> + 'a>> {
        Box::pin(async move {
            let mut count = usize::from(self.event_loop.run_until_idle(slice).await.is_ok());
            for child in &mut self.children {
                count += child.drive_descendants(slice).await;
            }
            count
        })
    }

    pub fn pump_descendant_messages(&mut self) -> (usize, usize) {
        let (mut down, mut up) = pump_frame_messages(
            &mut ParentDoc::Loop(&mut self.event_loop),
            &self.origin,
            &mut self.children,
            0,
        );
        for child in &mut self.children {
            let (nested_down, nested_up) = child.pump_descendant_messages();
            down += nested_down;
            up += nested_up;
        }
        (down, up)
    }

    /// Create a child iframe from srcdoc HTML.
    ///
    /// `parent_url` and `client` fetch `<script src>`s the markup contains:
    /// per spec, a `srcdoc` document's own URL is `about:srcdoc` but its
    /// BASE URL — what relative subresource references resolve against —
    /// is the parent document's. Without them, a widget shipping its JS as
    /// `<script src="widget.js">` inside `srcdoc` (rather than inline)
    /// never ran at all.
    pub async fn from_srcdoc(
        node_id: NodeId,
        html: &str,
        parent_url: &str,
        client: &crate::net::HttpClient,
        profile: &crate::stealth::StealthProfile,
    ) -> Result<Self, deno_core::error::AnyError> {
        let dom = crate::html_parser::parse_html(html);
        let scripts = crate::script_runner::find_scripts(&dom);
        let stylesheet_entries = crate::stylesheet_collector::find_stylesheets(&dom);
        let stylesheets = crate::stylesheet_collector::resolve_inline_only(&stylesheet_entries);

        let runtime = BrowserJsRuntime::with_options(
            dom,
            BrowserRuntimeOptions {
                stealth_profile: Some(profile.clone()),
                stylesheets,
                ..Default::default()
            },
        );
        let mut event_loop = BrowserEventLoop::new(runtime);

        // Per spec, a `srcdoc` document's own URL is `about:srcdoc` (its
        // BASE URL — what relative subresources resolve against — is
        // still the parent's, handled below). Left unset, `location.href`
        // stayed on whatever placeholder the runtime defaults to.
        //
        // Its ORIGIN is the parent's, not the opaque origin a literal
        // `about:` URL parses to: a widget that posts to its srcdoc frame
        // with `targetOrigin: location.origin`, or checks `event.origin`
        // against its own, relies on the two being equal.
        let origin = origin_of(parent_url);
        event_loop
            .execute_script("location.href = 'about:srcdoc';")
            .ok();
        let inherit = format!(
            "(function (caps) {{ if (caps.inheritOrigin) caps.inheritOrigin({}); }})",
            serde_json::to_string(&origin).unwrap_or_else(|_| "null".into())
        );
        event_loop.runtime_mut().call_privileged(&inherit).ok();
        // Setting `href` is URL-state setup, not a navigation request; left
        // pending it would cut the document's first run short.
        event_loop.reset_nav_pending();

        // Before any page script: a widget that talks to its embedder does so during
        // its own initial execution, so a bridge installed afterwards is installed
        // into a document that has already given up. See `from_url`.
        event_loop.execute_script(INSTALL_PARENT_BRIDGE).ok();
        install_frame_trace(&mut event_loop);

        // Execute scripts in the child's own V8 context. W2.7 — Chrome
        // reports `about:srcdoc` for srcdoc iframe stack frames, so inline
        // scripts keep that name; an external one is named by its resolved
        // URL, same as `from_url` below.
        let base = url::Url::parse(parent_url).ok();
        for (i, script) in scripts.iter().enumerate() {
            if let Some(src) = &script.src {
                let Some(full_url) = base.as_ref().and_then(|b| b.join(src).ok()) else {
                    continue;
                };
                let full_url = full_url.to_string();
                let hdrs = crate::net::headers::nav_headers_subresource(
                    client.profile(),
                    &full_url,
                    parent_url,
                    "script",
                    false,
                );
                // Boxed: the HTTP client's future is large, and inlined here it
                // becomes part of every future that awaits `from_srcdoc` —
                // `Page::from_html` among them. A test awaiting a dozen pages
                // in one body then held so big a future on its thread's stack
                // that V8 had none left to boot the next isolate ("Maximum
                // call stack size exceeded" in `00_primordials.js`).
                let code = match Box::pin(client.get_with_exact_headers(&full_url, &hdrs)).await {
                    Ok(resp) if resp.ok() => {
                        let text = resp.text();
                        if text.trim_start().starts_with("<!") {
                            continue;
                        }
                        text
                    }
                    _ => continue,
                };
                if code.trim().is_empty() {
                    continue;
                }
                if let Err(e) = event_loop.execute_script_with_name(&code, &full_url) {
                    tracing::warn!(script_index = i, error = %e, "srcdoc external script error");
                }
                continue;
            }
            if script.code.trim().is_empty() {
                continue;
            }
            if let Err(e) = event_loop.execute_script_with_name(&script.code, "about:srcdoc") {
                tracing::warn!(script_index = i, error = %e, "iframe script error");
            }
        }

        // The child document's own lifecycle — same as `from_url` below,
        // and for the same reason: a framed document that never advances
        // past `loading` leaves any `DOMContentLoaded` listener waiting
        // forever.
        const NS: &str = "(function(){try{var s=Object.getOwnPropertySymbols(globalThis,1);for(var i=0;i<s.length;i++){var v=globalThis[s[i]];if(v&&v.__bo)return v;}}catch(e){}return null;})()";
        event_loop
            .execute_script(&format!(
                "setTimeout(function(){{\
                   var b=(({NS}||{{}}).host||{{}}).bo;\
                   if(b)b.__documentReadyState='interactive';\
                   document.dispatchEvent(new Event('DOMContentLoaded',{{bubbles:true}}));\
                   globalThis.dispatchEvent(new Event('DOMContentLoaded',{{bubbles:true}}));\
                   if(b)b.__documentReadyState='complete';\
                   globalThis.dispatchEvent(new Event('load'));\
                 }},0);"
            ))
            .ok();

        // Run child event loop
        event_loop.run_until_idle(Duration::from_secs(5)).await?;

        Ok(Self {
            node_id,
            generation: next_frame_generation(),
            children: Vec::new(),
            event_loop,
            source: html.to_string(),
            origin,
            parent_realm: 0,
            base_url: parent_url.to_string(),
            frame_box: None,
        })
    }

    /// Create a child iframe by fetching src URL via HTTP client.
    ///
    /// `parent_url` is the embedding document's URL; it decides the request's
    /// `sec-fetch-site` and `Referer`, which a framed widget's server reads to
    /// tell an embedded frame from a typed-in address.
    pub async fn from_url(
        node_id: NodeId,
        url: &str,
        parent_url: &str,
        client: &crate::net::HttpClient,
        stealth_profile: Option<&crate::stealth::StealthProfile>,
    ) -> Result<Self, deno_core::error::AnyError> {
        // CSP `frame-src` enforcement (falls back to child-src then
        // default-src). Real Chrome refuses to navigate iframes whose
        // src violates the parent's CSP, surfacing the same network-
        // error shape we return on op_fetch blocks.
        if let Ok(parsed_url) = url::Url::parse(url) {
            if let Err(violated) = crate::js_runtime::extensions::fetch_ext::check_csp(
                crate::net::csp::Directive::FrameSrc,
                &parsed_url,
                None,
                false,
            ) {
                eprintln!(
                    "[csp] Refused to frame '{}' because it violates the following Content Security Policy directive: \"{}\".",
                    url, violated
                );
                return Err(deno_core::error::AnyError::msg(format!(
                    "iframe blocked by CSP: {}",
                    url
                )));
            }
        }

        let resp = match stealth_profile {
            Some(profile) => {
                let hdrs = crate::net::headers::nav_headers_iframe(profile, url, parent_url);
                client.get_with_exact_headers(url, &hdrs).await
            }
            None => client.get(url).await,
        }
        .map_err(|e| deno_core::error::AnyError::msg(format!("iframe fetch error: {}", e)))?;

        if !resp.ok() {
            return Err(deno_core::error::AnyError::msg(format!(
                "iframe fetch {} returned {}",
                url, resp.status
            )));
        }

        let html = resp.text();
        // Skip if response looks like non-HTML (binary, error page)
        if html.trim().is_empty() {
            return Self::from_srcdoc(
                node_id,
                "<html><body></body></html>",
                parent_url,
                client,
                stealth_profile.unwrap(),
            )
            .await;
        }

        let dom = crate::html_parser::parse_html(&html);
        let scripts = crate::script_runner::find_scripts(&dom);
        let stylesheet_entries = crate::stylesheet_collector::find_stylesheets(&dom);

        // Fetch external stylesheets
        let mut stylesheets = Vec::new();
        for entry in &stylesheet_entries {
            match entry {
                crate::stylesheet_collector::StylesheetEntry::Inline(css) => {
                    stylesheets.push(css.clone());
                }
                crate::stylesheet_collector::StylesheetEntry::External(href) => {
                    // `Url::join` handles every relative form (`style.css`,
                    // `../shared/x.css`, `//other-host/x.css`, `?query`), not
                    // just absolute and root-relative — the ad-hoc string
                    // concatenation this replaced silently dropped any
                    // document-relative stylesheet link.
                    let Some(full_url) = url::Url::parse(url)
                        .ok()
                        .and_then(|base| base.join(href).ok())
                        .map(|u| u.to_string())
                    else {
                        continue;
                    };
                    let hdrs = crate::net::headers::nav_headers_subresource(
                        client.profile(),
                        &full_url,
                        url,
                        "style",
                        false,
                    );
                    if let Ok(resp) = client.get_with_exact_headers(&full_url, &hdrs).await {
                        if resp.ok() {
                            let text = resp.text();
                            if !text.trim_start().starts_with("<!") {
                                stylesheets.push(text);
                            }
                        }
                    }
                }
            }
        }

        let mut options = BrowserRuntimeOptions {
            stylesheets,
            is_secure_context: crate::page::is_secure_url(url),
            ..Default::default()
        };
        if let Some(profile) = stealth_profile {
            options.stealth_profile = Some(profile.clone());
        }

        let runtime = BrowserJsRuntime::with_options(dom, options);
        let mut event_loop = BrowserEventLoop::new(runtime);

        // Set location
        let url_js = url.replace('\\', "\\\\").replace('\'', "\\'");
        event_loop
            .execute_script(&format!("location.href = '{}';", url_js))
            .ok();

        // Install the parent bridge BEFORE page scripts, not after. Third-party
        // widgets hand off to their embedder during their own initial execution —
        // hCaptcha's frame bundle ends with `send("checkbox-ready")` — so a bridge
        // installed after the script loop is installed into a frame that already
        // posted into the void and is now waiting for a reply that cannot come.
        // The embedder answers that first message with the config the frame needs
        // to fetch its proof-of-work worker, so losing it stalls the whole widget.
        event_loop.execute_script(INSTALL_PARENT_BRIDGE).ok();
        install_frame_trace(&mut event_loop);

        // Execute scripts, fetching external ones
        for (i, script) in scripts.iter().enumerate() {
            let code = if let Some(src) = &script.src {
                // Same fix as the stylesheet loop above: resolve every
                // relative form via `Url::join`, not just absolute/root-
                // relative. This was the actual cause of B3's "relative
                // scripts are skipped" — a framed widget shipping
                // `<script src="widget.js">` never ran at all.
                let Some(full_url) = url::Url::parse(url)
                    .ok()
                    .and_then(|base| base.join(src).ok())
                    .map(|u| u.to_string())
                else {
                    continue;
                };
                let hdrs = crate::net::headers::nav_headers_subresource(
                    client.profile(),
                    &full_url,
                    url,
                    "script",
                    false,
                );
                match client.get_with_exact_headers(&full_url, &hdrs).await {
                    Ok(resp) if resp.ok() => {
                        let text = resp.text();
                        if text.trim_start().starts_with("<!") {
                            continue;
                        }
                        text
                    }
                    _ => continue,
                }
            } else {
                script.code.clone()
            };

            if code.trim().is_empty() {
                continue;
            }
            // W2.7 — name scripts by their actual URL (external src or
            // the iframe document URL for inline). Chrome stack frames
            // are URL-tagged, not anonymous.
            let name = if let Some(src) = &script.src {
                src.clone()
            } else {
                url.to_string()
            };
            if let Err(e) = event_loop.execute_script_with_name(&code, &name) {
                tracing::warn!(script_index = i, error = %e, "iframe script error");
            }
        }

        // The child document's own lifecycle. Only the top-level page advanced
        // `readyState` and fired `DOMContentLoaded`/`load`; a framed document sat
        // at `loading` forever, so anything inside it written as
        //
        //     if (document.readyState === 'loading')
        //         document.addEventListener('DOMContentLoaded', init)
        //
        // registered `init` and waited for an event that never came. Measured on
        // Epic's login: hCaptcha's 605 KB frame bundle executed fine and then
        // rendered nothing at all, leaving an empty widget container.
        //
        // Same spec order as the page path: `interactive` before
        // DOMContentLoaded, `complete` before `load`, both from a task so the
        // handlers run inside the event loop rather than during setup.
        const NS: &str = "(function(){try{var s=Object.getOwnPropertySymbols(globalThis,1);for(var i=0;i<s.length;i++){var v=globalThis[s[i]];if(v&&v.__bo)return v;}}catch(e){}return null;})()";
        event_loop
            .execute_script(&format!(
                "setTimeout(function(){{\
                   var b=(({NS}||{{}}).host||{{}}).bo;\
                   if(b)b.__documentReadyState='interactive';\
                   (function(){{var ns=null;try{{var y=Object.getOwnPropertySymbols(globalThis,1);for(var i=0;i<y.length;i++){{var v=globalThis[y[i]];if(v&&v.__bo){{ns=v;break;}}}}}}catch(e){{}}try{{if(ns&&ns.images)ns.images.scan();}}catch(e){{}}}})();\
                   document.dispatchEvent(new Event('DOMContentLoaded',{{bubbles:true}}));\
                   globalThis.dispatchEvent(new Event('DOMContentLoaded',{{bubbles:true}}));\
                   if(b)b.__documentReadyState='complete';\
                   globalThis.dispatchEvent(new Event('load'));\
                 }},0);"
            ))
            .ok();

        // Run child event loop (shorter timeout for iframes)
        event_loop.run_until_idle(Duration::from_secs(10)).await?;

        Ok(Self {
            node_id,
            generation: next_frame_generation(),
            children: Vec::new(),
            event_loop,
            source: url.to_string(),
            origin: origin_of(url),
            parent_realm: 0,
            base_url: url.to_string(),
            frame_box: None,
        })
    }

    /// Evaluate JS in the child's V8 context.
    pub fn evaluate(&mut self, js: &str) -> Result<String, deno_core::error::AnyError> {
        self.event_loop.execute_script(js)
    }

    /// Evaluate engine-side code with this frame realm's privileged
    /// capabilities; see [`crate::Page::evaluate_privileged`].
    pub fn evaluate_privileged(
        &mut self,
        source: &str,
    ) -> Result<String, deno_core::error::AnyError> {
        self.event_loop.runtime_mut().call_privileged(source)
    }

    /// Query the child's DOM for text content of a selector match.
    pub fn query_text(&mut self, selector: &str) -> Option<String> {
        self.evaluate(&format!(
            r#"(() => {{ const el = document.querySelector("{}"); return el ? el.textContent : ""; }})()"#,
            selector.replace('"', "\\\"")
        )).ok().filter(|s| !s.is_empty())
    }
}

/// Find all `<iframe>` elements in the DOM.
pub fn find_iframes(dom: &Dom) -> Vec<IframeInfo> {
    let mut iframes = Vec::new();
    collect_iframes(dom, NodeId::DOCUMENT, &mut iframes);
    iframes
}

fn collect_iframes(dom: &Dom, node_id: NodeId, iframes: &mut Vec<IframeInfo>) {
    let children = dom.children(node_id);
    for child_id in children {
        if let Some(node) = dom.get(child_id) {
            if let NodeData::Element(elem) = &node.data {
                if elem.name.local.eq_ignore_ascii_case("iframe") {
                    let srcdoc = elem
                        .attrs
                        .iter()
                        .find(|a| a.name.local == "srcdoc")
                        .map(|a| a.value.clone());
                    let src = elem
                        .attrs
                        .iter()
                        .find(|a| a.name.local == "src")
                        .map(|a| a.value.clone());
                    iframes.push(IframeInfo {
                        node_id: child_id,
                        srcdoc,
                        src,
                    });
                }
            }
            collect_iframes(dom, child_id, iframes);
        }
    }
}
