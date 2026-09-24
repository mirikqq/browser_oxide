//! BoringSSL TLS configuration reproducing captured browser ClientHellos.
//!
//! The Chrome desktop stack is the one captured from Chrome
//! [`TLS_CHROME_MAJOR`] (cipher suites, curves, signature algorithms,
//! extensions and certificate compression, all in the order that produces
//! its JA3/JA4); Chrome Android, Safari on iOS and Firefox each have their
//! own. [`expected_impersonate`] names the stack a profile gets.

use crate::stealth::{DeviceClass, StealthProfile};
use boring2::ssl::{
    CertCompressionAlgorithm, ConnectConfiguration, SslConnector, SslCurve, SslMethod, SslOptions,
    SslVersion,
};
use boring2::x509::store::X509StoreBuilder;
use boring2::x509::X509;
use foreign_types::ForeignTypeRef;
use tokio::net::TcpStream;
use tokio_boring2::SslStream;

use crate::net::error::NetError;

/// The Chrome major version whose **verified-real** ClientHello / H2
/// fingerprint these constants reproduce, byte-exact.
///
/// Chrome's TLS ClientHello is version-stable across majors: it changes
/// only on a deliberate TLS-stack change, the last being ML-DSA signature
/// algorithms, signature-algorithm GREASE and Trust Anchor IDs, all present
/// by Chrome 152. So this capture stays valid for
/// neighbouring majors without a re-capture, and JA4 — TLS version +
/// sorted cipher/extension counts + ALPN + sorted sigalgs — carries no
/// Chrome version at all.
///
/// What this constant *is* for: pinning which capture the wire bytes came
/// from, so a future TLS-stack change is a deliberate re-capture rather
/// than silent drift (see `tls_fingerprint_vectors_no_silent_drift`).
pub const TLS_CHROME_MAJOR: u32 = 153;

/// The Chrome major every desktop Chrome preset's `user_agent`
/// advertises.
///
/// Kept equal to [`TLS_CHROME_MAJOR`]. An earlier revision ran these
/// deliberately apart (UA 148 over the wire-identical 147 capture, on the
/// argument that JA4 cannot encode the minor difference); the presets
/// have since settled on 147 and the constant had been left behind at
/// 148, so the coherence assertion below was failing on every run — a
/// permanently-red guard, which is worse than no guard: it stops being
/// read, and the next real drift hides behind it.
///
/// Generated profiles do not use this constant. They carry their own UA
/// from the fingerprint generator, and their TLS identity is checked
/// per-profile instead — see [`expected_impersonate`] and the
/// `tls_impersonate` rule in `StealthProfile::validate`.
pub const UA_CHROME_MAJOR: u32 = 153;

/// Which captured ClientHello family a profile gets on the wire.
///
/// The one decision both halves read: [`expected_impersonate`] names the stack
/// a profile may declare, and [`chrome_connector`] / [`configure_connection`]
/// branch on the same value to build it, so the declaration and the bytes
/// cannot drift apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WireFamily {
    ChromeDesktop,
    ChromeAndroid,
    /// Every browser on iOS: they all run on WebKit's network stack, whatever
    /// the user agent names.
    SafariIos,
    /// NSS-class ClientHello (GeckoView on Android shares it).
    Firefox,
}

pub(crate) fn wire_family(profile: &StealthProfile) -> WireFamily {
    match (profile.device_class, profile.browser_name.as_str()) {
        (DeviceClass::MobileIOS, _) => WireFamily::SafariIos,
        (_, "Firefox") => WireFamily::Firefox,
        (DeviceClass::MobileAndroid, _) => WireFamily::ChromeAndroid,
        (DeviceClass::Desktop, _) => WireFamily::ChromeDesktop,
    }
}

/// A captured ClientHello this module can put on the wire.
struct Stack {
    /// The `tls_impersonate` name a profile declares for it.
    name: &'static str,
    family: WireFamily,
    /// The browser major the capture was taken from.
    major: u32,
    /// That browser's full version, as a profile built around this stack
    /// reports it.
    version: &'static str,
}

/// Every stack this module can emit, oldest first within a family.
const STACKS: &[Stack] = &[
    Stack {
        name: "chrome_153",
        family: WireFamily::ChromeDesktop,
        major: TLS_CHROME_MAJOR,
        version: crate::stealth::presets::CHROME_DESKTOP_VERSION,
    },
    Stack {
        name: "chrome_147_android",
        family: WireFamily::ChromeAndroid,
        major: 147,
        version: "147.0.7727.117",
    },
    Stack {
        name: "safari_18_ios",
        family: WireFamily::SafariIos,
        major: 18,
        version: "18.0.1",
    },
    Stack {
        name: "firefox_135",
        family: WireFamily::Firefox,
        major: 135,
        version: "135.0",
    },
];

/// Every `tls_impersonate` name a profile may declare.
pub fn supported_impersonations() -> impl Iterator<Item = &'static str> {
    STACKS.iter().map(|stack| stack.name)
}

/// The full browser version a stack's capture was taken from, as a profile
/// built around it reports it (the generator presents sampled machines as
/// running exactly this version).
pub fn impersonation_version(name: &str) -> Option<&'static str> {
    STACKS
        .iter()
        .find(|stack| stack.name == name)
        .map(|stack| stack.version)
}

/// The major version a profile's `browser_version` names; 0 when unparsable.
fn browser_major(profile: &StealthProfile) -> u32 {
    profile
        .browser_version
        .split('.')
        .next()
        .and_then(|major| major.trim().parse().ok())
        .unwrap_or(0)
}

/// The TLS identity `chrome_connector`/`configure_connection` will actually
/// emit for this profile.
///
/// The wire stack is chosen from `browser_name` + `device_class`, while
/// the profile *also* carries a `tls_impersonate` string. Nothing read
/// that string, so it could say anything — a profile could advertise
/// `firefox_135` and put a Chrome ClientHello on the wire, which is
/// precisely the JA4-vs-UA contradiction the Firefox branch exists to
/// avoid. `StealthProfile::validate` now checks the declaration against
/// this function, so the field is a machine-checked statement of intent
/// rather than a comment.
///
/// Within the profile's wire family the stack is the newest capture at or
/// below the profile's browser major, else the oldest: a profile newer than
/// every capture still has to put a real handshake on the wire, and the newest
/// one is the closest available truth — inventing parameters for the version
/// it names would produce a ClientHello no shipping browser emits. With one
/// capture per family today this picks that capture; a second capture joins
/// the stack table and is selected by version with no change here.
///
/// This is also what makes TLS *generated* rather than hardcoded: a
/// generated profile names its TLS identity as data, and the check keeps
/// that name honest. Note the values are a small set of **captured, real**
/// stacks — TLS parameters cannot be sampled freely the way canvas or
/// audio noise can, because a cipher/extension list that no shipping
/// browser emits is a far stronger signal than a common one. What *does*
/// vary per connection is what real Chrome varies: the Fisher-Yates
/// extension permutation and fresh GREASE (see
/// `CHROME_EXTENSION_PERMUTATION`), so JA3 differs handshake to handshake
/// while JA4 stays stable — exactly Chrome's own behaviour since 110.
pub fn expected_impersonate(profile: &StealthProfile) -> &'static str {
    let family = wire_family(profile);
    let major = browser_major(profile);
    let mut candidates = STACKS.iter().filter(|stack| stack.family == family);
    let oldest = candidates.clone().next();
    candidates
        .rfind(|stack| stack.major <= major)
        .or(oldest)
        .map(|stack| stack.name)
        .expect("STACKS covers every WireFamily")
}

