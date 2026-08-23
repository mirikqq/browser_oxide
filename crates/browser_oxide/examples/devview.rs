//! Live debug view for the engine: mirrors its DOM into a real browser, streams what
//! it is doing over a WebSocket, and sends your clicks and typing straight back.
//!
//!   cargo run --release -p browser_oxide --example devview -- <url> [port]
//!
//! HTTP serves the page on `port`; the event socket is on `port + 1`.
//!
//! Two things this view has to be honest about. The engine has no rasteriser, so the
//! mirror is the engine's DOM rendered by *your* browser — close, but not the engine's
//! own layout. And there is no real cursor in headless: pointer motion is synthesised
//! by the behaviour generator, so the overlay draws where the engine believes the
//! cursor is, sample by sample.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};

const PAGE: &str = include_str!("devview.html");

/// Frame documents already sent, keyed by node id — `push_snapshot` sends a
/// frame's markup only when it differs from the record here, because a captcha
/// frame's document is ~600 KB and the loop ticks five times a second.
///
/// Cleared on a view's `resync`, which is the only reliable signal that somebody
/// is holding nothing.
static LAST_FRAME_DOCS: Mutex<Vec<(String, u64, String)>> = Mutex::new(Vec::new());

/// Last full-resolution bitmap delivered for each surface. A changed revision
/// is encoded at most 15 times/s; unchanged revisions carry metadata only.
static LAST_CANVAS_REVISIONS: LazyLock<Mutex<HashMap<String, (u64, Instant)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static FORCE_CANVAS_FLUSH: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Resolves the engine's symbol-keyed internal namespace (see `page.rs`).
const NS_RESOLVE: &str = "(function(){try{var s=Object.getOwnPropertySymbols(globalThis);for(var i=0;i<s.length;i++){var v=globalThis[s[i]];if(v&&v.__bo)return v;}}catch(e){}return null;})()";

/// Properties compared engine-vs-Chrome. Both sides iterate the same list.
const INSPECT_PROPS: &str = "['display','position','width','height','fontSize','fontFamily',\
'color','backgroundColor','marginTop','marginLeft','paddingTop','paddingLeft',\
'borderTopWidth','flexDirection','justifyContent','alignItems','zIndex','opacity',\
'visibility','overflow','textAlign','lineHeight']";

/// One poll: DOM, actionables, cursor samples, and the visibility of any vendor
/// challenge container. Network records do not come from here — the page-side
/// `__fetchLog` only ever saw `fetch()`; `net::netlog` records at the HTTP client
/// and so also catches scripts, stylesheets, XHR and iframe documents.
///
/// The cursor buffer is *drained*, not copied: `humanize.js` caps it at 200 entries
/// and never clears it, so the overlay would freeze once the cap is reached.
/// Challenge containers are reported by computed visibility because that is the
/// actual detection signal — vendors ship the markup on every page and only flip it
/// visible once they decide to challenge.
const SNAPSHOT_JS: &str = r#"
(function () {
  function selectorFor(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    while (el && el.nodeType === 1 && el.tagName !== 'HTML') {
      var p = el.parentNode;
      if (!p) break;
      var same = [].filter.call(p.children, function (c) { return c.tagName === el.tagName; });
      parts.unshift(el.tagName.toLowerCase() +
        (same.length > 1 ? ':nth-of-type(' + (same.indexOf(el) + 1) + ')' : ''));
      el = p;
    }
    return parts.join(' > ');
  }
  // Tag every frame before serialising: the mirror runs without allow-scripts,
  // so a real <iframe> there would either stay blank or — worse — re-run the
  // third party in the viewer's own browser. Tagging lets the view swap each one
  // for a box holding the document *this engine* built for it.
  var frames = [].map.call(document.querySelectorAll('iframe'), function (f, i) {
    try { f.setAttribute('data-bo-frame', String(i)); } catch (_) {}
    var r = f.getBoundingClientRect(), c = getComputedStyle(f);
    // A hidden frame still holds a full document — hCaptcha keeps the challenge
    // built and merely hides it. Reporting visibility lets the view leave it out
    // instead of spilling "Please try again / Verify" across the page.
    var shown = c.display !== 'none' && c.visibility !== 'hidden' &&
                Number(c.opacity) > 0 && r.width > 24 && r.height > 24;
    return {
      idx: i,
      src: String(f.getAttribute('src') || (f.hasAttribute('srcdoc') ? 'srcdoc' : 'about:blank')),
      shown: shown,
      box: [Math.round(r.width), Math.round(r.height)]
    };
  });
  var acts = [].map.call(
    document.querySelectorAll('input,button,a[href],select,textarea,[role=button],[role=link]'),
    function (el) {
      var r = el.getBoundingClientRect();
      return {
        sel: selectorFor(el),
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
                el.getAttribute('name') || el.textContent || '').trim().slice(0, 60),
        value: ('value' in el) ? String(el.value || '').slice(0, 60) : '',
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
      };
    });
  var _ns = (function(){try{var s=Object.getOwnPropertySymbols(globalThis);for(var i=0;i<s.length;i++){var v=globalThis[s[i]];if(v&&v.__bo)return v;}}catch(e){}return null;})();
  var bo = (_ns && _ns.input) || null;
  var cursor = [];
  if (bo && bo.mouse && bo.mouse.length) { cursor = bo.mouse.splice(0, bo.mouse.length); }
  var challenges = [].map.call(
    document.querySelectorAll('[id*=talon],[class*=talon],[id*=captcha],[class*=captcha],[class*=challenge]'),
    function (n) {
      var c = getComputedStyle(n), r = n.getBoundingClientRect();
      return {
        id: (n.id || n.className || n.tagName).toString().slice(0, 46),
        display: c.display, visibility: c.visibility,
        box: [Math.round(r.width), Math.round(r.height)]
      };
    });
  function __boSerialize() {
    return document.documentElement.outerHTML;
  }
  return JSON.stringify({
    url: location.href,
    title: document.title,
    viewport: [innerWidth, innerHeight],
    html: __boSerialize(),
    actionables: acts,
    frames: frames,
    cursor: cursor,
    lastPos: (bo && bo._lastPos) || null,
    challenges: challenges,
    counts: {
      elements: document.querySelectorAll('*').length,
      inputs: document.querySelectorAll('input').length,
      buttons: document.querySelectorAll('button').length
    }
  });
})()
"#;

/// The engine runs on a thread with a 64 MB stack, not the process main thread.
///
/// macOS gives `main` 8 MB and it cannot be grown after link time. Building a
/// second V8 isolate (which is what every `<iframe src=…>` needs) does not fit
/// in what is left of that, and V8 fails the child isolate's own bootstrap with
/// `Maximum call stack size exceeded` before any page script runs — so a page
/// with a cross-origin frame died on load. `parallel.rs` and the worker pool
/// already size their threads this way for the same reason.
fn main() {
    std::thread::Builder::new()
        .stack_size(64 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("failed to build tokio runtime")
                .block_on(run());
        })
        .expect("failed to spawn engine thread")
        .join()
        .expect("engine thread panicked");
}

