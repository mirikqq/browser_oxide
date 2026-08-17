//! Four API shapes that were stubs, each found by a fingerprinter tripping over it.
//!
//! None of them is exotic: an audio node that knows its context, a constructible
//! `AudioBuffer`, a comment node that is a comment, and an event-handler
//! attribute you can assign to. Each failure was silent in its own way — a
//! `TypeError` swallowed by the caller's `try`, or a wrong-but-plausible value —
//! which is why they survived until something read them one by one.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

async fn blank() -> Page {
    Page::from_html("<html><body></body></html>", Some(chrome_148_macos()))
        .await
        .expect("page")
}

#[tokio::test]
async fn audio_nodes_know_their_context_and_channel_shape() {
    let mut page = blank().await;
    let shape = page
        .evaluate(
            "(function(){var c=new OfflineAudioContext(1,44100,44100);var a=c.createAnalyser();\
             return 'sampleRate='+(a.context&&a.context.sampleRate)\
                    +' count='+a.channelCount+' mode='+a.channelCountMode\
                    +' interp='+a.channelInterpretation\
                    +' in='+a.numberOfInputs+' out='+a.numberOfOutputs\
                    +' oscIn='+c.createOscillator().numberOfInputs;})()",
        )
        .expect("analyser");
    // Chrome's values for an AnalyserNode, and a source node has no inputs.
    assert!(
        shape.contains("sampleRate=44100"),
        "узел не знает свой контекст: {shape}"
    );
    assert!(
        shape.contains("count=2")
            && shape.contains("mode=max")
            && shape.contains("interp=speakers"),
        "канальные свойства не как в браузере: {shape}"
    );
    assert!(
        shape.contains("in=1") && shape.contains("out=1") && shape.contains("oscIn=0"),
        "число входов/выходов: {shape}"
    );
}

#[tokio::test]
async fn audio_buffer_is_constructible_and_its_two_readers_agree() {
    let mut page = blank().await;
    let shape = page
        .evaluate(
            "(function(){var b=new AudioBuffer({length:2000,sampleRate:44100});\
             var direct=b.getChannelData(0); direct[7]=0.5; direct[9]=-0.25;\
             var copy=new Float32Array(2000); b.copyFromChannel(copy,0);\
             var same=true; for(var i=0;i<2000;i++) if(copy[i]!==direct[i]) { same=false; break; }\
             return 'длина='+b.length+' каналов='+b.numberOfChannels\
                    +' частота='+b.sampleRate+' совпало='+same\
                    +' наПрототипе='+('copyFromChannel' in AudioBuffer.prototype);})()",
        )
        .expect("audio buffer");
    assert!(
        shape.contains("длина=2000")
            && shape.contains("каналов=1")
            && shape.contains("частота=44100"),
        "AudioBuffer не сконструировался: {shape}"
    );
    // The comparison fingerprinters actually run: the two readers must agree.
    assert!(
        shape.contains("совпало=true") && shape.contains("наПрототипе=true"),
        "getChannelData и copyFromChannel расходятся: {shape}"
    );
}

#[tokio::test]
async fn comments_are_comments() {
    let mut page = blank().await;
    let shape = page
        .evaluate(
            "(function(){var c=document.createComment('заметка');\
             var d=document.createElement('div');\
             d.appendChild(c); d.appendChild(document.createTextNode('текст'));\
             return 'nodeType='+c.nodeType+' nodeName='+c.nodeName+' data='+c.data\
                    +' конструктор='+new Comment('x').nodeType\
                    +' html='+d.innerHTML\
                    +' текстЭлемента='+JSON.stringify(d.textContent);})()",
        )
        .expect("comment");
    assert!(
        shape.contains("nodeType=8") && shape.contains("nodeName=#comment"),
        "комментарий не комментарий: {shape}"
    );
    assert!(
        shape.contains("data=заметка") && shape.contains("конструктор=8"),
        "данные комментария потеряны: {shape}"
    );
    assert!(
        shape.contains("html=<!--заметка-->текст"),
        "комментарий не сериализуется: {shape}"
    );
    // An element's textContent excludes comments; the comment's own does not.
    assert!(
        shape.contains("текстЭлемента=\\\"текст\\\"") || shape.contains("текстЭлемента=\"текст\""),
        "textContent элемента вобрал комментарий: {shape}"
    );
}

#[tokio::test]
async fn onvoiceschanged_can_be_assigned() {
    let mut page = blank().await;
    let shape = page
        .evaluate(
            "(function(){var ss=globalThis.speechSynthesis;var err='нет';\
             try { ss.onvoiceschanged = function h(){}; } catch (e) { err = e.message; }\
             var d=Object.getOwnPropertyDescriptor(SpeechSynthesis.prototype,'onvoiceschanged');\
             return 'ошибка='+err+' читается='+typeof ss.onvoiceschanged\
                    +' get='+(d&&typeof d.get)+' set='+(d&&typeof d.set);})()",
        )
        .expect("speech synthesis");
    assert!(
        shape.contains("ошибка=нет") && shape.contains("читается=function"),
        "обработчик не присваивается: {shape}"
    );
    assert!(
        shape.contains("get=function") && shape.contains("set=function"),
        "атрибут-обработчик без сеттера: {shape}"
    );
}

/// RFC 3986 §5.2.4. Without it a relative URL keeps its `.`/`..` segments, and
/// the server is handed a path it may well not serve — measured as
/// `new Worker('./worker.js')` failing on a script sitting beside the document.
#[tokio::test]
async fn relative_urls_drop_their_dot_segments() {
    let mut page = blank().await;
    let shape = page
        .evaluate(
            "(function(){return [\
               new URL('./w.js','https://h/dir/page.html').href,\
               new URL('../up.js','https://h/a/b/page.html').href,\
               new URL('/root.js','https://h/a/b/').href,\
               new URL('//other/x.js','https://h/a/').href\
             ].join(' ');})()",
        )
        .expect("urls");
    assert!(
        shape.contains("https://h/dir/w.js"),
        "точечный сегмент остался: {shape}"
    );
    assert!(
        shape.contains("https://h/a/up.js"),
        "переход вверх не отработал: {shape}"
    );
    assert!(
        shape.contains("https://h/root.js") && shape.contains("https://other/x.js"),
        "корневой или протокол-относительный адрес: {shape}"
    );
}
