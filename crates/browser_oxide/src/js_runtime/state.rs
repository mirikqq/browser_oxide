use crate::dom::Dom;
use crate::layout::{LayoutEngine, Viewport};
use std::collections::HashMap;
use std::sync::Arc;

/// Shared state stored in deno_core's OpState, accessible by all ops.
pub struct DomState {
    pub dom: Dom,
    pub layout_engine: LayoutEngine,
    pub base_url: Option<url::Url>,
    /// Console output capture
    pub console_output: Vec<ConsoleMessage>,
    /// localStorage / sessionStorage (in-memory)
    pub storage: HashMap<String, HashMap<String, String>>,
    /// CSS from `<style>` blocks, used by getComputedStyle
    pub stylesheets: Vec<String>,
    /// Parsed and simplified CSS rules for fast lookup
    pub cached_rules: Vec<CachedRule>,
    /// `iframe.contentWindow.postMessage` payloads awaiting delivery into the child
    /// realm, as `(iframe node id, JSON)`. Realms are separate V8 isolates, so the
    /// hop has to go through Rust: `Page::pump_iframe_messages` drains this.
    pub messages_to_children: Vec<(u32, String)>,
    /// `parent.postMessage` payloads from a child realm, awaiting delivery upward.
    pub messages_to_parent: Vec<String>,
    pub stealth_profile: Option<crate::stealth::StealthProfile>,
    /// Active Content Security Policy. Built from the response
    /// `Content-Security-Policy` header(s) plus any
    /// `<meta http-equiv="Content-Security-Policy">` tags found in the
    /// parsed HTML. None means no policy applies (e.g. about:blank,
    /// from_html with no header). The policy applies to ALL fetches —
    /// `<script src>`, `op_fetch`, `op_net_fetch_sync`, iframes — until
    /// the next top-level navigation.
    pub csp_policy: Option<Arc<crate::net::csp::PolicySet>>,
    /// Origin used to resolve `'self'` in CSP source matching. Equals
    /// the document's origin (scheme + host + port of the navigated
    /// URL). None for opaque/about:blank documents — those bypass CSP.
    pub csp_origin: Option<url::Url>,
    /// Resource timings for performance.getEntriesByType('resource')
    pub resource_timings: Vec<crate::net::TimingStats>,
}

#[derive(Debug, Clone)]
pub struct CachedRule {
    pub selector_str: String,
    pub selectors: crate::css_selectors::SelectorList,
    pub declarations: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct ConsoleMessage {
    pub level: ConsoleLevel,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsoleLevel {
    Log,
    Warn,
    Error,
    Info,
    Debug,
}

impl DomState {
    pub fn new(dom: Dom) -> Self {
        let mut storage = HashMap::new();
        storage.insert("local".to_string(), HashMap::new());
        storage.insert("session".to_string(), HashMap::new());
        Self {
            dom,
            layout_engine: LayoutEngine::new(Viewport::new(1920.0, 1080.0)),
            base_url: None,
            console_output: Vec::new(),
            storage,
            stylesheets: Vec::new(),
            cached_rules: Vec::new(),
            messages_to_children: Vec::new(),
            messages_to_parent: Vec::new(),
            stealth_profile: None,
            csp_policy: None,
            csp_origin: None,
            resource_timings: Vec::new(),
        }
    }

    /// Sync layout + media evaluation with the stealth profile's viewport.
    /// Call after assigning `stealth_profile`.
    pub fn sync_viewport_from_profile(&mut self) {
        if let Some(p) = self.stealth_profile.as_ref() {
            self.layout_engine
                .set_viewport(crate::layout::Viewport::new(
                    p.inner_width as f32,
                    p.inner_height as f32,
                ));
        }
    }

    pub fn update_cached_rules(&mut self) {
        use crate::js_runtime::utils::tokens_to_string;
        self.cached_rules.clear();
        // Media features come from the stealth profile so `@media` evaluates against
        // the viewport the page is told it has, not the compiled-in default.
        let mut features = crate::css_cascade::MediaFeatures::default();
        if let Some(p) = self.stealth_profile.as_ref() {
            features.width = p.inner_width as f64;
            features.height = p.inner_height as f64;
            features.device_pixel_ratio = p.device_pixel_ratio;
        }
        for css_text in &self.stylesheets {
            let (stylesheet, _errors) = crate::css_parser::parse_stylesheet(css_text);
            // `@media` blocks were skipped entirely: only top-level qualified rules were
            // collected, so every responsive rule — which on a modern site is most of
            // them — was invisible to both getComputedStyle and layout. Matching blocks
            // are flattened in source order, which keeps cascade precedence right.
            let mut flat: Vec<&crate::css_parser::ast::Rule> = Vec::new();
            for rule in &stylesheet.rules {
                match rule {
                    crate::css_parser::ast::Rule::At(at)
                        if at.name.eq_ignore_ascii_case("media")
                            && crate::css_cascade::evaluate_media_query(&at.prelude, &features) =>
                    {
                        if let Some(crate::css_parser::ast::Block::RuleList(inner)) = &at.block {
                            flat.extend(inner.iter());
                        }
                    }
                    other => flat.push(other),
                }
            }
            for rule in flat {
                if let crate::css_parser::ast::Rule::Qualified(qr) = rule {
                    let selector_str = tokens_to_string(&qr.prelude);
                    if selector_str.is_empty() {
                        continue;
                    }
                    let mut declarations = HashMap::new();
                    for d in &qr.declarations {
                        declarations.insert(
                            d.name.to_string(),
                            tokens_to_string(&d.value).trim().to_string(),
                        );
                    }
                    let selectors = crate::css_selectors::parse_selector_list(&selector_str)
                        .unwrap_or_default();
                    self.cached_rules.push(CachedRule {
                        selector_str,
                        selectors,
                        declarations,
                    });
                }
            }
        }
        // Layout resolves its own cascade and needs the same rules; without this the
        // boxes stay at UA defaults while getComputedStyle reports author values.
        let rules = self
            .cached_rules
            .iter()
            .map(|r| crate::css_cascade::StyleRule {
                selectors: r.selectors.clone(),
                declarations: r.declarations.clone(),
            })
            .collect();
        self.layout_engine.set_style_rules(rules);
    }

    pub fn with_base_url(mut self, url: url::Url) -> Self {
        self.base_url = Some(url);
        self
    }
}
