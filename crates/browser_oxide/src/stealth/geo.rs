//! Resolving the exit address to a position, offline, from a GeoLite2 database.
//!
//! This is the approach Camoufox takes: rather than asking a public endpoint
//! what the IP looks like on every run, keep a MaxMind GeoLite2-City database
//! on disk and read it locally. That matters for three reasons. The lookup adds
//! no request to a third party that can see every address the engine uses; it
//! costs microseconds instead of a round trip on the page-load path; and it
//! keeps working when the provider is down, rate-limiting, or blocked in the
//! region the proxy exits from -- exactly the conditions under which a scraping
//! run is most likely to be using a proxy in the first place.
//!
//! What comes back is the city-level record: coordinates, MaxMind's own
//! accuracy radius, the IANA timezone for that address, and the country. Those
//! feed [`crate::stealth::egress::apply_egress`], so the clock, the geolocation
//! surface and the address a site resolves all describe the same place.
//!
//! The exit address itself still has to be learned — through a proxy it is not
//! the host's — so the database replaces the *geolocation* provider, not the
//! request: one plain IP echo instead of a provider that answers with (and
//! rate-limits on) the full record.
//!
//! This module opens no socket. [`mmdb_path`] says where the database belongs
//! and [`needs_refresh`] says when it has aged out; `egress` fetches it through
//! the profile's own client and calls [`install`] — but only from a source the
//! operator named, see [`mmdb_url`]. Reading it needs the `geoip` feature; without
//! it [`lookup`] always misses and the HTTP providers answer as before.

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::stealth::egress::Egress;

/// How long a cached database is trusted before a refresh is due.
///
/// MaxMind republishes GeoLite2-City twice a week. Thirty days is the same
/// window Camoufox uses: long enough that the refresh is rare, short enough
/// that a reassigned range does not keep resolving to the wrong continent.
const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// The file name the database is cached under.
const MMDB_FILE: &str = "GeoLite2-City.mmdb";

/// Where the GeoLite2 database lives.
///
/// `BROWSER_OXIDE_GEOIP_MMDB` points at a database directly, for hosts that
/// already ship one (a MaxMind subscription, a distro package, a container
/// layer) rather than letting the engine keep its own copy. Otherwise it sits
/// in the per-user cache directory, so several processes share one download.
pub fn mmdb_path() -> PathBuf {
    if let Some(explicit) = std::env::var_os("BROWSER_OXIDE_GEOIP_MMDB") {
        return PathBuf::from(explicit);
    }
    cache_dir().join(MMDB_FILE)
}

/// The per-user cache directory the engine keeps its GeoIP data in.
fn cache_dir() -> PathBuf {
    let base = std::env::var_os("BROWSER_OXIDE_CACHE_DIR")
        .map(PathBuf::from)
        // Windows gives every user a roaming-free local cache; XDG names it on
        // Linux; macOS has no XDG_CACHE_HOME by default, so fall back to HOME.
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))
        .or_else(|| std::env::var_os("XDG_CACHE_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("browser_oxide").join("geoip")
}

/// Whether the cached database is missing or old enough to be worth replacing.
///
/// A database that exists but cannot be stat'ed counts as fresh: a refresh that
/// fails leaves the old file in place, and re-downloading on every run because
/// the mtime is unreadable would be worse than a slightly stale answer.
pub fn needs_refresh(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return true;
    };
    if metadata.len() == 0 {
        return true;
    }
    metadata
        .modified()
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > MAX_AGE)
}

/// Write a freshly downloaded database into the cache.
///
/// Writes to a temporary file in the same directory and renames it into place,
/// so a lookup running concurrently in another process never sees a partially
/// written database -- it reads either the old copy or the new one.
pub fn install(bytes: &[u8]) -> std::io::Result<PathBuf> {
    let path = mmdb_path();
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let staging = parent.join(format!("{MMDB_FILE}.{}.part", std::process::id()));
    std::fs::write(&staging, bytes)?;
    match std::fs::rename(&staging, &path) {
        Ok(()) => Ok(path),
        Err(error) => {
            let _ = std::fs::remove_file(&staging);
            Err(error)
        }
    }
}

/// Where to fetch the database from, if the operator named a source.
///
/// Deliberately has no default. MaxMind requires a licence key for its own
/// endpoint, and the alternative would be to pull a binary database from a
/// third-party redistribution on the engine's own initiative -- a supply-chain
/// decision that belongs to whoever runs it, not to a default. With no URL set
/// the engine uses a database already on disk if there is one and otherwise
/// falls back to the HTTP providers, so the feature degrades rather than
/// reaching for an unvetted source.
///
/// Set `BROWSER_OXIDE_GEOIP_URL` to a MaxMind permalink (licence key
/// included), an internal mirror, or a redistribution you trust. Set
/// `BROWSER_OXIDE_GEOIP_MMDB` to use a database the host already provides.
pub fn mmdb_url() -> Option<String> {
    std::env::var("BROWSER_OXIDE_GEOIP_URL")
        .ok()
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty())
}

