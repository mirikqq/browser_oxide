//! HTTP/2 client reproducing the browser's SETTINGS fingerprint — Chrome's,
//! Firefox's or iOS Safari's, following the profile's wire family (the same
//! decision `tls::expected_impersonate` names).
//!
//! Uses the `http2` crate (a fork of h2) which supports custom
//! SETTINGS order, pseudo-header order, and stream priority — all
//! required to match Chrome's HTTP/2 fingerprint.
//!
//! The Chrome values were first verified against a Chrome 147 capture and
//! re-verified on the wire against Chrome 153.0.8010.48
//! (`tests/fixtures/chrome153/network_capture.json`, checked by
//! `chrome_preface_matches_the_chrome_153_capture`):
//! ```text
//! akamai_fingerprint: "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p"
//! priority: { weight: 256, depends_on: 0, exclusive: 1 }
//! ```

use crate::stealth::StealthProfile;
use bytes::Bytes;
use http2::client::{Builder, Connection, SendRequest};
use http2::frame::{PseudoId, PseudoOrder, SettingId, SettingsOrder, StreamDependency, StreamId};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::net::error::NetError;

/// Chrome HTTP/2 SETTINGS values.
///
/// **Verified against Chrome 147 and Chrome 153.0.8010.48 captures** (see the
/// module docs):
/// ```text
/// 1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p
/// ```
/// Only four settings — Chrome does NOT send `3 MAX_CONCURRENT_STREAMS`
/// or `5 MAX_FRAME_SIZE` on its client SETTINGS frame. Those defaults
/// are negotiated from the server side.
///
/// An earlier version incorrectly added both of those based on
/// an out-of-date reference; that made the HTTP/2 SETTINGS
/// fingerprint hash `d23e6399a1d185e3b8cb58e5640dd698`, diverging from
/// Chrome's actual hash `52d84b11737d980aef856699f885ca86`. The
/// reference capture corrected it.
const HEADER_TABLE_SIZE: u32 = 65_536; // SETTINGS 1
const ENABLE_PUSH: bool = false; // SETTINGS 2 = 0
const INITIAL_STREAM_WINDOW_SIZE: u32 = 6_291_456; // SETTINGS 4 = 6 MB
const MAX_HEADER_LIST_SIZE: u32 = 262_144; // SETTINGS 6 = 256 KB
                                           // `initial_connection_window_size` is the lib's CONFIGURED target — the
                                           // http2 lib sends a WINDOW_UPDATE of (target - 65535) on the wire to
                                           // raise the connection window from the protocol default (65535) up to
                                           // the configured value. So 15_728_640 here → 15_663_105 on the wire,
                                           // which is what the Chrome 147 and 153 captures show. Verified against wreq-util's
                                           // chrome profile (the gold-standard Rust impl,
                                           // `0x676e67/wreq-util/src/emulate/profile/chrome/http2.rs`).
const INITIAL_CONNECTION_WINDOW_SIZE: u32 = 15_728_640; // → wire 15_663_105 = Chrome match

// =============================================================================
// Safari iOS 18.4 HTTP/2 SETTINGS
// =============================================================================
//
// Per reference Safari iOS 18.4 captures. iOS 18.4 sends 4 SETTINGS:
//   2 ENABLE_PUSH = 0
//   3 MAX_CONCURRENT_STREAMS = 100
//   4 INITIAL_WINDOW_SIZE = 2097152 (2 MB, vs Chrome's 6 MB)
//   9 NO_RFC7540_PRIORITIES = 1
// (iOS 18.0 also sent 8 ENABLE_CONNECT_PROTOCOL = 1, dropped in 18.4.)
//
// INITIAL_CONNECTION_WINDOW_SIZE: configured target. The http2 lib sends a
// WINDOW_UPDATE of (target - 65535) on the wire. Safari emits 10420225 →
// configured target = 10485760 (10 MB).
const SAFARI_IOS_INITIAL_STREAM_WINDOW_SIZE: u32 = 2_097_152; // 2 MB
const SAFARI_IOS_MAX_CONCURRENT_STREAMS: u32 = 100;
const SAFARI_IOS_INITIAL_CONNECTION_WINDOW_SIZE: u32 = 10_485_760; // → wire 10_420_225

