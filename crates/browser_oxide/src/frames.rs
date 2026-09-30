//! The frame tree of one document: loading its frames — same-origin ones
//! into realms of the document's isolate (see `js_runtime::realms`),
//! cross-origin ones into isolates of their own (`ChildIframe`) — and keeping
//! them in step with the DOM. The page's document and every isolate frame's
//! document are settled by the same code.

use std::time::Duration;

use crate::event_loop::BrowserEventLoop;
use crate::iframe::{self, ChildIframe};
use crate::page::{Page, NS_RESOLVE};
use crate::{script_runner, stylesheet_collector};

/// Where a same-origin frame's document comes from.
enum RealmFrameSource {
    Srcdoc(String),
    Url(String),
}

impl RealmFrameSource {
    /// What `FrameRealm::source` records, to tell a reload from a no-op.
    fn key(&self) -> String {
        match self {
            Self::Srcdoc(html) => format!("srcdoc:{html}"),
            Self::Url(url) => format!("url:{url}"),
        }
    }
}

/// How the engine builds an `<iframe>`'s browsing context.
enum FrameKind {
    /// No document to load: the initial `about:blank`, created as a realm on
    /// first `contentWindow` access.
    Blank,
    /// Same-origin: a realm of this isolate (see `js_runtime::realms`).
    Realm(RealmFrameSource),
    /// Cross-origin: an isolate of its own (`ChildIframe`), at this URL.
    Isolate(String),
}

/// Classify a frame of a document at `base` whose origin is `origin`.
/// `srcdoc` wins over `src`, as in the spec.
fn classify_frame(info: &iframe::IframeInfo, base: &str, origin: &str) -> FrameKind {
    if let Some(html) = &info.srcdoc {
        return FrameKind::Realm(RealmFrameSource::Srcdoc(html.clone()));
    }
    let Some(src) = info.src.as_deref().map(str::trim) else {
        return FrameKind::Blank;
    };
    if src.is_empty() || src == "about:blank" || src.to_ascii_lowercase().starts_with("javascript:")
    {
        return FrameKind::Blank;
    }
    let Some(full) = Page::resolve_url(base, src) else {
        return FrameKind::Blank;
    };
    if origin != "null" && iframe::origin_of(&full) == origin {
        FrameKind::Realm(RealmFrameSource::Url(full))
    } else {
        FrameKind::Isolate(full)
    }
}

