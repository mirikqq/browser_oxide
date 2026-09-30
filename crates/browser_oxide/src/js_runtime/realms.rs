//! Frames as realms of one isolate (F4).
//!
//! A same-origin frame belongs in its embedder's isolate: its window is
//! reachable synchronously (`iframe.contentWindow.foo`, `contentDocument`),
//! exactly as in Chrome, where same-origin frames share an agent. A separate
//! isolate per frame (`ChildIframe`) cannot give that, and the thin
//! `contentWindow` realm the parent used to build for it was not a document —
//! it ran the frame's scripts a second time instead.
//!
//! A frame realm here is a full document: a `v8::Context` in the page's
//! isolate that runs the same bootstraps as the page and owns its own
//! [`DomState`]. The ops are shared, so which `DomState` they see has to
//! follow the calling realm: every realm gets its own `Deno.core.ops`, each op
//! wrapped to switch the active document first (`js/realm_prelude.js`), and
//! [`op_realm_switch`] swaps the realm's `DomState` into `OpState`. Everything
//! that reads `DomState` — ops and engine code alike — therefore keeps reading
//! "the" `DomState`; the engine puts the page's own back before it reads
//! (`BrowserJsRuntime::activate_realm(0)`).
//!
//! Realm 0 is the page itself. A frame realm is created with the initial
//! `about:blank` document — on first `contentWindow` access, or when the host
//! loads the frame — and loading the frame's real document replaces the
//! document while keeping the `Window`, as the HTML spec does for a
//! navigation away from the initial `about:blank` to a same-origin document.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use deno_core::error::AnyError;
use deno_core::op2;
use deno_core::v8;
use deno_core::JsRuntime;
use deno_core::OpState;

use crate::dom::Dom;
use crate::js_runtime::state::DomState;

/// The bootstraps a frame realm runs — the page's own, in the same order.
const BOOTSTRAP_JS: &str = crate::js_runtime::runtime::window_bootstrap_js!();
const CLEANUP_JS: &str = include_str!("js/cleanup_bootstrap.js");

/// An initial `about:blank` document.
const BLANK_HTML: &str = "<html><head></head><body></body></html>";

/// What the main realm's prelude handed over: the raw ops, the switch, the
/// shared active-realm record and the source of the per-realm wrapper — plus
/// the page's own context, so realms can be built from inside an op.
pub(crate) struct RealmSeed {
    raw: v8::Global<v8::Object>,
    switch: v8::Global<v8::Value>,
    state: v8::Global<v8::Object>,
    core: v8::Global<v8::Object>,
    make_ops_src: String,
    main: v8::Global<v8::Context>,
}

/// One frame realm.
pub(crate) struct FrameRealm {
    pub(crate) context: v8::Global<v8::Context>,
    pub(crate) global: v8::Global<v8::Object>,
    /// The realm whose document holds the frame's `<iframe>`.
    pub(crate) parent: u32,
    /// That `<iframe>`'s node id, in the parent's document.
    pub(crate) node: u32,
    /// The realm's privileged capabilities (see `privileged`), lifted off its
    /// namespace like the page's.
    pub(crate) caps: Option<v8::Global<v8::Object>>,
    /// What the loaded document came from (`srcdoc` text or URL); `None`
    /// while the initial `about:blank` is all it holds.
    pub(crate) source: Option<String>,
}

/// The documents of every realm but the active one, and which is active.
#[derive(Default)]
pub(crate) struct RealmDocs {
    docs: HashMap<u32, DomState>,
    realms: HashMap<u32, FrameRealm>,
    active: u32,
    next: u32,
    /// Frame realms whose document asked to navigate (`location.href = …`,
    /// a form, a meta refresh). The page loads the new document into the
    /// frame when it next settles its frames.
    navigating: std::collections::BTreeSet<u32>,
}

impl RealmDocs {
    pub(crate) fn realm(&self, id: u32) -> Option<&FrameRealm> {
        self.realms.get(&id)
    }

    pub(crate) fn realm_mut(&mut self, id: u32) -> Option<&mut FrameRealm> {
        self.realms.get_mut(&id)
    }

