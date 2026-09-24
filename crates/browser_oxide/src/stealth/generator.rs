//! Sampling a profile from a Bayesian network of observed fingerprints.
//!
//! `presets` builds identities by hand, so the field *combinations* are
//! plausible by eye rather than drawn from traffic. That is the weakness this
//! module closes: an anti-bot vendor does not ask whether 16 GB of RAM is
//! believable, it asks how often 16 GB appears *together with* this screen, this
//! core count and this GPU. Rare combinations of individually ordinary values
//! are what a hand-written profile gets wrong.
//!
//! `veilus_fingerprint` samples the Apify/BrowserForge network -- the same
//! dataset Camoufox draws on -- so the combinations are ones that occur in the
//! wild. The network is embedded in the crate, so sampling needs no download
//! and no runtime file IO. It is behind the `generator` feature (off by
//! default); without it [`sample`] returns [`GeneratorError::Unavailable`].
//!
//! What is deliberately *not* taken from the network
//! -------------------------------------------------
//! The sampler is statistical; parts of the identity must be exact, and for
//! those a common-but-synthetic value is worse than a fixed real one:
//!
//! * **TLS and HTTP/2 parameters.** The cipher list, curves, extension order
//!   and header order come from `net::tls`'s captured stacks. A handshake no
//!   shipping browser emits is a far stronger signal than a common one, so
//!   "generating" the transport means *selecting a real captured stack*, which
//!   is what [`crate::net::tls::expected_impersonate`] does.
//! * **The browser version.** It follows the stack rather than the network:
//!   the engine carries one captured handshake per browser family, and a
//!   sampled Chrome 12x user agent over the Chrome 153 handshake is exactly the
//!   JA4-versus-UA contradiction the stack selection exists to prevent. The
//!   sampled machine is presented as running the version the handshake is from.
//! * **Timezone and locale.** Not in the network's schema at all, and guessing
//!   them independently of the exit address is precisely the contradiction
//!   [`crate::stealth::egress`] exists to prevent.
//! * **Viewport.** The network emits zeros for `innerWidth`/`innerHeight`, so
//!   the window chain is derived from the sampled screen instead.
//! * **WebGL extension lists and `getParameter` values.** The network carries
//!   only the renderer and vendor strings; the surface JS actually reads comes
//!   from [`crate::stealth::gpu`]'s captured catalog entry for that renderer.
//!
//! Every sample is put through [`StealthProfile::validate`] before it is
//! returned, so a contradiction the repairs below missed fails loudly here
//! rather than on a site.

use crate::stealth::profile::{DeviceClass, StealthProfile};

/// Why a profile could not be sampled.
#[derive(Debug)]
pub enum GeneratorError {
    /// The network could not produce a sample for these constraints.
    Sampling(String),
    /// Samples were drawn but none survived the consistency gates.
    NoCoherentSample {
        /// How many samples were drawn before giving up.
        attempts: usize,
        /// Why the last one was rejected.
        last: Vec<String>,
    },
    /// The crate was built without the `generator` feature.
    Unavailable,
}

impl std::fmt::Display for GeneratorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GeneratorError::Sampling(error) => write!(f, "fingerprint sampling failed: {error}"),
            GeneratorError::NoCoherentSample { attempts, last } => write!(
                f,
                "no coherent fingerprint in {attempts} samples; last rejection: {}",
                last.join("; ")
            ),
            GeneratorError::Unavailable => {
                write!(f, "built without the `generator` feature")
            }
        }
    }
}

impl std::error::Error for GeneratorError {}

/// Which slice of the network to sample from.
#[derive(Debug, Clone, Default)]
pub struct Constraints {
    /// Only "Chrome" (the default) is sampled.
    ///
    /// Firefox is refused rather than attempted: the network carries Gecko's
    /// sanitised renderer strings (`"ANGLE (…), or similar"`), none of which has
    /// a captured GPU catalog entry, so no Firefox sample could ever pass the
    /// gate below. Safari is not sampled either: the desktop Safari stacks pair
    /// with a WebKit surface this engine does not present.
    pub browser: Option<String>,
    /// "Windows", "macOS" or "Linux".
    pub os: Option<String>,
    /// Desktop by default; the mobile classes need their own GPU catalog
    /// entries before they can be sampled coherently.
    pub device_class: DeviceClass,
    /// Makes sampling reproducible, for tests and for pinning one identity to
    /// one proxy session. The canvas and audio seeds derive from it too, so the
    /// same seed gives the same identity in every process.
    pub seed: Option<u64>,
}