pub(crate) async fn settle_document(
    event_loop: &mut BrowserEventLoop,
    children: &mut Vec<ChildIframe>,
    base_url: &str,
    client: &crate::net::HttpClient,
    profile: &crate::stealth::StealthProfile,
) -> usize {
    // Snapshot the current DOM's iframes (scoped borrow, dropped
    // before any await / before touching children).
    let iframes = {
        let dom_ref = event_loop.runtime_mut().inner();
        let state = dom_ref.op_state();
        let state = state.borrow();
        let dom_state = state.borrow::<crate::js_runtime::state::DomState>();
        iframe::find_iframes(&dom_state.dom)
    };
    // Apply the browsing-context lifecycle the DOM recorded since the last
    // pass. Dropping the realm is all that is needed for both cases: a frame
    // still in the tree is rebuilt below from its current attributes, and one
    // that left the tree is not found by the scan and so stays gone.
    let invalidated: Vec<u32> = {
        let dom_ref = event_loop.runtime_mut().inner();
        let state = dom_ref.op_state();
        let mut state = state.borrow_mut();
        let dom_state = state.borrow_mut::<crate::js_runtime::state::DomState>();
        std::mem::take(&mut dom_state.invalidated_frames)
    };
    iframe::forget_frame_load_failures(event_loop, &invalidated);
    let live: Vec<u32> = iframes.iter().map(|i| i.node_id.to_raw()).collect();
    // Not `Vec::retain` — see `iframe::bury_frame`'s doc comment: a
    // removed frame must be buried, not dropped in place, since a
    // surviving sibling can be a younger isolate.
    let (keep, gone): (Vec<_>, Vec<_>) = children.drain(..).partition(|child| {
        let id = child.node_id.to_raw();
        child.parent_realm != 0 || (live.contains(&id) && !invalidated.contains(&id))
    });
    *children = keep;
    for dead in gone {
        iframe::bury_frame(dead);
    }
    drop_stale_realm_frames(event_loop, 0, &live, &invalidated);

    let origin = event_loop
        .execute_script("String(location.origin)")
        .unwrap_or_else(|_| iframe::origin_of(base_url));
    let already: Vec<_> = children
        .iter()
        .filter(|c| c.parent_realm == 0)
        .map(|c| c.node_id)
        .collect();
    let mut materialized = 0usize;
    for info in &iframes {
        if already.contains(&info.node_id) {
            continue; // already a real child context — not script-new
        }
        if iframe::frame_load_failed(event_loop, info.node_id) {
            continue; // failed before; retried once invalidated
        }
        match classify_frame(info, base_url, &origin) {
            FrameKind::Blank => {}
            FrameKind::Realm(source) => {
                match Box::pin(load_realm_frame(
                    event_loop,
                    0,
                    info.node_id,
                    source,
                    base_url,
                    &origin,
                    client,
                ))
                .await
                {
                    Ok(true) => materialized += 1,
                    Ok(false) => {}
                    Err(e) => {
                        iframe::record_frame_load_failure(event_loop, info.node_id);
                        tracing::warn!(error = %e, "frame realm load error");
                    }
                }
            }
            FrameKind::Isolate(full_src) => {
                let src = info.src.clone().unwrap_or_default();
                match Box::pin(iframe::ChildIframe::from_url(
                    info.node_id,
                    &full_src,
                    base_url,
                    client,
                    Some(profile),
                ))
                .await
                {
                    Ok(mut child) => {
                        child.source = src;
                        iframe::fire_owner_load(event_loop, info.node_id);
                        children.push(child);
                        materialized += 1;
                    }
                    Err(e) => {
                        iframe::record_frame_load_failure(event_loop, info.node_id);
                        tracing::warn!(
                            src = %full_src, error = %e,
                            "rematerialize src-iframe error (CSP-blocked or fetch failed)"
                        )
                    }
                }
            }
        }
    }
    materialized += Box::pin(follow_frame_navigations(
        event_loop, children, base_url, &origin, client, profile,
    ))
    .await;
    materialized += Box::pin(settle_nested_realm_frames(
        event_loop, children, base_url, &origin, client, profile,
    ))
    .await;
    bury_orphaned_isolates(event_loop, children);
    materialized
}

/// Bury the isolates of cross-origin frames whose embedding frame realm is
/// gone (removed, navigated, or its document replaced).
fn bury_orphaned_isolates(event_loop: &mut BrowserEventLoop, children: &mut Vec<ChildIframe>) {
    let realms: Vec<u32> = event_loop
        .runtime_mut()
        .frame_realms()
        .into_iter()
        .map(|(id, _, _)| id)
        .collect();
    let (keep, gone): (Vec<_>, Vec<_>) = children
        .drain(..)
        .partition(|c| c.parent_realm == 0 || realms.contains(&c.parent_realm));
    *children = keep;
    for dead in gone {
        iframe::bury_frame(dead);
    }
}

/// Frame realms whose document navigated itself (`location.href = …`):
/// a same-origin target loads into the same realm; a cross-origin one
/// replaces a top-level frame's realm with an isolate of its own.
async fn follow_frame_navigations(
    event_loop: &mut BrowserEventLoop,
    children: &mut Vec<ChildIframe>,
    page_base: &str,
    page_origin: &str,
    client: &crate::net::HttpClient,
    profile: &crate::stealth::StealthProfile,
) -> usize {
    let mut followed = 0usize;
    for realm in event_loop.runtime_mut().take_frame_navigations() {
        let target = event_loop
            .runtime_mut()
            .execute_in_realm(
                realm,
                &format!(
                    "(function(){{var b=(({NS_RESOLVE}||{{}}).host||{{}}).bo;                         var p=b&&b.__pendingNavigation;if(b)b.__pendingNavigation=null;                         return p&&p.url?String(p.url):'';}})()"
                ),
            )
            .unwrap_or_default();
        if target.is_empty() || target.starts_with("about:") {
            continue;
        }
        let Some((_, parent, node)) = event_loop
            .runtime_mut()
            .frame_realms()
            .into_iter()
            .find(|(id, _, _)| *id == realm)
        else {
            continue;
        };
        let (base, origin) = match event_loop
            .runtime_mut()
            .frame_realm_source(realm)
            .as_deref()
            .and_then(|s| s.strip_prefix("url:").map(str::to_string))
        {
            Some(url) => (url.clone(), iframe::origin_of(&url)),
            None => (page_base.to_string(), page_origin.to_string()),
        };
        let Some(full) = Page::resolve_url(&base, &target) else {
            continue;
        };
        let node_id = crate::dom::node::NodeId::from_raw(node);
        if iframe::origin_of(&full) == origin && origin != "null" {
            if let Ok(true) = Box::pin(load_realm_frame(
                event_loop,
                parent,
                node_id,
                RealmFrameSource::Url(full),
                &base,
                &origin,
                client,
            ))
            .await
            {
                followed += 1;
            }
        } else if parent == 0 {
            event_loop.runtime_mut().destroy_frame_realm(realm);
            if let Ok(child) = Box::pin(iframe::ChildIframe::from_url(
                node_id,
                &full,
                &base,
                client,
                Some(profile),
            ))
            .await
            {
                iframe::fire_owner_load(event_loop, node_id);
                children.push(child);
                followed += 1;
            }
        }
    }
    followed
}

