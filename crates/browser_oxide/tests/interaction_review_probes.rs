//! Diagnostic probes behind the review of page interaction, humanized input,
//! iframes and the devview transport. They assert nothing: each one drives the
//! engine the way a driver does and prints what a page (or its server) actually
//! observes, as `PROBE <name>: <json>`, so a finding can be re-checked after a
//! fix. Ignored by default because they only report.
//!
//!   cargo test -p browser_oxide --test interaction_review_probes -- \
//!       --ignored --test-threads=1 --nocapture

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const NS: &str = "(function(){try{var s=Object.getOwnPropertySymbols(globalThis,1);for(var i=0;i<s.length;i++){var v=globalThis[s[i]];if(v&&v.__bo)return v;}}catch(e){}return null;})()";
const HUMANIZE: &str = include_str!("../src/js/humanize.js");
const DEVVIEW_SRC: &str = include_str!("../examples/devview.rs");

fn report(name: &str, v: impl std::fmt::Display) {
    println!("PROBE {name}: {v}");
}

fn devview_js(name: &str) -> String {
    let pat = format!("const {name}: &str = r#\"");
    let s = DEVVIEW_SRC.find(&pat).expect("const in devview.rs") + pat.len();
    let e = DEVVIEW_SRC[s..].find("\"#;").expect("end of raw string");
    DEVVIEW_SRC[s..s + e].to_string()
}

/// Records every input-ish event at the document (capture) with the fields a
/// behavioural sensor reads.
const LOGGER: &str = r##"
globalThis.__log = [];
globalThis.__T0 = performance.now();
['pointerover','pointerenter','pointerout','pointerleave','pointermove','pointerdown','pointerup',
 'mouseover','mouseenter','mouseout','mouseleave','mousemove','mousedown','mouseup','click',
 'focus','blur','focusin','focusout','keydown','keypress','keyup','beforeinput','input','change',
 'wheel','scroll','submit'].forEach(function (t) {
  document.addEventListener(t, function (e) {
    var tg = e.target;
    __log.push({
      t: e.type, tr: e.isTrusted,
      tg: tg ? (tg.id || tg.tagName || (tg === document ? 'document' : '?')) : null,
      c: e.constructor && e.constructor.name,
      x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY, py: e.pageY,
      b: e.button, bs: e.buttons, d: e.detail, pid: e.pointerId, pt: e.pointerType,
      ts: +(e.timeStamp - __T0).toFixed(2),
      k: e.key, cd: e.code, kc: e.keyCode, w: e.which, cc: e.charCode, sh: e.shiftKey,
      it: e.inputType, dt: e.data,
      rt: e.relatedTarget ? (e.relatedTarget.id || e.relatedTarget.tagName) : null
    });
  }, true);
});
"##;

async fn page_with(body: &str) -> Page {
    let html = format!(
        "<!doctype html><html><head></head><body>{body}<script>{LOGGER}</script></body></html>"
    );
    Page::from_html_with_url(
        &html,
        "http://127.0.0.1:9/probe.html",
        Some(chrome_148_macos()),
    )
    .await
    .unwrap()
}

// ---------------------------------------------------------------------------
// Tiny HTTP server on its own OS thread (the engine has synchronous fetches that
// would deadlock a server sharing the test's current-thread runtime).
// ---------------------------------------------------------------------------
struct Server {
    port: u16,
    hits: Arc<Mutex<Vec<String>>>,
}

impl Server {
    fn hits_for(&self, path: &str) -> usize {
        self.hits
            .lock()
            .unwrap()
            .iter()
            .filter(|h| h.ends_with(path))
            .count()
    }
}

fn serve(routes: Vec<(&str, &str, String)>) -> Server {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let routes: Vec<(String, String, String)> = routes
        .into_iter()
        .map(|(p, c, b)| {
            (
                p.to_string(),
                c.to_string(),
                b.replace("{PORT}", &port.to_string()),
            )
        })
        .collect();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let h2 = hits.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let routes = routes.clone();
            let h = h2.clone();
            std::thread::spawn(move || {
                use std::io::{Read, Write};
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                loop {
                    match s.read(&mut tmp) {
                        Ok(0) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&tmp[..n]);
                            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                        Err(_) => return,
                    }
                }
                let req = String::from_utf8_lossy(&buf).to_string();
                let line = req.lines().next().unwrap_or("").to_string();
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                let host = req
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("host:"))
                    .map(|l| l[5..].trim().to_string())
                    .unwrap_or_default();
                h.lock().unwrap().push(format!("{host}{path}"));
                let p = path.split('?').next().unwrap_or("/").to_string();
                let (status, ctype, body) = match routes.iter().find(|(rp, _, _)| *rp == p) {
                    Some((_, c, b)) => ("200 OK", c.clone(), b.clone()),
                    None => ("404 Not Found", "text/plain".to_string(), "nf".to_string()),
                };
                let resp = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = s.write_all(resp.as_bytes());
            });
        }
    });
    Server { port, hits }
}

// ---------------------------------------------------------------------------
// P01 — the Σ-Λ trajectory generator itself (no V8).
// ---------------------------------------------------------------------------
#[test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
fn p01_trajectory_velocity_profile() {
    use browser_oxide::stealth::behavior::{mouse_trajectory, BehaviorProfile};
    let (from, to) = ((100.0f32, 100.0f32), (700.0f32, 400.0f32));
    let dist = ((to.0 - from.0).powi(2) + (to.1 - from.1).powi(2)).sqrt();
    let mut cov8 = Vec::new();
    let mut t50 = Vec::new();
    let mut vmax = Vec::new();
    let mut still = Vec::new();
    let mut total = Vec::new();
    for _ in 0..40 {
        let pts = mouse_trajectory(from, to, 40.0, &BehaviorProfile::default());
        let cov = |i: usize| {
            let q = &pts[i.min(pts.len() - 1)];
            ((q.x - from.0).powi(2) + (q.y - from.1).powi(2)).sqrt() / dist
        };
        cov8.push(cov(1));
        let half = pts
            .iter()
            .find(|q| ((q.x - from.0).powi(2) + (q.y - from.1).powi(2)).sqrt() / dist >= 0.5)
            .map(|q| q.t_ms)
            .unwrap_or(f32::NAN);
        t50.push(half);
        let mut m = 0f32;
        let mut n_still = 0usize;
        for w in pts.windows(2) {
            let step = ((w[1].x - w[0].x).powi(2) + (w[1].y - w[0].y).powi(2)).sqrt();
            let v = step / ((w[1].t_ms - w[0].t_ms) / 1000.0);
            if v > m {
                m = v;
            }
            if step < 3.0 {
                n_still += 1;
            }
        }
        vmax.push(m);
        still.push(n_still as f32 / (pts.len() - 1) as f32);
        total.push(pts.last().unwrap().t_ms);
    }
    let med = |v: &mut Vec<f32>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    };
    report(
        "p01_trajectory",
        format!(
            "{{\"distance_px\":{dist:.0},\"median_share_covered_after_first_8ms\":{:.3},\"median_ms_to_half_distance\":{:.1},\"median_peak_speed_px_s\":{:.0},\"median_share_of_samples_moving_lt_3px\":{:.2},\"median_total_ms\":{:.0}}}",
            med(&mut cov8), med(&mut t50), med(&mut vmax), med(&mut still), med(&mut total)
        ),
    );
}

