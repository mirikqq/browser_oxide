#!/usr/bin/env python3
"""Generate parity_bootstrap.js: fills in Web API members Chrome has and we lack.

Inputs (all in this scratchpad):
  chrome153_full.json / oxide_full.json               - window realm surfaces
  chrome153_worker_full.json / oxide_worker_full.json - worker realm surfaces
  chrome153_values.json                               - real Chrome getter values
  chrome153_unscopables.json                          - @@unscopables / @@iterator shapes
Output: crates/browser_oxide/src/js_runtime/js/parity_bootstrap.js
"""
import json, pathlib, re, sys

S = pathlib.Path(__file__).parent
OUT = pathlib.Path("/Users/alanmirikov/repo/browser_oxide/crates/browser_oxide/src/js_runtime/js/parity_bootstrap.js")

chrome = json.load(open(S / "chrome153_full.json"))["interfaces"]
oxide = json.load(open(S / "oxide_baseline.json"))["interfaces"]
wchrome = json.load(open(S / "chrome153_worker_full.json"))["interfaces"]
woxide = json.load(open(S / "oxide_worker_baseline.json"))["interfaces"]
values = json.load(open(S / "chrome153_values.json"))
extra = json.load(open(S / "chrome153_unscopables.json"))

NUMERIC = re.compile(
    r"(^|[a-z])(width|height|length|size|count|index|time|times|duration|rate|volume|level|offset|"
    r"top|left|right|bottom|x|y|z|w|delta|scroll|client|screen|page|layer|depth|max|min|start|end|"
    r"position|progress|number|order|span|rows|cols|tab|zoom|opacity|threshold|weight|bits|samples|"
    r"channels|frames|bytes|ratio|value)$", re.I)
BOOLEAN = re.compile(
    r"^(is|has|can|should|allow|use|enable|disable|auto|default|no)[A-Z]|"
    r"^(disabled|hidden|readOnly|required|multiple|muted|loop|open|checked|selected|paused|ended|"
    r"seeking|controls|reversed|async|defer|noModule|inert|draggable|spellcheck|translate|"
    r"autofocus|autoplay|playsInline|novalidate|formNoValidate|complete|active|closed|composed|"
    r"bubbles|cancelable|repeat|shiftKey|ctrlKey|altKey|metaKey|persisted|aborted|visible|"
    r"pending|running|finished|delegatesFocus|clonable|serializable|secure|enabled|writable|"
    r"readable|locked|done|valid|dirty|empty|collapsed|replace|selectionDirection)$")
STRINGY_IFACE = re.compile(r"^(HTML|SVG|CSS|MathML)")
URLISH = re.compile(r"file:///|/values_probe_tmp|/unscop_tmp")


def missing(cm, om):
    """Members Chrome has on this bag and we do not."""
    return {k: v for k, v in cm.items() if k not in om}


def default_for(iface, member, shape, captured):
    if member.startswith("on") and shape.get("s"):
        return None
    if captured:
        kind, v = captured
        if kind == "string":
            return "" if (isinstance(v, str) and URLISH.search(v)) else v
        if kind == "number":
            if v != v or v in (float("inf"), float("-inf")):
                return {"$": "nan"} if v != v else {"$": "inf" if v > 0 else "-inf"}
            return v
        if kind == "boolean":
            return v
        if kind == "array":
            return {"$": "arr"}
        if kind == "object":
            return {"$": "promise"} if v == "Promise" else None
        return None
    if NUMERIC.search(member):
        return 0
    if BOOLEAN.match(member):
        return False
    if shape.get("s") and STRINGY_IFACE.match(iface):
        return ""
    if iface.endswith("Descriptors") or iface.endswith("StyleDeclaration"):
        return ""
    return None