/// Drop the frame realms of realm `parent`'s document whose `<iframe>` left
/// the tree, or whose loaded document was invalidated (its `src`/`srcdoc`
/// rewritten, the element re-inserted). A realm still holding its initial
/// `about:blank` survives invalidation: the frame's document loads into
/// that same window, as the HTML spec does — and `contentWindow` taken
/// right after the `<iframe>` was appended keeps pointing at it.
fn drop_stale_realm_frames(
    event_loop: &mut BrowserEventLoop,
    parent: u32,
    live: &[u32],
    invalidated: &[u32],
) {
    let candidates: Vec<(u32, u32)> = event_loop
        .runtime_mut()
        .frame_realms()
        .into_iter()
        .filter(|(_, p, _)| *p == parent)
        .map(|(id, _, node)| (id, node))
        .collect();
    for (id, node) in candidates {
        let gone = !live.contains(&node);
        let reload = invalidated.contains(&node)
            && event_loop.runtime_mut().frame_realm_source(id).is_some();
        if gone || reload {
            event_loop.runtime_mut().destroy_frame_realm(id);
        }
    }
}

/// Frames inside same-origin frames: each loaded frame realm's own document
/// is scanned the same way the page's is, breadth first — same-origin
/// frames become realms, cross-origin ones isolates embedded in the realm.
async fn settle_nested_realm_frames(
    event_loop: &mut BrowserEventLoop,
    children: &mut Vec<ChildIframe>,
    page_base: &str,
    page_origin: &str,
    client: &crate::net::HttpClient,
    profile: &crate::stealth::StealthProfile,
) -> usize {
    let mut built = 0usize;
    let mut done: Vec<u32> = Vec::new();
    loop {
        let next = event_loop
            .runtime_mut()
            .frame_realms()
            .into_iter()
            .map(|(id, _, _)| id)
            .find(|id| !done.contains(id));
        let Some(realm) = next else { break };
        done.push(realm);
        let Some(source) = event_loop.runtime_mut().frame_realm_source(realm) else {
            continue; // still its initial about:blank
        };
        // A srcdoc document shares its parent's base and origin.
        let (base, origin) = match source.strip_prefix("url:") {
            Some(url) => (url.to_string(), iframe::origin_of(url)),
            None => (page_base.to_string(), page_origin.to_string()),
        };
        let scanned = event_loop.runtime_mut().with_realm_dom(realm, |d| {
            let invalidated = std::mem::take(&mut d.invalidated_frames);
            for n in &invalidated {
                d.frame_load_failures.remove(n);
            }
            (
                iframe::find_iframes(&d.dom),
                invalidated,
                d.frame_load_failures.clone(),
            )
        });
        let Some((infos, invalidated, failed)) = scanned else {
            continue;
        };
        let live: Vec<u32> = infos.iter().map(|i| i.node_id.to_raw()).collect();
        drop_stale_realm_frames(event_loop, realm, &live, &invalidated);
        let (keep, gone): (Vec<_>, Vec<_>) = children.drain(..).partition(|c| {
            let id = c.node_id.to_raw();
            c.parent_realm != realm || (live.contains(&id) && !invalidated.contains(&id))
        });
        *children = keep;
        for dead in gone {
            iframe::bury_frame(dead);
        }
        for info in &infos {
            if failed.contains(&info.node_id.to_raw()) {
                continue;
            }
            let source = match classify_frame(info, &base, &origin) {
                FrameKind::Blank => continue,
                FrameKind::Realm(source) => source,
                FrameKind::Isolate(full) => {
                    let exists = children
                        .iter()
                        .any(|c| c.parent_realm == realm && c.node_id == info.node_id);
                    if exists {
                        continue;
                    }
                    let node = info.node_id.to_raw();
                    match Box::pin(iframe::ChildIframe::from_url(
                        info.node_id,
                        &full,
                        &base,
                        client,
                        Some(profile),
                    ))
                    .await
                    {
                        Ok(mut child) => {
                            child.source = info.src.clone().unwrap_or_default();
                            child.parent_realm = realm;
                            let _ = event_loop.runtime_mut().execute_in_realm(
                                realm,
                                &format!(
                                    "(function(){{var ns={NS_RESOLVE};if(ns&&ns.frames)ns.frames.fireLoad({node});}})()"
                                ),
                            );
                            children.push(child);
                            built += 1;
                        }
                        Err(e) => {
                            event_loop.runtime_mut().with_realm_dom(realm, |d| {
                                d.frame_load_failures.insert(node);
                            });
                            tracing::warn!(error = %e, "nested isolate frame load error");
                        }
                    }
                    continue;
                }
            };
            match Box::pin(load_realm_frame(
                event_loop,
                realm,
                info.node_id,
                source,
                &base,
                &origin,
                client,
            ))
            .await
            {
                Ok(true) => built += 1,
                Ok(false) => {}
                Err(e) => {
                    let node = info.node_id.to_raw();
                    event_loop.runtime_mut().with_realm_dom(realm, |d| {
                        d.frame_load_failures.insert(node);
                    });
                    tracing::warn!(error = %e, "nested frame realm load error");
                }
            }
        }
    }
    built
}