async fn run() {
    let mut args = std::env::args().skip(1);
    let url = args.next().expect("usage: devview <url> [port]");
    let port: u16 = args.next().and_then(|p| p.parse().ok()).unwrap_or(7333);
    let ws_port = port + 1;

    browser_oxide::net::netlog::enable();
    // Opt-in: an attached V8 inspector changes how `debugger` behaves, and pages
    // that probe for developer tools by timing a `debugger` statement then take a
    // branch no ordinary visitor takes. Off unless asked for.
    if std::env::var_os("DEVVIEW_INSPECT").is_some() {
        // Must precede page construction: the inspector is decided with the isolate.
        browser_oxide::js_runtime::inspect::enable();
    }

    let inspect: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    // Events fan out to every connected view; commands funnel back to the engine.
    let (events_tx, _) = broadcast::channel::<String>(1024);
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<String>();

    // The static page gets its own thread and its own runtime.
    //
    // Everything else shares one current-thread runtime with the engine, and
    // while the engine is inside V8 tokio polls nothing — V8 does not yield.
    // The socket was bound, so the kernel completed the handshake and the
    // browser sat waiting for a response that could not be written until the
    // page finished building, twenty-odd seconds later. Serving the page from
    // a thread of its own means the view is up the moment the process is.
    {
        let (p, wp) = (port, ws_port);
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("devview: cannot build the http runtime");
            rt.block_on(async move {
                serve_http(p, wp).await;
                std::future::pending::<()>().await;
            });
        });
    }
    serve_ws(ws_port, events_tx.clone(), cmd_tx).await;

    let open_url = format!("http://127.0.0.1:{port}/");
    println!("devview: {open_url}  (события: ws://127.0.0.1:{ws_port})  — вкладка откроется только с DEVVIEW_OPEN=1");
    // Opt-in: stealing focus with a new tab on every run is hostile when the
    // engine is being driven from a script while someone works in the same browser.
    if std::env::var_os("DEVVIEW_OPEN").is_some() {
        let opener = if cfg!(target_os = "macos") {
            "open"
        } else if cfg!(target_os = "windows") {
            "explorer"
        } else {
            "xdg-open"
        };
        let _ = std::process::Command::new(opener).arg(&open_url).spawn();
    }

    let emit = {
        let tx = events_tx.clone();
        move |kind: &str, payload: String| {
            let _ = tx.send(format!("{{\"kind\":\"{kind}\",{payload}}}"));
        }
    };

    // A fresh fingerprint per launch. A fixed preset means every session out of
    // one address range carries the same canvas hash, screen and audio surface —
    // which clusters on its own, regardless of how correct each value is.
    // `BROWSER_OXIDE_PROFILE_SEED` pins it when a run has to be reproducible.
    let profile = match std::env::var("BROWSER_OXIDE_PROFILE_SEED")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
    {
        Some(seed) => {
            let mut rng = browser_oxide::stealth::presets::seeded_rng(seed);
            browser_oxide::stealth::presets::random_desktop_with_rng(&mut rng)
        }
        None => browser_oxide::stealth::presets::random_desktop(),
    };
    // The locale is not left to the dice: it is pulled to wherever the traffic
    // actually leaves. An exit IP in Stockholm presenting `Europe/Paris` and
    // `fr-FR` is a mismatch a risk engine checks on nearly every request —
    // geolocating the peer is the cheapest signal it has. Opt out with
    // `BROWSER_OXIDE_NO_GEO=1` when testing on a fixed profile.
    let mut profile = profile;
    if std::env::var_os("BROWSER_OXIDE_NO_GEO").is_none() {
        match browser_oxide::stealth::egress::detect_country(&profile).await {
            Some(cc) => {
                if browser_oxide::stealth::egress::apply_country(&mut profile, &cc) {
                    eprintln!("[гео] выход из {cc} — локаль подогнана");
                } else {
                    eprintln!("[гео] выход из {cc} — нет записи, локаль оставлена случайной");
                }
            }
            None => eprintln!("[гео] определить страну выхода не удалось, локаль случайная"),
        }
    }
    let profile = profile;
    eprintln!(
        "[профиль] {} {} · {}x{} dpr={} · {} ядер · {} ГБ · {} {} · {}",
        profile.os_name,
        profile.browser_version,
        profile.screen_width,
        profile.screen_height,
        profile.device_pixel_ratio,
        profile.cpu_cores,
        profile.device_memory,
        profile.timezone,
        profile.language,
        profile.webgl_renderer.chars().take(48).collect::<String>(),
    );
    let started = std::time::Instant::now();
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async move {
            emit("status", "\"text\":\"навигация…\"".into());
            // `INIT=<js>` runs before the page's own scripts — the only place from
            // which anything can be observed before the page touches it.
            // `navigate_with_init` deliberately takes exactly the scripts supplied by
            // its caller. Keep the same human-input runtime as `Page::navigate`, then
            // append the optional diagnostic script before the document's scripts run.
            let mut init = vec![include_str!("../src/js/humanize.js").to_string()];
            if let Ok(script) = std::env::var("INIT") {
                init.push(script);
            }
            // Warm navigation by default; `DEVVIEW_COLD=1` for the cold loop.
            //
            // The cold path re-runs a whole fetch-build-drain cycle per
            // iteration to follow challenge redirects and cookie diffs. That is
            // worth it in a harness; here it is a minute of black window before
            // anything is on screen, measured at roughly 25 s against 4 s for
            // the warm path. The pool is created fresh for this one navigation,
            // so nothing carries over from an earlier document — what the warm
            // path actually gives up is the challenge-follow loop, and a driver
            // sitting in front of the view can simply reload.
            let cold = std::env::var_os("DEVVIEW_COLD").is_some();
            let navigated = if cold {
                browser_oxide::Page::navigate_with_init(&url, profile, 4, init).await
            } else {
                let pool = browser_oxide::PagePool::new(1);
                match pool.acquire(Some(profile)).await {
                    // The pool's own `navigate_with_init` would run humanize a
                    // second time, after the page's scripts; it has to go in
                    // before them, which is what the init list is for.
                    Ok(mut p) => match p.navigate_warm_with_init(&url, &init).await {
                        Ok(()) => Ok(p),
                        Err(e) => Err(e),
                    },
                    Err(e) => Err(e),
                }
            };
            let mut page = match navigated
            {
                Ok(p) => p,
                Err(e) => {
                    emit("status", format!("\"text\":\"ошибка навигации: {e}\""));
                    println!("navigate error: {e}");
                    return;
                }
            };
            emit(
                "status",
                format!(
                    "\"text\":\"готово за {} мс\"",
                    started.elapsed().as_millis()
                ),
            );
            println!("готово — открой {open_url}");

            if std::env::var_os("BROWSER_OXIDE_FRAME_TRACE").is_some() {
                let _ = page.evaluate(include_str!("../src/js/frame_trace.js"));
            }

            // Uncaught errors and rejected promises never reach `console.*` on their
            // own, and they are exactly what a stalled third-party widget produces.
            let _ = page.evaluate(
                "(function(){\
                   addEventListener('error',function(e){\
                     console.error('uncaught: '+(e.message||e.type)+\
                       (e.filename?' @ '+e.filename+':'+e.lineno:''));});\
                   addEventListener('unhandledrejection',function(e){\
                     var r=e.reason;console.error('unhandled rejection: '+\
                       ((r&&(r.stack||r.message))||String(r)));});\
                   return 'ok';})()",
            );

            loop {
                // Commands are applied the moment they arrive. The previous build drove
                // the loop 8 s and pumped six more times per action, so every click took
                // ~10 s to land and felt like the trigger had been ignored.
                while let Ok(raw) = cmd_rx.try_recv() {
                    let t0 = std::time::Instant::now();
                    // A view that just opened holds no frame documents, and the
                    // change-gate in `push_snapshot` would answer "unchanged" to it
                    // for as long as the markup inside a frame holds still. The view
                    // asks for the record to be dropped rather than the loop guessing
                    // from the subscriber count: a reload disconnects and reconnects
                    // between two ticks, so the count never looks any different.
                    if raw.contains("\"resync\"") {
                        LAST_FRAME_DOCS.lock().unwrap().clear();
                        LAST_CANVAS_REVISIONS.lock().unwrap().clear();
                        FORCE_CANVAS_FLUSH.store(true, std::sync::atomic::Ordering::Relaxed);
                        continue;
                    }
                    if raw.contains("\"action\":\"trace\"") {
                        let op = field(&raw, "op");
                        let clear = op == "clear";
                        let jsonl = page.devview_trace_jsonl(clear);
                        emit(
                            "trace",
                            format!("\"op\":{},\"jsonl\":{}", json_str(&op), json_str(&jsonl)),
                        );
                        continue;
                    }
                    // `frame` evaluates inside a child realm instead of the page —
                    // the only way to see why a third-party widget's own document
                    // (hCaptcha's, here) does or does not finish booting.
                    // Which child realm belongs to which <iframe> element. Message
                    // routing keys on node ids, so a frame missing from this list
                    // is a frame the page can post to and never reach.
                    // What V8 actually compiled, plus whether anything is still
                    // pending. The DOM and the network log both answer "fine" for
                    // a script that failed to compile or never ran.
                    if raw.contains("\"scripts\"") {
                        let (ops, timers, intervals, res) = page.pending_work();
                        let out = match page.inspect_snapshot() {
                            Some(log) => {
                                let mut lines = vec![log.summary()];
                                lines.push(format!(
                                    "не завершено: ops {ops}, таймеров {timers}, интервалов {intervals}, ресурсов {res}"
                                ));
                                for f in log.failures.iter() {
                                    lines.push(format!(
                                        "НЕ СКОМПИЛИРОВАЛСЯ: {} ({} байт)",
                                        if f.url.is_empty() { "<инлайн>" } else { &f.url },
                                        f.length
                                    ));
                                }
                                for e in log.exceptions.iter() {
                                    lines.push(format!("ИСКЛЮЧЕНИЕ: {} @ {}:{}", e.text, e.url, e.line));
                                }
                                for c in log.contexts.iter() {
                                    lines.push(format!(
                                        "реалм {} {} {}",
                                        c.id,
                                        if c.origin.is_empty() { "-" } else { &c.origin },
                                        if c.destroyed { "(уничтожен)" } else { "" }
                                    ));
                                }
                                for sc in log.scripts.iter() {
                                    lines.push(format!(
                                        "  [{}] {} {} байт{}",
                                        sc.context_id,
                                        if sc.url.is_empty() { "<eval/Function>" } else { &sc.url },
                                        sc.length,
                                        if sc.is_module { " (модуль)" } else { "" }
                                    ));
                                }
                                lines.join("\n")
                            }
                            None => "инспектор выключен".to_string(),
                        };
                        emit(
                            "action",
                            format!("\"raw\":{},\"state\":{}", json_str(&raw), json_str(&out)),
                        );
                        continue;
                    }
                    // A click the viewer aimed at a frame has to be replayed in
                    // that frame's own realm. Its DOM is a separate document, so a
                    // selector resolved against the top one would find nothing.
                    // Full-resolution snapshot of a canvas, written to a file.
                    //
                    // The mirror scales its canvas thumbnails and re-lays them out
                    // with the viewer's CSS, so it cannot answer "what did the
                    // engine actually draw, at what size". This can: it is the
                    // engine's own bitmap, untouched.
                    if raw.contains("\"shot\"") {
                        let idx_raw = field(&raw, "index");
                        let cidx = field(&raw, "cidx");
                        let cidx = if cidx.is_empty() { "0".to_string() } else { cidx };
                        let js = format!(
                            "(function(){{var c=document.querySelectorAll('canvas')[{cidx}];\
                             if(!c)return '';\
                             try{{return c.width+'x'+c.height+'|'+c.toDataURL();}}catch(e){{return '';}}}})()"
                        );
                        let out = if idx_raw.is_empty() {
                            page.evaluate(&js).unwrap_or_default()
                        } else {
                            let idx = realm_for_dom_slot(
                                &mut page,
                                idx_raw.parse().unwrap_or(0),
                            );
                            match page.child_iframe(idx) {
                                Some(c) => c.evaluate(&js).unwrap_or_default(),
                                None => String::new(),
                            }
                        };
                        let state = match out.split_once('|') {
                            Some((dims, url)) if url.starts_with("data:image/png;base64,") => {
                                let b64 = &url["data:image/png;base64,".len()..];
                                match base64_decode(b64) {
                                    Some(bytes) => {
                                        let path = format!(
                                            "/tmp/bo_canvas_{}.png",
                                            std::time::SystemTime::now()
                                                .duration_since(std::time::UNIX_EPOCH)
                                                .map(|d| d.as_secs())
                                                .unwrap_or(0)
                                        );
                                        match std::fs::write(&path, &bytes) {
                                            Ok(_) => format!(
                                                "{dims}, {} байт → {path}",
                                                bytes.len()
                                            ),
                                            Err(e) => format!("не записалось: {e}"),
                                        }
                                    }
                                    None => "не разобрался base64".to_string(),
                                }
                            }
                            _ => "канваса нет или toDataURL пуст".to_string(),
                        };
                        emit(
                            "action",
                            format!("\"raw\":{},\"state\":{}", json_str(&raw), json_str(&state)),
                        );
                        continue;
                    }
                    // Raw keystroke forwarding, same discipline as `pointer`.
                    if raw.contains("\"key\"") {
                        let phase = field(&raw, "phase");
                        let key = field(&raw, "key").replace('`', "\\`");
                        let code = field(&raw, "code").replace('`', "\\`");
                        let sel = field(&raw, "sel").replace('`', "\\`");
                        let flag = |name: &str| {
                            if field(&raw, name) == "true" {
                                "true"
                            } else {
                                "false"
                            }
                        };
                        let js = KEY_JS
                            .replace("__SEL__", &sel)
                            .replace("__KEY__", &key)
                            .replace("__CODE__", &code)
                            .replace("__PHASE__", &phase)
                            .replace("__CTRL__", flag("ctrl"))
                            .replace("__ALT__", flag("alt"))
                            .replace("__SHIFT__", flag("shift"))
                            .replace("__META__", flag("meta"));
                        let idx_raw = field(&raw, "index");
                        let out = if idx_raw.is_empty() {
                            page.evaluate(&js).unwrap_or_else(|e| format!("ошибка: {e}"))
                        } else {
                            let idx = realm_for_dom_slot(
                                &mut page,
                                idx_raw.parse().unwrap_or(0),
                            );
                            match page.child_iframe(idx) {
                                Some(c) => {
                                    c.evaluate(&js).unwrap_or_else(|e| format!("ошибка: {e}"))
                                }
                                None => format!("нет фрейма {idx}"),
                            }
                        };
                        emit(
                            "action",
                            format!("\"raw\":{},\"state\":{}", json_str(&raw), json_str(&out)),
                        );
                        continue;
                    }
                    // Raw pointer forwarding: the viewer's own gesture, step by step.
                    if raw.contains("\"pointer\"") {
                        let phase = field(&raw, "phase");
                        if phase == "up" {
                            FORCE_CANVAS_FLUSH
                                .store(true, std::sync::atomic::Ordering::Relaxed);
                        }
                        let sel = field(&raw, "sel").replace('`', "\\`");
                        let u = field(&raw, "u");
                        let v = field(&raw, "v");
                        let surface = parse_surface_key(&field(&raw, "surface"));
                        let idx_raw = field(&raw, "index");
                        let js = POINTER_JS
                            .replace(
                                "__CANVAS_ID__",
                                &surface
                                    .as_ref()
                                    .map_or_else(|| "-1".into(), |key| key.canvas_id.to_string()),
                            )
                            .replace("__SEL__", &sel)
                            .replace("__U__", if u.is_empty() { "NaN" } else { &u })
                            .replace("__V__", if v.is_empty() { "NaN" } else { &v })
                            .replace("__PHASE__", &phase);
                        let out = if surface.as_ref().is_some_and(|key| key.frame_path.is_empty())
                            || (surface.is_none() && idx_raw.is_empty())
                        {
                            page.evaluate(&js).unwrap_or_else(|e| format!("ошибка: {e}"))
                        } else if let Some(key) = surface.as_ref() {
                            page.devview_evaluate_in_frame(
                                &key.frame_path,
                                key.generation,
                                &js,
                            )
                            .unwrap_or_else(|e| format!("ошибка: {e}"))
                        } else {
                            let idx = realm_for_dom_slot(
                                &mut page,
                                idx_raw.parse().unwrap_or(0),
                            );
                            match page.child_iframe(idx) {
                                Some(c) => {
                                    c.evaluate(&js).unwrap_or_else(|e| format!("ошибка: {e}"))
                                }
                                None => format!("нет фрейма {idx}"),
                            }
                        };
                        emit(
                            "action",
                            format!("\"raw\":{},\"state\":{}", json_str(&raw), json_str(&out)),
                        );
                        continue;
                    }
                    if raw.contains("\"frameclick\"") {
                        let idx = realm_for_dom_slot(
                            &mut page,
                            field(&raw, "index").parse().unwrap_or(0),
                        );
                        let sel = field(&raw, "sel").replace('`', "\\`");
                        // Marked trusted, like the pointer path. An untrusted
                        // click is not a click to a widget that checks — hCaptcha
                        // takes the whole `pointerdown … click` sequence without a
                        // complaint and does nothing at all with it, so a press on
                        // its own button silently did nothing.
                        let js = format!(
                            "(function(){{var e=document.querySelector(`{sel}`);\
                             if(!e)return 'нет элемента';\
                             var ns=(function(){{try{{var s=Object.getOwnPropertySymbols(globalThis);\
                                 for(var i=0;i<s.length;i++){{var v=globalThis[s[i]];if(v&&v.__bo)return v;}}}}catch(e){{}}return null;}})();\
                             var mark=(typeof globalThis.__bo_mark_trusted==='function')\
                                 ?globalThis.__bo_mark_trusted\
                                 :((ns&&ns.input&&typeof ns.input.mark==='function')?ns.input.mark:null);\
                             var r=e.getBoundingClientRect();\
                             var b={{bubbles:true,cancelable:true,view:window,\
                                    clientX:Math.round(r.left+r.width/2),\
                                    clientY:Math.round(r.top+r.height/2)}};\
                             try{{e.focus&&e.focus();}}catch(_){{}}\
                             ['pointerdown','mousedown','pointerup','mouseup','click']\
                               .forEach(function(t){{\
                                 var C=(t.indexOf('pointer')===0&&typeof PointerEvent!=='undefined')\
                                       ?PointerEvent:MouseEvent;\
                                 try{{var ev=new C(t,b); if(mark)mark(ev); e.dispatchEvent(ev);}}catch(_){{}}\
                               }});\
                             return 'клик во фрейме по '+(e.id||e.tagName)+(mark?' [trusted]':' [untrusted]');}})()"
                        );
                        let out = match page.child_iframe(idx) {
                            Some(c) => c.evaluate(&js).unwrap_or_else(|e| format!("ошибка: {e}")),
                            None => format!("нет фрейма {idx}"),
                        };
                        emit(
                            "action",
                            format!("\"raw\":{},\"state\":{}", json_str(&raw), json_str(&out)),
                        );
                        continue;
                    }
                    if raw.contains("\"frames\"") {
                        // Materialize first: the listing is only meaningful next to
                        // the DOM as it stands right now.
                        page.materialize_new_iframes().await;
                        let ids = page.child_frame_ids();
                        let out = ids
                            .iter()
                            .map(|(id, url)| format!("node {id} → {url}"))
                            .collect::<Vec<_>>()
                            .join("\n");
                        emit(
                            "action",
                            format!("\"raw\":{},\"state\":{}", json_str(&raw), json_str(&out)),
                        );
                        continue;
                    }
                    if raw.contains("\"frame\"") {
                        let idx = realm_for_dom_slot(
                            &mut page,
                            field(&raw, "index").parse().unwrap_or(0),
                        );
                        let js = field(&raw, "text");
                        let out = match page.child_iframe(idx) {
                            Some(c) => c.evaluate(&js).unwrap_or_else(|e| format!("ошибка: {e}")),
                            None => format!("нет фрейма {idx}"),
                        };
                        emit(
                            "action",
                            format!("\"raw\":{},\"state\":{}", json_str(&raw), json_str(&out)),
                        );
                        continue;
                    }
                    let immediate = page
                        .evaluate(&wrap_action(&action_to_js(&raw)))
                        .unwrap_or_else(|e| format!("ошибка: {e}"));
                    emit(
                        "action",
                        format!(
                            "\"raw\":{},\"state\":{}",
                            json_str(&raw),
                            json_str(&immediate)
                        ),
                    );
                    // Humanized input settles on the clock (travel, dwell, per-key
                    // delays), so poll its parked result rather than blocking on it —
                    // and keep streaming snapshots meanwhile so the cursor animates.
                    if immediate == "запущено" {
                        for _ in 0..100 {
                            let _ = page
                                .evaluate_async("void 0", std::time::Duration::from_millis(100))
                                .await;
                            push_snapshot(&mut page, &events_tx, &inspect);
                            let r = page.evaluate(&format!("({NS_RESOLVE}||{{}}).devviewResult")).unwrap_or_default();
                            if r != "выполняется…" {
                                emit(
                                    "action",
                                    format!(
                                        "\"raw\":{},\"state\":{},\"ms\":{}",
                                        json_str(&raw),
                                        json_str(&r),
                                        t0.elapsed().as_millis()
                                    ),
                                );
                                if raw.contains("\"inspect\"") {
                                    *inspect.lock().unwrap() = r;
                                }
                                break;
                            }
                        }
                    } else if raw.contains("\"inspect\"") {
                        *inspect.lock().unwrap() = immediate;
                    }
                    if let Some(n) = page.materialize_new_iframes().await {
                        if n > 0 {
                            emit("log", format!("\"text\":\"материализовано iframe: {n}\""));
                        }
                    }
                }

                // A rendering-opportunity cadence, and the only point that yields.
                //
                // `run_until_idle` returns the moment the runtime reports no work,
                // and background timers deliberately do not pin it — so a driver
                // that just calls it in a loop spins a whole core. On a
                // single-threaded runtime that starves every other task: the
                // socket stops being served, and the timers the page is waiting on
                // never get their chance to fire. Measured on a page with 15
                // pending background timers, this loop was at 100% CPU with zero
                // forward progress.
                tokio::time::sleep(std::time::Duration::from_millis(16)).await;

                // Short slice keeps the cursor overlay smooth and actions responsive.
                let _ = page
                    .evaluate_async("void 0", std::time::Duration::from_millis(120))
                    .await;
                // Frames appear on their own — a widget injects one seconds after
                // load with no command from us — so materialise on every tick, not
                // only after a driver action. Already-built frames are skipped.
                if let Some(n) = page.materialize_new_iframes().await {
                    if n > 0 {
                        emit("log", format!("\"text\":\"материализовано iframe: {n}\""));
                    }
                }
                page.drive_children(std::time::Duration::from_millis(60))
                    .await;
                let (down, up) = page.pump_iframe_messages();
                if down > 0 || up > 0 {
                    emit(
                        "log",
                        format!("\"text\":\"postMessage вниз {down}, вверх {up}\""),
                    );
                }
                push_snapshot(&mut page, &events_tx, &inspect);
            }
        })
        .await;
}