/// How many samples to draw before admitting the constraints cannot be met.
///
/// The gates below reject a minority of samples (mostly GPUs with no captured
/// catalog entry), so this is reached only when a constraint combination is
/// genuinely unsatisfiable rather than merely unlucky.
#[cfg(feature = "generator")]
const MAX_ATTEMPTS: usize = 64;

/// Draw a coherent profile from the network.
///
/// Best-effort by design at the call site: an embedder that cannot get a
/// sample should fall back to a preset rather than fail the navigation, since a
/// fixed real identity beats no identity.
#[cfg(feature = "generator")]
pub fn sample(constraints: &Constraints) -> Result<StealthProfile, GeneratorError> {
    use veilus_fingerprint::{BrowserFamily, DeviceType, FingerprintGenerator, OsFamily};

    let mut last_errors = Vec::new();
    for attempt in 0..MAX_ATTEMPTS {
        let mut builder = FingerprintGenerator::new();
        match constraints.browser.as_deref() {
            Some("Chrome") | None => builder = builder.browser(BrowserFamily::Chrome),
            Some(other) => {
                return Err(GeneratorError::Sampling(format!(
                    "unsupported browser constraint '{other}' (only Chrome is sampled)"
                )))
            }
        }
        match constraints.os.as_deref() {
            Some("Windows") => builder = builder.os(OsFamily::Windows),
            Some("macOS") => builder = builder.os(OsFamily::MacOs),
            Some("Linux") => builder = builder.os(OsFamily::Linux),
            Some(other) => {
                return Err(GeneratorError::Sampling(format!(
                    "unsupported os constraint '{other}'"
                )))
            }
            None => {}
        }
        builder = match constraints.device_class {
            DeviceClass::Desktop => builder.device(DeviceType::Desktop),
            DeviceClass::MobileAndroid | DeviceClass::MobileIOS => {
                builder.device(DeviceType::Mobile)
            }
        };
        // Each attempt needs its own draw, so derive a per-attempt seed rather
        // than re-seeding identically and resampling the rejected profile.
        if let Some(seed) = constraints.seed {
            builder = builder.seeded(seed.wrapping_add(attempt as u64));
        }

        let sampled = builder
            .generate()
            .map_err(|error| GeneratorError::Sampling(error.to_string()))?;

        let mut profile = match from_sample(&sampled, constraints) {
            Some(profile) => profile,
            None => {
                last_errors =
                    vec!["sample carried another browser, or no usable GPU or screen".into()];
                continue;
            }
        };
        repair(&mut profile);
        match profile.validate() {
            Ok(()) => return Ok(profile),
            Err(errors) => last_errors = errors,
        }
    }
    Err(GeneratorError::NoCoherentSample {
        attempts: MAX_ATTEMPTS,
        last: last_errors,
    })
}

/// Without the `generator` feature there is no network to sample from.
#[cfg(not(feature = "generator"))]
pub fn sample(_constraints: &Constraints) -> Result<StealthProfile, GeneratorError> {
    Err(GeneratorError::Unavailable)
}

