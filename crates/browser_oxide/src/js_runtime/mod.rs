//! V8 JavaScript runtime with DOM bindings for browser_oxide.
//!
//! MIT/Apache-2.0 licensed. Part of the browser_oxide project.

pub mod extensions;
pub mod inspect;
mod intl;
pub mod module_loader;
pub mod native_fns;
pub(crate) mod privileged;
pub(crate) mod realms;
pub mod runtime;
pub mod snapshot;
pub mod state;
pub mod utils;

use crate::dom::Dom;
use crate::stealth::StealthProfile;
use deno_core::v8;
use deno_core::JsRuntime;
use extensions::nav_ext::NavSignal;
use runtime::{create_runtime_with_signals, BrowserRuntimeOptions};
use state::{ConsoleMessage, DomState};

/// Upper bound on how long one `<script type="module">` may take to settle
/// before the document moves on without it.
///
/// Only a module blocked on an unresolved top-level await reaches this; a
/// normal bundle settles in milliseconds. See `eval_module`.
const MODULE_EVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// A V8 JavaScript runtime with browser DOM bindings.
pub struct BrowserJsRuntime {
    inner: JsRuntime,
    /// Attached only when [`inspect::enabled_for_process`] was true at
    /// construction — `RuntimeOptions::inspector` is decided with the isolate and
    /// cannot be turned on afterwards.
    inspector_tap: Option<inspect::InspectorTap>,
    /// Per-runtime navigation-pending signal. JS sets it via
    /// `op_set_pending_nav` (called from window_bootstrap.js whenever
    /// `__pendingNavigation` is assigned). The event loop polls it to
    /// short-circuit `run_until_idle` for fast nav handoff (some sites
    /// expect a navigation to begin within a few seconds).
    nav_signal: NavSignal,
}

/// RAII guard that enters a V8 isolate on creation and exits it on drop,
/// restoring whatever isolate was thread-current before. Required because
/// browser_oxide keeps several `OwnedIsolate`s alive at once (page + per-iframe
/// runtimes) and, under v8-149/deno_core-0.403, the isolate is only
/// auto-entered at construction — so the "current" isolate is just the
/// last-constructed one unless we explicitly re-enter the one we're about to
/// drive. `Isolate::enter`/`exit` nest correctly (V8 saves/restores the
/// previous isolate), so this is safe to use on every entry point even when
/// the isolate already happens to be current.
struct IsolateEnterGuard {
    isolate: *mut v8::Isolate,
}

impl IsolateEnterGuard {
    fn enter(isolate: &mut v8::OwnedIsolate) -> Self {
        let isolate: *mut v8::Isolate = &mut **isolate;
        // SAFETY: `isolate` is a live, valid V8 isolate (owned by `self.inner`,
        // which outlives this guard — the guard is dropped at the end of the
        // calling method, well before the runtime). `enter`/`exit` are balanced
        // by the guard's `Drop`, and V8 restores the previously-entered isolate
        // on exit, so the thread-current isolate is left unchanged on return.
        // We hold a raw pointer (not a borrow) so the caller can still take a
        // fresh `&mut` to build its scope.
        unsafe { (*isolate).enter() };
        Self { isolate }
    }
}

impl Drop for IsolateEnterGuard {
    fn drop(&mut self) {
        // SAFETY: paired with the `enter()` in `IsolateEnterGuard::enter`;
        // `self.isolate` is still alive (the owning runtime outlives the guard).
        unsafe { (*self.isolate).exit() };
    }
}

impl BrowserJsRuntime {
    /// Attach the inspector tap if this process asked for it, then assemble.
    ///
    /// Attaching here rather than in each constructor keeps the decision in one
    /// place: an isolate built without `RuntimeOptions::inspector` has no
    /// inspector to attach to, and that flag is set by the same predicate.
    fn assemble(mut inner: JsRuntime, nav_signal: NavSignal) -> Self {
        let inspector_tap = if inspect::enabled_for_process() {
            Some(inspect::InspectorTap::attach(&mut inner))
        } else {
            None
        };
        Self {
            inner,
            nav_signal,
            inspector_tap,
        }
    }

    /// What V8 reports about the JavaScript this runtime has compiled and run.
    /// `None` when the tap is off.
    pub fn inspect_snapshot(&self) -> Option<inspect::InspectLog> {
        self.inspector_tap.as_ref().map(|t| t.snapshot())
    }

