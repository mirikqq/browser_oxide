//! A worker realm looks like a worker, and a worker that throws says so.
//!
//! Two gaps that only show up together. The global had no `WorkerGlobalScope`
//! interface, so the canonical "am I in a worker" test —
//! `!self.document && self.WorkerGlobalScope` — answered no, and a library then
//! ran its *window* path inside the worker: it found nothing it expected and
//! posted nothing back. And an uncaught error there was written to the trace log
//! and nowhere else, so from the page's side that worker was indistinguishable
//! from one still working. Measured on creepjs, whose worker collector produced
//! no data at all and left four of its own probes reading `undefined`.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;
use std::time::Duration;

async fn page() -> Page {
    Page::from_html("<html><body></body></html>", Some(chrome_148_macos()))
        .await
        .expect("page")
}

/// Run a blob worker and collect whatever it reports into `globalThis.__out`.
async fn run_worker(page: &mut Page, body: &str) -> String {
    let script = format!(
        "(function(){{globalThis.__out='ждём';\
         var b=new Blob([{}],{{type:'text/javascript'}});\
         var w=new Worker(URL.createObjectURL(b));\
         w.onmessage=function(e){{globalThis.__out='СООБЩЕНИЕ '+JSON.stringify(e.data);}};\
         w.onerror=function(e){{globalThis.__out='ОШИБКА '+String(e.message)+' @ '+String(e.filename);}};\
         return 'запущен';}})()",
        serde_json::to_string(body).expect("quote")
    );
    page.evaluate(&script).expect("spawn worker");
    for _ in 0..20 {
        let _ = page
            .evaluate_async("void 0", Duration::from_millis(100))
            .await;
        let out = page
            .evaluate("String(globalThis.__out)")
            .unwrap_or_default();
        if !out.contains("ждём") {
            return out;
        }
    }
    page.evaluate("String(globalThis.__out)")
        .unwrap_or_default()
}

#[tokio::test(flavor = "current_thread")]
async fn a_worker_global_identifies_itself_as_one() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let mut page = page().await;
            let out = run_worker(
                &mut page,
                "self.postMessage({\
                   вердикт: !self.document && !!self.WorkerGlobalScope,\
                   wgs: typeof WorkerGlobalScope,\
                   dwgs: typeof DedicatedWorkerGlobalScope,\
                   shared: typeof SharedWorkerGlobalScope,\
                   service: typeof ServiceWorkerGlobalScope,\
                   ctor: self.constructor && self.constructor.name,\
                   tag: Object.prototype.toString.call(self),\
                   instance: self instanceof WorkerGlobalScope,\
                 })",
            )
            .await;

            assert!(out.contains("СООБЩЕНИЕ"), "воркер не ответил: {out}");
            // The test every library actually runs.
            assert!(
                out.contains("\"вердикт\":true"),
                "область не опознаётся как воркерная: {out}"
            );
            assert!(
                out.contains("\"wgs\":\"function\"") && out.contains("\"dwgs\":\"function\""),
                "интерфейсы области отсутствуют: {out}"
            );
            assert!(
                out.contains("\"ctor\":\"DedicatedWorkerGlobalScope\"")
                    && out.contains("[object DedicatedWorkerGlobalScope]")
                    && out.contains("\"instance\":true"),
                "глобал не в цепочке своих интерфейсов: {out}"
            );
            // A dedicated worker is not a shared or service one.
            assert!(
                out.contains("\"shared\":\"undefined\"")
                    && out.contains("\"service\":\"undefined\""),
                "выделенный воркер выдаёт себя за другой вид: {out}"
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn an_uncaught_error_reaches_the_owning_page() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let mut page = page().await;
            let out = run_worker(&mut page, "throw new Error('сломалось')").await;
            assert!(
                out.contains("ОШИБКА") && out.contains("сломалось"),
                "ошибка воркера не дошла до страницы: {out}"
            );
            assert!(
                out.contains("blob:"),
                "у события ошибки нет источника: {out}"
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_working_worker_still_delivers_its_message() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let mut page = page().await;
            let out = run_worker(&mut page, "self.postMessage({жив: true})").await;
            assert!(
                out.contains("СООБЩЕНИЕ") && out.contains("\"жив\":true"),
                "обычное сообщение сломалось: {out}"
            );
        })
        .await;
}
