//! Engine-privileged capabilities, held on the Rust side.
//!
//! Some engine code has to do what page code must never be able to: mint
//! `isTrusted` on a synthesized event, reach the Rust behaviour generators
//! after `Deno` is gone, drive the humanized-input routines, give an
//! `about:srcdoc` document its parent's origin. The bootstraps create those
//! capabilities, but anything they leave on a JS object is reachable by the
//! page: the engine namespace hides from `Object.getOwnPropertySymbols(window)`
//! only when it is called with one argument, and any script can pass two.
//! Parking a minter there — or handing one out per navigation from there —
//! is a minter the page can take.
//!
//! So the capabilities never stay on a JS object. [`capture`] lifts them off
//! the namespace into a `v8::Global` right after the bootstraps finish, before
//! any caller-supplied or page script has run, and they are only ever handed to
//! engine code as an argument: [`call`] compiles a function expression and
//! invokes it with the capability object. A warm navigation reuses the same
//! isolate and the same capabilities, so nothing needs re-arming — the old
//! single-use capture-and-delete handles fell back to untrusted events from the
//! second navigation on.

use deno_core::error::AnyError;
use deno_core::v8;
use deno_core::JsRuntime;

/// The humanized-input installer: a function expression taking the capability
/// object and returning the input API (or nothing when the document has no
/// body yet).
pub(crate) const HUMANIZE_JS: &str = include_str!("../js/humanize.js");

/// Lifts the bootstraps' capabilities off the namespace. Runs before any
/// non-engine script, so the lookup with the revealing second argument is
/// still the engine talking to itself.
const CAPTURE_JS: &str = r#"(function () {
    var ns = null;
    try {
        var s = Object.getOwnPropertySymbols(globalThis, 1);
        for (var i = 0; i < s.length; i++) {
            var v = globalThis[s[i]];
            if (v && v.__bo) { ns = v; break; }
        }
    } catch (e) {}
    var caps = Object.create(null);
    if (!ns) return caps;
    var names = ['markTrusted', 'inputApi', 'inheritOrigin'];
    for (var j = 0; j < names.length; j++) {
        var n = names[j];
        if (Object.prototype.hasOwnProperty.call(ns, n)) {
            caps[n] = ns[n];
            try { delete ns[n]; } catch (e) {}
        }
    }
    return caps;
})()"#;

/// The capability object, stored in `OpState` for the runtime's lifetime.
struct Capabilities(v8::Global<v8::Object>);

/// Where a privileged call's promise stands.
pub(crate) enum Settled {
    Pending,
    Fulfilled(String),
    Rejected(String),
}

/// Take the bootstrap capabilities off the namespace and keep them in Rust.
///
/// Must run after the last bootstrap (and cleanup) and before any init or page
/// script. Harmless to call on a realm that published none — a worker, say —
/// where it only makes sure nothing is left behind.
pub(crate) fn capture(runtime: &mut JsRuntime) {
    let caps = {
        let ctx = runtime.main_context();
        v8::scope_with_context!(scope, runtime.v8_isolate(), ctx);
        let Some(caps) = capture_in(scope) else {
            return;
        };
        caps
    };
    runtime.op_state().borrow_mut().put(Capabilities(caps));
}

/// [`capture`] for the context `scope` is in, returning the capability object
/// instead of storing it — a frame realm keeps its own (see `realms`).
pub(crate) fn capture_in(scope: &mut v8::PinScope) -> Option<v8::Global<v8::Object>> {
    let src = v8::String::new(scope, CAPTURE_JS)?;
    let value = v8::Script::compile(scope, src, None).and_then(|s| s.run(scope))?;
    let obj = v8::Local::<v8::Object>::try_from(value).ok()?;
    Some(v8::Global::new(scope, obj))
}