// ---------------------------------------------------------------------------
// P02 — full event stream of Page::human_click (single, correct install).
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p02_human_click_event_stream() {
    let mut page = page_with(r##"
<input id="a" style="position:absolute;left:20px;top:20px;width:150px;height:24px">
<div id="pad" style="position:absolute;left:200px;top:100px;width:300px;height:200px;background:#eee"></div>
<button id="b" style="position:absolute;left:600px;top:400px;width:120px;height:40px">Go</button>
<script>document.getElementById('b').addEventListener('click', function(e){ globalThis.__stack = String(new Error('probe').stack); });</script>
"##).await;
    let r1 = page.human_click("#a").await.unwrap();
    page.evaluate("__log.length = 0; __T0 = performance.now();")
        .unwrap();
    let r2 = page.human_click("#b").await.unwrap();
    let summary = page.evaluate(r##"(function(){
      var L = __log, seq = [], last = null;
      L.forEach(function(e){ var k = e.t + (e.tr ? '' : '(UNTRUSTED)') + '@' + e.tg; if (k !== last) { seq.push(k); last = k; } });
      var moves = L.filter(function(e){ return e.t === 'mousemove'; });
      var pmoves = L.filter(function(e){ return e.t === 'pointermove'; });
      var firstPair = L.filter(function(e){ return e.t === 'mousemove' || e.t === 'pointermove'; }).slice(0, 2).map(function(e){ return e.t; });
      var frac = moves.filter(function(e){ return e.x % 1 !== 0 || e.y % 1 !== 0; }).length;
      var dts = []; for (var i = 1; i < moves.length; i++) dts.push(+(moves[i].ts - moves[i-1].ts).toFixed(1));
      var sdts = dts.slice().sort(function(a,b){return a-b;});
      var start = [95, 32], end = moves.length ? [moves[moves.length-1].x, moves[moves.length-1].y] : [0,0];
      var D = Math.hypot(end[0]-start[0], end[1]-start[1]);
      var firstMoveShare = moves.length ? Math.hypot(moves[0].x-start[0], moves[0].y-start[1]) / D : null;
      var zeroMoves = 0; for (var j = 1; j < moves.length; j++) if (moves[j].x === moves[j-1].x && moves[j].y === moves[j-1].y) zeroMoves++;
      var onPad = moves.filter(function(e){ return e.tg === 'pad'; }).length;
      var boundary = L.filter(function(e){ return /over|out|enter|leave/.test(e.t); }).map(function(e){ return e.t + '@' + e.tg; });
      var focus = L.filter(function(e){ return /focus|blur/.test(e.t); }).map(function(e){ return e.t + (e.tr ? '' : '(UNTRUSTED)') + '@' + e.tg + (e.rt ? ' rt=' + e.rt : ''); });
      var click = L.filter(function(e){ return e.t === 'click'; })[0] || null;
      var sy = L.filter(function(e){ return typeof e.sy === 'number' && e.sy; }).map(function(e){ return Math.round(e.sy - e.y); });
      var syDistinct = sy.filter(function(v,i,a){ return a.indexOf(v) === i; });
      return JSON.stringify({
        events: L.length, mousemove: moves.length, pointermove: pmoves.length,
        first_move_pair_order: firstPair,
        mousemove_fractional_clientXY: frac,
        move_dt_ms: { median: sdts[sdts.length >> 1], p90: sdts[Math.floor(sdts.length*0.9)], max: sdts[sdts.length-1] },
        first_move_share_of_distance: firstMoveShare && +firstMoveShare.toFixed(3),
        zero_distance_moves: zeroMoves, moves_on_pad_crossed: onPad,
        boundary_events: boundary, focus_events: focus,
        click: click && { ctor: click.c, trusted: click.tr, detail: click.d, pointerId: click.pid, pointerType: click.pt, button: click.b, buttons: click.bs },
        screenY_minus_clientY_values: syDistinct,
        sequence: seq
      });
    })()"##).unwrap();
    let stack = page.evaluate("String(globalThis.__stack)").unwrap();
    report(
        "p02_results",
        format!("{{\"click_a\":{r1:?},\"click_b\":{r2:?}}}"),
    );
    report("p02_stream", summary);
    report("p02_listener_stack", format!("{stack:?}"));
}

// ---------------------------------------------------------------------------
// P03 — default actions after a humanized click; pending navigation afterwards.
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p03_activation_behaviour() {
    let mut page = page_with(r##"
<input type="checkbox" id="cb" style="position:absolute;left:20px;top:20px;width:20px;height:20px">
<label id="lbl" for="cb2" style="position:absolute;left:60px;top:20px;width:100px;height:20px;display:block">Label</label>
<input type="checkbox" id="cb2" style="position:absolute;left:180px;top:20px;width:20px;height:20px">
<input type="radio" name="r" id="r1" style="position:absolute;left:20px;top:60px;width:20px;height:20px">
<a id="hash" href="#section" style="position:absolute;left:20px;top:100px;width:100px;height:20px;display:block">hash link</a>
<details id="det" style="position:absolute;left:20px;top:180px"><summary id="sum" style="display:block;width:100px;height:20px">sum</summary>x</details>
<select id="sel" style="position:absolute;left:300px;top:20px;width:100px;height:24px"><option>a</option><option>b</option></select>
<form id="f" action="/submit" style="position:absolute;left:20px;top:260px"><input name="q" value="1"><button id="sub" style="width:80px;height:30px">Send</button></form>
<a id="nav" href="/next" style="position:absolute;left:20px;top:140px;width:100px;height:20px;display:block">nav link</a>
<script>
globalThis.__ev = [];
document.addEventListener('change', function(e){ __ev.push('change:' + e.target.id); });
document.addEventListener('submit', function(e){ __ev.push('submit'); });
window.addEventListener('hashchange', function(){ __ev.push('hashchange'); });
</script>
"##).await;
    let mut results = Vec::new();
    for sel in ["#cb", "#lbl", "#r1", "#hash", "#sum", "#sel"] {
        let r = page.human_click(sel).await.unwrap();
        results.push(format!("{sel}={r:?}"));
    }
    let state = page.evaluate(&format!(r##"JSON.stringify({{
      cb_checked: document.getElementById('cb').checked,
      cb2_checked_via_label: document.getElementById('cb2').checked,
      r1_checked: document.getElementById('r1').checked,
      location_hash: location.hash,
      details_open: document.getElementById('det').open,
      active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
      events: __ev,
      pending_nav: ((({NS}||{{}}).host||{{}}).bo||{{}}).__pendingNavigation || null
    }})"##)).unwrap();
    report("p03_clicks", results.join(" | "));
    report("p03_state_after_checkbox_label_radio_hash_summary", state);

    // Anchor to another document.
    let r = page.human_click("#nav").await.unwrap();
    let nav = page
        .evaluate(&format!(
            "JSON.stringify(((({NS}||{{}}).host||{{}}).bo||{{}}).__pendingNavigation || null)"
        ))
        .unwrap();
    report(
        "p03_link_click",
        format!(
            "{{\"result\":{r:?},\"pending_nav\":{nav},\"page_url\":{:?}}}",
            page.url()
        ),
    );

    // A submit button laid out inside an absolutely positioned <form>: see p25
    // for why the hit test rejects it, and p26 for the submit path itself.
    let r = page.human_click("#sub").await.unwrap();
    report("p03_submit_button_in_positioned_form", format!("{r:?}"));
}

