use std::collections::HashMap;
use std::rc::Rc;

pub type CustomProps = Rc<HashMap<String, String>>;

pub fn has_var(text: &str) -> bool {
    text.as_bytes()
        .windows(4)
        .any(|w| w.eq_ignore_ascii_case(b"var("))
}

pub fn substitute(text: &str, lookup: &mut dyn FnMut(&str) -> Option<String>) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        let starts_var = bytes[i..]
            .get(..4)
            .is_some_and(|w| w.eq_ignore_ascii_case(b"var("))
            && (i == 0 || !is_ident_byte(bytes[i - 1]));
        if starts_var {
            let close = closing_paren(bytes, i + 3)?;
            let inner = &text[i + 4..close];
            let (name, fallback) = match inner.split_once(',') {
                Some((n, f)) => (n, Some(f)),
                None => (inner, None),
            };
            let value = match lookup(name.trim()) {
                Some(v) => v,
                None => substitute(fallback?.trim_start(), lookup)?,
            };
            out.push_str(&value);
            i = close + 1;
        } else {
            let ch = text[i..].chars().next()?;
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    Some(out)
}

pub fn inherit(parent: &CustomProps, declared: HashMap<String, String>) -> CustomProps {
    if declared.is_empty() {
        return parent.clone();
    }
    let mut out = (**parent).clone();
    for name in declared.keys() {
        match resolve(name, &declared, parent, &mut Vec::new()) {
            Some(v) => out.insert(name.clone(), v),
            None => out.remove(name),
        };
    }
    Rc::new(out)
}

fn resolve(
    name: &str,
    declared: &HashMap<String, String>,
    parent: &HashMap<String, String>,
    stack: &mut Vec<String>,
) -> Option<String> {
    let Some(raw) = declared.get(name) else {
        return parent.get(name).cloned();
    };
    if stack.iter().any(|n| n == name) {
        return None;
    }
    stack.push(name.to_string());
    let value = substitute(raw, &mut |n| resolve(n, declared, parent, stack));
    stack.pop();
    value
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b >= 0x80
}

fn closing_paren(bytes: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut i = open;
    while i < bytes.len() {
        let b = bytes[i];
        match quote {
            Some(q) => match b {
                b'\\' => i += 1,
                _ if b == q => quote = None,
                _ => {}
            },
            None => match b {
                b'"' | b'\'' => quote = Some(b),
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            },
        }
        i += 1;
    }
    None
}