/// Compile `source` — which must evaluate to a function — and call it with the
/// capability object as its only argument. Returns the call's result.
///
/// The function is engine code; nothing reachable from the page is involved in
/// getting the capabilities to it.
pub(crate) fn call(
    runtime: &mut JsRuntime,
    source: &str,
) -> Result<v8::Global<v8::Value>, AnyError> {
    let caps = runtime
        .op_state()
        .borrow()
        .try_borrow::<Capabilities>()
        .map(|c| c.0.clone());
    let ctx = runtime.main_context();
    v8::scope_with_context!(scope, runtime.v8_isolate(), ctx);
    let caps: v8::Local<v8::Value> = match caps.as_ref() {
        Some(g) => v8::Local::new(scope, g).into(),
        // A runtime that never captured (none should exist) still gets an
        // object, so engine code can test for a capability instead of
        // crashing on `undefined`.
        None => v8::Object::new(scope).into(),
    };
    v8::tc_scope!(let tc, scope);
    macro_rules! fail {
        ($what:expr) => {{
            let msg = match tc.exception() {
                Some(exc) => exc
                    .to_string(tc)
                    .map(|s| s.to_rust_string_lossy(tc))
                    .unwrap_or_default(),
                None => $what.to_string(),
            };
            return Err(AnyError::msg(msg));
        }};
    }
    let src =
        v8::String::new(tc, source).ok_or_else(|| AnyError::msg("failed to create V8 string"))?;
    let Some(script) = v8::Script::compile(tc, src, None) else {
        fail!("privileged script compilation failed")
    };
    let Some(value) = script.run(tc) else {
        fail!("privileged script failed")
    };
    let func = v8::Local::<v8::Function>::try_from(value)
        .map_err(|_| AnyError::msg("privileged source must evaluate to a function"))?;
    let recv: v8::Local<v8::Value> = v8::undefined(tc).into();
    let Some(out) = func.call(tc, recv, &[caps]) else {
        fail!("privileged call threw")
    };
    Ok(v8::Global::new(tc, out))
}

/// [`call`], stringified the way `execute_script` stringifies.
pub(crate) fn call_to_string(runtime: &mut JsRuntime, source: &str) -> Result<String, AnyError> {
    let out = call(runtime, source)?;
    Ok(stringify(runtime, &out))
}

fn stringify(runtime: &mut JsRuntime, value: &v8::Global<v8::Value>) -> String {
    let ctx = runtime.main_context();
    v8::scope_with_context!(scope, runtime.v8_isolate(), ctx);
    let local = v8::Local::new(scope, value);
    local
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_default()
}

/// Whether `value` (a privileged call's result) has settled. A non-promise is
/// settled from the start.
pub(crate) fn settled(runtime: &mut JsRuntime, value: &v8::Global<v8::Value>) -> Settled {
    let ctx = runtime.main_context();
    v8::scope_with_context!(scope, runtime.v8_isolate(), ctx);
    let local = v8::Local::new(scope, value);
    let Ok(promise) = v8::Local::<v8::Promise>::try_from(local) else {
        return Settled::Fulfilled(text(scope, local));
    };
    match promise.state() {
        v8::PromiseState::Pending => Settled::Pending,
        v8::PromiseState::Fulfilled => {
            let r = promise.result(scope);
            Settled::Fulfilled(text(scope, r))
        }
        v8::PromiseState::Rejected => {
            let r = promise.result(scope);
            // An Error's message, not its `Error: …` rendering — the form the
            // humanized-input results have always been reported in.
            if let Ok(obj) = v8::Local::<v8::Object>::try_from(r) {
                if let Some(key) = v8::String::new(scope, "message") {
                    if let Some(m) = obj.get(scope, key.into()) {
                        if m.is_string() {
                            return Settled::Rejected(text(scope, m));
                        }
                    }
                }
            }
            Settled::Rejected(text(scope, r))
        }
    }
}

fn text(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> String {
    value
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_default()
}

/// Install the humanized-input routines, once per document.
///
/// Returns `Ok(true)` when this call installed them, `Ok(false)` when they
/// already were (or the document has no body to install into yet).
pub(crate) fn install_humanize(runtime: &mut JsRuntime) -> Result<bool, AnyError> {
    let installer = HUMANIZE_JS.trim_end().trim_end_matches(';');
    let js = format!(
        "(function (caps) {{\n\
           if (caps.human) return false;\n\
           var h = ({installer}\n)(caps);\n\
           if (!h || typeof h !== 'object') return false;\n\
           caps.human = h;\n\
           return true;\n\
         }})"
    );
    Ok(call_to_string(runtime, &js)? == "true")
}

/// Forget the current document's humanized-input routines so the next
/// document installs its own. Their timers belong to the old document and are
/// cancelled with it.
pub(crate) fn reset_humanize(runtime: &mut JsRuntime) {
    let _ = call(runtime, "(function (caps) { delete caps.human; })");
}

/// Run one caller-supplied init script. The humanized-input installer is
/// recognised by content and routed through [`install_humanize`]: it is the
/// one init script that takes capabilities, and callers have always passed it
/// as plain source.
pub(crate) fn run_init_script(runtime: &mut JsRuntime, code: &str) -> Result<(), AnyError> {
    if code == HUMANIZE_JS {
        install_humanize(runtime).map(|_| ())
    } else {
        runtime
            .execute_script("<anonymous>", code.to_string())
            .map(|_| ())
            .map_err(|e| AnyError::msg(e.to_string()))
    }
}
