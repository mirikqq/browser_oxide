//! Iframe isolation tests — each frame is a separate JS realm with its own
//! globals and document. Same-origin (srcdoc) frames are realms of the page's
//! own isolate (F4); see `frame_tree_realms.rs` for how they are reached.

use browser_oxide::Page;

/// The i-th frame realm in load (= document) order.
fn realm(page: &mut Page, i: usize) -> u32 {
    page.frame_realms()[i].0
}

#[tokio::test]
async fn iframe_srcdoc_creates_child() {
    let mut page = Page::from_html(
        r#"<!DOCTYPE html><html><body>
        <iframe srcdoc="<html><body><p>hello from iframe</p></body></html>"></iframe>
    </body></html>"#,
        None::<browser_oxide::stealth::StealthProfile>,
    )
    .await
    .unwrap();
    assert_eq!(page.frame_realms().len(), 1, "should have 1 frame realm");
}

#[tokio::test]
async fn iframe_srcdoc_has_isolated_globals() {
    let mut page = Page::from_html(r#"<!DOCTYPE html><html><body>
        <script>globalThis.parentVar = 42;</script>
        <iframe srcdoc="<html><body><script>globalThis.childVar = 99;</script></body></html>"></iframe>
    </body></html>"#, None::<browser_oxide::stealth::StealthProfile>).await.unwrap();
    // Parent sees its own var
    assert_eq!(page.evaluate("parentVar").unwrap(), "42");
    // Parent does NOT see child's var (isolated context)
    assert_eq!(page.evaluate("typeof childVar").unwrap(), "undefined");
    let r = realm(&mut page, 0);
    // Child sees its own var
    assert_eq!(page.evaluate_in_frame_realm(r, "childVar").unwrap(), "99");
    // Child does NOT see parent's var
    assert_eq!(
        page.evaluate_in_frame_realm(r, "typeof parentVar").unwrap(),
        "undefined"
    );
}

#[tokio::test]
async fn iframe_child_has_own_document() {
    let mut page = Page::from_html(
        r#"<!DOCTYPE html><html><body>
        <p id="parent-p">parent content</p>
        <iframe srcdoc="<html><body><p id='child-p'>child content</p></body></html>"></iframe>
    </body></html>"#,
        None::<browser_oxide::stealth::StealthProfile>,
    )
    .await
    .unwrap();
    // Parent sees its own DOM
    assert_eq!(
        page.evaluate("document.getElementById('parent-p').textContent")
            .unwrap(),
        "parent content"
    );
    // Parent doesn't see child's DOM
    assert_eq!(
        page.evaluate("document.getElementById('child-p')").unwrap(),
        "null"
    );
    // Child sees its own DOM
    let r = realm(&mut page, 0);
    assert_eq!(
        page.evaluate_in_frame_realm(r, "document.querySelector('#child-p').textContent")
            .unwrap(),
        "child content"
    );
}

#[tokio::test]
async fn iframe_srcdoc_executes_scripts() {
    let mut page = Page::from_html(r#"<!DOCTYPE html><html><body>
        <iframe srcdoc="<html><body><div id='target'>before</div><script>document.getElementById('target').textContent = 'after';</script></body></html>"></iframe>
    </body></html>"#, None::<browser_oxide::stealth::StealthProfile>).await.unwrap();
    let r = realm(&mut page, 0);
    assert_eq!(
        page.evaluate_in_frame_realm(r, "document.querySelector('#target').textContent")
            .unwrap(),
        "after"
    );
}

#[tokio::test]
async fn multiple_iframes_isolated() {
    let mut page = Page::from_html(
        r#"<!DOCTYPE html><html><body>
        <iframe srcdoc="<script>globalThis.x = 'iframe1';</script>"></iframe>
        <iframe srcdoc="<script>globalThis.x = 'iframe2';</script>"></iframe>
    </body></html>"#,
        None::<browser_oxide::stealth::StealthProfile>,
    )
    .await
    .unwrap();
    assert_eq!(page.frame_realms().len(), 2);
    let (a, b) = (realm(&mut page, 0), realm(&mut page, 1));
    assert_eq!(page.evaluate_in_frame_realm(a, "x").unwrap(), "iframe1");
    assert_eq!(page.evaluate_in_frame_realm(b, "x").unwrap(), "iframe2");
}

// FP-E1 regression: an iframe `appendChild`'d by script AFTER load must be
// built as a real frame that executes its document. It used to get only a
// synthetic `contentWindow` shim. A same-origin (srcdoc) one is a realm of
// the page's isolate (F4); the cross-origin `src` path is covered by
// `frame_tree_realms.rs` and the live `#[ignore]` anti-bot suites.
#[tokio::test]
async fn fp_e1_post_js_injected_iframe_is_materialized() {
    let profile = browser_oxide::stealth::presets::chrome_148_macos();
    let client = browser_oxide::net::HttpClient::new(&profile).unwrap();
    let mut page = Page::from_html(
        "<!DOCTYPE html><html><body><div id=root></div></body></html>",
        Some(profile.clone()),
    )
    .await
    .unwrap();
    // No frames at build time.
    assert_eq!(page.frame_realms().len(), 0);
    // Challenge-script-style POST-LOAD iframe injection.
    page.evaluate(
        r#"const f = document.createElement('iframe');
        f.srcdoc = "<html><body><script>globalThis.__childRan='yes';</script></body></html>";
        document.body.appendChild(f);"#,
    )
    .unwrap();
    let n = page
        .rematerialize_iframes("https://example.test/", &client, &profile)
        .await;
    assert_eq!(n, 1, "post-JS-injected iframe must be materialized");
    assert_eq!(page.frame_realms().len(), 1);
    let r = realm(&mut page, 0);
    assert_eq!(
        page.evaluate_in_frame_realm(r, "__childRan").unwrap(),
        "yes",
        "the materialized frame must really execute its document's script"
    );
    // Idempotent: a second call materializes nothing new.
    let n2 = page
        .rematerialize_iframes("https://example.test/", &client, &profile)
        .await;
    assert_eq!(n2, 0, "rematerialize must be idempotent");
}