    /// Every frame realm, as `(id, parent, node)`.
    pub(crate) fn frames(&self) -> Vec<(u32, u32, u32)> {
        let mut out: Vec<_> = self
            .realms
            .iter()
            .map(|(id, r)| (*id, r.parent, r.node))
            .collect();
        out.sort_unstable();
        out
    }

    /// The frame realm for `node` in realm `parent`'s document.
    pub(crate) fn frame_for(&self, parent: u32, node: u32) -> Option<u32> {
        self.realms
            .iter()
            .find(|(_, r)| r.parent == parent && r.node == node)
            .map(|(id, _)| *id)
    }
}

/// The page's storage areas, wherever the page's document currently is
/// (in `OpState`, or parked while a frame realm's is active).
pub(crate) fn page_storage(state: &mut OpState) -> &mut HashMap<String, HashMap<String, String>> {
    let parked = state
        .try_borrow::<RealmDocs>()
        .is_some_and(|d| d.active != 0 && d.docs.contains_key(&0));
    if parked {
        &mut state
            .borrow_mut::<RealmDocs>()
            .docs
            .get_mut(&0)
            .expect("checked above")
            .storage
    } else {
        &mut state.borrow_mut::<DomState>().storage
    }
}

/// Record a navigation request from the active document if it is a frame
/// realm's; `false` for the page's own, which navigates the page.
pub(crate) fn note_frame_navigation(state: &mut OpState) -> bool {
    match state.try_borrow_mut::<RealmDocs>() {
        Some(docs) if docs.active != 0 => {
            let id = docs.active;
            docs.navigating.insert(id);
            true
        }
        _ => false,
    }
}

/// Drop realm `id`'s pending navigation request (its document just loaded).
pub(crate) fn forget_frame_navigation(op_state: &Rc<RefCell<OpState>>, id: u32) {
    if let Some(d) = op_state.borrow_mut().try_borrow_mut::<RealmDocs>() {
        d.navigating.remove(&id);
    }
}

/// Frame realms that asked to navigate since the last call.
pub(crate) fn take_frame_navigations(op_state: &Rc<RefCell<OpState>>) -> Vec<u32> {
    op_state
        .borrow_mut()
        .try_borrow_mut::<RealmDocs>()
        .map(|d| std::mem::take(&mut d.navigating).into_iter().collect())
        .unwrap_or_default()
}

/// Make realm `id`'s document the one in `OpState`. Unknown ids (a realm that
/// was destroyed) leave the current document in place and return `false`.
fn swap_in(state: &mut OpState, id: u32) -> bool {
    let Some(docs) = state.try_borrow_mut::<RealmDocs>() else {
        return id == 0;
    };
    if docs.active == id {
        return true;
    }
    let Some(target) = docs.docs.remove(&id) else {
        return false;
    };
    let previous = docs.active;
    docs.active = id;
    let current = state.take::<DomState>();
    state
        .borrow_mut::<RealmDocs>()
        .docs
        .insert(previous, current);
    state.put(target);
    true
}

/// Switch the document the ops act on to realm `id`'s. Called by the per-realm
/// op wrappers only; see the module docs. `false` for a realm that no longer
/// exists — its wrappers then do nothing rather than act on another document.
#[op2(fast)]
pub fn op_realm_switch(state: &mut OpState, #[smi] id: u32) -> bool {
    swap_in(state, id)
}

fn field<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    obj: v8::Local<'s, v8::Object>,
    name: &str,
) -> Option<v8::Local<'s, v8::Value>> {
    let k = v8::String::new(scope, name)?;
    obj.get(scope, k.into())
}