fn push_snapshot(
    page: &mut browser_oxide::Page,
    events: &broadcast::Sender<String>,
    inspect: &Arc<Mutex<String>>,
) {
    // Nothing is listening until the view connects, and draining the network log
    // into a broadcast with no subscribers loses every record from page load —
    // exactly the window where a widget's own bootstrap happens.
    if events.receiver_count() == 0 {
        return;
    }
    if let Ok(json) = page.evaluate(SNAPSHOT_JS) {
        let ins = inspect.lock().unwrap().clone();
        let ins = if ins.is_empty() { "null".into() } else { ins };
        // Each child realm's own document, so the mirror can show what the engine
        // built inside a frame instead of an empty rectangle.
        //
        // Only when it changed: a captcha frame's document is ~600 KB and the loop
        // ticks five times a second, which is megabytes per second of unchanged
        // markup. `null` means "keep what you have".
        let (frame_docs, frame_realms, frame_tree): (Vec<String>, Vec<String>, Vec<String>) = {
            let snapshots = page.devview_frame_snapshots(&serialize_js());
            let width = snapshots
                .iter()
                .filter(|frame| frame.parent_path.is_empty())
                .filter_map(|frame| frame.slot)
                .max()
                .map_or(0, |slot| slot + 1);
            let mut out = vec!["null".to_string(); width];
            let mut realms = Vec::new();
            let mut tree = Vec::new();
            let mut last = LAST_FRAME_DOCS.lock().unwrap();
            for frame in snapshots {
                let path = frame
                    .frame_path
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(".");
                let changed = match last.iter_mut().find(|(key, _, _)| key == &path) {
                    Some((_, old_generation, prev))
                        if *old_generation == frame.generation && *prev == frame.html =>
                    {
                        false
                    }
                    Some((_, old_generation, prev)) => {
                        *old_generation = frame.generation;
                        *prev = frame.html.clone();
                        true
                    }
                    None => {
                        last.push((path.clone(), frame.generation, frame.html.clone()));
                        true
                    }
                };
                let slot = frame
                    .slot
                    .map_or_else(|| "null".into(), |slot| slot.to_string());
                let path_json = serde_json::to_string(&frame.frame_path).unwrap_or_default();
                let parent_json = serde_json::to_string(&frame.parent_path).unwrap_or_default();
                let rect_json = serde_json::to_string(&frame.css_rect).unwrap_or_default();
                let html_json = changed
                    .then(|| json_str(&frame.html))
                    .unwrap_or_else(|| "null".into());
                tree.push(format!(
                    "{{\"framePath\":{path_json},\"parentPath\":{parent_json},\"slot\":{slot},\"generation\":{},\"cssRect\":{rect_json},\"html\":{html_json}}}",
                    frame.generation
                ));
                if frame.parent_path.is_empty() {
                    let Some(slot) = frame.slot else { continue };
                    realms.push(format!(
                        "{{\"slot\":{slot},\"framePath\":{path_json},\"generation\":{}}}",
                        frame.generation
                    ));
                    if changed {
                        out[slot] = json_str(&frame.html);
                    }
                }
            }
            (out, realms, tree)
        };

        let console: Vec<String> = page
            .take_console()
            .iter()
            .map(|(level, text)| format!("{{\"level\":\"{level}\",\"text\":{}}}", json_str(text)))
            .collect();
        let force = FORCE_CANVAS_FLUSH.swap(false, std::sync::atomic::Ordering::Relaxed);
        let now = Instant::now();
        let canvas_updates: Vec<String> = page
            .devview_canvas_manifest()
            .into_iter()
            .map(|meta| {
                let key = serde_json::to_string(&meta.key).unwrap_or_default();
                let send_png = {
                    let cache = LAST_CANVAS_REVISIONS.lock().unwrap();
                    match cache.get(&key) {
                        None => true,
                        Some((revision, sent_at)) => {
                            force
                                || (*revision != meta.revision
                                    && now.duration_since(*sent_at) >= Duration::from_millis(66))
                        }
                    }
                };
                let png = send_png
                    .then(|| page.devview_canvas_png(&meta.key, meta.revision))
                    .flatten();
                if let Some(ref png) = png {
                    trace_canvas_update(page, &meta, png);
                }
                if png.is_some() {
                    LAST_CANVAS_REVISIONS
                        .lock()
                        .unwrap()
                        .insert(key, (meta.revision, now));
                }
                format!(
                    "{{\"meta\":{},\"png\":{}}}",
                    serde_json::to_string(&meta).unwrap_or_else(|_| "null".into()),
                    png.as_deref()
                        .map(json_str)
                        .unwrap_or_else(|| "null".into())
                )
            })
            .collect();
        let _ = events.send(format!(
            "{{\"kind\":\"snapshot\",\"inspect\":{ins},\"net\":{},\"console\":[{}],\
             \"frameDocs\":[{}],\"frameRealms\":[{}],\"frameTree\":[{}],\"canvasUpdates\":[{}],\"data\":{json}}}",
            drain_netlog(),
            console.join(","),
            frame_docs.join(","),
            frame_realms.join(","),
            frame_tree.join(","),
            canvas_updates.join(",")
        ));
    }
}