    /// Create a new runtime with the given DOM (no stealth profile).
    pub fn new(dom: Dom) -> Self {
        let (inner, nav_signal) =
            create_runtime_with_signals(dom, BrowserRuntimeOptions::default());
        Self::assemble(inner, nav_signal)
    }

    /// Create with a stealth profile.
    pub fn with_profile(dom: Dom, profile: StealthProfile) -> Self {
        let (inner, nav_signal) = create_runtime_with_signals(
            dom,
            BrowserRuntimeOptions {
                stealth_profile: Some(profile),
                ..Default::default()
            },
        );
        Self::assemble(inner, nav_signal)
    }

    /// Create with full options.
    pub fn with_options(dom: Dom, mut options: BrowserRuntimeOptions) -> Self {
        // TODO(deno-0.403): V8-149 snapshot RESTORE segfaults (deno_core 0.403
        // snapshot deserialize — op external-reference handling). The engine is
        // otherwise fully correct on V8 149; snapshot is DISABLED by default so
        // we run bootstrap fresh (~1.5 s slower cold start, correctness intact).
        // Re-enable with BROWSER_OXIDE_USE_SNAPSHOT=1 to test a fix.
        if std::env::var_os("BROWSER_OXIDE_USE_SNAPSHOT").is_some()
            && options.startup_snapshot.is_none()
        {
            options.startup_snapshot = Some(snapshot::get_snapshot());
        }
        let (inner, nav_signal) = create_runtime_with_signals(dom, options);
        Self::assemble(inner, nav_signal)
    }

    /// Re-apply the profile's timezone and locale to this isolate.
    ///
    /// ICU's defaults are process-wide and set when a runtime is built, so a
    /// runtime that outlives its first document — a pooled page, a warm
    /// navigation — has to set them again before serving the next one: any page
    /// built in between may have moved them. A runtime without a profile has
    /// nothing to assert and is left alone.
    pub fn reapply_profile_intl_defaults(&mut self) {
        let wanted = {
            let op_state = self.inner.op_state();
            let state = op_state.borrow();
            state
                .try_borrow::<extensions::stealth_ext::StealthState>()
                .and_then(|s| s.profile.as_ref())
                .map(|p| (p.timezone.clone(), p.language.clone()))
        };
        if let Some((timezone, locale)) = wanted {
            intl::reapply(
                self.inner.v8_isolate(),
                &intl::IntlDefaults {
                    timezone: &timezone,
                    locale: &locale,
                },
            );
        }
    }

    /// Returns true iff JS has set a pending navigation since the last
    /// reset. Cheap (atomic load); safe to poll from the event loop.
    pub fn nav_pending(&self) -> bool {
        self.nav_signal.pending()
    }

    /// Reset the pending-navigation flag. Called by the event loop after
    /// it has acted on the signal (e.g., before starting a fresh iteration).
    pub fn reset_nav_pending(&self) {
        self.nav_signal.reset();
    }

    /// Get a thread-safe handle to the V8 isolate. Used to call
    /// `terminate_execution()` from a watcher thread when a wall-clock
    /// deadline expires — preempts CPU-bound JS spin loops that
    /// `tokio::time::timeout` cannot interrupt because they never yield
    /// to the tokio scheduler. The returned handle is `Send + Sync`.
    pub fn isolate_handle(&mut self) -> deno_core::v8::IsolateHandle {
        self.inner.v8_isolate().thread_safe_handle()
    }

    /// Cancel a previously-issued `terminate_execution()`. Required if
    /// you want the runtime to be usable for further script execution
    /// after a deadline fired. Without this, the next `execute_script`
    /// returns "Uncaught Error: execution terminated".
    pub fn cancel_terminate_execution(&mut self) {
        self.inner.v8_isolate().cancel_terminate_execution();
    }

    /// V8's `used_heap_size` for this isolate, in bytes.
    ///
    /// Intended for monitoring warm reuse: pair with [`Self::collect_garbage`]
    /// and sample after each navigation. On a healthy pool the value is flat
    /// across navigations; a monotonic climb means something is retaining the
    /// previous page (see `Page::reset_for_reuse`).
    ///
    /// Note this is V8 heap only — it excludes external/`ArrayBuffer` backing
    /// stores and everything Rust-side, so it is not process RSS.
    pub fn v8_heap_used_bytes(&mut self) -> usize {
        self.inner
            .v8_isolate()
            .get_heap_statistics()
            .used_heap_size()
    }