/// Whether the GeoIP path is switched off.
///
/// Off when built without the `geoip` feature, or when a run that must not
/// touch the filesystem cache or download anything sets
/// `BROWSER_OXIDE_NO_GEOIP=1`. Either way the HTTP providers answer.
pub fn disabled() -> bool {
    !cfg!(feature = "geoip") || std::env::var_os("BROWSER_OXIDE_NO_GEOIP").is_some()
}

/// Look `address` up in the local GeoLite2 database.
///
/// `None` when the database is absent, unreadable, or has no record for the
/// address -- all ordinary conditions, not errors. The caller falls back to an
/// HTTP provider, and failing that keeps the profile it already had, because a
/// confident wrong position contradicts the clock and is worse than none.
#[cfg(feature = "geoip")]
pub fn lookup(address: IpAddr) -> Option<Egress> {
    let path = mmdb_path();
    let reader = match maxminddb::Reader::open_readfile(&path) {
        Ok(reader) => reader,
        Err(error) => {
            tracing::debug!(path = %path.display(), %error, "GeoLite2 database unavailable");
            return None;
        }
    };
    let record: maxminddb::geoip2::City = match reader.lookup(address) {
        Ok(Some(record)) => record,
        Ok(None) => return None,
        Err(error) => {
            tracing::debug!(%address, %error, "GeoLite2 lookup failed");
            return None;
        }
    };
    egress_from_city(&record)
}

/// Without the `geoip` feature there is no reader: every lookup misses.
#[cfg(not(feature = "geoip"))]
pub fn lookup(_address: IpAddr) -> Option<Egress> {
    None
}

/// Read the fields we align a profile on out of a GeoLite2 City record.
///
/// Split out so the mapping is testable without a database on disk: it is the
/// part that can silently go wrong when MaxMind's schema shifts.
#[cfg(feature = "geoip")]
fn egress_from_city(record: &maxminddb::geoip2::City<'_>) -> Option<Egress> {
    let english = |names: &Option<std::collections::BTreeMap<&str, &str>>| -> Option<String> {
        names.as_ref()?.get("en").map(|name| (*name).to_string())
    };

    // Without a country there is nothing to align to, which is the same bar
    // the HTTP providers are held to in `egress::parse_egress`.
    let country = record
        .country
        .as_ref()
        .and_then(|country| country.iso_code)
        .map(|code| code.to_ascii_uppercase())?;

    let location = record.location.as_ref();
    Some(Egress {
        country,
        city: record.city.as_ref().and_then(|city| english(&city.names)),
        region: record
            .subdivisions
            .as_ref()
            .and_then(|subdivisions| subdivisions.first())
            .and_then(|subdivision| english(&subdivision.names)),
        timezone: location
            .and_then(|location| location.time_zone)
            .map(str::to_string),
        latitude: location.and_then(|location| location.latitude),
        longitude: location.and_then(|location| location.longitude),
    })
}

