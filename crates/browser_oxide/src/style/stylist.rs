//! Every style rule the document has, ready to be matched and cascaded.
//!
//! A [`Stylist`] is built from stylesheets and answers one question — which
//! declarations apply to this element, and which of them win. It is the single
//! place the cascade is decided: layout reads its typed answer
//! ([`Stylist::cascade`]) and `getComputedStyle` reads the raw text of the same
//! winner ([`Stylist::winning_raw`]), so the two cannot disagree about which rule
//! won.
//!
//! What it understands: origins (user agent / author), `!important`, the `style`
//! attribute (author origin, above every selector), `@layer` (registration
//! order, unlayered-beats-layered, the reversal for important), `@media` against
//! the profile's viewport, `@supports` (assumed true unless negated), CSS nesting
//! (`&`), and custom properties with `var()` (see `custom.rs`: substituted as
//! text, per element, in the rules that use them). Everything else an at-rule can carry
//! (`@container`, `@scope`, `@font-face`, `@keyframes`, `@import`, …) is skipped.
//!
//! Matching goes through an index on the rightmost compound selector — id, class
//! or tag — so an element is tested only against the rules that could apply to
//! it, not against every rule in the document.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use crate::css_cascade::{
    cascade_sort, compare_keys, evaluate_media_query, evaluate_media_query_strict, CascadeEntry,
    CascadeKey, LayerId, MediaFeatures, Origin,
};
use crate::css_parser::ast::{Block, Declaration, Rule as AstRule};
use crate::css_selectors::{
    compute_specificity, matches_selector, parse_selector_list, Component, SelectorList,
    SimpleSelector, Specificity,
};
use crate::css_values::property::{CssValue, PropertyDeclaration, PropertyId};
use crate::dom::element::DomElement;
use crate::dom::node::{NodeData, NodeId};
use crate::dom::Dom;
use crate::js_runtime::utils::tokens_to_string;
use crate::style::custom::{self, CustomProps};

/// The user-agent stylesheet, see `ua.css`.
const UA_CSS: &str = include_str!("ua.css");

/// What `LayoutMode::Full` adds, see `ua_full.css`.
const UA_FULL_CSS: &str = include_str!("ua_full.css");

/// Order given to presentational hints: above every rule of the user-agent sheet,
/// below every author rule (the origin sees to the latter).
pub const HINT_ORDER: u32 = 1_000_000;

/// A declaration as written, before it was turned into a typed value. This is what
/// `getComputedStyle` serialises from.
#[derive(Debug, Clone)]
pub struct RawDecl {
    /// Lowercased property name.
    pub name: String,
    pub value: String,
    pub important: bool,
}

/// One style rule: selectors, and the declarations they apply.
#[derive(Debug, Clone)]
pub struct Rule {
    pub selectors: SelectorList,
    /// Declarations as typed longhands, in source order.
    pub decls: Vec<PropertyDeclaration>,
    /// The same declarations as written.
    pub raw: Vec<RawDecl>,
    pub origin: Origin,
    pub layer: Option<LayerId>,
    /// Position in the document's rules; later wins a tie.
    pub order: u32,
    pub dynamic: bool,
}

#[derive(Debug, Clone, Default)]
struct Buckets {
    by_id: HashMap<String, Vec<u32>>,
    by_class: HashMap<String, Vec<u32>>,
    by_tag: HashMap<String, Vec<u32>>,
    universal: Vec<u32>,
}

/// All the document's style rules.
#[derive(Debug, Clone)]
pub struct Stylist {
    rules: Arc<Vec<Rule>>,
    buckets: Arc<Buckets>,
    layers: Arc<HashMap<String, LayerId>>,
    media: MediaFeatures,
    /// Built for `LayoutMode::Full`: `@media` is evaluated to the letter of the spec,
    /// and the table attributes of old markup act as style.
    full: bool,
}

/// The user-agent rules, parsed once for the process.
static UA_STYLIST: LazyLock<Stylist> = LazyLock::new(|| {
    let mut s = Stylist::empty(MediaFeatures::default());
    s.add_stylesheet(UA_CSS, Origin::UserAgent);
    s
});