/// Take the prelude's hand-off (`__boRealmSeed`) into Rust and delete it. Runs
/// after the bootstraps and before cleanup and any page script.
pub(crate) fn capture_seed(runtime: &mut JsRuntime) {
    let seed = {
        let ctx = runtime.main_context();
        v8::scope_with_context!(scope, runtime.v8_isolate(), ctx);
        let main = scope.get_current_context();
        let global = main.global(scope);
        let Some(key) = v8::String::new(scope, "__boRealmSeed") else {
            return;
        };
        let Some(value) = global.get(scope, key.into()) else {
            return;
        };
        global.delete(scope, key.into());
        let Ok(obj) = v8::Local::<v8::Object>::try_from(value) else {
            return;
        };
        let (Some(raw), Some(sw), Some(st), Some(core), Some(src)) = (
            field(scope, obj, "raw"),
            field(scope, obj, "sw"),
            field(scope, obj, "state"),
            field(scope, obj, "core"),
            field(scope, obj, "makeRealmOps"),
        ) else {
            return;
        };
        let (Ok(raw), Ok(st), Ok(core)) = (
            v8::Local::<v8::Object>::try_from(raw),
            v8::Local::<v8::Object>::try_from(st),
            v8::Local::<v8::Object>::try_from(core),
        ) else {
            return;
        };
        RealmSeed {
            raw: v8::Global::new(scope, raw),
            switch: v8::Global::new(scope, sw),
            state: v8::Global::new(scope, st),
            core: v8::Global::new(scope, core),
            make_ops_src: src.to_rust_string_lossy(scope),
            main: v8::Global::new(scope, main),
        }
    };
    let op_state = runtime.op_state();
    let mut op_state = op_state.borrow_mut();
    op_state.put(seed);
    op_state.put(RealmDocs {
        next: 1,
        ..Default::default()
    });
}

/// Which realm's document is active.
pub(crate) fn active(op_state: &Rc<RefCell<OpState>>) -> u32 {
    op_state
        .borrow()
        .try_borrow::<RealmDocs>()
        .map_or(0, |docs| docs.active)
}

/// Make realm `id`'s document the active one, and tell the JS side. `false`
/// when there is no such realm.
pub(crate) fn activate_in(
    scope: &mut v8::PinScope,
    op_state: &Rc<RefCell<OpState>>,
    id: u32,
) -> bool {
    let (swapped, state) = {
        let mut op_state = op_state.borrow_mut();
        let already = op_state
            .try_borrow::<RealmDocs>()
            .is_none_or(|docs| docs.active == id);
        if already {
            return true;
        }
        let swapped = swap_in(&mut op_state, id);
        let state = op_state
            .try_borrow::<RealmSeed>()
            .map(|seed| seed.state.clone());
        (swapped, state)
    };
    if swapped {
        if let Some(state) = state {
            let state = v8::Local::new(scope, &state);
            if let Some(key) = v8::String::new(scope, "active") {
                let v = v8::Integer::new_from_unsigned(scope, id);
                state.set(scope, key.into(), v.into());
            }
        }
    }
    swapped
}

/// [`activate_in`] from outside any scope.
pub(crate) fn activate(runtime: &mut JsRuntime, id: u32) -> bool {
    let op_state = runtime.op_state();
    if active(&op_state) == id {
        return true;
    }
    let ctx = runtime.main_context();
    v8::scope_with_context!(scope, runtime.v8_isolate(), ctx);
    activate_in(scope, &op_state, id)
}

