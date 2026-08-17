//! `OfflineAudioContext` signals completion as an event, not only as a promise.
//!
//! `startRendering()` returns a promise *and* fires a `complete` event carrying
//! the rendered buffer, and a script may wait on either. Resolving only the
//! promise leaves the listener-based half hanging forever with nothing logged —
//! measured on creepjs, where the audio collector is one entry in a
//! `Promise.all` over nineteen, so the whole report sat at "Computing...".

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;
use std::time::Duration;

const RENDER: &str = r#"
(function () {
  globalThis.__audio = { событие: null, атрибут: null, промис: null };
  var ctx = new OfflineAudioContext(1, 44100, 44100);
  var osc = ctx.createOscillator();
  var comp = ctx.createDynamicsCompressor();
  osc.connect(comp);
  comp.connect(ctx.destination);
  osc.start(0);
  ctx.addEventListener('complete', function (e) {
    globalThis.__audio.событие = 'тип=' + e.type +
      ' буфер=' + (e.renderedBuffer ? e.renderedBuffer.length : 'нет');
  });
  ctx.oncomplete = function () { globalThis.__audio.атрибут = 'вызван'; };
  ctx.startRendering().then(function (b) {
    globalThis.__audio.промис = 'длина=' + (b && b.length);
  });
  return 'запущено';
})()
"#;

#[tokio::test(flavor = "current_thread")]
async fn rendering_fires_complete_as_well_as_resolving() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let mut page = Page::from_html("<html><body></body></html>", Some(chrome_148_macos()))
                .await
                .expect("page");

            page.evaluate(RENDER).expect("start rendering");
            // The event is dispatched in a microtask; turning the loop once is
            // enough, but give it a few slices so a slow render still lands.
            for _ in 0..8 {
                let _ = page
                    .evaluate_async("void 0", Duration::from_millis(100))
                    .await;
            }

            let out = page
                .evaluate("JSON.stringify(globalThis.__audio)")
                .expect("read result");

            assert!(
                out.contains("тип=complete"),
                "событие complete не пришло: {out}"
            );
            assert!(
                out.contains("буфер=44100"),
                "у события нет renderedBuffer: {out}"
            );
            assert!(
                out.contains("\"атрибут\":\"вызван\""),
                "oncomplete не вызван: {out}"
            );
            // The promise half must keep working.
            assert!(out.contains("длина=44100"), "промис не разрешился: {out}");
        })
        .await;
}