def collect(chrome_ifaces, oxide_ifaces, table, realm):
    for name, spec in chrome_ifaces.items():
        if name not in oxide_ifaces:
            continue
        ours = oxide_ifaces[name]
        entry = table.setdefault(name, {"a": [], "f": [], "sa": [], "sf": [], "t": None,
                                        "it": None, "ait": None, "un": None})
        seen = {}
        for bag in ("a", "f"):
            for e in entry[bag]:
                seen[e[0]] = e
        for member, shape in missing(spec.get("proto", {}), ours.get("proto", {})).items():
            if member in seen:
                # Missing in both realms: drop the realm restriction.
                prev = seen[member]
                if isinstance(prev[-1], str):
                    prev[-1] = prev[-1].replace("w", "").replace("k", "")
                    if not prev[-1]:
                        prev.pop()
                continue
            if member == "@@Symbol.toStringTag":
                entry["t"] = shape.get("v", name)
                continue
            if member == "@@Symbol.asyncIterator":
                entry["ait"] = "entries"
                continue
            if member == "@@Symbol.iterator":
                it = extra["iterators"].get(name) or {}
                entry["it"] = it.get("name", "values")
                continue
            if member == "@@Symbol.unscopables":
                un = extra["unscopables"].get(name)
                if un:
                    entry["un"] = un["keys"]
                continue
            if member.startswith("@@"):
                continue
            flags = realm + ("" if shape.get("e", 1) else "n")
            if shape.get("k") == "fn":
                entry["f"].append([member, shape.get("l", 0)] + ([flags] if flags else []))
            elif shape.get("k") == "acc":
                captured = (values.get(name) or {}).get(member)
                if (name, member) in EXCLUDE:
                    continue
                entry["a"].append([member, 1 if shape.get("s") else 0,
                                   default_for(name, member, shape, captured)]
                                  + ([flags] if flags else []))
        seen_s = {}
        for bag in ("sa", "sf"):
            for e in entry[bag]:
                seen_s[e[0]] = e
        for member, shape in missing(spec.get("static", {}), ours.get("static", {})).items():
            if member in ("length", "name", "prototype") or member.startswith("@@"):
                continue
            if member in seen_s:
                prev = seen_s[member]
                if isinstance(prev[-1], str):
                    prev[-1] = prev[-1].replace("w", "").replace("k", "")
                continue
            flags = realm + ("" if shape.get("e", 1) else "n")
            if shape.get("k") == "fn":
                entry["sf"].append([member, shape.get("l", 0), None, flags])
            elif shape.get("k") == "acc":
                entry["sa"].append([member, 1 if shape.get("s") else 0, None, flags])
            elif shape.get("k") in ("number", "string", "boolean"):
                entry["sf"].append([member, -1, shape.get("v"), flags])


EXCLUDE = set()
excl_path = S / "parity_exclusions.json"
if excl_path.exists():
    EXCLUDE = {tuple(x) for x in json.load(open(excl_path))}

table = {}
collect(chrome, oxide, table, "w")
collect(wchrome, woxide, table, "k")
for spec in table.values():
    for bag in ("a", "f", "sa", "sf"):
        merged = {}
        for item in spec[bag]:
            key = item[0]
            if key in merged:
                prev = merged[key]
                flags = (prev[-1] if isinstance(prev[-1], str) else "")
                cur = (item[-1] if isinstance(item[-1], str) else "")
                both = ("n" if "n" in flags and "n" in cur else "")
                if isinstance(prev[-1], str):
                    prev[-1] = both
                elif both:
                    prev.append(both)
            else:
                merged[key] = list(item)
        spec[bag] = [it for it in merged.values()
                     if not (isinstance(it[-1], str) and it[-1] == "")
                     or it.pop() is None or True]

table = {k: v for k, v in table.items()
         if v["a"] or v["f"] or v["sa"] or v["sf"] or v["t"] or v["it"] or v["ait"] or v["un"]}