/// Build a frame realm for the `<iframe>` `node` in realm `parent`'s document,
/// holding `dom` (the initial `about:blank` when `None`): a new context in
/// this isolate, same-origin with the page, running the page's bootstraps
/// against its own document. `origin` is the origin it inherits. Returns the
/// realm's id; the active document is `parent`'s again on return.
pub(crate) fn create_in(
    scope: &mut v8::PinScope,
    op_state: &Rc<RefCell<OpState>>,
    parent: u32,
    node: u32,
    dom: Option<Dom>,
    stylesheets: Vec<String>,
    origin: &str,
) -> Result<u32, AnyError> {
    let (id, raw, sw, state, core, src, orig_fpt, tag) = {
        let mut op_state = op_state.borrow_mut();
        if !op_state.has::<RealmSeed>() {
            return Err(AnyError::msg("this runtime has no realm support"));
        }
        let profile = op_state
            .try_borrow::<DomState>()
            .and_then(|d| d.stealth_profile.clone());
        let docs = op_state.borrow_mut::<RealmDocs>();
        let id = docs.next;
        docs.next += 1;
        let mut doc =
            DomState::new(dom.unwrap_or_else(|| crate::html_parser::parse_html(BLANK_HTML)));
        doc.stylesheets = stylesheets;
        doc.stealth_profile = profile;
        doc.update_cached_rules();
        docs.docs.insert(id, doc);
        let seed = op_state.borrow::<RealmSeed>();
        let store = op_state.try_borrow::<crate::js_runtime::native_fns::IframeRealmStore>();
        (
            id,
            seed.raw.clone(),
            seed.switch.clone(),
            seed.state.clone(),
            seed.core.clone(),
            seed.make_ops_src.clone(),
            store.and_then(|s| s.orig_fp_tostring.clone()),
            store.and_then(|s| s.native_tag_sym.clone()),
        )
    };

    let built = (|| -> Result<(v8::Global<v8::Context>, v8::Global<v8::Object>), AnyError> {
        // The context, with the page's security token (same origin), a `Deno`
        // whose ops are this realm's, and nothing else yet.
        let token = scope.get_current_context().get_security_token(scope);
        let ctx = v8::Context::new(scope, v8::ContextOptions::default());
        ctx.set_security_token(token);
        let cs = &mut v8::ContextScope::new(scope, ctx);
        let global = ctx.global(cs);
        let source = v8::String::new(cs, &format!("({src})"))
            .ok_or_else(|| AnyError::msg("realm ops source"))?;
        let make = v8::Script::compile(cs, source, None)
            .and_then(|s| s.run(cs))
            .and_then(|f| v8::Local::<v8::Function>::try_from(f).ok())
            .ok_or_else(|| AnyError::msg("realm ops wrapper did not compile"))?;
        let raw = v8::Local::new(cs, &raw);
        let sw = v8::Local::new(cs, &sw);
        let state = v8::Local::new(cs, &state);
        let rid = v8::Integer::new_from_unsigned(cs, id);
        let undef = v8::undefined(cs).into();
        let ops = make
            .call(cs, undef, &[raw.into(), sw, state.into(), rid.into()])
            .ok_or_else(|| AnyError::msg("realm ops wrapper threw"))?;
        let core_proto = v8::Local::new(cs, &core);
        let shim_core = v8::Object::new(cs);
        shim_core.set_prototype(cs, core_proto.into());
        // An own data property: `ops` is read-only on the frozen core it
        // inherits from, and a plain assignment would be silently ignored.
        let k_ops = v8::String::new(cs, "ops").unwrap();
        shim_core.create_data_property(cs, k_ops.into(), ops);
        let deno = v8::Object::new(cs);
        let k_core = v8::String::new(cs, "core").unwrap();
        deno.set(cs, k_core.into(), shim_core.into());
        let k_deno = v8::String::new(cs, "Deno").unwrap();
        global.set(cs, k_deno.into(), deno.into());
        Ok((v8::Global::new(cs, ctx), v8::Global::new(cs, global)))
    })();
    let (context, global) = match built {
        Ok(b) => b,
        Err(e) => {
            op_state
                .borrow_mut()
                .borrow_mut::<RealmDocs>()
                .docs
                .remove(&id);
            return Err(e);
        }
    };

    activate_in(scope, op_state, id);
    let ran = run_in_scope(scope, &context, BOOTSTRAP_JS, "<anonymous>")
        .and_then(|_| run_in_scope(scope, &context, CLEANUP_JS, "<anonymous>"));
    let caps = {
        let ctx = v8::Local::new(scope, &context);
        let cs = &mut v8::ContextScope::new(scope, ctx);
        if let Some(orig) = orig_fpt.as_ref() {
            crate::js_runtime::native_fns::install_native_fp_tostring(cs, orig, tag.as_ref());
        }
        crate::js_runtime::privileged::capture_in(cs)
    };
    activate_in(scope, op_state, parent);
    if let Err(e) = ran {
        let mut s = op_state.borrow_mut();
        s.borrow_mut::<RealmDocs>().docs.remove(&id);
        return Err(e);
    }
    op_state
        .borrow_mut()
        .borrow_mut::<RealmDocs>()
        .realms
        .insert(
            id,
            FrameRealm {
                context,
                global,
                parent,
                node,
                caps,
                source: None,
            },
        );
    link_frame(scope, op_state, id, origin)?;
    // Seeding `location` with `about:blank` was setup, not a navigation.
    forget_frame_navigation(op_state, id);
    Ok(id)
}