// ---------------------------------------------------------------------------
// P04 — human_type: key event shape, hidden fields, cancelled keydown, prefill.
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p04_human_type() {
    let mut page = page_with(r##"
<input id="i" style="position:absolute;left:20px;top:20px;width:200px;height:24px">
<input id="pre" value="xyz" style="position:absolute;left:20px;top:60px;width:200px;height:24px">
<input id="hid" name="honeypot" style="display:none">
<input id="blk" style="position:absolute;left:20px;top:100px;width:200px;height:24px">
<script>document.getElementById('blk').addEventListener('keydown', function(e){ e.preventDefault(); });</script>
"##).await;
    page.evaluate("__log.length = 0").unwrap();
    let r = page.human_type("#i", "aA1 @ж").await.unwrap();
    let keys = page.evaluate(r##"(function(){
      var L = __log.filter(function(e){ return e.tg === 'i'; });
      var kinds = {}; L.forEach(function(e){ kinds[e.t] = (kinds[e.t]||0) + 1; });
      var kd = L.filter(function(e){ return e.t === 'keydown'; }).map(function(e){ return [e.k, e.cd, e.kc, e.w, e.sh, e.tr]; });
      var ku = L.filter(function(e){ return e.t === 'keyup'; });
      var kdd = L.filter(function(e){ return e.t === 'keydown'; });
      var dwell = kdd.map(function(e, i){ return ku[i] ? +(ku[i].ts - e.ts).toFixed(0) : null; });
      var flight = kdd.slice(1).map(function(e, i){ return +(e.ts - ku[i].ts).toFixed(0); });
      var inputs = L.filter(function(e){ return e.t === 'input'; }).map(function(e){ return [e.c, e.it, e.dt, e.tr]; });
      return JSON.stringify({ event_counts: kinds, keydown_key_code_keyCode_which_shift_trusted: kd, dwell_ms: dwell, flight_ms: flight, input_events: inputs.slice(0, 3), value: document.getElementById('i').value });
    })()"##).unwrap();
    report("p04_type_result", format!("{r:?}"));
    report("p04_key_stream", keys);

    page.evaluate("__log.length = 0").unwrap();
    let r_pre = page.human_type("#pre", "ab").await.unwrap();
    let pre = page.evaluate(r##"JSON.stringify({ value: document.getElementById('pre').value,
        events_for_clearing_xyz: __log.filter(function(e){ return e.tg === 'pre' && (e.t === 'input' || e.t === 'keydown'); }).slice(0, 1).map(function(e){ return e.t + ':' + e.k; }) })"##).unwrap();
    report(
        "p04_prefilled_field",
        format!("{{\"result\":{r_pre:?},\"state\":{pre}}}"),
    );

    let r_hid = page.human_type("#hid", "bot").await.unwrap();
    let hid = page
        .evaluate("document.getElementById('hid').value")
        .unwrap();
    report(
        "p04_hidden_honeypot",
        format!("{{\"result\":{r_hid:?},\"value_after\":{hid:?}}}"),
    );

    let r_blk = page.human_type("#blk", "q").await.unwrap();
    let blk = page
        .evaluate("document.getElementById('blk').value")
        .unwrap();
    report(
        "p04_keydown_prevented",
        format!("{{\"result\":{r_blk:?},\"value_after\":{blk:?}}}"),
    );

    let tel = page.evaluate(&format!(r##"(function(){{ var ns = {NS}; var m = ns.input.mouse, kinds = {{}};
        m.forEach(function(p){{ kinds[p.kind] = (kinds[p.kind]||0) + 1; }});
        return JSON.stringify({{ mouse_kind_histogram: kinds, key_buffer_len: ns.input.key.length, counters: ns.input.counters }}); }})()"##)).unwrap();
    report("p04_telemetry_buffer", tel);
}

