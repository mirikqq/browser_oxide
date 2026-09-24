//! The profile's timezone, set where V8 actually reads it: ICU's default zone.
//!
//! A JS shim can only re-point the surfaces it knows about. The one this
//! replaces covered `Intl.DateTimeFormat`, `getTimezoneOffset` and the
//! `toString` family, but not the local getters (`getHours`, `getDate`, …) or
//! the `Date` constructor, which kept the host's zone. `new Date().toString()`
//! printed the profile's offset while `getHours()` on the same object returned
//! the host's hour — two methods of one object contradicting each other, and a
//! one-line probe:
//!
//! ```js
//! new Date().getHours() === +new Intl.DateTimeFormat("en", { hour: "numeric", hour12: false }).format()
//! ```
//!
//! V8 reads local time, the `Intl` default zone and `toLocale*String` from ICU's
//! default zone, so setting that one value moves every surface at once and
//! leaves nothing to fall out of step.
//!
//! # Process-global state
//!
//! ICU's default zone is one value per process, while V8 caches what it derives
//! from it per isolate. [`claim`] and [`reapply`] therefore set the process
//! default (only when it changes) and flush the calling isolate's date cache
//! with [`v8::TimeZoneDetection::Skip`] — *not* `Redetect`, which would re-read
//! the host zone and overwrite the one just set.
//!
//! Sequential pages with different zones are fine: each one sets its zone when
//! it is built ([`claim`]) and again when it is reused ([`reapply`]). Pages that
//! run *concurrently* with different zones cannot all be right — an
//! `Intl.DateTimeFormat()` built in any of them reads whichever zone was set
//! last. The live zones are tracked so that case is logged when it happens
//! rather than discovered on a site; the remedy is one timezone per process.
//!
//! `TZ` is deliberately left alone. With ICU's default set explicitly and host
//! detection skipped, nothing in the engine reads it, while changing it would
//! move the embedding application's local time too, and `setenv` races the
//! C-level `getenv` calls other threads make.

use deno_core::v8;
use std::collections::BTreeMap;
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
}

/// Longer than any IANA id (the longest are ~32 UTF-16 units).
const ZONE_ID_CAPACITY: usize = 64;

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
fn set_icu_default(timezone: &str) -> bool {
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
fn icu_default() -> String {
    let mut buf = [0u16; ZONE_ID_CAPACITY];
    let mut status: i32 = 0;
    // SAFETY: `buf` is a writable buffer of the capacity passed and `status`
    // is a valid out-parameter; ICU writes at most `capacity` units.
    let len =
        unsafe { ucal_getDefaultTimeZone_77(buf.as_mut_ptr(), buf.len() as i32, &mut status) };
    let len = usize::try_from(len).unwrap_or(0).min(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

/// Which zones live runtimes were built for. The lock also serialises changes
/// to ICU's default, so a check-then-set cannot interleave with another one.
struct Registry {
    /// Live runtimes per zone, maintained by [`TimezoneLease`].
    live: BTreeMap<String, usize>,
}

static REGISTRY: Mutex<Registry> = Mutex::new(Registry {
    live: BTreeMap::new(),
});

fn registry() -> MutexGuard<'static, Registry> {
    // Nothing panics while holding the lock; recovering from poison keeps a
    // panic elsewhere from taking every later page's timezone down with it.
    REGISTRY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Held in a runtime's `OpState` for the runtime's lifetime, so the registry
/// knows which zones live pages were built for.
pub(crate) struct TimezoneLease {
    zone: String,
}

impl Drop for TimezoneLease {
    fn drop(&mut self) {
        let mut registry = registry();
        if let Some(count) = registry.live.get_mut(&self.zone) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                registry.live.remove(&self.zone);
            }
        }
    }
}

/// Make `timezone` the process default if it is not already, then flush
/// `isolate`'s date cache so it re-reads it.
///
/// Compared against what ICU actually holds rather than what was last set here,
/// so a default moved from outside this module is not mistaken for ours. The
/// flush happens even when the default did not change: another page may have
/// moved it and back while this isolate cached the other zone.
fn apply_locked(registry: &Registry, isolate: &mut v8::OwnedIsolate, timezone: &str) -> bool {
    if icu_default() != timezone {
        if !set_icu_default(timezone) {
            tracing::warn!(
                timezone,
                "timezone is not a zone ICU knows; the page keeps the process default"
            );
            return false;
        }
        let others: Vec<&str> = registry
            .live
            .keys()
            .map(String::as_str)
            .filter(|zone| *zone != timezone)
            .collect();
        if !others.is_empty() {
            tracing::warn!(
                timezone,
                ?others,
                "ICU's process-wide timezone moved while pages built for other zones are alive; \
                 any of them running concurrently now reads this zone from Intl — use one \
                 timezone per process"
            );
        }
    }
    let _entered = IsolateEnterGuard::enter(isolate);
    isolate.date_time_configuration_change_notification(v8::TimeZoneDetection::Skip);
    true
}

/// Apply `timezone` for a newly built runtime and register the runtime as live.
///
/// Call before any script runs in the isolate, so nothing observes the host zone
/// first. `None` when ICU does not know the zone: the page then reports the
/// process default on every surface — wrong, but at least consistently so.
pub(crate) fn claim(isolate: &mut v8::OwnedIsolate, timezone: &str) -> Option<TimezoneLease> {
    let mut registry = registry();
    if !apply_locked(&registry, isolate, timezone) {
        return None;
    }
    *registry.live.entry(timezone.to_string()).or_default() += 1;
    Some(TimezoneLease {
        zone: timezone.to_string(),
    })
}

/// Re-apply a live runtime's zone before it serves another document.
///
/// The warm-reuse path needs this: the zone was applied when the isolate was
/// built, and any page built since may have moved the process default.
pub(crate) fn reapply(isolate: &mut v8::OwnedIsolate, timezone: &str) -> bool {
    apply_locked(&registry(), isolate, timezone)
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
        let original = icu_default();
        assert!(set_icu_default("Asia/Tokyo"));
        assert!(!set_icu_default("Mars/Olympus_Mons"));
        assert_eq!(icu_default(), "Asia/Tokyo");
        assert!(set_icu_default("Europe/Berlin"));
        assert_eq!(icu_default(), "Europe/Berlin");
        set_icu_default(&original);
    }
}