/// Chrome's cipher suite list, desktop and Android (order is critical for the
/// JA3 fingerprint). Unchanged through the `chrome_153` capture; pinned by
/// `tls_fingerprint_vectors_no_silent_drift`.
const CIPHER_LIST: &str = concat!(
    "TLS_AES_128_GCM_SHA256",
    ":TLS_AES_256_GCM_SHA384",
    ":TLS_CHACHA20_POLY1305_SHA256",
    ":TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256",
    ":TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
    ":TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
    ":TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
    ":TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256",
    ":TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256",
    ":TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA",
    ":TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA",
    ":TLS_RSA_WITH_AES_128_GCM_SHA256",
    ":TLS_RSA_WITH_AES_256_GCM_SHA384",
    ":TLS_RSA_WITH_AES_128_CBC_SHA",
    ":TLS_RSA_WITH_AES_256_CBC_SHA",
);

/// Chrome's base signature algorithms (order matters). Desktop Chrome 152+
/// appends the ML-DSA ones after these — see
/// `CHROME_DESKTOP_ADVERTISED_EXTRA_SIGALGS`.
const SIGALGS_LIST: &str = concat!(
    "ecdsa_secp256r1_sha256",
    ":rsa_pss_rsae_sha256",
    ":rsa_pkcs1_sha256",
    ":ecdsa_secp384r1_sha384",
    ":rsa_pss_rsae_sha384",
    ":rsa_pkcs1_sha384",
    ":rsa_pss_rsae_sha512",
    ":rsa_pkcs1_sha512",
);

/// Chrome desktop elliptic curves (Chrome 131+ uses MLKEM768).
const CURVES_DESKTOP: &[SslCurve] = &[
    SslCurve::X25519_MLKEM768,
    SslCurve::X25519,
    SslCurve::SECP256R1,
    SslCurve::SECP384R1,
];

/// Chrome Android elliptic curves. Kyber768Draft00 (deprecated) was the
/// canonical Chrome 124-130 PQ curve; Chrome 131+ desktop replaced it with
/// MLKEM768 (codepoint 4588). A reference Chrome 131 Android capture
/// shows no PQ at all (just 29/23/24), but Chrome Android shares the
/// desktop codebase and by Chrome 147+ should have rolled MLKEM — verify
/// against a fresh Pixel capture if regressions appear.
const CURVES_ANDROID: &[SslCurve] = CURVES_DESKTOP;

/// iOS Safari 18 cipher suite list (20 ciphers, Apple's order). Per a
/// reference Safari iOS 18 TLS capture.
/// Distinct from Chrome desktop (15 ciphers): includes 3DES_EDE_CBC_SHA at
/// the tail and an extra RSA_WITH_3DES_EDE_CBC_SHA. Cipher order matters
/// for JA3.
const CIPHER_LIST_SAFARI_IOS: &str = concat!(
    "TLS_AES_128_GCM_SHA256",
    ":TLS_AES_256_GCM_SHA384",
    ":TLS_CHACHA20_POLY1305_SHA256",
    ":TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
    ":TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256",
    ":TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256",
    ":TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
    ":TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
    ":TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256",
    ":TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA",
    ":TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA",
    ":TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA",
    ":TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA",
    ":TLS_RSA_WITH_AES_256_GCM_SHA384",
    ":TLS_RSA_WITH_AES_128_GCM_SHA256",
    ":TLS_RSA_WITH_AES_256_CBC_SHA",
    ":TLS_RSA_WITH_AES_128_CBC_SHA",
    ":TLS_ECDHE_ECDSA_WITH_3DES_EDE_CBC_SHA",
    ":TLS_ECDHE_RSA_WITH_3DES_EDE_CBC_SHA",
    ":TLS_RSA_WITH_3DES_EDE_CBC_SHA",
);

/// iOS Safari signature algorithms (10 entries, includes the duplicated
/// `rsa_pss_rsae_sha384` Apple quirk we must reproduce verbatim).
/// Reference Safari TLS captures include the duplicate.
const SIGALGS_LIST_SAFARI_IOS: &str = concat!(
    "ecdsa_secp256r1_sha256",
    ":rsa_pss_rsae_sha256",
    ":rsa_pkcs1_sha256",
    ":ecdsa_secp384r1_sha384",
    ":rsa_pss_rsae_sha384",
    ":rsa_pss_rsae_sha384",
    ":rsa_pkcs1_sha384",
    ":rsa_pss_rsae_sha512",
    ":rsa_pkcs1_sha512",
    ":rsa_pkcs1_sha1",
);

/// iOS Safari 18 elliptic curves. No PQ (MLKEM lands in iOS 26 per Apple's
/// PQC support page). Adds P-521 vs Chrome desktop. Order per safari_18.0_iOS.yaml.
const CURVES_SAFARI_IOS: &[SslCurve] = &[
    SslCurve::X25519,
    SslCurve::SECP256R1,
    SslCurve::SECP384R1,
    SslCurve::SECP521R1,
];

