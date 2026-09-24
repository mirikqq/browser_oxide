//! Every Date and Intl surface reports the profile's timezone and locale, and they agree
//! with each other — on a fresh page and on a pooled one that is reused after
//! another page moved the process-wide ICU zone.
//!
//! The zones are chosen to differ from the host's, which is where a JS-level
//! override used to come apart: `toString()` printed the profile's offset while
//! `getHours()` on the same object returned the host's hour.

use browser_oxide::stealth::{presets, StealthProfile};
use browser_oxide::{Page, PagePool};

const HTML: &str = "<!DOCTYPE html><html><body></body></html>";
const URL: &str = "https://example.com/";

/// Everything a page can be asked about its clock, read off one `Date`.
const PROBE: &str = r#"(() => {
    const d = new Date(Math.floor(Date.now() / 1000) * 1000);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23",
        year: "numeric", month: "numeric", day: "numeric",
        hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(d);
    const get = (t) => +parts.find((p) => p.type === t).value;
    const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"),
        get("hour"), get("minute"), get("second"));
    const m = /GMT([+-])(\d\d)(\d\d)/.exec(d.toString());
    return JSON.stringify({
        tz,
        getHours: d.getHours(),
        intlHour: +new Intl.DateTimeFormat("en", { hour: "numeric", hourCycle: "h23" }).format(d),
        sameDay: d.getDate() === get("day") && d.getMonth() + 1 === get("month")
            && d.getFullYear() === get("year") && d.getMinutes() === get("minute"),
        offset: d.getTimezoneOffset(),
        intlOffset: Math.round((d.getTime() - wallAsUtc) / 60000),
        toStringOffset: m ? (m[1] === "+" ? -1 : 1) * (+m[2] * 60 + +m[3]) : null,
        janFirst: new Date(2026, 0, 1).toISOString(),
        temporal: typeof Temporal === "object" ? Temporal.Now.timeZoneId() : null,
        localeHour: +d.toLocaleTimeString("en-US", { hour: "numeric", hourCycle: "h23" }),
    });
})()"#;

fn with_zone(timezone: &str) -> StealthProfile {
    let mut profile = presets::chrome_148_macos();
    profile.timezone = timezone.to_string();
    profile
}

/// Assert the page's clock surfaces agree with each other and name
/// `expected_zone`. Returns the probe for zone-specific checks.
fn assert_consistent(page: &mut Page, expected_zone: &str) -> serde_json::Value {
    let raw = page.evaluate(PROBE).expect("probe runs");
    let probe: serde_json::Value = serde_json::from_str(&raw).expect("probe returns JSON");
    assert_eq!(probe["tz"], expected_zone, "Intl default zone: {probe}");
    assert_eq!(
        probe["getHours"], probe["intlHour"],
        "getHours vs Intl: {probe}"
    );
    assert_eq!(
        probe["getHours"], probe["localeHour"],
        "getHours vs toLocaleTimeString: {probe}"
    );
    assert_eq!(probe["sameDay"], true, "local getters vs Intl: {probe}");
    assert_eq!(
        probe["offset"], probe["intlOffset"],
        "getTimezoneOffset vs Intl: {probe}"
    );
    assert_eq!(
        probe["offset"], probe["toStringOffset"],
        "getTimezoneOffset vs toString: {probe}"
    );
    if !probe["temporal"].is_null() {
        assert_eq!(
            probe["temporal"], expected_zone,
            "Temporal.Now vs Intl: {probe}"
        );
    }
    probe
}

#[tokio::test]
async fn a_fresh_page_reads_one_zone_everywhere() {
    let mut page = Page::with_profile(HTML, URL, with_zone("Asia/Tokyo"))
        .await
        .expect("page");
    let probe = assert_consistent(&mut page, "Asia/Tokyo");
    // Tokyo has no DST: UTC+9 all year.
    assert_eq!(probe["offset"], -540, "{probe}");
    // The local-time constructor builds in the profile's zone too.
    assert_eq!(probe["janFirst"], "2025-12-31T15:00:00.000Z", "{probe}");
}

#[tokio::test]
async fn a_zone_with_dst_stays_consistent() {
    let mut page = Page::with_profile(HTML, URL, with_zone("America/New_York"))
        .await
        .expect("page");
    let probe = assert_consistent(&mut page, "America/New_York");
    let offset = probe["offset"].as_i64().expect("numeric offset");
    assert!(offset == 240 || offset == 300, "EDT or EST, got {probe}");
    assert_eq!(probe["janFirst"], "2026-01-01T05:00:00.000Z", "{probe}");
}

