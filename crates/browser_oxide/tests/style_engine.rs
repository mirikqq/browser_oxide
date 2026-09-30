//! The style pass as a page sees it: inheritance, the user-agent sheet, the
//! cascade's `!important` and `@layer`, and the shorthands layout acts on.

use browser_oxide::stealth::presets::chrome_148_macos;
use browser_oxide::Page;

async fn page(html: &str) -> Page {
    Page::from_html_with_url(html, "https://example.test/", Some(chrome_148_macos()))
        .await
        .expect("page")
}

fn js(p: &mut Page, code: &str) -> String {
    p.evaluate(code).expect("evaluate")
}

const RECT: &str = "(id)=>{const r=document.getElementById(id).getBoundingClientRect();\
    return [r.x,r.y,r.width,r.height].map(n=>Math.round(n*100)/100).join(',')}";

fn rect(p: &mut Page, id: &str) -> Vec<f64> {
    js(p, &format!("({RECT})('{id}')"))
        .split(',')
        .map(|v| v.parse().expect("number"))
        .collect()
}

#[tokio::test]
async fn ua_sheet_gives_tags_their_display() {
    let mut p = page("<div id=d></div><span id=s></span><h1 id=h>x</h1><li id=l></li>").await;
    let mut d = |id: &str| {
        js(&mut p, &format!("getComputedStyle(document.getElementById('{id}')).display"))
    };
    assert_eq!(d("d"), "block");
    assert_eq!(d("s"), "inline");
    assert_eq!(d("h"), "block");
    assert_eq!(d("l"), "list-item");
}

#[tokio::test]
async fn font_size_inherits_and_compounds() {
    let mut p = page(
        "<style>#a{font-size:20px} #b{font-size:1.5em}</style>\
         <div id=a><p id=b><span id=c>x</span></p></div><h1 id=h>y</h1>",
    )
    .await;
    let fs = |p: &mut Page, id: &str| {
        js(p, &format!("getComputedStyle(document.getElementById('{id}')).fontSize"))
    };
    assert_eq!(fs(&mut p, "a"), "20px");
    assert_eq!(fs(&mut p, "b"), "30px");
    assert_eq!(fs(&mut p, "c"), "30px", "a descendant inherits the computed size");
    assert_eq!(fs(&mut p, "h"), "32px", "h1 is 2em of the default 16px");
}

#[tokio::test]
async fn em_margins_use_the_elements_own_font_size() {
    let mut p = page("<style>#a{font-size:10px;margin-top:2em}</style><div id=a>x</div>").await;
    assert_eq!(
        js(&mut p, "getComputedStyle(document.getElementById('a')).marginTop"),
        "20px"
    );
}

#[tokio::test]
async fn important_and_layers_decide_the_winner() {
    let mut p = page(
        "<style>\
         @layer base, theme;\
         @layer theme { #a { width: 200px } }\
         @layer base  { #a { width: 100px } }\
         #b { width: 10px !important } #b { width: 20px }\
         #c { width: 30px } @layer base { #c { width: 40px } }\
         </style><div id=a></div><div id=b></div><div id=c></div>",
    )
    .await;
    let w = |p: &mut Page, id: &str| {
        js(p, &format!("getComputedStyle(document.getElementById('{id}')).width"))
    };
    assert_eq!(w(&mut p, "a"), "200px", "the later layer wins");
    assert_eq!(w(&mut p, "b"), "10px", "!important beats a later rule");
    assert_eq!(w(&mut p, "c"), "30px", "unlayered beats layered");
}

#[tokio::test]
async fn paragraph_margins_shift_layout() {
    let mut p = page(
        "<!doctype html><body style='margin:0'><p id=a style='margin:0'>x</p>\
         <p id=b>y</p><div id=c style='height:10px'></div>",
    )
    .await;
    let a = rect(&mut p, "a");
    let b = rect(&mut p, "b");
    assert_eq!(a[1], 0.0);
    assert!(
        (b[1] - (a[1] + a[3] + 16.0)).abs() < 0.5,
        "the second paragraph sits one 1em margin below the first: a={a:?} b={b:?}"
    );
}

#[tokio::test]
async fn heading_is_taller_than_a_paragraph() {
    let mut p = page("<!doctype html><body style='margin:0'><h1 id=h>x</h1><p id=p>y</p>").await;
    let h = rect(&mut p, "h");
    let q = rect(&mut p, "p");
    assert!(h[3] > q[3] * 1.5, "h1 height {} vs p height {}", h[3], q[3]);
}

#[tokio::test]
async fn flex_gap_and_shorthand_grow() {
    let mut p = page(
        "<!doctype html><body style='margin:0'>\
         <div style='display:flex;gap:10px;width:300px'>\
         <div id=a style='width:50px;height:10px'></div>\
         <div id=b style='width:50px;height:10px'></div>\
         <div id=c style='flex:1;height:10px'></div></div>",
    )
    .await;
    let a = rect(&mut p, "a");
    let b = rect(&mut p, "b");
    let c = rect(&mut p, "c");
    assert_eq!(b[0] - (a[0] + a[2]), 10.0, "column gap from `gap: 10px`");
    assert_eq!(c[0] + c[2], 300.0, "`flex: 1` fills the rest of the row");
}

#[tokio::test]
async fn justify_content_and_align_items_take_effect() {
    let mut p = page(
        "<!doctype html><body style='margin:0'>\
         <div style='display:flex;width:200px;height:100px;justify-content:center;align-items:center'>\
         <div id=a style='width:40px;height:20px'></div></div>",
    )
    .await;
    let a = rect(&mut p, "a");
    assert_eq!((a[0], a[1]), (80.0, 40.0));
}

#[tokio::test]
async fn logical_margin_centres_a_block() {
    let mut p = page(
        "<!doctype html><body style='margin:0'>\
         <div id=a style='width:100px;height:10px;margin-inline:auto'></div>",
    )
    .await;
    let a = rect(&mut p, "a");
    let vw: f64 = js(&mut p, "innerWidth").parse().expect("innerWidth");
    assert!((a[0] - (vw - 100.0) / 2.0).abs() < 0.5, "x={} vw={vw}", a[0]);
}

#[tokio::test]
async fn display_none_ancestor_zeroes_the_subtree() {
    let mut p = page(
        "<!doctype html><div style='display:none'><div id=a style='width:50px;height:50px'></div></div>",
    )
    .await;
    assert_eq!(rect(&mut p, "a"), vec![0.0, 0.0, 0.0, 0.0]);
}