/// iOS Safari 18 extension permutation. Indices into BoringSSL's internal
/// `BORING_SSLEXTENSION_PERMUTATION` table — see boring2 ssl/mod.rs for the
/// canonical ordering. Per reference Safari iOS 18 TLS captures, real
/// Safari emits its extensions in a FIXED order (no Fisher-Yates shuffle),
/// roughly: server_name, extended_master_secret, renegotiate, supported_groups,
/// ec_point_formats, ALPN, status_request, signature_algorithms,
/// signed_certificate_timestamp, key_share, psk_key_exchange_modes,
/// supported_versions, cert_compression. (GREASE and PADDING are auto-emitted
/// by BoringSSL outside the permutation table; PADDING positional ordering
/// requires raw extension injection — deferred.)
const SAFARI_IOS_EXTENSION_PERMUTATION: &[u8] = &[
    0,  // server_name
    2,  // extended_master_secret
    3,  // renegotiate
    4,  // supported_groups
    5,  // ec_point_formats
    7,  // application_layer_protocol_negotiation (ALPN)
    8,  // status_request
    9,  // signature_algorithms
    11, // certificate_timestamp
    14, // key_share
    15, // psk_key_exchange_modes
    17, // supported_versions
    21, // cert_compression (compress_certificate, type 27). boring2 kExtensions
        // index is 21 (proven by CHROME_EXTENSION_PERMUTATION, which emits 0x1b);
        // the previous `22` is the PADDING slot — a live TLS-fingerprint capture
        // showed this index emitting ext 0x15 (padding) instead of 0x1b
        // here, giving JA4 t13d2013h2 vs real iOS-18 Safari's t13d2014h2. With
        // 21, compress_certificate is emitted and BoringSSL auto-appends padding
        // last by ClientHello length → the 14-extension Safari JA4.
];

/// Firefox 135 (NSS) cipher suite list — 17 ciphers, NSS order. Distinct
/// from Chrome's 15: NSS leads TLS1.3 with AES-128-GCM, CHACHA20, AES-256-GCM
/// (CHACHA before AES-256), then the ECDHE-ECDSA/RSA GCM pairs, then the CBC
/// block (ECDSA before RSA, 256 before 128 in NSS's CBC ordering), then the
/// two RSA-GCM and two RSA-CBC fallbacks. Yields the Firefox JA4 cipher hash
/// `5b57614c22b0` (vs Chrome's). Per reference Firefox TLS captures.
const CIPHER_LIST_FIREFOX: &str = concat!(
    "TLS_AES_128_GCM_SHA256",
    ":TLS_CHACHA20_POLY1305_SHA256",
    ":TLS_AES_256_GCM_SHA384",
    ":TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256",
    ":TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
    ":TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256",
    ":TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256",
    ":TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
    ":TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
    ":TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA",
    ":TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA",
    ":TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA",
    ":TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA",
    ":TLS_RSA_WITH_AES_128_GCM_SHA256",
    ":TLS_RSA_WITH_AES_256_GCM_SHA384",
    ":TLS_RSA_WITH_AES_128_CBC_SHA",
    ":TLS_RSA_WITH_AES_256_CBC_SHA",
);

/// Firefox 135 (NSS) signature algorithms — 11 entries, NSS order: the three
/// ECDSA curves first, then RSA-PSS, then RSA-PKCS1, then the SHA-1 tail
/// (ecdsa_sha1, rsa_pkcs1_sha1). Yields the Firefox JA4 sigalg hash
/// `3d5424432f57`.
const SIGALGS_LIST_FIREFOX: &str = concat!(
    "ecdsa_secp256r1_sha256",
    ":ecdsa_secp384r1_sha384",
    ":ecdsa_secp521r1_sha512",
    ":rsa_pss_rsae_sha256",
    ":rsa_pss_rsae_sha384",
    ":rsa_pss_rsae_sha512",
    ":rsa_pkcs1_sha256",
    ":rsa_pkcs1_sha384",
    ":rsa_pkcs1_sha512",
    ":ecdsa_sha1",
    ":rsa_pkcs1_sha1",
);

/// Firefox 135 supported_groups. NSS appends the two FFDHE groups
/// (ffdhe2048, ffdhe3072) after the EC curves — a hard Firefox signature no
/// Chrome build sends. X25519MLKEM768 leads (Firefox shipped PQ key-share by
/// default in 132+). P-521 present (Chrome desktop omits it).
const CURVES_FIREFOX: &[SslCurve] = &[
    SslCurve::X25519_MLKEM768,
    SslCurve::X25519,
    SslCurve::SECP256R1,
    SslCurve::SECP384R1,
    SslCurve::SECP521R1,
    SslCurve::FFDHE2048,
    SslCurve::FFDHE3072,
];

/// Firefox 135 delegated_credentials (ext 0x22) sigalg list — Firefox-only.
/// The four ECDSA sigalgs NSS advertises in the delegated-credential ext.
const FIREFOX_DELEGATED_CREDENTIALS: &str = concat!(
    "ecdsa_secp256r1_sha256",
    ":ecdsa_secp384r1_sha384",
    ":ecdsa_secp521r1_sha512",
    ":ecdsa_sha1",
);

/// Firefox 135 record_size_limit (ext 0x1c) value: 0x4001 (16385).
const FIREFOX_RECORD_SIZE_LIMIT: u16 = 0x4001;

/// Firefox 135 extension order (indices into BoringSSL's
/// `BORING_SSLEXTENSION_PERMUTATION` table — same index space the Chrome and
/// Safari permutations use). FIXED order every handshake (NSS does not
/// Fisher-Yates shuffle). 15 extensions → the Firefox `t13d1715h2` JA4 count.
/// Index map (proven from CHROME_/SAFARI_ permutations + boring2 ext table):
/// 0=SNI, 1=ECH, 2=ext_master_secret, 3=renegotiate, 4=supported_groups,
/// 5=ec_point_formats, 6=session_ticket, 7=ALPN, 8=status_request,
/// 9=signature_algorithms, 14=key_share, 15=psk_kex_modes, 17=supported_versions,
/// 22=delegated_credentials, 26=record_size_limit. Order verified against a
/// reference Firefox 135 TLS capture — iterate if the JA4 ext-hash diverges.
const FIREFOX_EXTENSION_PERMUTATION: &[u8] = &[
    0,  // server_name
    2,  // extended_master_secret
    3,  // renegotiation_info
    4,  // supported_groups
    5,  // ec_point_formats
    6,  // session_ticket
    7,  // ALPN
    8,  // status_request
    22, // delegated_credentials (0x22) — Firefox-only
    14, // key_share
    17, // supported_versions
    9,  // signature_algorithms
    15, // psk_key_exchange_modes
    25, // record_size_limit (0x1c) — Firefox-only (boring2 perm-table index 25)
    1,  // encrypted_client_hello (ECH grease)
];

/// ALPN protocols: h2 + http/1.1
const ALPN_PROTOS: &[u8] = b"\x02h2\x08http/1.1";

use rand::prelude::SliceRandom;