// ---------------------------------------------------------------------------
// P05 — focus semantics around a click.
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p05_focus_semantics() {
    let mut page = page_with(r##"
<input id="i" style="position:absolute;left:20px;top:20px;width:200px;height:24px">
<button id="nofocus" style="position:absolute;left:20px;top:80px;width:120px;height:30px">keeps focus</button>
<div id="plain" style="position:absolute;left:20px;top:140px;width:200px;height:40px;background:#ddd">plain div</div>
<script>document.getElementById('nofocus').addEventListener('mousedown', function(e){ e.preventDefault(); });</script>
"##).await;
    page.human_click("#i").await.unwrap();
    page.human_click("#nofocus").await.unwrap();
    let a1 = page.evaluate("document.activeElement && (document.activeElement.id || document.activeElement.tagName)").unwrap();
    page.human_click("#plain").await.unwrap();
    let a2 = page.evaluate("document.activeElement && (document.activeElement.id || document.activeElement.tagName)").unwrap();
    let focus_div = page
        .evaluate("(function(){ var d=document.createElement('div'); document.body.appendChild(d); d.focus(); return document.activeElement === d; })()")
        .unwrap();
    report(
        "p05_focus",
        format!("{{\"active_after_click_on_button_with_mousedown_preventDefault\":{a1:?},\"active_after_click_on_plain_div\":{a2:?},\"div_without_tabindex_accepts_focus()\":{focus_div}}}"),
    );
}

// ---------------------------------------------------------------------------
// P06 — humanize.js installed twice in one realm (what warm navigation does).
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p06_double_install() {
    let mut page = page_with(r##"<button id="b" style="position:absolute;left:600px;top:400px;width:120px;height:40px">Go</button>"##).await;
    page.evaluate(HUMANIZE).unwrap();
    page.evaluate(HUMANIZE).unwrap();
    page.evaluate("__log.length = 0").unwrap();
    let r = page.human_click("#b").await.unwrap();
    let out = page.evaluate(r##"(function(){
      var L = __log, trusted = L.filter(function(e){ return e.tr; }).length;
      var moves = L.filter(function(e){ return e.t === 'mousemove'; });
      var path = 0; for (var i = 1; i < moves.length; i++) path += Math.hypot(moves[i].x-moves[i-1].x, moves[i].y-moves[i-1].y);
      var straight = moves.length > 1 ? Math.hypot(moves[moves.length-1].x-moves[0].x, moves[moves.length-1].y-moves[0].y) : 0;
      var seedMoves = 0;
      return JSON.stringify({ events: L.length, trusted: trusted, untrusted: L.length - trusted, mousemove: moves.length,
        path_efficiency: straight ? +(straight / path).toFixed(4) : null,
        click_trusted: (L.filter(function(e){ return e.t === 'click'; })[0] || {}).tr });
    })()"##).unwrap();
    report(
        "p06_double_install",
        format!("{{\"result\":{r:?},\"stream\":{out}}}"),
    );
}

// ---------------------------------------------------------------------------
// P07/P08 — the real navigation entry points: PagePool (warm), devview's warm
// path, and cold Page::navigate.
// ---------------------------------------------------------------------------
const NAV_PAGE: &str = r##"<!doctype html><html><head><title>p</title></head><body>
<button id="b" style="position:absolute;left:300px;top:200px;width:120px;height:40px">Go</button>
<script>
globalThis.__early = [];
['mousemove','pointermove'].forEach(function(t){ window.addEventListener(t, function(e){ __early.push([t, e.isTrusted, e.clientX, e.clientY, Math.round(e.timeStamp)]); }); });
globalThis.__clicks = [];
document.getElementById('b').addEventListener('click', function(e){ __clicks.push(e.isTrusted); });
document.getElementById('b').addEventListener('mousedown', function(e){ __clicks.push('down:' + e.isTrusted); });
</script></body></html>"##;

async fn nav_probe(page: &mut Page, label: &str) {
    let early = page.evaluate("JSON.stringify(__early)").unwrap();
    let r = page.human_click("#b").await.unwrap();
    let clicks = page.evaluate("JSON.stringify(__clicks)").unwrap();
    let mark = page
        .evaluate(&format!("(function(){{var ns={NS};return JSON.stringify({{markTrusted:typeof (ns&&ns.markTrusted),inputMark:typeof (ns&&ns.input&&ns.input.mark),inputApi:typeof (ns&&ns.inputApi)}});}})()"))
        .unwrap();
    report(
        label,
        format!("{{\"window_moves_seen_by_page_at_load\":{early},\"human_click\":{r:?},\"button_events_trusted\":{clicks},\"namespace\":{mark}}}"),
    );
}

#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p07_pool_and_devview_warm_paths() {
    let srv = serve(vec![("/p", "text/html", NAV_PAGE.to_string())]);
    let url = format!("http://127.0.0.1:{}/p", srv.port);
    let pool = browser_oxide::PagePool::new(1);

    let mut page = pool.navigate(&url, chrome_148_macos()).await.unwrap();
    nav_probe(&mut page, "p07_pool_navigate_first").await;
    pool.release(page);

    let mut page = pool.navigate(&url, chrome_148_macos()).await.unwrap();
    nav_probe(&mut page, "p07_pool_navigate_reused_page").await;
    pool.release(page);

    // Exactly what examples/devview.rs does by default.
    let pool2 = browser_oxide::PagePool::new(1);
    let mut page = pool2.acquire(Some(chrome_148_macos())).await.unwrap();
    page.navigate_warm_with_init(&url, &[HUMANIZE.to_string()])
        .await
        .unwrap();
    nav_probe(&mut page, "p07_devview_default_warm_path").await;
    drop(page);
    drop(pool2);
}

#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p08_cold_navigate() {
    let srv = serve(vec![("/p", "text/html", NAV_PAGE.to_string())]);
    let url = format!("http://127.0.0.1:{}/p", srv.port);
    let mut page = Page::navigate(&url, chrome_148_macos(), 2).await.unwrap();
    nav_probe(&mut page, "p08_cold_page_navigate").await;

    // What any page script can do with the engine namespace.
    let reach = page.evaluate(r##"(function(){
      var plain = Object.getOwnPropertySymbols(window).length, withArg = Object.getOwnPropertySymbols(window, 1).length;
      var ns = null; Object.getOwnPropertySymbols(window, 1).forEach(function(s){ var v = window[s]; if (v && v.__bo) ns = v; });
      var ev = new MouseEvent('click', { bubbles: true });
      if (ns && ns.input && ns.input.mark) ns.input.mark(ev);
      return JSON.stringify({ symbols_plain: plain, symbols_with_2nd_arg: withArg, namespace_found: !!ns,
        some_namespace_keys: ns ? Object.getOwnPropertyNames(ns).slice(0, 30) : [],
        page_forged_event_isTrusted: ev.isTrusted });
    })()"##).unwrap();
    report("p08_page_reaches_engine_namespace", reach);
}