fn trace_canvas_update(
    page: &mut browser_oxide::Page,
    meta: &browser_oxide::DevviewCanvasMeta,
    png: &str,
) {
    if std::env::var_os("BROWSER_OXIDE_FRAME_TRACE").is_none() {
        return;
    }
    let hash = png.bytes().fold(2166136261u32, |hash, byte| {
        (hash ^ byte as u32).wrapping_mul(16777619)
    });
    let detail = serde_json::json!({
        "kind": "canvas",
        "event": "revision",
        "revision": meta.revision,
        "pngHash": format!("{hash:08x}"),
        "pngBytes": png.len(),
        "backingSize": meta.backing_size,
        "cssRect": meta.css_rect,
        "viewport": meta.viewport,
        "dpr": meta.dpr,
    });
    let js = format!(
        "(function(){{var ns={NS_RESOLVE};if(ns&&ns.trace)ns.trace.record('canvas revision',{});}})()",
        detail
    );
    if meta.key.frame_path.is_empty() {
        let _ = page.evaluate(&js);
    } else {
        let _ = page.devview_evaluate_in_frame(&meta.key.frame_path, meta.key.generation, &js);
    }
}

/// Records not yet sent, as a JSON array. The page-side `__fetchLog` only ever
/// saw `fetch()`, so scripts, stylesheets, iframe documents and XHR were all
/// invisible — exactly the traffic worth watching when a third-party widget
/// fails to boot. `net::netlog` records at the HTTP client instead.
fn drain_netlog() -> String {
    static SEEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let from = SEEN.load(std::sync::atomic::Ordering::Relaxed);
    let recs = browser_oxide::net::netlog::since(from);
    if let Some(last) = recs.last() {
        SEEN.store(last.seq + 1, std::sync::atomic::Ordering::Relaxed);
    }
    let items: Vec<String> = recs
        .iter()
        .map(|r| {
            let pairs = |list: &[(String, String)]| -> String {
                list.iter()
                    .map(|(k, v)| format!("[{},{}]", json_str(k), json_str(v)))
                    .collect::<Vec<_>>()
                    .join(",")
            };
            let hdrs = pairs(&r.headers);
            let req_hdrs = pairs(&r.req_headers);
            format!(
                "{{\"seq\":{},\"method\":{},\"url\":{},\"status\":{},\"kind\":{},\
                 \"mime\":{},\"size\":{},\"headers\":[{}],\"body\":{},\
                 \"reqHeaders\":[{}],\"reqSize\":{},\"reqBodyTruncated\":{},\"reqBody\":{}}}",
                r.seq,
                json_str(&r.method),
                json_str(&r.url),
                r.status,
                json_str(r.kind),
                json_str(&r.mime),
                r.size,
                hdrs,
                json_str(&r.body),
                req_hdrs,
                r.req_size,
                r.req_body_truncated,
                json_str(&r.req_body)
            )
        })
        .collect();
    format!("[{}]", items.join(","))
}