/// Point a new frame realm at its embedder: `parent`/`top` are the parent
/// realm's `parent`/`top` chain, `frameElement` is the `<iframe>`, and an
/// `about:blank` document inherits `origin`.
fn link_frame(
    scope: &mut v8::PinScope,
    op_state: &Rc<RefCell<OpState>>,
    id: u32,
    origin: &str,
) -> Result<(), AnyError> {
    let (context, parent_global, caps) = {
        let s = op_state.borrow();
        let docs = s.borrow::<RealmDocs>();
        let realm = docs
            .realm(id)
            .ok_or_else(|| AnyError::msg("no such realm"))?;
        let parent_global = if realm.parent == 0 {
            let seed = s.borrow::<RealmSeed>();
            let main = v8::Local::new(scope, &seed.main);
            v8::Global::new(scope, main.global(scope))
        } else {
            docs.realm(realm.parent)
                .map(|p| p.global.clone())
                .ok_or_else(|| AnyError::msg("parent realm is gone"))?
        };
        (realm.context.clone(), parent_global, realm.caps.clone())
    };
    let node = op_state
        .borrow()
        .borrow::<RealmDocs>()
        .realm(id)
        .map_or(0, |r| r.node);
    let parent_realm = op_state
        .borrow()
        .borrow::<RealmDocs>()
        .realm(id)
        .map_or(0, |r| r.parent);
    // The `<iframe>` wrapper lives in the parent realm; ask it for one.
    let element = {
        let parent_ctx = context_of(scope, op_state, parent_realm);
        match parent_ctx {
            Some(pctx) => {
                activate_in(scope, op_state, parent_realm);
                let el = run_value_in(
                    scope,
                    &pctx,
                    &format!(
                        "(function(){{try{{var s=Object.getOwnPropertySymbols(globalThis,1);\
                         for(var i=0;i<s.length;i++){{var v=globalThis[s[i]];\
                         if(v&&v.__bo&&v.frames&&v.frames.elementForNode)return v.frames.elementForNode({node});}}}}\
                         catch(e){{}}return null;}})()"
                    ),
                );
                el
            }
            None => None,
        }
    };
    activate_in(scope, op_state, id);
    let ctx = v8::Local::new(scope, &context);
    let cs = &mut v8::ContextScope::new(scope, ctx);
    let setup = v8::String::new(cs, LINK_FRAME_JS).unwrap();
    let f = v8::Script::compile(cs, setup, None)
        .and_then(|s| s.run(cs))
        .and_then(|f| v8::Local::<v8::Function>::try_from(f).ok())
        .ok_or_else(|| AnyError::msg("frame link script"))?;
    let parent_global: v8::Local<v8::Value> = v8::Local::new(cs, &parent_global).into();
    let element: v8::Local<v8::Value> = match element {
        Some(e) => v8::Local::new(cs, &e),
        None => v8::null(cs).into(),
    };
    let caps: v8::Local<v8::Value> = match caps {
        Some(c) => v8::Local::new(cs, &c).into(),
        None => v8::Object::new(cs).into(),
    };
    let origin = v8::String::new(cs, origin).unwrap().into();
    let undef = v8::undefined(cs).into();
    f.call(cs, undef, &[parent_global, element, caps, origin]);
    activate_in(cs, op_state, parent_realm);
    Ok(())
}

