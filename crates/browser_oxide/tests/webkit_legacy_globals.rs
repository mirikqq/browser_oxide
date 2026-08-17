//! Chrome's legacy `webkit`-prefixed globals, present and shaped as Chrome has them.
//!
//! Their absence is not a subtle statistical signal. A public detector rejected
//! this engine outright on one line — "Chrome UA but webkitRequestAnimationFrame
//! absent" — and reported the browser as tampered with because of it.
//!
//! Shapes verified against a real Chrome: the constructors are the *same object*
//! as their unprefixed form, while the two animation-frame functions are separate
//! wrappers carrying their own prefixed names. `webkitAudioContext` is absent
//! there, so it must be absent here too — a global this engine has and the
//! browser it claims to be does not is a difference in the worse direction.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

async fn page() -> Page {
    Page::from_html("<html><body></body></html>", Some(chrome_148_macos()))
        .await
        .expect("page")
}

#[tokio::test]
async fn the_legacy_globals_chrome_has_are_all_present() {
    let mut page = page().await;
    let out = page
        .evaluate(
            "(function(){var need=['webkitURL','webkitRTCPeerConnection','webkitMediaStream',\
             'WebKitMutationObserver','WebKitCSSMatrix','webkitCancelAnimationFrame',\
             'webkitRequestAnimationFrame','webkitSpeechGrammar','webkitSpeechGrammarList',\
             'webkitSpeechRecognition','webkitSpeechRecognitionError','webkitSpeechRecognitionEvent'];\
             var miss=need.filter(function(k){return typeof globalThis[k]==='undefined'});\
             return 'нет='+(miss.join(',')||'—');})()",
        )
        .expect("read globals");
    assert!(
        out.contains("нет=—"),
        "не хватает легаси-глобалов Chrome: {out}"
    );
}

#[tokio::test]
async fn webkit_audio_context_is_absent_like_in_chrome() {
    let mut page = page().await;
    let out = page
        .evaluate(
            "(function(){return 'audio='+typeof globalThis.webkitAudioContext\
             +' offline='+typeof globalThis.webkitOfflineAudioContext\
             +' базовый='+typeof globalThis.AudioContext;})()",
        )
        .expect("read audio aliases");
    assert!(
        out.contains("audio=undefined") && out.contains("offline=undefined"),
        "префиксный AudioContext снова появился — Chrome его удалил: {out}"
    );
    // The unprefixed one must stay.
    assert!(
        out.contains("базовый=function"),
        "AudioContext пропал вместе с псевдонимом: {out}"
    );
}

#[tokio::test]
async fn the_aliases_have_the_identities_chrome_gives_them() {
    let mut page = page().await;
    let out = page
        .evaluate(
            "(function(){return 'url='+(webkitURL===URL)\
             +' mo='+(WebKitMutationObserver===MutationObserver)\
             +' rtc='+(webkitRTCPeerConnection===RTCPeerConnection)\
             +' rafТотЖе='+(webkitRequestAnimationFrame===requestAnimationFrame)\
             +' rafИмя='+webkitRequestAnimationFrame.name\
             +' rafИсходник='+String(webkitRequestAnimationFrame)\
             +' rafПрототип='+('prototype' in webkitRequestAnimationFrame);})()",
        )
        .expect("read identities");
    // Constructors: the same object, not a copy.
    assert!(
        out.contains("url=true") && out.contains("mo=true") && out.contains("rtc=true"),
        "псевдонимы конструкторов должны быть теми же объектами: {out}"
    );
    // Animation frame: a distinct function that keeps the prefixed name.
    assert!(
        out.contains("rafТотЖе=false") && out.contains("rafИмя=webkitRequestAnimationFrame"),
        "webkitRequestAnimationFrame должен быть отдельной функцией со своим именем: {out}"
    );
    assert!(
        out.contains("function webkitRequestAnimationFrame() { [native code] }"),
        "исходник не выглядит нативным: {out}"
    );
    assert!(
        out.contains("rafПрототип=false"),
        "у нативной функции не бывает prototype: {out}"
    );
}

#[tokio::test]
async fn the_prefixed_animation_frame_actually_schedules() {
    let mut page = page().await;
    let out = page
        .evaluate(
            "(function(){var id=webkitRequestAnimationFrame(function(){});\
             var ok=(typeof id==='number');\
             webkitCancelAnimationFrame(id);\
             return 'вернулId='+ok;})()",
        )
        .expect("call raf");
    assert!(
        out.contains("вернулId=true"),
        "псевдоним не планирует кадр: {out}"
    );
}