    /// Ask V8 to perform a full garbage collection.
    ///
    /// Only meaningful for measurement: call it before
    /// [`Self::v8_heap_used_bytes`] so the reading reflects *live* (reachable)
    /// objects rather than not-yet-collected garbage. Without it, heap-growth
    /// numbers are dominated by GC scheduling noise. Not a correctness tool —
    /// never call it on a hot path.
    pub fn collect_garbage(&mut self) {
        let _guard = IsolateEnterGuard::enter(self.inner.v8_isolate());
        self.inner.v8_isolate().low_memory_notification();
    }

    /// Execute a JavaScript script and return the string representation of the result.
    ///
    /// Uses V8 directly in a single HandleScope — avoids the overhead of
    /// deno_core's `execute_script` (which allocates a Global handle) and
    /// a second `handle_scope()` call for stringification.
    pub fn execute_script(
        &mut self,
        code: &str,
        name: Option<&str>,
    ) -> Result<String, deno_core::error::AnyError> {
        let __ctx = self.inner.main_context();
        // v8-149 + deno_core 0.403: a V8 isolate is entered (made the
        // thread-current isolate) when its `OwnedIsolate` is constructed and
        // only exited when dropped — the per-call scope macros no longer
        // enter/exit the isolate. browser_oxide runs MULTIPLE live isolates on
        // one thread (the page plus a separate isolate per child iframe; see
        // `crates/browser/src/iframe.rs`). Whichever isolate was constructed
        // most recently is the thread-current one, so calling `execute_script`
        // on a *different* runtime would make `scope_with_context!`'s
        // `ContextScope::new` panic ("… do not belong to the same Isolate").
        // Re-enter this runtime's own isolate for the duration of the call so
        // the scope/context we build always match the thread-current isolate.
        let _isolate_guard = IsolateEnterGuard::enter(self.inner.v8_isolate());
        deno_core::v8::scope_with_context!(scope, self.inner.v8_isolate(), __ctx);
        let source = deno_core::v8::String::new(scope, code)
            .ok_or_else(|| deno_core::error::AnyError::msg("failed to create V8 string"))?;

        let mut script_origin = None;
        if let Some(n) = name {
            let n_v8 = deno_core::v8::String::new(scope, n).unwrap();
            let resource_name = n_v8.into();
            script_origin = Some(deno_core::v8::ScriptOrigin::new(
                scope,
                resource_name,
                0,
                0,
                false,
                0,
                None,
                false,
                false,
                false,
                None,
            ));
        }

        deno_core::v8::tc_scope!(let tc_scope, scope);
        let script = deno_core::v8::Script::compile(tc_scope, source, script_origin.as_ref())
            .ok_or_else(|| {
                let exception = match tc_scope.exception() {
                    Some(exc) => exc,
                    None => return deno_core::error::AnyError::msg("script compilation failed"),
                };
                let msg = exception
                    .to_string(tc_scope)
                    .map(|s| s.to_rust_string_lossy(tc_scope))
                    .unwrap_or_default();
                deno_core::error::AnyError::msg(msg)
            })?;
        match script.run(tc_scope) {
            Some(value) => Ok(value
                .to_string(tc_scope)
                .map(|s| s.to_rust_string_lossy(tc_scope))
                .unwrap_or_default()),
            None => {
                let exception = match tc_scope.exception() {
                    Some(exc) => exc,
                    None => return Err(deno_core::error::AnyError::msg("script execution failed")),
                };
                let msg = exception
                    .to_string(tc_scope)
                    .map(|s| s.to_rust_string_lossy(tc_scope))
                    .unwrap_or_default();
                Err(deno_core::error::AnyError::msg(msg))
            }
        }
    }

