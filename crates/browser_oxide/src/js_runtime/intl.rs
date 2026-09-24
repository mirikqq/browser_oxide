//! The profile's timezone and locale, set where V8 actually reads them: ICU's
//! process defaults.
//!
//! A JS shim can only re-point the surfaces it knows about. The timezone shim
//! this replaces covered `Intl.DateTimeFormat`, `getTimezoneOffset` and the
//! `toString` family, but not the local getters (`getHours`, `getDate`, …), the
//! `Date` constructor or `Temporal.Now`, which kept the host's zone.
//! `new Date().toString()` printed the profile's offset while `getHours()` on
//! the same object returned the host's hour — a one-line probe:
//!
//! ```js
//! new Date().getHours() === +new Intl.DateTimeFormat("en", { hour: "numeric", hour12: false }).format()
//! ```
//!
//! The locale shim had the same shape of problem: it wrapped the `Intl`
//! constructors (a wrapper `prototype.constructor` does not point back to),
//! forced `resolvedOptions().locale` to the profile's even for an explicit
//! `new Intl.DateTimeFormat("de")`, and missed `toLocaleDateString`,
//! `toLocaleTimeString`, `Number.prototype.toLocaleString` and `localeCompare`,
//! which kept the host's locale.
//!
//! V8 reads every one of those from ICU's default zone and locale, so setting
//! the two values moves every surface at once and leaves nothing to fall out
//! of step, with the natives left untouched.
//!
//! # Process-global state
//!
//! ICU's defaults are one value each per process, while V8 caches what it
//! derives from them per isolate. [`claim`] and [`reapply`] therefore set the
//! process defaults (only when they change) and flush the calling isolate's
//! caches: the date cache with [`v8::TimeZoneDetection::Skip`] — *not*
//! `Redetect`, which would re-read the host zone and overwrite the one just
//! set — and the default locale plus cached ICU formatters with
//! `LocaleConfigurationChangeNotification`.
//!
//! Sequential pages with different identities are fine: each one sets its
//! defaults when it is built ([`claim`]) and again when it is reused
//! ([`reapply`]). Pages that run *concurrently* with a different zone or locale
//! cannot all be right — an `Intl.DateTimeFormat()` built in any of them reads
//! whichever defaults were set last. The live values are tracked so that case
//! is logged when it happens rather than discovered on a site; the remedy is
//! one timezone and locale per process.
//!
//! `TZ` and `LANG` are deliberately left alone. With ICU's defaults set
//! explicitly nothing in the engine reads them, while changing them would move
//! the embedding application's local time and locale too, and `setenv` races
//! the C-level `getenv` calls other threads make.

use deno_core::v8;
use std::collections::BTreeMap;
use std::ffi::{c_char, CStr, CString};
use std::sync::{Mutex, MutexGuard};

use super::IsolateEnterGuard;

extern "C" {
    // V8 statically links ICU 77 and version-suffixes its C symbols — the same
    // convention as `v8::icu::set_common_data_77`. If a V8 bump changes the ICU
    // major these fail to link, which is the right way to find out.

    /// `ucal_setDefaultTimeZone`: adopt `zone_id` (NUL-terminated UTF-16) as
    /// the process-wide default. ICU copies the id.
    fn ucal_setDefaultTimeZone_77(zone_id: *const u16, status: *mut i32);

    /// `ucal_getCanonicalTimeZoneID`: canonicalize `id` and report through
    /// `is_system_id` (an ICU `UBool`, one byte) whether it names a zone in
    /// ICU's database.
    fn ucal_getCanonicalTimeZoneID_77(
        id: *const u16,
        len: i32,
        result: *mut u16,
        result_capacity: i32,
        is_system_id: *mut i8,
        status: *mut i32,
    ) -> i32;

    /// `ucal_getDefaultTimeZone`: the current process-wide default id.
    fn ucal_getDefaultTimeZone_77(result: *mut u16, result_capacity: i32, status: *mut i32) -> i32;

    /// `uloc_forLanguageTag`: the ICU locale id for a BCP 47 tag, reporting
    /// how much of the tag it could parse.
    fn uloc_forLanguageTag_77(
        langtag: *const c_char,
        locale_id: *mut c_char,
        locale_id_capacity: i32,
        parsed_length: *mut i32,
        status: *mut i32,
    ) -> i32;

    /// `uloc_setDefault`: the process-wide default locale. ICU copies the id.
    fn uloc_setDefault_77(locale_id: *const c_char, status: *mut i32);

    /// `uloc_getDefault`: the current default locale id, owned by ICU.
    fn uloc_getDefault_77() -> *const c_char;

    /// `v8::Isolate::LocaleConfigurationChangeNotification()`, which the `v8`
    /// crate does not bind: drops the isolate's cached default locale and ICU
    /// formatters. A non-virtual member taking only `this`, so on every
    /// supported target it is called like a C function with the isolate as its
    /// one argument. The names are the Itanium (Linux, macOS) and MSVC
    /// (Windows) manglings, both checked against the v149 static libraries.
    #[cfg_attr(
        not(windows),
        link_name = "_ZN2v87Isolate37LocaleConfigurationChangeNotificationEv"
    )]
    #[cfg_attr(
        windows,
        link_name = "?LocaleConfigurationChangeNotification@Isolate@v8@@QEAAXXZ"
    )]
    fn v8_isolate_locale_configuration_change_notification(isolate: v8::UnsafeRawIsolatePtr);
}

