//! YAML/JSON configuration loader for `StealthProfile`.
//!
//! Profiles are normally produced by the `presets::*` constructors, which
//! are the authoritative source for the values we ship. This module lets a
//! caller load a profile from a YAML or JSON file at runtime — useful for
//! integrators that want to ship the engine binary and a separate
//! `profile.yaml` describing the desired browser identity (UA, screen,
//! locale, GPU, etc.) without rebuilding.
//!
//! ```no_run
//! use browser_oxide::stealth::StealthProfile;
//!
//! let profile = StealthProfile::load_from_file("profiles/chrome_148_macos.yaml")
//!     .expect("profile loads");
//! profile.validate().expect("internally consistent");
//! ```

use crate::stealth::profile::StealthProfile;
use std::fs;
use std::path::Path;

/// Errors returned by the config loader.
#[derive(Debug)]
pub enum ConfigError {
    Io(std::io::Error),
    Yaml(serde_yaml_ng::Error),
    Json(serde_json::Error),
    UnknownFormat(String),
    Invalid(Vec<String>),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::Io(e) => write!(f, "io error: {e}"),
            ConfigError::Yaml(e) => write!(f, "yaml parse error: {e}"),
            ConfigError::Json(e) => write!(f, "json parse error: {e}"),
            ConfigError::UnknownFormat(ext) => {
                write!(
                    f,
                    "unknown config format '{ext}' (expected .yaml/.yml/.json)"
                )
            }
            ConfigError::Invalid(errs) => {
                write!(f, "profile failed validation: {}", errs.join("; "))
            }
        }
    }
}

impl std::error::Error for ConfigError {}

/// Config file format. Selected by file extension when reading from disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigFormat {
    Yaml,
    Json,
}

impl ConfigFormat {
    /// Pick a format from a path extension. `.yaml`/`.yml` → Yaml,
    /// `.json` → Json. Anything else returns `UnknownFormat`.
    pub fn from_path(path: &Path) -> Result<Self, ConfigError> {
        match path.extension().and_then(|s| s.to_str()) {
            Some("yaml") | Some("yml") => Ok(ConfigFormat::Yaml),
            Some("json") => Ok(ConfigFormat::Json),
            other => Err(ConfigError::UnknownFormat(other.unwrap_or("").into())),
        }
    }
}

impl StealthProfile {
    /// Point `gpu_profile` at the catalog entry this profile's
    /// `webgl_renderer` names, when the two disagree and the catalog has a
    /// match.
    ///
    /// `gpu_profile` — not `webgl_renderer` — is what reaches JS:
    /// `canvas_bootstrap.js` reads `webgl_unmasked_vendor` /
    /// `webgl_unmasked_renderer`, both sourced from `gpu_profile`. A
    /// hand-written profile that names its GPU in `webgl_renderer` and
    /// leaves `gpu_profile` to its serde default therefore shipped
    /// `nvidia_rtx_3060_windows()`'s extension list, getParameter values
    /// and shader precision — NVIDIA-on-Windows WebGL under, say, a macOS
    /// user agent. The bundled `profiles/chrome_148_macos.yaml` had
    /// exactly that shape.
    ///
    /// Leaves `gpu_profile` untouched when the renderer is not a catalog
    /// entry, so Firefox profiles (`webgl_renderer: "Mozilla"` — the real
    /// base RENDERER string, deliberately different from the unmasked one)
    /// and GPUs with no capture yet keep whatever they were given.
    fn resolve_gpu_profile(&mut self) {
        if self.webgl_renderer.is_empty()
            || self.gpu_profile.unmasked_renderer == self.webgl_renderer
        {
            return;
        }
        if let Some(gpu) = crate::stealth::gpu::by_unmasked_renderer(&self.webgl_renderer) {
            self.gpu_profile = gpu;
        }
    }

    /// Parse a profile from a YAML string and validate it.
    pub fn from_yaml_str(s: &str) -> Result<Self, ConfigError> {
        let mut profile: StealthProfile = serde_yaml_ng::from_str(s).map_err(ConfigError::Yaml)?;
        profile.resolve_gpu_profile();
        profile.validate().map_err(ConfigError::Invalid)?;
        Ok(profile)
    }