/// The warm-reuse path: the zone is applied when the isolate is built, and any
/// page built after that moves the process-wide ICU default. Reuse must put the
/// pooled page's own zone back before its next document.
#[tokio::test]
async fn a_reused_page_gets_its_zone_back() {
    let pool = PagePool::new(1);
    let page = pool
        .acquire(Some(with_zone("Asia/Tokyo")))
        .await
        .expect("pooled page");
    pool.release(page);

    {
        // Built after the pooled page and dropped before it: V8 requires
        // isolates to be dropped in reverse creation order.
        let mut other = Page::with_profile(HTML, URL, with_zone("America/New_York"))
            .await
            .expect("page");
        assert_consistent(&mut other, "America/New_York");
    }

    let mut reused = pool
        .acquire(Some(with_zone("Asia/Tokyo")))
        .await
        .expect("reused page");
    let probe = assert_consistent(&mut reused, "Asia/Tokyo");
    assert_eq!(probe["offset"], -540, "{probe}");
}

/// ICU installs GMT for an id it does not know and reports success. Such a
/// zone must be refused outright, not half-applied.
#[tokio::test]
async fn an_unknown_zone_is_not_half_applied() {
    let mut reference = Page::with_profile(HTML, URL, with_zone("Europe/Berlin"))
        .await
        .expect("page");
    assert_consistent(&mut reference, "Europe/Berlin");
    drop(reference);

    let mut page = Page::with_profile(HTML, URL, with_zone("Mars/Olympus_Mons"))
        .await
        .expect("page");
    // The process default stays what it was, and every surface agrees on it.
    assert_consistent(&mut page, "Europe/Berlin");
}

/// Every locale-dependent surface formats in the profile's locale, and the
/// `Intl` constructors are V8's own again.
const LOCALE_PROBE: &str = r#"(() => {
    const d = new Date(Date.UTC(2026, 0, 2, 12));
    const n = 1234567.5;
    return JSON.stringify({
        navigator: navigator.language,
        dtf: Intl.DateTimeFormat().resolvedOptions().locale,
        nf: new Intl.NumberFormat().resolvedOptions().locale,
        collator: new Intl.Collator().resolvedOptions().locale,
        numberSame: n.toLocaleString() === new Intl.NumberFormat().format(n),
        dateSame: d.toLocaleDateString() === new Intl.DateTimeFormat().format(d),
        timeSame: d.toLocaleTimeString() === new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(d),
        explicit: new Intl.DateTimeFormat("de").resolvedOptions().locale,
        ctor: Intl.DateTimeFormat.prototype.constructor === Intl.DateTimeFormat
            && Intl.NumberFormat.prototype.constructor === Intl.NumberFormat,
        number: n.toLocaleString(),
    });
})()"#;

fn with_locale(language: &str, languages: &[&str]) -> StealthProfile {
    let mut profile = presets::chrome_148_windows();
    profile.language = language.to_string();
    profile.languages = languages.iter().map(|s| s.to_string()).collect();
    profile
}

fn locale_probe(page: &mut Page) -> serde_json::Value {
    serde_json::from_str(&page.evaluate(LOCALE_PROBE).expect("probe runs")).expect("JSON")
}

#[tokio::test]
async fn every_locale_surface_reads_the_profile_locale() {
    let mut page = Page::with_profile(HTML, URL, with_locale("ru-RU", &["ru-RU", "ru", "en"]))
        .await
        .expect("page");
    let p = locale_probe(&mut page);
    for key in ["navigator", "dtf", "nf", "collator"] {
        assert_eq!(p[key], "ru-RU", "{key}: {p}");
    }
    for key in ["numberSame", "dateSame", "timeSame", "ctor"] {
        assert_eq!(p[key], true, "{key}: {p}");
    }
    // Russian grouping and decimal separator, not the host's `1,234,567.5`.
    assert_eq!(p["number"], "1\u{a0}234\u{a0}567,5", "{p}");
    // An explicit locale is honoured, not overwritten with the profile's.
    assert_eq!(p["explicit"], "de", "{p}");
}

/// Same rule as the zone: a pooled page gets its locale back after another
/// page moved the process default.
#[tokio::test]
async fn a_reused_page_gets_its_locale_back() {
    let pool = PagePool::new(1);
    let page = pool
        .acquire(Some(with_locale("ja-JP", &["ja-JP", "ja", "en-US", "en"])))
        .await
        .expect("pooled page");
    pool.release(page);
    {
        let mut other = Page::with_profile(HTML, URL, with_locale("de-DE", &["de-DE", "de"]))
            .await
            .expect("page");
        assert_eq!(locale_probe(&mut other)["dtf"], "de-DE");
    }
    let mut reused = pool
        .acquire(Some(with_locale("ja-JP", &["ja-JP", "ja", "en-US", "en"])))
        .await
        .expect("reused page");
    let p = locale_probe(&mut reused);
    assert_eq!(p["dtf"], "ja-JP", "{p}");
    assert_eq!(p["numberSame"], true, "{p}");
}