/// Quote a string as JSON.
///
/// Only backslash, quote and newline used to be escaped, and carriage returns
/// were dropped outright — every other control character went out raw. A page
/// whose markup or whose response body contains a tab, a form feed or a stray
/// `\x0b` — minified bundles are full of them — produced a payload the viewer
/// could not parse at all: "Bad control character in string literal in JSON",
/// and the whole snapshot was lost rather than one field.
fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            // Everything below 0x20 has to be escaped, and so do the lone
            // surrogates' worth of unprintables JSON refuses.
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Park the settled value of an async action so the loop can poll for it: humanized
/// input returns a Promise and `evaluate` would only ever see "[object Promise]".
fn wrap_action(inner: &str) -> String {
    // Parked on the engine's internal namespace rather than a global slot: a
    // symbol on `window` is visible to `Object.getOwnPropertySymbols`, and this
    // tool has no business adding one to a page it is meant to observe.
    format!(
        "(function(){{var ns={NS_RESOLVE}||{{}};ns.devviewResult='выполняется…';\
         var r=({inner});\
         if(r&&typeof r.then==='function'){{\
           r.then(function(v){{ns.devviewResult=String(v);}},\
                  function(e){{ns.devviewResult='ошибка: '+e.message;}});\
           return 'запущено';}}\
         ns.devviewResult=String(r);return String(r);}})()"
    )
}

