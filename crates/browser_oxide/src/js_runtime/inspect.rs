//! V8 inspector tap — the authoritative record of what JavaScript actually ran.
//!
//! Every other way of asking "did that script run?" is second-hand. The DOM only
//! shows the tags. The network log only shows the bytes arriving. A script that
//! compiled and threw looks exactly like one that never loaded, and a script the
//! page built with `new Function` leaves no trace anywhere. V8's own inspector
//! reports `Debugger.scriptParsed` for every unit it compiles — parser-inserted,
//! dynamically appended, `eval`, `Function` constructor, in every realm — plus the
//! exceptions raised and the execution contexts themselves. It is the same feed
//! Chrome DevTools consumes, so it agrees with a real browser by construction
//! rather than by our own bookkeeping happening to be right.
//!
//! Off by default: attaching a session makes V8 keep script metadata alive and
//! notify on every compile. Enable per-run with `BROWSER_OXIDE_INSPECT`, or from a
//! host with [`enabled_for_process`].

use deno_core::{InspectorMsg, InspectorSessionKind, JsRuntime, LocalInspectorSession};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

/// One compilation unit V8 accepted.
#[derive(Clone, Debug)]
pub struct ScriptRecord {
    pub script_id: String,
    /// Empty for `eval` and `new Function`, which is itself the interesting case.
    pub url: String,
    pub length: u64,
    pub is_module: bool,
    /// Execution context it was compiled in — distinguishes realms.
    pub context_id: i64,
}

/// A compilation unit V8 rejected. Distinct from a script that threw at runtime:
/// this one never had a chance to run.
#[derive(Clone, Debug)]
pub struct ParseFailure {
    pub url: String,
    pub length: u64,
    pub context_id: i64,
}

/// A realm. One per page, one per iframe, one per worker.
#[derive(Clone, Debug)]
pub struct ContextRecord {
    pub id: i64,
    pub origin: String,
    pub name: String,
    pub destroyed: bool,
}

/// An uncaught exception, as V8 saw it — including ones no page listener caught.
#[derive(Clone, Debug)]
pub struct ExceptionRecord {
    pub text: String,
    pub url: String,
    pub line: u32,
}

#[derive(Default, Debug, Clone)]
pub struct InspectLog {
    pub scripts: Vec<ScriptRecord>,
    pub failures: Vec<ParseFailure>,
    pub contexts: Vec<ContextRecord>,
    pub exceptions: Vec<ExceptionRecord>,
}

impl InspectLog {
    /// One line fit for a status bar.
    pub fn summary(&self) -> String {
        let modules = self.scripts.iter().filter(|s| s.is_module).count();
        let anonymous = self.scripts.iter().filter(|s| s.url.is_empty()).count();
        format!(
            "скриптов {} (модулей {}, безымянных {}), не скомпилировалось {}, реалмов {} (живых {}), исключений {}",
            self.scripts.len(),
            modules,
            anonymous,
            self.failures.len(),
            self.contexts.len(),
            self.contexts.iter().filter(|c| !c.destroyed).count(),
            self.exceptions.len(),
        )
    }
}

static FORCED: AtomicBool = AtomicBool::new(false);
static FROM_ENV: OnceLock<bool> = OnceLock::new();

/// Whether new runtimes should attach an inspector session.
pub fn enabled_for_process() -> bool {
    FORCED.load(Ordering::Relaxed)
        || *FROM_ENV.get_or_init(|| std::env::var_os("BROWSER_OXIDE_INSPECT").is_some())
}

/// Turn the tap on for runtimes created from now on.
///
/// Has no effect on runtimes that already exist: `RuntimeOptions::inspector` is
/// decided at isolate construction.
pub fn enable() {
    FORCED.store(true, Ordering::Relaxed);
}

/// An attached inspector session plus the log it feeds.
///
/// Dropping this detaches the session.
pub struct InspectorTap {
    #[allow(
        dead_code,
        reason = "RAII: the session must outlive the tap — dropping it detaches from V8"
    )]
    session: LocalInspectorSession,
    log: Rc<RefCell<InspectLog>>,
}

impl InspectorTap {
    /// Attach to a runtime that was built with `RuntimeOptions::inspector`.
    ///
    /// Enables the `Runtime` and `Debugger` domains, which is what makes V8 start
    /// reporting. No breakpoints are set and nothing pauses: a paused isolate
    /// would be indistinguishable from a hung one, and `debugger` statements are
    /// a documented detection trick.
    pub fn attach(runtime: &mut JsRuntime) -> Self {
        let log = Rc::new(RefCell::new(InspectLog::default()));
        let sink = log.clone();

        let mut session = deno_core::JsRuntimeInspector::create_local_session(
            runtime.inspector(),
            Box::new(move |msg: InspectorMsg| {
                record(&sink, &msg.content);
            }),
            InspectorSessionKind::NonBlocking {
                wait_for_disconnect: false,
            },
        );

        session.post_message(1, "Runtime.enable", None::<()>);
        session.post_message(2, "Debugger.enable", None::<()>);

        Self { session, log }
    }