/// Wires a frame realm to its embedder; see [`link_frame`].
const LINK_FRAME_JS: &str = r#"(function (parentWin, frameEl, caps, origin) {
    var ns = null;
    try {
        var s = Object.getOwnPropertySymbols(globalThis, 1);
        for (var i = 0; i < s.length; i++) { var v = globalThis[s[i]]; if (v && v.__bo) { ns = v; break; } }
    } catch (e) {}
    var top = parentWin;
    try { top = parentWin.top || parentWin; } catch (e) {}
    if (ns && typeof ns.setFrameLinks === 'function') {
        ns.setFrameLinks(parentWin, top);
        try { delete ns.setFrameLinks; } catch (e) {}
    }
    try {
        var get = Object.getOwnPropertyDescriptor({ get frameElement() { return frameEl; } }, 'frameElement').get;
        Object.defineProperty(globalThis, 'frameElement', { get: get, enumerable: true, configurable: true });
    } catch (e) {}
    try { location.href = 'about:blank'; } catch (e) {}
    if (caps && typeof caps.inheritOrigin === 'function') caps.inheritOrigin(origin);
    // A document is on its way (srcdoc, or a src that is not about:blank):
    // hold messages for it rather than hand them to this about:blank.
    try {
        var src = frameEl ? String(frameEl.getAttribute('src') || '').trim() : '';
        var pending = frameEl && (frameEl.getAttribute('srcdoc') != null
            || (src && src !== 'about:blank' && !/^javascript:/i.test(src)));
        if (pending && ns && typeof ns.awaitDocument === 'function') ns.awaitDocument();
        // The initial about:blank is complete from the start: its `load`
        // fires during the insertion that created it.
        var bo = ns && ns.host && ns.host.bo;
        if (!pending && bo) bo.__documentReadyState = 'complete';
    } catch (e) {}
})"#;

fn context_of(
    scope: &mut v8::PinScope,
    op_state: &Rc<RefCell<OpState>>,
    id: u32,
) -> Option<v8::Global<v8::Context>> {
    let s = op_state.borrow();
    if id == 0 {
        let _ = scope;
        return s.try_borrow::<RealmSeed>().map(|seed| seed.main.clone());
    }
    s.try_borrow::<RealmDocs>()
        .and_then(|d| d.realm(id))
        .map(|r| r.context.clone())
}

/// Compile and run `code` in `context`, stringifying the completion value.
pub(crate) fn run_in_scope(
    scope: &mut v8::PinScope,
    context: &v8::Global<v8::Context>,
    code: &str,
    name: &str,
) -> Result<String, AnyError> {
    let ctx = v8::Local::new(scope, context);
    let cs = &mut v8::ContextScope::new(scope, ctx);
    let source = v8::String::new(cs, code).ok_or_else(|| AnyError::msg("script too large"))?;
    let name = v8::String::new(cs, name).unwrap();
    let origin = v8::ScriptOrigin::new(
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
    );
    v8::tc_scope!(let tc, cs);
    let Some(script) = v8::Script::compile(tc, source, Some(&origin)) else {
        let msg = tc
            .exception()
            .and_then(|e| e.to_string(tc))
            .map(|s| s.to_rust_string_lossy(tc))
            .unwrap_or_else(|| "compile error".into());
        return Err(AnyError::msg(msg));
    };
    match script.run(tc) {
        Some(v) => Ok(v
            .to_string(tc)
            .map(|s| s.to_rust_string_lossy(tc))
            .unwrap_or_default()),
        None => {
            let msg = tc
                .exception()
                .and_then(|e| e.to_string(tc))
                .map(|s| s.to_rust_string_lossy(tc))
                .unwrap_or_else(|| "script failed".into());
            Err(AnyError::msg(msg))
        }
    }
}

fn run_value_in(
    scope: &mut v8::PinScope,
    context: &v8::Global<v8::Context>,
    code: &str,
) -> Option<v8::Global<v8::Value>> {
    let ctx = v8::Local::new(scope, context);
    let cs = &mut v8::ContextScope::new(scope, ctx);
    let source = v8::String::new(cs, code)?;
    let v = v8::Script::compile(cs, source, None)?.run(cs)?;
    Some(v8::Global::new(cs, v))
}