static UA_FULL_STYLIST: LazyLock<Stylist> = LazyLock::new(|| {
    let mut s = Stylist::empty(MediaFeatures::default());
    s.add_stylesheet(UA_CSS, Origin::UserAgent);
    s.add_stylesheet(UA_FULL_CSS, Origin::UserAgent);
    s
});

impl Stylist {
    fn empty(media: MediaFeatures) -> Self {
        Self {
            rules: Arc::default(),
            buckets: Arc::default(),
            layers: Arc::default(),
            media,
            full: false,
        }
    }

    /// A stylist holding only the user-agent stylesheet. `media` decides which
    /// `@media` blocks of author sheets added later apply.
    pub fn new(media: MediaFeatures) -> Self {
        let mut s = UA_STYLIST.clone();
        s.media = media;
        s
    }

    /// [`Stylist::new`] for a layout mode: `Full` adds the table rules to the
    /// user-agent sheet.
    pub fn for_mode(media: MediaFeatures, mode: crate::layout::LayoutMode) -> Self {
        let mut s = match mode {
            crate::layout::LayoutMode::Full => UA_FULL_STYLIST.clone(),
            crate::layout::LayoutMode::Legacy => UA_STYLIST.clone(),
        };
        s.media = media;
        s.full = mode == crate::layout::LayoutMode::Full;
        s
    }

    /// Whether this stylist was built for `LayoutMode::Full`.
    pub fn is_full(&self) -> bool {
        self.full
    }

    pub fn rule_count(&self) -> usize {
        self.rules.len()
    }

    pub fn media(&self) -> &MediaFeatures {
        &self.media
    }

    /// Parse `css` and add its rules, after everything already added.
    pub fn add_stylesheet(&mut self, css: &str, origin: Origin) {
        let (sheet, _errors) = crate::css_parser::parse_stylesheet(css);
        self.walk(&sheet.rules, origin, None, "", None);
    }

    fn layer_id(&mut self, full_name: &str) -> LayerId {
        if let Some(id) = self.layers.get(full_name) {
            return *id;
        }
        // Ids are handed out in registration order, which is the order the
        // cascade sorts layers by.
        let id = self.layers.len() as LayerId + 1;
        Arc::make_mut(&mut self.layers).insert(full_name.to_string(), id);
        id
    }