/// Load a same-origin frame's document into its realm — created with the
/// initial `about:blank` if nothing touched `contentWindow` yet — the way
/// the page loads its own: stylesheets, scripts in order (external ones
/// fetched), `DOMContentLoaded`/`load` inside, then `load` on the
/// `<iframe>` in the parent. `Ok(false)` when that document is already
/// the one loaded.
async fn load_realm_frame(
    event_loop: &mut BrowserEventLoop,
    parent: u32,
    node: crate::dom::node::NodeId,
    source: RealmFrameSource,
    parent_base: &str,
    parent_origin: &str,
    client: &crate::net::HttpClient,
) -> Result<bool, deno_core::error::AnyError> {
    let key = source.key();
    let raw = node.to_raw();
    let existing = event_loop
        .runtime_mut()
        .frame_realms()
        .into_iter()
        .find(|(_, p, n)| *p == parent && *n == raw)
        .map(|(id, _, _)| id);
    if let Some(id) = existing {
        if event_loop.runtime_mut().frame_realm_source(id).as_deref() == Some(key.as_str()) {
            return Ok(false);
        }
    }
    let (html, doc_url, base, inherit) = match &source {
        RealmFrameSource::Srcdoc(html) => (
            html.clone(),
            "about:srcdoc".to_string(),
            parent_base.to_string(),
            Some(parent_origin.to_string()),
        ),
        RealmFrameSource::Url(url) => {
            let hdrs = crate::net::headers::nav_headers_iframe(client.profile(), url, parent_base);
            let resp = Box::pin(client.get_with_exact_headers(url, &hdrs))
                .await
                .map_err(|e| deno_core::error::AnyError::msg(format!("frame fetch: {e}")))?;
            if !resp.ok() {
                return Err(deno_core::error::AnyError::msg(format!(
                    "frame fetch {url} returned {}",
                    resp.status
                )));
            }
            (resp.text(), url.clone(), url.clone(), None)
        }
    };
    let dom = crate::html_parser::parse_html(&html);
    let scripts = script_runner::find_scripts(&dom);
    let stylesheet_entries = stylesheet_collector::find_stylesheets(&dom);
    let mut stylesheets = Vec::new();
    for entry in &stylesheet_entries {
        match entry {
            stylesheet_collector::StylesheetEntry::Inline(css) => stylesheets.push(css.clone()),
            stylesheet_collector::StylesheetEntry::External(href) => {
                let Some(full) = url::Url::parse(&base).ok().and_then(|b| b.join(href).ok()) else {
                    continue;
                };
                let full = full.to_string();
                let hdrs = crate::net::headers::nav_headers_subresource(
                    client.profile(),
                    &full,
                    &base,
                    "style",
                    false,
                );
                if let Ok(resp) = Box::pin(client.get_with_exact_headers(&full, &hdrs)).await {
                    if resp.ok() {
                        stylesheets.push(resp.text());
                    }
                }
            }
        }
    }

    let realm = match existing {
        Some(id) => id,
        None => event_loop.runtime_mut().create_frame_realm_for(
            parent,
            raw,
            None,
            Vec::new(),
            parent_origin,
        )?,
    };
    event_loop.runtime_mut().replace_realm_document(
        realm,
        dom,
        stylesheets,
        &doc_url,
        inherit.as_deref(),
    )?;
    event_loop
        .runtime_mut()
        .set_frame_realm_source(realm, Some(key));

    for (i, script) in scripts.iter().enumerate() {
        let (code, name) = match &script.src {
            Some(src) => {
                let Some(full) = url::Url::parse(&base).ok().and_then(|b| b.join(src).ok()) else {
                    continue;
                };
                let full = full.to_string();
                let hdrs = crate::net::headers::nav_headers_subresource(
                    client.profile(),
                    &full,
                    &base,
                    "script",
                    false,
                );
                match Box::pin(client.get_with_exact_headers(&full, &hdrs)).await {
                    Ok(resp) if resp.ok() => {
                        let text = resp.text();
                        if text.trim_start().starts_with("<!") {
                            continue;
                        }
                        (text, full)
                    }
                    _ => continue,
                }
            }
            None => (script.code.clone(), doc_url.clone()),
        };
        if code.trim().is_empty() {
            continue;
        }
        if let Err(e) = event_loop
            .runtime_mut()
            .execute_in_realm_named(realm, &code, &name)
        {
            tracing::warn!(script_index = i, error = %e, "frame realm script error");
        }
    }

    // Messages posted to the frame before its document was in.
    let _ = event_loop.runtime_mut().execute_in_realm(
        realm,
        &format!(
            "(function(){{var ns={NS_RESOLVE};if(ns&&ns.documentLoaded)ns.documentLoaded();}})()"
        ),
    );
    // The document's own lifecycle, from a task, in spec order.
    let _ = event_loop.runtime_mut().execute_in_realm(
        realm,
        &format!(
            "setTimeout(function(){{\
               var b=(({NS_RESOLVE}||{{}}).host||{{}}).bo;\
               if(b)b.__documentReadyState='interactive';\
               document.dispatchEvent(new Event('DOMContentLoaded',{{bubbles:true}}));\
               if(b)b.__documentReadyState='complete';\
               globalThis.dispatchEvent(new Event('load'));\
             }},0);"
        ),
    );
    let _ = event_loop.run_until_idle(Duration::from_millis(200)).await;
    sync_realm_frame_geometry(event_loop, realm);
    // `load` on the `<iframe>` element, in the parent's document.
    let _ = event_loop.runtime_mut().execute_in_realm(
        parent,
        &format!(
            "(function(){{var ns={NS_RESOLVE};if(ns&&ns.frames)ns.frames.fireLoad({raw});}})()"
        ),
    );
    Ok(true)
}