    /// Call engine code with the privileged capabilities.
    ///
    /// `source` must evaluate to a function; it is called with one argument,
    /// the capability object — `markTrusted(event)` (mint `isTrusted`),
    /// `inputApi` (the Rust behaviour generators) and, once installed, `human`
    /// (the humanized-input routines). The capabilities are held in Rust and
    /// reach JS only as this argument; no page-reachable object carries them.
    /// Returns the result stringified, like [`Self::execute_script`].
    pub fn call_privileged(&mut self, source: &str) -> Result<String, deno_core::error::AnyError> {
        let _isolate_guard = IsolateEnterGuard::enter(self.inner.v8_isolate());
        privileged::call_to_string(&mut self.inner, source)
    }

    /// [`Self::call_privileged`], keeping the raw result so a returned
    /// promise can be followed with [`Self::privileged_settled`].
    pub(crate) fn start_privileged(
        &mut self,
        source: &str,
    ) -> Result<v8::Global<v8::Value>, deno_core::error::AnyError> {
        let _isolate_guard = IsolateEnterGuard::enter(self.inner.v8_isolate());
        privileged::call(&mut self.inner, source)
    }

    /// Whether a [`Self::start_privileged`] result has settled.
    pub(crate) fn privileged_settled(
        &mut self,
        value: &v8::Global<v8::Value>,
    ) -> privileged::Settled {
        let _isolate_guard = IsolateEnterGuard::enter(self.inner.v8_isolate());
        privileged::settled(&mut self.inner, value)
    }

    /// Install the humanized-input routines into the current document, once.
    /// `Ok(true)` when this call installed them.
    pub fn install_humanize(&mut self) -> Result<bool, deno_core::error::AnyError> {
        let _isolate_guard = IsolateEnterGuard::enter(self.inner.v8_isolate());
        privileged::install_humanize(&mut self.inner)
    }

    /// Drop the current document's humanized-input routines, so the next
    /// document on this (reused) runtime installs its own.
    pub fn reset_humanize(&mut self) {
        let _isolate_guard = IsolateEnterGuard::enter(self.inner.v8_isolate());
        privileged::reset_humanize(&mut self.inner);
    }

    /// Run a caller-supplied init script, routing the humanized-input
    /// installer through [`Self::install_humanize`].
    pub fn run_init_script(&mut self, code: &str) -> Result<(), deno_core::error::AnyError> {
        let _isolate_guard = IsolateEnterGuard::enter(self.inner.v8_isolate());
        privileged::run_init_script(&mut self.inner, code)
    }

    /// Run the V8 event loop until all pending work is done.
    pub async fn run_event_loop(&mut self) -> Result<(), deno_core::error::AnyError> {
        // v8-149: re-enter this runtime's own isolate so driving the event
        // loop (which runs JS, microtasks, and ops that build scopes) targets
        // the correct thread-current isolate even when a child-iframe runtime
        // was constructed more recently and made *its* isolate current. See
        // the long note in `execute_script`. Without this, sites that spawn
        // iframes/workers crash with the scope.rs "not the same Isolate" panic.
        let _isolate_guard = IsolateEnterGuard::enter(self.inner.v8_isolate());
        self.inner
            .run_event_loop(deno_core::PollEventLoopOptions::default())
            .await
            .map_err(|e| deno_core::error::AnyError::msg(e.to_string()))
    }

    /// P2 — load + evaluate an EXTERNAL ES module (`<script type="module" src>`).
    /// The configured `BrowserModuleLoader` fetches the import graph on demand;
    /// we drive the event loop so those async fetches + top-level async work
    /// resolve. Returns Err for the caller to log — a throwing/failing module
    /// must NOT blank the page (matches classic-script handling).
    pub async fn load_eval_module_url(
        &mut self,
        url: &str,
    ) -> Result<(), deno_core::error::AnyError> {
        let spec = deno_core::ModuleSpecifier::parse(url)
            .map_err(|e| deno_core::error::AnyError::msg(format!("module url {url}: {e}")))?;
        // v8-149: see `run_event_loop` — module loading drives V8 and must
        // target this runtime's isolate, not a more-recently-entered child's.
        let _isolate_guard = IsolateEnterGuard::enter(self.inner.v8_isolate());
        let mod_id = self.inner.load_main_es_module(&spec).await?;
        self.eval_module(mod_id).await
    }