/// Longer than any IANA id (the longest are ~32 UTF-16 units).
const ZONE_ID_CAPACITY: usize = 64;

/// Longer than any locale id a profile carries.
const LOCALE_ID_CAPACITY: usize = 157;

/// Whether ICU knows `timezone` as a system (IANA) zone.
///
/// This check cannot be left to `ucal_setDefaultTimeZone`: for an id it does
/// not recognise, ICU silently installs `Etc/Unknown` (GMT) and reports
/// success. Its status only ever carries allocation failures, so testing it
/// alone would ship a GMT clock under any typo'd profile.
fn is_system_zone(timezone: &str) -> bool {
    let id: Vec<u16> = timezone.encode_utf16().collect();
    if id.is_empty() || id.len() > ZONE_ID_CAPACITY {
        return false;
    }
    let mut canonical = [0u16; ZONE_ID_CAPACITY];
    let mut is_system: i8 = 0;
    let mut status: i32 = 0;
    // SAFETY: `id` is a live buffer of exactly `id.len()` UTF-16 units (ICU
    // does not need a terminator when a length is given), `canonical` is a
    // writable buffer of the capacity passed, and `is_system`/`status` are
    // valid out-parameters. ICU retains none of the pointers past the call.
    let len = unsafe {
        ucal_getCanonicalTimeZoneID_77(
            id.as_ptr(),
            id.len() as i32,
            canonical.as_mut_ptr(),
            canonical.len() as i32,
            &mut is_system,
            &mut status,
        )
    };
    // A positive UErrorCode is a failure; negative values are warnings.
    status <= 0 && is_system != 0 && len > 0
}

/// Install `timezone` as ICU's process-wide default. Returns whether it was.
fn set_default_zone(timezone: &str) -> bool {
    if !is_system_zone(timezone) {
        return false;
    }
    let mut zone: Vec<u16> = timezone.encode_utf16().collect();
    zone.push(0);
    let mut status: i32 = 0;
    // SAFETY: `zone` is a NUL-terminated UTF-16 buffer that outlives the call
    // and `status` is a valid out-parameter. ICU copies the id; it keeps no
    // pointer into `zone`.
    unsafe { ucal_setDefaultTimeZone_77(zone.as_ptr(), &mut status) };
    status <= 0
}