/// Whitespace-tolerant read of one JSON string field, with escapes decoded.
///
/// Splitting on the next bare `"` and handing the slice straight to V8 was wrong in
/// both directions: it truncated any value containing a quote, and it passed `\n`
/// through as a literal backslash-n, which is a syntax error outside a string
/// literal. Multi-line JS sent to the `eval`/`frame` actions therefore failed to
/// compile and read as an engine defect rather than a transport one.
/// One step of a raw pointer gesture, replayed in the engine.
///
/// The viewer forwards its own `pointerdown`/`pointermove`/`pointerup` instead
/// of a synthesised click, because a drag cannot be expressed as one: hCaptcha's
/// "drag each shape to its matching outline" needs a press, a path, and a
/// release on two different elements.
///
/// The target is named by selector plus an offset inside it, not by viewport
/// coordinates. The mirror lays the document out at its own width, so its pixel
/// positions are not the engine's; an element-relative offset survives that.
///
/// Events are minted trusted where the realm still exposes the marker — the top
/// page hands it to humanize.js, which captures and revokes it, so there the
/// engine's own input API is used instead.
const POINTER_JS: &str = r#"(function(){
  var canvasId = Number('__CANVAS_ID__');
  var rawU = __U__, rawV = __V__;
  if (typeof rawU !== 'number' || typeof rawV !== 'number'
      || !Number.isFinite(rawU) || !Number.isFinite(rawV)) return 'некорректные координаты';
  var u = Math.max(0, Math.min(1, rawU));
  var v = Math.max(0, Math.min(1, rawV));
  var vw = Math.max(1, Number(globalThis.innerWidth) || 1);
  var vh = Math.max(1, Number(globalThis.innerHeight) || 1);
  var el, x, y;
  if (canvasId >= 0) {
    el = [].find.call(document.querySelectorAll('canvas'), function(c){ return (c._canvasId|0) === canvasId; });
    if (!el) return 'нет элемента';
    // A canvas's own box, not the frame's: drawImage-space math needs offsets
    // relative to the surface itself.
    var r = el.getBoundingClientRect();
    x = r.left + u * r.width;
    y = r.top + v * r.height;
  } else {
    // Position, not a stale selector, finds the target here.
    //
    // `__SEL__` is a `:nth-of-type` path computed against the *mirror's*
    // snapshot of the DOM, moments before this runs against the *engine's*
    // own, independently-mutating copy. hCaptcha's widgets mutate constantly
    // — an error banner, a class toggle, anything that changes a sibling
    // count anywhere in the ancestor chain — and every `:nth-of-type(n)`
    // after that point then names a different element than the one the
    // mirror saw. A click on Verify landed on a grid tile three levels down
    // a path that had quietly gone stale. `u`/`v` here are normalized against
    // the frame's own viewport (matching how the mirror computed them), so
    // the live element under that point — found fresh, the same way a real
    // click would hit-test — is what actually receives the gesture. The
    // selector survives only as a fallback for the rare page where the exact
    // point is occluded by something `elementFromPoint` prefers.
    x = u * vw;
    y = v * vh;
    try { el = document.elementFromPoint(x, y); } catch (e) { el = null; }
    // `<body>`/`<html>` itself is never really the target — real content
    // covers that whole area, so landing there means `u`/`v` (fractions of
    // the *mirror's* own rendered width) missed this page's actual layout —
    // the mirror panel and this page's real viewport can differ sharply in
    // both size and aspect ratio, and CSS that reflows differently at each
    // width puts the same fraction over different content. The selector,
    // computed at click time against the mirror's own DOM shape, still names
    // the right element even when the coordinate doesn't.
    if (!el || el === document.body || el === document.documentElement) {
      try { var bySel = document.querySelector(`__SEL__`); if (bySel) el = bySel; } catch (e2) {}
    }
    if (!el) return 'нет элемента';
  }
  // Event coordinates are CSS viewport pixels. Clamp after converting the
  // mirror offset: neither a canvas backing-store coordinate nor a stale mirror
  // rect may place a pointer outside the browser profile's viewport.
  x = Math.max(0, Math.min(vw - 1, x));
  y = Math.max(0, Math.min(vh - 1, y));
  var ns = (function(){try{var s=Object.getOwnPropertySymbols(globalThis);
      for(var i=0;i<s.length;i++){var v=globalThis[s[i]];if(v&&v.__bo)return v;}}catch(e){}return null;})();
  var mark = (typeof globalThis.__bo_mark_trusted === 'function')
      ? globalThis.__bo_mark_trusted
      : ((ns && ns.input && typeof ns.input.mark === 'function') ? ns.input.mark : null);
  var st = ns ? (ns.__drag || (ns.__drag = {})) : {};
  function underPointer() {
    // Same body/html distrust as the initial resolution above — this re-runs
    // the live hit-test on every phase (down/move/up), so a coordinate that
    // missed once misses identically each time without this check.
    try {
      var hit = document.elementFromPoint(x, y);
      return (hit && hit !== document.body && hit !== document.documentElement) ? hit : el;
    } catch (e) { return el; }
  }
  function fire(type, Ctor, receiver) {
    var isMove = type === 'pointermove' || type === 'mousemove';
    var isRelease = type === 'pointerup' || type === 'mouseup';
    var isPress = type === 'pointerdown' || type === 'mousedown';
    var prev = st.at || { x: x, y: y };
    var buttons = isRelease ? 0 : (isMove ? (st.down ? 1 : 0) : (isPress ? 1 : 0));
    var init = { bubbles: true, cancelable: true, view: globalThis,
                 clientX: Math.round(x), clientY: Math.round(y),
                 screenX: Math.round((Number(globalThis.screenX) || 0) + x),
                 screenY: Math.round((Number(globalThis.screenY) || 0) + y),
                 movementX: Math.round(x - prev.x), movementY: Math.round(y - prev.y),
                 button: isMove && Ctor === globalThis.PointerEvent ? -1 : 0,
                 buttons: buttons };
    if (type === 'pointerenter' || type === 'mouseenter') init.bubbles = false;
    if (Ctor === globalThis.PointerEvent) {
      init.pointerId = 1; init.pointerType = 'mouse'; init.isPrimary = true;
      init.width = 1; init.height = 1; init.pressure = init.buttons ? 0.5 : 0;
    }
    var ev;
    try { ev = new Ctor(type, init); } catch (e) { return; }
    if (mark) { try { mark(ev); } catch (e) {} }
    try { (receiver || underPointer() || el).dispatchEvent(ev); } catch (e) {}
  }
  var P = globalThis.PointerEvent || globalThis.MouseEvent;
  var phase = '__PHASE__';

  if (phase === 'down') {
    var target = underPointer();
    fire('pointerover', P, target); fire('pointerenter', P, target);
    fire('mouseover', globalThis.MouseEvent, target); fire('mouseenter', globalThis.MouseEvent, target);
    fire('pointermove', P, target); fire('mousemove', globalThis.MouseEvent, target);
    st.down = { x: x, y: y, target: target, dragged: false };
    fire('pointerdown', P, target); fire('mousedown', globalThis.MouseEvent, target);
    try { target.focus && target.focus(); } catch (e) {}
  } else if (phase === 'move') {
    var moved = st.down && Math.hypot(x - st.down.x, y - st.down.y) > 4;
    if (moved) st.down.dragged = true;
    var target = underPointer();
    fire('pointermove', P, target); fire('mousemove', globalThis.MouseEvent, target);
  } else {
    var target = underPointer();
    var down = st.down;
    fire('pointerup', P, target); fire('mouseup', globalThis.MouseEvent, target);
    // A canvas is one DOM element for every tile, so exact-target equality
    // still catches a completed drag from one tile onto another. But a real
    // click's up doesn't always hit-test to the literal same element as its
    // down — a button's inner label span, an icon glyph, a hair of sub-pixel
    // jitter — and the browser fires `click` there too, provided the two are
    // on the same ancestor chain. Requiring strict `===` silently ate exactly
    // that case: down on a `<button>`, up one DOM level in on its label.
    var related = down && (down.target === target
      || (down.target.contains && down.target.contains(target))
      || (target.contains && target.contains(down.target)));
    if (down && !down.dragged && related) {
      fire('click', globalThis.MouseEvent, target);
    }
    st.down = null;
  }
  st.at = { x: x, y: y };
  if (ns && ns.trace && ns.trace.record) {
    try { ns.trace.record('pointer transport', {
      kind:'input', phase:phase, uv:[u,v], client:[x,y],
      backing:[u * (Number(el.width)||r.width), v * (Number(el.height)||r.height)],
      screen:[(Number(globalThis.screenX)||0)+x,(Number(globalThis.screenY)||0)+y],
      target:(underPointer().id ? '#'+underPointer().id : underPointer().tagName),
      buttons:phase==='up'?0:(st.down?1:0), hitTest:true
    }); } catch (_) {}
  }
  return phase + ' @' + Math.round(x) + ',' + Math.round(y)
    + ' → ' + (el.id ? '#' + el.id : el.tagName.toLowerCase())
    + (mark ? ' [trusted]' : ' [untrusted]');
})()"#;

/// One keystroke, replayed in the engine.
///
/// Forwarded as it happens rather than as a finished string: a field that
/// reacts per character — validation, masking, an autocomplete that fires on
/// `input` — behaves differently when handed the whole value at once.
///
/// The target is the engine's own `activeElement`, not the mirror's: focus
/// lives in the engine, and the mirror is a copy that gets rebuilt underneath.
/// On `keydown` of a printable key the value is edited at the caret and
/// `beforeinput`/`input` are fired, which is what a real keystroke does — a
/// bare `KeyboardEvent` changes no text at all.
const KEY_JS: &str = r#"(function(){
  var sel = `__SEL__`;
  var el = sel ? document.querySelector(sel) : (document.activeElement || document.body);
  if (!el) return 'нет цели';
  var key = `__KEY__`, code = `__CODE__`, phase = '__PHASE__';
  var ns = (function(){try{var s=Object.getOwnPropertySymbols(globalThis);
      for(var i=0;i<s.length;i++){var v=globalThis[s[i]];if(v&&v.__bo)return v;}}catch(e){}return null;})();
  var mark = (typeof globalThis.__bo_mark_trusted === 'function')
      ? globalThis.__bo_mark_trusted
      : ((ns && ns.input && typeof ns.input.mark === 'function') ? ns.input.mark : null);
  function fire(type, Ctor, init) {
    var ev;
    try { ev = new Ctor(type, init); } catch (e) { return true; }
    if (mark) { try { mark(ev); } catch (e) {} }
    try { return el.dispatchEvent(ev); } catch (e) { return true; }
  }
  // A keystroke that arrives at a field nobody ever moved to or clicked is the
  // same tell as a press with no approach. If the target is not already
  // focused, focus it the way a person would: the pointer path lands there
  // first. Only the first key of a burst pays this — afterwards the field is
  // already current.
  if (phase === 'down' && el !== document.activeElement && el.focus) {
    try {
      var r = el.getBoundingClientRect();
      var pos = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      var ns2 = ns || {};
      var seat = ns2.__drag || (ns2.__drag = {});
      var from = seat.at || { x: pos.x - 160, y: pos.y - 90 };
      var steps = 10;
      for (var i2 = 1; i2 <= steps; i2++) {
        var t2 = i2 / steps, e2 = 1 - Math.pow(1 - t2, 3);
        var mx = from.x + (pos.x - from.x) * e2 + (Math.random() - 0.5) * 1.2;
        var my = from.y + (pos.y - from.y) * e2 + (Math.random() - 0.5) * 1.2;
        var mi = { bubbles: true, cancelable: true, view: globalThis,
                   clientX: Math.round(mx), clientY: Math.round(my), button: -1, buttons: 0 };
        try {
          var mv = new globalThis.MouseEvent('mousemove', mi);
          if (mark) mark(mv);
          (document.elementFromPoint(mx, my) || el).dispatchEvent(mv);
        } catch (e) {}
      }
      seat.at = pos;
      var ci = { bubbles: true, cancelable: true, view: globalThis,
                 clientX: Math.round(pos.x), clientY: Math.round(pos.y), button: 0, buttons: 1 };
      ['mousedown', 'mouseup', 'click'].forEach(function (t3) {
        try {
          var ev3 = new globalThis.MouseEvent(t3, t3 === 'mouseup' ? Object.assign({}, ci, { buttons: 0 }) : ci);
          if (mark) mark(ev3);
          el.dispatchEvent(ev3);
        } catch (e) {}
      });
      el.focus();
    } catch (e) {}
  }

  var kinit = { key: key, code: code, bubbles: true, cancelable: true, view: globalThis,
                ctrlKey: __CTRL__, altKey: __ALT__, shiftKey: __SHIFT__, metaKey: __META__ };
  if (phase === 'up') { fire('keyup', globalThis.KeyboardEvent, kinit); return 'keyup ' + key; }

  var notPrevented = fire('keydown', globalThis.KeyboardEvent, kinit);
  var tag = (el.tagName || '').toLowerCase();
  var editable = (tag === 'input' || tag === 'textarea');
  if (!notPrevented || !editable) return 'keydown ' + key + (editable ? ' (отменён)' : '');

  var val = String(el.value == null ? '' : el.value);
  var start = el.selectionStart == null ? val.length : el.selectionStart;
  var end = el.selectionEnd == null ? start : el.selectionEnd;
  var next = null, itype = 'insertText', data = null;
  if (key.length === 1 && !__CTRL__ && !__META__) {
    next = val.slice(0, start) + key + val.slice(end); data = key;
    start = start + 1;
  } else if (key === 'Backspace') {
    itype = 'deleteContentBackward';
    if (end > start) { next = val.slice(0, start) + val.slice(end); }
    else if (start > 0) { next = val.slice(0, start - 1) + val.slice(start); start = start - 1; }
  } else if (key === 'Delete') {
    itype = 'deleteContentForward';
    if (end > start) { next = val.slice(0, start) + val.slice(end); }
    else { next = val.slice(0, start) + val.slice(start + 1); }
  }
  if (next === null) return 'keydown ' + key;
  if (fire('beforeinput', globalThis.InputEvent || globalThis.Event,
           { inputType: itype, data: data, bubbles: true, cancelable: true })) {
    // Through the prototype setter, the way a framework-wrapped field expects
    // its value to arrive.
    var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (d && d.set) { d.set.call(el, next); } else { el.value = next; }
    try { el.setSelectionRange(start, start); } catch (e) {}
    fire('input', globalThis.InputEvent || globalThis.Event,
         { inputType: itype, data: data, bubbles: true, cancelable: false });
  }
  return 'keydown ' + key + ' → ' + JSON.stringify(String(el.value)).slice(0, 40);
})()"#;

