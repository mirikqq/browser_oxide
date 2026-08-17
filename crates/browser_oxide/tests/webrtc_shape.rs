//! WebRTC produces an offer and a candidate that a probe can actually read.
//!
//! Three separate gaps met here. `addEventListener`/`removeEventListener` were
//! overridden with empty stubs that shadowed the real `EventTarget` methods, so a
//! listener registered the standard way was silently dropped — and watching for
//! `icecandidate` that way is the usual form, which made every probe report the
//! transport blocked. The offer was a four-line stub with no media section, no
//! ICE credentials and no fingerprint, which no WebRTC stack emits. And
//! `RTCIceCandidate` carried only the raw string, while Chrome parses it into
//! named fields that scripts read directly.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;
use std::time::Duration;

async fn page() -> Page {
    Page::from_html("<html><body></body></html>", Some(chrome_148_macos()))
        .await
        .expect("page")
}

const OFFER: &str = r#"
(function () {
  globalThis.__rtc = { sdp: '', события: [] };
  var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun4.l.google.com:19302' }] });
  pc.addEventListener('icecandidate', function (e) {
    if (!e.candidate) { globalThis.__rtc.события.push('конец'); return; }
    var c = e.candidate;
    globalThis.__rtc.события.push([c.foundation, c.type, c.protocol, c.component,
      typeof c.port, /\.local$/.test(String(c.address))].join('|'));
  });
  pc.createDataChannel('');
  pc.createOffer({ offerToReceiveAudio: 1, offerToReceiveVideo: 1 }).then(function (o) {
    globalThis.__rtc.sdp = String(o.sdp || '');
    return pc.setLocalDescription(o);
  });
  return 'ок';
})()
"#;

async fn gather(page: &mut Page) -> String {
    page.evaluate(OFFER).expect("start webrtc");
    for _ in 0..15 {
        let _ = page
            .evaluate_async("void 0", Duration::from_millis(100))
            .await;
        let out = page
            .evaluate("JSON.stringify(globalThis.__rtc)")
            .unwrap_or_default();
        if out.contains("конец") {
            return out;
        }
    }
    page.evaluate("JSON.stringify(globalThis.__rtc)")
        .unwrap_or_default()
}

#[tokio::test(flavor = "current_thread")]
async fn the_offer_looks_like_something_a_webrtc_stack_emits() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let mut page = page().await;
            let out = gather(&mut page).await;
            for part in [
                "m=application",
                "webrtc-datachannel",
                "a=ice-ufrag:",
                "a=ice-pwd:",
                "a=fingerprint:sha-256",
                "a=setup:actpass",
                "a=sctp-port:5000",
                "a=group:BUNDLE",
            ] {
                assert!(out.contains(part), "в SDP нет `{part}`: {out}");
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_listener_added_the_standard_way_receives_the_candidate() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let mut page = page().await;
            let out = gather(&mut page).await;
            assert!(
                out.contains("конец"),
                "сбор кандидатов не завершился — слушатель не сработал: {out}"
            );
            // foundation | type | protocol | component | typeof port | mDNS address
            assert!(
                out.contains("|host|udp|rtp|number|true"),
                "поля кандидата не разобраны как в Chrome: {out}"
            );
        })
        .await;
}

/// Chrome hides the real address behind an mDNS name; a bare IP here would be a
/// privacy leak *and* a mismatch with what a browser reports.
#[tokio::test(flavor = "current_thread")]
async fn the_candidate_address_is_an_mdns_name_not_an_ip() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let mut page = page().await;
            let _ = gather(&mut page).await;
            let out = page
                .evaluate(
                    "(function(){var e=globalThis.__rtc.события[0]||'';\
                     return 'ip='+/\\|\\d+\\.\\d+\\.\\d+\\.\\d+\\|/.test(e)+' mdns='+/true$/.test(e);})()",
                )
                .expect("read address");
            assert!(
                out.contains("ip=false") && out.contains("mdns=true"),
                "адрес кандидата должен быть mDNS-именем: {out}"
            );
        })
        .await;
}
