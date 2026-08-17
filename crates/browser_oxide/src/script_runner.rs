use crate::dom::node::{NodeData, NodeId};
use crate::dom::Dom;

/// Information about a <script> element found in the DOM.
pub struct ScriptInfo {
    pub code: String,
    pub src: Option<String>,
    /// Value of the `nonce` attribute, if any. Required by CSP3
    /// `'nonce-...'` source matching — when the active policy uses
    /// `'strict-dynamic'`, only nonce-tagged parser-inserted scripts
    /// are authorized to load. Captured here at HTML-walk time so the
    /// fetch path (`page.rs::navigate_with_init`) can pass it to
    /// `crate::net::csp::CheckCtx`.
    pub nonce: Option<String>,
    /// `<script type="module">` — must be executed via the ES-module path
    /// (`load_main_es_module` + `mod_evaluate`) NOT classic `execute_script`,
    /// which throws `SyntaxError: Cannot use import statement outside a module`
    /// and silently drops modern Vite/React/Vue bundles. (P2 / thin-render fix.)
    pub is_module: bool,
    /// `defer` on an external classic script: run after parsing, in document
    /// order, before `DOMContentLoaded`. Modules are deferred by default.
    pub defer: bool,
    /// `async` on an external classic script: run as soon as it is available,
    /// out of document order, and *after* `DOMContentLoaded` in practice.
    ///
    /// Order is not cosmetic here. A page whose markup is built by an earlier
    /// script on `DOMContentLoaded` — the common shape for JS-rendered pages —
    /// hands an async third-party widget a fully built document. Running that
    /// widget at its document position instead gives it an empty page, it finds
    /// nothing to attach to, and it never scans again.
    pub is_async: bool,
    /// Raw `NodeId` of the `<script>` element in the arena DOM. Used to set
    /// `document.currentScript` to this element's wrapper for the duration of
    /// the script's execution (the standard web-API contract). Scripts that
    /// locate their own `<script>` element via `document.currentScript` (e.g.
    /// to read a `data-*` attribute or resolve a relative path) depend on it;
    /// without it set, `currentScript` is `null` and such scripts stall.
    pub node_id: u32,
}

/// Find all <script> elements in the DOM and extract their content.
/// Returns both inline scripts (code) and external scripts (src URL).
pub fn find_scripts(dom: &Dom) -> Vec<ScriptInfo> {
    let mut scripts = Vec::new();
    collect_scripts(dom, NodeId::DOCUMENT, &mut scripts);
    for (i, s) in scripts.iter().enumerate() {
        if let Some(src) = &s.src {
            tracing::debug!(index = i, src = %src, "Found external script");
        } else {
            tracing::debug!(index = i, code_len = s.code.len(), "Found inline script");
        }
    }
    scripts
}

fn collect_scripts(dom: &Dom, node_id: NodeId, scripts: &mut Vec<ScriptInfo>) {
    let children = dom.children(node_id);
    for child_id in children {
        if let Some(node) = dom.get(child_id) {
            if let NodeData::Element(elem) = &node.data {
                if elem.name.local.eq_ignore_ascii_case("script") {
                    // Skip non-JS script types (JSON-LD, templates, etc.)
                    let script_type = elem
                        .attrs
                        .iter()
                        .find(|a| a.name.local == "type")
                        .map(|a| a.value.as_str());
                    match script_type {
                        Some("application/ld+json")
                        | Some("application/json")
                        | Some("text/template")
                        | Some("text/html")
                        | Some("text/x-template") => {
                            collect_scripts(dom, child_id, scripts);
                            continue;
                        }
                        _ => {}
                    }

                    let src = elem
                        .attrs
                        .iter()
                        .find(|a| a.name.local == "src")
                        .map(|a| decode_html_entities(a.value.as_str()));

                    let nonce = elem
                        .attrs
                        .iter()
                        .find(|a| a.name.local == "nonce")
                        .map(|a| a.value.to_string())
                        .filter(|n| !n.is_empty());

                    // `type="module"` (and the rarer `type="text/javascript;
                    // version=module"` is not a thing — only the exact "module"
                    // token) routes to the ES-module path. `type="importmap"`
                    // is handled separately (skipped here, not executable code).
                    let is_module = script_type == Some("module");
                    let has = |name: &str| elem.attrs.iter().any(|a| a.name.local == name);
                    // Both present: `async` wins for classic scripts. Modules are
                    // deferred unless explicitly async.
                    let is_async = has("async");
                    let defer = (has("defer") || is_module) && !is_async;
                    if script_type == Some("importmap") || script_type == Some("speculationrules") {
                        collect_scripts(dom, child_id, scripts);
                        continue;
                    }

                    if src.is_some() {
                        // External script — store the URL for fetching
                        scripts.push(ScriptInfo {
                            code: String::new(),
                            src,
                            nonce,
                            is_module,
                            defer,
                            is_async,
                            node_id: child_id.to_raw(),
                        });
                    } else {
                        // Inline script
                        let code = dom.text_content(child_id);
                        if !code.trim().is_empty() {
                            scripts.push(ScriptInfo {
                                code,
                                src: None,
                                nonce,
                                is_module,
                                // Inline scripts ignore both attributes.
                                defer: false,
                                is_async: false,
                                node_id: child_id.to_raw(),
                            });
                        }
                    }
                }
            }
            collect_scripts(dom, child_id, scripts);
        }
    }
}

fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scripts_of(html: &str) -> Vec<ScriptInfo> {
        find_scripts(&crate::html_parser::parse_html(html))
    }

    /// Execution order is decided by these two attributes, and getting them
    /// wrong is silent: an `async` third-party widget run at its document
    /// position sees a page its predecessors have not built yet.
    #[test]
    fn defer_and_async_are_read_from_the_tag() {
        let s = scripts_of(
            r#"<html><head>
                 <script src="/a.js"></script>
                 <script src="/b.js" defer></script>
                 <script src="/c.js" async></script>
                 <script src="/d.js" async defer></script>
                 <script type="module" src="/e.js"></script>
                 <script>var inline = 1;</script>
               </head><body></body></html>"#,
        );
        let by_src = |name: &str| {
            s.iter()
                .find(|x| x.src.as_deref() == Some(name))
                .unwrap_or_else(|| panic!("нет скрипта {name}"))
        };

        assert!(
            !by_src("/a.js").defer && !by_src("/a.js").is_async,
            "обычный"
        );
        assert!(by_src("/b.js").defer && !by_src("/b.js").is_async, "defer");
        assert!(by_src("/c.js").is_async && !by_src("/c.js").defer, "async");
        // Both present: async wins for classic scripts.
        assert!(
            by_src("/d.js").is_async && !by_src("/d.js").defer,
            "async defer → async"
        );
        // Modules are deferred by default.
        assert!(
            by_src("/e.js").defer && by_src("/e.js").is_module,
            "модуль отложен по умолчанию"
        );

        let inline = s.iter().find(|x| x.src.is_none()).expect("инлайн");
        assert!(
            !inline.defer && !inline.is_async,
            "инлайн игнорирует оба атрибута"
        );
    }
}
