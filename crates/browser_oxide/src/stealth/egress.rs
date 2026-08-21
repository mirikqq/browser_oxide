//! Aligning the fingerprint with the connection it goes out on.
//!
//! A profile is only coherent relative to the address it is presented from. An
//! exit IP in Stockholm paired with `Europe/Paris` and `fr-FR` is not a subtle
//! inconsistency — geolocation of the peer is the cheapest signal a risk engine
//! has, and it is checked against the timezone and `Accept-Language` on nearly
//! every request. Randomising the locale independently of the egress therefore
//! makes a profile *worse* than leaving it fixed.
//!
//! So the locale is not sampled: it is resolved from wherever the traffic
//! actually leaves, through the very client that will carry the page load —
//! proxy included, since that is the address the site sees.

use crate::net::HttpClient;
use crate::stealth::profile::StealthProfile;

/// Country → (language tag, `navigator.languages`, IANA timezone).
///
/// One entry per country we can speak for: the primary language as the site
/// would expect it, English kept as a secondary where it is genuinely common,
/// and the timezone of the country's main population centre.
const COUNTRY_LOCALES: &[(&str, &str, &[&str], &str)] = &[
    ("US", "en-US", &["en-US", "en"], "America/New_York"),
    ("CA", "en-CA", &["en-CA", "en", "fr-CA"], "America/Toronto"),
    ("GB", "en-GB", &["en-GB", "en"], "Europe/London"),
    ("IE", "en-IE", &["en-IE", "en"], "Europe/Dublin"),
    (
        "DE",
        "de-DE",
        &["de-DE", "de", "en-US", "en"],
        "Europe/Berlin",
    ),
    ("AT", "de-AT", &["de-AT", "de", "en"], "Europe/Vienna"),
    (
        "CH",
        "de-CH",
        &["de-CH", "de", "fr-CH", "en"],
        "Europe/Zurich",
    ),
    (
        "FR",
        "fr-FR",
        &["fr-FR", "fr", "en-US", "en"],
        "Europe/Paris",
    ),
    ("ES", "es-ES", &["es-ES", "es", "en"], "Europe/Madrid"),
    ("IT", "it-IT", &["it-IT", "it", "en"], "Europe/Rome"),
    ("PT", "pt-PT", &["pt-PT", "pt", "en"], "Europe/Lisbon"),
    (
        "NL",
        "nl-NL",
        &["nl-NL", "nl", "en-US", "en"],
        "Europe/Amsterdam",
    ),
    (
        "BE",
        "nl-BE",
        &["nl-BE", "nl", "fr-BE", "en"],
        "Europe/Brussels",
    ),
    (
        "SE",
        "sv-SE",
        &["sv-SE", "sv", "en-US", "en"],
        "Europe/Stockholm",
    ),
    (
        "NO",
        "nb-NO",
        &["nb-NO", "no", "en-US", "en"],
        "Europe/Oslo",
    ),
    (
        "DK",
        "da-DK",
        &["da-DK", "da", "en-US", "en"],
        "Europe/Copenhagen",
    ),
    (
        "FI",
        "fi-FI",
        &["fi-FI", "fi", "en-US", "en"],
        "Europe/Helsinki",
    ),
    (
        "PL",
        "pl-PL",
        &["pl-PL", "pl", "en-US", "en"],
        "Europe/Warsaw",
    ),
    ("CZ", "cs-CZ", &["cs-CZ", "cs", "en"], "Europe/Prague"),
    ("RO", "ro-RO", &["ro-RO", "ro", "en"], "Europe/Bucharest"),
    ("UA", "uk-UA", &["uk-UA", "uk", "ru", "en"], "Europe/Kyiv"),
    (
        "RU",
        "ru-RU",
        &["ru-RU", "ru", "en-US", "en"],
        "Europe/Moscow",
    ),
    (
        "TR",
        "tr-TR",
        &["tr-TR", "tr", "en-US", "en"],
        "Europe/Istanbul",
    ),
    (
        "BR",
        "pt-BR",
        &["pt-BR", "pt", "en-US", "en"],
        "America/Sao_Paulo",
    ),
    ("MX", "es-MX", &["es-MX", "es", "en"], "America/Mexico_City"),
    (
        "AR",
        "es-AR",
        &["es-AR", "es", "en"],
        "America/Argentina/Buenos_Aires",
    ),
    ("IN", "en-IN", &["en-IN", "en", "hi"], "Asia/Kolkata"),
    ("JP", "ja-JP", &["ja-JP", "ja", "en-US", "en"], "Asia/Tokyo"),
    ("KR", "ko-KR", &["ko-KR", "ko", "en-US", "en"], "Asia/Seoul"),
    ("SG", "en-SG", &["en-SG", "en", "zh-CN"], "Asia/Singapore"),
    ("AU", "en-AU", &["en-AU", "en"], "Australia/Sydney"),
    ("NZ", "en-NZ", &["en-NZ", "en"], "Pacific/Auckland"),
    ("ZA", "en-ZA", &["en-ZA", "en"], "Africa/Johannesburg"),
    ("AE", "en-AE", &["en-AE", "en", "ar"], "Asia/Dubai"),
    (
        "IL",
        "he-IL",
        &["he-IL", "he", "en-US", "en"],
        "Asia/Jerusalem",
    ),
    ("HK", "zh-HK", &["zh-HK", "zh", "en"], "Asia/Hong_Kong"),
];