// ---------------------------------------------------------------------------
// P10 — page-side hooks see the synthetic machinery.
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p10_page_hooks_observe_humanize() {
    let mut page = page_with(r##"
<button id="b" style="position:absolute;left:300px;top:200px;width:120px;height:40px">Go</button>
<script>
globalThis.__hook = { trustedThroughJsDispatch: 0, ctorCalls: 0, efp: 0, types: {} };
(function(){
  var orig = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (e) {
    if (e && e.isTrusted) { __hook.trustedThroughJsDispatch++; __hook.types[e.type] = (__hook.types[e.type]||0) + 1; }
    return orig.call(this, e);
  };
  var OME = MouseEvent;
  window.MouseEvent = class extends OME { constructor(t, o) { super(t, o); __hook.ctorCalls++; } };
  var oefp = Document.prototype.elementFromPoint || document.elementFromPoint;
  document.elementFromPoint = function (x, y) { __hook.efp++; return oefp.call(document, x, y); };
})();
</script>"##).await;
    let r = page.human_click("#b").await.unwrap();
    let hook = page.evaluate("JSON.stringify(__hook)").unwrap();
    report(
        "p10_hooks",
        format!("{{\"result\":{r:?},\"seen_by_page\":{hook}}}"),
    );
}

// ---------------------------------------------------------------------------
// P11 — MouseEvent coordinate shape.
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p11_mouse_event_coordinates() {
    let mut page = page_with("").await;
    let v = page.evaluate(r##"JSON.stringify({
      mouse_clientX_of_10_7: new MouseEvent('mousemove', { clientX: 10.7, clientY: 3.2 }).clientX,
      pointer_clientX_of_10_7: new PointerEvent('pointermove', { clientX: 10.7 }).clientX,
      pageY_with_scroll: (function(){ window.scrollTo(0, 500); var e = new MouseEvent('click', { clientY: 10 }); return [e.pageY, window.scrollY]; })(),
      click_from_element_click: (function(){ var c = null, b = document.createElement('button'); document.body.appendChild(b);
          b.addEventListener('click', function(e){ c = [e.constructor.name, e.isTrusted, typeof e.clientX]; }); b.click(); return c; })()
    })"##).unwrap();
    report("p11_event_shape", v);
}

// ---------------------------------------------------------------------------
// P12 — srcdoc frames: lifecycle, duplicate execution, postMessage routing.
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p12_srcdoc_frames() {
    let srcdoc = "<script>window.__ran=(window.__ran||0)+1;window.__rs0=document.readyState;document.addEventListener('DOMContentLoaded',function(){window.__dcl=(window.__dcl||0)+1;});window.addEventListener('load',function(){window.__load=1;});window.__msgs=[];window.addEventListener('message',function(e){window.__msgs.push([e.data,e.origin,e.isTrusted]);});</script><script src='/ext.js'></script>";
    let html = r##"<!doctype html><html><body><iframe id="f" style="width:300px;height:150px" srcdoc="{SRCDOC}"></iframe>
<script>
globalThis.__up = [];
addEventListener('message', function(e){ var f = document.getElementById('f');
  __up.push([e.data, e.origin, e.isTrusted, e.source === f.contentWindow]);
  if (e.data === 'up') e.source.postMessage('reply', '*'); });
</script></body></html>"##
        .replace("{SRCDOC}", srcdoc);
    let mut page = Page::from_html_with_url(
        &html,
        "http://127.0.0.1:9/parent.html",
        Some(chrome_148_macos()),
    )
    .await
    .unwrap();
    report("p12_children_built", page.child_iframe_count());
    let child_state = |page: &mut Page| {
        page.child_iframe(0)
            .map(|c| {
                c.evaluate("JSON.stringify({ran:window.__ran,rs0:window.__rs0,rs:document.readyState,dcl:window.__dcl||0,load:window.__load||0,href:location.href,origin:location.origin,msgs:window.__msgs})")
                    .unwrap_or_else(|e| format!("err {e}"))
            })
            .unwrap_or_else(|| "no child".into())
    };
    report("p12_child_after_build", child_state(&mut page));
    let fake = page
        .evaluate("(function(){ var w = document.getElementById('f').contentWindow; return JSON.stringify({ ran_in_parent_side_realm: w && w.__ran, same_object_as_child: false }); })()")
        .unwrap();
    report("p12_parent_side_contentWindow", fake);
    // Parent → child, targeted at the parent's own origin (srcdoc inherits it).
    page.evaluate(
        "document.getElementById('f').contentWindow.postMessage('down', location.origin)",
    )
    .unwrap();
    // Child → parent, and the parent's reply via event.source.
    if let Some(c) = page.child_iframe(0) {
        let _ = c.evaluate("parent.postMessage('up', '*')");
    }
    for _ in 0..4 {
        page.pump_iframe_messages();
        page.drive_children(Duration::from_millis(50)).await;
        let _ = page.evaluate_async("0", Duration::from_millis(50)).await;
    }
    report("p12_child_after_messages", child_state(&mut page));
    report(
        "p12_parent_received",
        page.evaluate("JSON.stringify(__up)").unwrap(),
    );
    report(
        "p12_parent_side_realm_msgs",
        page.evaluate("JSON.stringify(document.getElementById('f').contentWindow.__msgs)")
            .unwrap(),
    );
}