/// Inline everything the mirror cannot resolve on its own.
///
/// The mirror is markup rendered by the viewer's browser, so a `blob:` URL —
/// how a page shows an image it fetched itself, and how hCaptcha delivers its
/// tile art — points at an object that exists only inside this engine. Those
/// references are rewritten to `data:` before serialising: backgrounds onto a
/// `data-bo-bg` attribute the view reads, `<img>` sources in place.
///
/// Bounded, and restored afterwards: the page must not observe either change.
const INLINE_BLOBS_FN: &str = r#"
  function __boInlineBlobs() {
    var undo = [];
    var budget = 30;
    var cache = {};
    function toData(u) {
      if (cache[u] !== undefined) return cache[u];
      var out = '';
      try { out = Deno.core.ops.op_blob_data_url(u) || ''; } catch (e) { out = ''; }
      cache[u] = out;
      return out;
    }
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length && budget > 0; i++) {
      var el = all[i];
      // <img src="blob:…">
      try {
        var src = el.tagName === 'IMG' ? el.getAttribute('src') : null;
        if (src && src.indexOf('blob:') === 0) {
          var d = toData(src);
          if (d) { el.setAttribute('src', d); undo.push([el, 'src', src]); budget--; }
        }
      } catch (e) {}
      // background-image: url(blob:…)
      try {
        var css = getComputedStyle(el);
        var bg = css.backgroundImage;
        if (bg && bg !== 'none') {
          var rect = el.getBoundingClientRect();
          var width = rect.width || parseFloat(css.width) || 0;
          var height = rect.height || parseFloat(css.height) || 0;
          // A positioned background sprite can have a valid used size even
          // while our layout box is still zero. Prefer its explicit CSS size;
          // hCaptcha's square tiles also publish that size in background-size.
          if (!height) {
            var size = /^([\d.]+)px(?:\s+([\d.]+)px)?/.exec(css.backgroundSize || '');
            if (size) height = parseFloat(size[2] || size[1]) || 0;
          }
          if (width > 0 || height > 0) {
            var oldBox = el.getAttribute('data-bo-box');
            el.setAttribute('data-bo-box', Math.round(width) + ',' + Math.round(height));
            undo.push([el, 'data-bo-box', oldBox]);
          }
        }
        if (bg && bg.indexOf('blob:') >= 0) {
          var m = /url\(["']?(blob:[^"')]+)["']?\)/.exec(bg);
          if (m) {
            var dd = toData(m[1]);
            if (dd) {
              el.setAttribute('data-bo-bg', dd);
              undo.push([el, 'data-bo-bg', null]);
              budget--;
            }
          }
        }
      } catch (e) {}
    }
    return undo;
  }
  function __boUndoBlobs(undo) {
    for (var i = 0; i < undo.length; i++) {
      var el = undo[i][0], attr = undo[i][1], prev = undo[i][2];
      try {
        if (prev === null) el.removeAttribute(attr);
        else el.setAttribute(attr, prev);
      } catch (e) {}
    }
  }
"#;

/// Serialise document structure only. Canvas pixels travel independently in
/// `canvasUpdates`, keyed by backing-surface revision.
const SERIALIZE_WITH_CANVAS_BODY: &str = r#"(function(){
  __BLOBS__
  var blobUndo = __boInlineBlobs();
  var frames = document.querySelectorAll('iframe'), tagged = [];
  for (var i = 0; i < frames.length; i++) {
    try { frames[i].setAttribute('data-bo-frame', String(i)); tagged.push(frames[i]); } catch (_) {}
  }
  var html = document.documentElement.outerHTML;
  __boUndoBlobs(blobUndo);
  for (var j = 0; j < tagged.length; j++) {
    try { tagged[j].removeAttribute('data-bo-frame'); } catch (_) {}
  }
  return html;
})()"#;

fn serialize_js() -> String {
    SERIALIZE_WITH_CANVAS_BODY.replace("__BLOBS__", INLINE_BLOBS_FN)
}

/// Minimal base64 decode for the canvas snapshot command.
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut rev = [255u8; 256];
    for (i, c) in T.iter().enumerate() {
        rev[*c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for b in s.bytes() {
        if b == b'=' || b == b'\n' || b == b'\r' {
            continue;
        }
        let v = rev[b as usize];
        if v == 255 {
            return None;
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// Map the viewer's frame number — a position among the top document's
/// `<iframe>` elements — onto an index into the materialized child realms.
///
/// The two orders are not the same. A page can hold `<iframe>`s that were never
/// materialized (no `src`, `javascript:`, CSP-blocked), so the n-th element is
/// not the n-th realm: on Epic's login the challenge is element 2 but realm 1,
/// and a click aimed at it answered "нет фрейма 2". Falls back to treating the
/// number as a realm index, which keeps the older commands working.
fn realm_for_dom_slot(page: &mut browser_oxide::Page, wanted: usize) -> usize {
    let slots = page.child_frame_dom_slots();
    for (realm_idx, (_node, slot)) in slots.iter().enumerate() {
        if *slot == Some(wanted) {
            return realm_idx;
        }
    }
    wanted
}

fn parse_surface_key(raw: &str) -> Option<browser_oxide::DevviewCanvasKey> {
    let mut parts = raw.split('~');
    let path = parts.next()?;
    let generation = parts.next()?.parse().ok()?;
    let canvas_id = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let frame_path = if path.is_empty() {
        Vec::new()
    } else {
        path.split('.')
            .map(str::parse)
            .collect::<Result<_, _>>()
            .ok()?
    };
    Some(browser_oxide::DevviewCanvasKey {
        frame_path,
        generation,
        canvas_id,
    })
}

fn field(raw: &str, key: &str) -> String {
    // The quoted name must be followed by `:`, or the scan matches the same text
    // appearing as a *value*: `{"action":"key","key":"a"}` split on the first
    // `"key"` — the one inside `"action":"key"` — and returned nothing at all,
    // so every keystroke arrived with an empty key.
    let needle = format!("\"{key}\"");
    let mut from = 0usize;
    let rest = loop {
        let Some(hit) = raw[from..].find(&needle) else {
            return String::new();
        };
        let after = from + hit + needle.len();
        let tail = raw[after..].trim_start();
        if let Some(t) = tail.strip_prefix(':') {
            break t;
        }
        from = after;
    };
    let rest = rest.trim_start();
    let Some(rest) = rest.strip_prefix('"') else {
        // A bare JSON value — number, `true`, `null`. This used to return the
        // empty string, so `{"action":"frame","index":1}` parsed as index 0 and
        // every frame command silently evaluated in the *first* child realm.
        // A caller comparing realms then saw them all report the same document
        // and concluded the realms were wrong, when only the parse was.
        let end = rest.find([',', '}']).unwrap_or(rest.len());
        return rest[..end].trim().to_string();
    };

    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => break,
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('r') => out.push('\r'),
                Some('u') => {
                    let hex: String = chars.by_ref().take(4).collect();
                    match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                        Some(ch) => out.push(ch),
                        None => out.push_str(&hex),
                    }
                }
                Some(other) => out.push(other),
                None => break,
            },
            _ => out.push(c),
        }
    }
    out
}