    fn walk(
        &mut self,
        rules: &[AstRule<'_>],
        origin: Origin,
        layer: Option<LayerId>,
        layer_path: &str,
        parent: Option<&str>,
    ) {
        for rule in rules {
            match rule {
                AstRule::Qualified(qr) => {
                    let text = tokens_to_string(&qr.prelude);
                    let text = text.trim();
                    if text.is_empty() {
                        continue;
                    }
                    let selector = match parent {
                        Some(p) => resolve_nested(p, text),
                        None => text.to_string(),
                    };
                    self.add_block(
                        &selector,
                        &qr.declarations,
                        &qr.rules,
                        origin,
                        layer,
                        layer_path,
                    );
                }
                AstRule::At(at) => {
                    let prelude = tokens_to_string(&at.prelude);
                    let prelude = prelude.trim();
                    match at.name.to_ascii_lowercase().as_str() {
                        "media" => {
                            let matches = if self.full {
                                evaluate_media_query_strict(&at.prelude, &self.media)
                            } else {
                                evaluate_media_query(&at.prelude, &self.media)
                            };
                            if matches {
                                self.walk_block(
                                    at.block.as_ref(),
                                    origin,
                                    layer,
                                    layer_path,
                                    parent,
                                );
                            }
                        }
                        "supports" => {
                            if !prelude.to_ascii_lowercase().starts_with("not") {
                                self.walk_block(
                                    at.block.as_ref(),
                                    origin,
                                    layer,
                                    layer_path,
                                    parent,
                                );
                            }
                        }
                        "layer" => {
                            self.add_layer(prelude, at.block.as_ref(), origin, layer_path, parent)
                        }
                        // @container, @scope, @starting-style, @font-face,
                        // @keyframes, @import, @property, …: not style rules for
                        // the elements themselves, or not understood yet.
                        _ => {}
                    }
                }
            }
        }
    }

    /// The contents of a conditional at-rule, in the context of its parent.
    fn walk_block(
        &mut self,
        block: Option<&Block<'_>>,
        origin: Origin,
        layer: Option<LayerId>,
        layer_path: &str,
        parent: Option<&str>,
    ) {
        match block {
            Some(Block::RuleList(inner)) => self.walk(inner, origin, layer, layer_path, parent),
            Some(Block::DeclarationBlock {
                declarations,
                rules,
            }) => {
                // Inside a style rule, `@media { color: red }` declares for that rule.
                if let Some(p) = parent {
                    self.add_block(p, declarations, rules, origin, layer, layer_path);
                } else {
                    self.walk(rules, origin, layer, layer_path, None);
                }
            }
            None => {}
        }
    }

    fn add_layer(
        &mut self,
        prelude: &str,
        block: Option<&Block<'_>>,
        origin: Origin,
        layer_path: &str,
        parent: Option<&str>,
    ) {
        let join = |name: &str| {
            if layer_path.is_empty() {
                name.to_string()
            } else {
                format!("{layer_path}.{name}")
            }
        };
        match block {
            // `@layer a, b;` only fixes the order of the names.
            None => {
                for name in prelude.split(',').map(str::trim).filter(|n| !n.is_empty()) {
                    self.layer_id(&join(name));
                }
            }
            // `@layer a { … }` (or anonymous: `@layer { … }`, a layer of its own).
            //
            // Nested layers are registered flat, in first-seen order. A rule
            // written directly in `a` therefore ranks below `a.b`, where the spec
            // ranks it above.
            Some(block) => {
                let name = if prelude.is_empty() {
                    format!("<anonymous {}>", self.layers.len())
                } else {
                    prelude.to_string()
                };
                let full = join(&name);
                let id = self.layer_id(&full);
                self.walk_block(Some(block), origin, Some(id), &full, parent);
            }
        }
    }

    /// Add the rule `selector { declarations }`, then its nested rules.
    fn add_block(
        &mut self,
        selector: &str,
        declarations: &[crate::css_parser::ast::Declaration<'_>],
        nested: &[AstRule<'_>],
        origin: Origin,
        layer: Option<LayerId>,
        layer_path: &str,
    ) {
        if !declarations.is_empty() {
            let mut decls = Vec::new();
            let mut raw = Vec::new();
            for d in declarations {
                raw.push(raw_decl(d));
                if let Ok(props) = crate::css_values::parse_property(d.name, &d.value, d.important)
                {
                    decls.extend(props);
                }
            }
            let dynamic = raw
                .iter()
                .any(|d| d.name.starts_with("--") || custom::has_var(&d.value));
            if let Ok(selectors) = parse_selector_list(selector) {
                let index = self.rules.len() as u32;
                if self.index_rule(index, &selectors) {
                    Arc::make_mut(&mut self.rules).push(Rule {
                        selectors,
                        decls,
                        raw,
                        origin,
                        layer,
                        order: index,
                        dynamic,
                    });
                }
            }
        }
        if !nested.is_empty() {
            self.walk(nested, origin, layer, layer_path, Some(selector));
        }
    }

    /// Register `selectors` in the lookup buckets under the rule index `index`.
    /// Returns false, registering nothing, if no selector can match an element
    /// (every one of them ends in a pseudo-element).
    fn index_rule(&mut self, index: u32, selectors: &SelectorList) -> bool {
        let buckets = Arc::make_mut(&mut self.buckets);
        let mut any = false;
        for sel in selectors {
            let components = sel.components();
            if components
                .iter()
                .any(|c| matches!(c, Component::Simple(SimpleSelector::PseudoElement(_))))
            {
                continue;
            }
            any = true;
            // Components run right to left: the key compound is everything up to
            // the first combinator.
            let compound: Vec<&SimpleSelector> = components
                .iter()
                .take_while(|c| !matches!(c, Component::Combinator(_)))
                .filter_map(|c| match c {
                    Component::Simple(s) => Some(s),
                    Component::Combinator(_) => None,
                })
                .collect();
            let bucket = if let Some(SimpleSelector::Id(id)) =
                compound.iter().find(|s| matches!(s, SimpleSelector::Id(_)))
            {
                buckets.by_id.entry(id.clone()).or_default()
            } else if let Some(SimpleSelector::Class(c)) = compound
                .iter()
                .find(|s| matches!(s, SimpleSelector::Class(_)))
            {
                buckets.by_class.entry(c.clone()).or_default()
            } else if let Some(SimpleSelector::Type(t)) = compound
                .iter()
                .find(|s| matches!(s, SimpleSelector::Type(_)))
            {
                buckets.by_tag.entry(t.to_ascii_lowercase()).or_default()
            } else {
                &mut buckets.universal
            };
            if bucket.last() != Some(&index) {
                bucket.push(index);
            }
        }
        any
    }

    /// Indices of the rules that could apply to `node`, ascending.
    fn candidates(&self, dom: &Dom, node: NodeId) -> Vec<u32> {
        let Some(NodeData::Element(elem)) = dom.get(node).map(|n| &n.data) else {
            return Vec::new();
        };
        let mut out: Vec<u32> = self.buckets.universal.clone();
        if let Some(v) = self
            .buckets
            .by_tag
            .get(&elem.name.local.to_ascii_lowercase())
        {
            out.extend_from_slice(v);
        }
        for attr in &elem.attrs {
            match &*attr.name.local {
                "id" => {
                    if let Some(v) = self.buckets.by_id.get(attr.value.as_str()) {
                        out.extend_from_slice(v);
                    }
                }
                "class" => {
                    for class in attr.value.split_ascii_whitespace() {
                        if let Some(v) = self.buckets.by_class.get(class) {
                            out.extend_from_slice(v);
                        }
                    }
                }
                _ => {}
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// The rules that match `node`, each with its highest matching specificity.
    fn matching<'a>(
        &'a self,
        dom: &'a Dom,
        node: NodeId,
    ) -> impl Iterator<Item = (&'a Rule, Specificity)> {
        let element = DomElement::new(dom, node);
        let candidates = if element.is_some() {
            self.candidates(dom, node)
        } else {
            Vec::new()
        };
        candidates.into_iter().filter_map(move |i| {
            let element = element.as_ref()?;
            let rule = &self.rules[i as usize];
            rule.selectors
                .iter()
                .filter(|sel| matches_selector(element, sel))
                .map(compute_specificity)
                .max()
                .map(|spec| (rule, spec))
        })
    }

    /// The cascaded value of every property for `node`: the winner of each
    /// property among the matching rules, the `style` attribute and `extra`
    /// (presentational hints). Custom properties are not inherited here; see
    /// [`Stylist::cascade_with_custom`].
    pub fn cascade(
        &self,
        dom: &Dom,
        node: NodeId,
        extra: Vec<CascadeEntry>,
    ) -> HashMap<PropertyId, CssValue> {
        self.cascade_with_custom(dom, node, extra, &CustomProps::default())
            .0
    }

    /// [`Stylist::cascade`], with `var()` resolved against the custom properties
    /// the element inherits (`inherited`) and declares itself. Also returns the
    /// element's custom properties, for its children to inherit.
    pub fn cascade_with_custom(
        &self,
        dom: &Dom,
        node: NodeId,
        extra: Vec<CascadeEntry>,
        inherited: &CustomProps,
    ) -> (HashMap<PropertyId, CssValue>, CustomProps) {
        let mut entries = extra;
        let mut dynamic: Vec<(CascadeKey, RawDecl)> = Vec::new();
        for (rule, specificity) in self.matching(dom, node) {
            if rule.dynamic {
                for d in &rule.raw {
                    let key = CascadeKey {
                        important: d.important,
                        origin: rule.origin,
                        layer: rule.layer,
                        specificity,
                        source_order: rule.order,
                    };
                    dynamic.push((key, d.clone()));
                }
                continue;
            }
            for decl in &rule.decls {
                entries.push(CascadeEntry {
                    declaration: decl.clone(),
                    origin: rule.origin,
                    layer: rule.layer,
                    specificity,
                    source_order: rule.order,
                });
            }
        }
        dynamic.extend(
            inline_decls(dom, node)
                .into_iter()
                .map(|d| (inline_key(d.important), d)),
        );
        dynamic.sort_by(|a, b| compare_keys(&a.0, &b.0));

        let declared: HashMap<String, String> = dynamic
            .iter()
            .filter(|(_, d)| d.name.starts_with("--"))
            .map(|(_, d)| (d.name.clone(), d.value.clone()))
            .collect();
        let props = custom::inherit(inherited, declared);

        for (key, d) in dynamic.iter().filter(|(_, d)| !d.name.starts_with("--")) {
            let Some(value) = custom::substitute(&d.value, &mut |n| props.get(n).cloned()) else {
                continue;
            };
            let important = if d.important { " !important" } else { "" };
            let text = format!("{}:{}{}", d.name, value, important);
            for declaration in parse_inline_style(&text) {
                entries.push(CascadeEntry {
                    declaration,
                    origin: key.origin,
                    layer: key.layer,
                    specificity: key.specificity,
                    source_order: key.source_order,
                });
            }
        }
        (cascade_sort(&mut entries), props)
    }

    /// Every declaration that applies to `node`, as written, weakest first: the
    /// last one to set a property is its cascade winner. Shorthands are left
    /// unexpanded, in the order they were written, so a caller that expands them
    /// as it goes gets later-beats-earlier right within a rule too. The `style`
    /// attribute is included, ranked as the cascade ranks it.
    pub fn matching_declarations(&self, dom: &Dom, node: NodeId) -> Vec<RawDecl> {
        let mut found: Vec<(CascadeKey, usize, RawDecl)> = Vec::new();
        for (rule, specificity) in self.matching(dom, node) {
            for decl in &rule.raw {
                let key = CascadeKey {
                    important: decl.important,
                    origin: rule.origin,
                    layer: rule.layer,
                    specificity,
                    source_order: rule.order,
                };
                found.push((key, found.len(), decl.clone()));
            }
        }
        for decl in inline_decls(dom, node) {
            found.push((inline_key(decl.important), found.len(), decl));
        }
        // The running index keeps written order among declarations of one rule.
        found.sort_by(|a, b| compare_keys(&a.0, &b.0).then(a.1.cmp(&b.1)));
        found.into_iter().map(|(_, _, d)| d).collect()
    }

    /// The text of the winning declaration of `name` (a CSS property name as
    /// written, lowercase) from the style rules and the `style` attribute, or
    /// `None` if nothing sets it. Ordered by the same comparison as
    /// [`Stylist::cascade`]. The text is as written: a `var()` in it is not
    /// resolved here.
    ///
    /// Shorthands are not expanded: asking for `margin-top` finds only rules that
    /// wrote `margin-top`.
    pub fn winning_raw(&self, dom: &Dom, node: NodeId, name: &str) -> Option<String> {
        let mut found: Vec<(CascadeKey, String)> = Vec::new();
        for (rule, specificity) in self.matching(dom, node) {
            for decl in rule.raw.iter().filter(|d| d.name == name) {
                let key = CascadeKey {
                    important: decl.important,
                    origin: rule.origin,
                    layer: rule.layer,
                    specificity,
                    source_order: rule.order,
                };
                found.push((key, decl.value.clone()));
            }
        }
        for decl in inline_decls(dom, node)
            .into_iter()
            .filter(|d| d.name == name)
        {
            found.push((inline_key(decl.important), decl.value));
        }
        // Stable, ascending, so among equals the later declaration is last.
        found.sort_by(|a, b| compare_keys(&a.0, &b.0));
        found.pop().map(|(_, v)| v)
    }
}

fn raw_decl(d: &Declaration<'_>) -> RawDecl {
    RawDecl {
        name: if d.name.starts_with("--") {
            d.name.to_string()
        } else {
            d.name.to_ascii_lowercase()
        },
        value: tokens_to_string(&d.value).trim().to_string(),
        important: d.important,
    }
}

fn inline_decls(dom: &Dom, node: NodeId) -> Vec<RawDecl> {
    let Some(NodeData::Element(elem)) = dom.get(node).map(|n| &n.data) else {
        return Vec::new();
    };
    let Some(attr) = elem
        .attrs
        .iter()
        .find(|a| a.name.local.eq_ignore_ascii_case("style"))
    else {
        return Vec::new();
    };
    let (decls, _) = crate::css_parser::parse_declaration_list(&attr.value);
    decls
        .iter()
        .map(raw_decl)
        .filter(|d| !d.value.is_empty())
        .collect()
}

fn inline_key(important: bool) -> CascadeKey {
    CascadeKey {
        important,
        origin: Origin::Author,
        layer: None,
        specificity: Specificity::new(u32::MAX, 0, 0),
        source_order: u32::MAX,
    }
}

/// `parent { nested }` as a single selector: each comma-separated part of
/// `nested` with `&` replaced by the parent, or, without an `&`, the parent as an
/// ancestor.
fn resolve_nested(parent: &str, nested: &str) -> String {
    let scope = format!(":is({parent})");
    let mut parts = Vec::new();
    let (mut depth, mut start) = (0i32, 0usize);
    for (i, ch) in nested.char_indices() {
        match ch {
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(&nested[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&nested[start..]);
    parts
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(|p| {
            if p.contains('&') {
                p.replace('&', &scope)
            } else {
                format!("{scope} {p}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Parse the text of a `style` attribute into typed declarations.
pub fn parse_inline_style(style: &str) -> Vec<PropertyDeclaration> {
    let (decls, _) = crate::css_parser::parse_declaration_list(style);
    let mut out = Vec::new();
    for d in &decls {
        if let Ok(props) = crate::css_values::parse_property(d.name, &d.value, d.important) {
            out.extend(props);
        }
    }
    out
}

/// Cascade entries for declarations that do not come from a rule.
pub(crate) fn entries_for(
    decls: impl IntoIterator<Item = PropertyDeclaration>,
    origin: Origin,
    specificity: Specificity,
    source_order: u32,
) -> Vec<CascadeEntry> {
    decls
        .into_iter()
        .map(|declaration| CascadeEntry {
            declaration,
            origin,
            layer: None,
            specificity,
            source_order,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::css_values::types::color::Color;
    use crate::html_parser::parse_html;

    fn find(dom: &Dom, id: &str) -> NodeId {
        dom.get_element_by_id(id).expect("element")
    }

    fn color_of(map: &HashMap<PropertyId, CssValue>) -> Option<(u8, u8, u8)> {
        match map.get(&PropertyId::Color) {
            Some(CssValue::Color(Color::Rgba { r, g, b, .. })) => Some((*r, *g, *b)),
            _ => None,
        }
    }

    fn stylist(css: &str) -> Stylist {
        let mut s = Stylist::new(MediaFeatures::default());
        s.add_stylesheet(css, Origin::Author);
        s
    }

    #[test]
    fn specificity_beats_source_order() {
        let dom = parse_html("<p id=a class=c>x</p>");
        let s = stylist("#a{color:rgb(1,0,0)} .c{color:rgb(2,0,0)} p{color:rgb(3,0,0)}");
        let c = s.cascade(&dom, find(&dom, "a"), vec![]);
        assert_eq!(color_of(&c), Some((1, 0, 0)));
    }

    #[test]
    fn later_rule_wins_a_tie() {
        let dom = parse_html("<p id=a>x</p>");
        let s = stylist("p{color:rgb(1,0,0)} p{color:rgb(2,0,0)}");
        assert_eq!(
            color_of(&s.cascade(&dom, find(&dom, "a"), vec![])),
            Some((2, 0, 0))
        );
    }

    #[test]
    fn important_beats_specificity() {
        let dom = parse_html("<p id=a>x</p>");
        let s = stylist("p{color:rgb(1,0,0) !important} #a{color:rgb(2,0,0)}");
        assert_eq!(
            color_of(&s.cascade(&dom, find(&dom, "a"), vec![])),
            Some((1, 0, 0))
        );
    }

    #[test]
    fn author_beats_user_agent_and_ua_applies_alone() {
        let dom = parse_html("<h1 id=a>x</h1><div id=b>y</div>");
        let s = stylist("div{display:flex}");
        let h1 = s.cascade(&dom, find(&dom, "a"), vec![]);
        assert_eq!(
            h1.get(&PropertyId::Display),
            Some(&CssValue::Display(
                crate::css_values::types::display::Display::Block
            ))
        );
        let div = s.cascade(&dom, find(&dom, "b"), vec![]);
        assert_eq!(
            div.get(&PropertyId::Display),
            Some(&CssValue::Display(
                crate::css_values::types::display::Display::Flex
            ))
        );
    }

    #[test]
    fn unlayered_beats_layered_and_later_layer_beats_earlier() {
        let dom = parse_html("<p id=a>x</p><p id=b>y</p>");
        let s = stylist(
            "@layer base, theme;\
             @layer theme { p{color:rgb(2,0,0)} }\
             @layer base { p{color:rgb(1,0,0)} }\
             #b{color:rgb(9,0,0)}",
        );
        assert_eq!(
            color_of(&s.cascade(&dom, find(&dom, "a"), vec![])),
            Some((2, 0, 0)),
            "theme is declared after base"
        );
        assert_eq!(
            color_of(&s.cascade(&dom, find(&dom, "b"), vec![])),
            Some((9, 0, 0))
        );
        let s = stylist("@layer a { #a{color:rgb(1,0,0)} } p{color:rgb(5,0,0)}");
        assert_eq!(
            color_of(&s.cascade(&dom, find(&dom, "a"), vec![])),
            Some((5, 0, 0)),
            "unlayered wins even against higher specificity"
        );
    }

    #[test]
    fn media_blocks_follow_the_viewport() {
        let dom = parse_html("<p id=a>x</p>");
        let narrow = MediaFeatures {
            width: 400.0,
            ..Default::default()
        };
        let mut s = Stylist::new(narrow);
        s.add_stylesheet(
            "@media (min-width: 800px){p{color:rgb(1,0,0)}} @media (max-width: 500px){p{color:rgb(2,0,0)}}",
            Origin::Author,
        );
        assert_eq!(
            color_of(&s.cascade(&dom, find(&dom, "a"), vec![])),
            Some((2, 0, 0))
        );
    }

    #[test]
    fn nesting_with_and_without_ampersand() {
        let dom = parse_html("<div id=o><p id=a class=k>x</p></div>");
        let s = stylist("#o { .k { color: rgb(1,0,0) } p& { } }");
        assert_eq!(
            color_of(&s.cascade(&dom, find(&dom, "a"), vec![])),
            Some((1, 0, 0))
        );
    }

    #[test]
    fn pseudo_element_rules_do_not_style_the_element() {
        let dom = parse_html("<p id=a>x</p>");
        let s = stylist("p::before{color:rgb(1,0,0)}");
        assert_eq!(color_of(&s.cascade(&dom, find(&dom, "a"), vec![])), None);
    }

    #[test]
    fn raw_winner_uses_the_same_order() {
        let dom = parse_html("<p id=a>x</p>");
        let s = stylist("p{width:10px !important} #a{width:20px}");
        assert_eq!(
            s.winning_raw(&dom, find(&dom, "a"), "width").as_deref(),
            Some("10px")
        );
        assert_eq!(s.winning_raw(&dom, find(&dom, "a"), "height"), None);
    }

    #[test]
    fn resolve_nested_splits_top_level_commas() {
        assert_eq!(
            resolve_nested(".p", "a, &:hover, :is(b, c)"),
            ":is(.p) a, :is(.p):hover, :is(.p) :is(b, c)"
        );
    }
}
