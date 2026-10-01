//! The natural size of an image given as a `data:` URL: all that is known of a
//! picture nothing has fetched.

use base64::Engine as _;

/// `(width, height)` in px of the image `url` holds, if it is a `data:` URL of an
/// SVG, PNG or GIF whose size can be read.
pub fn natural_size(url: &str) -> Option<(f32, f32)> {
    let rest = url.trim().strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    let mime = meta.split(';').next()?.to_ascii_lowercase();
    let bytes = if meta.ends_with(";base64") {
        base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .ok()?
    } else {
        percent_encoding::percent_decode_str(payload).collect()
    };
    match mime.as_str() {
        "image/svg+xml" => svg_size(&String::from_utf8_lossy(&bytes)),
        "image/png" if bytes.len() >= 24 => Some((
            u32::from_be_bytes(bytes[16..20].try_into().ok()?) as f32,
            u32::from_be_bytes(bytes[20..24].try_into().ok()?) as f32,
        )),
        "image/gif" if bytes.len() >= 10 => Some((
            u16::from_le_bytes([bytes[6], bytes[7]]) as f32,
            u16::from_le_bytes([bytes[8], bytes[9]]) as f32,
        )),
        _ => None,
    }
}

/// The `width` and `height` of the `<svg>` element, else its `viewBox`.
fn svg_size(text: &str) -> Option<(f32, f32)> {
    let start = text.find("<svg")?;
    let tag = &text[start..start + text[start..].find('>')?];
    let attr = |name: &str| -> Option<&str> {
        let mut from = 0;
        while let Some(i) = tag[from..].find(name) {
            let at = from + i;
            from = at + name.len();
            let before_ok = tag[..at]
                .chars()
                .next_back()
                .is_none_or(|c| c.is_whitespace());
            let rest = tag[from..].trim_start().strip_prefix('=')?.trim_start();
            let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
            let value = &rest[1..];
            if before_ok {
                return value.split(quote).next();
            }
        }
        None
    };
    let number = |v: &str| {
        let v = v.trim();
        (!v.ends_with('%')).then(|| {
            v.trim_end_matches(|c: char| c.is_ascii_alphabetic())
                .parse::<f32>()
                .ok()
        })?
    };
    if let (Some(w), Some(h)) = (
        attr("width").and_then(number),
        attr("height").and_then(number),
    ) {
        return Some((w, h));
    }
    let view: Vec<f32> = attr("viewBox")?
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|p| !p.is_empty())
        .filter_map(|p| p.parse().ok())
        .collect();
    (view.len() == 4).then(|| (view[2], view[3]))
}