/// Chrome 152 extension permutation (indices into BoringSSL kExtensions table).
/// 17 extensions matching a verified Chrome 152 macOS arm64 reference capture,
/// and the Chrome 153 one (`desktop_client_hello_matches_the_chrome_153_capture`).
///
/// **Real Chrome shuffling behavior** (per Fastly TLS Fingerprinting blog
/// + Chromestatus 5124606246518784 + BoringSSL `ssl_setup_extension_permutation`
/// source): Chrome shuffles ALL non-PSK extensions with a single Fisher-Yates
/// pass — there is no documented bucket structure. The only positional
/// constraint is psk_key_exchange_modes / pre_shared_key being last (BoringSSL
/// enforces this). The previous 3-bucket scheme was folklore from earlier
/// public RE work; it reduced shuffle entropy by ~720,000× and put
/// signature_algorithms always at position 16 — a deterministic positional
/// pattern that per-handshake classifiers can detect as anomalous.
const CHROME_EXTENSION_PERMUTATION: &[u8] = &[
    14, // key_share (51)
    1,  // encrypted_client_hello (65037)
    4,  // supported_groups (10)
    11, // certificate_timestamp (18)
    15, // psk_key_exchange_modes (45)
    2,  // extended_master_secret (23)
    24, // application_settings_new (17613)
    21, // cert_compression (27)
    17, // supported_versions (43)
    0,  // server_name (0)
    3,  // renegotiate (65281)
    5,  // ec_point_formats (11)
    8,  // status_request (5)
    7,  // application_layer_protocol_negotiation (16)
    6,  // session_ticket (35)
    9,  // signature_algorithms (13)
    26, // trust_anchors (0xca34)
];

const CHROME_DESKTOP_ADVERTISED_EXTRA_SIGALGS: &[u16] = &[0x0904, 0x0905, 0x0906];

#[rustfmt::skip]
const CHROME_DESKTOP_TRUST_ANCHOR_IDS: &[u8] = &[
    0x04, 0xd6, 0x79, 0x09, 0x0e,
    0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x07,
    0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x09,
    0x04, 0xd6, 0x79, 0x09, 0x09,
    0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x08,
    0x04, 0xd6, 0x79, 0x09, 0x06,
    0x05, 0x82, 0xdf, 0x13, 0x02, 0x14,
    0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x0d,
    0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x0c,
    0x05, 0x82, 0xdf, 0x13, 0x02, 0x0e,
    0x04, 0xd6, 0x79, 0x09, 0x01,
    0x04, 0xd6, 0x79, 0x09, 0x0d,
    0x04, 0xd6, 0x79, 0x09, 0x08,
    0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x0b,
    0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x0a,
    0x04, 0xd6, 0x79, 0x09, 0x05,
    0x04, 0xd6, 0x79, 0x09, 0x0b,
    0x05, 0x82, 0xdf, 0x13, 0x02, 0x01,
    0x04, 0xd6, 0x79, 0x09, 0x0c,
    0x05, 0x82, 0xdf, 0x13, 0x02, 0x0f,
    0x05, 0x82, 0xdf, 0x13, 0x02, 0x12,
    0x04, 0xd6, 0x79, 0x09, 0x03,
    0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x13,
    0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x12,
    0x04, 0xd6, 0x79, 0x09, 0x04,
    0x04, 0xd6, 0x79, 0x09, 0x0f,
    0x05, 0x82, 0xdf, 0x13, 0x02, 0x13,
    0x05, 0x82, 0xdf, 0x13, 0x02, 0x06,
    0x04, 0xd6, 0x79, 0x09, 0x0a,
    0x04, 0xd6, 0x79, 0x09, 0x07,
    0x05, 0x82, 0xdf, 0x13, 0x02, 0x0d,
    0x04, 0xd6, 0x79, 0x09, 0x02,
];

/// Generate a fresh Fisher-Yates shuffle over all 17 Chrome 152 extensions.
fn shuffled_chrome_extension_permutation() -> Vec<u8> {
    let mut rng = rand::rng();
    let mut permutation = CHROME_EXTENSION_PERMUTATION.to_vec();
    permutation.shuffle(&mut rng);
    permutation
}