// ---------------------------------------------------------------------------
// P13 — src frames (same-origin + cross-origin) with a real server: fetch/exec
// counts, message routing, input inside frames (humanize absent, devview path).
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p13_src_frames() {
    let parent = r##"<!doctype html><html><body>
<iframe id="same" src="/same.html" style="position:absolute;left:10px;top:10px;width:300px;height:150px;border:0"></iframe>
<iframe id="cross" src="http://localhost:{PORT}/cross.html" style="position:absolute;left:10px;top:200px;width:300px;height:150px;border:0"></iframe>
<iframe id="sameabs" src="http://127.0.0.1:{PORT}/sameabs.html" style="position:absolute;left:400px;top:10px;width:300px;height:150px;border:0"></iframe>
<script>
globalThis.__up = [];
addEventListener('message', function (e) {
  var who = e.data && e.data.who, f = who && document.getElementById(who);
  __up.push([who, e.origin, e.isTrusted, !!f && e.source === f.contentWindow]);
  try { e.source.postMessage({ reply: who }, '*'); } catch (err) { __up.push(['reply-threw', String(err)]); }
});
globalThis.__touch = [typeof document.getElementById('same').contentWindow, typeof document.getElementById('sameabs').contentWindow];
globalThis.__frameEvents = [];
['mousemove','mousedown','click'].forEach(function(t){ document.addEventListener(t, function(e){ __frameEvents.push(t + '@' + (e.target.id || e.target.tagName)); }, true); });
</script></body></html>"##;
    let script = |who: &str| {
        format!(
            r##"window.__exec=(window.__exec||0)+1; window.__got=[]; window.__docEvents=[];
addEventListener('message', function(e){{ __got.push([JSON.stringify(e.data), e.origin, e.isTrusted]); }});
['mousemove','mousedown','click'].forEach(function(t){{ document.addEventListener(t, function(e){{ __docEvents.push(t + ':' + e.isTrusted); }}, true); }});
document.getElementById('fb').addEventListener('click', function(e){{ window.__fbclick=[e.isTrusted, e.clientX, e.clientY, e.screenX, e.screenY]; }});
parent.postMessage({{ who: '{who}' }}, '*');"##
        )
    };
    let frame = |who: &str| {
        format!(
            r##"<!doctype html><html><body><button id="fb" style="position:absolute;left:0;top:0;width:100px;height:40px">in-frame</button>
<script src="rel.js"></script><script src="/{who}.js"></script><script>{inline}</script></body></html>"##,
            inline = script(who).replace("window.__exec=", "window.__inlineExec=1; window.__exec=")
        )
    };
    let srv = serve(vec![
        ("/parent.html", "text/html", parent.to_string()),
        ("/same.html", "text/html", frame("same")),
        ("/cross.html", "text/html", frame("cross")),
        ("/same.js", "application/javascript", script("same")),
        ("/cross.js", "application/javascript", script("cross")),
        ("/sameabs.html", "text/html", frame("sameabs")),
        ("/sameabs.js", "application/javascript", script("sameabs")),
        (
            "/rel.js",
            "application/javascript",
            "window.__rel=1;".to_string(),
        ),
    ]);
    let url = format!("http://127.0.0.1:{}/parent.html", srv.port);
    let parent_html = parent.replace("{PORT}", &srv.port.to_string());
    let mut page = Page::from_html_with_url(&parent_html, &url, Some(chrome_148_macos()))
        .await
        .unwrap();
    let side = page
        .evaluate("(function(){ var out = { touched: __touch }; ['same','sameabs','cross'].forEach(function(id){ try { var w = document.getElementById(id).contentWindow; out[id] = { exec_in_parent_side_realm: w.__exec, rel_in_parent_side_realm: w.__rel, doc_title_readable: typeof w.document }; } catch (e) { out[id] = 'threw: ' + e.name + ': ' + e.message; } }); return JSON.stringify(out); })()")
        .unwrap();
    report("p13_parent_side_same_origin_realm", side);
    let n = page.materialize_new_iframes().await;
    report(
        "p13_materialized",
        format!("{n:?} ids={:?}", page.child_frame_ids()),
    );
    for _ in 0..6 {
        page.pump_iframe_messages();
        page.drive_children(Duration::from_millis(50)).await;
        let _ = page.evaluate_async("0", Duration::from_millis(50)).await;
    }
    report(
        "p13_parent_received",
        page.evaluate("JSON.stringify(__up)").unwrap(),
    );
    let ids = page.child_frame_ids();
    for (i, (_, u)) in ids.iter().enumerate() {
        let c = page.child_iframe(i).unwrap();
        let st = c
            .evaluate(&format!(
                "(function(){{var ns={NS};return JSON.stringify({{url:location.href,exec:window.__exec,inline_ran:window.__inlineExec||0,rel_js_ran:window.__rel||0,got:window.__got,rs:document.readyState,innerWH:[innerWidth,innerHeight],frameBox:ns&&ns.frame,humanize_input:typeof (ns&&ns.input),markTrusted_left_on_namespace:typeof (ns&&ns.markTrusted)}});}})()"
            ))
            .unwrap_or_else(|e| format!("err {e}"));
        report(
            &format!("p13_child_{i}"),
            format!("{{\"src\":{u:?},\"state\":{st}}}"),
        );
    }
    report(
        "p13_server_hits",
        format!(
            "{{\"same.html\":{},\"same.js\":{},\"rel.js\":{},\"cross.html\":{},\"cross.js\":{},\"sameabs.html\":{},\"sameabs.js\":{},\"all\":{:?}}}",
            srv.hits_for("/same.html"),
            srv.hits_for("/same.js"),
            srv.hits_for("/rel.js"),
            srv.hits_for("/cross.html"),
            srv.hits_for("/cross.js"),
            srv.hits_for("/sameabs.html"),
            srv.hits_for("/sameabs.js"),
            srv.hits.lock().unwrap().clone()
        ),
    );

    // A humanized click aimed at the frame goes to the <iframe> element in the parent.
    let r = page.human_click("#cross").await.unwrap();
    let parent_saw = page
        .evaluate("JSON.stringify(__frameEvents.filter(function(s){return !/mousemove/.test(s);}))")
        .unwrap();
    let cross_idx = ids
        .iter()
        .position(|(_, u)| u.contains("cross"))
        .unwrap_or(1);
    let child_saw = page
        .child_iframe(cross_idx)
        .map(|c| {
            c.evaluate("JSON.stringify(__docEvents)")
                .unwrap_or_default()
        })
        .unwrap_or_default();
    report(
        "p13_human_click_on_iframe",
        format!("{{\"result\":{r:?},\"parent_document_saw\":{parent_saw},\"child_document_saw\":{child_saw}}}"),
    );

    // devview's own pointer transport replayed inside the frame's realm.
    let pointer = devview_js("POINTER_JS");
    let mut out = Vec::new();
    for phase in ["down", "up"] {
        let js = pointer
            .replace("__CANVAS_ID__", "-1")
            .replace("__SEL__", "#fb")
            .replace("__U__", "0.15")
            .replace("__V__", "0.12")
            .replace("__PHASE__", phase);
        let c = page.child_iframe(cross_idx).unwrap();
        out.push(c.evaluate(&js).unwrap_or_else(|e| format!("err {e}")));
    }
    let c = page.child_iframe(cross_idx).unwrap();
    let fb = c
        .evaluate("JSON.stringify(window.__fbclick || null)")
        .unwrap_or_default();
    report(
        "p13_devview_pointer_in_frame",
        format!("{{\"returns\":{out:?},\"button_click_seen\":{fb}}}"),
    );
}

// ---------------------------------------------------------------------------
// P15 — CDP Input domain.
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p15_cdp_input_domain() {
    use browser_oxide::protocol::{CdpRequest, CdpSession};
    let mut page = page_with(
        r##"
<button id="b" style="position:absolute;left:100px;top:100px;width:120px;height:40px">Go</button>
<input id="i" style="position:absolute;left:100px;top:200px;width:200px;height:24px">
"##,
    )
    .await;
    let mut session = CdpSession::new();
    let send = |method: &str, params: serde_json::Value| CdpRequest {
        id: 1,
        method: method.to_string(),
        params,
    };
    let reqs = vec![
        send(
            "Input.dispatchMouseEvent",
            serde_json::json!({"type":"mouseMoved","x":160,"y":120}),
        ),
        send(
            "Input.dispatchMouseEvent",
            serde_json::json!({"type":"mousePressed","x":160,"y":120,"button":"left","buttons":1,"clickCount":1}),
        ),
        send(
            "Input.dispatchMouseEvent",
            serde_json::json!({"type":"mouseReleased","x":160,"y":120,"button":"left","buttons":0,"clickCount":1}),
        ),
    ];
    for r in &reqs {
        let _ = session.handle_request(&mut page, r, None).await;
    }
    let mouse = page.evaluate(r##"(function(){ var L = __log.filter(function(e){ return !/move/.test(e.t); });
       var moves = __log.filter(function(e){ return e.t === 'mousemove'; });
       return JSON.stringify({ non_move_events: L.map(function(e){ return e.t + (e.tr ? '' : '(UNTRUSTED)') + '@' + e.tg; }), mousemove_count: moves.length,
         first_moves: moves.slice(0, 3).map(function(e){ return [Math.round(e.x), Math.round(e.y), e.ts]; }) }); })()"##).unwrap();
    report("p15_cdp_mouse", mouse);
    page.evaluate("document.getElementById('i').focus(); __log.length = 0;")
        .unwrap();
    for r in [
        send(
            "Input.dispatchKeyEvent",
            serde_json::json!({"type":"keyDown","key":"a","code":"KeyA","text":"a"}),
        ),
        send(
            "Input.dispatchKeyEvent",
            serde_json::json!({"type":"keyUp","key":"a","code":"KeyA"}),
        ),
    ] {
        let _ = session.handle_request(&mut page, &r, None).await;
    }
    let keys = page.evaluate("JSON.stringify({ value: document.getElementById('i').value, events: __log.map(function(e){ return e.t + (e.tr ? '' : '(UNTRUSTED)'); }) })").unwrap();
    report("p15_cdp_keydown_with_text", keys);
}

