//! The engine's layout against Chrome's on saved real pages.
//!
//! The pages live in `tests/layout_corpus/real/`, which is not in git (they are
//! other people's work): make them with `prepare.mjs`, record Chrome's numbers with
//! `snapshot.mjs --real`. Without that directory this test does nothing.
//!
//! Every element is compared by its position in document order. Nothing here
//! asserts a match rate unless `real/floors.json` exists; write it with
//! `LAYOUT_CORPUS_WRITE_FLOORS=1`.
//!
//!   cargo test --release --test layout_corpus_real -- --nocapture

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use browser_oxide::layout::LayoutMode;
use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;
use serde_json::Value;

const TOLERANCE: f64 = 1.0;

const COLLECT: &str = "(() => {\
    const all = [...document.querySelectorAll('*')].map((e) => {\
        const b = e.getBoundingClientRect();\
        return [e.localName, b.x, b.y, b.width, b.height];\
    });\
    return JSON.stringify({viewport: [innerWidth, innerHeight], all});\
})()";

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/layout_corpus/real")
}

struct Score {
    matched: usize,
    total: usize,
    by_tag: BTreeMap<String, (usize, usize)>,
    samples: Vec<String>,
}

fn compare(chrome: &[Value], engine: &[Value]) -> Score {
    let mut score = Score {
        matched: 0,
        total: chrome.len(),
        by_tag: BTreeMap::new(),
        samples: Vec::new(),
    };
    let nums = |v: &Value| -> Vec<f64> {
        v.as_array()
            .map(|a| a.iter().skip(1).filter_map(Value::as_f64).collect())
            .unwrap_or_default()
    };
    for (i, want) in chrome.iter().enumerate() {
        let tag = want[0].as_str().unwrap_or("?").to_string();
        let (w, h) = (nums(want), engine.get(i).map(nums).unwrap_or_default());
        let entry = score.by_tag.entry(tag.clone()).or_default();
        entry.1 += 1;
        if w.len() == 4 && h.len() == 4 && w.iter().zip(&h).all(|(a, b)| (a - b).abs() <= TOLERANCE)
        {
            score.matched += 1;
            entry.0 += 1;
        } else if score.samples.len() < 14 {
            score
                .samples
                .push(format!("#{i} <{tag}> chrome {w:.1?} engine {h:.1?}"));
        }
    }
    score
}

fn report(page: &str, mode: &str, s: &Score) {
    println!(
        "{page} {mode}: {}/{} ({:.1}%)",
        s.matched,
        s.total,
        100.0 * s.matched as f64 / s.total.max(1) as f64
    );
    if std::env::var_os("LAYOUT_CORPUS_REPORT").is_some() && mode == "full" {
        let mut tags: Vec<_> = s.by_tag.iter().filter(|(_, (m, t))| m < t).collect();
        tags.sort_by_key(|(_, (m, t))| std::cmp::Reverse(t - m));
        for (tag, (m, t)) in tags.iter().take(8) {
            println!("    <{tag}>: {} of {t} off", t - m);
        }
        for line in &s.samples {
            println!("    {line}");
        }
    }
}

#[tokio::test]
async fn real_pages_against_chrome() {
    let Ok(entries) = fs::read_dir(dir()) else {
        println!("no saved pages in {}; nothing to compare", dir().display());
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            e.path()
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
        })
        .filter(|n| {
            dir().join(format!("{n}.html")).exists() && dir().join(format!("{n}.json")).exists()
        })
        .collect();
    names.sort();
    names.dedup();

    let floors_path = dir().join("floors.json");
    let floors: Value = fs::read_to_string(&floors_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let mut written = serde_json::Map::new();
    let (mut sum_full, mut sum_legacy, mut sum_total) = (0, 0, 0);
    for name in &names {
        let html = fs::read_to_string(dir().join(format!("{name}.html"))).unwrap();
        let reference: Value =
            serde_json::from_str(&fs::read_to_string(dir().join(format!("{name}.json"))).unwrap())
                .unwrap();
        let chrome = reference["all"].as_array().cloned().unwrap_or_default();
        let mut page =
            Page::from_html_with_url(&html, "file:///real.html", Some(chrome_148_macos()))
                .await
                .expect("page");
        let mut scores = Vec::new();
        for (mode, label) in [(LayoutMode::Legacy, "legacy"), (LayoutMode::Full, "full")] {
            page.set_layout_mode(mode);
            let got: Value =
                serde_json::from_str(&page.evaluate(COLLECT).expect("evaluate")).unwrap();
            let engine = got["all"].as_array().cloned().unwrap_or_default();
            if engine.len() != chrome.len() {
                println!(
                    "{name}: Chrome has {} elements, the engine {}",
                    chrome.len(),
                    engine.len()
                );
            }
            let score = compare(&chrome, &engine);
            report(name, label, &score);
            scores.push(score);
        }
        sum_legacy += scores[0].matched;
        sum_full += scores[1].matched;
        sum_total += scores[1].total;
        written.insert(name.clone(), Value::from(scores[1].matched));
        if let Some(floor) = floors[name].as_u64() {
            assert!(
                scores[1].matched as u64 >= floor,
                "{name}: full layout matches {}, floor is {floor}",
                scores[1].matched
            );
        }
    }
    if sum_total > 0 {
        println!(
            "all pages: legacy {sum_legacy}/{sum_total}, full {sum_full}/{sum_total} ({:.1}%)",
            100.0 * sum_full as f64 / sum_total as f64
        );
    }
    if std::env::var_os("LAYOUT_CORPUS_WRITE_FLOORS").is_some() {
        fs::write(
            &floors_path,
            serde_json::to_string_pretty(&Value::Object(written)).unwrap(),
        )
        .unwrap();
    }
}