payload = json.dumps(table, separators=(",", ":"), ensure_ascii=False)
counts = {
    "interfaces": len(table),
    "accessors": sum(len(v["a"]) for v in table.values()),
    "methods": sum(len(v["f"]) for v in table.values()),
    "statics": sum(len(v["sa"]) + len(v["sf"]) for v in table.values()),
    "tags": sum(1 for v in table.values() if v["t"]),
}
print(counts)
TOLERANT = "--tolerant" in sys.argv
js = """// GENERATED FILE — do not edit by hand.
// Rebuilt by tests/fixtures/chrome153/gen_parity.py from a Chrome 153 capture.
//
// Web IDL members Chrome exposes and this engine does not implement. A missing
// member is as visible to a surface diff as an extra one: every entry here was
// absent from `Object.getOwnPropertyNames(X.prototype)` while Chrome had it.
// Accessor defaults are the values a freshly created instance reports in a real
// Chrome 153 (captured per interface); the rest fall back to the IDL-typed zero
// value. Methods return undefined — they are shape, not behaviour.
//
// Entry format per interface:
//   a:  [name, hasSetter, default, flags?]   prototype accessors
//   f:  [name, length, flags?]               prototype methods
//   sa: [name, hasSetter, default, flags?]   static accessors
//   sf: [name, length|-1, value, flags?]     static methods / constants
// flags: 'w' window-only, 'k' worker-only, 'n' non-enumerable (ECMAScript
// built-ins); absent means "both realms, enumerable" like every IDL member.
//   t:  Symbol.toStringTag value
//   it: name of the method Symbol.iterator aliases
//   ait: name of the method Symbol.asyncIterator aliases
//   un: Symbol.unscopables keys
((globalThis) => {
    'use strict';
    const TABLE = JSON.parse(%s);
    // cleanup_bootstrap.js deletes the masking helper from the global scope, and
    // in a worker this file runs again after cleanup (interfaces the worker
    // layout creates only exist by then), so keep a reference on the internal
    // namespace for that second pass.
    const ns = (() => {
        try {
            const syms = Object.getOwnPropertySymbols(globalThis);
            for (let i = 0; i < syms.length; i++) {
                const v = globalThis[syms[i]];
                if (v && v.__bo) return v;
            }
        } catch (_e) {}
        return null;
    })();
    if (ns && typeof globalThis._maskFunction === 'function' && !ns.parityMask) {
        ns.parityMask = globalThis._maskFunction;
    }
    const mask = typeof globalThis._maskFunction === 'function'
        ? globalThis._maskFunction
        : ((ns && ns.parityMask) || ((fn) => fn));
    // Share the engine's IDL state map, so a member an implementation fills in
    // (`idl.own(obj).startOffset = 2`) reads back through the accessor here.
    const idl = (ns && ns.idl) || null;
    const fallback = new WeakMap();
    const slots = idl || {
        own: (obj) => {
            let st = fallback.get(obj);
            if (!st) fallback.set(obj, (st = { __proto__: null }));
            return st;
        },
        read: (obj, name, def) => {
            const st = fallback.get(obj);
            return st && name in st ? st[name] : def;
        },
    };
    // The worker global's toStringTag is installed later in the boot sequence,
    // so ask the realm about itself instead of about its tag.
    const isWorker = typeof globalThis.importScripts === 'function'
        || (typeof globalThis.WorkerGlobalScope === 'function' && globalThis.window === undefined);
    const wrongRealm = (flags) => (flags === 'w' || flags === 'wn') ? isWorker
        : (flags === 'k' || flags === 'kn') ? !isWorker : false;
    const enumerableOf = (flags) => !(typeof flags === 'string' && flags.indexOf('n') >= 0);
    const valueOf = (def) => {
        if (def !== null && typeof def === 'object') {
            if (def.$ === 'arr') return [];
            if (def.$ === 'promise') return Promise.resolve();
            if (def.$ === 'nan') return NaN;
            if (def.$ === 'inf') return Infinity;
            if (def.$ === '-inf') return -Infinity;
            return null;
        }
        return def;
    };
    const TOLERANT = %%TOLERANT%%;
    const defineAccessor = (target, name, hasSetter, def, ifaceName, flags) => {
        const get = Object.getOwnPropertyDescriptor({
            get [name]() {
                const stored = slots.read(this, name, undefined);
                return stored === undefined ? valueOf(def) : stored;
            },
        }, name).get;
        mask(get, 'get ' + name);
        let set;
        if (hasSetter || TOLERANT) {
            set = Object.getOwnPropertyDescriptor({
                set [name](v) {
                    if (TOLERANT && !hasSetter) {
                        (globalThis.__parityWrites || (globalThis.__parityWrites = []))
                            .push(ifaceName + '.' + name);
                    }
                    slots.own(this)[name] = v;
                },
            }, name).set;
            mask(set, 'set ' + name);
        }
        Object.defineProperty(target, name, {
            get, set, enumerable: enumerableOf(flags), configurable: true,
        });
    };
    const defineMethod = (target, name, length, flags) => {
        const fn = { [name]() {} }[name];
        Object.defineProperty(fn, 'length', { value: length, configurable: true });
        mask(fn, name);
        Object.defineProperty(target, name, {
            value: fn, writable: true, enumerable: enumerableOf(flags), configurable: true,
        });
    };
    const has = Object.prototype.hasOwnProperty;
    for (const name of Object.keys(TABLE)) {
        let C;
        try { C = globalThis[name]; } catch (_e) { continue; }
        if (typeof C !== 'function' || !C.prototype || typeof C.prototype !== 'object') continue;
        const spec = TABLE[name];
        const proto = C.prototype;
        try {
            for (const [member, hasSetter, def, flags] of spec.a) {
                if (wrongRealm(flags) || has.call(proto, member)) continue;
                defineAccessor(proto, member, hasSetter, def, name, flags);
            }
            for (const [member, length, flags] of spec.f) {
                if (wrongRealm(flags) || has.call(proto, member)) continue;
                defineMethod(proto, member, length, flags);
            }
            for (const [member, hasSetter, def, flags] of spec.sa) {
                if (wrongRealm(flags) || has.call(C, member)) continue;
                defineAccessor(C, member, hasSetter, def, name, flags);
            }
            for (const [member, length, value, flags] of spec.sf) {
                if (wrongRealm(flags) || has.call(C, member)) continue;
                if (length === -1) {
                    Object.defineProperty(C, member, {
                        value, writable: false, enumerable: enumerableOf(flags), configurable: false,
                    });
                } else {
                    defineMethod(C, member, length, flags);
                }
            }
            if (spec.t && !has.call(proto, Symbol.toStringTag)) {
                Object.defineProperty(proto, Symbol.toStringTag, {
                    value: spec.t, writable: false, enumerable: false, configurable: true,
                });
            }
            if (spec.it && !has.call(proto, Symbol.iterator)) {
                // Legacy platform collections take Array.prototype.values
                // verbatim; maplike/setlike ones alias their own method.
                const alias = proto[spec.it] || Array.prototype[spec.it];
                if (typeof alias === 'function') {
                    Object.defineProperty(proto, Symbol.iterator, {
                        value: alias, writable: true, enumerable: false, configurable: true,
                    });
                }
            }
            if (spec.ait && !has.call(proto, Symbol.asyncIterator)) {
                const alias = proto[spec.ait];
                if (typeof alias === 'function') {
                    Object.defineProperty(proto, Symbol.asyncIterator, {
                        value: alias, writable: true, enumerable: false, configurable: true,
                    });
                }
            }
            if (spec.un && !has.call(proto, Symbol.unscopables)) {
                const un = { __proto__: null };
                for (const key of spec.un) un[key] = true;
                Object.defineProperty(proto, Symbol.unscopables, {
                    value: un, writable: false, enumerable: false, configurable: true,
                });
            }
        } catch (_e) { /* one bad interface must not stop the rest */ }
    }
})(globalThis);
""" % json.dumps(payload, ensure_ascii=False)
OUT.write_text(js.replace("%TOLERANT%", "true" if TOLERANT else "false"))
print("wrote", OUT, len(js), "bytes")
