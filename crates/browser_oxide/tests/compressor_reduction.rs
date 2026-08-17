//! `DynamicsCompressorNode.reduction` — Chrome's shape and a rendered value.
//!
//! The property was missing entirely. hCaptcha's audio probe reads
//! `node.reduction.value || node.reduction` (the legacy-AudioParam compat
//! form) from its `complete` handler, so the very first line of the handler
//! threw `Cannot read properties of undefined (reading 'value')` and the whole
//! audio fingerprint silently failed — measured on the Epic Games login frame.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;
use std::time::Duration;

const RENDER: &str = r#"
(function () {
  var ctx = new OfflineAudioContext(1, 44100, 44100);
  var osc = ctx.createOscillator();
  var comp = ctx.createDynamicsCompressor();
  osc.type = 'triangle';
  osc.frequency.value = 10000;
  osc.connect(comp);
  comp.connect(ctx.destination);
  osc.start(0);
  globalThis.__red = 'ждём';
  ctx.startRendering().then(function () { globalThis.__red = comp.reduction; });
  return 'запущено';
})()
"#;

#[tokio::test(flavor = "current_thread")]
async fn reduction_matches_chrome_shape_and_follows_the_render() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let mut page = Page::from_html("<html><body></body></html>", Some(chrome_148_macos()))
                .await
                .expect("page");

            // Chrome: readonly accessor on the prototype, 0 before any render.
            let shape = page
                .evaluate(
                    "(function(){var c=new OfflineAudioContext(1,128,44100);\
                      var k=c.createDynamicsCompressor();\
                      var d=Object.getOwnPropertyDescriptor(\
                        Object.getPrototypeOf(k),'reduction');\
                      return [typeof k.reduction, !!(d&&d.get), !!(d&&d.set),\
                        Object.prototype.hasOwnProperty.call(k,'reduction'),\
                        k.reduction].join('|')})()",
                )
                .expect("read shape");
            assert_eq!(shape, "number|true|false|false|0", "форма reduction");

            // The probe's own access pattern must not throw.
            let probe = page
                .evaluate(
                    "(function(){var c=new OfflineAudioContext(1,128,44100);\
                      var k=c.createDynamicsCompressor();\
                      var v=k.reduction;return String((v&&v.value)||v)})()",
                )
                .expect("read probe");
            assert_eq!(probe, "0", "паттерн `reduction.value || reduction`");

            page.evaluate(RENDER).expect("start rendering");
            for _ in 0..8 {
                let _ = page
                    .evaluate_async("void 0", Duration::from_millis(100))
                    .await;
            }

            let out = page.evaluate("String(globalThis.__red)").expect("read");
            let value: f64 = out
                .parse()
                .unwrap_or_else(|_| panic!("reduction не число после рендера: {out}"));
            assert!(
                value < 0.0 && value > -100.0,
                "reduction после рендера — отрицательные дБ, получили {value}"
            );
        })
        .await;
}
