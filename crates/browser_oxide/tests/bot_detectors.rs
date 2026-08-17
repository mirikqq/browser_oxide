//! What public bot detectors see when this engine loads their page.
//!
//! Two shapes, because detectors come in two kinds. `bot.sannysoft.com` reads a
//! fixed list of properties and marks each pass/fail, so its verdict is stable
//! enough to assert on and it guards the signals a stealth profile exists to
//! control. The rest score a browser as a whole, change their scoring without
//! notice, and go down for days at a time — asserting on those buys flakiness,
//! so the sweep prints what each one says and leaves the judgement to a person.
//!
//! `#[ignore]`: needs the network and live third parties. Run with
//! `cargo test -p browser_oxide --test bot_detectors -- --ignored --test-threads=1 --nocapture`
//! — `--nocapture` is the point of the sweep.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::PagePool;
use std::time::Duration;

/// Give a detector's own scripts time to finish scoring before reading the page.
async fn settle(page: &mut browser_oxide::Page, rounds: usize) {
    for _ in 0..rounds {
        let _ = page
            .evaluate_async("void 0", Duration::from_millis(250))
            .await;
    }
}

/// Every `pass`/`fail` row of the sannysoft table, as `name\tverdict\tvalue`.
///
/// Reads the row's *cells* rather than its text: each value cell also holds the
/// `<script>` that produced it, and its source would otherwise be indexed as the
/// value.
const SANNYSOFT_ROWS: &str = r#"
(function () {
  var out = [];
  var rows = document.querySelectorAll('table tr');
  for (var i = 0; i < rows.length; i++) {
    var c = rows[i].querySelectorAll('td');
    if (c.length < 2) continue;
    var name = (c[0].textContent || '').trim();
    if (!name || name.length > 48) continue;
    var cls = String(c[1].className || '');
    var verdict = /passed/.test(cls) ? 'pass' : (/failed/.test(cls) ? 'FAIL' : '-');
    var value = '';
    for (var j = 0; j < c[1].childNodes.length; j++) {
      var n = c[1].childNodes[j];
      if (n.nodeType === 1 && n.tagName === 'SCRIPT') continue;
      value += (n.textContent || '');
    }
    out.push(name + '\t' + verdict + '\t' + value.trim().slice(0, 90));
  }
  return out.join('\n');
})()
"#;

#[tokio::test(flavor = "current_thread")]
#[ignore = "network: loads a live bot detector"]
async fn sannysoft_finds_nothing_to_flag() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let pool = PagePool::new(1);
            if let Ok(seed) = pool.acquire(Some(chrome_148_macos())).await {
                pool.release(seed);
            }
            let mut page = pool
                .navigate("https://bot.sannysoft.com/", chrome_148_macos())
                .await
                .expect("navigate");
            settle(&mut page, 8).await;

            let table = page.evaluate(SANNYSOFT_ROWS).expect("read table");
            let table = table
                .trim_matches('"')
                .replace("\\n", "\n")
                .replace("\\t", "\t");
            println!("\n=== bot.sannysoft.com ===\n{table}\n");

            let row = |name: &str| -> String {
                table
                    .lines()
                    .find(|l| l.starts_with(name))
                    .unwrap_or_default()
                    .to_string()
            };

            // The signal the whole category is named after.
            assert!(
                row("WebDriver").contains("missing") || row("WebDriver").contains("pass"),
                "webdriver виден детектору: {}",
                row("WebDriver")
            );
            // Headless Chrome's historical tells: no plugins, no languages, a
            // software WebGL stack.
            assert!(
                !row("Plugins Length").contains("\t0") && !row("Plugins Length").is_empty(),
                "плагинов нет: {}",
                row("Plugins Length")
            );
            assert!(
                row("Languages").contains("en"),
                "языки пусты: {}",
                row("Languages")
            );
            assert!(
                !row("WebGL Renderer").ends_with('\t') && row("WebGL Renderer").contains("ANGLE"),
                "WebGL выдаёт программный рендерер: {}",
                row("WebGL Renderer")
            );

            let flagged: Vec<&str> = table.lines().filter(|l| l.contains("\tFAIL\t")).collect();
            assert!(flagged.is_empty(), "детектор пометил: {flagged:?}");
        })
        .await;
}

/// Detectors worth watching, each with the text that carries its verdict.
///
/// Not assertions: several of these rescore browsers regularly, and
/// `arh.antoinevastel.com` answered 502 for the whole of one afternoon while
/// this was written. The sweep exists so a stealth change can be judged against
/// all of them in one run.
const SWEEP: &[(&str, &str)] = &[
    ("creepjs", "https://abrahamjuliot.github.io/creepjs/"),
    ("browserscan", "https://www.browserscan.net/bot-detection"),
    ("rebrowser", "https://bot-detector.rebrowser.net/"),
    (
        "device-and-browser-info",
        "https://deviceandbrowserinfo.com/are_you_a_bot",
    ),
    (
        "areyouheadless",
        "https://arh.antoinevastel.com/bots/areyouheadless",
    ),
];

#[tokio::test(flavor = "current_thread")]
#[ignore = "network: sweeps live bot detectors, prints their verdicts"]
async fn detector_sweep_reports_what_each_one_says() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let pool = PagePool::new(1);
            if let Ok(seed) = pool.acquire(Some(chrome_148_macos())).await {
                pool.release(seed);
            }

            let mut answered = 0;
            for (name, url) in SWEEP {
                let Ok(mut page) = pool.navigate(url, chrome_148_macos()).await else {
                    println!("[{name}] не открылся: {url}");
                    continue;
                };
                // creepjs scores for several seconds before it writes anything.
                settle(&mut page, 40).await;

                // Verdicts live in the page's own words, and `textContent` on
                // `<body>` also returns every `<style>` and `<script>` body —
                // creepjs alone buries its score under kilobytes of generated
                // `@media` rules. Drop those and the site's own navigation.
                let text = page
                    .evaluate(
                        "(function(){var b=document.body;if(!b)return '';\
                         var c=b.cloneNode(true);\
                         c.querySelectorAll('style,script,noscript,nav,header,footer')\
                          .forEach(function(n){n.remove();});\
                         return (c.textContent||'').replace(/\\s+/g,' ').trim().slice(0,600);})()",
                    )
                    .unwrap_or_default();
                let text = text.trim_matches('"');
                if text.len() > 40 {
                    answered += 1;
                }
                println!("\n=== {name} — {url} ===\n{text}\n");
            }

            assert!(
                answered > 0,
                "ни один детектор не ответил — сеть или движок, а не stealth"
            );
        })
        .await;
}
