//! The engine's layout against Chrome's, on the corpus in `tests/layout_corpus/`.
//!
//! Every case is a small self-contained page; `chrome/<case>.json` is what a real
//! Chrome reported for each element with an `id` (`snapshot.mjs` records it). An
//! element matches when its border box is within one pixel of Chrome's on all four
//! numbers, and its `getClientRects()` lists the same lines. The numbers below are floors: `Full` may only get better, and
//! `Legacy` (the layout headless users have today) must not move at all.
//!
//! `LAYOUT_CORPUS_REPORT=1 cargo test --test layout_corpus -- --nocapture` lists
//! every miss.

use std::fs;
use std::path::PathBuf;

use browser_oxide::layout::LayoutMode;
use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;
use serde_json::Value;

const TOLERANCE: f64 = 1.0;

/// What `Legacy` matches today; it is frozen, so this is an equality.
const LEGACY_MATCHED: usize = 53;
/// What `Full` has reached; raise it as the layout improves.
const FULL_FLOOR: usize = 138;

const COLLECT: &str = "(() => {\
    const box = (b) => [b.x, b.y, b.width, b.height];\
    const r = {}, c = {};\
    for (const e of document.querySelectorAll('[id]')) {\
        r[e.id] = box(e.getBoundingClientRect());\
        c[e.id] = [...e.getClientRects()].map(box);\
    }\
    return JSON.stringify({viewport: [innerWidth, innerHeight], rects: r, client: c});\
})()";

struct Case {
    name: String,
    html: String,
    reference: Value,
}

fn load_cases() -> Vec<Case> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/layout_corpus");
    let mut names: Vec<String> = fs::read_dir(dir.join("cases"))
        .expect("cases dir")
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            e.path()
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
        })
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| Case {
            html: fs::read_to_string(dir.join("cases").join(format!("{name}.html"))).unwrap(),
            reference: serde_json::from_str(
                &fs::read_to_string(dir.join("chrome").join(format!("{name}.json")))
                    .unwrap_or_else(|_| panic!("no Chrome reference for {name}: run snapshot.mjs")),
            )
            .unwrap(),
            name,
        })
        .collect()
}

fn numbers(v: &Value) -> Vec<f64> {
    v.as_array()
        .map(|a| a.iter().filter_map(Value::as_f64).collect())
        .unwrap_or_default()
}

/// `(matched, total, misses)` for one page in its current mode.
fn compare(page: &mut Page, case: &Case) -> (usize, usize, Vec<String>) {
    let got: Value = serde_json::from_str(&page.evaluate(COLLECT).expect("evaluate")).unwrap();
    assert_eq!(
        numbers(&got["viewport"]),
        numbers(&case.reference["viewport"]),
        "{}: engine and Chrome disagree about the viewport",
        case.name
    );
    let (mut matched, mut total, mut misses) = (0, 0, Vec::new());
    let close = |want: &[f64], have: &[f64]| {
        have.len() == want.len()
            && want
                .iter()
                .zip(have)
                .all(|(w, h)| (w - h).abs() <= TOLERANCE)
    };
    for (id, want) in case.reference["rects"].as_object().unwrap() {
        total += 1;
        let want = numbers(want);
        let have = numbers(&got["rects"][id]);
        let want_lines: Vec<Vec<f64>> = case.reference["client"][id]
            .as_array()
            .map(|a| a.iter().map(numbers).collect())
            .unwrap_or_default();
        let have_lines: Vec<Vec<f64>> = got["client"][id]
            .as_array()
            .map(|a| a.iter().map(numbers).collect())
            .unwrap_or_default();
        let lines_ok = want_lines.len() == have_lines.len()
            && want_lines.iter().zip(&have_lines).all(|(w, h)| close(w, h));
        if close(&want, &have) && lines_ok {
            matched += 1;
        } else {
            misses.push(format!(
                "{}#{id}: chrome {want:?} {} line(s), engine {have:?} {} line(s)",
                case.name,
                want_lines.len(),
                have_lines.len()
            ));
        }
    }
    (matched, total, misses)
}

async fn run(mode: LayoutMode) -> (usize, usize, Vec<String>) {
    let (mut matched, mut total, mut misses) = (0, 0, Vec::new());
    for case in load_cases() {
        let mut page =
            Page::from_html_with_url(&case.html, "file:///corpus.html", Some(chrome_148_macos()))
                .await
                .expect("page");
        page.set_layout_mode(mode);
        let (m, t, x) = compare(&mut page, &case);
        matched += m;
        total += t;
        misses.extend(x);
    }
    (matched, total, misses)
}

fn report(mode: &str, matched: usize, total: usize, misses: &[String]) {
    println!("{mode}: {matched}/{total} elements within {TOLERANCE}px of Chrome");
    if std::env::var_os("LAYOUT_CORPUS_REPORT").is_some() {
        for m in misses {
            println!("  miss {m}");
        }
    }
}

#[tokio::test]
async fn legacy_layout_is_frozen() {
    let (matched, total, misses) = run(LayoutMode::Legacy).await;
    report("legacy", matched, total, &misses);
    assert_eq!(matched, LEGACY_MATCHED, "the legacy layout moved");
}

#[tokio::test]
async fn full_layout_does_not_regress() {
    let (matched, total, misses) = run(LayoutMode::Full).await;
    report("full", matched, total, &misses);
    assert!(
        matched >= FULL_FLOOR,
        "full layout matches {matched}/{total}, floor is {FULL_FLOOR}"
    );
}
