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

use std::sync::{Arc, Mutex};
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
static LAST_FRAME_DOCS: Mutex<Vec<(u32, String)>> = Mutex::new(Vec::new());

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
  // Same canvas inlining as the frame path — see SERIALIZE_WITH_CANVAS.
  function __boSerialize() {
    var cs = document.querySelectorAll('canvas');
    var touched = [], budget = 4;
    for (var i = 0; i < cs.length && budget > 0; i++) {
      var c = cs[i];
      if ((c.width | 0) < 24 || (c.height | 0) < 24) continue;
      var url = '';
      try {
        // Bounded thumbnail, not the full surface: a full-resolution PNG of a
        // large canvas is hundreds of KB on every tick.
        var MAX = 320, cw = c.width | 0, chh = c.height | 0;
        var sc = Math.min(1, MAX / Math.max(cw, chh));
        var tw = Math.max(1, Math.round(cw * sc)), th = Math.max(1, Math.round(chh * sc));
        var t = document.createElement('canvas');
        t.width = tw; t.height = th;
        var xx = t.getContext('2d');
        xx.drawImage(c, 0, 0, cw, chh, 0, 0, tw, th);
        url = t.toDataURL();
      } catch (e) { continue; }
      if (!url || url.length < 32) continue;
      c.setAttribute('data-bo-shot', url);
      c.setAttribute('data-bo-cidx', String(i));
      c.setAttribute('data-bo-cw', String(c.width | 0));
      c.setAttribute('data-bo-ch', String(c.height | 0));
      touched.push(c);
      budget--;
    }
    var html = document.documentElement.outerHTML;
    for (var j = 0; j < touched.length; j++) {
      try {
      touched[j].removeAttribute('data-bo-shot');
      touched[j].removeAttribute('data-bo-cidx');
      touched[j].removeAttribute('data-bo-cw');
      touched[j].removeAttribute('data-bo-ch');
    } catch (e) {}
    }
    return html;
  }
  return JSON.stringify({
    url: location.href,
    title: document.title,
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

    serve_http(port, ws_port).await;
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
            // Challenge widgets are a lifecycle-sensitive path: a pooled navigation
            // can retain a prior document's state and intentionally skips the cold
            // challenge-follow loop. Devview is used to diagnose those widgets, so
            // it must reproduce a fresh browser navigation rather than optimize it.
            let mut page = match browser_oxide::Page::navigate_with_init(
                &url, profile, 4, init,
            )
            .await
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
                        let sel = field(&raw, "sel").replace('`', "\\`");
                        let ox = field(&raw, "ox");
                        let oy = field(&raw, "oy");
                        let rx = field(&raw, "rx");
                        let ry = field(&raw, "ry");
                        let idx_raw = field(&raw, "index");
                        let js = POINTER_JS
                            .replace("__CIDX__", &field(&raw, "cidx"))
                            .replace("__SEL__", &sel)
                            .replace("__OX__", if ox.is_empty() { "0" } else { &ox })
                            .replace("__OY__", if oy.is_empty() { "0" } else { &oy })
                            .replace("__RX__", if rx.is_empty() { "0" } else { &rx })
                            .replace("__RY__", if ry.is_empty() { "0" } else { &ry })
                            .replace("__PHASE__", &phase);
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
        let frame_docs: Vec<String> = {
            let slots = page.child_frame_dom_slots();
            let width = slots
                .iter()
                .filter_map(|(_, at)| *at)
                .max()
                .map_or(0, |m| m + 1);
            let mut out = vec!["null".to_string(); width];
            let mut last = LAST_FRAME_DOCS.lock().unwrap();
            for (realm, (node_id, at)) in slots.iter().enumerate() {
                let Some(at) = *at else { continue };
                let html = page
                    .child_iframe(realm)
                    .and_then(|c| c.evaluate(&serialize_js()).ok())
                    .unwrap_or_default();
                match last.iter_mut().find(|(id, _)| id == node_id) {
                    Some((_, prev)) if *prev == html => continue,
                    Some((_, prev)) => *prev = html.clone(),
                    None => last.push((*node_id, html.clone())),
                }
                out[at] = json_str(&html);
            }
            out
        };

        let console: Vec<String> = page
            .take_console()
            .iter()
            .map(|(level, text)| format!("{{\"level\":\"{level}\",\"text\":{}}}", json_str(text)))
            .collect();
        let _ = events.send(format!(
            "{{\"kind\":\"snapshot\",\"inspect\":{ins},\"net\":{},\"console\":[{}],\
             \"frameDocs\":[{}],\"data\":{json}}}",
            drain_netlog(),
            console.join(","),
            frame_docs.join(",")
        ));
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
                 \"reqHeaders\":[{}],\"reqBody\":{}}}",
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
  // A gesture aimed at a canvas arrives by index, not by selector: the mirror
  // draws a scaled <img> in its place, so a selector built there names a node
  // this document does not have.
  var cidx = '__CIDX__';
  var el = cidx !== ''
    ? document.querySelectorAll('canvas')[cidx | 0]
    : document.querySelector(`__SEL__`);
  if (!el) return 'нет элемента';
  var r = el.getBoundingClientRect();
  // A canvas gesture arrives in the bitmap's own pixels: the mirror shows a
  // scaled snapshot and scales the offsets back up by `data-bo-cw`/`ch`. A
  // selector gesture arrives in CSS pixels inside the element. A canvas is
  // normally sized in CSS and drawn at devicePixelRatio, so the two differ by
  // that factor — reading bitmap pixels as CSS pixels put every press near the
  // bottom-right corner or past the element entirely, so nothing inside the
  // canvas was ever hit and no drag could start.
  var kx = 1, ky = 1;
  if (cidx !== '' && el.width && el.height && r.width && r.height) {
    kx = r.width / el.width;
    ky = r.height / el.height;
  }
  // The mirror and engine have different viewport widths. For ordinary DOM
  // elements replay a relative point against the engine's computed box; canvas
  // gestures retain bitmap coordinates because the bitmap is the interaction
  // surface itself.
  var rx = Number(__RX__), ry = Number(__RY__);
  var x = cidx !== ''
    ? r.left + (__OX__) * kx
    : r.left + (isFinite(rx) ? Math.max(0, Math.min(1, rx)) * r.width : (__OX__));
  var y = cidx !== ''
    ? r.top + (__OY__) * ky
    : r.top + (isFinite(ry) ? Math.max(0, Math.min(1, ry)) * r.height : (__OY__));
  // Event coordinates are CSS viewport pixels. Clamp after converting the
  // mirror offset: neither a canvas backing-store coordinate nor a stale mirror
  // rect may place a pointer outside the browser profile's viewport.
  var vw = Math.max(1, Number(globalThis.innerWidth) || 1);
  var vh = Math.max(1, Number(globalThis.innerHeight) || 1);
  x = Math.max(0, Math.min(vw - 1, x));
  y = Math.max(0, Math.min(vh - 1, y));
  var ns = (function(){try{var s=Object.getOwnPropertySymbols(globalThis);
      for(var i=0;i<s.length;i++){var v=globalThis[s[i]];if(v&&v.__bo)return v;}}catch(e){}return null;})();
  var mark = (typeof globalThis.__bo_mark_trusted === 'function')
      ? globalThis.__bo_mark_trusted
      : ((ns && ns.input && typeof ns.input.mark === 'function') ? ns.input.mark : null);
  var st = ns ? (ns.__drag || (ns.__drag = {})) : {};
  function underPointer() {
    try { return document.elementFromPoint(x, y) || el; } catch (e) { return el; }
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
    st.down = { x: x, y: y, target: target, dragged: false };
    fire('pointerover', P, target); fire('pointerenter', P, target);
    fire('mouseover', globalThis.MouseEvent, target); fire('mouseenter', globalThis.MouseEvent, target);
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
    // A canvas is one DOM element for every tile. Compare geometry as well as
    // target identity so a completed canvas drag cannot turn into a click.
    if (down && !down.dragged && down.target === target) {
      fire('click', globalThis.MouseEvent, target);
    }
    st.down = null;
  }
  st.at = { x: x, y: y };
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

/// A canvas snapshot small enough to ship on every tick.
///
/// The full-resolution PNG of a captcha's 1000x940 surface is ~800 KB, and a
/// snapshot carrying one pushed the whole message past 1.4 MB — five times a
/// second, which the broadcast channel simply drops. This downscales to a
/// bounded width first: enough to see what the engine drew, ~40x smaller.
const CANVAS_THUMB_FN: &str = r#"
  function __boThumb(c) {
    var MAX = 320;
    var w = c.width | 0, h = c.height | 0;
    if (!w || !h) return '';
    var scale = Math.min(1, MAX / Math.max(w, h));
    var tw = Math.max(1, Math.round(w * scale));
    var th = Math.max(1, Math.round(h * scale));
    var t = document.createElement('canvas');
    t.width = tw; t.height = th;
    var x = t.getContext('2d');
    if (!x) return '';
    x.drawImage(c, 0, 0, w, h, 0, 0, tw, th);
    return t.toDataURL();
  }
"#;

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
        var bg = getComputedStyle(el).backgroundImage;
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

/// Serialise a document with every canvas' pixels inlined.
///
/// A `<canvas>` carries no markup: its bitmap lives in the engine, so the
/// mirror — which is HTML — always drew an empty box where the page has a
/// picture. Stamping `toDataURL()` onto the element as an attribute lets the
/// view swap in an `<img>` and show what the engine actually rendered.
///
/// Bounded on purpose: only canvases big enough to matter, and only a few of
/// them, because each PNG is a few hundred KB and this runs on every snapshot.
const SERIALIZE_WITH_CANVAS_BODY: &str = r#"(function(){
  __THUMB__
  var blobUndo = __boInlineBlobs();
  var cs = document.querySelectorAll('canvas');
  var touched = [];
  var budget = 4;
  for (var i = 0; i < cs.length && budget > 0; i++) {
    var c = cs[i];
    var w = c.width | 0, h = c.height | 0;
    if (w < 24 || h < 24) continue;
    var url = '';
    try { url = __boThumb(c); } catch (e) { continue; }
    if (!url || url.length < 32) continue;
    c.setAttribute('data-bo-shot', url);
    // Index among this document's canvases plus the intrinsic size: the view
    // needs both to aim a gesture back at the real element. The mirror shows a
    // scaled <img>, so a selector built there would name the wrong node and its
    // offsets would be in thumbnail pixels.
    c.setAttribute('data-bo-cidx', String(i));
    c.setAttribute('data-bo-cw', String(w));
    c.setAttribute('data-bo-ch', String(h));
    touched.push(c);
    budget--;
  }
  var html = document.documentElement.outerHTML;
  __boUndoBlobs(blobUndo);
  // The attribute is a view-only artefact — the page must never see it.
  for (var j = 0; j < touched.length; j++) {
    try { touched[j].removeAttribute('data-bo-shot'); } catch (e) {}
  }
  return html;
})()"#;

/// The frame serialiser with the thumbnail helper spliced in.
fn serialize_js() -> String {
    SERIALIZE_WITH_CANVAS_BODY.replace("__THUMB__", &format!("{CANVAS_THUMB_FN}{INLINE_BLOBS_FN}"))
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