/// The process's ICU default zone, as ICU reports it: the id it was given, not
/// a canonicalized one.
fn default_zone() -> String {
    let mut buf = [0u16; ZONE_ID_CAPACITY];
    let mut status: i32 = 0;
    // SAFETY: `buf` is a writable buffer of the capacity passed and `status`
    // is a valid out-parameter; ICU writes at most `capacity` units.
    let len =
        unsafe { ucal_getDefaultTimeZone_77(buf.as_mut_ptr(), buf.len() as i32, &mut status) };
    let len = usize::try_from(len).unwrap_or(0).min(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

/// The ICU locale id for a BCP 47 tag (`"ru-RU"` → `"ru_RU"`), when ICU can
/// parse the whole tag as one.
///
/// `uloc_setDefault` takes anything and yields a bogus locale for garbage,
/// which V8 then reports as `"und"`; the whole tag has to parse first.
fn locale_id_for(tag: &str) -> Option<String> {
    let c_tag = CString::new(tag).ok()?;
    if tag.is_empty() || tag.len() >= LOCALE_ID_CAPACITY {
        return None;
    }
    let mut buf = [0 as c_char; LOCALE_ID_CAPACITY];
    let mut parsed: i32 = 0;
    let mut status: i32 = 0;
    // SAFETY: `c_tag` is NUL-terminated and outlives the call, `buf` is a
    // writable buffer of the capacity passed, `parsed`/`status` are valid
    // out-parameters; ICU keeps none of the pointers.
    let len = unsafe {
        uloc_forLanguageTag_77(
            c_tag.as_ptr(),
            buf.as_mut_ptr(),
            buf.len() as i32,
            &mut parsed,
            &mut status,
        )
    };
    let whole_tag = usize::try_from(parsed).ok() == Some(tag.len());
    if status > 0 || len <= 0 || !whole_tag {
        return None;
    }
    // SAFETY: on success ICU NUL-terminates `buf` when it has room, and `len`
    // is below its capacity, so the string ends inside the buffer.
    let id = unsafe { CStr::from_ptr(buf.as_ptr()) };
    Some(id.to_string_lossy().into_owned())
}

/// The process's ICU default locale id.
fn default_locale_id() -> String {
    // SAFETY: ICU returns a pointer to a NUL-terminated id it owns and keeps
    // alive (default locales are cached, never freed); it is copied at once.
    let id = unsafe { uloc_getDefault_77() };
    if id.is_null() {
        return String::new();
    }
    // SAFETY: non-null and NUL-terminated, per the above.
    unsafe { CStr::from_ptr(id) }.to_string_lossy().into_owned()
}

/// Install `locale_id` (an ICU id) as ICU's default. Returns whether it was.
fn set_default_locale(locale_id: &str) -> bool {
    let Ok(id) = CString::new(locale_id) else {
        return false;
    };
    let mut status: i32 = 0;
    // SAFETY: `id` is NUL-terminated and outlives the call; ICU copies it.
    unsafe { uloc_setDefault_77(id.as_ptr(), &mut status) };
    status <= 0
}

/// What one runtime asks ICU for.
pub(crate) struct IntlDefaults<'a> {
    /// IANA zone, e.g. `"Asia/Tokyo"`.
    pub timezone: &'a str,
    /// BCP 47 tag, e.g. `"ja-JP"` — the profile's `navigator.language`.
    pub locale: &'a str,
}

/// Which zones and locales live runtimes were built for. The lock also
/// serialises changes to ICU's defaults, so a check-then-set cannot
/// interleave with another one.
struct Registry {
    zones: BTreeMap<String, usize>,
    locales: BTreeMap<String, usize>,
}

static REGISTRY: Mutex<Registry> = Mutex::new(Registry {
    zones: BTreeMap::new(),
    locales: BTreeMap::new(),
});

fn registry() -> MutexGuard<'static, Registry> {
    // Nothing panics while holding the lock; recovering from poison keeps a
    // panic elsewhere from taking every later page's defaults down with it.
    REGISTRY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn release(map: &mut BTreeMap<String, usize>, key: &str) {
    if let Some(count) = map.get_mut(key) {
        *count = count.saturating_sub(1);
        if *count == 0 {
            map.remove(key);
        }
    }
}

/// Held in a runtime's `OpState` for the runtime's lifetime, so the registry
/// knows which zone and locale live pages were built for.
pub(crate) struct IntlLease {
    zone: Option<String>,
    locale: Option<String>,
}

impl Drop for IntlLease {
    fn drop(&mut self) {
        let mut registry = registry();
        if let Some(zone) = &self.zone {
            release(&mut registry.zones, zone);
        }
        if let Some(locale) = &self.locale {
            release(&mut registry.locales, locale);
        }
    }
}

/// Log a process default moving while runtimes built for another value live.
fn warn_if_shared(kind: &str, live: &BTreeMap<String, usize>, value: &str) {
    let others: Vec<&str> = live
        .keys()
        .map(String::as_str)
        .filter(|other| *other != value)
        .collect();
    if !others.is_empty() {
        tracing::warn!(
            kind,
            value,
            ?others,
            "ICU's process-wide default moved while pages built for another value are \
             alive; any of them running concurrently now reads this one — use one \
             timezone and locale per process"
        );
    }
}

/// What [`apply_locked`] managed to install.
struct Applied {
    zone: bool,
    locale: bool,
}

/// Make the requested zone and locale the process defaults where they are not
/// already, then flush `isolate`'s caches so it re-reads them.
///
/// Compared against what ICU actually holds rather than what was last set here,
/// so a default moved from outside this module is not mistaken for ours. The
/// flush happens even when nothing changed: another page may have moved a
/// default and back while this isolate cached the other value.
fn apply_locked(
    registry: &Registry,
    isolate: &mut v8::OwnedIsolate,
    defaults: &IntlDefaults<'_>,
) -> Applied {
    let zone = if default_zone() == defaults.timezone {
        true
    } else if set_default_zone(defaults.timezone) {
        warn_if_shared("timezone", &registry.zones, defaults.timezone);
        true
    } else {
        tracing::warn!(
            timezone = defaults.timezone,
            "timezone is not a zone ICU knows; the page keeps the process default"
        );
        false
    };

    let locale = match locale_id_for(defaults.locale) {
        Some(id) if default_locale_id() == id => true,
        Some(id) if set_default_locale(&id) => {
            warn_if_shared("locale", &registry.locales, defaults.locale);
            true
        }
        _ => {
            tracing::warn!(
                locale = defaults.locale,
                "locale is not a BCP 47 tag ICU can parse; the page keeps the process default"
            );
            false
        }
    };

    let _entered = IsolateEnterGuard::enter(isolate);
    isolate.date_time_configuration_change_notification(v8::TimeZoneDetection::Skip);
    // SAFETY: `as_raw_isolate_ptr` yields the C++ `v8::Isolate*` behind this
    // live isolate (the Rust `Isolate` is only a handle to it; the type is a
    // `repr(transparent)` pointer, so it passes as `this`). The isolate is
    // entered on the current thread by the guard above for the duration of the
    // call, as V8 requires of any `Isolate` method; the function only resets
    // per-isolate caches and retains no pointer.
    unsafe { v8_isolate_locale_configuration_change_notification(isolate.as_raw_isolate_ptr()) };
    Applied { zone, locale }
}

/// Apply `defaults` for a newly built runtime and register it as live.
///
/// Call before any script runs in the isolate, so nothing observes the host's
/// values first. A value ICU refuses is left at the process default — wrong,
/// but consistently so on every surface — and is not registered.
pub(crate) fn claim(isolate: &mut v8::OwnedIsolate, defaults: &IntlDefaults<'_>) -> IntlLease {
    let mut registry = registry();
    let applied = apply_locked(&registry, isolate, defaults);
    let zone = applied.zone.then(|| defaults.timezone.to_string());
    let locale = applied.locale.then(|| defaults.locale.to_string());
    if let Some(zone) = &zone {
        *registry.zones.entry(zone.clone()).or_default() += 1;
    }
    if let Some(locale) = &locale {
        *registry.locales.entry(locale.clone()).or_default() += 1;
    }
    IntlLease { zone, locale }
}

/// Re-apply a live runtime's defaults before it serves another document.
///
/// The warm-reuse path needs this: they were applied when the isolate was
/// built, and any page built since may have moved the process defaults.
pub(crate) fn reapply(isolate: &mut v8::OwnedIsolate, defaults: &IntlDefaults<'_>) {
    apply_locked(&registry(), isolate, defaults);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iana_zones_are_known() {
        for zone in ["America/Los_Angeles", "Europe/Moscow", "Asia/Tokyo", "UTC"] {
            assert!(is_system_zone(zone), "{zone} should be a system zone");
        }
    }

    /// ICU installs GMT for an unknown id and reports success, so rejecting
    /// these is on us.
    #[test]
    fn unknown_zones_are_rejected() {
        for zone in ["", "Mars/Olympus_Mons", "America/Los Angeles", "GMT+05:00"] {
            assert!(!is_system_zone(zone), "{zone:?} should be rejected");
        }
        assert!(!is_system_zone(&"A/".repeat(64)));
    }

    #[test]
    fn a_rejected_zone_leaves_the_default_alone() {
        let _serialised = registry();
        let original = default_zone();
        assert!(set_default_zone("Asia/Tokyo"));
        assert!(!set_default_zone("Mars/Olympus_Mons"));
        assert_eq!(default_zone(), "Asia/Tokyo");
        assert!(set_default_zone("Europe/Berlin"));
        assert_eq!(default_zone(), "Europe/Berlin");
        set_default_zone(&original);
    }

    #[test]
    fn language_tags_become_icu_locale_ids() {
        assert_eq!(locale_id_for("ru-RU").as_deref(), Some("ru_RU"));
        assert_eq!(locale_id_for("ja").as_deref(), Some("ja"));
        assert_eq!(locale_id_for("zh-Hans-CN").as_deref(), Some("zh_Hans_CN"));
        assert_eq!(locale_id_for("de-CH").as_deref(), Some("de_CH"));
    }

    /// `uloc_setDefault` accepts anything, so garbage has to be stopped here.
    #[test]
    fn unparsable_tags_are_rejected() {
        for tag in ["", "not a tag", "en_US", "e", "en-US-", "x\0y"] {
            assert_eq!(locale_id_for(tag), None, "{tag:?}");
        }
    }

    #[test]
    fn the_default_locale_round_trips() {
        let _serialised = registry();
        let original = default_locale_id();
        assert!(set_default_locale("de_CH"));
        assert_eq!(default_locale_id(), "de_CH");
        set_default_locale(&original);
    }
}