    /// Everything seen so far, as an owned copy.
    pub fn snapshot(&self) -> InspectLog {
        self.log.borrow().clone()
    }
}

/// Fold one inspector notification into the log. Unknown methods are ignored —
/// enabling a domain turns on more events than we consume.
fn record(log: &Rc<RefCell<InspectLog>>, content: &str) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(content) else {
        return;
    };
    let Some(method) = v.get("method").and_then(|m| m.as_str()) else {
        return;
    };
    let p = v.get("params").cloned().unwrap_or(serde_json::Value::Null);
    let s = |k: &str| p.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let n = |k: &str| p.get(k).and_then(|x| x.as_i64()).unwrap_or(0);

    let mut log = log.borrow_mut();
    match method {
        "Debugger.scriptParsed" => log.scripts.push(ScriptRecord {
            script_id: s("scriptId"),
            url: s("url"),
            length: p.get("length").and_then(|x| x.as_u64()).unwrap_or(0),
            is_module: p.get("isModule").and_then(|x| x.as_bool()).unwrap_or(false),
            context_id: n("executionContextId"),
        }),
        "Debugger.scriptFailedToParse" => log.failures.push(ParseFailure {
            url: s("url"),
            length: p.get("length").and_then(|x| x.as_u64()).unwrap_or(0),
            context_id: n("executionContextId"),
        }),
        "Runtime.executionContextCreated" => {
            let ctx = p.get("context").cloned().unwrap_or(serde_json::Value::Null);
            log.contexts.push(ContextRecord {
                id: ctx.get("id").and_then(|x| x.as_i64()).unwrap_or(0),
                origin: ctx
                    .get("origin")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                name: ctx
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                destroyed: false,
            });
        }
        "Runtime.executionContextDestroyed" => {
            let id = n("executionContextId");
            if let Some(c) = log.contexts.iter_mut().find(|c| c.id == id) {
                c.destroyed = true;
            }
        }
        "Runtime.exceptionThrown" => {
            let d = p
                .get("exceptionDetails")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            log.exceptions.push(ExceptionRecord {
                text: d
                    .get("text")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                url: d
                    .get("url")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                line: d
                    .get("lineNumber")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0)
                    .saturating_add(1) as u32,
            });
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fold(msgs: &[&str]) -> InspectLog {
        let log = Rc::new(RefCell::new(InspectLog::default()));
        for m in msgs {
            record(&log, m);
        }
        Rc::try_unwrap(log).expect("sole owner").into_inner()
    }

    #[test]
    fn folds_script_and_failure_notifications() {
        let log = fold(&[
            r#"{"method":"Debugger.scriptParsed","params":{"scriptId":"7","url":"https://x/a.js","length":120,"isModule":false,"executionContextId":1}}"#,
            r#"{"method":"Debugger.scriptParsed","params":{"scriptId":"8","url":"","length":40,"executionContextId":1}}"#,
            r#"{"method":"Debugger.scriptFailedToParse","params":{"url":"https://x/bad.js","length":9,"executionContextId":1}}"#,
        ]);
        assert_eq!(log.scripts.len(), 2);
        assert_eq!(log.scripts[0].url, "https://x/a.js");
        // An empty URL is `eval`/`new Function` — the case nothing else can see.
        assert!(log.scripts[1].url.is_empty());
        assert_eq!(log.failures.len(), 1);
        assert_eq!(log.failures[0].url, "https://x/bad.js");
    }

    #[test]
    fn tracks_realm_lifetime() {
        let log = fold(&[
            r#"{"method":"Runtime.executionContextCreated","params":{"context":{"id":2,"origin":"https://x","name":"frame"}}}"#,
            r#"{"method":"Runtime.executionContextDestroyed","params":{"executionContextId":2}}"#,
        ]);
        assert_eq!(log.contexts.len(), 1);
        assert!(log.contexts[0].destroyed, "реалм помечен уничтоженным");
    }

    #[test]
    fn records_uncaught_exceptions_with_one_based_lines() {
        let log = fold(&[
            r#"{"method":"Runtime.exceptionThrown","params":{"exceptionDetails":{"text":"Uncaught TypeError","url":"https://x/a.js","lineNumber":41}}}"#,
        ]);
        assert_eq!(log.exceptions.len(), 1);
        // V8 reports zero-based; every UI that shows this counts from one.
        assert_eq!(log.exceptions[0].line, 42);
    }

    #[test]
    fn ignores_unrelated_notifications() {
        let log = fold(&[
            r#"{"method":"Runtime.consoleAPICalled","params":{"type":"log"}}"#,
            r#"not json"#,
            r#"{"no":"method"}"#,
        ]);
        assert_eq!(log.scripts.len(), 0);
        assert_eq!(log.exceptions.len(), 0);
    }
}