// =============================================================================
// Firefox 135 HTTP/2 SETTINGS — Firefox wire class
// =============================================================================
//
// Canonical Firefox H2 fingerprint
// (`1:65536;4:131072;5:16384|12517377|...|m,p,a,s`). Firefox sends only THREE
// settings: 1 HEADER_TABLE_SIZE=65536, 4 INITIAL_WINDOW_SIZE=131072 (128 KiB,
// vs Chrome's 6 MB), 5 MAX_FRAME_SIZE=16384. No ENABLE_PUSH, no
// MAX_HEADER_LIST_SIZE on the wire, no MAX_CONCURRENT_STREAMS. Pseudo-header
// order is m,p,a,s. Connection-window wire delta 12517377 → target 12582912.
const FIREFOX_INITIAL_STREAM_WINDOW_SIZE: u32 = 131_072; // 128 KiB
const FIREFOX_MAX_FRAME_SIZE: u32 = 16_384;
const FIREFOX_INITIAL_CONNECTION_WINDOW_SIZE: u32 = 12_582_912; // → wire 12_517_377

/// Perform an HTTP/2 handshake over a TLS stream and return a sender + connection.
///
/// The connection must be driven by spawning it onto a tokio task.
/// The sender is used to send requests. Per `profile.device_class`:
///  - Chrome desktop / Android: Chrome SETTINGS (1,2,4,6) + masp pseudo-header order
///    + 6 MB stream window + 15663105 wire connection-window
///  - MobileIOS: Safari 18.4 SETTINGS (2,3,4,9) + msap pseudo-header order
///    + 2 MB stream window + 10420225 wire connection-window
pub async fn handshake<T>(
    io: T,
    profile: &StealthProfile,
) -> Result<(SendRequest<Bytes>, Connection<T, Bytes>), NetError>
where
    T: AsyncRead + AsyncWrite + Unpin,
{
    // The TLS stack's decision, so the HTTP/2 preface always belongs to the
    // same browser as the ClientHello before it.
    let family = crate::net::tls::wire_family(profile);
    let is_safari_ios = family == crate::net::tls::WireFamily::SafariIos;
    let is_firefox = family == crate::net::tls::WireFamily::Firefox;

    // Pseudo-header order:
    //   Chrome  (masp) = :method, :authority, :scheme, :path
    //   Safari  (msap) = :method, :scheme, :authority, :path
    //   Firefox (mpas) = :method, :path, :authority, :scheme
    let pseudo_order = if is_safari_ios {
        PseudoOrder::builder()
            .push(PseudoId::Method)
            .push(PseudoId::Scheme)
            .push(PseudoId::Authority)
            .push(PseudoId::Path)
            .build()
    } else if is_firefox {
        PseudoOrder::builder()
            .push(PseudoId::Method)
            .push(PseudoId::Path)
            .push(PseudoId::Authority)
            .push(PseudoId::Scheme)
            .build()
    } else {
        PseudoOrder::builder()
            .push(PseudoId::Method)
            .push(PseudoId::Authority)
            .push(PseudoId::Scheme)
            .push(PseudoId::Path)
            .build()
    };

    // SETTINGS order on the wire. Chrome's 8-entry order (covers all the
    // settings Chrome MIGHT emit even if only 4 carry values). Safari sends
    // a different 4-setting subset in a different order; we declare just
    // those 4 in their on-wire order.
    let settings_order = if is_safari_ios {
        // Safari iOS 18.4 wire order: 2, 3, 4, 9
        SettingsOrder::builder()
            .push(SettingId::EnablePush)
            .push(SettingId::MaxConcurrentStreams)
            .push(SettingId::InitialWindowSize)
            .push(SettingId::NoRfc7540Priorities)
            .build()
    } else if is_firefox {
        // Firefox 135 wire order: 1, 4, 5 (only three settings)
        SettingsOrder::builder()
            .push(SettingId::HeaderTableSize)
            .push(SettingId::InitialWindowSize)
            .push(SettingId::MaxFrameSize)
            .build()
    } else {
        // Chrome 130+ canonical 8-entry order — wreq-util reference impl.
        SettingsOrder::builder()
            .push(SettingId::HeaderTableSize)
            .push(SettingId::EnablePush)
            .push(SettingId::MaxConcurrentStreams)
            .push(SettingId::InitialWindowSize)
            .push(SettingId::MaxFrameSize)
            .push(SettingId::MaxHeaderListSize)
            .push(SettingId::EnableConnectProtocol)
            .push(SettingId::NoRfc7540Priorities)
            .build()
    };

    let mut builder = Builder::new();
    if is_safari_ios {
        // Safari 18.4 advertises 4 SETTINGS on the wire (2, 3, 4, 9) — see
        // SETTINGS order above. The http2 builder accepts additional setting
        // VALUES that aren't in the wire order; those are used for internal
        // validation (e.g. capacity checks against frames the server might
        // send) without appearing on the wire.
        //
        // Some servers return RST_STREAM INTERNAL_ERROR if
        // MAX_HEADER_LIST_SIZE isn't set on the connection — the server
        // can't validate response headers without a limit. Adding
        // max_header_list_size with Chrome's 256KB default (matches what real
        // Safari uses internally even though it doesn't advertise the setting).
        builder
            .enable_push(ENABLE_PUSH)
            .max_concurrent_streams(SAFARI_IOS_MAX_CONCURRENT_STREAMS)
            .initial_window_size(SAFARI_IOS_INITIAL_STREAM_WINDOW_SIZE)
            .max_header_list_size(MAX_HEADER_LIST_SIZE)
            .initial_connection_window_size(SAFARI_IOS_INITIAL_CONNECTION_WINDOW_SIZE)
            .headers_pseudo_order(pseudo_order)
            .settings_order(settings_order);
        // Safari does NOT send a stream-priority frame (`headers_stream_dependency`
        // is the lib's HEADERS-frame priority hint — Chrome sends weight 255,
        // exclusive=true; Safari has NO_RFC7540_PRIORITIES so it omits priority).
        // Skipping the headers_stream_dependency call entirely.
    } else if is_firefox {
        // Firefox 135: 3 SETTINGS (1,4,5), 128 KiB stream window, m,p,a,s
        // pseudo-order. MAX_FRAME_SIZE=16384 (HTTP/2 default) is advertised.
        // max_header_list_size is set for internal validation (some servers
        // RST without a limit) but kept OUT of settings_order so it doesn't
        // appear on the wire — same trick the Safari arm uses.
        // NOTE: do NOT set max_header_list_size for Firefox — this http2
        // builder emits any set non-default value on the wire even when it's
        // absent from settings_order, and real Firefox sends ONLY settings
        // 1,4,5 (no setting 6). Including it produced a spurious `6:262144`
        // on the wire, diverging from the canonical Firefox H2 fingerprint.
        builder
            .header_table_size(HEADER_TABLE_SIZE)
            .initial_window_size(FIREFOX_INITIAL_STREAM_WINDOW_SIZE)
            .max_frame_size(FIREFOX_MAX_FRAME_SIZE)
            .initial_connection_window_size(FIREFOX_INITIAL_CONNECTION_WINDOW_SIZE)
            .headers_pseudo_order(pseudo_order)
            .settings_order(settings_order);
        // Firefox emits an RFC 7540 idle-stream PRIORITY tree, which this
        // builder's single StreamDependency hint can't express; the pragmatic
        // choice is to omit the single Chrome priority hint entirely (closer
        // to Firefox than a Chrome-weighted one).
    } else {
        builder
            .header_table_size(HEADER_TABLE_SIZE)
            .enable_push(ENABLE_PUSH)
            .initial_window_size(INITIAL_STREAM_WINDOW_SIZE)
            .max_header_list_size(MAX_HEADER_LIST_SIZE)
            .initial_connection_window_size(INITIAL_CONNECTION_WINDOW_SIZE)
            .headers_pseudo_order(pseudo_order)
            .settings_order(settings_order)
            .headers_stream_dependency(StreamDependency::new(
                StreamId::zero(),
                // Chrome sends weight 256 (wire byte 255), exclusive=true,
                // depends_on=0 — verified against a real-browser capture
                // from a TLS-fingerprint reference service.
                255,
                true,
            ));
    }

    builder
        .handshake(io)
        .await
        .map_err(|e| NetError::Http(format!("HTTP/2 handshake failed: {e}")))
}