/// Drop realm `id`, every frame realm nested in it, and their documents.
/// Their contexts stay alive as long as something still references them; their
/// op wrappers then find no document and do nothing.
pub(crate) fn destroy_in(scope: &mut v8::PinScope, op_state: &Rc<RefCell<OpState>>, id: u32) {
    if id == 0 {
        return;
    }
    activate_in(scope, op_state, 0);
    let mut s = op_state.borrow_mut();
    let Some(docs) = s.try_borrow_mut::<RealmDocs>() else {
        return;
    };
    let mut doomed = vec![id];
    let mut i = 0;
    while i < doomed.len() {
        let p = doomed[i];
        doomed.extend(
            docs.realms
                .iter()
                .filter(|(_, r)| r.parent == p)
                .map(|(c, _)| *c),
        );
        i += 1;
    }
    for d in doomed {
        docs.docs.remove(&d);
        docs.realms.remove(&d);
    }
}

/// The realm whose context `ctx` is; 0 for the page, `None` for any other.
pub(crate) fn realm_of_context(
    scope: &mut v8::PinScope,
    op_state: &Rc<RefCell<OpState>>,
    ctx: v8::Local<v8::Context>,
) -> Option<u32> {
    let s = op_state.borrow();
    if let Some(seed) = s.try_borrow::<RealmSeed>() {
        if v8::Local::new(scope, &seed.main) == ctx {
            return Some(0);
        }
    }
    let docs = s.try_borrow::<RealmDocs>()?;
    docs.realms
        .iter()
        .find(|(_, r)| v8::Local::new(scope, &r.context) == ctx)
        .map(|(id, _)| *id)
}

/// The global of realm `id` (the page's for 0).
pub(crate) fn global_of<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    op_state: &Rc<RefCell<OpState>>,
    id: u32,
) -> Option<v8::Local<'s, v8::Object>> {
    let s = op_state.borrow();
    if id == 0 {
        let seed = s.try_borrow::<RealmSeed>()?;
        let main = v8::Local::new(scope, &seed.main);
        return Some(main.global(scope));
    }
    let docs = s.try_borrow::<RealmDocs>()?;
    docs.realm(id).map(|r| v8::Local::new(scope, &r.global))
}

/// The context of the active frame realm — the document whose code called
/// the op — or `None` when that is the page.
pub(crate) fn active_context(
    scope: &mut v8::PinScope,
    op_state: &Rc<RefCell<OpState>>,
) -> Option<v8::Global<v8::Context>> {
    let id = active(op_state);
    if id == 0 {
        return None;
    }
    context_of(scope, op_state, id)
}

/// The window of the frame realm for `<iframe>` `node` in the calling
/// document, created with the initial `about:blank` on first access.
///
/// Called by `contentWindow`/`contentDocument` for frames the parent decided
/// are same-origin; `origin` is the parent's, which `about:blank` inherits.
/// Re-entrant: building the realm runs its bootstraps, which call ops.
#[op2(reentrant)]
pub fn op_frame_window<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    #[smi] node: u32,
    #[string] origin: String,
) -> v8::Local<'s, v8::Value> {
    let op_state = JsRuntime::op_state_from(scope);
    let parent = active(&op_state);
    let existing = op_state
        .borrow()
        .try_borrow::<RealmDocs>()
        .and_then(|d| d.frame_for(parent, node));
    let id = match existing {
        Some(id) => Some(id),
        None => match create_in(scope, &op_state, parent, node, None, Vec::new(), &origin) {
            Ok(id) => Some(id),
            Err(e) => {
                tracing::warn!(error = %e, "frame realm creation failed");
                None
            }
        },
    };
    activate_in(scope, &op_state, parent);
    match id.and_then(|id| global_of(scope, &op_state, id)) {
        Some(g) => g.into(),
        None => v8::null(scope).into(),
    }
}

/// The window of the realm whose code is running — the page's, a frame
/// realm's, or `null` when it is neither (a separate isolate's never is).
/// What a `postMessage` names as its `source`.
#[op2]
pub fn op_incumbent_window<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Value> {
    let op_state = JsRuntime::op_state_from(scope);
    let ctx = scope.get_entered_or_microtask_context();
    let ctx = v8::Global::new(scope, ctx);
    let ctx = v8::Local::new(scope, &ctx);
    match realm_of_context(scope, &op_state, ctx).and_then(|id| global_of(scope, &op_state, id)) {
        Some(g) => g.into(),
        None => v8::null(scope).into(),
    }
}