/// Turns `{"action":…,"sel":…,"text":…}` into the JS that performs it.
/// Selector-based on purpose: engine layout coordinates are not trustworthy yet.
fn action_to_js(raw: &str) -> String {
    // Values land inside backtick templates below, so escape what a template would
    // otherwise eat. Decoding is `field`'s job — this used to carry a second, cruder
    // copy of it that truncated at the first quote and left `\n` literal.
    let get = |key: &str| -> String {
        field(raw, key)
            .replace('\\', "\\\\")
            .replace('`', "\\`")
            .replace("${", "\\${")
    };
    let (action, sel, text) = (get("action"), get("sel"), get("text"));
    match action.as_str() {
        "inspect" => format!(
            "(function(){{var e=document.querySelector(`{sel}`);\
             if(!e)return JSON.stringify({{sel:`{sel}`,error:'нет элемента'}});\
             var c=getComputedStyle(e),r=e.getBoundingClientRect(),o={{}};\
             {INSPECT_PROPS}.forEach(function(p){{o[p]=String(c[p]);}});\
             return JSON.stringify({{sel:`{sel}`,\
               rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],\
               style:o}});}})()"
        ),
        // The humanized path travels the cursor, dwells, then presses — and mints the
        // events trusted. `element.click()` reports isTrusted=false, which is exactly
        // what vendor sensors read.
        "click" => format!(
            "(function(){{var e=document.querySelector(`{sel}`);if(!e)return 'нет элемента';\
             var h=({NS_RESOLVE}||{{}}).input;\
             if(h&&typeof h.clickElement==='function')return h.clickElement(e);\
             e.click();return 'клик (isTrusted=false — humanize не загружен)';}})()"
        ),
        "fill" => format!(
            "(function(){{var e=document.querySelector(`{sel}`);if(!e)return 'нет элемента';\
             var h=({NS_RESOLVE}||{{}}).input;\
             if(h&&typeof h.typeElement==='function')return h.typeElement(e,`{text}`);\
             var p=Object.getOwnPropertyDescriptor(e.constructor.prototype,'value');\
             if(p&&p.set){{p.set.call(e,`{text}`);}}else{{e.value=`{text}`;}}\
             e.dispatchEvent(new Event('input',{{bubbles:true}}));\
             return 'заполнено (humanize не загружен)';}})()"
        ),
        "eval" => text,
        other => format!("'неизвестное действие: {other}'"),
    }
}

#[cfg(test)]
mod tests {
    use super::{serialize_js, PAGE, POINTER_JS};

    #[test]
    fn canvas_substitution_is_not_applied_twice() {
        assert_eq!(
            PAGE.matches(r#"<canvas\b(?![^>]*data-bo-canvas)[^>]*>"#)
                .count(),
            2
        );
    }

    fn pointer(phase: &str, u: f64, v: f64) -> String {
        POINTER_JS
            .replace("__CANVAS_ID__", "-1")
            .replace("__SEL__", "#target")
            .replace("__U__", &u.to_string())
            .replace("__V__", &v.to_string())
            .replace("__PHASE__", phase)
    }

    #[tokio::test]
    async fn pointer_drag_has_approach_pressed_moves_and_no_click() {
        let mut page = browser_oxide::Page::from_html(
            r#"<div id="target" style="width:200px;height:100px"></div><script>
               globalThis.events=[];
               for(const type of ['pointermove','pointerdown','pointerup','click'])
                 document.getElementById('target').addEventListener(type,e=>events.push(type+':'+e.buttons));
               </script>"#,
            None::<browser_oxide::stealth::StealthProfile>,
        )
        .await
        .unwrap();
        page.evaluate(&pointer("move", 0.1, 0.5)).unwrap();
        page.evaluate(&pointer("down", 0.2, 0.5)).unwrap();
        page.evaluate(&pointer("move", 0.8, 0.5)).unwrap();
        page.evaluate(&pointer("up", 0.8, 0.5)).unwrap();
        let events = page.evaluate("JSON.stringify(events)").unwrap();
        assert_eq!(
            events,
            r#"["pointermove:0","pointermove:0","pointerdown:1","pointermove:1","pointerup:0"]"#
        );
    }

    #[tokio::test]
    async fn invalid_pointer_coordinates_are_not_dispatched_at_origin() {
        let mut page = browser_oxide::Page::from_html(
            r#"<div id="target" style="width:200px;height:100px"></div><script>
               globalThis.moves=0;
               document.getElementById('target').addEventListener('mousemove',()=>moves++);
               </script>"#,
            None::<browser_oxide::stealth::StealthProfile>,
        )
        .await
        .unwrap();
        assert_eq!(
            page.evaluate(&pointer("move", f64::NAN, 0.5)).unwrap(),
            "некорректные координаты"
        );
        assert_eq!(page.evaluate("String(moves)").unwrap(), "0");
    }

    #[tokio::test]
    async fn background_snapshot_carries_used_box_without_mutating_page() {
        let mut page = browser_oxide::Page::from_html(
            r#"<div id="image" style="width:120px;height:80px;background-image:url(data:image/png;base64,AA==)"></div>"#,
            None::<browser_oxide::stealth::StealthProfile>,
        )
        .await
        .unwrap();
        let html = page.evaluate(&serialize_js()).unwrap();
        assert!(html.contains(r#"data-bo-box="120,80""#), "{html}");
        assert_eq!(
            page.evaluate("document.querySelector('#image').getAttribute('data-bo-box')")
                .unwrap(),
            "null"
        );
    }

    #[tokio::test]
    async fn background_snapshot_recovers_zero_height_from_background_size() {
        let mut page = browser_oxide::Page::from_html(
            r#"<div id="image" style="position:absolute;width:120px;height:0;background-image:url(data:image/png;base64,AA==);background-size:120px 120px"></div>"#,
            None::<browser_oxide::stealth::StealthProfile>,
        )
        .await
        .unwrap();
        let html = page.evaluate(&serialize_js()).unwrap();
        assert!(html.contains(r#"data-bo-box="120,120""#), "{html}");
    }
}

/// Static page only. Everything live goes over the socket.
async fn serve_http(port: u16, ws_port: u16) {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap_or_else(|e| panic!("devview: cannot bind port {port}: {e}"));
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                continue;
            };
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                if sock.read(&mut buf).await.is_err() {
                    return;
                }
                let body = PAGE.replace("__WS_PORT__", &ws_port.to_string());
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
                     Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            });
        }
    });
}

async fn serve_ws(
    port: u16,
    events: broadcast::Sender<String>,
    cmds: mpsc::UnboundedSender<String>,
) {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap_or_else(|e| panic!("devview: cannot bind ws port {port}: {e}"));
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let mut rx = events.subscribe();
            let cmds = cmds.clone();
            tokio::spawn(async move {
                use futures_util::{SinkExt, StreamExt};
                let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
                    return;
                };
                let (mut sink, mut source) = ws.split();
                let pump = async {
                    while let Ok(msg) = rx.recv().await {
                        if sink
                            .send(tokio_tungstenite::tungstenite::Message::text(msg))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                };
                let intake = async {
                    while let Some(Ok(msg)) = source.next().await {
                        if let tokio_tungstenite::tungstenite::Message::Text(t) = msg {
                            let _ = cmds.send(t.to_string());
                        }
                    }
                };
                tokio::select! { _ = pump => {}, _ = intake => {} }
            });
        }
    });
}
