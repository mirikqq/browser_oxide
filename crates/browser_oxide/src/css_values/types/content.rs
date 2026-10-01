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
    /// `counter(name, style)`: the innermost counter of that name.
    Counter {
        name: String,
        style: String,
    },
    /// `counters(name, sep, style)`: every counter of that name in scope, outermost
    /// first, joined by `sep`.
    Counters {
        name: String,
        sep: String,
        style: String,
    },
}