// ---------------------------------------------------------------------------
// P16 — pointerStep drag state; P20 — devview KEY_JS approach.
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p16_pointer_step_drag_and_devview_key() {
    let mut page = page_with(r##"
<div id="src" style="position:absolute;left:20px;top:20px;width:100px;height:100px;background:#faa"></div>
<div id="dst" style="position:absolute;left:300px;top:20px;width:100px;height:100px;background:#afa"></div>
<input id="i" style="position:absolute;left:20px;top:200px;width:200px;height:24px">
"##).await;
    page.evaluate(HUMANIZE).unwrap();
    page.evaluate("__log.length = 0").unwrap();
    page.evaluate(&format!("(function(){{var ns={NS}; ns.input.pointerStep(70,70,'down'); ns.input.pointerStep(150,70,'move'); ns.input.pointerStep(250,70,'move'); ns.input.pointerStep(350,70,'up');}})()")).unwrap();
    let drag = page.evaluate(r##"JSON.stringify(__log.filter(function(e){ return !/over|out|enter|leave/.test(e.t); }).map(function(e){ return e.t + '@' + e.tg + ' buttons=' + e.bs; }))"##).unwrap();
    report("p16_pointerStep_drag", drag);

    page.evaluate("__log.length = 0").unwrap();
    let key = devview_js("KEY_JS");
    let mk = |phase: &str| {
        key.replace("__SEL__", "#i")
            .replace("__KEY__", "a")
            .replace("__CODE__", "KeyA")
            .replace("__PHASE__", phase)
            .replace("__CTRL__", "false")
            .replace("__ALT__", "false")
            .replace("__SHIFT__", "false")
            .replace("__META__", "false")
    };
    let d = page.evaluate(&mk("down")).unwrap();
    let u = page.evaluate(&mk("up")).unwrap();
    let stream = page.evaluate(r##"JSON.stringify(__log.filter(function(e){ return e.t !== 'mousemove' || true; }).map(function(e){ return [e.t, e.tr, e.b, e.ts, e.kc]; }))"##).unwrap();
    report(
        "p20_devview_key",
        format!(
            "{{\"down\":{d:?},\"up\":{u:?},\"events_[type,trusted,button,ts,keyCode]\":{stream}}}"
        ),
    );
}

// ---------------------------------------------------------------------------
// P23 — targets inside a scrolled container; P24 — dispatch ordering at target.
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p23_scroll_container_and_p24_dispatch_order() {
    let mut page = page_with(
        r##"
<div id="box" style="position:absolute;left:20px;top:20px;width:300px;height:100px;overflow:auto">
  <div style="height:1000px"></div><button id="deep" style="width:100px;height:30px">deep</button>
</div>
<div id="far" style="position:absolute;left:20px;top:3000px;width:100px;height:30px">far</div>
"##,
    )
    .await;
    let r_deep = page.human_click("#deep").await.unwrap();
    let r_far = page.human_click("#far").await.unwrap();
    report("p23_scroll", format!("{{\"inside_overflow_container\":{r_deep:?},\"below_the_fold\":{r_far:?},\"scrollY\":{}}}", page.evaluate("scrollY").unwrap()));

    let order = page.evaluate(r##"(function(){ var out = [], b = document.createElement('button'); document.body.appendChild(b);
      b.addEventListener('x', function(){ out.push('target-bubble-listener'); });
      b.addEventListener('x', function(){ out.push('target-capture-listener'); }, true);
      b.addEventListener('click', function(){ out.push('A(addEventListener)'); });
      b.onclick = function(){ out.push('B(onclick)'); };
      b.addEventListener('click', function(){ out.push('C(addEventListener)'); });
      b.dispatchEvent(new Event('x', { bubbles: true }));
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return JSON.stringify(out); })()"##).unwrap();
    report("p24_dispatch_order", order);
}

// ---------------------------------------------------------------------------
// P25 — follow-ups: hit-testing after scroll / inside positioned containers,
// the travel "jump", and what a submit leaves behind.
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p25_hit_testing_and_jump() {
    let mut page = page_with(r##"
<form id="f" action="/submit" style="position:absolute;left:20px;top:260px"><input name="q" value="1"><button id="sub" style="width:80px;height:30px">Send</button></form>
<details id="det" style="position:absolute;left:20px;top:180px"><summary id="sum" style="display:block;width:100px;height:20px">sum</summary>x</details>
<div id="far" style="position:absolute;left:20px;top:3000px;width:100px;height:30px">far</div>
<button id="a" style="position:absolute;left:20px;top:20px;width:100px;height:30px">a</button>
<button id="b" style="position:absolute;left:900px;top:600px;width:100px;height:30px">b</button>
"##).await;
    let ht = page.evaluate(r##"(function(){ function probe(id){ var el = document.getElementById(id), r = el.getBoundingClientRect();
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2, hit = document.elementFromPoint(cx, cy);
        return { rect: [r.left, r.top, r.width, r.height].map(Math.round), hit_at_center: hit && (hit.id || hit.tagName) }; }
      var out = { sub_in_positioned_form: probe('sub'), summary: probe('sum') };
      window.scrollTo(0, 2600); out.far_after_scrollTo_2600 = probe('far'); out.scrollY = scrollY; window.scrollTo(0, 0);
      return JSON.stringify(out); })()"##).unwrap();
    report("p25_hit_testing", ht);

    page.human_click("#a").await.unwrap();
    page.evaluate("__log.length = 0").unwrap();
    page.human_click("#b").await.unwrap();
    let jump = page.evaluate(r##"(function(){ var m = __log.filter(function(e){ return e.t === 'mousemove'; });
       var a = document.getElementById('a').getBoundingClientRect(), b = document.getElementById('b').getBoundingClientRect();
       var D = Math.hypot((b.left+b.width/2)-(a.left+a.width/2), (b.top+b.height/2)-(a.top+a.height/2));
       var steps = []; for (var i = 1; i < m.length; i++) steps.push({ d: Math.hypot(m[i].x-m[i-1].x, m[i].y-m[i-1].y), dt: m[i].ts - m[i-1].ts });
       var big = steps.reduce(function(p, c){ return c.d > p.d ? c : p; }, { d: 0, dt: 0 });
       return JSON.stringify({ moves: m.length, distance_px: Math.round(D), largest_single_step_px: Math.round(big.d), largest_step_share: +(big.d / D).toFixed(3),
         over_ms: +big.dt.toFixed(1), implied_speed_px_s: Math.round(big.d / (big.dt / 1000)),
         steps_under_3px_share: +(steps.filter(function(s){ return s.d < 3; }).length / steps.length).toFixed(2) }); })()"##).unwrap();
    report("p25_travel_jump", jump);
}