/// Build an `SslConnector` configured with the TLS fingerprint of the
/// profile's wire family — the same decision [`expected_impersonate`]
/// names, so the declared stack and the emitted one cannot differ.
pub fn chrome_connector(profile: &StealthProfile) -> Result<SslConnector, NetError> {
    // Per-family branching.
    //  - Chrome desktop / Android: shared cipher/sigalg/extension config.
    //    Android diverges in the curves list, and desktop alone adds the
    //    ML-DSA sigalgs and Trust Anchor IDs of the chrome_153 capture.
    //  - Firefox: the NSS-class ClientHello (see `is_firefox` below).
    //  - MobileIOS: distinct Safari 18 cipher/sigalg/curves + skip Fisher-Yates
    //    extension permutation + zlib cert compression + SslOptions::NO_TICKET.
    //    Per-connection ALPS and ECH grease are also skipped — see
    //    configure_connection() below.
    let family = wire_family(profile);
    let is_safari_ios = family == WireFamily::SafariIos;
    // Firefox wire class: a desktop profile whose browser family is Firefox
    // emits an NSS-class ClientHello (no GREASE, FFDHE groups,
    // delegated_credentials + record_size_limit, fixed extension order)
    // instead of Chrome's. Without this a firefox_135_* profile put a
    // Chrome JA4 under a Firefox UA — an incoherent identity that any JA4↔UA
    // cross-check would flag.
    let is_firefox = family == WireFamily::Firefox;
    let curves: &[SslCurve] = if is_firefox {
        CURVES_FIREFOX
    } else {
        match profile.device_class {
            DeviceClass::MobileAndroid => CURVES_ANDROID,
            DeviceClass::MobileIOS => CURVES_SAFARI_IOS,
            DeviceClass::Desktop => CURVES_DESKTOP,
        }
    };
    let cipher_list: &str = if is_safari_ios {
        CIPHER_LIST_SAFARI_IOS
    } else if is_firefox {
        CIPHER_LIST_FIREFOX
    } else {
        CIPHER_LIST
    };
    let sigalgs_list: &str = if is_safari_ios {
        SIGALGS_LIST_SAFARI_IOS
    } else if is_firefox {
        SIGALGS_LIST_FIREFOX
    } else {
        SIGALGS_LIST
    };
    let mut builder =
        SslConnector::builder(SslMethod::tls()).map_err(|e| NetError::Tls(e.to_string()))?;

    // Cipher suites (per device_class)
    builder
        .set_cipher_list(cipher_list)
        .map_err(|e| NetError::Tls(e.to_string()))?;

    // Elliptic curves (per device_class)
    builder
        .set_curves(curves)
        .map_err(|e| NetError::Tls(e.to_string()))?;

    // Signature algorithms (per device_class)
    builder
        .set_sigalgs_list(sigalgs_list)
        .map_err(|e| NetError::Tls(e.to_string()))?;

    // ALPN
    builder
        .set_alpn_protos(ALPN_PROTOS)
        .map_err(|e| NetError::Tls(e.to_string()))?;

    // TLS version range. Safari iOS 18.x advertises 4 versions (1.0, 1.1,
    // 1.2, 1.3) in supported_versions per reference Safari iOS captures —
    // visible as a length-difference on the extension. Servers still
    // negotiate 1.3 because no real server speaks 1.0/1.1 anymore, but the
    // ClientHello must advertise all four to fingerprint as Safari.
    let min_version = if is_safari_ios {
        SslVersion::TLS1
    } else {
        SslVersion::TLS1_2
    };
    builder
        .set_min_proto_version(Some(min_version))
        .map_err(|e| NetError::Tls(e.to_string()))?;
    builder
        .set_max_proto_version(Some(SslVersion::TLS1_3))
        .map_err(|e| NetError::Tls(e.to_string()))?;

    // GREASE: Chrome sprinkles GREASE across cipher/group/extension lists;
    // NSS-class Firefox sends NONE. The visible no-GREASE shape is itself a
    // Firefox tell, so disable it for the Firefox arm.
    builder.set_grease_enabled(!is_firefox);

    builder.set_permute_extensions(false);

    builder.enable_ocsp_stapling();
    builder.enable_signed_cert_timestamps();

    // Chrome 131+ and Firefox 132+ both send two key shares
    // (X25519MLKEM768 + X25519).
    builder.set_key_shares_limit(2);

    // Firefox-only extensions: delegated_credentials (0x22) and
    // record_size_limit (0x1c). Both are hard Firefox/NSS signatures absent
    // from every Chrome build. boring2 4.15 exposes them as builder methods.
    if is_firefox {
        builder
            .set_delegated_credentials(FIREFOX_DELEGATED_CREDENTIALS)
            .map_err(|e| NetError::Tls(e.to_string()))?;
        builder.set_record_size_limit(FIREFOX_RECORD_SIZE_LIMIT);
    }

    // Certificate compression. Chrome desktop+Android = Brotli (algo 2).
    // iOS Safari = Zlib (algo 1). Firefox 135 advertises zlib THEN brotli in
    // its compress_certificate ext (NSS order).
    if is_firefox {
        builder
            .add_cert_compression_alg(CertCompressionAlgorithm::Zlib)
            .map_err(|e| NetError::Tls(e.to_string()))?;
        builder
            .add_cert_compression_alg(CertCompressionAlgorithm::Brotli)
            .map_err(|e| NetError::Tls(e.to_string()))?;
    } else {
        let cert_compress_alg = if is_safari_ios {
            CertCompressionAlgorithm::Zlib
        } else {
            CertCompressionAlgorithm::Brotli
        };
        builder
            .add_cert_compression_alg(cert_compress_alg)
            .map_err(|e| NetError::Tls(e.to_string()))?;
    }

    // iOS Safari does not send the session_ticket extension at all.
    // SslOptions::NO_TICKET tells BoringSSL to omit the extension entirely
    // (vs sending it with a stale ticket).
    if is_safari_ios {
        builder.set_options(SslOptions::NO_TICKET);
    }

    // Load Mozilla root certificates into the certificate store
    let mut cert_store = X509StoreBuilder::new().map_err(|e| NetError::Tls(e.to_string()))?;
    for cert_der in webpki_root_certs::TLS_SERVER_ROOT_CERTS {
        let x509 = X509::from_der(cert_der.as_ref())
            .map_err(|e| NetError::Tls(format!("failed to parse root cert: {e}")))?;
        let _ = cert_store.add_cert(x509);
    }
    builder.set_cert_store(cert_store.build());

    let connector = builder.build();

    // Extension order:
    //  - Chrome: per-handshake Fisher-Yates shuffle of all 16 desktop extensions
    //  - Safari iOS: FIXED order (same every handshake) — Phase D
    //    upgrade. Set Safari's specific 13-extension order via the same
    //    permutation API. PADDING positional ordering still requires raw
    //    extension injection (deferred); BoringSSL auto-emits PADDING when
    //    ClientHello length crosses ~512 bytes, which our Safari profile
    //    typically does.
    let permutation = if is_safari_ios {
        SAFARI_IOS_EXTENSION_PERMUTATION.to_vec()
    } else if is_firefox {
        // Firefox/NSS emits a FIXED extension order every handshake (no
        // Fisher-Yates), like Safari — use the Firefox order verbatim.
        FIREFOX_EXTENSION_PERMUTATION.to_vec()
    } else {
        shuffled_chrome_extension_permutation()
    };
    // SAFETY: BoringSSL's `SSL_CTX_set_extension_permutation` reads
    // `len` consecutive `uint8_t` from `ptr` and copies them into the
    // SSL_CTX. `permutation` is a contiguous `Vec<u8>` that lives
    // for the duration of this call; `permutation.as_ptr()` and
    // `permutation.len()` are an exact, in-bounds, non-null
    // pair. `connector.context()` is a live `SslContext` we just
    // built — its `as_ptr()` returns a non-null pointer valid for
    // the call. No aliasing concern: BoringSSL only reads the
    // permutation buffer.
    unsafe {
        boring_sys2::SSL_CTX_set_extension_permutation(
            connector.context().as_ptr(),
            permutation.as_ptr(),
            permutation.len(),
        );
    }

    if family == WireFamily::ChromeDesktop {
        let ctx = connector.context().as_ptr();
        // SAFETY: `ctx` is the live SSL_CTX of the connector built above and is
        // not yet shared with any connection. Both setters read `len` elements
        // from a `'static` slice and copy them into the SSL_CTX; nothing is
        // retained or written through the pointers.
        let ok = unsafe {
            boring_sys2::SSL_CTX_set_grease_sigalgs_enabled(ctx, 1);
            boring_sys2::SSL_CTX_set_advertised_extra_sigalgs(
                ctx,
                CHROME_DESKTOP_ADVERTISED_EXTRA_SIGALGS.as_ptr(),
                CHROME_DESKTOP_ADVERTISED_EXTRA_SIGALGS.len(),
            ) == 1
                && boring_sys2::SSL_CTX_set1_requested_trust_anchors(
                    ctx,
                    CHROME_DESKTOP_TRUST_ANCHOR_IDS.as_ptr(),
                    CHROME_DESKTOP_TRUST_ANCHOR_IDS.len(),
                ) == 1
        };
        if !ok {
            return Err(NetError::Tls(
                "failed to configure Chrome desktop signature algorithms / trust anchors".into(),
            ));
        }
    }

    Ok(connector)
}