/// Give frame realm `realm` its `<iframe>`'s box as its viewport, the way
/// a separate-isolate frame gets it (`ChildIframe::set_frame_geometry`).
fn sync_realm_frame_geometry(event_loop: &mut BrowserEventLoop, realm: u32) {
    let Some((parent, node)) = event_loop
        .runtime_mut()
        .frame_realms()
        .into_iter()
        .find(|(id, _, _)| *id == realm)
        .map(|(_, p, n)| (p, n))
    else {
        return;
    };
    let rect = event_loop.runtime_mut().with_realm_dom(parent, |d| {
        let r = d
            .layout_engine
            .get_bounding_rect(&d.dom, crate::dom::node::NodeId::from_raw(node));
        (
            r.x,
            r.y,
            r.width,
            r.height,
            d.layout_engine.viewport().device_pixel_ratio,
        )
    });
    let Some((x, y, w, h, dpr)) = rect else {
        return;
    };
    if w <= 0.0 || h <= 0.0 {
        return;
    }
    event_loop.runtime_mut().with_realm_dom(realm, |d| {
        d.layout_engine
            .set_viewport(crate::layout::Viewport::with_dpr(w as f32, h as f32, dpr));
    });
    let _ = event_loop.runtime_mut().execute_in_realm(
        realm,
        &format!(
            "(function(){{var ns={NS_RESOLVE};if(ns)ns.frame={{x:{x:.2},y:{y:.2},w:{w:.2},h:{h:.2}}};}})()"
        ),
    );
}