/// Send a GET request over an HTTP/2 connection.
///
/// `headers` is an ordered list of (name, value) pairs to include.
pub async fn send_get(
    sender: &mut SendRequest<Bytes>,
    uri: &str,
    _host: &str,
    headers: &[(String, String)],
) -> Result<(http::response::Parts, Vec<u8>), NetError> {
    let mut ready_sender = sender
        .clone()
        .ready()
        .await
        .map_err(|e| NetError::Http(format!("HTTP/2 not ready: {e}")))?;

    // In HTTP/2, :authority is derived from the URI automatically.
    // Do NOT add an explicit `host` header — some servers (nginx) reject it.
    let mut request = http::Request::builder().method(http::Method::GET).uri(uri);

    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }

    let request = request
        .body(())
        .map_err(|e| NetError::Http(format!("failed to build request: {e}")))?;

    let (response, _) = ready_sender
        .send_request(request, true) // true = end of stream (no body)
        .map_err(|e| NetError::Http(format!("failed to send request: {e}")))?;

    let response = response
        .await
        .map_err(|e| NetError::Http(format!("HTTP/2 response error: {e}")))?;

    let (parts, mut body) = response.into_parts();

    // Read the response body
    let mut data = Vec::new();
    while let Some(chunk) = body.data().await {
        let chunk = chunk.map_err(|e| NetError::Http(format!("body read error: {e}")))?;
        let _ = body.flow_control().release_capacity(chunk.len());
        data.extend_from_slice(&chunk);
    }

    Ok((parts, data))
}