/// Configure a per-connection TLS session with ALPS, ECH GREASE, and SNI.
/// Per-wire-family branching:
///  - Desktop / Android: ECH grease + ALPS HTTP/2 SETTINGS payload
///  - MobileIOS: skip BOTH (Safari has neither)
pub fn configure_connection(
    connector: &SslConnector,
    profile: &StealthProfile,
    domain: &str,
) -> Result<ConnectConfiguration, NetError> {
    let mut config = connector
        .configure()
        .map_err(|e| NetError::Tls(e.to_string()))?;

    let family = wire_family(profile);
    let is_safari_ios = family == WireFamily::SafariIos;
    let is_firefox = family == WireFamily::Firefox;

    if !is_safari_ios {
        // ECH GREASE — Chrome desktop+Android AND Firefox all send it.
        // Safari does not.
        config.set_enable_ech_grease(true);
    }

    if !is_safari_ios && !is_firefox {
        // Application-layer settings (ALPS) for HTTP/2: the same four
        // SETTINGS (1, 2, 4, 6) Chrome's HTTP/2 preface sends — see h2_client.
        // Safari has no ALPS extension at all — skip entirely on iOS.
        // Firefox has no ALPS extension either — skip for the Firefox arm.
        let alps_payload: &[u8] = &[
            // SETTINGS frame (Length 24, Type 4, Flags 0, Stream 0)
            0x00, 0x00, 0x18, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, // ID 1: 65536
            0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // ID 2: 0
            0x00, 0x02, 0x00, 0x00, 0x00, 0x00, // ID 4: 6291456
            0x00, 0x04, 0x00, 0x60, 0x00, 0x00, // ID 6: 262144
            0x00, 0x06, 0x00, 0x04, 0x00, 0x00,
            // Empty ACCEPT_CH frame (Length 0, Type 0x89, Flags 0, Stream 0)
            0x00, 0x00, 0x00, 0x89, 0x00, 0x00, 0x00, 0x00, 0x00,
        ];

        // SAFETY: BoringSSL's `SSL_add_application_settings` reads the
        // ALPN name (`b"h2"`, length 2) and the ALPS payload buffer
        // (`alps_payload` — a contiguous static slice we built above);
        // both are valid, contiguous, non-null, and live for the
        // entire call. `config.as_ptr()` returns a non-null pointer
        // to the live `SslContext` we own here. BoringSSL only reads
        // these buffers; it copies the data into the SSL_CTX, no
        // ownership transfer.
        unsafe {
            if boring_sys2::SSL_add_application_settings(
                config.as_ptr(),
                b"h2".as_ptr(),
                2,
                alps_payload.as_ptr(),
                alps_payload.len(),
            ) != 1
            {
                return Err(NetError::Tls("failed to add ALPS settings".into()));
            }
        }
        config.set_alps_use_new_codepoint(true);
    }

    // SNI is the same for all profiles.
    let sni_domain = domain.trim_start_matches('[').trim_end_matches(']');
    if sni_domain.parse::<std::net::IpAddr>().is_ok() {
        config.set_use_server_name_indication(false);
    } else {
        config
            .set_hostname(sni_domain)
            .map_err(|e| NetError::Tls(e.to_string()))?;
    }

    Ok(config)
}

/// Establish a TLS connection to `domain` using the provided `SslConnector`.
pub async fn connect_tls(
    connector: &SslConnector,
    profile: &StealthProfile,
    domain: &str,
    stream: TcpStream,
) -> Result<SslStream<TcpStream>, NetError> {
    let config = configure_connection(connector, profile, domain)?;
    let sni_domain = domain.trim_start_matches('[').trim_end_matches(']');

    tokio_boring2::connect(config, sni_domain, stream)
        .await
        .map_err(|e| NetError::Tls(format!("TLS handshake failed: {e}")))
}

