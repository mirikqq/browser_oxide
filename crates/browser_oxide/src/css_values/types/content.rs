/// One piece of a `content` value.
#[derive(Debug, Clone, PartialEq)]
pub enum ContentItem {
    Str(String),
    /// `attr(name)`: the element's attribute, as text.
    Attr(String),
    /// `url(...)`: an image; with nothing loaded it is an empty replaced box.
    Url(String),
    OpenQuote,
    CloseQuote,
    NoOpenQuote,
    NoCloseQuote,
    /// `counter(name)` and `counters(name, sep)`; counters are not tracked yet, so
    /// layout puts nothing in their place.
    Counter(String),
}