    /// Parse a profile from a JSON string and validate it.
    pub fn from_json_str(s: &str) -> Result<Self, ConfigError> {
        let mut profile: StealthProfile = serde_json::from_str(s).map_err(ConfigError::Json)?;
        profile.resolve_gpu_profile();
        profile.validate().map_err(ConfigError::Invalid)?;
        Ok(profile)
    }

    /// Load a profile from a `.yaml`/`.yml`/`.json` file on disk.
    pub fn load_from_file(path: impl AsRef<Path>) -> Result<Self, ConfigError> {
        let path = path.as_ref();
        let format = ConfigFormat::from_path(path)?;
        let text = fs::read_to_string(path).map_err(ConfigError::Io)?;
        match format {
            ConfigFormat::Yaml => Self::from_yaml_str(&text),
            ConfigFormat::Json => Self::from_json_str(&text),
        }
    }

    /// Serialise this profile to YAML. Pairs with `from_yaml_str` for
    /// dump-and-edit workflows.
    pub fn to_yaml_string(&self) -> Result<String, ConfigError> {
        serde_yaml_ng::to_string(self).map_err(ConfigError::Yaml)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stealth::presets;

    #[test]
    fn round_trip_yaml() {
        let original = presets::chrome_148_macos();
        let yaml = original.to_yaml_string().expect("serialise to yaml");
        let parsed = StealthProfile::from_yaml_str(&yaml).expect("parse back");
        assert_eq!(parsed.user_agent, original.user_agent);
        assert_eq!(parsed.browser_version, original.browser_version);
        assert_eq!(parsed.screen_width, original.screen_width);
        assert_eq!(parsed.tls_impersonate, original.tls_impersonate);
    }

    #[test]
    fn round_trip_json_matches_yaml() {
        let original = presets::chrome_148_windows();
        let json = serde_json::to_string(&original).expect("serialise json");
        let parsed = StealthProfile::from_json_str(&json).expect("parse json");
        assert_eq!(parsed.user_agent, original.user_agent);
    }

    #[test]
    fn format_detection_by_extension() {
        assert_eq!(
            ConfigFormat::from_path(Path::new("p.yaml")).unwrap(),
            ConfigFormat::Yaml
        );
        assert_eq!(
            ConfigFormat::from_path(Path::new("p.yml")).unwrap(),
            ConfigFormat::Yaml
        );
        assert_eq!(
            ConfigFormat::from_path(Path::new("p.json")).unwrap(),
            ConfigFormat::Json
        );
        assert!(ConfigFormat::from_path(Path::new("p.txt")).is_err());
    }

    #[test]
    fn shipped_example_profile_loads() {
        // The chrome_148_macos.yaml shipped under crates/browser_oxide/profiles/
        // is the example users edit. If a serde rename or required-field
        // addition breaks the example, this test catches it before users do.
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("profiles")
            .join("chrome_148_macos.yaml");
        let profile = StealthProfile::load_from_file(&path)
            .unwrap_or_else(|e| panic!("load {:?}: {e}", path));
        assert_eq!(profile.browser_name, "Chrome");
        assert_eq!(profile.browser_version, "153.0.8010.48");
        assert_eq!(profile.os_name, "macOS");
        assert!(profile.user_agent.contains("Chrome/153.0.0.0"));
    }

    #[test]
    fn unknown_field_rejected() {
        // We do not set `deny_unknown_fields`, so extra keys are tolerated —
        // assert that current behavior, so a future change is a conscious one.
        let yaml = r#"
user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
browser_name: Chrome
browser_version: "153.0.8010.48"
os_name: macOS
os_version: "15.2"
platform: MacIntel
vendor: "Google Inc."
vendor_sub: ""
product_sub: "20030107"
app_version: "5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
screen_width: 2560
screen_height: 1440
screen_avail_width: 2560
screen_avail_height: 1415
screen_avail_top: 25
screen_color_depth: 30
device_pixel_ratio: 2.0
cpu_cores: 10
device_memory: 16
max_touch_points: 0
webgl_vendor: "Google Inc. (Apple)"
webgl_renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)"
language: "en-US"
languages: ["en-US", "en"]
timezone: "America/New_York"
tls_impersonate: "chrome_153"
connection_effective_type: "4g"
connection_rtt: 50
connection_downlink: 10.0
pdf_viewer_enabled: true
plugins_count: 5
mime_types_count: 2
canvas_seed: 1311768467294899695
audio_seed: 18364758544493064001
prefers_color_scheme: "light"
pointer_type: "fine"
hover_capability: "hover"
inner_width: 2560
inner_height: 1304
outer_width: 2560
outer_height: 1415
"#;
        let p = StealthProfile::from_yaml_str(yaml).expect("loads");
        assert!(p.user_agent.contains("153.0.0.0"));
        assert_eq!(p.os_name, "macOS");
    }