/// Build a profile from one sample, before the repairs.
#[cfg(feature = "generator")]
fn from_sample(
    sampled: &veilus_fingerprint::BrowserProfile,
    constraints: &Constraints,
) -> Option<StealthProfile> {
    use crate::stealth::gpu;

    let navigator = &sampled.fingerprint.navigator;
    let screen = &sampled.fingerprint.screen;
    if screen.width == 0 || screen.height == 0 {
        return None;
    }
    // The browser family filter is a preference, not a guarantee: the network
    // occasionally answers a Chrome request with another browser. It also
    // spells names in lower case, while the engine keys the wire stack and the
    // GL identity on "Chrome" / "Firefox".
    if !sampled.browser.name.eq_ignore_ascii_case("chrome") {
        return None;
    }

    let os_name = os_name_for(&sampled.operating_system.name, &navigator.platform);
    // ARM outside macOS (Linux aarch64, Windows on Snapdragon) has no GPU in the
    // catalog, and rewriting the architecture would leave `aarch64` in the user
    // agent and `navigator.platform` next to an x86 GPU. Discard it instead.
    let arm_claimed = [navigator.platform.as_str(), navigator.user_agent.as_str()]
        .iter()
        .any(|text| text.contains("aarch64") || text.contains("armv") || text.contains("ARM64"));
    if arm_claimed && os_name != "macOS" {
        return None;
    }
    let ua_data = navigator.user_agent_data.as_ref();
    let video_card = sampled.fingerprint.video_card.as_ref();

    // The renderer decides the whole WebGL surface, so a sample whose GPU has
    // no captured catalog entry is discarded rather than shipped under another
    // card's extension list.
    let renderer = video_card.map(|card| card.renderer.clone())?;
    let gpu_profile = gpu::by_unmasked_renderer(&renderer)?;

    let avail_width = nonzero_or(screen.avail_width, screen.width);
    let avail_height = nonzero_or(screen.avail_height, screen.height);
    let avail_top = screen.avail_top.unwrap_or(match os_name.as_str() {
        // The macOS menu bar is always reserved; Windows and Linux report the
        // taskbar through availHeight instead.
        "macOS" => 25,
        _ => 0,
    });
    let (inner_width, inner_height, outer_width, outer_height) =
        window_chain(screen, avail_width, avail_height);

    // Derived from the seed when there is one: a seed stands for one identity,
    // and the canvas / audio noise is as much a part of it as the screen.
    let (canvas_seed, audio_seed) = match constraints.seed {
        Some(seed) => {
            use rand::RngExt;
            let mut rng = crate::stealth::presets::seeded_rng(seed);
            (rng.random(), rng.random())
        }
        None => (rand::random(), rand::random()),
    };

    Some(StealthProfile {
        user_agent: navigator.user_agent.clone(),
        browser_name: "Chrome".into(),
        browser_version: sampled.browser.version.clone(),
        os_name: os_name.clone(),
        os_version: sampled.operating_system.version.clone(),
        platform: navigator.platform.clone(),
        vendor: navigator.vendor.clone(),
        vendor_sub: navigator.vendor_sub.clone().unwrap_or_default(),
        product_sub: navigator.product_sub.clone(),
        app_version: navigator.app_version.clone().unwrap_or_default(),

        screen_width: screen.width,
        screen_height: screen.height,
        screen_avail_width: avail_width,
        screen_avail_height: avail_height,
        screen_avail_top: avail_top,
        screen_color_depth: u32::from(screen.color_depth),
        device_pixel_ratio: f64::from(screen.device_pixel_ratio),
        // The network models core counts above 255 for server-class hardware;
        // clamp to something a consumer machine reports.
        cpu_cores: navigator.hardware_concurrency.clamp(2, 64) as u8,
        device_memory: navigator
            .device_memory
            .map(|memory| memory.clamp(1.0, 64.0) as u8)
            .unwrap_or(8),
        max_touch_points: navigator
            .max_touch_points
            .map(|points| points.min(10) as u8)
            .unwrap_or(0),

        webgl_vendor: video_card
            .map(|card| card.vendor.clone())
            .unwrap_or_else(|| gpu_profile.unmasked_vendor.clone()),
        webgl_renderer: renderer,
        gpu_profile,

        // Locale is not sampled: `egress` resolves it from the exit address,
        // and a sampled locale that disagrees with the address is the exact
        // contradiction this module exists to avoid. English is the honest
        // placeholder until the alignment runs.
        language: "en-US".into(),
        languages: vec!["en-US".into(), "en".into()],
        timezone: "America/New_York".into(),
        latitude: None,
        longitude: None,

        cpu_architecture: ua_data
            .and_then(|data| data.architecture.clone())
            .unwrap_or_else(|| default_architecture(&os_name, &navigator.platform)),
        cpu_bitness: ua_data
            .and_then(|data| data.bitness.clone())
            .unwrap_or_else(|| "64".into()),
        platform_version: ua_data
            .and_then(|data| data.platform_version.clone())
            .unwrap_or_default(),
        ua_model: ua_data
            .and_then(|data| data.model.clone())
            .unwrap_or_default(),
        ua_wow64: false,

        device_class: constraints.device_class,
        // Overwritten by `repair`; the sample has no say in the wire stack.
        tls_impersonate: String::new(),
        connection_effective_type: "4g".into(),
        connection_rtt: 50,
        connection_downlink: 10.0,

        pdf_viewer_enabled: navigator
            .extra_properties
            .as_ref()
            .and_then(|extra| extra.pdf_viewer_enabled)
            .unwrap_or(true),
        plugins_count: 5,
        mime_types_count: 2,

        canvas_seed,
        audio_seed,
        audio_sample_rate: if os_name == "macOS" { 48000 } else { 44100 },

        has_platform_authenticator: matches!(os_name.as_str(), "macOS" | "Windows"),
        conditional_mediation: true,
        // The engine does speak HTTP/3 (`net::quic`), but vanilla quinn-proto
        // shuffles its transport parameters and GREASE per handshake, which no
        // Chrome does; until that stack is Chrome-matched, advertising h3 is a
        // worse fingerprint than not speaking it — the same rule every preset
        // follows (`http3_disabled_by_default_on_all_presets`).
        allow_http3: false,

        prefers_color_scheme: "light".into(),
        pointer_type: "fine".into(),
        hover_capability: "hover".into(),
        color_gamut: if os_name == "macOS" {
            "p3".into()
        } else {
            "srgb".into()
        },

        inner_width,
        inner_height,
        outer_width,
        outer_height,

        proxy: None,
        media_devices: Vec::new(),
        enforce_csp: true,
    })
}

