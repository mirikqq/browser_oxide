//! The engine's privileged input capabilities — the trusted-event minter, the
//! behaviour-generator bridge, the humanized-input API — must be unreachable
//! from page script, on every navigation, while engine-driven input stays
//! trusted.
//!
//! The engine namespace is NOT a hiding place: `Object.getOwnPropertySymbols`
//! reveals it to any caller that passes a second argument, which is exactly
//! what the probe below does. So the probe walks everything reachable from it
//! and offers a fresh event to every function it finds: a single one that
//! comes back `isTrusted` is a page-usable forgery primitive.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::{Page, PagePool};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Page-side probe. Returns a JSON array naming every namespace path that
/// either still carries a known capability or minted trust on a probe event.
const PROBE_JS: &str = r#"(function () {
  var ns = null;
  try {
    var syms = Object.getOwnPropertySymbols(globalThis, 1);
    for (var i = 0; i < syms.length; i++) {
      var v = globalThis[syms[i]];
      if (v && v.__bo) { ns = v; break; }
    }
  } catch (e) {}
  if (!ns) return '["no namespace"]';
  var found = [];
  ['markTrusted', 'inputApi', 'inheritOrigin', 'human'].forEach(function (n) {
    if (n in ns) found.push('ns.' + n);
  });
  if (ns.input) {
    ['mark', 'clickElement', 'clickSelector', 'typeElement', 'typeSelector',
     'moveTo', 'pointerStep', 'setAmbient'].forEach(function (n) {
      if (n in ns.input) found.push('ns.input.' + n);
    });
  }
  var seen = new Set();
  function walk(obj, path, depth) {
    if (!obj || seen.has(obj)) return;
    seen.add(obj);
    var keys;
    try { keys = Reflect.ownKeys(obj); } catch (e) { return; }
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j], val;
      try { val = obj[k]; } catch (e) { continue; }
      var name = path + '.' + String(k);
      if (typeof val === 'function') {
        var ev = new Event('probe');
        try { val.call(obj, ev); } catch (e) {}
        if (ev.isTrusted) found.push(name);
      } else if (val && typeof val === 'object' && depth < 2) {
        walk(val, name, depth + 1);
      }
    }
  }
  walk(ns, 'ns', 0);
  return JSON.stringify(found);
})()"#;

#[tokio::test]
async fn page_script_cannot_reach_a_trust_minter() {
    let mut page = Page::from_html(
        "<html><body><button id=b>b</button></body></html>",
        Some(chrome_148_macos()),
    )
    .await
    .expect("page");
    page.install_humanize().expect("install");
    let found = page.evaluate(PROBE_JS).expect("probe");
    assert_eq!(found, "[]", "page-reachable capabilities: {found}");
}

/// Control for the probe itself: a minter deliberately leaked onto the
/// namespace — the way `ns.input.mark` used to be — must be caught, or the
/// empty result above proves nothing.
#[tokio::test]
async fn probe_catches_a_leaked_minter() {
    let mut page = Page::from_html("<html><body></body></html>", Some(chrome_148_macos()))
        .await
        .expect("page");
    page.install_humanize().expect("install");
    page.evaluate_privileged(
        "(function (caps) { \
           var s = Object.getOwnPropertySymbols(globalThis, 1); \
           for (var i = 0; i < s.length; i++) { var v = globalThis[s[i]]; \
             if (v && v.__bo) { v.input.leaked = function (e) { caps.markTrusted(e); }; } } })",
    )
    .unwrap();
    let found = page.evaluate(PROBE_JS).expect("probe");
    assert_eq!(found, r#"["ns.input.leaked"]"#);
}

#[tokio::test]
async fn engine_input_stays_trusted_and_privileged_calls_see_the_minter() {
    let mut page = Page::from_html(
        r#"<html><body>
           <button id="b" style="position:absolute;left:40px;top:40px;width:90px;height:30px">b</button>
           <script>
             globalThis.__log = [];
             document.getElementById('b').addEventListener('click', e => __log.push(e.isTrusted));
           </script></body></html>"#,
        Some(chrome_148_macos()),
    )
    .await
    .expect("page");
    page.human_click("#b").await.expect("human click");
    assert_eq!(page.evaluate("JSON.stringify(__log)").unwrap(), "[true]");

    // A driver composing its own event gets the minter as an argument.
    let trusted = page
        .evaluate_privileged(
            "(function (caps) { var e = new MouseEvent('click', {bubbles: true}); \
              caps.markTrusted(e); document.getElementById('b').dispatchEvent(e); \
              return String(e.isTrusted); })",
        )
        .unwrap();
    assert_eq!(trusted, "true");
    // …and a page-constructed one stays untrusted.
    page.evaluate(
        "document.getElementById('b').dispatchEvent(new MouseEvent('click', {bubbles: true}))",
    )
    .unwrap();
    assert_eq!(
        page.evaluate("JSON.stringify(__log)").unwrap(),
        "[true,true,false]"
    );
}

/// On the warm path the page's own scripts run BEFORE humanize.js is
/// installed, so this is the window a republish-from-`reset_for_reuse` scheme
/// left open. The probe runs from the document's own inline script, on both
/// the cold first navigation and the warm second one.
#[tokio::test]
async fn warm_navigation_page_scripts_find_nothing_and_clicks_stay_trusted() {
    let html = format!(
        r#"<!doctype html><html><body>
<button id="go" style="position:absolute;left:40px;top:40px;width:90px;height:30px">go</button>
<script>
  globalThis.__probe = {PROBE_JS};
  globalThis.__log = [];
  document.getElementById('go').addEventListener('click', (e) => __log.push(e.isTrusted));
</script>
</body></html>"#
    );
    let port = spawn_server(html).await;
    let url = format!("http://127.0.0.1:{port}/");
    let pool = PagePool::new(1);

    for round in 0..2 {
        let mut page = pool
            .navigate(&url, chrome_148_macos())
            .await
            .unwrap_or_else(|e| panic!("navigation {round}: {e}"));
        assert_eq!(
            page.evaluate("__probe").unwrap(),
            "[]",
            "navigation {round}: page script reached capabilities"
        );
        page.human_click("#go").await.expect("click");
        assert_eq!(
            page.evaluate("JSON.stringify(__log)").unwrap(),
            "[true]",
            "navigation {round}: click not trusted"
        );
        pool.release(page);
    }
}

async fn spawn_server(html: String) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            let body = html.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.write_all(body.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    port
}