    /// A profile that names its GPU but omits `gpu_profile` must not ship
    /// the `nvidia_rtx_3060_windows()` serde default — `gpu_profile` is the
    /// field JS actually reads for UNMASKED_VENDOR/RENDERER, so the default
    /// meant "macOS user agent, NVIDIA-on-Windows WebGL".
    #[test]
    fn omitted_gpu_profile_resolves_from_webgl_renderer() {
        let yaml = r#"
user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
browser_name: "Chrome"
browser_version: "153.0.8010.48"
os_name: "macOS"
os_version: "15.2"
platform: "MacIntel"
vendor: "Google Inc."
vendor_sub: ""
product_sub: "20030107"
app_version: "5.0 (Macintosh)"
screen_width: 1512
screen_height: 982
screen_avail_width: 1512
screen_avail_height: 949
screen_avail_top: 33
screen_color_depth: 30
device_pixel_ratio: 2.0
cpu_cores: 8
device_memory: 8
max_touch_points: 0
webgl_vendor: "Google Inc. (Apple)"
webgl_renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)"
language: "en-US"
languages: ["en-US", "en"]
timezone: "America/Los_Angeles"
cpu_architecture: "arm"
cpu_bitness: "64"
platform_version: "15.2.0"
tls_impersonate: "chrome_153"
connection_effective_type: "4g"
connection_rtt: 50
connection_downlink: 10.0
pdf_viewer_enabled: true
plugins_count: 5
mime_types_count: 2
canvas_seed: 42
audio_seed: 43
audio_sample_rate: 48000
prefers_color_scheme: "light"
pointer_type: "fine"
hover_capability: "hover"
color_gamut: "p3"
inner_width: 1512
inner_height: 838
outer_width: 1512
outer_height: 949
"#;
        let p = StealthProfile::from_yaml_str(yaml).expect("loads");
        assert_eq!(
            p.gpu_profile.unmasked_renderer, p.webgl_renderer,
            "gpu_profile must follow the renderer the profile names"
        );
        assert_eq!(p.gpu_profile.unmasked_vendor, "Google Inc. (Apple)");
        assert!(
            !p.gpu_profile.unmasked_renderer.contains("NVIDIA"),
            "must not fall back to the NVIDIA-on-Windows default"
        );
    }

    /// An Apple Silicon chip with no dedicated capture still resolves to the
    /// shared ANGLE Metal stack under its own name — BrowserForge samples
    /// M1/M2/M4 far more often than the M3 the catalog was captured on.
    #[test]
    fn unknown_apple_chip_resolves_to_metal_stack() {
        let yaml = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/profiles/chrome_148_macos.yaml"
        ))
        .expect("bundled profile readable");
        let yaml = yaml.replace("Apple M3", "Apple M4 Pro");
        let p = StealthProfile::from_yaml_str(&yaml).expect("loads");
        assert!(p.gpu_profile.unmasked_renderer.contains("Apple M4 Pro"));
        assert!(!p.gpu_profile.extensions.is_empty());
    }

    /// The bundled example profile itself — the one the docs tell people to
    /// copy — must come out internally consistent.
    #[test]
    fn bundled_macos_profile_has_consistent_gpu() {
        let p = StealthProfile::load_from_file(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/profiles/chrome_148_macos.yaml"
        ))
        .expect("bundled profile loads");
        assert_eq!(p.gpu_profile.unmasked_renderer, p.webgl_renderer);
        assert_eq!(p.gpu_profile.unmasked_vendor, p.webgl_vendor);
    }
}