    /// P2 — load + evaluate an INLINE ES module. `specifier` must be a unique
    /// URL whose path is the document URL (e.g. `https://site/p#oxide-mod-3`) so
    /// relative `import`s resolve against the document while staying distinct
    /// from other inline modules on the page.
    pub async fn load_eval_module_code(
        &mut self,
        specifier: &str,
        code: String,
    ) -> Result<(), deno_core::error::AnyError> {
        let spec = deno_core::ModuleSpecifier::parse(specifier).map_err(|e| {
            deno_core::error::AnyError::msg(format!("inline module spec {specifier}: {e}"))
        })?;
        // v8-149: see `run_event_loop` — module loading drives V8 and must
        // target this runtime's isolate, not a more-recently-entered child's.
        let _isolate_guard = IsolateEnterGuard::enter(self.inner.v8_isolate());
        // A *side* module, not a main one. deno_core allows exactly one "main"
        // module per runtime, and a document routinely has several
        // `<script type="module">` tags: the second and every one after it failed
        // with `Trying to create "main" module … when one already exists`.
        //
        // The failure was invisible — the error went to `tracing`, which a host
        // with no subscriber drops — so a page's whole application bundle was
        // skipped while the load looked successful. Nothing in a browser
        // distinguishes a document's module scripts this way; none of them is
        // "the" main module.
        let mod_id = self
            .inner
            .load_side_es_module_from_code(&spec, code)
            .await?;
        self.eval_module(mod_id).await
    }

    async fn eval_module(
        &mut self,
        mod_id: deno_core::ModuleId,
    ) -> Result<(), deno_core::error::AnyError> {
        // v8-149: see `run_event_loop` — mod_evaluate + the loop drive run on
        // this runtime's isolate; re-enter it in case a child is current.
        let _isolate_guard = IsolateEnterGuard::enter(self.inner.v8_isolate());
        let eval = self.inner.mod_evaluate(mod_id);

        // Drive the loop so the loader's async fetches and any top-level await
        // resolve — but only until this module's own evaluation settles.
        //
        // `run_event_loop` returns when the loop has *no* pending work left,
        // which is the right shape for a standalone program and the wrong one
        // for a document: a real page always has something pending (timers,
        // polling fetches, our own `humanize.js` interval), so awaiting it
        // parked here until the V8 deadline watcher terminated execution.
        // Measured on a live login page: a 2.8 MB module bundle "executed" for
        // 24.7 s with the process idle in `kevent` the whole time, which put
        // `DOMContentLoaded` past the 15 s watchdogs third-party SDKs arm on
        // themselves. A browser does not wait for the page to go quiet before
        // considering a module script done, and neither do we now.
        let inner = &mut self.inner;
        let mut eval = std::pin::pin!(eval);
        let settled = std::future::poll_fn(|cx| {
            // Ignore the loop's own readiness: it reports "still pending" for
            // work that outlives this module, and its errors surface through
            // the evaluation result.
            let _ = inner.poll_event_loop(cx, deno_core::PollEventLoopOptions::default());
            std::future::Future::poll(eval.as_mut(), cx)
        });

        match tokio::time::timeout(MODULE_EVAL_TIMEOUT, settled).await {
            Ok(result) => result.map_err(|e| deno_core::error::AnyError::msg(e.to_string())),
            Err(_) => {
                // A module whose top-level await never resolves does not block
                // the document in a browser either; leave it running and let
                // later event-loop turns settle it.
                tracing::warn!(
                    timeout_ms = MODULE_EVAL_TIMEOUT.as_millis(),
                    "module evaluation did not settle; continuing"
                );
                Ok(())
            }
        }
    }

    /// Get console output captured so far.
    pub fn console_output(&mut self) -> Vec<ConsoleMessage> {
        let state = self.inner.op_state();
        let state = state.borrow();
        state.borrow::<DomState>().console_output.clone()
    }

    /// Replace the DOM in this runtime with a new one.
    /// Used for CDP Page.navigate to avoid recreating the V8 isolate.
    pub fn replace_dom(&mut self, dom: Dom, stylesheets: Vec<String>, external: Vec<String>) {
        // The outgoing document's frame realms go with it.
        let doomed: Vec<u32> = self
            .frame_realms()
            .into_iter()
            .filter(|(_, parent, _)| *parent == 0)
            .map(|(id, _, _)| id)
            .collect();
        for id in doomed {
            self.destroy_frame_realm(id);
        }
        self.activate_realm(0);
        let state = self.inner.op_state();
        let mut state = state.borrow_mut();
        // Replace DomState — ops will pick up the new DOM on next call
        let mut dom_state = DomState::new(dom);
        dom_state.stylesheets = stylesheets;
        dom_state.external_stylesheets = external;
        dom_state.update_cached_rules();
        state.put(dom_state);
        // Reset timer state (clear pending timers from old page)
        state.put(extensions::timer_ext::TimerState::new());
    }

