#!/usr/bin/env python3
"""Find every `this.field = ...` in our bootstraps whose interface exposes that
field as a prototype accessor in Chrome. Those members cannot be filled in by
parity_bootstrap.js (a getter-only accessor would make our own constructor throw)."""
import json, pathlib, re

JS = pathlib.Path("/Users/alanmirikov/repo/browser_oxide/crates/browser_oxide/src/js_runtime/js")
S = pathlib.Path(__file__).parent
chrome = json.load(open(S / "chrome153_full.json"))["interfaces"]
wchrome = json.load(open(S / "chrome153_worker_full.json"))["interfaces"]


def _own_readonly(iface):
    out = set()
    for src in (chrome, wchrome):
        spec = src.get(iface)
        if spec:
            for member, shape in spec.get("proto", {}).items():
                if shape.get("k") == "acc" and not shape.get("s"):
                    out.add(member)
    return out


def accessors(iface):
    """Read-only accessors of this interface AND of everything it inherits:
    an implementation assigning `this.baseLatency` conflicts with the accessor
    Chrome puts on AudioContext even when the class is BaseAudioContext."""
    out, seen, name = set(), set(), iface
    while name and name not in seen:
        seen.add(name)
        out |= _own_readonly(name)
        spec = chrome.get(name) or wchrome.get(name) or {}
        name = spec.get("parent")
    # Descendants matter too: the class may be the one Chrome derives from.
    for src in (chrome, wchrome):
        for child, spec in src.items():
            if spec.get("parent") == iface:
                out |= _own_readonly(child)
    return out


def block_end(s, i):
    depth = 0
    while True:
        if s[i] == "{":
            depth += 1
        elif s[i] == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1


conflicts = set()
for path in sorted(JS.glob("*.js")):
    if path.name == "parity_bootstrap.js":
        continue
    src = path.read_text()
    for m in re.finditer(r"(?:class|function)\s+(\w+)\s*(?:extends\s+[\w.]+\s*)?[({]", src):
        name = m.group(1)
        acc = accessors(name)
        if not acc:
            continue
        try:
            start = src.index("{", m.end() - 1)
            body = src[start:block_end(src, start)]
        except (ValueError, IndexError):
            continue
        for field in set(re.findall(r"\bthis\.([A-Za-z_]\w*)\s*=[^=]", body)):
            if field in acc:
                conflicts.add((name, field))
print(len(conflicts), "conflicts")
by = {}
for iface, field in sorted(conflicts):
    by.setdefault(iface, []).append(field)
for k, v in sorted(by.items()):
    print(" ", k, v)
p = S / "parity_exclusions.json"
p.write_text(json.dumps(sorted(conflicts)))
print("total exclusions:", len(conflicts))
