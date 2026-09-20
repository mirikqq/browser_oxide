#!/usr/bin/env python3
"""Generate browser_oxide StealthProfile YAML from BrowserForge fingerprints.

Why
---
`stealth::presets` builds profiles by hand, so field *combinations* are
plausible-by-eye rather than drawn from observed traffic. BrowserForge
(Apache-2.0, the same generator Camoufox uses) samples a Bayesian network
trained on real fingerprints, so screen / hardware / UA-CH combinations are
ones that actually occur together in the wild.

    pip install "browserforge[all]"
    python tools/browserforge_profile.py --os macos --count 5 --out profiles/generated

What this deliberately does NOT take from BrowserForge
------------------------------------------------------
* **Viewport** (`innerWidth`/`innerHeight`/`clientWidth`): emitted as 0 in
  120/120 sampled fingerprints. Derived here from the available area minus
  the browser chrome, the same way `presets::chrome_148_macos_sampled` does.
* **Fonts**: 0-23 probe-detected names (avg 4.8), not a system font list.
  The engine's own `canvas::text::system_fonts` host lookup stays
  authoritative; using this short list as the whole truth would be a
  downgrade.
* **Timezone**: not part of the fingerprint schema at all. The engine ties
  it to the egress IP's geography (`stealth::egress`), which is stronger.
* **Headers**: `net::headers::chrome_headers()` is byte-verified against
  real Chrome captures and covered by the JA4H tests; BrowserForge's header
  generator is statistical and would regress that.
* **TLS parameters**: the cipher list, curves, sigalgs and extension set
  come from `net::tls`'s captured stacks and are NOT sampled. A
  cipher/extension combination no shipping browser emits is a far stronger
  signal than a common one, so "generating" TLS means *selecting a real
  captured stack* (via `tls_impersonate`, which `validate()` checks
  against the stack actually emitted) — not inventing parameters. The
  per-connection variation real Chrome does have is already implemented:
  a fresh Fisher-Yates extension permutation and GREASE per handshake, so
  JA3 differs handshake to handshake while JA4 stays stable.
* **canvas/audio seeds**: engine-owned, randomised per profile below.

Consistency gates
-----------------
A sample is rejected unless it is coherent with the parts of the engine
that are NOT generated:

1. **Chrome major must equal the TLS profile's major.** `net::tls` sends a
   byte-exact Chrome 147 ClientHello; a generated UA claiming 138 with a
   147-era JA4 (MLKEM768 post-quantum, which did not exist before Chrome
   131) is a worse fingerprint than a hand-built one. ~84% of samples are
   already 147, so resampling is cheap.
2. **GPU must resolve to a catalog entry.** `stealth::gpu` supplies the
   extension list, getParameter values and shader precision that JS
   actually reports; a renderer string with no matching entry would ship
   another GPU's WebGL surface. `gpu::by_unmasked_renderer` resolves every
   Apple Silicon chip name plus the captured NVIDIA/Intel entries.
3. **`StealthProfile::validate()`** is the final gate — run the emitted
   file through the engine (the `--check` hint printed at the end).
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from dataclasses import dataclass
from pathlib import Path

try:
    from browserforge.fingerprints import FingerprintGenerator
except ImportError:  # pragma: no cover - dependency hint
    sys.exit('browserforge is not installed. Run: pip install "browserforge[all]"')


# Chrome major the engine's TLS/H2 fingerprint reproduces byte-exactly.
# Keep in sync with `net::tls`'s documented capture version.
TLS_CHROME_MAJOR = 147

# Renderers `stealth::gpu::by_unmasked_renderer` can resolve. Apple Silicon
# is matched by pattern (any chip name on the shared ANGLE Metal stack);
# the others need their own captured entry.
APPLE_SILICON_RE = re.compile(
    r"^ANGLE \(Apple, ANGLE Metal Renderer: Apple [^,]+, Unspecified Version\)$"
)
CAPTURED_RENDERERS = {
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)",
}

# Chrome's own UI height above the viewport (toolbar + tab strip +
# bookmarks bar), matching the constant the in-tree samplers use.
CHROME_UI_HEIGHT = 111

OS_META = {
    "macos": {"os_name": "macOS", "platform": "MacIntel", "tz": "America/Los_Angeles"},
    "windows": {"os_name": "Windows", "platform": "Win32", "tz": "America/New_York"},
    "linux": {"os_name": "Linux", "platform": "Linux x86_64", "tz": "Europe/Berlin"},
}


@dataclass
class Rejected:
    version: int = 0
    full_version: int = 0
    gpu: int = 0
    screen: int = 0

    def total(self) -> int:
        return self.version + self.full_version + self.gpu + self.screen


# Core counts Apple actually ships per chip. BrowserForge's network models
# each field's marginal distribution well but does not tie GPU to CPU: it
# happily emits `cpu_cores: 6` alongside an M2 Pro, a machine that has only
# ever shipped with 10 or 12.
APPLE_CHIP_CORES = {
    "Apple M1": [8],
    "Apple M1 Pro": [8, 10],
    "Apple M1 Max": [10],
    "Apple M1 Ultra": [20],
    "Apple M2": [8],
    "Apple M2 Pro": [10, 12],
    "Apple M2 Max": [12],
    "Apple M2 Ultra": [24],
    "Apple M3": [8],
    "Apple M3 Pro": [11, 12],
    "Apple M3 Max": [14, 16],
    "Apple M4": [10],
    "Apple M4 Pro": [12, 14],
    "Apple M4 Max": [14, 16],
}

# navigator.deviceMemory is quantised by the Device Memory spec and never
# exceeds 8 in a real browser, however much RAM the machine has. The
# generator hands out raw RAM figures (16, 32), which is a direct tell.
DEVICE_MEMORY_BUCKETS = [1, 2, 4, 8]


def apple_chip(renderer: str | None) -> str | None:
    if not renderer or not APPLE_SILICON_RE.match(renderer):
        return None
    return renderer.split("Metal Renderer: ", 1)[1].split(",", 1)[0]


def harmonize(profile: dict, rng: random.Random) -> dict:
    """Repair cross-field contradictions BrowserForge's per-field sampling
    leaves behind. Each rule below fixes a combination the engine's own
    `validate()` or a fingerprint cross-check would flag."""
    chip = apple_chip(profile["webgl_renderer"])
    if chip:
        # Apple Silicon is ARM-only; `Sec-CH-UA-Arch: "x86"` next to an
        # Apple GPU contradicts itself, and profile.rs calls out this exact
        # pairing ("Real Chrome on M3 reports Sec-CH-UA-Arch: arm").
        profile["cpu_architecture"] = "arm"
        cores = APPLE_CHIP_CORES.get(chip)
        if cores and profile["cpu_cores"] not in cores:
            profile["cpu_cores"] = rng.choice(cores)

    # Quantise RAM down to the nearest reportable bucket, capped at 8.
    mem = profile["device_memory"]
    profile["device_memory"] = max(b for b in DEVICE_MEMORY_BUCKETS if b <= max(mem, 1))

    # navigator.languages carries the base language after the regional one
    # ("en-US" alone is not what a real en-US Chrome reports).
    langs = profile["languages"]
    if len(langs) == 1 and "-" in langs[0]:
        langs.append(langs[0].split("-", 1)[0])

    # The window must fit inside the available area, and the viewport
    # inside the window — `validate()` enforces the whole chain.
    profile["outer_width"] = min(profile["outer_width"], profile["screen_avail_width"])
    profile["outer_height"] = min(profile["outer_height"], profile["screen_avail_height"])
    profile["inner_width"] = min(profile["inner_width"], profile["outer_width"])
    profile["inner_height"] = min(profile["inner_height"], profile["outer_height"])
    return profile


def gpu_is_supported(renderer: str | None) -> bool:
    if not renderer:
        return False
    return bool(APPLE_SILICON_RE.match(renderer)) or renderer in CAPTURED_RENDERERS


def chrome_major(user_agent: str) -> int | None:
    m = re.search(r"Chrome/(\d+)", user_agent)
    return int(m.group(1)) if m else None


def os_version_for(os_key: str, ua_data: dict) -> str:
    """A human `os_version`, kept consistent with the UA-CH platformVersion."""
    pv = str(ua_data.get("platformVersion") or "")
    if os_key == "macos":
        # UA-CH reports macOS as "26.4.1"-style; os_version mirrors it.
        return pv or "15.2"
    if os_key == "windows":
        # Chrome maps Win10 and Win11 both to "10.0.0"+ in UA-CH; the
        # platform version is what separates them.
        return "11" if pv and int(pv.split(".")[0] or 0) >= 13 else "10"
    return pv or ""


def build_profile(fp, os_key: str, rng: random.Random) -> dict:
    nav = fp.navigator
    scr = fp.screen
    ua_data = fp.navigator.userAgentData or {}
    meta = OS_META[os_key]

    # Viewport: BrowserForge emits zeros, so derive it. A maximised window
    # fills the *available* area (the macOS menu bar keeps its strip), and
    # the viewport is that minus Chrome's own UI.
    outer_w = scr.availWidth or scr.width
    outer_h = scr.availHeight or scr.height
    inner_w = outer_w
    inner_h = max(outer_h - CHROME_UI_HEIGHT, 200)

    full_version = str(ua_data.get("uaFullVersion") or "")
    major = chrome_major(nav.userAgent)

    profile = {
        # ---- Identity ----
        "user_agent": nav.userAgent,
        "browser_name": "Chrome",
        "browser_version": full_version or f"{major}.0.0.0",
        "os_name": meta["os_name"],
        "os_version": os_version_for(os_key, ua_data),
        "platform": nav.platform or meta["platform"],
        "vendor": nav.vendor or "Google Inc.",
        "vendor_sub": nav.vendorSub or "",
        "product_sub": nav.productSub or "20030107",
        "app_version": nav.appVersion,
        # ---- Hardware ----
        "screen_width": scr.width,
        "screen_height": scr.height,
        "screen_avail_width": scr.availWidth or scr.width,
        "screen_avail_height": scr.availHeight or scr.height,
        "screen_avail_top": scr.availTop or 0,
        "screen_color_depth": scr.colorDepth,
        "device_pixel_ratio": round(float(scr.devicePixelRatio), 4),
        "cpu_cores": nav.hardwareConcurrency,
        "device_memory": nav.deviceMemory or 8,
        "max_touch_points": nav.maxTouchPoints or 0,
        # ---- GPU ----
        # `gpu_profile` is intentionally omitted: the engine resolves it
        # from this renderer via `gpu::by_unmasked_renderer` at load time,
        # so the extension list / params / shader precision stay matched to
        # the chip named here instead of falling back to a default.
        "webgl_vendor": fp.videoCard.vendor,
        "webgl_renderer": fp.videoCard.renderer,
        # ---- Locale ----
        "language": nav.language or "en-US",
        "languages": list(nav.languages) or ["en-US", "en"],
        "timezone": meta["tz"],
        # ---- Client Hints (high-entropy) ----
        "cpu_architecture": str(ua_data.get("architecture") or "x86"),
        "cpu_bitness": str(ua_data.get("bitness") or "64"),
        "platform_version": str(ua_data.get("platformVersion") or ""),
        "ua_model": str(ua_data.get("model") or ""),
        "ua_wow64": bool(ua_data.get("wow64") or False),
        # ---- Network ----
        # The TLS identity is a *declaration* the engine machine-checks
        # against the stack it will actually emit
        # (`net::tls::expected_impersonate` + the `validate()` rule), so a
        # generated profile cannot end up with a Chrome ClientHello under
        # a non-Chrome UA. Desktop Chrome is the only class this script
        # emits; Firefox/Android/iOS have their own captured stacks
        # ("firefox_135" / "chrome_147_android" / "safari_18_ios").
        "tls_impersonate": f"chrome_{TLS_CHROME_MAJOR}",
        "connection_effective_type": "4g",
        "connection_rtt": rng.choice([25, 50, 75, 100, 125]),
        "connection_downlink": rng.choice([1.5, 3.0, 5.0, 7.5, 10.0]),
        # ---- Plugins ----
        "pdf_viewer_enabled": bool(
            (nav.extraProperties or {}).get("pdfViewerEnabled", True)
        ),
        "plugins_count": 5,
        "mime_types_count": 2,
        # ---- Fingerprint seeds (engine-owned, per instance) ----
        "canvas_seed": rng.getrandbits(64),
        "audio_seed": rng.getrandbits(64),
        # Apple Silicon ships 48 kHz natively; 44.1 kHz stays the common
        # default elsewhere.
        "audio_sample_rate": 48000 if os_key == "macos" else 44100,
        # ---- Media features ----
        "prefers_color_scheme": "light",
        "pointer_type": "fine",
        "hover_capability": "hover",
        # macOS/iOS panels are wide-gamut; Windows/Linux report sRGB.
        "color_gamut": "p3" if os_key == "macos" else "srgb",
        # ---- Window ----
        "inner_width": inner_w,
        "inner_height": inner_h,
        "outer_width": outer_w,
        "outer_height": outer_h,
    }
    if os_key == "linux":
        # Chrome on Linux reports an empty platform version — validate()
        # enforces this.
        profile["platform_version"] = ""
    return harmonize(profile, rng)


def to_yaml(profile: dict) -> str:
    """Minimal YAML writer — avoids a PyYAML dependency for flat data."""
    lines = ["# Generated by tools/browserforge_profile.py — do not hand-edit.", ""]
    for key, value in profile.items():
        if isinstance(value, bool):
            rendered = "true" if value else "false"
        elif isinstance(value, str):
            rendered = json.dumps(value)
        elif isinstance(value, list):
            rendered = "[" + ", ".join(json.dumps(v) for v in value) + "]"
        else:
            rendered = str(value)
        lines.append(f"{key}: {rendered}")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--os", default="macos", choices=sorted(OS_META))
    ap.add_argument("--count", type=int, default=1)
    ap.add_argument("--out", type=Path, help="directory to write <n>.yaml into")
    ap.add_argument("--seed", type=int, help="reproducible engine-owned fields")
    ap.add_argument(
        "--max-attempts", type=int, default=4000, help="resampling budget"
    )
    args = ap.parse_args()

    rng = random.Random(args.seed)
    gen = FingerprintGenerator(browser="chrome", os=args.os, device="desktop")

    profiles: list[dict] = []
    rejected = Rejected()
    for _ in range(args.max_attempts):
        if len(profiles) >= args.count:
            break
        fp = gen.generate()
        if chrome_major(fp.navigator.userAgent) != TLS_CHROME_MAJOR:
            rejected.version += 1
            continue
        # `browser_version` feeds sec-ch-ua-full-version-list, which carries
        # the full 4-part build ("147.0.7727.117"). Samples without a
        # uaFullVersion would fall back to the *reduced* UA form
        # ("147.0.0.0") — the right string for the UA header, a tell in the
        # full-version list.
        ua_full = str((fp.navigator.userAgentData or {}).get("uaFullVersion") or "")
        if len(ua_full.split(".")) != 4 or ua_full.endswith(".0.0.0"):
            rejected.full_version += 1
            continue
        if not fp.videoCard or not gpu_is_supported(fp.videoCard.renderer):
            rejected.gpu += 1
            continue
        if not fp.screen.width or not fp.screen.height:
            rejected.screen += 1
            continue
        profiles.append(build_profile(fp, args.os, rng))

    if len(profiles) < args.count:
        print(
            f"only {len(profiles)}/{args.count} samples passed the gates "
            f"({rejected.total()} rejected: version={rejected.version} "
            f"full_version={rejected.full_version} gpu={rejected.gpu} screen={rejected.screen})",
            file=sys.stderr,
        )

    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        for i, profile in enumerate(profiles):
            path = args.out / f"{args.os}_{i:02d}.yaml"
            path.write_text(to_yaml(profile))
            print(path)
        print(
            f"\nrejected {rejected.total()} samples "
            f"(version={rejected.version} full_version={rejected.full_version} gpu={rejected.gpu} screen={rejected.screen})",
            file=sys.stderr,
        )
        print(
            "verify with: StealthProfile::load_from_file(<path>) — it runs "
            "validate() and resolves gpu_profile from webgl_renderer",
            file=sys.stderr,
        )
    else:
        for profile in profiles:
            print(to_yaml(profile))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