    /// Take the DOM out of the runtime (consumes self).
    pub fn take_dom(self) -> Dom {
        let state = self.inner.op_state();
        let mut state = state.borrow_mut();
        state.take::<DomState>().dom
    }

    /// Snapshot the current localStorage and sessionStorage contents.
    /// Used by the navigation loop to carry storage across same-origin reloads.
    pub fn get_storage(
        &mut self,
    ) -> std::collections::HashMap<String, std::collections::HashMap<String, String>> {
        let state = self.inner.op_state();
        let state = state.borrow();
        state.borrow::<DomState>().storage.clone()
    }

    /// Get the inner deno_core JsRuntime.
    pub fn inner(&mut self) -> &mut JsRuntime {
        // Engine code reaching past this wrapper reads the page's document.
        self.activate_realm(0);
        &mut self.inner
    }

    /// Get the OpState (shared state).
    pub fn op_state(&mut self) -> std::rc::Rc<std::cell::RefCell<deno_core::OpState>> {
        // `DomState` in here is whichever document ran last; engine code
        // means the page's own (see `realms`).
        self.activate_realm(0);
        self.inner.op_state()
    }

    /// Make frame realm `id`'s document the one `DomState` refers to (0 is the
    /// page). See [`realms`].
    pub(crate) fn activate_realm(&mut self, id: u32) {
        if realms::active(&self.inner.op_state()) == id {
            return;
        }
        let _isolate_guard = IsolateEnterGuard::enter(self.inner.v8_isolate());
        realms::activate(&mut self.inner, id);
    }

    /// Run `f` with a scope in the page's context and the op state — what the
    /// realm functions take, so they also work from inside an op.
    fn with_realm_scope<R>(
        &mut self,
        f: impl FnOnce(&mut v8::PinScope, &std::rc::Rc<std::cell::RefCell<deno_core::OpState>>) -> R,
    ) -> R {
        let op_state = self.inner.op_state();
        let _isolate_guard = IsolateEnterGuard::enter(self.inner.v8_isolate());
        let ctx = self.inner.main_context();
        v8::scope_with_context!(scope, self.inner.v8_isolate(), ctx);
        f(scope, &op_state)
    }

    /// Build a frame realm for the `<iframe>` `node` in realm `parent`'s
    /// document: a full document (its own DOM, the page's bootstraps) in a new
    /// context of this isolate, same-origin with the page and inheriting
    /// `origin`. `dom` is its document, the initial `about:blank` when `None`.
    /// Returns its id.
    pub fn create_frame_realm_for(
        &mut self,
        parent: u32,
        node: u32,
        dom: Option<Dom>,
        stylesheets: Vec<String>,
        origin: &str,
    ) -> Result<u32, deno_core::error::AnyError> {
        self.with_realm_scope(|scope, op_state| {
            let prev = realms::active(op_state);
            realms::activate_in(scope, op_state, parent);
            let out = realms::create_in(scope, op_state, parent, node, dom, stylesheets, origin);
            realms::activate_in(scope, op_state, prev);
            out
        })
    }

    /// [`Self::create_frame_realm_for`] with no owning element — a detached
    /// document of its own, for tests and tools.
    pub fn create_frame_realm(
        &mut self,
        dom: Dom,
        stylesheets: Vec<String>,
    ) -> Result<u32, deno_core::error::AnyError> {
        self.create_frame_realm_for(0, u32::MAX, Some(dom), stylesheets, "null")
    }