/// Send a POST request over an HTTP/2 connection.
pub async fn send_post(
    sender: &mut SendRequest<Bytes>,
    uri: &str,
    _host: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> Result<(http::response::Parts, Vec<u8>), NetError> {
    let mut ready_sender = sender
        .clone()
        .ready()
        .await
        .map_err(|e| NetError::Http(format!("HTTP/2 not ready: {e}")))?;

    let mut request = http::Request::builder()
        .method(http::Method::POST)
        .uri(uri)
        .header("content-length", body.len().to_string());

    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }

    let request = request
        .body(())
        .map_err(|e| NetError::Http(format!("failed to build request: {e}")))?;

    let (response, mut send_stream) = ready_sender
        .send_request(request, false) // false = body follows
        .map_err(|e| NetError::Http(format!("failed to send request: {e}")))?;

    // Send the body
    send_stream
        .send_data(Bytes::copy_from_slice(body), true)
        .map_err(|e| NetError::Http(format!("failed to send body: {e}")))?;

    let response = response
        .await
        .map_err(|e| NetError::Http(format!("HTTP/2 response error: {e}")))?;

    let (parts, mut resp_body) = response.into_parts();

    let mut data = Vec::new();
    while let Some(chunk) = resp_body.data().await {
        let chunk = chunk.map_err(|e| NetError::Http(format!("body read error: {e}")))?;
        let _ = resp_body.flow_control().release_capacity(chunk.len());
        data.extend_from_slice(&chunk);
    }

    Ok((parts, data))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The HTTP/2 preface our Chrome profile writes, against a Chrome
    /// 153.0.8010.48 capture (`tests/fixtures/chrome153/network_capture.json`):
    /// SETTINGS, the connection WINDOW_UPDATE, the HEADERS priority and the
    /// pseudo-header order. Runs over an in-memory pipe — no TLS, no network.
    #[tokio::test]
    async fn chrome_preface_matches_the_chrome_153_capture() {
        use tokio::io::AsyncReadExt;

        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/chrome153/network_capture.json"
        ))
        .expect("fixture");
        let h2 = &fixture["http2"];

        let (client, mut server) = tokio::io::duplex(64 * 1024);
        let profile = crate::stealth::presets::chrome_148_windows();
        let (mut sender, conn) = handshake(client, &profile).await.unwrap();
        tokio::spawn(conn);
        tokio::spawn(async move {
            let _ = send_get(&mut sender, "https://test.example/", "test.example", &[]).await;
        });

        let mut preface = [0u8; 24];
        server.read_exact(&mut preface).await.unwrap();
        assert_eq!(&preface, b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");

        let (mut settings, mut window_update, mut headers) = (None, None, None);
        while headers.is_none() {
            let mut head = [0u8; 9];
            server.read_exact(&mut head).await.unwrap();
            let len = usize::from(head[0]) << 16 | usize::from(head[1]) << 8 | usize::from(head[2]);
            let mut payload = vec![0u8; len];
            server.read_exact(&mut payload).await.unwrap();
            match head[3] {
                4 => {
                    settings = Some(
                        payload
                            .chunks(6)
                            .map(|c| {
                                serde_json::json!([
                                    u16::from_be_bytes([c[0], c[1]]),
                                    u32::from_be_bytes([c[2], c[3], c[4], c[5]])
                                ])
                            })
                            .collect::<Vec<_>>(),
                    )
                }
                8 => {
                    window_update = Some(
                        u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]])
                            & 0x7fff_ffff,
                    )
                }
                1 => headers = Some((head[4], payload)),
                _ => {}
            }
        }

        assert_eq!(
            serde_json::json!(settings.unwrap()),
            h2["settings"],
            "SETTINGS"
        );
        assert_eq!(
            serde_json::json!(window_update.unwrap()),
            h2["window_update"]
        );

        let (flags, block) = headers.unwrap();
        assert_ne!(flags & 0x20, 0, "HEADERS carries a priority");
        let dependency = u32::from_be_bytes([block[0], block[1], block[2], block[3]]);
        let priority = &h2["headers_priority"];
        assert_eq!(
            serde_json::json!(dependency >> 31 == 1),
            priority["exclusive"]
        );
        assert_eq!(
            serde_json::json!(dependency & 0x7fff_ffff),
            priority["depends_on"]
        );
        assert_eq!(serde_json::json!(block[4]), priority["weight_byte"]);

        // The first four HPACK representations name the pseudo-headers; all
        // reference the static table (:authority 1, :method 2-3, :path 4-5,
        // :scheme 6-7), whether fully indexed or literal-with-indexed-name.
        let mut order = Vec::new();
        let mut p = 5;
        while order.len() < 4 {
            let byte = block[p];
            let (index, literal) = if byte & 0x80 != 0 {
                (byte & 0x7f, false)
            } else if byte & 0x40 != 0 {
                (byte & 0x3f, true)
            } else {
                (byte & 0x0f, true)
            };
            p += 1;
            if literal {
                let value_len = usize::from(block[p] & 0x7f);
                p += 1 + value_len;
            }
            order.push(match index {
                1 => ":authority",
                2 | 3 => ":method",
                4 | 5 => ":path",
                6 | 7 => ":scheme",
                other => panic!("unexpected static index {other}"),
            });
        }
        assert_eq!(serde_json::json!(order), h2["pseudo_header_order"]);
    }

    #[tokio::test]
    #[ignore] // requires network
    async fn h2_get_httpbin() {
        let profile = crate::stealth::presets::chrome_148_macos();
        let connector = crate::net::tls::chrome_connector(&profile).unwrap();
        let tcp = crate::net::tcp::connect("httpbin.org", 443, std::time::Duration::from_secs(10))
            .await
            .unwrap();
        let tls = crate::net::tls::connect_tls(&connector, &profile, "httpbin.org", tcp)
            .await
            .unwrap();

        // Verify ALPN negotiated h2
        assert_eq!(
            crate::net::tls::negotiated_alpn(&tls),
            Some(b"h2".as_slice())
        );

        let (mut sender, conn) = handshake(tls, &profile).await.unwrap();
        tokio::spawn(async move {
            if let Err(e) = conn.await {
                eprintln!("H2 connection error: {e}");
            }
        });

        let (parts, body) = send_get(&mut sender, "https://httpbin.org/get", "httpbin.org", &[])
            .await
            .unwrap();

        assert_eq!(parts.status, 200);
        assert!(!body.is_empty());
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("httpbin.org"), "Response: {text}");
    }
}
