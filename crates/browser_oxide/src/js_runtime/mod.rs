//! V8 JavaScript runtime with DOM bindings for browser_oxide.
//!
//! MIT/Apache-2.0 licensed. Part of the browser_oxide project.

pub mod extensions;
pub mod inspect;
pub mod module_loader;
pub mod native_fns;
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
    pub fn replace_dom(&mut self, dom: Dom, stylesheets: Vec<String>) {
        let state = self.inner.op_state();
        let mut state = state.borrow_mut();
        // Replace DomState — ops will pick up the new DOM on next call
        let mut dom_state = DomState::new(dom);
        dom_state.stylesheets = stylesheets;
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
        &mut self.inner
    }

    /// Get the OpState (shared state).
    pub fn op_state(&mut self) -> std::rc::Rc<std::cell::RefCell<deno_core::OpState>> {
        self.inner.op_state()
    }

    pub fn record_resource_timing(&mut self, timings: crate::net::TimingStats) {
        let op_state = self.inner.op_state();
        let mut state = op_state.borrow_mut();
        extensions::fetch_ext::record_resource_timing(&mut state, timings);
    }
}