#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p26_submit_and_pending_navigation() {
    let mut page = page_with(r##"
<form id="f" action="/submit"><input name="q" value="1"></form>
<button id="sub" form="f" type="submit" style="position:absolute;left:20px;top:260px;width:80px;height:30px">Send</button>
<script>globalThis.__sub = 0; document.addEventListener('submit', function(){ __sub++; });</script>
"##).await;
    let r = page.human_click("#sub").await.unwrap();
    let nav = page
        .evaluate(&format!(
            "JSON.stringify(((({NS}||{{}}).host||{{}}).bo||{{}}).__pendingNavigation || null)"
        ))
        .unwrap();
    page.evaluate("globalThis.__late = 0; setTimeout(function(){ __late = 1; }, 700);")
        .unwrap();
    let t0 = Instant::now();
    let reason = page.evaluate_async("0", Duration::from_secs(3)).await;
    let waited = t0.elapsed().as_millis();
    let late = page.evaluate("String(__late)").unwrap();
    report(
        "p26_submit",
        format!(
            "{{\"result\":{r:?},\"submit_events\":{},\"pending_nav\":{nav},\"page_url_after\":{:?},\"evaluate_async_3s_returned_after_ms\":{waited},\"reason\":{:?},\"timer_700ms_fired\":{late}}}",
            page.evaluate("String(__sub)").unwrap(),
            page.url(),
            format!("{reason:?}")
        ),
    );
}

// ---------------------------------------------------------------------------
// P27 — devview transport: a CSS.escape()d id inside POINTER_JS's template literal.
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p27_devview_selector_escaping() {
    let mut page = page_with(
        r##"<div id="1abc" style="position:absolute;left:0;top:0;width:50px;height:50px"></div>"##,
    )
    .await;
    let pointer = devview_js("POINTER_JS");
    // What the viewer sends for <div id="1abc">: '#' + CSS.escape('1abc') === '#\31 abc'
    let js = pointer
        .replace("__CANVAS_ID__", "-1")
        .replace("__SEL__", "#\\31 abc")
        .replace("__U__", "0.5")
        .replace("__V__", "0.5")
        .replace("__PHASE__", "move");
    let r = page.evaluate(&js);
    report(
        "p27_pointer_with_escaped_id",
        format!("{:?}", r.map_err(|e| e.to_string())),
    );
}

// ---------------------------------------------------------------------------
// P28 — disabled controls and contenteditable.
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p28_disabled_and_contenteditable() {
    let mut page = page_with(r##"
<button id="dis" disabled style="position:absolute;left:20px;top:20px;width:100px;height:30px">disabled</button>
<div id="ce" contenteditable="true" style="position:absolute;left:20px;top:80px;width:200px;height:30px"></div>
<input id="ro" readonly style="position:absolute;left:20px;top:140px;width:200px;height:24px">
<script>globalThis.__dis = []; document.getElementById('dis').addEventListener('click', function(e){ __dis.push(e.isTrusted); });</script>
"##).await;
    let r1 = page.human_click("#dis").await.unwrap();
    let r2 = page.human_type("#ce", "hi").await.unwrap();
    let r3 = page.human_type("#ro", "ro").await.unwrap();
    let st = page.evaluate("JSON.stringify({ disabled_button_click_listener_ran: __dis, ce_text: document.getElementById('ce').textContent, ce_expando_value: document.getElementById('ce').value, readonly_value: document.getElementById('ro').value })").unwrap();
    report("p28", format!("{{\"click_disabled\":{r1:?},\"type_contenteditable\":{r2:?},\"type_readonly\":{r3:?},\"state\":{st}}}"));
}

// ---------------------------------------------------------------------------
// P29 — the owner <iframe> element's `load`, a script-inserted about:blank
// frame, and `document.hasFocus()` across the frame tree.
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore = "diagnostic probe: prints observations, asserts nothing"]
async fn p29_owner_load_about_blank_and_has_focus() {
    let html = r##"<!doctype html><html><body>
<iframe id="a" srcdoc="<p>a</p>"></iframe>
<script>
globalThis.__loads = [];
document.getElementById('a').addEventListener('load', function(){ __loads.push('a'); });
var f = document.createElement('iframe'); f.id = 'dyn';
f.addEventListener('load', function(){ __loads.push('dyn-about-blank'); });
document.body.appendChild(f);
globalThis.__syncAfterAppend = __loads.slice();
</script></body></html>"##;
    let mut page = Page::from_html_with_url(html, "http://127.0.0.1:9/", Some(chrome_148_macos()))
        .await
        .unwrap();
    let _ = page.materialize_new_iframes().await;
    for _ in 0..3 {
        page.drive_children(Duration::from_millis(50)).await;
        let _ = page.evaluate_async("0", Duration::from_millis(50)).await;
    }
    let child_focus = page
        .child_iframe(0)
        .map(|c| {
            c.evaluate("String(document.hasFocus())")
                .unwrap_or_default()
        })
        .unwrap_or_default();
    report(
        "p29",
        format!(
            "{{\"owner_load_events\":{},\"sync_load_after_append\":{},\"materialized_children\":{},\"top_hasFocus\":{},\"child_hasFocus\":{child_focus}}}",
            page.evaluate("JSON.stringify(__loads)").unwrap(),
            page.evaluate("JSON.stringify(__syncAfterAppend)").unwrap(),
            page.child_iframe_count(),
            page.evaluate("String(document.hasFocus())").unwrap(),
        ),
    );
}