/// Bring a sample in line with the parts of the engine that are not sampled.
///
/// Kept separate from [`from_sample`] so each repair is visible and testable:
/// these are the cross-field contradictions the network's per-field sampling
/// produces, and silently leaving any of them in is what makes a "statistically
/// realistic" profile fail an inconsistency probe.
#[cfg(feature = "generator")]
fn repair(profile: &mut StealthProfile) {
    use crate::stealth::gpu;

    // The stack is selected, never invented, and the browser version follows
    // it: the handshake is a capture of one version, so that is the version
    // the user agent, `appVersion` and the client hints name.
    let stack = crate::net::tls::expected_impersonate(profile);
    if let Some(version) = crate::net::tls::impersonation_version(stack) {
        align_browser_version(profile, version);
    }
    profile.tls_impersonate = stack.to_string();

    // Chrome on Linux reports an empty platformVersion; every other desktop
    // reports a zero-padded triple.
    if profile.os_name == "Linux" {
        profile.platform_version.clear();
    }

    // Apple Silicon only exists on macOS, and an `arm` claim anywhere else is
    // an inconsistency probe's easiest catch.
    if profile.cpu_architecture == "arm"
        && !matches!(profile.os_name.as_str(), "macOS" | "Android" | "ChromeOS")
    {
        profile.cpu_architecture = "x86".into();
    }

    // A desktop profile must not leak a device model.
    if profile.max_touch_points == 0 {
        profile.ua_model.clear();
    }

    // `language` has to appear in `languages`.
    if !profile.languages.contains(&profile.language) {
        profile.languages.insert(0, profile.language.clone());
    }

    // The vendor string follows the renderer: the catalog entry is what JS
    // actually reads, so disagreement here means the two halves of the WebGL
    // surface name different cards.
    if profile.gpu_profile.unmasked_renderer != profile.webgl_renderer {
        if let Some(matching) = gpu::by_unmasked_renderer(&profile.webgl_renderer) {
            profile.gpu_profile = matching;
        }
    }
    profile.webgl_vendor = profile.gpu_profile.unmasked_vendor.clone();
    profile.webgl_renderer = profile.gpu_profile.unmasked_renderer.clone();

    // The window chain has to nest, whatever the sample said.
    profile.screen_avail_width = profile.screen_avail_width.min(profile.screen_width);
    profile.screen_avail_height = profile.screen_avail_height.min(profile.screen_height);
    if profile.screen_avail_top + profile.screen_avail_height > profile.screen_height {
        profile.screen_avail_top = profile.screen_height - profile.screen_avail_height;
    }
    profile.outer_width = profile.outer_width.min(profile.screen_avail_width);
    profile.outer_height = profile.outer_height.min(profile.screen_avail_height);
    profile.inner_width = profile.inner_width.min(profile.outer_width);
    profile.inner_height = profile.inner_height.min(profile.outer_height);
}

/// Present the sampled machine as running `version`, the browser version the
/// profile's wire stack was captured from.
///
/// Chrome's reduced user agent carries only the major (`Chrome/153.0.0.0`),
/// while `browser_version` keeps the full one the client hints report.
#[cfg(feature = "generator")]
fn align_browser_version(profile: &mut StealthProfile, version: &str) {
    let major = version.split('.').next().unwrap_or(version);
    let reduced = format!("{major}.0.0.0");
    profile.user_agent = replace_version_token(&profile.user_agent, "Chrome/", &reduced);
    profile.app_version = replace_version_token(&profile.app_version, "Chrome/", &reduced);
    profile.browser_version = version.to_string();
}