/// Returns the negotiated ALPN protocol from a TLS stream, if any.
pub fn negotiated_alpn(stream: &SslStream<TcpStream>) -> Option<&[u8]> {
    stream.ssl().selected_alpn_protocol()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Self-verifying JA4 drift guard + UA/TLS coherence assert.
    /// Network-free.
    ///
    /// Pins every JA4 input (cipher list, sigalg list, supported-groups
    /// order, extension count) byte-/element-exact to the verified-real
    /// Chrome reference so the fingerprint can never silently drift
    /// again (any edit to
    /// the constants fails this test loudly), and machine-checks that
    /// the deliberate UA=148 / TLS-ref=147 split is the documented,
    /// wire-coherent one (see [`TLS_CHROME_MAJOR`] docs).
    /// What a ClientHello says, GREASE values removed. Extension *types* are
    /// kept as a sorted set: Chrome permutes their order per connection.
    #[derive(Debug, Default)]
    struct HelloSummary {
        ciphers: Vec<u16>,
        extensions: Vec<u16>,
        groups: Vec<u16>,
        key_shares: Vec<u16>,
        sigalgs: Vec<u16>,
        bodies: std::collections::HashMap<u16, Vec<u8>>,
    }

    fn is_grease(v: u16) -> bool {
        v & 0x0f0f == 0x0a0a
    }

    fn parse_client_hello(record: &[u8]) -> HelloSummary {
        let u16_at = |b: &[u8], i: usize| u16::from_be_bytes([b[i], b[i + 1]]);
        let list = |b: &[u8]| -> Vec<u16> {
            let n = usize::from(u16_at(b, 0));
            (0..n / 2)
                .map(|i| u16_at(b, 2 + 2 * i))
                .filter(|v| !is_grease(*v))
                .collect()
        };
        let mut out = HelloSummary::default();
        // record header (5) + handshake header (4) + version (2) + random (32)
        let mut p = 5 + 4 + 2 + 32;
        p += 1 + usize::from(record[p]);
        let cl = usize::from(u16_at(record, p));
        out.ciphers = list(&record[p..p + 2 + cl]);
        p += 2 + cl;
        p += 1 + usize::from(record[p]);
        let end = p + 2 + usize::from(u16_at(record, p));
        p += 2;
        while p < end {
            let (ty, len) = (u16_at(record, p), usize::from(u16_at(record, p + 2)));
            let body = record[p + 4..p + 4 + len].to_vec();
            p += 4 + len;
            if is_grease(ty) {
                continue;
            }
            match ty {
                10 => out.groups = list(&body),
                13 => out.sigalgs = list(&body),
                51 => {
                    let mut q = 2;
                    while q < body.len() {
                        let group = u16_at(&body, q);
                        if !is_grease(group) {
                            out.key_shares.push(group);
                        }
                        q += 4 + usize::from(u16_at(&body, q + 2));
                    }
                }
                _ => {}
            }
            out.extensions.push(ty);
            out.bodies.insert(ty, body);
        }
        out.extensions.sort_unstable();
        out
    }

    /// Our desktop ClientHello against a Chrome 153.0.8010.48 capture
    /// (`tests/fixtures/chrome153/network_capture.json`, taken on loopback with
    /// the capture script next to it). Network-free: the hello goes to a local
    /// listener that never answers.
    ///
    /// The capture is taken with `--disable-field-trial-config`. Without it,
    /// Chrome for Testing applies its built-in field-trial testing config, which
    /// among other things turns on BoringSSL's server-padding experiment
    /// (extension 4832) — not what a Chrome install with default features sends.
    #[tokio::test]
    async fn desktop_client_hello_matches_the_chrome_153_capture() {
        use tokio::io::AsyncReadExt;
        use tokio::net::{TcpListener, TcpStream};

        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/chrome153/network_capture.json"
        ))
        .expect("fixture");
        let tls = &fixture["tls"];
        let nums = |key: &str| -> Vec<u16> {
            tls[key]
                .as_array()
                .expect(key)
                .iter()
                .map(|v| v.as_u64().expect("number") as u16)
                .collect()
        };
        let hex = |key: &str| tls[key].as_str().expect(key).to_string();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut header = [0u8; 5];
            stream.read_exact(&mut header).await.unwrap();
            let len = usize::from(u16::from_be_bytes([header[3], header[4]]));
            let mut body = vec![0u8; len];
            stream.read_exact(&mut body).await.unwrap();
            [header.to_vec(), body].concat()
        });
        let profile = crate::stealth::presets::chrome_148_windows();
        let connector = chrome_connector(&profile).expect("connector");
        let tcp = TcpStream::connect(addr).await.unwrap();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            connect_tls(&connector, &profile, "test.example", tcp),
        )
        .await;
        let record = tokio::time::timeout(std::time::Duration::from_secs(3), server)
            .await
            .expect("server timeout")
            .expect("server task");
        let ours = parse_client_hello(&record);

        assert_eq!(ours.ciphers, nums("cipher_suites"), "cipher suites");
        assert_eq!(ours.groups, nums("supported_groups"), "supported groups");
        assert_eq!(ours.key_shares, nums("key_share_groups"), "key shares");
        assert_eq!(
            ours.sigalgs,
            nums("signature_algorithms"),
            "signature algorithms"
        );
        let body_hex = |ty: u16| {
            ours.bodies
                .get(&ty)
                .map(|b| b.iter().map(|x| format!("{x:02x}")).collect::<String>())
                .unwrap_or_default()
        };
        assert_eq!(body_hex(16), hex("alpn"), "ALPN");
        assert_eq!(body_hex(17613), hex("alps_17613"), "ALPS");
        assert_eq!(
            body_hex(27),
            hex("cert_compression"),
            "certificate compression"
        );
        assert_eq!(body_hex(45), hex("psk_modes"), "PSK modes");
        assert_eq!(body_hex(5), hex("status_request"), "status_request");

        let chrome = nums("extensions");
        let missing: Vec<u16> = chrome
            .iter()
            .copied()
            .filter(|t| !ours.extensions.contains(t))
            .collect();
        let extra: Vec<u16> = ours
            .extensions
            .iter()
            .copied()
            .filter(|t| !chrome.contains(t))
            .collect();
        assert_eq!(
            extra,
            Vec::<u16>::new(),
            "extensions Chrome 153 does not send"
        );
        assert_eq!(
            missing,
            Vec::<u16>::new(),
            "extensions Chrome 153 sends and we do not"
        );
    }

    /// A version newer than every capture gets the newest one; older than
    /// every capture, the oldest. Either way a real handshake, never an
    /// invented one.
    #[test]
    fn the_stack_is_chosen_by_version_within_the_family() {
        let mut profile = crate::stealth::presets::chrome_148_windows();
        profile.browser_version = "400.0.1.2".into();
        assert_eq!(expected_impersonate(&profile), "chrome_153");
        profile.browser_version = "100.0.0.0".into();
        assert_eq!(expected_impersonate(&profile), "chrome_153");
        profile.browser_version = "garbage".into();
        assert_eq!(expected_impersonate(&profile), "chrome_153");
    }

    /// Firefox must not be handed the Chromium stack, nor the reverse; and
    /// every browser on iOS runs on WebKit's network stack.
    #[test]
    fn the_browser_family_selects_the_stack_family() {
        use crate::stealth::presets;
        assert_eq!(
            expected_impersonate(&presets::firefox_135_macos()),
            "firefox_135"
        );
        assert_eq!(
            expected_impersonate(&presets::chrome_148_macos()),
            "chrome_153"
        );
        assert_eq!(
            expected_impersonate(&presets::pixel_9_pro_chrome_148()),
            "chrome_147_android"
        );
        assert_eq!(
            expected_impersonate(&presets::iphone_15_pro_safari_18()),
            "safari_18_ios"
        );
        let mut firefox_ios = presets::iphone_15_pro_safari_18();
        firefox_ios.browser_name = "Firefox".into();
        assert_eq!(wire_family(&firefox_ios), WireFamily::SafariIos);
    }

    /// `expected_impersonate` relies on every family having a stack, and each
    /// stack's full version has to name its own major.
    #[test]
    fn the_stack_table_is_complete_and_consistent() {
        for family in [
            WireFamily::ChromeDesktop,
            WireFamily::ChromeAndroid,
            WireFamily::SafariIos,
            WireFamily::Firefox,
        ] {
            assert!(
                STACKS.iter().any(|stack| stack.family == family),
                "{family:?} has no stack"
            );
        }
        for stack in STACKS {
            assert_eq!(
                stack.version.split('.').next(),
                Some(stack.major.to_string().as_str()),
                "{}",
                stack.name
            );
        }
    }

    #[test]
    fn tls_fingerprint_vectors_no_silent_drift() {
        // --- JA4 input 1: cipher suites (order is JA4-significant) ---
        const EXPECT_CIPHERS: &str = "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:\
TLS_CHACHA20_POLY1305_SHA256:TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256:\
TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256:TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384:\
TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384:TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256:\
TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256:TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA:\
TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA:TLS_RSA_WITH_AES_128_GCM_SHA256:\
TLS_RSA_WITH_AES_256_GCM_SHA384:TLS_RSA_WITH_AES_128_CBC_SHA:\
TLS_RSA_WITH_AES_256_CBC_SHA";
        assert_eq!(
            CIPHER_LIST, EXPECT_CIPHERS,
            "Chrome cipher list drifted from the verified-real reference \
             — JA4 cipher hash would change"
        );

        // --- JA4 input 2: signature algorithms (order is JA4-significant) ---
        const EXPECT_SIGALGS: &str = "ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:\
rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:\
rsa_pss_rsae_sha512:rsa_pkcs1_sha512";
        assert_eq!(
            SIGALGS_LIST, EXPECT_SIGALGS,
            "Chrome sigalg list drifted — JA4 sigalg hash would change"
        );

        // --- JA4 input 3: supported groups / curves order ---
        assert_eq!(
            CURVES_DESKTOP,
            &[
                SslCurve::X25519_MLKEM768,
                SslCurve::X25519,
                SslCurve::SECP256R1,
                SslCurve::SECP384R1,
            ],
            "Chrome desktop curve order drifted (post-quantum MLKEM768 \
             must lead) — JA4 supported_groups would change"
        );

        // --- JA4 input 4: extension count (17 — JA4 `c` digit) ---
        assert_eq!(
            CHROME_EXTENSION_PERMUTATION.len(),
            17,
            "Chrome extension count drifted — JA4 extension-count digit \
             would change"
        );

        assert_eq!(
            CHROME_DESKTOP_ADVERTISED_EXTRA_SIGALGS,
            &[0x0904, 0x0905, 0x0906],
            "Chrome ML-DSA sigalgs drifted — JA4 sigalg hash would change"
        );
        assert_eq!(CHROME_DESKTOP_TRUST_ANCHOR_IDS.len(), 204);

        assert_eq!(TLS_CHROME_MAJOR, 153);
        assert_eq!(UA_CHROME_MAJOR, 153);

        fn ua_chrome_major(ua: &str) -> Option<u32> {
            let i = ua.find("Chrome/")? + "Chrome/".len();
            ua[i..].split('.').next()?.parse().ok()
        }

        for profile in [
            crate::stealth::presets::chrome_148_macos(),
            crate::stealth::presets::chrome_148_windows(),
        ] {
            assert_eq!(
                ua_chrome_major(&profile.user_agent),
                Some(UA_CHROME_MAJOR),
                "desktop Chrome preset UA major must equal UA_CHROME_MAJOR \
                 (the coherence single-source-of-truth); UA was {:?}",
                profile.user_agent
            );
            assert_eq!(
                profile.tls_impersonate, "chrome_153",
                "desktop Chrome preset TLS profile must be the verified-real \
                 chrome_153 reference (wire-equivalent to Chrome \
                 {UA_CHROME_MAJOR}); see TLS_CHROME_MAJOR docs"
            );
        }
    }

    /// Capture the first 5 bytes of our outbound ClientHello (the TLS
    /// record header) and assert the record version is 0x0301 (TLS 1.0).
    /// Source-code analysis of `boringssl/src/ssl/ssl_aead_ctx.cc:168-173`
    /// confirms `RecordVersion()` returns `TLS1_VERSION` (0x0301) for the
    /// initial ClientHello (null cipher, version_ == 0). This test verifies
    /// it empirically — a BoringSSL source patch for the TLS 1.0 record
    /// version is **NOT NEEDED**.
    #[tokio::test]
    async fn safari_ios_emits_tls_1_0_record_version() {
        use tokio::io::AsyncReadExt;
        use tokio::net::{TcpListener, TcpStream};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        // Background server that just reads the first 5 bytes and reports.
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 5];
            tokio::time::timeout(
                std::time::Duration::from_secs(3),
                stream.read_exact(&mut buf),
            )
            .await
            .unwrap()
            .unwrap();
            buf
        });

        // Connect with iOS Safari profile.
        let profile = crate::stealth::presets::iphone_15_pro_safari_18();
        let connector = chrome_connector(&profile).expect("connector");
        let tcp = TcpStream::connect(addr).await.unwrap();
        // We expect the handshake to fail (server doesn't respond), but the
        // ClientHello is sent before that. Race the timeout against the
        // server's read.
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            connect_tls(&connector, &profile, "localhost", tcp),
        )
        .await;

        let bytes = tokio::time::timeout(std::time::Duration::from_secs(2), server)
            .await
            .expect("server timeout")
            .expect("server task");

        let content_type = bytes[0];
        let record_version = ((bytes[1] as u16) << 8) | (bytes[2] as u16);

        // Content type 22 = TLS handshake
        assert_eq!(
            content_type, 22,
            "expected TLS handshake (22), got {content_type}"
        );

        // Record version: real Safari sends 0x0301 (TLS 1.0); BoringSSL
        // emits the same for null-cipher (initial ClientHello).
        assert_eq!(
            record_version, 0x0301,
            "iOS Safari record version: got 0x{record_version:04x}, expected 0x0301 (TLS 1.0). \
             If this is 0x0303 then a BoringSSL source patch IS needed; if 0x0301 then \
             our current build already matches Safari."
        );
    }

    /// Same record-version check for desktop Chrome profile. Real Chrome
    /// also sends 0x0301 (TLS 1.0) record version for the initial ClientHello
    /// — TLS-version selection happens in the inner extension, not the outer
    /// record header. This test confirms the BoringSSL behavior is uniform
    /// across desktop and Safari profiles.
    #[tokio::test]
    async fn desktop_chrome_emits_tls_1_0_record_version() {
        use tokio::io::AsyncReadExt;
        use tokio::net::{TcpListener, TcpStream};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 5];
            tokio::time::timeout(
                std::time::Duration::from_secs(3),
                stream.read_exact(&mut buf),
            )
            .await
            .unwrap()
            .unwrap();
            buf
        });

        let profile = crate::stealth::presets::chrome_148_macos();
        let connector = chrome_connector(&profile).expect("connector");
        let tcp = TcpStream::connect(addr).await.unwrap();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            connect_tls(&connector, &profile, "localhost", tcp),
        )
        .await;

        let bytes = tokio::time::timeout(std::time::Duration::from_secs(2), server)
            .await
            .expect("server timeout")
            .expect("server task");

        let record_version = ((bytes[1] as u16) << 8) | (bytes[2] as u16);
        assert_eq!(
            record_version, 0x0301,
            "Chrome desktop record version: got 0x{record_version:04x}, expected 0x0301."
        );
    }

    #[test]
    fn test_shuffle_is_full_fisher_yates() {
        // Real Chrome shuffles all 17 extensions uniformly (no buckets).
        // Verify the shuffle preserves the full set + is non-deterministic.
        let p1 = shuffled_chrome_extension_permutation();
        let p2 = shuffled_chrome_extension_permutation();

        assert_eq!(p1.len(), 17);
        assert_eq!(p2.len(), 17);

        let mut sorted = p1.clone();
        sorted.sort();
        let mut expected = CHROME_EXTENSION_PERMUTATION.to_vec();
        expected.sort();
        assert_eq!(sorted, expected, "shuffle must preserve the set");

        // Probabilistically should differ run-to-run.
        assert_ne!(p1, p2, "Shuffle should be non-deterministic");
    }
}