/// Point a profile's locale at a country, leaving everything else alone.
///
/// Returns `false` for a country we have no entry for — better to keep the
/// sampled locale than to invent a mapping, since a wrong-but-confident pairing
/// is exactly the inconsistency this exists to avoid.
pub fn apply_country(profile: &mut StealthProfile, country: &str) -> bool {
    let cc = country.trim().to_ascii_uppercase();
    let Some((_, lang, langs, tz)) = COUNTRY_LOCALES.iter().find(|(c, ..)| *c == cc) else {
        return false;
    };
    // Timezone follows the exit address — that pairing *is* checked. The
    // language does not: English reads as ordinary from anywhere, and a
    // localised captcha is unreadable to whoever is driving. Set
    // `BROWSER_OXIDE_MATCH_LANG=1` to take the country's language too.
    profile.timezone = (*tz).to_string();
    if std::env::var_os("BROWSER_OXIDE_MATCH_LANG").is_some() {
        profile.language = (*lang).to_string();
        profile.languages = langs.iter().map(|s| (*s).to_string()).collect();
    } else {
        profile.language = "en-US".to_string();
        profile.languages = vec!["en-US".to_string(), "en".to_string()];
    }
    true
}

/// Countries this module can align a profile to.
pub fn known_countries() -> impl Iterator<Item = &'static str> {
    COUNTRY_LOCALES.iter().map(|(c, ..)| *c)
}

/// The two-letter country of the address this profile's traffic leaves from.
///
/// Goes through a client built from `profile`, so it follows the same proxy the
/// page load will: the answer has to describe the address the *site* sees, not
/// the machine running the engine.
///
/// `None` on any failure — no network, a lookup that is blocked, an
/// unrecognised body. The caller keeps its sampled locale in that case, which
/// is the honest fallback: a guess here would reintroduce the very mismatch the
/// lookup exists to prevent.
pub async fn detect_country(profile: &StealthProfile) -> Option<String> {
    let client = HttpClient::shared(profile).ok()?;
    // Two independent providers: one being down or blocked must not silently
    // leave every profile mis-localised.
    for url in [
        "https://ipinfo.io/json",
        "https://ipapi.co/json/",
        "https://api.country.is/",
    ] {
        let Ok(resp) =
            tokio::time::timeout(std::time::Duration::from_secs(6), client.get_follow(url, 3))
                .await
        else {
            continue;
        };
        let Ok(resp) = resp else { continue };
        if !resp.ok() {
            continue;
        }
        if let Some(cc) = parse_country(&resp.text()) {
            return Some(cc);
        }
    }
    None
}

/// Pull a two-letter country out of a JSON body without a JSON dependency.
///
/// The three providers spell the field differently (`country`,
/// `country_code`), so both keys are accepted; the value is only taken when it
/// is exactly two ASCII letters, which rejects a full country name arriving
/// under the same key.
fn parse_country(body: &str) -> Option<String> {
    for key in ["\"country_code\"", "\"country\""] {
        let mut from = 0usize;
        while let Some(hit) = body[from..].find(key) {
            let after = from + hit + key.len();
            let tail = body[after..].trim_start();
            if let Some(rest) = tail.strip_prefix(':') {
                let rest = rest.trim_start();
                if let Some(rest) = rest.strip_prefix('"') {
                    let value: String = rest.chars().take_while(|c| *c != '"').collect();
                    if value.len() == 2 && value.chars().all(|c| c.is_ascii_alphabetic()) {
                        return Some(value.to_ascii_uppercase());
                    }
                }
            }
            from = after;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn country_is_read_from_either_field_name() {
        assert_eq!(
            parse_country(r#"{"ip":"1.2.3.4","country":"SE","city":"Stockholm"}"#).as_deref(),
            Some("SE")
        );
        assert_eq!(
            parse_country(r#"{"country_code":"fr","country_name":"France"}"#).as_deref(),
            Some("FR")
        );
        // A full name under `country` must not be mistaken for a code.
        assert_eq!(parse_country(r#"{"country":"Sweden"}"#), None);
        assert_eq!(parse_country("не json"), None);
    }

    #[test]
    fn country_sets_the_timezone_and_leaves_the_language_english() {
        let mut p = crate::stealth::presets::chrome_148_macos();
        assert!(apply_country(&mut p, "se"));
        // The timezone follows the exit address — that pairing is checked.
        assert_eq!(p.timezone, "Europe/Stockholm");
        // The language does not: a localised UI is unreadable to whoever drives
        // the browser, and English is ordinary from any address.
        assert_eq!(p.language, "en-US");
        assert!(p.languages.iter().any(|l| l == "en-US"));
        // Unknown country leaves the profile untouched.
        let before = p.timezone.clone();
        assert!(!apply_country(&mut p, "XX"));
        assert_eq!(p.timezone, before);
    }
}
