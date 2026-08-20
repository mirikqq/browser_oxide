// Strict API mode — a debug-only probe that names the web-platform surface a
// page reaches for and this engine does not implement.
//
// V8 gives us ECMAScript and nothing else; every DOM/HTML/WebIDL member is
// hand-written here, so any gap shows up as a property that simply reads
// `undefined`. That failure is silent: a page calling a method we never wrote
// throws deep inside its own bundle, or — worse — feature-detects, takes a
// fallback path, and renders nothing. Both look like "the page is broken",
// never like "the engine is missing `getElementsByName`".
//
// The trick: a missing property is by definition NOT an own property, so the
// lookup walks the prototype chain. Splicing a Proxy in at the *end* of each
// chain gives a `get`/`has` trap that fires only on misses — real members are
// found before the walk ever reaches us, so nothing observable changes for
// code that stays inside the implemented surface.
//
// Enabled by `BROWSER_OXIDE_STRICT_API=1`; never injected otherwise, because
// the spliced prototypes are themselves observable.
((globalThis) => {
    const _ns = (function () {
        try {
            const syms = Object.getOwnPropertySymbols(globalThis);
            for (let i = 0; i < syms.length; i++) {
                const v = globalThis[syms[i]];
                if (v && v.__bo) return v;
            }
        } catch (_e) { /* ignore */ }
        return null;
    })();
    if (!_ns || _ns.strict) return;

    const misses = new Map();

    // Names every page touches for feature detection, where a miss is the
    // correct answer rather than a gap. Logging them would bury the signal.
    const expected = new Set([
        "webdriver", "__nightmare", "_phantom", "callPhantom", "domAutomation",
        "domAutomationController", "_Selenium_IDE_Recorder", "__selenium_unwrapped",
        "__webdriver_evaluate", "__driver_evaluate", "__playwright", "__pw_manual",
        "then", "toJSON", "inspect", "Symbol(Symbol.toPrimitive)",
        "Symbol(nodejs.util.inspect.custom)", "$$typeof", "@@iterator",
    ]);

    const note = (where, prop) => {
        try {
            if (typeof prop !== "string") return;
            if (prop.startsWith("__react") || prop.startsWith("__vue")) return;
            if (expected.has(prop)) return;
            const key = `${where}.${prop}`;
            misses.set(key, (misses.get(key) || 0) + 1);
        } catch (_e) { /* never throw out of a trap */ }
    };

    /// Splice a logging Proxy in as `holder`'s prototype. `holder` is the last
    /// object of the chain we care about, so anything not found by the time the
    /// walk reaches it is a genuine miss.
    const watch = (holder, where) => {
        try {
            if (!holder) return;
            const upstream = Object.getPrototypeOf(holder);
            if (!upstream) return;
            Object.setPrototypeOf(holder, new Proxy(upstream, {
                get(target, prop, receiver) {
                    if (!(prop in target)) note(where, prop);
                    return Reflect.get(target, prop, receiver);
                },
                has(target, prop) {
                    const found = Reflect.has(target, prop);
                    if (!found) note(where, prop);
                    return found;
                },
            }));
        } catch (_e) { /* ignore */ }
    };

    // `globalThis` itself cannot be proxied, but its prototype can — and a
    // missing window member is never an own property of the global.
    watch(globalThis, "window");
    if (globalThis.Document) watch(globalThis.Document.prototype, "document");
    if (globalThis.Navigator) watch(globalThis.Navigator.prototype, "navigator");
    // Element sits below HTMLElement and every HTML*Element, so one splice here
    // covers the whole element surface.
    if (globalThis.Element) watch(globalThis.Element.prototype, "element");
    if (globalThis.CSSStyleDeclaration) {
        watch(globalThis.CSSStyleDeclaration.prototype, "style");
    }

    const report = () => {
        const rows = [...misses.entries()].sort((a, b) => b[1] - a[1]);
        if (!rows.length) return "strict: пробелов не найдено";
        return "strict: не реализовано (" + rows.length + ")\n"
            + rows.map(([k, n]) => `  ${k}  ×${n}`).join("\n");
    };

    _ns.strict = { misses, report };
    // The host prints this at the end of a navigation; a page can neither see
    // the namespace nor the timer.
    try {
        setTimeout(() => { try { console.log(report()); } catch (_e) { /* ignore */ } }, 3000);
    } catch (_e) { /* ignore */ }
})(globalThis);