/// Replace the version after the first `prefix` in `text` — up to the next
/// space, `)` or `;` — with `value`. `text` is returned unchanged when it has
/// no `prefix`.
#[cfg(feature = "generator")]
fn replace_version_token(text: &str, prefix: &str, value: &str) -> String {
    let Some(start) = text.find(prefix).map(|at| at + prefix.len()) else {
        return text.to_string();
    };
    let end = text[start..]
        .find([' ', ')', ';'])
        .map_or(text.len(), |offset| start + offset);
    format!("{}{value}{}", &text[..start], &text[end..])
}

/// Derive the window chain from the sampled screen.
///
/// The network reports zero for every viewport field, so taking it at face
/// value would ship `innerWidth === 0` -- readable from script and true of no
/// real browser. A maximised window inside the available area, minus the
/// chrome the platform actually draws, is the closest honest reconstruction.
#[cfg(feature = "generator")]
fn window_chain(
    screen: &veilus_fingerprint::ScreenFingerprint,
    avail_width: u32,
    avail_height: u32,
) -> (u32, u32, u32, u32) {
    // Tab strip plus omnibox, as Chrome draws them at 1x. The same on every
    // desktop platform it ships on, which is why this is one number.
    let chrome_height = 111;
    let outer_width = nonzero_or(screen.outer_width.unwrap_or(0), avail_width);
    let outer_height = nonzero_or(screen.outer_height.unwrap_or(0), avail_height);
    let inner_width = nonzero_or(screen.inner_width, outer_width);
    let inner_height = nonzero_or(
        screen.inner_height,
        outer_height.saturating_sub(chrome_height).max(1),
    );
    (inner_width, inner_height, outer_width, outer_height)
}

#[cfg(feature = "generator")]
fn nonzero_or(value: u32, fallback: u32) -> u32 {
    if value == 0 {
        fallback
    } else {
        value
    }
}

/// The OS name this crate uses, from what the sample called it.
#[cfg(feature = "generator")]
fn os_name_for(sampled: &str, platform: &str) -> String {
    let lower = sampled.to_ascii_lowercase();
    if lower.contains("mac") || platform == "MacIntel" {
        "macOS".into()
    } else if lower.contains("linux") || platform.starts_with("Linux") {
        "Linux".into()
    } else if lower.contains("android") {
        "Android".into()
    } else {
        "Windows".into()
    }
}

#[cfg(feature = "generator")]
fn default_architecture(os_name: &str, platform: &str) -> String {
    if os_name == "macOS" && platform == "MacIntel" {
        // Every shipping Mac is Apple Silicon now, and `navigator.platform`
        // still says MacIntel on all of them, so it cannot decide this.
        "arm".into()
    } else {
        "x86".into()
    }
}

#[cfg(all(test, not(feature = "generator")))]
mod unavailable_tests {
    use super::*;

    /// Without the feature, sampling reports why instead of panicking, so a
    /// caller can fall back to a preset.
    #[test]
    fn sampling_without_the_feature_says_so() {
        assert!(matches!(
            sample(&Constraints::default()),
            Err(GeneratorError::Unavailable)
        ));
    }
}

#[cfg(all(test, feature = "generator"))]
mod tests {
    use super::*;

    #[test]
    fn a_sampled_profile_validates() {
        let profile = sample(&Constraints {
            seed: Some(1),
            ..Constraints::default()
        })
        .expect("a coherent sample");
        profile.validate().expect("internally consistent");
    }

    /// The whole point: the declared wire identity is the one the transport
    /// emits, not something the network made up.
    #[test]
    fn sampled_profile_declares_the_stack_it_emits() {
        let profile = sample(&Constraints {
            seed: Some(7),
            ..Constraints::default()
        })
        .expect("a coherent sample");
        assert_eq!(
            profile.tls_impersonate,
            crate::net::tls::expected_impersonate(&profile)
        );
    }

    /// The user agent names the version the handshake is a capture of,
    /// whatever version the network sampled.
    #[test]
    fn the_user_agent_names_the_version_the_handshake_is_from() {
        for seed in 0..6 {
            let profile = sample(&Constraints {
                seed: Some(seed),
                ..Constraints::default()
            })
            .expect("a coherent sample");
            assert_eq!(profile.browser_name, "Chrome", "seed {seed}");
            let version = crate::net::tls::impersonation_version(&profile.tls_impersonate)
                .expect("a known stack");
            let major = version.split('.').next().expect("major");
            assert_eq!(profile.browser_version, version, "seed {seed}");
            for (field, text) in [
                ("UA", &profile.user_agent),
                ("appVersion", &profile.app_version),
            ] {
                assert!(
                    text.contains(&format!("Chrome/{major}.0.0.0")),
                    "seed {seed}: {field} {text}"
                );
            }
        }
    }