/// MaxMind's accuracy radius for an address, in metres.
///
/// The geolocation surface reports an accuracy alongside the coordinates, and a
/// browser on a real machine without GPS reports a coarse one. Quoting metres
/// of precision for a position derived from an IP range would be the tell.
pub fn accuracy_metres(accuracy_radius_km: Option<u16>) -> f64 {
    // GeoLite2 leaves the radius out for some ranges; 50km is MaxMind's own
    // typical city-level figure and keeps the claim conservative.
    f64::from(accuracy_radius_km.unwrap_or(50)) * 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_database_path_wins() {
        // Safe only because the suite runs single-threaded (`--test-threads=1`,
        // the V8 constraint): nothing else reads the variable meanwhile.
        std::env::set_var("BROWSER_OXIDE_GEOIP_MMDB", "/somewhere/else/City.mmdb");
        assert_eq!(mmdb_path(), PathBuf::from("/somewhere/else/City.mmdb"));
        std::env::remove_var("BROWSER_OXIDE_GEOIP_MMDB");
    }

    #[test]
    fn the_cache_lives_under_the_engine_name() {
        std::env::set_var("BROWSER_OXIDE_CACHE_DIR", "/var/cache/x");
        assert_eq!(
            mmdb_path(),
            PathBuf::from("/var/cache/x/browser_oxide/geoip/GeoLite2-City.mmdb")
        );
        std::env::remove_var("BROWSER_OXIDE_CACHE_DIR");
    }

    /// The download source is the operator's choice; nothing is fetched from a
    /// default.
    #[test]
    fn there_is_no_default_download_source() {
        std::env::remove_var("BROWSER_OXIDE_GEOIP_URL");
        assert_eq!(mmdb_url(), None);
        std::env::set_var("BROWSER_OXIDE_GEOIP_URL", "   ");
        assert_eq!(mmdb_url(), None);
        std::env::set_var(
            "BROWSER_OXIDE_GEOIP_URL",
            " https://mirror.internal/City.mmdb ",
        );
        assert_eq!(
            mmdb_url().as_deref(),
            Some("https://mirror.internal/City.mmdb")
        );
        std::env::remove_var("BROWSER_OXIDE_GEOIP_URL");
    }

    #[test]
    fn missing_database_needs_a_refresh() {
        assert!(needs_refresh(Path::new("/no/such/GeoLite2-City.mmdb")));
    }

    #[test]
    fn a_zero_length_database_is_not_trusted() {
        let dir = std::env::temp_dir().join("browser-oxide-geo-test-empty");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("empty.mmdb");
        std::fs::write(&path, b"").expect("write");
        assert!(
            needs_refresh(&path),
            "a truncated download must not be treated as a usable database"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_fresh_database_is_left_alone() {
        let dir = std::env::temp_dir().join("browser-oxide-geo-test-fresh");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("fresh.mmdb");
        std::fs::write(&path, b"not really a database, but recent").expect("write");
        assert!(!needs_refresh(&path));
        let _ = std::fs::remove_file(&path);
    }

    /// A lookup running in another process must see the old database or the
    /// new one, never a partial write, and nothing may be left behind.
    #[test]
    fn install_replaces_the_database_in_one_step() {
        let dir = std::env::temp_dir().join("browser-oxide-geo-test-install");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("City.mmdb");
        std::env::set_var("BROWSER_OXIDE_GEOIP_MMDB", &path);
        std::fs::write(&path, b"old").expect("write");
        assert_eq!(install(b"new database").expect("install"), path);
        assert_eq!(std::fs::read(&path).expect("read"), b"new database");
        let leftovers = std::fs::read_dir(&dir)
            .expect("list")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".part"))
            .count();
        assert_eq!(leftovers, 0, "the staging file must be renamed away");
        std::env::remove_var("BROWSER_OXIDE_GEOIP_MMDB");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_radius_falls_back_to_a_coarse_claim() {
        assert_eq!(accuracy_metres(None), 50_000.0);
        assert_eq!(accuracy_metres(Some(5)), 5_000.0);
    }

    /// The mapping from a GeoLite2 City record, which is the part that can go
    /// quietly wrong when MaxMind's schema shifts. Built from JSON, since the
    /// record type is only ever produced by a reader otherwise.
    #[cfg(feature = "geoip")]
    #[test]
    fn a_city_record_maps_onto_the_egress() {
        let json = r#"{
            "city": {"names": {"en": "Stockholm", "sv": "Stockholm"}},
            "country": {"iso_code": "se"},
            "location": {"latitude": 59.33, "longitude": 18.06, "time_zone": "Europe/Stockholm"},
            "subdivisions": [{"names": {"en": "Stockholm County"}}]
        }"#;
        let record: maxminddb::geoip2::City<'_> = serde_json::from_str(json).expect("record");
        let egress = egress_from_city(&record).expect("a country is present");
        assert_eq!(egress.country, "SE");
        assert_eq!(egress.city.as_deref(), Some("Stockholm"));
        assert_eq!(egress.region.as_deref(), Some("Stockholm County"));
        assert_eq!(egress.timezone.as_deref(), Some("Europe/Stockholm"));
        assert_eq!(egress.latitude, Some(59.33));
        assert_eq!(egress.longitude, Some(18.06));
    }

    /// Without a country there is nothing to align to — the same bar the HTTP
    /// providers are held to.
    #[cfg(feature = "geoip")]
    #[test]
    fn a_record_without_a_country_is_no_answer() {
        let json = r#"{"location": {"time_zone": "Europe/Stockholm"}}"#;
        let record: maxminddb::geoip2::City<'_> = serde_json::from_str(json).expect("record");
        assert!(egress_from_city(&record).is_none());
    }

    #[test]
    fn lookup_without_a_database_is_a_miss_not_a_panic() {
        std::env::set_var("BROWSER_OXIDE_GEOIP_MMDB", "/no/such/GeoLite2-City.mmdb");
        assert!(lookup("8.8.8.8".parse::<IpAddr>().expect("literal")).is_none());
        std::env::remove_var("BROWSER_OXIDE_GEOIP_MMDB");
    }
}
