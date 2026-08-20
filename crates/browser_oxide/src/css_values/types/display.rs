/// CSS `display` property values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Display {
    None,
    Block,
    Inline,
    InlineBlock,
    Flex,
    InlineFlex,
    Grid,
    InlineGrid,
    Table,
    InlineTable,
    ListItem,
    FlowRoot,
    Contents,
    TableRow,
    TableCell,
    TableColumn,
    TableColumnGroup,
    TableHeaderGroup,
    TableFooterGroup,
    TableRowGroup,
    TableCaption,
}

/// CSS `position` property values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Position {
    Static,
    Relative,
    Absolute,
    Fixed,
    Sticky,
}

/// CSS `border-style`.
///
/// Needed for geometry, not decoration: a border only occupies space when its
/// style is something other than `none`/`hidden`. The initial `border-width` is
/// `medium` (3px), so applying width unconditionally gave every single element
/// a 3px border on all four sides — every box 6px too wide and 6px too tall,
/// and every position shifted by the accumulated error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BorderStyle {
    None,
    Hidden,
    Solid,
    Dashed,
    Dotted,
    Double,
    Groove,
    Ridge,
    Inset,
    Outset,
}

impl BorderStyle {
    /// Whether a border with this style takes up no space.
    pub fn is_blank(self) -> bool {
        matches!(self, Self::None | Self::Hidden)
    }
}

/// CSS `visibility` property values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    Visible,
    Hidden,
    Collapse,
}

/// CSS `overflow` property values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Overflow {
    Visible,
    Hidden,
    Scroll,
    Auto,
    Clip,
}

/// CSS `box-sizing` property values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoxSizing {
    ContentBox,
    BorderBox,
}

/// CSS `float` property values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Float {
    None,
    Left,
    Right,
    InlineStart,
    InlineEnd,
}

/// CSS `clear` property values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Clear {
    None,
    Left,
    Right,
    Both,
    InlineStart,
    InlineEnd,
}

/// CSS `text-align` property values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextAlign {
    Left,
    Right,
    Center,
    Justify,
    Start,
    End,
}

/// CSS `white-space` property values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhiteSpace {
    Normal,
    Nowrap,
    Pre,
    PreWrap,
    PreLine,
    BreakSpaces,
}

/// CSS `flex-direction` property values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlexDirection {
    Row,
    RowReverse,
    Column,
    ColumnReverse,
}

/// CSS `flex-wrap` property values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlexWrap {
    Nowrap,
    Wrap,
    WrapReverse,
}

/// CSS alignment values (used by align-items, justify-content, etc.).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlignmentValue {
    Normal,
    Stretch,
    Center,
    Start,
    End,
    FlexStart,
    FlexEnd,
    Baseline,
    SpaceBetween,
    SpaceAround,
    SpaceEvenly,
}

/// CSS `content-visibility` property values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentVisibility {
    Visible,
    Hidden,
    Auto,
}