    /// No Firefox sample can pass the GPU gate, so the constraint is refused
    /// up front rather than after a futile round of attempts.
    #[test]
    fn firefox_is_refused_with_a_reason() {
        let error = sample(&Constraints {
            browser: Some("Firefox".into()),
            seed: Some(1),
            ..Constraints::default()
        })
        .expect_err("Firefox is not sampled");
        assert!(matches!(error, GeneratorError::Sampling(_)), "{error}");
    }

    #[test]
    fn the_same_seed_gives_the_same_identity() {
        let constraints = Constraints {
            seed: Some(42),
            ..Constraints::default()
        };
        let first = sample(&constraints).expect("sample");
        let second = sample(&constraints).expect("sample");
        assert_eq!(first.user_agent, second.user_agent);
        assert_eq!(first.screen_width, second.screen_width);
        assert_eq!(first.webgl_renderer, second.webgl_renderer);
        // The noise seeds are part of the identity too.
        assert_eq!(first.canvas_seed, second.canvas_seed);
        assert_eq!(first.audio_seed, second.audio_seed);
    }

    #[test]
    fn os_constraint_is_honoured() {
        let profile = sample(&Constraints {
            os: Some("macOS".into()),
            seed: Some(3),
            ..Constraints::default()
        })
        .expect("sample");
        assert_eq!(profile.os_name, "macOS");
        assert_eq!(profile.platform, "MacIntel");
    }

    /// The viewport the network emits is zero; shipping that would be readable
    /// from script and true of no real browser.
    #[test]
    fn the_window_chain_is_derived_not_zero() {
        let profile = sample(&Constraints {
            seed: Some(11),
            ..Constraints::default()
        })
        .expect("sample");
        assert!(profile.inner_width > 0 && profile.inner_height > 0);
        assert!(profile.inner_width <= profile.outer_width);
        assert!(profile.outer_width <= profile.screen_avail_width);
        assert!(profile.screen_avail_width <= profile.screen_width);
    }

    /// The WebGL surface JS reads comes from the catalog, so both halves must
    /// name the same card.
    #[test]
    fn webgl_vendor_and_renderer_name_one_card() {
        for seed in 0..8 {
            let profile = sample(&Constraints {
                seed: Some(seed),
                ..Constraints::default()
            })
            .expect("sample");
            assert_eq!(
                profile.gpu_profile.unmasked_renderer,
                profile.webgl_renderer
            );
            assert_eq!(profile.gpu_profile.unmasked_vendor, profile.webgl_vendor);
            assert!(!profile.gpu_profile.extensions.is_empty());
        }
    }

    /// Locale stays neutral until the egress lookup sets it: a sampled locale
    /// that contradicts the exit address is worse than none.
    #[test]
    fn locale_is_left_for_the_egress_alignment() {
        let profile = sample(&Constraints {
            seed: Some(5),
            ..Constraints::default()
        })
        .expect("sample");
        assert_eq!(profile.language, "en-US");
        assert!(profile.latitude.is_none());
    }

    /// An ARM machine outside macOS has no catalog GPU; such samples are
    /// discarded, not given an x86 GPU under an `aarch64` user agent.
    #[test]
    fn no_arm_user_agent_outside_macos() {
        for seed in 0..24 {
            let profile = sample(&Constraints {
                seed: Some(seed * 1000),
                ..Constraints::default()
            })
            .expect("sample");
            if profile.os_name != "macOS" {
                for text in [&profile.user_agent, &profile.platform] {
                    assert!(
                        !text.contains("aarch64") && !text.contains("arm"),
                        "seed {seed}: {text}"
                    );
                }
            }
        }
    }

    /// Generated profiles follow the same h3 rule as every preset.
    #[test]
    fn sampled_profiles_do_not_advertise_http3() {
        for seed in 0..4 {
            let profile = sample(&Constraints {
                seed: Some(seed),
                ..Constraints::default()
            })
            .expect("sample");
            assert!(!profile.allow_http3, "seed {seed}");
        }
    }

    #[test]
    fn version_tokens_are_replaced_in_place() {
        assert_eq!(
            replace_version_token(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
                "Chrome/",
                "153.0.0.0",
            ),
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
        );
        assert_eq!(
            replace_version_token("5.0 (Windows)", "Chrome/", "153.0.0.0"),
            "5.0 (Windows)"
        );
    }
}