    /// Run `code` in frame realm `id` (0: the page) and stringify the result.
    pub fn execute_in_realm(
        &mut self,
        id: u32,
        code: &str,
    ) -> Result<String, deno_core::error::AnyError> {
        self.with_realm_scope(|scope, op_state| {
            let ctx = if id == 0 {
                v8::Global::new(scope, scope.get_current_context())
            } else {
                let found = op_state
                    .borrow()
                    .try_borrow::<realms::RealmDocs>()
                    .and_then(|d| d.realm(id))
                    .map(|r| r.context.clone());
                match found {
                    Some(c) => c,
                    None => return Err(deno_core::error::AnyError::msg("no such frame realm")),
                }
            };
            realms::activate_in(scope, op_state, id);
            let out = realms::run_in_scope(scope, &ctx, code, "<anonymous>");
            realms::activate_in(scope, op_state, 0);
            out
        })
    }

    /// [`Self::execute_in_realm`] naming the script (`name` shows in stack
    /// traces: the document URL, or `about:srcdoc`).
    pub fn execute_in_realm_named(
        &mut self,
        id: u32,
        code: &str,
        name: &str,
    ) -> Result<String, deno_core::error::AnyError> {
        self.with_realm_scope(|scope, op_state| {
            let ctx = if id == 0 {
                v8::Global::new(scope, scope.get_current_context())
            } else {
                let found = op_state
                    .borrow()
                    .try_borrow::<realms::RealmDocs>()
                    .and_then(|d| d.realm(id))
                    .map(|r| r.context.clone());
                match found {
                    Some(c) => c,
                    None => return Err(deno_core::error::AnyError::msg("no such frame realm")),
                }
            };
            realms::activate_in(scope, op_state, id);
            let out = realms::run_in_scope(scope, &ctx, code, name);
            realms::activate_in(scope, op_state, 0);
            out
        })
    }

    /// Load `dom` into frame realm `id` as its document, keeping its window —
    /// what the HTML spec does when a frame navigates from its initial
    /// `about:blank` to a same-origin document. The old document's own frame
    /// realms go with it. `url` becomes `location.href` (`about:srcdoc` for a
    /// srcdoc document, which then takes `inherit_origin`).
    pub fn replace_realm_document(
        &mut self,
        id: u32,
        dom: Dom,
        stylesheets: Vec<String>,
        url: &str,
        inherit_origin: Option<&str>,
    ) -> Result<(), deno_core::error::AnyError> {
        let nested: Vec<u32> = self
            .frame_realms()
            .into_iter()
            .filter(|(_, parent, _)| *parent == id)
            .map(|(r, _, _)| r)
            .collect();
        for r in nested {
            self.destroy_frame_realm(r);
        }
        let swapped = self
            .with_realm_dom(id, |doc| {
                let mut next = DomState::new(dom);
                next.stylesheets = stylesheets;
                next.stealth_profile = doc.stealth_profile.clone();
                next.update_cached_rules();
                *doc = next;
            })
            .is_some();
        if !swapped {
            return Err(deno_core::error::AnyError::msg("no such frame realm"));
        }
        let url_js = serde_json::to_string(url).unwrap_or_else(|_| "\"about:blank\"".into());
        self.execute_in_realm(
            id,
            &format!(
                "(function(){{var ns=null;try{{var s=Object.getOwnPropertySymbols(globalThis,1);                 for(var i=0;i<s.length;i++){{var v=globalThis[s[i]];if(v&&v.__bo){{ns=v;break;}}}}}}catch(e){{}}                 var h=(ns&&ns.host)||{{}};                 try{{if(typeof h.__resetDomRegistries==='function')h.__resetDomRegistries();}}catch(e){{}}                 try{{if(h.bo)h.bo.__documentReadyState='loading';}}catch(e){{}}                 location.href={url_js};}})()"
            ),
        )?;
        if let Some(origin) = inherit_origin {
            let origin = serde_json::to_string(origin).unwrap_or_else(|_| "\"null\"".into());
            self.call_privileged_in_realm(
                id,
                &format!("(function(caps){{if(caps.inheritOrigin)caps.inheritOrigin({origin});}})"),
            )?;
        }
        // Setting `href` above was the load itself, not a request to navigate.
        let op_state = self.inner.op_state();
        realms::forget_frame_navigation(&op_state, id);
        Ok(())
    }

