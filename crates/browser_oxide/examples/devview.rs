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
  var bo = globalThis.__bo_input_events || null;
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
  return JSON.stringify({
    url: location.href,
    title: document.title,
    html: document.documentElement.outerHTML,
    actionables: acts,
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

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let url = args.next().expect("usage: devview <url> [port]");
    let port: u16 = args.next().and_then(|p| p.parse().ok()).unwrap_or(7333);
    let ws_port = port + 1;

    browser_oxide::net::netlog::enable();

    let inspect: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    // Events fan out to every connected view; commands funnel back to the engine.
    let (events_tx, _) = broadcast::channel::<String>(1024);
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<String>();

    serve_http(port, ws_port).await;
    serve_ws(ws_port, events_tx.clone(), cmd_tx).await;

    let open_url = format!("http://127.0.0.1:{port}/");
    println!("devview: {open_url}  (события: ws://127.0.0.1:{ws_port})");
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    let _ = std::process::Command::new(opener).arg(&open_url).spawn();

    let emit = {
        let tx = events_tx.clone();
        move |kind: &str, payload: String| {
            let _ = tx.send(format!("{{\"kind\":\"{kind}\",{payload}}}"));
        }
    };

    let profile = browser_oxide::stealth::presets::chrome_148_macos();
    let started = std::time::Instant::now();
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async move {
            emit("status", "\"text\":\"навигация…\"".into());
            // Pooled navigation: measured on this URL the pool renders the same page
            // in ~4 s where the cold path spends ~25 s waiting on deadline floors.
            let pool = browser_oxide::PagePool::new(1);
            if let Ok(seed) = pool.acquire(Some(profile.clone())).await {
                pool.release(seed);
            }
            let mut page = match pool.navigate(&url, profile).await {
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
                    // `frame` evaluates inside a child realm instead of the page —
                    // the only way to see why a third-party widget's own document
                    // (hCaptcha's, here) does or does not finish booting.
                    if raw.contains("\"frame\"") {
                        let idx: usize = field(&raw, "index").parse().unwrap_or(0);
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
                            let r = page.evaluate("globalThis.__boResult").unwrap_or_default();
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

                // Short slice keeps the cursor overlay smooth and actions responsive.
                let _ = page
                    .evaluate_async("void 0", std::time::Duration::from_millis(120))
                    .await;
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
        let console: Vec<String> = page
            .take_console()
            .iter()
            .map(|(level, text)| format!("{{\"level\":\"{level}\",\"text\":{}}}", json_str(text)))
            .collect();
        let _ = events.send(format!(
            "{{\"kind\":\"snapshot\",\"inspect\":{ins},\"net\":{},\"console\":[{}],\"data\":{json}}}",
            drain_netlog(),
            console.join(",")
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
            let hdrs: Vec<String> = r
                .headers
                .iter()
                .map(|(k, v)| format!("[{},{}]", json_str(k), json_str(v)))
                .collect();
            format!(
                "{{\"seq\":{},\"method\":{},\"url\":{},\"status\":{},\"kind\":{},\
                 \"mime\":{},\"size\":{},\"headers\":[{}],\"body\":{}}}",
                r.seq,
                json_str(&r.method),
                json_str(&r.url),
                r.status,
                json_str(r.kind),
                json_str(&r.mime),
                r.size,
                hdrs.join(","),
                json_str(&r.body)
            )
        })
        .collect();
    format!("[{}]", items.join(","))
}

fn json_str(s: &str) -> String {
    let escaped = s
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "");
    format!("\"{escaped}\"")
}

/// Park the settled value of an async action so the loop can poll for it: humanized
/// input returns a Promise and `evaluate` would only ever see "[object Promise]".
fn wrap_action(inner: &str) -> String {
    format!(
        "(function(){{globalThis.__boResult='выполняется…';\
         var r=({inner});\
         if(r&&typeof r.then==='function'){{\
           r.then(function(v){{globalThis.__boResult=String(v);}},\
                  function(e){{globalThis.__boResult='ошибка: '+e.message;}});\
           return 'запущено';}}\
         globalThis.__boResult=String(r);return String(r);}})()"
    )
}

/// Whitespace-tolerant read of one JSON string field, with escapes decoded.
///
/// Splitting on the next bare `"` and handing the slice straight to V8 was wrong in
/// both directions: it truncated any value containing a quote, and it passed `\n`
/// through as a literal backslash-n, which is a syntax error outside a string
/// literal. Multi-line JS sent to the `eval`/`frame` actions therefore failed to
/// compile and read as an engine defect rather than a transport one.
fn field(raw: &str, key: &str) -> String {
    let needle = format!("\"{key}\"");
    let Some(rest) = raw.split_once(&needle).map(|(_, r)| r) else {
        return String::new();
    };
    let rest = rest.trim_start();
    let Some(rest) = rest.strip_prefix(':') else {
        return String::new();
    };
    let rest = rest.trim_start();
    let Some(rest) = rest.strip_prefix('"') else {
        return String::new();
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
             var h=globalThis.__bo_input_events;\
             if(h&&typeof h.clickElement==='function')return h.clickElement(e);\
             e.click();return 'клик (isTrusted=false — humanize не загружен)';}})()"
        ),
        "fill" => format!(
            "(function(){{var e=document.querySelector(`{sel}`);if(!e)return 'нет элемента';\
             var h=globalThis.__bo_input_events;\
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