    /// [`Self::call_privileged`] against frame realm `id`'s own capabilities.
    pub fn call_privileged_in_realm(
        &mut self,
        id: u32,
        source: &str,
    ) -> Result<String, deno_core::error::AnyError> {
        self.with_realm_scope(|scope, op_state| {
            let (ctx, caps) = {
                let s = op_state.borrow();
                let r = s
                    .try_borrow::<realms::RealmDocs>()
                    .and_then(|d| d.realm(id))
                    .map(|r| (r.context.clone(), r.caps.clone()));
                match r {
                    Some(r) => r,
                    None => return Err(deno_core::error::AnyError::msg("no such frame realm")),
                }
            };
            realms::activate_in(scope, op_state, id);
            let out = (|| {
                let ctx = v8::Local::new(scope, &ctx);
                let cs = &mut v8::ContextScope::new(scope, ctx);
                let src = v8::String::new(cs, source)
                    .ok_or_else(|| deno_core::error::AnyError::msg("source too large"))?;
                let f = v8::Script::compile(cs, src, None)
                    .and_then(|s| s.run(cs))
                    .and_then(|f| v8::Local::<v8::Function>::try_from(f).ok())
                    .ok_or_else(|| {
                        deno_core::error::AnyError::msg(
                            "privileged source must evaluate to a function",
                        )
                    })?;
                let caps: v8::Local<v8::Value> = match caps {
                    Some(c) => v8::Local::new(cs, &c).into(),
                    None => v8::Object::new(cs).into(),
                };
                let undef = v8::undefined(cs).into();
                let out = f
                    .call(cs, undef, &[caps])
                    .ok_or_else(|| deno_core::error::AnyError::msg("privileged call threw"))?;
                Ok(out
                    .to_string(cs)
                    .map(|s| s.to_rust_string_lossy(cs))
                    .unwrap_or_default())
            })();
            realms::activate_in(scope, op_state, 0);
            out
        })
    }

    /// The source frame realm `id`'s document was loaded from, if any.
    pub fn frame_realm_source(&mut self, id: u32) -> Option<String> {
        self.inner
            .op_state()
            .borrow()
            .try_borrow::<realms::RealmDocs>()
            .and_then(|d| d.realm(id))
            .and_then(|r| r.source.clone())
    }

    /// Record what frame realm `id`'s document was loaded from.
    pub fn set_frame_realm_source(&mut self, id: u32, source: Option<String>) {
        if let Some(r) = self
            .inner
            .op_state()
            .borrow_mut()
            .try_borrow_mut::<realms::RealmDocs>()
            .and_then(|d| d.realm_mut(id))
        {
            r.source = source;
        }
    }

    /// Frame realms that asked to navigate (see `realms::note_frame_navigation`).
    pub fn take_frame_navigations(&mut self) -> Vec<u32> {
        let op_state = self.inner.op_state();
        realms::take_frame_navigations(&op_state)
    }

    /// Every frame realm, as `(id, parent realm, <iframe> node in the parent)`.
    pub fn frame_realms(&mut self) -> Vec<(u32, u32, u32)> {
        self.inner
            .op_state()
            .borrow()
            .try_borrow::<realms::RealmDocs>()
            .map(|d| d.frames())
            .unwrap_or_default()
    }

    /// Drop frame realm `id`, the frame realms nested in it, and their
    /// documents.
    pub fn destroy_frame_realm(&mut self, id: u32) {
        self.with_realm_scope(|scope, op_state| realms::destroy_in(scope, op_state, id));
    }

    /// Run `f` against frame realm `id`'s `DomState` (0: the page's). `None`
    /// when there is no such realm.
    pub fn with_realm_dom<R>(
        &mut self,
        id: u32,
        f: impl FnOnce(&mut state::DomState) -> R,
    ) -> Option<R> {
        let ok = self.with_realm_scope(|scope, op_state| realms::activate_in(scope, op_state, id));
        let out = if ok {
            let op_state = self.inner.op_state();
            let mut s = op_state.borrow_mut();
            s.try_borrow_mut::<state::DomState>().map(f)
        } else {
            None
        };
        self.activate_realm(0);
        out
    }

    pub fn record_resource_timing(
        &mut self,
        url: String,
        decoded_size: u64,
        timings: crate::net::TimingStats,
    ) {
        let op_state = self.inner.op_state();
        let mut state = op_state.borrow_mut();
        extensions::fetch_ext::record_resource_timing(&mut state, url, decoded_size, timings);
    }
}
