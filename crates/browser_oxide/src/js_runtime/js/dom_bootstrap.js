((globalThis) => {
    const core = Deno.core;
    const ops = core.ops;

    // Everything the host injects later needs a handle, and a string-named
    // global is the loudest possible way to provide one: `__bo_*` shows up in
    // `Object.getOwnPropertyNames(window)`, which is the first thing a
    // fingerprinting script enumerates, and non-enumerable does not help —
    // that method lists non-enumerable properties too. A symbol key does not
    // appear there at all; only `getOwnPropertySymbols` sees it, and that is
    // far less commonly walked.
    //
    // Host scripts find it by scanning symbols for the `__bo` marker, so the
    // description carries no meaning and can stay empty.
    // Get-or-create: an earlier bootstrap may already have installed it, and two
    // namespaces would mean two symbols on the global where Chrome has none.
    const _boNs = (function () {
        try {
            const syms = Object.getOwnPropertySymbols(globalThis);
            for (let i = 0; i < syms.length; i++) {
                const v = globalThis[syms[i]];
                if (v && v.__bo) return v;
            }
        } catch (_) { /* ignore */ }
        const ns = { __bo: true };
        try {
            Object.defineProperty(globalThis, Symbol(""), {
                value: ns, writable: false, configurable: true, enumerable: false,
            });
        } catch (_) { /* ignore */ }
        return ns;
    })();

    // `_ADOPT` separates the two callers: the page constructs a new node, while
    // `_wrapNodeWithType` adopts one that already exists in the arena.
    const _ADOPT = Symbol("adopt");

    const _nodeIds = new WeakMap();
    const _nodeCache = new Map();
    const _scrollState = new Map(); // nodeId -> {top, left}

    function _getNodeId(node) {
        if (node === null || node === undefined) return -1;
        if (node === globalThis || node === globalThis.window) return -999;
        // WeakMap.get on a non-object returns undefined per spec — no throw.
        const id = _nodeIds.get(node);
        if (id === undefined) {
            // node is not a registered DOM node. Returning 0 (the DOCUMENT
            // id) here used to be a "resilience" default, but it caused
            // every appendChild(weirdValue) to surface as
            // appendChild(parent, document) → cycle assertion fires.
            // -1 makes the Rust op layer's `dom.get(NodeId(u32::MAX))` miss
            // and silently no-op, which is the right behaviour for a JS
            // mutation against a non-node argument.
            return -1;
        }
        return id;
    }

    function _wrapNode(nodeId) {
        if (nodeId === null || nodeId === undefined || nodeId === -1) return null;
        const cached = _nodeCache.get(nodeId);
        if (cached) {
            const obj = cached.deref();
            if (obj) return obj;
        }
        const nodeType = ops.op_dom_get_node_type(nodeId);
        return _wrapNodeWithType(nodeId, nodeType);
    }

    function _wrapNodeWithType(nodeId, nodeType) {
        if (nodeId === null || nodeId === undefined || nodeId === -1) return null;
        const cached = _nodeCache.get(nodeId);
        if (cached) {
            const obj = cached.deref();
            if (obj) return obj;
        }
        let node;
        switch (nodeType) {
            case 1:
                node = new Element(nodeId);
                _retargetElementProto(node);
                break;
            case 3: node = new Text(nodeId, _ADOPT); break;
            case 8: node = new Comment(nodeId, _ADOPT); break;
            case 9: node = _document; break;
            case 11: node = new DocumentFragment(nodeId, _ADOPT); break;
            default: node = new Node(nodeId); break;
        }
        _nodeCache.set(nodeId, new WeakRef(node));
        return node;
    }

    // Tracks base URLs (query-stripped) of scripts currently being sync-fetched.
    // Guards against re-entrant fetch loops: e.g. Yandex Metrika's bootstrap IIFE
    // inserts a new <script src="tag.js?timestamp"> while tag.js is still being
    // evaluated. Without this guard the fetch recurses infinitely.
    const _syncFetchInFlight = new Set();

    // Tracks nesting depth of sync eval chains. Each _onNodeInserted call that
    // fetches+evals a script increments this. Scripts beyond MAX nesting are
    // degraded to async — prevents C++ stack overflow when deeply-nested
    // third-party SDKs load more scripts during their own synchronous eval
    // (each pending eval adds a large V8 interpreter frame to the C stack;
    // 6-9 levels can overflow an 8 MB Rust thread stack).
    let _syncEvalDepth = 0;
    const _MAX_SYNC_EVAL_DEPTH = 4;

    // Guards against unbounded `document.write` chains. Two failure modes
    // we observed on bot.sannysoft.com:
    //   (a) A script does `document.write('<script>...</script>')` and the
    //       written script does the same — direct cycle. Caught by depth.
    //   (b) `document.write` dispatches every new node through
    //       `_onNodeInserted`, which evals scripts. If a written script
    //       calls `document.write` again during its eval (synchronously),
    //       we re-enter `_onNodeInserted` from inside its own call.
    let _onNodeInsertedDepth = 0;
    const _MAX_NODE_INSERT_DEPTH = 64;

    // `sync` means "fetch and run the script inside this insertion call", which is
    // parser-inserted behaviour. Only `document.write` qualifies: a script the
    // parser meets blocks it. One inserted through `appendChild` is not
    // parser-inserted, so per spec it loads asynchronously and must not block —
    // hence the default here.
    //
    // Blocking mid-insertion also inverted script order against genuinely async
    // tags: an SDK injecting its own copy of a library had that copy fetched and
    // executed instantly, while the page's own `<script async>` for the same
    // library was still in flight. Whichever copy initialises last owns the
    // library's state, so the page ends up addressing the discarded instance.
    function _onNodeInserted(child, sync = false) {
        if (!child) return;
        if (_onNodeInsertedDepth >= _MAX_NODE_INSERT_DEPTH) {
            // Bail — log once and skip. This breaks document.write recursion
            // chains that would otherwise blow the C-stack via deep nested
            // eval -> op_dom_document_write -> _onNodeInserted.
            console.log(`[DOM] _onNodeInserted depth limit (${_MAX_NODE_INSERT_DEPTH}) — skipping`);
            return;
        }
        _onNodeInsertedDepth++;
        try {
            return _onNodeInsertedInner(child, sync);
        } finally {
            _onNodeInsertedDepth--;
        }
    }

    class DOMPointReadOnly {
        constructor(x = 0, y = 0, z = 0, w = 1) {
            this.x = x; this.y = y; this.z = z; this.w = w;
        }
        static fromPoint(p) { return new DOMPointReadOnly(p.x, p.y, p.z, p.w); }
        toJSON() { return { x: this.x, y: this.y, z: this.z, w: this.w }; }
    }
    globalThis.DOMPointReadOnly = DOMPointReadOnly;

    class DOMPoint extends DOMPointReadOnly {
        constructor(x = 0, y = 0, z = 0, w = 1) { super(x, y, z, w); }
    }
    globalThis.DOMPoint = DOMPoint;

    class DOMRectReadOnly {
        constructor(x = 0, y = 0, width = 0, height = 0) {
            this.x = x; this.y = y; this.width = width; this.height = height;
        }
        get top() { return this.y; }
        get left() { return this.x; }
        get right() { return this.x + this.width; }
        get bottom() { return this.y + this.height; }
        toJSON() { return { x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, left: this.left, right: this.right, bottom: this.bottom }; }
    }
    globalThis.DOMRectReadOnly = DOMRectReadOnly;

    class DOMRect extends DOMRectReadOnly {
        constructor(x = 0, y = 0, width = 0, height = 0) { super(x, y, width, height); }
        static fromRect(r) { return new DOMRect(r.x, r.y, r.width, r.height); }
    }
    globalThis.DOMRect = DOMRect;

    if (typeof _maskFunction === 'function') {
        _maskFunction(DOMPointReadOnly, 'DOMPointReadOnly');
        _maskFunction(DOMPoint, 'DOMPoint');
        _maskFunction(DOMRectReadOnly, 'DOMRectReadOnly');
        _maskFunction(DOMRect, 'DOMRect');
    }

    // Scripts that came out of an HTML-parsing API — `innerHTML`, `outerHTML`,
    // `insertAdjacentHTML`, `createContextualFragment`, `DOMParser` — are created
    // with their "already started" flag set and MUST never run, however they are
    // inserted later. This engine ran them, so
    //
    //     el.innerHTML = '<script>…</script>'
    //
    // executed, which no browser does. It is a behaviour difference on its own
    // and it also fires markup at the wrong realm: an `<iframe srcdoc>` holding a
    // script had that script run in the *parent* while the child was still being
    // built.
    //
    // Node ids, because a wrapper object is not stable across `_wrapNode` calls.
    const _inertScripts = new Set();

    function _markScriptsAlreadyStarted(root) {
        if (!root) return;
        try {
            if ((root.tagName || "").toUpperCase() === "SCRIPT") {
                _inertScripts.add(_getNodeId(root));
            }
            const found = root.getElementsByTagName && root.getElementsByTagName("script");
            if (found) {
                for (let i = 0; i < found.length; i++) {
                    _inertScripts.add(_getNodeId(found[i]));
                }
            }
        } catch (_) { /* ignore */ }
    }

    // `getBBox()` — the element's box in its own user-space units. Derived from
    // the laid-out rect relative to the nearest `<svg>` ancestor, which is what
    // it reduces to for the untransformed elements scripts measure.
    // Text-content elements answer a few measurement methods on top of the
    // geometry ones. Kept separate from the rest because `<rect>` has no
    // `getComputedTextLength` in a browser either.
    const _SVG_TEXT_TAGS = new Set(["text", "tspan", "textpath", "tref", "altglyph"]);

    function _installSvgGeometry(el, tag) {
        try {
            // The `<svg>` element's geometry factories. `createSVGRect` is the
            // best known — it is a stock browser-capability probe, and libraries
            // call it to build rects for `getIntersectionList`/`checkIntersection`
            // — but the whole family is stock SVG 1.1 surface that this engine
            // simply did not have.
            if (tag === "svg") {
                const _num = (v) => ({ value: +v || 0, valueInSpecifiedUnits: +v || 0 });
                const _defs = {
                    createSVGRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
                    createSVGPoint: () => ({
                        x: 0, y: 0,
                        matrixTransform(m) {
                            const mm = m || {};
                            return {
                                x: this.x * (mm.a ?? 1) + this.y * (mm.c ?? 0) + (mm.e ?? 0),
                                y: this.x * (mm.b ?? 0) + this.y * (mm.d ?? 1) + (mm.f ?? 0),
                            };
                        },
                    }),
                    createSVGMatrix: () => (globalThis.DOMMatrix ? new DOMMatrix() : {
                        a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
                    }),
                    createSVGLength: () => _num(0),
                    createSVGAngle: () => _num(0),
                    createSVGNumber: () => _num(0),
                    createSVGTransform: () => ({
                        type: 0, angle: 0,
                        matrix: globalThis.DOMMatrix ? new DOMMatrix() : null,
                        setTranslate() {}, setScale() {}, setRotate() {},
                    }),
                    createSVGTransformFromMatrix: (m) => ({ type: 1, angle: 0, matrix: m }),
                    getIntersectionList: () => (globalThis.NodeList ? [] : []),
                    getEnclosureList: () => [],
                    checkIntersection: () => false,
                    checkEnclosure: () => false,
                    suspendRedraw: () => 0,
                    unsuspendRedraw: () => {},
                    unsuspendRedrawAll: () => {},
                    forceRedraw: () => {},
                };
                for (const [name, fn] of Object.entries(_defs)) {
                    if (typeof el[name] === "function") continue;
                    Object.defineProperty(el, name, {
                        value: fn, writable: true, enumerable: false, configurable: true,
                    });
                    if (_maskRuntime) _maskRuntime(el[name], name);
                }
            }
            Object.defineProperty(el, "getBBox", {
                value: function getBBox() {
                    let x = 0, y = 0, width = 0, height = 0;
                    try {
                        const own = this.getBoundingClientRect();
                        width = own.width;
                        height = own.height;
                        let root = this.parentNode;
                        while (root && (root.tagName || "").toLowerCase() !== "svg") {
                            root = root.parentNode;
                        }
                        const origin = root ? root.getBoundingClientRect() : null;
                        x = origin ? own.left - origin.left : own.left;
                        y = origin ? own.top - origin.top : own.top;
                    } catch (_) { /* ignore */ }
                    return { x, y, width, height };
                },
                writable: true, enumerable: false, configurable: true,
            });
            if (!_SVG_TEXT_TAGS.has(String(tag || "").toLowerCase())) return;
            const text = () => String(el.textContent || "");
            const width = () => {
                try { return el.getBoundingClientRect().width; } catch (_) { return 0; }
            };
            const methods = {
                getComputedTextLength() { return width(); },
                getNumberOfChars() { return text().length; },
                getSubStringLength(offset, length) {
                    const total = text().length;
                    return total ? (width() * Math.min(length, total - offset)) / total : 0;
                },
                getCharNumAtPosition() { return -1; },
                getStartPositionOfChar() { return { x: 0, y: 0 }; },
                getEndPositionOfChar() { return { x: width(), y: 0 }; },
                getExtentOfChar() {
                    const total = text().length || 1;
                    return { x: 0, y: 0, width: width() / total, height: 0 };
                },
                getRotationOfChar() { return 0; },
                selectSubString() {},
            };
            for (const name of Object.keys(methods)) {
                Object.defineProperty(el, name, {
                    value: methods[name], writable: true, enumerable: false, configurable: true,
                });
            }
        } catch (_) { /* ignore */ }
    }

    // The engine's state object no longer hangs off a named global — the cleanup
    // pass moves it onto the symbol namespace, because `_browser_oxide` in
    // `Object.getOwnPropertyNames(window)` spelled the engine's name out for any
    // script that looked. Readers resolve it either way: the global before the
    // move, the namespace after.
    function _boState() {
        if (globalThis._browser_oxide) return globalThis._browser_oxide;
        try {
            const syms = Object.getOwnPropertySymbols(globalThis);
            for (let i = 0; i < syms.length; i++) {
                const v = globalThis[syms[i]];
                if (v && v.__bo && v.host) return v.host.bo;
            }
        } catch (_) { /* ignore */ }
        return null;
    }

    /// Debug counter for injected iframes. It used to be assigned straight to
    /// `globalThis`, which re-created a named engine global on the window
    /// *after* the cleanup pass had deleted it — visible to any page that
    /// enumerates the global namespace.
    function _setIfAppendCount(n) {
        const st = _boState();
        if (st) st.__ifAppendCount = n;
    }

    /// The `document.cookie` mirror of `net::cookies`, for this origin.
    ///
    /// It used to live at `globalThis.__jsCookies`, but that name is one the
    /// cleanup pass moves onto the engine's namespace and deletes from the
    /// global — so every read created a fresh empty object and
    /// `document.cookie` answered `""` no matter what the server had set.
    /// Cookies still travelled correctly at the HTTP layer, which is what made
    /// it invisible: only *scripts* saw a cookie-less browser, and a client
    /// that receives `Set-Cookie` and then reports no cookies at all is exactly
    /// the shape a risk engine scores as a fresh, suspicious visitor.
    function _cookieMirror() {
        const st = _boState();
        if (st) {
            if (!st.__jsCookies) st.__jsCookies = {};
            return st.__jsCookies;
        }
        if (!globalThis.__jsCookies) globalThis.__jsCookies = {};
        return globalThis.__jsCookies;
    }

    function _onNodeInsertedInner(child, sync = true) {
        // 1. Dynamic script loading
        const childTag = (child.tagName || child.nodeName || "").toLowerCase();
        const type = (child.getAttribute?.('type') || '').toLowerCase();
        const isJs = !type || type === 'text/javascript' || type === 'application/javascript' || type === 'module';
        
        if (childTag === 'script' && !isJs) {
            return; // Skip non-JS scripts like application/ld+json
        }

        if (childTag === 'script' && _inertScripts.has(_getNodeId(child))) {
            return; // "already started" — parsed from markup, never executes
        }

        const childSrc = (childTag === 'script') ? (child.src || child.getAttribute?.('src')) : null;

        if (childTag === 'script' && !childSrc) {
            const code = child.textContent || child.innerText || '';
            if (code && code.trim()) {
                console.log(`[DOM] executing inline script (${code.length} bytes)`);
                try { _evalAsScript(code, child); } catch (e) {
                    console.log(`[DOM] inline eval error: ${e.message}`);
                }
            }
        }

        if (childTag === 'script' && childSrc) {
            const src = childSrc;
            const scriptEl = child;

            // `blob:` is not a network URL — the bytes are already in this process,
            // held by the blob store. Routing it through the HTTP client fetches
            // nothing and the script silently never runs. Bundlers and workers
            // build code at runtime and load it exactly this way, so the whole
            // pattern was dead.
            if (src.startsWith('blob:')) {
                let code = '';
                try { code = ops.op_blob_fetch_text(src) || ''; } catch (_) {}
                if (code) {
                    console.log(`[DOM] executing blob script (${code.length} bytes)`);
                    try {
                        _evalAsScript(code, scriptEl);
                        // Only dispatch: `dispatchEvent` invokes the `onload`
                        // attribute itself, so calling it first fired every
                        // handler twice. A widget whose loader consumes state on
                        // the first call then threw on the second.
                        scriptEl.dispatchEvent && scriptEl.dispatchEvent(new Event('load'));
                    } catch (e) {
                        console.log(`[DOM] blob eval error: ${e.message}`);
                        scriptEl.dispatchEvent && scriptEl.dispatchEvent(new Event('error'));
                    }
                } else {
                    scriptEl.dispatchEvent && scriptEl.dispatchEvent(new Event('error'));
                }
                return;
            }

            let fullUrl = src;
            if (!src.startsWith('http') && !src.startsWith('data:')) {
                try {
                    const base = globalThis.location ? globalThis.location.href : 'about:blank';
                    fullUrl = new URL(src, base).href;
                } catch(e) {}
            }

            // Third-party trackers known to trigger uncontrolled C-stack recursion
            // inside their own VM (not in our shims). Skip them — they add no
            // signal to fingerprint scoring, and crashing the engine on them
            // costs us all subsequent tests on the page.
            // Known offenders identified via stack-overflow crashes on real
            // sites: bot.sannysoft.com loads Yandex Metrika; leboncoin.fr
            // loads it too.
            const _RECURSIVE_TRACKERS = [
                "mc.yandex.ru/metrika/tag.js",
                "mc.yandex.ru/metrika/watch.js",
                "mc.yandex.ru/webvisor/",
            ];
            for (const pat of _RECURSIVE_TRACKERS) {
                if (fullUrl.includes(pat)) {
                    scriptEl.dispatchEvent && scriptEl.dispatchEvent(new Event('load'));
                    return;
                }
            }

            if (sync) {
                // Strip query params for in-flight dedup: scripts that reload themselves
                // with a cache-busting timestamp (e.g. Yandex Metrika tag.js?<timestamp>)
                // share the same base URL and would recurse infinitely without this guard.
                const baseUrl = fullUrl.split('?')[0];
                if (_syncFetchInFlight.has(baseUrl)) {
                    // Re-entrant same-URL fetch — fire load event and bail to break the cycle.
                    scriptEl.dispatchEvent && scriptEl.dispatchEvent(new Event('load'));
                    return;
                }
                // Depth guard: if sync evals are already nested beyond the safe limit,
                // degrade to async. This prevents C++ stack overflow from chains like
                // tag.js → pixel.js → tracker.js → … where each level blocks the V8
                // thread inside op_net_fetch_sync while its eval frame stays on stack.
                if (_syncEvalDepth >= _MAX_SYNC_EVAL_DEPTH) {
                    console.log(`[DOM] sync eval depth limit (${_MAX_SYNC_EVAL_DEPTH}) — falling back to async: ${fullUrl}`);
                    (async () => {
                        try {
                            const resp = await globalThis.fetch(fullUrl);
                            if (resp.ok) {
                                const code = await resp.text();
                                try { _evalAsScript(code, scriptEl); } catch(_) {}
                                scriptEl.dispatchEvent && scriptEl.dispatchEvent(new Event('load'));
                            }
                        } catch(_) {
                            scriptEl.dispatchEvent && scriptEl.dispatchEvent(new Event('error'));
                        }
                    })();
                    return;
                }
                _syncFetchInFlight.add(baseUrl);
                _syncEvalDepth++;
                console.log(`[DOM] sync fetching script (depth ${_syncEvalDepth}): ${fullUrl}`);
                try {
                    const code = ops.op_net_fetch_sync(fullUrl, globalThis.location?.href || "");
                    if (code) {
                        console.log(`[DOM] sync executing script (${code.length} bytes): ${fullUrl}`);
                        try {
                            _evalAsScript(code, scriptEl);
                            console.log(`[DOM] sync execution SUCCESS: ${fullUrl}`);
                        } catch(e) {
                            console.log(`[DOM] sync eval ERROR for ${fullUrl}: ${e.message}\n${e.stack}`);
                            scriptEl.dispatchEvent && scriptEl.dispatchEvent(new Event('error'));
                        }
                    } else {
                        console.log(`[DOM] sync fetch FAILED (empty) for ${fullUrl}`);
                        scriptEl.dispatchEvent && scriptEl.dispatchEvent(new Event('error'));
                    }
                    scriptEl.dispatchEvent && scriptEl.dispatchEvent(new Event('load'));
                } catch(e) {
                    console.log(`[DOM] sync fetch OP error for ${fullUrl}: ${e.message}`);
                    scriptEl.dispatchEvent && scriptEl.dispatchEvent(new Event('error'));
                } finally {
                    _syncFetchInFlight.delete(baseUrl);
                    _syncEvalDepth--;
                }
            } else {
                console.log(`[DOM] async fetching script: ${fullUrl}`);
                // Deferred to a task, not routed through `fetch`. A classic script
                // load is a no-cors resource fetch; `fetch()` is a CORS request and
                // a cross-origin library without the right response headers simply
                // fails — which is most of them. Taking the same direct fetch the
                // parser path uses, one task later, keeps the request identical
                // while making the *timing* right: the insertion returns
                // immediately and the download no longer jumps the queue ahead of
                // scripts requested earlier.
                (async () => {
                    try {
                        const resp = await globalThis.fetch(fullUrl);
                        const code = resp.ok ? await resp.text() : "";
                        if (code) {
                            console.log(`[DOM] async executing script (${code.length} bytes): ${fullUrl}`);
                            try {
                                _evalAsScript(code, scriptEl);
                                console.log(`[DOM] async execution SUCCESS: ${fullUrl}`);
                                scriptEl.dispatchEvent && scriptEl.dispatchEvent(new Event('load'));
                            } catch(e) {
                                console.log(`[DOM] async eval ERROR for ${fullUrl}: ${e.message}\n${e.stack}`);
                                scriptEl.dispatchEvent && scriptEl.dispatchEvent(new Event('error'));
                            }
                        } else {
                            console.log(`[DOM] async fetch FAILED (empty) for ${fullUrl}`);
                            scriptEl.dispatchEvent && scriptEl.dispatchEvent(new Event('error'));
                        }
                    } catch(e) {
                        console.log(`[DOM] async fetch ERROR for ${fullUrl}: ${e.message}`);
                        scriptEl.dispatchEvent && scriptEl.dispatchEvent(new Event('error'));
                    }
                })();
            }
        }

        // 2. Recursive check for children (handles <div><script>...</script></div>)
        if (child.childNodes && child.childNodes.length > 0) {
            for (let i = 0; i < child.childNodes.length; i++) {
                _onNodeInserted(child.childNodes[i], sync);
            }
        }
    }

    globalThis.__onNodeInserted = _onNodeInserted;

    class NodeList {
        constructor(data, isTyped = false) {
            if (isTyped) {
                this._ids = [];
                for (let i = 0; i < data.length; i += 2) {
                    const id = data[i];
                    const type = data[i+1];
                    this._ids.push(id);
                    this[i/2] = _wrapNodeWithType(id, type);
                }
            } else {
                this._ids = data;
                for (let i = 0; i < data.length; i++) {
                    this[i] = _wrapNode(data[i]);
                }
            }
        }
        get length() { return this._ids.length; }
        item(index) { return index < this._ids.length ? _wrapNode(this._ids[index]) : null; }
        forEach(cb, thisArg) {
            for (let i = 0; i < this._ids.length; i++) {
                cb.call(thisArg, this[i], i, this);
            }
        }
        entries() {
            const self = this;
            let i = 0;
            return { next() { return i < self.length ? { value: [i, self[i++]], done: false } : { done: true }; }, [Symbol.iterator]() { return this; } };
        }
        keys() {
            const self = this;
            let i = 0;
            return { next() { return i < self.length ? { value: i++, done: false } : { done: true }; }, [Symbol.iterator]() { return this; } };
        }
        values() { return this[Symbol.iterator](); }
        [Symbol.iterator]() {
            let i = 0;
            const self = this;
            return {
                next() {
                    if (i < self.length) return { value: self[i++], done: false };
                    return { value: undefined, done: true };
                },
                [Symbol.iterator]() { return this; }
            };
        }
    }

    class DOMTokenList {
        #nodeId;
        constructor(nodeId) { this.#nodeId = nodeId; }
        add(cls) { ops.op_dom_class_list_add(this.#nodeId, cls); }
        remove(cls) { ops.op_dom_class_list_remove(this.#nodeId, cls); }
        toggle(cls) {
            if (this.contains(cls)) { this.remove(cls); return false; }
            this.add(cls); return true;
        }
        contains(cls) {
            const attr = ops.op_dom_get_attribute(this.#nodeId, "class");
            return attr ? attr.split(/\s+/).includes(cls) : false;
        }
        get value() { return ops.op_dom_get_attribute(this.#nodeId, "class") || ""; }
        get length() { return this.value.split(/\s+/).filter(Boolean).length; }
        toString() { return this.value; }
        item(index) {
            const tokens = this.value.split(/\s+/).filter(Boolean);
            return tokens[index] != null ? tokens[index] : null;
        }
        // Real Chrome DOMTokenList is iterable; iterating yields each token
        // string. Some scripts spread element.classList — without
        // Symbol.iterator we throw "non-iterable" while Chrome returns the
        // token array.
        [Symbol.iterator]() {
            const tokens = this.value.split(/\s+/).filter(Boolean);
            let i = 0;
            return {
                next() {
                    if (i < tokens.length) return { value: tokens[i++], done: false };
                    return { value: undefined, done: true };
                },
                [Symbol.iterator]() { return this; }
            };
        }
        entries() {
            const tokens = this.value.split(/\s+/).filter(Boolean);
            let i = 0;
            return {
                next() {
                    if (i < tokens.length) { const idx = i; return { value: [idx, tokens[i++]], done: false }; }
                    return { value: undefined, done: true };
                },
                [Symbol.iterator]() { return this; }
            };
        }
        keys() {
            const n = this.length;
            let i = 0;
            return {
                next() {
                    if (i < n) return { value: i++, done: false };
                    return { value: undefined, done: true };
                },
                [Symbol.iterator]() { return this; }
            };
        }
        values() { return this[Symbol.iterator](); }
        forEach(cb, thisArg) {
            const tokens = this.value.split(/\s+/).filter(Boolean);
            for (let i = 0; i < tokens.length; i++) {
                cb.call(thisArg, tokens[i], i, this);
            }
        }
    }

    // EventTarget is the base of the DOM prototype chain in real Chrome:
    //   EventTarget ← Node ← Element ← HTMLElement ← HTMLDivElement etc.
    // Some scripts check `document instanceof EventTarget === true`
    // and walk Object.getPrototypeOf chains expecting this layout.
    const EventTarget = globalThis.EventTarget || class EventTarget {
        constructor() {}
        addEventListener(type, listener, options) {}
        removeEventListener(type, listener, options) {}
        dispatchEvent(event) { return true; }
    };
    globalThis.EventTarget = EventTarget;

    class Node extends EventTarget {
        constructor(nodeId) {
            super();
            _nodeIds.set(this, nodeId);
        }
        // nodeType constants
        static ELEMENT_NODE = 1;
        static TEXT_NODE = 3;
        static COMMENT_NODE = 8;
        static DOCUMENT_NODE = 9;
        static DOCUMENT_FRAGMENT_NODE = 11;
        static DOCUMENT_TYPE_NODE = 10;
        static PROCESSING_INSTRUCTION_NODE = 7;
        static ATTRIBUTE_NODE = 2;
        static CDATA_SECTION_NODE = 4;

        get nodeType() { return ops.op_dom_get_node_type(_getNodeId(this)); }
        get nodeName() {
            const type = this.nodeType;
            if (type === 1) return ops.op_dom_get_tag_name(_getNodeId(this)).toUpperCase();
            if (type === 3) return "#text";
            if (type === 8) return "#comment";
            if (type === 9) return "#document";
            if (type === 11) return "#document-fragment";
            return "";
        }
        get nodeValue() {
            const type = this.nodeType;
            if (type === 3 || type === 8) return ops.op_dom_get_text_content(_getNodeId(this));
            return null;
        }
        set nodeValue(val) {
            const type = this.nodeType;
            if (type === 3 || type === 8) ops.op_dom_set_text_content(_getNodeId(this), String(val));
        }
        get ownerDocument() {
            return this.nodeType === 9 ? null : _document;
        }
        get isConnected() {
            let n = this;
            while (n) {
                if (n.nodeType === 9) return true;
                n = n.parentNode;
            }
            return false;
        }
        get baseURI() {
            return globalThis.location?.href || "about:blank";
        }
        get parentNode() { return _wrapNode(ops.op_dom_get_parent(_getNodeId(this))); }
        get parentElement() {
            const p = this.parentNode;
            return p && p.nodeType === 1 ? p : null;
        }
        get childNodes() { return new NodeList(ops.op_dom_get_children_with_types(_getNodeId(this)), true); }
        get firstChild() { return _wrapNode(ops.op_dom_get_first_child(_getNodeId(this))); }
        get lastChild() { return _wrapNode(ops.op_dom_get_last_child(_getNodeId(this))); }
        get nextSibling() { return _wrapNode(ops.op_dom_get_next_sibling(_getNodeId(this))); }
        get previousSibling() { return _wrapNode(ops.op_dom_get_prev_sibling(_getNodeId(this))); }
        get textContent() { return ops.op_dom_get_text_content(_getNodeId(this)); }
        set textContent(val) { ops.op_dom_set_text_content(_getNodeId(this), String(val)); }
        appendChild(child) {
            ops.op_dom_append_child(_getNodeId(this), _getNodeId(child));
            _onNodeInserted(child);
            return child;
        }
        removeChild(child) {
            _ceDisconnected(child);
            ops.op_dom_remove_child(_getNodeId(this), _getNodeId(child));
            return child;
        }
        replaceChild(newChild, oldChild) {
            const parent = _getNodeId(this);
            const oldId = _getNodeId(oldChild);
            const newId = _getNodeId(newChild);
            _ceDisconnected(oldChild);
            ops.op_dom_insert_before(parent, newId, oldId);
            ops.op_dom_remove_child(parent, oldId);
            _onNodeInserted(newChild);
            return oldChild;
        }
        insertBefore(newChild, refChild) {
            if (refChild === null || refChild === undefined) return this.appendChild(newChild);
            ops.op_dom_insert_before(_getNodeId(this), _getNodeId(newChild), _getNodeId(refChild));
            _onNodeInserted(newChild);
            return newChild;
        }
        cloneNode(deep = false) {
            const newId = ops.op_dom_clone_node(_getNodeId(this), !!deep);
            return _wrapNode(newId);
        }
        contains(other) {
            if (!other) return false;
            if (other === this) return true;
            let p = other.parentNode;
            while (p) {
                if (p === this) return true;
                p = p.parentNode;
            }
            return false;
        }
        hasChildNodes() { return ops.op_dom_get_children(_getNodeId(this)).length > 0; }
        getRootNode() {
            let n = this;
            while (n.parentNode) n = n.parentNode;
            return n;
        }
        normalize() {
            // Merge adjacent text nodes
            const children = ops.op_dom_get_children(_getNodeId(this));
            let prevTextId = null;
            for (const cid of children) {
                if (ops.op_dom_get_node_type(cid) === 3) {
                    if (prevTextId !== null) {
                        const prevText = ops.op_dom_get_text_content(prevTextId);
                        const curText = ops.op_dom_get_text_content(cid);
                        ops.op_dom_set_text_content(prevTextId, prevText + curText);
                        ops.op_dom_remove_child(_getNodeId(this), cid);
                    } else {
                        prevTextId = cid;
                    }
                } else {
                    prevTextId = null;
                }
            }
        }
        isEqualNode(other) {
            if (!other) return false;
            if (this === other) return true;
            if (this.nodeType !== other.nodeType) return false;
            if (this.nodeType === 1) return this.outerHTML === other.outerHTML;
            return this.textContent === other.textContent;
        }
        isSameNode(other) { return this === other; }
        compareDocumentPosition(other) {
            if (this === other) return 0;
            if (this.contains(other)) return 20; // DOCUMENT_POSITION_CONTAINED_BY | FOLLOWING
            if (other.contains(this)) return 10; // DOCUMENT_POSITION_CONTAINS | PRECEDING
            return 4; // DOCUMENT_POSITION_FOLLOWING
        }
    }

    // --- Internal Bridge ---
    if (!globalThis.__browser_oxide) {
        Object.defineProperty(globalThis, '__browser_oxide', { value: {}, enumerable: false, configurable: true });
    }
    globalThis.__browser_oxide._getNodeId = _getNodeId;
    globalThis.__browser_oxide._wrapNode = _wrapNode;
    globalThis.__browser_oxide._setCurrentScript = _setCurrentScript;

    // The same three, where the host can still reach them. `__browser_oxide` is
    // a named global and the cleanup pass deletes it — correctly, since a page
    // can enumerate globals — but the host drives `document.currentScript` from
    // Rust through this bridge, and after the delete every one of those calls
    // threw into a swallowed result. Parser-inserted scripts then all ran with
    // `currentScript === null`, which no real browser does.
    try {
        Object.defineProperty(_boNs, 'script', {
            value: {
                setCurrent(nodeId) {
                    _setCurrentScript(nodeId == null || nodeId < 0 ? null : _wrapNode(nodeId));
                },
                clearLater: _clearCurrentScriptLater,
                nodeIdOf: _getNodeId,
                wrap: _wrapNode,
            },
            writable: false,
            configurable: true,
            enumerable: false,
        });
    } catch (_) { /* ignore */ }

    function _createStyleProxy(nodeId) {
        const cache = {};
        const raw = ops.op_dom_get_attribute(nodeId, "style") || "";
        for (const part of raw.split(";")) {
            const idx = part.indexOf(":");
            if (idx > 0) cache[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
        }
        function flush() {
            const parts = [];
            for (const k in cache) { if (cache[k] !== "") parts.push(k + ": " + cache[k]); }
            ops.op_dom_set_attribute(nodeId, "style", parts.join("; "));
        }
        // A declaration a browser would refuse.
        //
        // CSSOM drops a value it cannot parse, leaving the property as it was.
        // This proxy stored whatever it was handed, so a page whose arithmetic
        // produced `NaN` — from a metric that read back as an empty string, say
        // — wrote `height: NaN` into the element and the browser-side result
        // (property simply unset) never happened. The element then laid out on
        // a value no engine would accept. Measured on hCaptcha's tiles:
        // `background-size: 120px NaNpx` and nothing painted.
        const _rejects = (v) => {
            const t = String(v).trim();
            if (t === "") return false;      // empty means "remove", which is valid
            // `NaN`, `undefined`, `Infinity` never appear in valid CSS; they are
            // exactly what broken JS arithmetic stringifies to. No trailing
            // delimiter is required: the unit is usually glued straight on, as
            // in `background-size: 120px NaNpx`.
            return /(^|[\s(,])(NaN|undefined|Infinity)/.test(t);
        };

        const toKebab = (p) => p.replace(/[A-Z]/g, m => "-" + m.toLowerCase());
        const style = Object.create(globalThis.CSSStyleDeclaration.prototype || Object.prototype);
        return new Proxy(style, {
            get(target, prop) {
                if (prop === "setProperty") return (name, value) => {
                    if (_rejects(value)) return;
                    cache[name] = String(value); flush();
                };
                if (prop === "getPropertyValue") return (name) => cache[name] || "";
                if (prop === "removeProperty") return (name) => { const old = cache[name] || ""; delete cache[name]; flush(); return old; };
                if (prop === "cssText") return ops.op_dom_get_attribute(nodeId, "style") || "";
                if (prop === "length") return Object.keys(cache).length;
                if (prop === Symbol.toStringTag) return "CSSStyleDeclaration";
                if (typeof prop === "string") {
                    if (/^\d+$/.test(prop)) return Object.keys(cache)[parseInt(prop, 10)];
                    return cache[toKebab(prop)] || "";
                }
                return undefined;
            },
            set(target, prop, value) {
                if (prop === "cssText") {
                    for (const k in cache) delete cache[k];
                    for (const part of String(value).split(";")) {
                        const idx = part.indexOf(":");
                        if (idx > 0) {
                            const v = part.slice(idx + 1).trim();
                            if (!_rejects(v)) cache[part.slice(0, idx).trim()] = v;
                        }
                    }
                    flush();
                    return true;
                }
                if (_rejects(value)) return true;   // refused, as a browser does
                cache[toKebab(prop)] = String(value);
                flush();
                return true;
            },
            // V8 Proxy invariant: has/ownKeys/getOwnPropertyDescriptor must
            // agree. Without explicit traps V8 reconciles against the empty
            // target object on every `prop in style` / Object.keys(style)
            // call — hot work that fingerprint scripts hit per WebIDL property under test.
            has(target, prop) {
                if (prop === "setProperty" || prop === "getPropertyValue" ||
                    prop === "removeProperty" || prop === "cssText") return true;
                if (typeof prop === "string") return Object.prototype.hasOwnProperty.call(cache, toKebab(prop));
                return false;
            },
            ownKeys() {
                return Object.keys(cache);
            },
            getOwnPropertyDescriptor(target, prop) {
                if (typeof prop !== "string") return undefined;
                const key = toKebab(prop);
                if (Object.prototype.hasOwnProperty.call(cache, key)) {
                    return { value: cache[key], enumerable: true, configurable: true, writable: true };
                }
                return undefined;
            }
        });
    }

    // A real `Attr`, not the `{name, value, specified}` literal `attributes`
    // used to hand out. React 19's hydration path walks `element.attributes`
    // and drops the server-rendered extras with
    // `element.removeAttributeNode(attr)` — with neither the method nor a
    // node-shaped value, Next.js pages died mid-hydration with
    // `e.removeAttributeNode is not a function` and rendered nothing at all.
    class Attr {
        constructor(name, value, ownerElement) {
            this._name = String(name);
            this._value = value == null ? "" : String(value);
            this._owner = ownerElement || null;
        }
        get name() { return this._name; }
        get localName() { return this._name; }
        get nodeName() { return this._name; }
        get value() { return this._value; }
        set value(v) {
            this._value = v == null ? "" : String(v);
            if (this._owner) this._owner.setAttribute(this._name, this._value);
        }
        get nodeValue() { return this._value; }
        set nodeValue(v) { this.value = v; }
        get textContent() { return this._value; }
        set textContent(v) { this.value = v; }
        get ownerElement() { return this._owner; }
        get specified() { return true; }
        get prefix() { return null; }
        get namespaceURI() { return null; }
        get nodeType() { return 2; }
    }
    Object.defineProperty(Attr.prototype, Symbol.toStringTag, {
        value: "Attr", configurable: true,
    });

    /// Set by the `HTMLImageElement` block below, which is defined after this
    /// class. `setAttribute('src', …)` on an <img> starts the fetch through it,
    /// so markup-parsed images and `img.src = …` follow the same path.
    /// `_maskFunction` captured while it still exists.
    ///
    /// The cleanup pass purges the masking helpers from the global namespace,
    /// so any `typeof _maskFunction === 'function'` check made at *runtime* —
    /// from an element factory, say — fails and the masking silently does
    /// nothing. Every function installed after cleanup then serialises as its
    /// own JS source instead of `[native code]`.
    const _maskRuntime = (typeof _maskFunction === "function") ? _maskFunction : null;

    let _onImgSrcAttr = null;
    /// The document's focused element. `null` means "the body", which is what
    /// `document.activeElement` reports when nothing is focused.
    let _activeElement = null;
    /// Set below by the form-control block: clears a control's dirty value /
    /// checkedness flags so it falls back to its markup default again.
    let _clearDirtyValue = null;

    // pointerId → the element currently capturing it.
    const _pointerCaptures = new Map();
    const _firePointerCapture = (el, type, pointerId) => {
        try {
            const P = globalThis.PointerEvent || globalThis.MouseEvent;
            const ev = new P(type, {
                bubbles: true, cancelable: false, composed: true,
                pointerId, pointerType: "mouse", isPrimary: true,
            });
            el.dispatchEvent(ev);
        } catch (_e) { /* ignore */ }
    };

    class Element extends Node {
        get tagName() { return ops.op_dom_get_tag_name(_getNodeId(this)).toUpperCase(); }
        get localName() { return ops.op_dom_get_tag_name(_getNodeId(this)); }
        get id() { return ops.op_dom_get_attribute(_getNodeId(this), "id") || ""; }
        set id(val) { ops.op_dom_set_attribute(_getNodeId(this), "id", String(val)); }
        get className() { return ops.op_dom_get_attribute(_getNodeId(this), "class") || ""; }
        set className(val) { ops.op_dom_set_attribute(_getNodeId(this), "class", String(val)); }
        // HTML attribute-backed properties (script.src, link.href, img.src, etc.)
        // `.src` reflects the IDL attribute, which real Chrome returns as an
        // ABSOLUTE URL (resolved against the document base) — not the raw
        // relative attribute. Returning the raw relative value is a parity gap
        // that breaks any script deriving paths from its own `.src`. Resolve
        // against the document base; fall back to the raw value if URL parsing
        // fails, and keep "" for an absent/empty attribute (Chrome parity).
        get src() {
            const _raw = this.getAttribute("src");
            if (!_raw) return "";
            try {
                const _base = (globalThis.location && globalThis.location.href)
                    || (globalThis.__browser_oxide && globalThis.__browser_oxide._baseUrl)
                    || undefined;
                return new URL(_raw, _base).href;
            } catch (_) {
                return _raw;
            }
        }
        set src(val) { this.setAttribute("src", String(val)); }
        get href() { return this.getAttribute("href") || ""; }
        set href(val) { this.setAttribute("href", String(val)); }
        get type() { return this.getAttribute("type") || ""; }
        set type(val) { this.setAttribute("type", String(val)); }
        get rel() { return this.getAttribute("rel") || ""; }
        set rel(val) { this.setAttribute("rel", String(val)); }
        get async() { return this.hasAttribute("async"); }
        set async(val) { if (val) this.setAttribute("async", ""); else this.removeAttribute("async"); }
        get defer() { return this.hasAttribute("defer"); }
        set defer(val) { if (val) this.setAttribute("defer", ""); else this.removeAttribute("defer"); }
        get crossOrigin() { return this.getAttribute("crossorigin"); }
        set crossOrigin(val) { if (val != null) this.setAttribute("crossorigin", String(val)); else this.removeAttribute("crossorigin"); }
        get integrity() { return this.getAttribute("integrity") || ""; }
        set integrity(val) { this.setAttribute("integrity", String(val)); }
        get referrerPolicy() { return this.getAttribute("referrerpolicy") || ""; }
        set referrerPolicy(val) { this.setAttribute("referrerpolicy", String(val)); }
        get classList() { return new DOMTokenList(_getNodeId(this)); }
        get innerHTML() { return ops.op_dom_get_inner_html(_getNodeId(this)); }
        set innerHTML(val) {
            ops.op_dom_set_inner_html(_getNodeId(this), String(val));
            _markScriptsAlreadyStarted(this);
        }
        get outerHTML() { return ops.op_dom_get_outer_html(_getNodeId(this)); }
        get children() {
            return new NodeList(ops.op_dom_get_child_elements_with_types(_getNodeId(this)), true);
        }
        get firstElementChild() {
            const els = ops.op_dom_get_child_elements(_getNodeId(this));
            return els.length > 0 ? _wrapNode(els[0]) : null;
        }
        get lastElementChild() {
            const els = ops.op_dom_get_child_elements(_getNodeId(this));
            return els.length > 0 ? _wrapNode(els[els.length - 1]) : null;
        }
        getAttribute(name) { return ops.op_dom_get_attribute(_getNodeId(this), name); }
        setAttribute(name, value) {
            const v = String(value);
            ops.op_dom_set_attribute(_getNodeId(this), name, v);
            if (_onImgSrcAttr && name.toLowerCase() === "src"
                && (this.tagName || "").toLowerCase() === "img") {
                _onImgSrcAttr(this, v);
            }
        }
        removeAttribute(name) {
            ops.op_dom_remove_attribute(_getNodeId(this), name);
            if (_onImgSrcAttr && name.toLowerCase() === "src"
                && (this.tagName || "").toLowerCase() === "img") {
                _onImgSrcAttr(this, null);
            }
        }
        getAttributeNode(name) {
            const n = String(name);
            const val = ops.op_dom_get_attribute(_getNodeId(this), n);
            return val ? new Attr(n, val, this) : null;
        }
        getAttributeNodeNS(_ns, name) { return this.getAttributeNode(name); }
        setAttributeNode(attr) {
            if (!attr) return null;
            const prev = this.getAttributeNode(attr.name);
            this.setAttribute(attr.name, attr.value);
            return prev;
        }
        setAttributeNodeNS(attr) { return this.setAttributeNode(attr); }
        removeAttributeNode(attr) {
            if (!attr) return null;
            this.removeAttribute(attr.name);
            return attr;
        }
        hasAttribute(name) { return ops.op_dom_has_attribute(_getNodeId(this), name); }
        querySelector(sel) {
            const id = ops.op_dom_query_selector(_getNodeId(this), sel);
            return id !== null ? _wrapNode(id) : null;
        }
        querySelectorAll(sel) {
            return new NodeList(ops.op_dom_query_selector_all(_getNodeId(this), sel));
        }
        matches(sel) {
            const all = ops.op_dom_query_selector_all(
                ops.op_dom_get_parent(_getNodeId(this)) || ops.op_dom_document_node(),
                sel
            );
            return all.includes(_getNodeId(this));
        }
        closest(sel) {
            let el = this;
            while (el) {
                if (el.matches && el.matches(sel)) return el;
                el = el.parentElement;
            }
            return null;
        }
        getElementsByTagName(tag) {
            return new NodeList(ops.op_dom_get_elements_by_tag_name(_getNodeId(this), tag));
        }
        getElementsByClassName(cls) {
            return new NodeList(ops.op_dom_get_elements_by_class_name(_getNodeId(this), cls));
        }
        // Layout APIs (wired to taffy via layout_ext ops)
        getBoundingClientRect() {
            const r = ops.op_layout_get_bounding_rect(_getNodeId(this));
            return new DOMRect(r.x, r.y, r.width, r.height);
        }
        getClientRects() { return [this.getBoundingClientRect()]; }
        get offsetWidth() { return ops.op_layout_get_offset_width(_getNodeId(this)); }
        get offsetHeight() { return ops.op_layout_get_offset_height(_getNodeId(this)); }
        get offsetTop() { return ops.op_layout_get_offset_top(_getNodeId(this)); }
        get offsetLeft() { return ops.op_layout_get_offset_left(_getNodeId(this)); }
        get clientWidth() { return this.offsetWidth; }
        get clientHeight() { return this.offsetHeight; }
        get scrollWidth() { return this.offsetWidth; }
        get scrollHeight() { return this.offsetHeight; }
        get scrollTop() {
            const s = _scrollState.get(_getNodeId(this));
            return s ? s.top : 0;
        }
        set scrollTop(v) {
            const id = _getNodeId(this);
            const n = Number(v);
            const top = Number.isFinite(n) ? n : 0;
            const cur = _scrollState.get(id);
            if (cur) cur.top = top; else _scrollState.set(id, { top, left: 0 });
        }
        get scrollLeft() {
            const s = _scrollState.get(_getNodeId(this));
            return s ? s.left : 0;
        }
        set scrollLeft(v) {
            const id = _getNodeId(this);
            const n = Number(v);
            const left = Number.isFinite(n) ? n : 0;
            const cur = _scrollState.get(id);
            if (cur) cur.left = left; else _scrollState.set(id, { top: 0, left });
        }
        scrollIntoView(_arg) { /* spec no-op when no scrollable ancestor; safe stub */ }

        // Pointer capture.
        //
        // These did not exist at all, and a drag implementation opens with
        // `e.target.setPointerCapture(e.pointerId)` — so the very first line of
        // every `pointerdown` handler threw `TypeError: … is not a function` and
        // the handler never got as far as setting its "dragging" flag. Every
        // later `pointermove` then arrived at a widget that did not believe a
        // drag was in progress: the events registered, nothing moved, and the
        // gesture never produced an answer to submit.
        //
        // Retargeting is not needed here — pointer events are dispatched at the
        // element under the pointer and bubble — so this tracks the capture and
        // fires the two events the spec pairs with it.
        setPointerCapture(pointerId) {
            const id = pointerId | 0;
            const prev = _pointerCaptures.get(id);
            if (prev === this) return;
            if (prev) _firePointerCapture(prev, "lostpointercapture", id);
            _pointerCaptures.set(id, this);
            _firePointerCapture(this, "gotpointercapture", id);
        }
        releasePointerCapture(pointerId) {
            const id = pointerId | 0;
            if (_pointerCaptures.get(id) !== this) {
                throw new DOMException(
                    "Failed to execute 'releasePointerCapture' on 'Element': " +
                    "No active pointer with the given id is found.",
                    "NotFoundError");
            }
            _pointerCaptures.delete(id);
            _firePointerCapture(this, "lostpointercapture", id);
        }
        hasPointerCapture(pointerId) {
            return _pointerCaptures.get(pointerId | 0) === this;
        }
        scrollTo(xOrOpts, y) {
            if (typeof xOrOpts === "object" && xOrOpts !== null) {
                if (xOrOpts.left !== undefined) this.scrollLeft = xOrOpts.left;
                if (xOrOpts.top !== undefined) this.scrollTop = xOrOpts.top;
            } else {
                this.scrollLeft = xOrOpts;
                this.scrollTop = y;
            }
        }
        scrollBy(xOrOpts, y) {
            if (typeof xOrOpts === "object" && xOrOpts !== null) {
                if (xOrOpts.left !== undefined) this.scrollLeft = this.scrollLeft + xOrOpts.left;
                if (xOrOpts.top !== undefined) this.scrollTop = this.scrollTop + xOrOpts.top;
            } else {
                this.scrollLeft = this.scrollLeft + xOrOpts;
                this.scrollTop = this.scrollTop + y;
            }
        }
        get offsetParent() { return this.parentElement; }
        // --- Modern DOM manipulation ---
        remove() {
            const parent = ops.op_dom_get_parent(_getNodeId(this));
            if (parent !== -1 && parent !== null) {
                ops.op_dom_remove_child(parent, _getNodeId(this));
            }
        }
        append(...nodes) {
            for (const node of nodes) {
                if (typeof node === "string") {
                    this.appendChild(_document.createTextNode(node));
                } else {
                    this.appendChild(node);
                }
            }
        }
        prepend(...nodes) {
            const first = this.firstChild;
            for (const node of nodes) {
                const n = typeof node === "string" ? _document.createTextNode(node) : node;
                if (first) {
                    this.insertBefore(n, first);
                } else {
                    this.appendChild(n);
                }
            }
        }
        after(...nodes) {
            const parent = this.parentNode;
            if (!parent) return;
            const next = this.nextSibling;
            for (const node of nodes) {
                const n = typeof node === "string" ? _document.createTextNode(node) : node;
                if (next) {
                    parent.insertBefore(n, next);
                } else {
                    parent.appendChild(n);
                }
            }
        }
        before(...nodes) {
            const parent = this.parentNode;
            if (!parent) return;
            for (const node of nodes) {
                const n = typeof node === "string" ? _document.createTextNode(node) : node;
                parent.insertBefore(n, this);
            }
        }
        replaceWith(...nodes) {
            const parent = this.parentNode;
            if (!parent) return;
            const next = this.nextSibling;
            this.remove();
            for (const node of nodes) {
                const n = typeof node === "string" ? _document.createTextNode(node) : node;
                if (next) {
                    parent.insertBefore(n, next);
                } else {
                    parent.appendChild(n);
                }
            }
        }
        replaceChildren(...nodes) {
            // Remove all existing children
            while (this.firstChild) this.removeChild(this.firstChild);
            this.append(...nodes);
        }
        // --- insertAdjacent family ---
        insertAdjacentHTML(position, html) {
            ops.op_dom_insert_adjacent_html(_getNodeId(this), position, html);
            // Same rule as `innerHTML`: markup-parsed scripts never run. The
            // inserted nodes land around this element, so the parent is what has
            // to be swept.
            _markScriptsAlreadyStarted(this.parentNode || this);
        }
        insertAdjacentElement(position, element) {
            const parent = this.parentNode;
            switch (position) {
                case "beforebegin":
                    if (parent) parent.insertBefore(element, this);
                    break;
                case "afterbegin":
                    this.insertBefore(element, this.firstChild);
                    break;
                case "beforeend":
                    this.appendChild(element);
                    break;
                case "afterend":
                    if (parent) {
                        const next = this.nextSibling;
                        if (next) parent.insertBefore(element, next);
                        else parent.appendChild(element);
                    }
                    break;
            }
            return element;
        }
        insertAdjacentText(position, text) {
            const textNode = _document.createTextNode(text);
            this.insertAdjacentElement(position, textNode);
        }
        toggleAttribute(name, force) {
            if (force !== undefined) {
                if (force) { this.setAttribute(name, ""); return true; }
                else { this.removeAttribute(name); return false; }
            }
            if (this.hasAttribute(name)) { this.removeAttribute(name); return false; }
            this.setAttribute(name, ""); return true;
        }
        // --- Attribute helpers ---
        get attributes() {
            // NamedNodeMap-like object. Uses op_dom_get_attribute_names to
            // enumerate real attributes; previous shim hardcoded length: 0
            // which violates the V8 Proxy invariant ownKeys ⇔ has and made
            // per-element attribute audits do redundant work.
            const el = this;
            const id = _getNodeId(this);
            const namesOf = () => ops.op_dom_get_attribute_names(id);
            const itemFor = (name) => {
                const val = ops.op_dom_get_attribute(id, name);
                return val ? new Attr(name, val, el) : null;
            };
            return new Proxy([], {
                get(target, prop) {
                    // Real Chrome reports
                    // Object.prototype.toString.call(el.attributes) ===
                    // "[object NamedNodeMap]". The Proxy target is [], so
                    // without this it leaked "[object Array]", which differs
                    // from real Chrome. @@toStringTag (a string)
                    // overrides the array builtin tag per spec step 5.
                    if (prop === Symbol.toStringTag) return "NamedNodeMap";
                    if (prop === "length") return namesOf().length;
                    if (prop === "getNamedItem") return (name) => itemFor(String(name));
                    if (prop === "item") return (i) => {
                        const n = namesOf()[i];
                        return n ? itemFor(n) : null;
                    };
                    if (prop === Symbol.iterator) return function* () {
                        for (const n of namesOf()) yield itemFor(n);
                    };
                    if (typeof prop === "string" && /^\d+$/.test(prop)) {
                        const n = namesOf()[parseInt(prop, 10)];
                        return n ? itemFor(n) : undefined;
                    }
                    if (typeof prop === "string") return itemFor(prop);
                    return undefined;
                },
                has(target, prop) {
                    if (prop === "length" || prop === "getNamedItem" || prop === "item") return true;
                    if (typeof prop === "string" && /^\d+$/.test(prop)) {
                        return parseInt(prop, 10) < namesOf().length;
                    }
                    if (typeof prop === "string") return ops.op_dom_has_attribute(id, prop);
                    return false;
                },
                ownKeys() {
                    const names = namesOf();
                    const keys = [];
                    for (let i = 0; i < names.length; i++) keys.push(String(i));
                    return keys.concat(["length"]);
                },
                getOwnPropertyDescriptor(target, prop) {
                    if (prop === "length") {
                        return { value: namesOf().length, enumerable: false, configurable: false, writable: false };
                    }
                    if (typeof prop === "string" && /^\d+$/.test(prop)) {
                        const n = namesOf()[parseInt(prop, 10)];
                        if (n) return { value: itemFor(n), enumerable: true, configurable: true, writable: false };
                    }
                    return undefined;
                }
            });
        }
        get dataset() {
            const el = this;
            const id = _getNodeId(this);
            const toKebab = (p) => "data-" + p.replace(/[A-Z]/g, m => "-" + m.toLowerCase());
            const fromKebab = (a) => a.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            const dataNames = () => ops.op_dom_get_attribute_names(id).filter(n => n.startsWith("data-"));
            return new Proxy({}, {
                get(target, prop) {
                    if (typeof prop !== "string") return undefined;
                    return ops.op_dom_get_attribute(id, toKebab(prop)) || undefined;
                },
                set(target, prop, value) {
                    el.setAttribute(toKebab(prop), String(value));
                    return true;
                },
                has(target, prop) {
                    if (typeof prop !== "string") return false;
                    return ops.op_dom_has_attribute(id, toKebab(prop));
                },
                deleteProperty(target, prop) {
                    if (typeof prop === "string") el.removeAttribute(toKebab(prop));
                    return true;
                },
                ownKeys() {
                    return dataNames().map(fromKebab);
                },
                getOwnPropertyDescriptor(target, prop) {
                    if (typeof prop !== "string") return undefined;
                    const attr = toKebab(prop);
                    if (ops.op_dom_has_attribute(id, attr)) {
                        return {
                            value: ops.op_dom_get_attribute(id, attr) || "",
                            enumerable: true, configurable: true, writable: true,
                        };
                    }
                    return undefined;
                }
            });
        }
        get nextElementSibling() {
            let n = this.nextSibling;
            while (n) {
                if (n.nodeType === 1) return n;
                n = n.nextSibling;
            }
            return null;
        }
        get previousElementSibling() {
            let n = this.previousSibling;
            while (n) {
                if (n.nodeType === 1) return n;
                n = n.previousSibling;
            }
            return null;
        }
        get childElementCount() {
            return ops.op_dom_get_child_elements(_getNodeId(this)).length;
        }
        // element.style — CSSStyleDeclaration proxy
        get style() {
            if (!this._style) this._style = _createStyleProxy(_getNodeId(this));
            return this._style;
        }
        // Interaction stubs
        click() {
            const ev = new Event("click", { bubbles: true, cancelable: true });
            const ok = this.dispatchEvent(ev);
            // Default action runs only if no listener cancelled the click.
            // Called through the closure — this file owns the function, so it
            // needs no global handle at all.
            if (ok) {
                try { _runActivation(this); } catch (_) { /* ignore */ }
            }
        }
        /// Focus moves `document.activeElement`, and takes it off whatever held
        /// it before. It used to only fire the event, so `activeElement` stayed
        /// on `<body>` for the document's whole life: a page reading it to find
        /// the focused field saw none, and a driver sending keystrokes to the
        /// focused element had nowhere to send them.
        ///
        /// Order follows the spec: the old target gets `blur`/`focusout`, the
        /// new one `focus`/`focusin`, and the bubbling pair comes after the
        /// non-bubbling one.
        focus() {
            const prev = _activeElement;
            if (prev === this) return;
            _activeElement = this;
            if (prev && prev !== this) {
                try {
                    prev.dispatchEvent(new FocusEvent("blur", { relatedTarget: this }));
                    prev.dispatchEvent(new FocusEvent("focusout", {
                        bubbles: true, relatedTarget: this,
                    }));
                } catch (_) { /* ignore */ }
            }
            this.dispatchEvent(new FocusEvent("focus", { relatedTarget: prev || null }));
            this.dispatchEvent(new FocusEvent("focusin", {
                bubbles: true, relatedTarget: prev || null,
            }));
        }
        blur() {
            if (_activeElement === this) _activeElement = null;
            this.dispatchEvent(new FocusEvent("blur", {}));
            this.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        }
        checkVisibility() { return true; }
        animate() { return { finished: Promise.resolve(), cancel() {}, play() {}, pause() {} }; }
        getAnimations() { return []; }
        attachShadow(init = {}) {
            const mode = init.mode || "open";
            const shadowId = ops.op_dom_attach_shadow(_getNodeId(this), mode);
            // Use _wrapNode — _wrap is not a defined helper. Was a stale
            // reference that threw `ReferenceError: _wrap is not defined`
            // whenever attachShadow was actually called — observable to
            // scripts that exercise Shadow DOM.
            const shadowRoot = _wrapNode(shadowId);
            // ShadowRoot inherits Node methods (appendChild, querySelector, etc.)
            Object.defineProperties(shadowRoot, {
                mode: { value: mode, enumerable: true },
                host: { value: this, enumerable: true },
                innerHTML: {
                    get() { return ops.op_dom_get_inner_html(shadowId); },
                    set(html) { ops.op_dom_set_inner_html(shadowId, html); },
                },
            });
            if (mode === "open") this._shadowRoot = shadowRoot;
            return shadowRoot;
        }
        get shadowRoot() { return this._shadowRoot || null; }
    }

    // Full DOM prototype chain:
    //   EventTarget ← Node ← Element ← HTMLElement ← HTML*Element
    // Subclasses are mostly empty markers for instanceof checks. When an
    // element is created via _wrapNode, we do setPrototypeOf based on the
    // tag name to select the right specific class (HTMLDivElement etc.)
    // without having to create a dedicated Rust-side dispatch.
    // `innerText` is *rendered* text, and that is the whole point of it: a
    // hidden subtree contributes nothing, block boundaries become newlines, and
    // runs of whitespace collapse. `textContent` does none of that, so a page
    // that reads `innerText` and gets `textContent` reads back its own inline
    // <style> rules and every `display:none` panel it has ever built.
    //
    // Not having it at all is worse than either: `'innerText' in document.body`
    // is one line, and every real browser answers true.
    const _TEXT_SKIP = new Set([
        "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "LINK", "BASE",
    ]);
    const _TEXT_BLOCK = new Set([
        "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "CAPTION", "DD", "DETAILS",
        "DIALOG", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM",
        "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HGROUP", "HR", "LI", "MAIN", "NAV",
        "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH",
        "THEAD", "TR", "UL",
    ]);

    function _renderedText(root) {
        // The spec counts *required line breaks* at a boundary and emits them
        // only once real text follows, rather than writing a newline on the way
        // in and another on the way out. The difference is visible immediately:
        // two sibling <div>s are separated by one newline, two sibling <p>s by
        // two, and a trailing block adds none at all.
        const out = [];
        let pending = 0;
        let started = false;

        const text = (s) => {
            if (!s) return;
            if (started && pending) out.push("\n".repeat(pending));
            pending = 0;
            out.push(s);
            started = true;
        };
        const boundary = (n) => { if (started) pending = Math.max(pending, n); };

        const visit = (node, pre) => {
            const type = node.nodeType;
            if (type === 3) {
                const raw = node.data || "";
                if (pre) { text(raw); return; }
                const collapsed = raw.replace(/\s+/g, " ");
                // Whitespace between two blocks is not a word gap — it is the
                // markup's own indentation, and emitting it would satisfy the
                // pending line break with a space.
                if (!collapsed.trim()) {
                    if (started && !pending) out.push(" ");
                    return;
                }
                text(collapsed);
                return;
            }
            if (type !== 1) return;
            const tag = node.tagName;
            if (_TEXT_SKIP.has(tag)) return;
            const style = globalThis.getComputedStyle
                ? globalThis.getComputedStyle(node)
                : null;
            if (style && (style.display === "none" || style.visibility === "hidden")) return;
            if (tag === "BR") { pending = Math.max(pending, 1); return; }
            const display = (style && style.display) || "";
            const breaks = tag === "P" ? 2 : 1;
            const block = _TEXT_BLOCK.has(tag) ||
                /^(block|flex|grid|table|list-item|flow-root)/.test(display);
            if (block) boundary(breaks);
            const nowPre = pre || tag === "PRE" || tag === "TEXTAREA";
            for (let c = node.firstChild; c; c = c.nextSibling) visit(c, nowPre);
            if (block) boundary(breaks);
        };

        const rootPre = root.tagName === "PRE" || root.tagName === "TEXTAREA";
        for (let c = root.firstChild; c; c = c.nextSibling) visit(c, rootPre);
        return out
            .join("")
            .replace(/[ \t]*\n[ \t]*/g, "\n")
            .replace(/^\s+|\s+$/g, "");
    }

    class HTMLElement extends Element {
        get innerText() { return _renderedText(this); }
        set innerText(val) {
            // Spec's "set the inner text": the string replaces the children, and
            // its line breaks become <br> rather than literal newlines — which is
            // why assigning "a\nb" and reading `textContent` back gives "ab".
            this.textContent = "";
            const lines = String(val).split(/\r\n|\r|\n/);
            for (let i = 0; i < lines.length; i++) {
                if (i) this.appendChild(_document.createElement("br"));
                if (lines[i]) this.appendChild(_document.createTextNode(lines[i]));
            }
        }
        get outerText() { return _renderedText(this); }
        set outerText(val) {
            const parent = this.parentNode;
            if (!parent) throw new DOMException("no parent", "NoModificationAllowedError");
            this.innerText = val;
            while (this.firstChild) parent.insertBefore(this.firstChild, this);
            parent.removeChild(this);
        }
    }
    class HTMLDivElement extends HTMLElement {}
    class HTMLSpanElement extends HTMLElement {}
    class HTMLParagraphElement extends HTMLElement {}
    class HTMLHeadingElement extends HTMLElement {}
    class HTMLAnchorElement extends HTMLElement {}
    // HTMLHyperlinkElementUtils — the URL decomposition IDL attributes. Without these,
    // the `document.createElement('a')` + `.pathname` idiom (axios's isURLSameOrigin,
    // and a long tail of older libraries) reads `undefined` and throws at module-eval
    // time, taking the whole bundle down and leaving a modern SPA as a bare shell.
    // Spec puts them on <a> and <area> only, so they must NOT land on Element.
    const _hyperlinkURL = (el) => {
        const raw = el.getAttribute("href");
        if (!raw) return null;
        try {
            const base = (globalThis.location && globalThis.location.href)
                || (globalThis.__browser_oxide && globalThis.__browser_oxide._baseUrl)
                || undefined;
            return new URL(raw, base);
        } catch (_) {
            return null;
        }
    };
    // Chrome returns "" for every member when href is absent or unparseable — except
    // `origin`, which is "null", and `protocol`, which is ":".
    const _hyperlinkMembers = {
        href: { get: (u, el) => (u ? u.href : (el.getAttribute("href") || "")), set: true },
        origin: { get: (u) => (u ? u.origin : "null") },
        protocol: { get: (u) => (u ? u.protocol : ":"), set: true },
        username: { get: (u) => (u ? u.username : ""), set: true },
        password: { get: (u) => (u ? u.password : ""), set: true },
        host: { get: (u) => (u ? u.host : ""), set: true },
        hostname: { get: (u) => (u ? u.hostname : ""), set: true },
        port: { get: (u) => (u ? u.port : ""), set: true },
        pathname: { get: (u) => (u ? u.pathname : ""), set: true },
        search: { get: (u) => (u ? u.search : ""), set: true },
        hash: { get: (u) => (u ? u.hash : ""), set: true },
    };
    const _defineHyperlinkUtils = (ctor) => {
        for (const [name, spec] of Object.entries(_hyperlinkMembers)) {
            const desc = {
                get() { return spec.get(_hyperlinkURL(this), this); },
                enumerable: true,
                configurable: true,
            };
            if (spec.set) {
                // Setting a component re-serializes the whole URL back into the
                // attribute, which is what Chrome does.
                desc.set = function (val) {
                    if (name === "href") { this.setAttribute("href", String(val)); return; }
                    const u = _hyperlinkURL(this);
                    if (!u) return;
                    try {
                        u[name] = String(val);
                        this.setAttribute("href", u.href);
                    } catch (_) { /* invalid component value: Chrome ignores it */ }
                };
            }
            Object.defineProperty(ctor.prototype, name, desc);
        }
        Object.defineProperty(ctor.prototype, "toString", {
            value: function () { return this.href; },
            writable: true, enumerable: false, configurable: true,
        });
    };
    _defineHyperlinkUtils(HTMLAnchorElement);
    class HTMLImageElement extends HTMLElement {}
    Object.defineProperty(HTMLImageElement.prototype, "width", {
        get() {
            const attr = this.getAttribute("width");
            return attr ? parseInt(attr, 10) : 0;
        },
        enumerable: true, configurable: true
    });
    Object.defineProperty(HTMLImageElement.prototype, "height", {
        get() {
            const attr = this.getAttribute("height");
            return attr ? parseInt(attr, 10) : 0;
        },
        enumerable: true, configurable: true
    });
    // ── Image loading ────────────────────────────────────────────────────
    //
    // These three used to be constants: `complete` was always `true` and the
    // natural size came from the `width`/`height` *content attributes*, so an
    // image without them reported `0x0` while claiming to be complete — a
    // combination a real browser cannot produce, and a cheap tell. Nothing was
    // ever fetched, and neither `load` nor `error` fired, so a widget that
    // waits for its images to arrive waited forever. hCaptcha's challenge tiles
    // are exactly that: the task text rendered and every tile stayed blank.
    //
    // State lives off the element (a WeakMap, not own properties) so
    // `Object.getOwnPropertyNames(img)` keeps Chrome's shape.
    const _imgState = new WeakMap();
    // Intrinsic sizes by resolved URL. A document that shows the same sprite in
    // twenty places should fetch it once, as the HTTP cache would.
    const _imgSizes = new Map();

    const _imgStateOf = (el) => {
        let st = _imgState.get(el);
        if (!st) { st = { done: false, ok: false, w: 0, h: 0, url: null, id: -1 }; _imgState.set(el, st); }
        return st;
    };
    // `drawImage(img, …)` needs the decoded pixels, which live in the canvas
    // state under this id. Exposed on the prototype rather than as an own
    // property so `Object.getOwnPropertyNames(img)` keeps Chrome's shape.
    Object.defineProperty(HTMLImageElement.prototype, '_decodedImageId', {
        get() { return _imgStateOf(this).id; },
        enumerable: false, configurable: true,
    });

    const _startImgLoad = (el, rawSrc) => {
        const st = _imgStateOf(el);
        if (!rawSrc) {
            // Per spec, clearing `src` puts the element back to "no image".
            st.done = false; st.ok = false; st.w = 0; st.h = 0; st.url = null;
            return;
        }
        let url;
        try {
            url = new URL(String(rawSrc), globalThis.location?.href || undefined).href;
        } catch (_) { url = String(rawSrc); }
        if (st.url === url) return;      // same image, nothing to redo
        st.url = url; st.done = false; st.ok = false; st.w = 0; st.h = 0;

        const settle = (ok, w, h, id) => {
            // A `src` reassigned while this load was in flight wins: the stale
            // result must not overwrite the newer one or fire its events.
            if (st.url !== url) return;
            st.done = true; st.ok = ok; st.w = w | 0; st.h = h | 0;
            st.id = (id === undefined || id === null) ? -1 : (id | 0);
            try {
                el.dispatchEvent(new Event(ok ? "load" : "error"));
            } catch (_) { /* ignore */ }
        };

        const cached = _imgSizes.get(url);
        if (cached) {
            // Still a task, never synchronous: a browser fires `load` from the
            // event loop, and code that assigns `src` then attaches `onload`
            // right after would otherwise miss it.
            setTimeout(() => settle(cached.ok, cached.w, cached.h, cached.id), 0);
            return;
        }
        try {
            ops.op_img_load(url).then((r) => {
                const ok = !!(r && r.ok);
                const rec = {
                    ok, w: (r && r.width) | 0, h: (r && r.height) | 0,
                    id: (r && typeof r.id === 'number') ? r.id : -1,
                };
                _imgSizes.set(url, rec);
                settle(rec.ok, rec.w, rec.h, rec.id);
            }, () => settle(false, 0, 0, -1));
        } catch (_) {
            setTimeout(() => settle(false, 0, 0, -1), 0);
        }
    };

    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
        get() { return _imgStateOf(this).w; },
        enumerable: true, configurable: true
    });
    Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", {
        get() { return _imgStateOf(this).h; },
        enumerable: true, configurable: true
    });
    // Chrome: `true` for an element with no `src` at all, and for one whose
    // fetch has settled either way. `false` only while a load is outstanding.
    Object.defineProperty(HTMLImageElement.prototype, "complete", {
        get() {
            const st = _imgStateOf(this);
            if (!st.url) return true;
            return st.done;
        },
        enumerable: true, configurable: true
    });
    Object.defineProperty(HTMLImageElement.prototype, "src", {
        get() {
            const raw = this.getAttribute("src");
            if (raw == null) return "";
            try {
                return new URL(raw, globalThis.location?.href || undefined).href;
            } catch (_) { return raw; }
        },
        set(v) { this.setAttribute("src", String(v)); },
        enumerable: true, configurable: true
    });
    Object.defineProperty(HTMLImageElement.prototype, "currentSrc", {
        get() { return _imgStateOf(this).ok ? _imgStateOf(this).url || "" : ""; },
        enumerable: true, configurable: true
    });
    HTMLImageElement.prototype.decode = function decode() {
        const st = _imgStateOf(this);
        if (st.done) {
            return st.ok
                ? Promise.resolve()
                : Promise.reject(new DOMException("The source image cannot be decoded.", "EncodingError"));
        }
        return new Promise((resolve, reject) => {
            this.addEventListener("load", () => resolve(), { once: true });
            this.addEventListener("error", () => reject(
                new DOMException("The source image cannot be decoded.", "EncodingError")
            ), { once: true });
        });
    };
    // The engine drives loads from the attribute, so markup-parsed images and
    // `img.src = …` take the same path.
    _onImgSrcAttr = (el, value) => _startImgLoad(el, value);

    // Images that came from the markup never pass through `setAttribute`, so
    // the host kicks this off once the document is parsed (right before it
    // dispatches DOMContentLoaded) — same point a browser has finished the
    // parser-triggered fetches.
    try {
        Object.defineProperty(_boNs, 'images', {
            value: {
                scan() {
                    let n = 0;
                    try {
                        const list = document.querySelectorAll('img');
                        for (let i = 0; i < list.length; i++) {
                            const el = list[i];
                            const src = el.getAttribute('src');
                            if (src) { _startImgLoad(el, src); n++; }
                        }
                    } catch (_) { /* ignore */ }
                    return n;
                },
            },
            writable: true, configurable: true, enumerable: false,
        });
    } catch (_) { /* ignore */ }
    class HTMLInputElement extends HTMLElement {}
    class HTMLFormElement extends HTMLElement {
        submit() {
            const action = this.action || (globalThis.location ? globalThis.location.href : '');
            const method = (this.method || 'GET').toUpperCase();

            // Serialize form data
            const params = new URLSearchParams();
            const inputs = this.querySelectorAll('input, textarea, select');
            for (let i = 0; i < inputs.length; i++) {
                const el = inputs[i];
                const name = el.name;
                if (!name || el.disabled) continue;

                const type = (el.type || '').toLowerCase();
                if (type === 'submit' || type === 'button' || type === 'image') continue;
                if ((type === 'checkbox' || type === 'radio') && !el.checked) continue;

                params.append(name, el.value || '');
            }

            let finalUrl = action;
            let finalBody = null;

            if (method === 'GET') {
                const url = new URL(action, globalThis.location ? globalThis.location.href : 'about:blank');
                params.forEach((v, k) => url.searchParams.append(k, v));
                finalUrl = url.href;
            } else {
                finalBody = params.toString();
            }

            // Through the engine's state object, not `globalThis`: the cleanup
            // pass deletes that name, so a form submit wrote its navigation
            // into a fresh global nobody reads and the page never navigated.
            const _st = _boState();
            const _nav = {
                url: finalUrl,
                method: method,
                body: finalBody,
                kind: 'assign'
            };
            if (_st) _st.__pendingNavigation = _nav;
            else globalThis.__pendingNavigation = _nav;
            // Signal the Rust event loop to short-circuit run_until_idle —
            // see crates/js_runtime/src/extensions/nav_ext.rs.
            try { ops.op_set_pending_nav(); } catch (_) {}
        }
        // Spec: `requestSubmit()` fires a cancelable `submit` event and only
        // submits if nothing cancelled it — unlike `submit()`, which fires
        // nothing. Calling `submit()` here skipped the event entirely, so every
        // SPA that does its work in `onSubmit` (React, Vue, Angular — all of
        // them) saw a click that led nowhere, while the engine tried a real
        // form navigation the app never wanted.
        requestSubmit(submitter) {
            if (submitter != null) {
                const t = String(submitter.type || '').toLowerCase();
                if (t !== 'submit' && t !== 'image') {
                    throw new TypeError('The specified element is not a submit button');
                }
                if (submitter.form !== this) {
                    throw new TypeError('The specified element is not owned by this form element');
                }
            }
            const ev = new Event('submit', { bubbles: true, cancelable: true });
            try {
                Object.defineProperty(ev, 'submitter', {
                    value: submitter || null,
                    configurable: true,
                    enumerable: true,
                });
            } catch (_) { /* ignore */ }
            // dispatchEvent returns false once a listener called preventDefault.
            if (this.dispatchEvent(ev)) this.submit();
        }

        reset() {
            const ev = new Event('reset', { bubbles: true, cancelable: true });
            if (!this.dispatchEvent(ev)) return;
            const controls = this.querySelectorAll('input, textarea, select');
            for (let i = 0; i < controls.length; i++) {
                const el = controls[i];
                // Clearing the dirty flags *is* the reset: the getters then
                // read the markup defaults again. Assigning `el.value` here
                // would instead mark the control dirty at its default value.
                if (_clearDirtyValue) _clearDirtyValue(el);
            }
        }
    }

    // IDL property ↔ HTML attribute reflection. Scripts that configure form
    // fields via properties (el.name = 'x', form.action = url, form.method =
    // 'POST') expect the read-back to see what they set — which only works if
    // the property setter writes the underlying attribute. Without this,
    // programmatically-built forms look empty to our submit() serializer.
    // Universal primitive — matches HTML spec "reflect" behavior.
    const _reflectStr = (proto, prop, attr = prop, dflt = '') => {
        Object.defineProperty(proto, prop, {
            get() { const v = this.getAttribute(attr); return v == null ? dflt : v; },
            set(v) { this.setAttribute(attr, String(v)); },
            enumerable: true, configurable: true,
        });
    };
    const _reflectBool = (proto, prop, attr = prop) => {
        Object.defineProperty(proto, prop, {
            get() { return this.hasAttribute(attr); },
            set(v) {
                if (v) this.setAttribute(attr, '');
                else this.removeAttribute(attr);
            },
            enumerable: true, configurable: true,
        });
    };
    _reflectStr(HTMLInputElement.prototype, 'name');
    _reflectStr(HTMLInputElement.prototype, 'type', 'type', 'text');
    _reflectStr(HTMLInputElement.prototype, 'placeholder');
    _reflectBool(HTMLInputElement.prototype, 'disabled');
    _reflectBool(HTMLInputElement.prototype, 'readOnly', 'readonly');
    _reflectBool(HTMLInputElement.prototype, 'required');
    _reflectStr(HTMLFormElement.prototype, 'action');
    _reflectStr(HTMLFormElement.prototype, 'method', 'method', 'get');
    _reflectStr(HTMLFormElement.prototype, 'enctype', 'enctype', 'application/x-www-form-urlencoded');
    _reflectStr(HTMLFormElement.prototype, 'target');
    _reflectStr(HTMLFormElement.prototype, 'name');
    _reflectBool(HTMLFormElement.prototype, 'noValidate', 'novalidate');

    // HTMLFormElement.prototype.elements — live HTMLFormControlsCollection
    // of the form's listed elements (HTML spec §6.4.3: button, fieldset,
    // input, object, output, select, textarea). Reddit's verify-page solver
    // calls `form.elements.namedItem('solution').value = token`; without
    // this getter that throws TypeError, the SPA's pendingNavigation is
    // never set, and the page returns iter=0 with the challenge stub.
    Object.defineProperty(HTMLFormElement.prototype, 'elements', {
        get() {
            const form = this;
            const controls = form.querySelectorAll(
                'button, fieldset, input, object, output, select, textarea',
            );
            const len = controls.length;
            const ctor = globalThis.HTMLFormControlsCollection;
            const wrap = ctor && ctor.prototype
                ? Object.create(ctor.prototype)
                : Object.create(null);
            for (let i = 0; i < len; i++) {
                Object.defineProperty(wrap, i, {
                    value: controls[i],
                    writable: false, configurable: true, enumerable: true,
                });
            }
            Object.defineProperty(wrap, 'length', {
                value: len,
                writable: false, configurable: true, enumerable: false,
            });
            Object.defineProperty(wrap, 'item', {
                value: function item(idx) {
                    idx = Math.trunc(+idx);
                    return idx >= 0 && idx < len ? wrap[idx] : null;
                },
                writable: true, configurable: true, enumerable: false,
            });
            Object.defineProperty(wrap, 'namedItem', {
                value: function namedItem(name) {
                    if (typeof name !== 'string' || name === '') return null;
                    const matches = [];
                    for (let i = 0; i < len; i++) {
                        const el = controls[i];
                        if (el.name === name || el.id === name) matches.push(el);
                    }
                    if (matches.length === 0) return null;
                    if (matches.length === 1) return matches[0];
                    // Spec: multiple → RadioNodeList. Returning an array
                    // covers reddit's single-name case + iteration.
                    return matches;
                },
                writable: true, configurable: true, enumerable: false,
            });
            Object.defineProperty(wrap, Symbol.iterator, {
                value: function* () {
                    for (let i = 0; i < len; i++) yield wrap[i];
                },
                writable: true, configurable: true, enumerable: false,
            });
            return wrap;
        },
        configurable: true,
        enumerable: true,
    });

    class HTMLButtonElement extends HTMLElement {}
    class HTMLSelectElement extends HTMLElement {}
    class HTMLTextAreaElement extends HTMLElement {}

    // --- form association + activation behaviour ---
    //
    // Two spec pieces that were missing and cost the same thing: a click on a
    // submit button did nothing at all. `.form` is how every form-associated
    // control names its owner (and what `requestSubmit` validates against), and
    // activation behaviour is the *default action* a click runs after dispatch.
    // Without them the engine delivered a perfectly-shaped click event and then
    // stopped, so a login form looked alive and submitted nothing.
    const _formOwnerGetter = {
        get() {
            const id = this.getAttribute('form');
            if (id) {
                const f = _document.getElementById(id);
                return f && f.tagName === 'FORM' ? f : null;
            }
            let n = this.parentNode;
            while (n && n.nodeType === 1) {
                if (n.tagName === 'FORM') return n;
                n = n.parentNode;
            }
            return null;
        },
        configurable: true,
        enumerable: true,
    };
    [HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement].forEach((C) => {
        try { Object.defineProperty(C.prototype, 'form', _formOwnerGetter); } catch (_) { /* ignore */ }
    });

    // A button with no explicit type is a submit button (HTML default).
    function _buttonType(el) {
        const t = el.getAttribute('type');
        return t ? String(t).toLowerCase() : (el.tagName === 'BUTTON' ? 'submit' : '');
    }

    function _runActivation(el) {
        if (!el || el.nodeType !== 1 || el.disabled) return;
        const tag = el.tagName;
        if (tag !== 'BUTTON' && tag !== 'INPUT') return;
        const type = _buttonType(el);
        if (type !== 'submit' && type !== 'reset' && type !== 'image') return;
        const form = el.form;
        if (!form) return;
        if (type === 'reset') form.reset();
        else form.requestSubmit(el);
    }

    // Shared with `humanize.js`, which dispatches its own pointer/mouse sequence
    // and so never reaches `click()` below. Non-enumerable, same discipline as
    // the other `__bo_` hooks.
    try {
        Object.defineProperty(_boNs, 'activate', {
            value: _runActivation,
            writable: false,
            configurable: true,
            enumerable: false,
        });
    } catch (_) { /* ignore */ }
    class HTMLCanvasElement extends HTMLElement {}
    Object.defineProperty(HTMLCanvasElement.prototype, "width", {
        get() {
            const attr = this.getAttribute("width");
            return attr ? parseInt(attr, 10) : 300;
        },
        set(v) { this.setAttribute("width", v); },
        enumerable: true, configurable: true
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "height", {
        get() {
            const attr = this.getAttribute("height");
            return attr ? parseInt(attr, 10) : 150;
        },
        set(v) { this.setAttribute("height", v); },
        enumerable: true, configurable: true
    });
    HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
        if (!this._canvasId) {
            let osName = "Linux", canvasSeed = 0n;
            try {
                if (ops.op_has_stealth_profile && ops.op_has_stealth_profile()) {
                    osName = ops.op_get_profile_value("os_name") || "Linux";
                    canvasSeed = BigInt(ops.op_get_profile_value("canvas_seed") || "0");
                }
            } catch (_e) { /* fall back to defaults */ }
            this._canvasId = ops.op_canvas_create(this.width, this.height, osName, canvasSeed);
        }
        return ops.op_canvas_to_data_url(this._canvasId);
    };
    class HTMLScriptElement extends HTMLElement {}
    class HTMLStyleElement extends HTMLElement {}
    // CSSOM for <style>. Emotion, styled-components and MUI ship ALL of their CSS
    // through `sheet.insertRule` in production ("speedy" mode) — with no `sheet`
    // property that path threw, and every rule those libraries generate was lost, so
    // a modern app rendered as an unstyled DOM with garbage geometry.
    //
    // Rules are mirrored into the element's text content rather than kept in a
    // side table: the cascade already re-reads <style> text, it makes injected CSS
    // survive serialisation (outerHTML), and it keeps one source of truth.
    const _sheets = new WeakMap();
    Object.defineProperty(HTMLStyleElement.prototype, "sheet", {
        get() {
            let s = _sheets.get(this);
            if (!s) { s = new CSSStyleSheet(this); _sheets.set(this, s); }
            return s;
        },
        enumerable: true, configurable: true,
    });
    class HTMLLinkElement extends HTMLElement {}
    class HTMLMetaElement extends HTMLElement {}
    class HTMLTableElement extends HTMLElement {}
    class HTMLIFrameElement extends HTMLElement {}

    // `iframe.src = url` must write the *attribute*. Without reflection the
    // assignment lands as an own property on a transient wrapper, so two things
    // break at once: the host's DOM scan never sees a src and never materializes
    // the frame, and the value disappears the next time the node is re-wrapped.
    // A widget that builds its own iframe from script — hCaptcha's invisible
    // checkbox frame does exactly this — then has a frame the page can post to
    // and nothing on the other end. Per spec the getter returns an absolute URL.
    Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
        get() {
            const v = this.getAttribute('src');
            if (v == null || v === '') return '';
            try {
                return new URL(v, globalThis.location ? globalThis.location.href : undefined).href;
            } catch (_) {
                return v;
            }
        },
        set(v) { this.setAttribute('src', String(v)); },
        enumerable: true,
        configurable: true,
    });
    _reflectStr(HTMLIFrameElement.prototype, 'srcdoc');
    _reflectStr(HTMLIFrameElement.prototype, 'name');

    class HTMLVideoElement extends HTMLElement {}
    class HTMLAudioElement extends HTMLElement {}
    class HTMLBodyElement extends HTMLElement {}
    class HTMLHeadElement extends HTMLElement {}
    class HTMLHtmlElement extends HTMLElement {}
    class HTMLUListElement extends HTMLElement {}
    class HTMLOListElement extends HTMLElement {}
    class HTMLLIElement extends HTMLElement {}
    class HTMLTableRowElement extends HTMLElement {}
    class HTMLTableCellElement extends HTMLElement {}
    class HTMLTableSectionElement extends HTMLElement {}
    class HTMLLabelElement extends HTMLElement {}
    class HTMLOptionElement extends HTMLElement {}
    // A `<template>`'s children do not live in the tree — they live in a
    // separate `DocumentFragment` reachable as `.content`, and `innerHTML` reads
    // and writes that fragment rather than the element.
    //
    // Without `content` the whole idiom collapses at its most common use:
    //
    //     const t = document.createElement('template');
    //     t.innerHTML = markup;
    //     return document.importNode(t.content, true);   // content undefined
    //
    // which is how creepjs builds every node it renders — each call threw
    // "Cannot read properties of undefined (reading 'cloneNode')" and the report
    // stayed empty while its data collection had already finished.
    //
    // Contents are adopted lazily rather than at parse time: this engine's
    // parser leaves them as ordinary children, and moving them on first access
    // is enough for everything that goes through `.content`.
    const _templateContent = new Map();

    class HTMLTemplateElement extends HTMLElement {
        get content() {
            const id = _getNodeId(this);
            let frag = _templateContent.get(id);
            if (!frag) {
                frag = _document.createDocumentFragment();
                _templateContent.set(id, frag);
                while (this.firstChild) frag.appendChild(this.firstChild);
            }
            return frag;
        }
        get innerHTML() {
            const frag = this.content;
            let out = "";
            for (let c = frag.firstChild; c; c = c.nextSibling) {
                out += c.nodeType === 1 ? c.outerHTML : (c.textContent || "");
            }
            return out;
        }
        set innerHTML(html) {
            const frag = this.content;
            while (frag.firstChild) frag.removeChild(frag.firstChild);
            const holder = _document.createElement("div");
            holder.innerHTML = String(html);
            while (holder.firstChild) frag.appendChild(holder.firstChild);
        }
    }
    class HTMLPreElement extends HTMLElement {}
    class HTMLQuoteElement extends HTMLElement {}

    // Tag → specific HTML*Element prototype map. Anything not listed falls
    // back to HTMLElement.prototype.
    const _tagToProto = {
        div: HTMLDivElement.prototype,
        span: HTMLSpanElement.prototype,
        p: HTMLParagraphElement.prototype,
        h1: HTMLHeadingElement.prototype,
        h2: HTMLHeadingElement.prototype,
        h3: HTMLHeadingElement.prototype,
        h4: HTMLHeadingElement.prototype,
        h5: HTMLHeadingElement.prototype,
        h6: HTMLHeadingElement.prototype,
        a: HTMLAnchorElement.prototype,
        img: HTMLImageElement.prototype,
        input: HTMLInputElement.prototype,
        form: HTMLFormElement.prototype,
        button: HTMLButtonElement.prototype,
        select: HTMLSelectElement.prototype,
        textarea: HTMLTextAreaElement.prototype,
        canvas: HTMLCanvasElement.prototype,
        script: HTMLScriptElement.prototype,
        style: HTMLStyleElement.prototype,
        link: HTMLLinkElement.prototype,
        meta: HTMLMetaElement.prototype,
        table: HTMLTableElement.prototype,
        iframe: HTMLIFrameElement.prototype,
        video: HTMLVideoElement.prototype,
        audio: HTMLAudioElement.prototype,
        body: HTMLBodyElement.prototype,
        head: HTMLHeadElement.prototype,
        html: HTMLHtmlElement.prototype,
        ul: HTMLUListElement.prototype,
        ol: HTMLOListElement.prototype,
        li: HTMLLIElement.prototype,
        tr: HTMLTableRowElement.prototype,
        td: HTMLTableCellElement.prototype,
        th: HTMLTableCellElement.prototype,
        thead: HTMLTableSectionElement.prototype,
        tbody: HTMLTableSectionElement.prototype,
        tfoot: HTMLTableSectionElement.prototype,
        label: HTMLLabelElement.prototype,
        option: HTMLOptionElement.prototype,
        template: HTMLTemplateElement.prototype,
        pre: HTMLPreElement.prototype,
        blockquote: HTMLQuoteElement.prototype,
        q: HTMLQuoteElement.prototype,
    };

    // Adjust an Element instance's prototype to the tag-specific subclass
    // so `el instanceof HTMLDivElement` works as in real Chrome.
    // `document.currentScript` must point at the executing element for the whole
    // of a classic script's run — dynamically inserted ones included. A library
    // reads its own tag through it to recover the parameters it was configured
    // with: hCaptcha's `api.js` finds `?onload=<name>` that way and calls the
    // callback the embedder is waiting on. With `currentScript` null it loads,
    // exposes its whole API, and never signals readiness to anyone.
    /// Restore `document.currentScript` once the whole microtask queue has
    /// drained, not one tick later.
    ///
    /// HTML's "clean up after running script" performs a microtask *checkpoint*
    /// — it runs the queue to exhaustion, chained continuations included — and
    /// only then is `currentScript` restored. So a task, not a microtask:
    /// deno_core drains every pending microtask before the next task runs,
    /// which reproduces the checkpoint exactly. A `queueMicrotask` reset is one
    /// tick and lands in the middle of any `await` chain.
    ///
    /// Turbopack's `registerChunk` is such a chain: it awaits its sibling
    /// chunks and only then evaluates the entry module, where Next.js's
    /// `getAssetPrefix()` throws `Invariant: Expected document.currentScript to
    /// be a <script> element` on null — which aborted hydration on every
    /// Next.js page built with Turbopack.
    ///
    /// The guard leaves a nested or subsequent script's element alone: only the
    /// script that is still current restores.
    function _clearCurrentScriptLater(to) {
        const mine = _currentScript;
        const restore = () => { if (_currentScript === mine) _setCurrentScript(to ?? null); };
        // A plain `setTimeout`, not the engine's background timer: the
        // background one does not hold `run_until_idle` open, so the restore
        // could be dropped and `document.currentScript` would still name the
        // last script once the document was idle. One 0 ms timer per script is
        // the cost of getting the reset to actually happen.
        setTimeout(restore, 0);
    }

    function _evalAsScript(code, el) {
        const prev = _currentScript;
        const mine = el || null;
        _setCurrentScript(mine);
        try {
            (0, eval)(code);
        } finally {
            // Restored synchronously: HTML performs the microtask checkpoint
            // only when the JS stack is empty, and a script inserted from
            // inside running page code never empties it. `document.currentScript`
            // is therefore back to its previous value by the time `appendChild`
            // returns. (The document's *own* scripts do empty the stack — see
            // `clear_current_script_js` in `page.rs`, which defers instead.)
            _setCurrentScript(prev);
        }
    }

    // SVG graphics elements, by tag. Elements parsed out of markup never pass
    // through `createElementNS`, so this is where they get their geometry.
    const _SVG_TAGS = new Set([
        "svg", "g", "rect", "circle", "ellipse", "line", "path", "polygon",
        "polyline", "text", "tspan", "use", "image", "symbol", "foreignobject",
    ]);

    function _retargetElementProto(el) {
        try {
            const tag = ops.op_dom_get_tag_name(_getNodeId(el)).toLowerCase();
            const proto = _tagToProto[tag] || HTMLElement.prototype;
            Object.setPrototypeOf(el, proto);
            if (_SVG_TAGS.has(tag)) _installSvgGeometry(el, tag);
        } catch {}
    }

    // `new Text('x')`, `new Comment('x')` and `new DocumentFragment()` are all
    // constructible in a browser and all three produce real nodes. Without a
    // constructor they produced an object with no arena node behind it:
    // `nodeType` read 0 and every mutation was a silent no-op, so
    //
    //     const frag = new DocumentFragment();
    //     frag.appendChild(el);          // does nothing
    //     document.body.appendChild(frag); // inserts nothing
    //
    // put nothing in the document and reported no error. Measured consequence:
    // creepjs builds its measurement iframe exactly that way, finds no frame
    // where it expects one, silently falls back to the *main* window, and then
    // overwrites the real page with its own `@media` probe markup — the page
    // went from 246 elements to 13 and rendered blank.
    //
    // See `_ADOPT` at the top of this file.
    class Text extends Node {
        constructor(data, adopt) {
            super(adopt === _ADOPT
                ? data
                : ops.op_dom_create_text_node(data === undefined ? "" : String(data)));
        }
        get data() { return ops.op_dom_get_text_content(_getNodeId(this)); }
        set data(val) { ops.op_dom_set_text_content(_getNodeId(this), String(val)); }
        get length() { return this.data.length; }
        get wholeText() { return this.data; }
    }

    class Comment extends Node {
        constructor(data, adopt) {
            super(adopt === _ADOPT
                ? data
                : ops.op_dom_create_comment(data === undefined ? "" : String(data)));
        }
        get data() { return ops.op_dom_get_text_content(_getNodeId(this)); }
        set data(val) { ops.op_dom_set_text_content(_getNodeId(this), String(val)); }
    }

    class DocumentFragment extends Node {
        constructor(nodeId, adopt) {
            super(adopt === _ADOPT ? nodeId : ops.op_dom_create_document_fragment());
        }
    }

    let _currentScript = null;
    // Where each script's next `document.write` continues from, by node id.
    const _writeAnchors = new Map();
    function _setCurrentScript(el) { _currentScript = el; }

    class HTMLAllCollection {
        constructor(doc) {
            this._doc = doc;
        }
        get length() { return this._doc.querySelectorAll("*").length; }
        item(i) { return this._doc.querySelectorAll("*")[i] || null; }
        namedItem(n) {
            return this._doc.getElementById(n) || 
                   this._doc.querySelector(`[name="${CSS.escape(n)}"]`) || 
                   null;
        }
        [Symbol.iterator]() {
            const nodes = this._doc.querySelectorAll("*");
            let i = 0;
            return {
                next() {
                    return i < nodes.length ? { value: nodes[i++], done: false } : { value: undefined, done: true };
                },
                [Symbol.iterator]() { return this; }
            };
        }
    }

    class Document extends Node {
        constructor(nodeId) {
            // Forward the document node id to Node so _getNodeId returns
            // the real Rust-side Document. Without this, document.nodeType
            // resolved to 0 (the "no such node" sentinel), which broke
            // anything walking parentNode→isConnected. Phase 7 follow-up.
            super(nodeId);
            if (!globalThis.__browser_oxide) {
                Object.defineProperty(globalThis, '__browser_oxide', { value: {}, enumerable: false, configurable: true });
            }
            // Capture initial base URL from ops or a global hint
            globalThis.__browser_oxide._baseUrl = ops.op_dom_get_base_url && ops.op_dom_get_base_url();

            const all = new HTMLAllCollection(this);
            // Hide 'all' from enumeration but keep it truthy
            Object.defineProperty(this, 'all', {
                get() { return all; },
                enumerable: false,
                configurable: true
            });
        }
        get scripts() { return this.getElementsByTagName("script"); }
        get currentScript() { return _currentScript; }
        get visibilityState() { return "visible"; }
        get hidden() { return false; }
        get webkitVisibilityState() { return "visible"; }
        get webkitHidden() { return false; }
        get fullscreenEnabled() { return true; }
        get webkitFullscreenEnabled() { return true; }
        get webkitIsFullScreen() { return false; }

        get documentElement() {
            const els = ops.op_dom_get_child_elements(ops.op_dom_document_node());
            return els.length > 0 ? _wrapNode(els[0]) : null;
        }
        get head() { return this.querySelector("head"); }
        get body() { return this.querySelector("body"); }
        get title() {
            const el = this.querySelector("title");
            return el ? el.textContent : "";
        }
        set title(val) {
            let el = this.querySelector("title");
            if (el) { el.textContent = val; }
        }
        getElementById(id) {
            const nodeId = ops.op_dom_get_element_by_id(id);
            return nodeId !== null ? _wrapNode(nodeId) : null;
        }
        getElementsByTagName(tag) {
            return new NodeList(ops.op_dom_get_elements_by_tag_name(ops.op_dom_document_node(), tag));
        }
        getElementsByClassName(cls) {
            return new NodeList(ops.op_dom_get_elements_by_class_name(ops.op_dom_document_node(), cls));
        }
        // React reads `document.getElementsByName` while restoring form state
        // during hydration; without it every Next.js page died with
        // `document.getElementsByName is not a function` and rendered only
        // Next's "Application error" fallback.
        getElementsByName(name) {
            const sel = `[name="${String(name).replace(/(["\\])/g, "\\$1")}"]`;
            return new NodeList(
                ops.op_dom_query_selector_all(ops.op_dom_document_node(), sel),
            );
        }
        querySelector(sel) {
            const id = ops.op_dom_query_selector(ops.op_dom_document_node(), sel);
            return id !== null ? _wrapNode(id) : null;
        }
        querySelectorAll(sel) {
            return new NodeList(ops.op_dom_query_selector_all(ops.op_dom_document_node(), sel));
        }
        createElement(tag) {
            const el = _wrapNode(ops.op_dom_create_element(tag));
            if (tag.toLowerCase() === "script") {
                let _src = "";
                // Capture the real descriptor to avoid infinite recursion
                const proto = Object.getPrototypeOf(el);
                const origSrc = Object.getOwnPropertyDescriptor(proto, 'src');

                Object.defineProperty(el, "src", {
                    get: () => _src,
                    set: (v) => {
                        // Coerced, because the assigned value is not always a
                        // string: a module loader may hand over a `URL` or a
                        // `TrustedScriptURL`, and calling `.includes` on one threw
                        // straight out of the setter. Webpack's chunk loader does
                        // exactly that, so the throw took out every lazily-loaded
                        // chunk — and with them a whole application's bootstrap.
                        const value = String(v);
                        _src = value;
                        if (origSrc && origSrc.set) {
                            origSrc.set.call(el, value);
                        } else {
                            el.setAttribute("src", value);
                        }
                    },
                    configurable: true,
                });
            }
            return el;
        }
        createElementNS(ns, tag) {
            // Namespaced elements are ordinary ones here, with one addition:
            // SVG graphics elements answer `getBBox()`. It is defined per element
            // rather than on `Element.prototype` because this engine aliases
            // `SVGElement` to `Element`, and putting it on the prototype would
            // hand `getBBox` to every `<div>` on the page — a difference from
            // Chrome that is one `in` check away.
            const el = this.createElement(tag);
            if (String(ns || "").indexOf("svg") >= 0) _installSvgGeometry(el, tag);
            return el;
        }
        createTextNode(text) {
            return _wrapNode(ops.op_dom_create_text_node(text));
        }
        createDocumentFragment() {
            return _wrapNode(ops.op_dom_create_document_fragment());
        }
        createComment(text) {
            return _wrapNode(ops.op_dom_create_comment(text === undefined ? "" : String(text)));
        }
        /// Legacy event factory. Its argument is an *interface* name, not an
        /// event type: `createEvent('MouseEvent')` hands back an uninitialised
        /// MouseEvent whose `type` is empty until `initEvent` fills it in.
        /// Treating the argument as the type produced an `Event` called
        /// "MouseEvent" that nothing ever listened for.
        createEvent(iface) {
            const name = String(iface || "").toLowerCase();
            const g = globalThis;
            const table = {
                event: g.Event, events: g.Event, htmlevents: g.Event,
                customevent: g.CustomEvent,
                uievent: g.UIEvent, uievents: g.UIEvent,
                mouseevent: g.MouseEvent, mouseevents: g.MouseEvent,
                keyboardevent: g.KeyboardEvent, keyevents: g.KeyboardEvent,
                focusevent: g.FocusEvent,
                wheelevent: g.WheelEvent,
                touchevent: g.TouchEvent,
                dragevent: g.DragEvent,
                messageevent: g.MessageEvent,
                storageevent: g.StorageEvent,
                hashchangeevent: g.HashChangeEvent,
                popstateevent: g.PopStateEvent,
                progressevent: g.ProgressEvent,
                compositionevent: g.CompositionEvent,
                animationevent: g.AnimationEvent,
                transitionevent: g.TransitionEvent,
            };
            const Ctor = table[name];
            if (typeof Ctor !== "function") {
                throw new DOMException(
                    "Failed to execute 'createEvent' on 'Document': The provided event type " +
                    "('" + iface + "') is invalid.",
                    "NotSupportedError");
            }
            const ev = new Ctor("");
            // Uninitialised until `initEvent`, as in a browser.
            ev.bubbles = false;
            ev.cancelable = false;
            return ev;
        }
        createRange() {
            return new Range();
        }
        createTreeWalker(root, whatToShow, filter) {
            return { currentNode: root, nextNode() { return null; }, previousNode() { return null; } };
        }
        createNodeIterator(root, whatToShow, filter) {
            return { nextNode() { return null; }, previousNode() { return null; } };
        }
        importNode(node, deep) { return node.cloneNode(deep); }
        adoptNode(node) {
            // Detach from current parent, adopt into this document
            if (node.parentNode) node.parentNode.removeChild(node);
            return node;
        }
        createAttribute(name) {
            return { name, value: "", specified: true };
        }
        // document.open/close — reset and finalize document stream
        open() { return this; }
        close() {}
        write(html) {
            // Written markup belongs at the parser's insertion point, which is
            // where the writing <script> sits — not at the end of <body>, which
            // is where it used to land. `_writeAnchors` carries the position
            // forward so a script calling write() repeatedly keeps its order.
            //
            // With no script running there is nothing to anchor to. The spec
            // says such a write reopens and wipes the document; this engine
            // keeps the old append instead, because a blanked page is a worse
            // answer than a misplaced one for anything driving it.
            const script = _currentScript;
            const anchorId = script ? _writeAnchors.get(_getNodeId(script)) : undefined;
            let newIds;
            if (script && script.parentNode) {
                const from = anchorId === undefined ? _getNodeId(script) : anchorId;
                newIds = ops.op_dom_document_write_after(from, String(html));
                if (Array.isArray(newIds) && newIds.length) {
                    _writeAnchors.set(_getNodeId(script), newIds[newIds.length - 1]);
                }
            } else {
                newIds = ops.op_dom_document_write(String(html));
            }
            // Chrome runs any <script> the write inserts synchronously, so the
            // insertion hook is driven in sync mode here.
            if (Array.isArray(newIds)) {
                for (const id of newIds) {
                    const node = _wrapNode(id);
                    if (node) _onNodeInserted(node, true);
                }
            }
        }
        writeln(html) {
            this.write(html + "\n");
        }
        // Selection and editing
        execCommand(command, showUI, value) { return false; }
        queryCommandSupported(command) { return false; }
        queryCommandEnabled(command) { return false; }
        getSelection() { return globalThis.getSelection ? globalThis.getSelection() : null; }
        // Point-based queries. Per spec, a point OUTSIDE the viewport
        // (negative, or >= innerWidth/innerHeight) returns null / []. Real
        // Chrome returns null for elementFromPoint(-1,-1) and (99999,99999);
        // the previous unconditional `return this.body` differed from
        // real Chrome's layout behaviour for out-of-bounds points.
        // We lack full layout, so an in-viewport
        // point still approximates the topmost element with body (falling back
        // to documentElement) — but the viewport-bounds null result, which is
        // the detectable behaviour, is now spec-correct.
        _pointInViewport(x, y) {
            x = +x; y = +y;
            const w = globalThis.innerWidth || 0;
            const h = globalThis.innerHeight || 0;
            return x >= 0 && y >= 0 && x < w && y < h;
        }
        /// Everything under the point, topmost first.
        ///
        /// Both entry points used to answer `body` for any point inside the
        /// viewport, whatever was actually drawn there. Anything that asks "is
        /// my element the thing at this coordinate" — hit-testing before a
        /// click, an overlay checking whether it is covered, a widget routing a
        /// gesture — got the same wrong answer every time. Layout gives real
        /// boxes now, so the question can be answered from them.
        _hitStack(x, y) {
            if (!this._pointInViewport(x, y)) return [];
            x = +x; y = +y;
            const hits = [];
            let all;
            try { all = this.querySelectorAll('*'); } catch (_e) { return []; }
            for (let i = 0; i < all.length; i++) {
                const el = all[i];
                let st = null;
                try { st = getComputedStyle(el); } catch (_e) { /* ignore */ }
                if (st) {
                    if (st.display === 'none') continue;
                    if (st.visibility === 'hidden' || st.visibility === 'collapse') continue;
                    if (st.pointerEvents === 'none') continue;
                }
                let r;
                try { r = el.getBoundingClientRect(); } catch (_e) { continue; }
                if (!r || r.width <= 0 || r.height <= 0) continue;
                if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue;
                let z = 0;
                let positioned = 0;
                if (st) {
                    positioned = st.position && st.position !== 'static' ? 1 : 0;
                    const zi = parseInt(st.zIndex, 10);
                    if (positioned && isFinite(zi)) z = zi;
                }
                hits.push({ el, z, positioned, order: i });
            }
            // Painting order, approximated by the three rules that decide it in
            // practice: a higher `z-index` wins, a positioned box paints over a
            // static one, and otherwise whatever comes later in the document is
            // on top — which also puts a descendant above its ancestor, since it
            // always comes after it. Sorting by tree depth instead let a deeply
            // nested box on an untouched part of the page beat an overlay that
            // was appended over it.
            hits.sort((a, b) =>
                (b.z - a.z) || (b.positioned - a.positioned) || (b.order - a.order));
            return hits.map((h) => h.el);
        }
        elementFromPoint(x, y) {
            if (!this._pointInViewport(x, y)) return null;
            const stack = this._hitStack(x, y);
            return stack.length ? stack[0] : (this.body || this.documentElement || null);
        }
        elementsFromPoint(x, y) {
            if (!this._pointInViewport(x, y)) return [];
            const stack = this._hitStack(x, y);
            if (stack.length) return stack;
            return this.body ? [this.body] : [];
        }
        caretPositionFromPoint(x, y) { return null; }
        hasFocus() { return true; }  // Anti-bot: must return true
        get readyState() { 
            return (_boState() || {}).__documentReadyState || "complete"; 
        }
        get URL() { return globalThis.location?.href || "about:blank"; }
        get documentURI() { return this.URL; }
        get domain() { return globalThis.location?.hostname || ""; }
        get location() { return globalThis.location; }
        set location(val) { if (globalThis.location) globalThis.location.href = val; }
        get referrer() { return ""; }
        get hidden() { return false; }
        get visibilityState() { return "visible"; }
        get cookie() {
            // Unified cookie jar: returns the mirror of net::cookies for this origin.
            // The mirror is refreshed synchronously on every page navigation and after
            // each fetch() response via _syncCookiesFromNet().
            return Object.entries(_cookieMirror())
                .map(([k, v]) => `${k}=${v}`)
                .join("; ");
        }
        set cookie(val) {
            // Parse "name=value; path=/; ..." — update local mirror AND push to net::cookies.
            const _mirror = _cookieMirror();
            const parts = String(val).split(";");
            const [name, ...rest] = (parts[0] || "").split("=");
            const key = name.trim();
            const value = rest.join("=").trim();
            if (!key) return;
            // Check for max-age=0 or expires in the past (delete cookie)
            const lower = String(val).toLowerCase();
            if (lower.includes("max-age=0") || lower.includes("max-age=-")) {
                delete _mirror[key];
            } else {
                _mirror[key] = value;
            }
            // Fire-and-forget propagation to the net layer.
            try {
                let url = globalThis.location?.href;
                if (!url || url === "about:blank" || url === "javascript:;" || url === "") {
                    url = globalThis.__browser_oxide && globalThis.__browser_oxide._baseUrl;
                }
                if (url) {
                    // Persist into the Rust
                    // jar SYNCHRONOUSLY. The async op_cookie_set was
                    // fire-and-forget, so a cookie set in the last microtasks
                    // before location.reload() (e.g. a challenge token) was
                    // lost — the reload re-fetched the stub. op_cookie_set_sync
                    // writes immediately (try_lock) with an async fallback.
                    if (ops.op_cookie_set_sync) {
                        ops.op_cookie_set_sync(url, String(val));
                    } else if (ops.op_cookie_set) {
                        ops.op_cookie_set(url, String(val));
                    }
                }
            } catch (e) { /* ignore */ }
        }
        // HTML legacy default per HTML Standard §2.4 — Chrome reports
        // "windows-1252" for HTML documents without an explicit
        // `<meta charset>` declaration. Verified against a real browser
        // (which reports "windows-1252").
        get characterSet() { return "windows-1252"; }
        get charset() { return "windows-1252"; }
        get contentType() { return "text/html"; }
        get compatMode() { return "CSS1Compat"; }
        // document.implementation — the DOMImplementation API. fpCollect and
        // several bot tests call createHTMLDocument() to verify the surface.
        get implementation() {
            return {
                createHTMLDocument(title) {
                    // Return a stub document with just enough of the Document
                    // API to satisfy fingerprinters. Real browsers return a
                    // fully functional Document, but our stubs never read it.
                    return {
                        title: title || "",
                        body: { innerHTML: "", appendChild: () => {} },
                        head: { appendChild: () => {} },
                        documentElement: { innerHTML: "" },
                        createElement(tag) {
                            return { tagName: tag.toUpperCase(), innerHTML: "", appendChild: () => {} };
                        },
                        createTextNode(t) { return { nodeValue: t }; },
                        querySelector() { return null; },
                        querySelectorAll() { return []; },
                    };
                },
                createDocument(ns, qualifiedName, doctype) {
                    return this.createHTMLDocument("");
                },
                createDocumentType(qualifiedName, publicId, systemId) {
                    return { name: qualifiedName, publicId, systemId };
                },
                hasFeature() { return true; },
            };
        }
        get doctype() { return null; }
        get defaultView() { return globalThis; }
        get activeElement() {
            // A detached element cannot stay focused — Chrome falls back to the
            // body the moment the focused node leaves the tree.
            if (_activeElement) {
                try {
                    if (_activeElement.isConnected !== false) return _activeElement;
                } catch (_) { /* fall through */ }
                _activeElement = null;
            }
            return this.body;
        }
        hasFocus() { return true; }
        get scripts() { return this.getElementsByTagName("script"); }
        get forms() { return this.getElementsByTagName("form"); }
        get images() { return this.getElementsByTagName("img"); }
        get links() { return this.getElementsByTagName("a"); }
        get embeds() { return this.getElementsByTagName("embed"); }
        get anchors() { return this.querySelectorAll("a[name]"); }
        get styleSheets() {
            const count = ops.op_dom_get_stylesheet_count();
            const sheets = [];
            for (let i = 0; i < count; i++) {
                sheets.push(new CSSStyleSheet(i));
            }
            return sheets;
        }
        get fullscreenElement() { return null; }
        get pointerLockElement() { return null; }
        exitFullscreen() { return Promise.resolve(); }
        exitPointerLock() {}
    }

    // --- CSSOM ---
    class CSSStyleSheet {
        // Two flavours: index-based (document.styleSheets) and owner-based
        // (styleElement.sheet). Only the owner-based one can be mutated, because the
        // rule text lives in that element — see the `sheet` getter above.
        constructor(indexOrOwner) {
            if (indexOrOwner && typeof indexOrOwner === "object") {
                this._owner = indexOrOwner;
                this._index = -1;
            } else {
                this._owner = null;
                this._index = indexOrOwner;
            }
        }
        get type() { return "text/css"; }
        get disabled() { return false; }
        get ownerNode() { return this._owner; }
        get parentStyleSheet() { return null; }
        get title() { return null; }
        get media() { return { length: 0, mediaText: "" }; }
        /// Rule texts of an owner-backed sheet, split on top-level `}`.
        _ownerRuleTexts() {
            const text = (this._owner && this._owner.textContent) || "";
            const out = [];
            let depth = 0, start = 0;
            for (let i = 0; i < text.length; i++) {
                if (text[i] === "{") depth++;
                else if (text[i] === "}") {
                    depth--;
                    if (depth === 0) {
                        const chunk = text.slice(start, i + 1).trim();
                        if (chunk) out.push(chunk);
                        start = i + 1;
                    }
                }
            }
            return out;
        }
        get cssRules() {
            if (this._owner) {
                return this._ownerRuleTexts().map((t) => new CSSStyleRule({
                    selector_text: t.slice(0, t.indexOf("{")).trim(),
                    css_text: t,
                    rule_type: t.startsWith("@") ? 4 : 1,
                }));
            }
            const raw = ops.op_dom_get_stylesheet_rules(this._index);
            return raw.map(r => new CSSStyleRule(r));
        }
        get rules() { return this.cssRules; }
        // insertRule used to be a no-op returning 0. Emotion/MUI push every rule they
        // generate through it, so the whole design system silently evaporated. Rules
        // are written back into the owner <style> element's text, which is the same
        // source the Rust cascade re-reads.
        insertRule(rule, index) {
            if (!this._owner) return 0;
            const texts = this._ownerRuleTexts();
            const at = index === undefined ? texts.length : Number(index);
            if (at < 0 || at > texts.length) {
                throw new DOMException(
                    "Failed to execute 'insertRule' on 'CSSStyleSheet': the index provided is larger than the maximum size of the rule list.",
                    "IndexSizeError");
            }
            texts.splice(at, 0, String(rule));
            this._owner.textContent = texts.join("\n");
            return at;
        }
        deleteRule(index) {
            if (!this._owner) return;
            const texts = this._ownerRuleTexts();
            const at = Number(index);
            if (at < 0 || at >= texts.length) {
                throw new DOMException(
                    "Failed to execute 'deleteRule' on 'CSSStyleSheet': the index provided is larger than the maximum size of the rule list.",
                    "IndexSizeError");
            }
            texts.splice(at, 1);
            this._owner.textContent = texts.join("\n");
        }
        replaceSync(text) { if (this._owner) this._owner.textContent = String(text); }
        replace(text) { this.replaceSync(text); return Promise.resolve(this); }
    }
    globalThis.CSSStyleSheet = CSSStyleSheet;

    class CSSStyleRule {
        constructor({ selector_text, css_text, rule_type }) {
            this.selectorText = selector_text;
            this.cssText = css_text;
            this.type = rule_type;
            // Parse declarations into style-like object
            const styleObj = {};
            const declMatch = css_text.match(/\{([^}]*)\}/);
            if (declMatch) {
                for (const part of declMatch[1].split(";")) {
                    const [prop, ...vals] = part.split(":");
                    if (prop && vals.length) {
                        const p = prop.trim();
                        const v = vals.join(":").trim();
                        styleObj[p] = v;
                        // Also set camelCase version
                        const camel = p.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                        if (camel !== p) styleObj[camel] = v;
                    }
                }
            }
            this.style = styleObj;
        }
    }

    // --- Range (minimal) ---
    class Range {
        constructor() {
            this.startContainer = null; this.startOffset = 0;
            this.endContainer = null; this.endOffset = 0;
            this.collapsed = true; this.commonAncestorContainer = null;
        }
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; this.collapsed = false; }
        setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }
        collapse(toStart) { this.collapsed = true; }
        cloneRange() {
            const copy = new Range();
            copy.startContainer = this.startContainer;
            copy.startOffset = this.startOffset;
            copy.endContainer = this.endContainer;
            copy.endOffset = this.endOffset;
            copy.collapsed = this.collapsed;
            copy._selected = this._selected;
            return copy;
        }
        // Selecting a node is how the geometry of a range is normally set up —
        // `range.selectNode(el); range.getClientRects()` is the standard way to
        // cross-check an element's own rects, and it was missing entirely, so the
        // whole idiom threw. With it, the rects come from the selected node,
        // which is what a browser reports for a range that spans exactly one.
        selectNode(node) {
            this._selected = node;
            this.startContainer = node && node.parentNode;
            this.endContainer = this.startContainer;
            this.commonAncestorContainer = this.startContainer;
            this.collapsed = false;
        }
        selectNodeContents(node) {
            this._selected = node;
            this.startContainer = node;
            this.endContainer = node;
            this.commonAncestorContainer = node;
            this.collapsed = false;
        }
        getBoundingClientRect() {
            const n = this._selected;
            return n && n.getBoundingClientRect ? n.getBoundingClientRect() : new DOMRect();
        }
        getClientRects() {
            const n = this._selected;
            return n && n.getClientRects ? n.getClientRects() : [];
        }
        createContextualFragment(html) {
            const div = _document.createElement("div");
            div.innerHTML = html;
            const frag = _document.createDocumentFragment();
            while (div.firstChild) frag.appendChild(div.firstChild);
            return frag;
        }
        toString() { return ""; }
    }

    // --- Selection (minimal) ---
    class Selection {
        get anchorNode() { return null; }
        get anchorOffset() { return 0; }
        get focusNode() { return null; }
        get focusOffset() { return 0; }
        get isCollapsed() { return true; }
        get rangeCount() { return 0; }
        getRangeAt(i) { return new Range(); }
        addRange(range) {}
        removeRange(range) {}
        removeAllRanges() {}
        collapse(node, offset) {}
        toString() { return ""; }
    }
    const _selection = new Selection();

    // Create the global document
    const _document = new Document(ops.op_dom_document_node());
    _nodeCache.set(ops.op_dom_document_node(), new WeakRef(_document));

    // Set globals
    // Symbol.toStringTag on every DOM class — some scripts
    // check Object.prototype.toString.call(node) and expect the Chrome
    // WebIDL brand name like "[object HTMLDivElement]". Without these
    // tags every node shows as "[object Object]", which differs from
    // real Chrome.
    const _tag = (cls, name) => {
        try {
            Object.defineProperty(cls.prototype, Symbol.toStringTag, {
                value: name, configurable: true,
            });
        } catch {}
    };
    _tag(EventTarget, "EventTarget");
    _tag(Node, "Node");
    _tag(Element, "Element");
    _tag(HTMLElement, "HTMLElement");
    _tag(HTMLDivElement, "HTMLDivElement");
    _tag(HTMLSpanElement, "HTMLSpanElement");
    _tag(HTMLParagraphElement, "HTMLParagraphElement");
    _tag(HTMLHeadingElement, "HTMLHeadingElement");
    _tag(HTMLAnchorElement, "HTMLAnchorElement");
    _tag(HTMLImageElement, "HTMLImageElement");
    _tag(HTMLInputElement, "HTMLInputElement");
    _tag(HTMLFormElement, "HTMLFormElement");
    _tag(HTMLButtonElement, "HTMLButtonElement");
    _tag(HTMLSelectElement, "HTMLSelectElement");
    _tag(HTMLTextAreaElement, "HTMLTextAreaElement");
    _tag(HTMLCanvasElement, "HTMLCanvasElement");
    _tag(HTMLScriptElement, "HTMLScriptElement");
    _tag(HTMLStyleElement, "HTMLStyleElement");
    _tag(HTMLLinkElement, "HTMLLinkElement");
    _tag(HTMLMetaElement, "HTMLMetaElement");
    _tag(HTMLTableElement, "HTMLTableElement");
    _tag(HTMLIFrameElement, "HTMLIFrameElement");
    _tag(HTMLVideoElement, "HTMLVideoElement");
    _tag(HTMLAudioElement, "HTMLAudioElement");
    _tag(HTMLBodyElement, "HTMLBodyElement");
    _tag(HTMLHeadElement, "HTMLHeadElement");
    _tag(HTMLHtmlElement, "HTMLHtmlElement");
    _tag(HTMLUListElement, "HTMLUListElement");
    _tag(HTMLOListElement, "HTMLOListElement");
    _tag(HTMLLIElement, "HTMLLIElement");
    _tag(HTMLTableRowElement, "HTMLTableRowElement");
    _tag(HTMLTableCellElement, "HTMLTableCellElement");
    _tag(HTMLTableSectionElement, "HTMLTableSectionElement");
    _tag(HTMLLabelElement, "HTMLLabelElement");
    _tag(HTMLOptionElement, "HTMLOptionElement");
    _tag(HTMLTemplateElement, "HTMLTemplateElement");
    _tag(HTMLPreElement, "HTMLPreElement");
    _tag(HTMLQuoteElement, "HTMLQuoteElement");
    _tag(Text, "Text");
    _tag(Comment, "Comment");
    _tag(DocumentFragment, "DocumentFragment");
    // Chrome exposes document as HTMLDocument (which extends Document).
    _tag(Document, "HTMLDocument");
    _tag(NodeList, "NodeList");
    _tag(DOMTokenList, "DOMTokenList");

    // documentElement (HTMLHtmlElement) and body (HTMLBodyElement) layout
    // dimensions in standards mode are viewport-clipped, NOT full document.
    // Default Element getters return offsetWidth/Height = full document
    // (e.g. 1914 × 28638 on some sites) which differs from real Chrome.
    // Real Chrome returns innerWidth × innerHeight (1440 × 789 on a typical
    // macOS 1440x900 viewport).
    {
        const _viewportW = () => (globalThis.innerWidth | 0) || 1440;
        const _viewportH = () => (globalThis.innerHeight | 0) || 789;
        Object.defineProperty(HTMLHtmlElement.prototype, 'clientWidth',  { get() { return _viewportW(); }, configurable: true });
        Object.defineProperty(HTMLHtmlElement.prototype, 'clientHeight', { get() { return _viewportH(); }, configurable: true });
        // documentElement.scrollWidth/Height are still full content size,
        // so leave the inherited offset-based getters in place for those.
    }

    globalThis.document = _document;
    globalThis.Document = Document;
    globalThis.HTMLDocument = Document;
    globalThis.Node = Node;
    globalThis.Element = Element;
    globalThis.Attr = Attr;
    // Expose the real HTMLElement subclasses — the prototype chain is
    // EventTarget ← Node ← Element ← HTMLElement ← HTML*Element so that
    // `el instanceof HTMLDivElement` etc. works as in real Chrome.
    // ── Members the strict-API probe found missing on a real login form ──────
    //
    // Each is plain spec surface every Chrome element carries. Their absence is
    // doubly costly: form code that reads them breaks, and the absence itself
    // differs from Chrome, so a fingerprinter sees a window where
    // `'contentEditable' in div` is false.

    const _reflectInt = (proto, prop, attr = prop.toLowerCase(), dflt = -1) => {
        Object.defineProperty(proto, prop, {
            get() {
                const v = this.getAttribute(attr);
                if (v == null) return dflt;
                const n = parseInt(v, 10);
                return Number.isNaN(n) ? dflt : n;
            },
            set(v) { this.setAttribute(attr, String(v | 0)); },
            enumerable: true, configurable: true,
        });
    };

    // Element: the namespace every node reports. SVG content lives in the SVG
    // namespace, everything else parsed from an HTML document in the XHTML one.
    Object.defineProperty(Element.prototype, 'namespaceURI', {
        get() {
            try {
                const tag = ops.op_dom_get_tag_name(_getNodeId(this)).toLowerCase();
                if (_SVG_TAGS.has(tag)) return 'http://www.w3.org/2000/svg';
            } catch (_) { /* detached */ }
            return 'http://www.w3.org/1999/xhtml';
        },
        enumerable: true, configurable: true,
    });
    Object.defineProperty(Element.prototype, 'prefix', {
        get() { return null; }, enumerable: true, configurable: true,
    });

    // HTMLElement: the global content attributes.
    _reflectStr(HTMLElement.prototype, 'title');
    _reflectStr(HTMLElement.prototype, 'lang');
    _reflectStr(HTMLElement.prototype, 'dir');
    _reflectBool(HTMLElement.prototype, 'hidden');
    Object.defineProperty(HTMLElement.prototype, 'translate', {
        get() { return this.getAttribute('translate') !== 'no'; },
        set(v) { this.setAttribute('translate', v ? 'yes' : 'no'); },
        enumerable: true, configurable: true,
    });
    // `contentEditable` is the tri-state string; `isContentEditable` is the
    // resolved boolean, inherited from the nearest editable ancestor.
    Object.defineProperty(HTMLElement.prototype, 'contentEditable', {
        get() {
            const v = this.getAttribute('contenteditable');
            if (v == null) return 'inherit';
            return v === '' ? 'true' : String(v);
        },
        set(v) { this.setAttribute('contenteditable', String(v)); },
        enumerable: true, configurable: true,
    });
    Object.defineProperty(HTMLElement.prototype, 'isContentEditable', {
        get() {
            let n = this;
            while (n && n.getAttribute) {
                const v = n.getAttribute('contenteditable');
                if (v === 'true' || v === '') return true;
                if (v === 'false') return false;
                n = n.parentNode;
            }
            return false;
        },
        enumerable: true, configurable: true,
    });

    // Form controls beyond the handful already reflected above.
    _reflectStr(HTMLInputElement.prototype, 'autocomplete');
    _reflectStr(HTMLInputElement.prototype, 'pattern');
    _reflectInt(HTMLInputElement.prototype, 'maxLength', 'maxlength', 524288);
    _reflectInt(HTMLInputElement.prototype, 'minLength', 'minlength', -1);
    // ── `value` / `checked`: internal state, not attribute reflection ───────
    //
    // These were plain `_reflectStr`/`_reflectBool`, i.e. `el.value = 'x'` wrote
    // the `value` *content attribute*. That is not what a browser does, and the
    // difference is observable three ways: typing into a field silently
    // rewrote the markup, `defaultValue` moved with `value` instead of staying
    // at the markup default, and `getAttribute('value')` changed on every
    // keystroke — which no real browser ever shows. React tracks controlled
    // inputs through exactly this pair, which is why its `_valueTracker` kept
    // turning up in the strict-API log.
    //
    // Per HTML: `value` is backed by internal state plus a *dirty value flag*.
    // Before the flag is set the state follows the content attribute; once
    // anything assigns `value` (or the user types) the attribute stops
    // affecting it. `defaultValue` reflects the attribute throughout. Same
    // shape for `checked` / `defaultChecked` with a dirty *checkedness* flag.
    const _valueState = new WeakMap();
    const _vs = (el) => {
        let st = _valueState.get(el);
        if (!st) { st = { dirty: false, value: '', checkedDirty: false, checked: false }; _valueState.set(el, st); }
        return st;
    };
    // Types whose `value` IDL attribute is in "default" or "default/on" mode:
    // it is the content attribute, with no internal state at all.
    const _DEFAULT_VALUE_TYPES = new Set(['button', 'reset', 'submit', 'image']);
    const _ON_VALUE_TYPES = new Set(['checkbox', 'radio']);

    Object.defineProperty(HTMLInputElement.prototype, 'value', {
        get() {
            const t = String(this.getAttribute('type') || 'text').toLowerCase();
            const attr = this.getAttribute('value');
            if (_DEFAULT_VALUE_TYPES.has(t)) return attr == null ? '' : attr;
            if (_ON_VALUE_TYPES.has(t)) return attr == null ? 'on' : attr;
            const st = _vs(this);
            if (st.dirty) return st.value;
            return attr == null ? '' : attr;
        },
        set(v) {
            const t = String(this.getAttribute('type') || 'text').toLowerCase();
            const str = v == null ? '' : String(v);
            if (_DEFAULT_VALUE_TYPES.has(t) || _ON_VALUE_TYPES.has(t)) {
                this.setAttribute('value', str);
                return;
            }
            const st = _vs(this);
            st.dirty = true;
            st.value = str;
        },
        enumerable: true, configurable: true,
    });
    Object.defineProperty(HTMLInputElement.prototype, 'checked', {
        get() {
            const st = _vs(this);
            return st.checkedDirty ? st.checked : this.hasAttribute('checked');
        },
        set(v) {
            const st = _vs(this);
            st.checkedDirty = true;
            st.checked = !!v;
        },
        enumerable: true, configurable: true,
    });
    Object.defineProperty(HTMLInputElement.prototype, 'defaultChecked', {
        get() { return this.hasAttribute('checked'); },
        set(v) {
            if (v) this.setAttribute('checked', '');
            else this.removeAttribute('checked');
        },
        enumerable: true, configurable: true,
    });
    // <textarea> keeps the same rule with its child text as the default.
    Object.defineProperty(HTMLTextAreaElement.prototype, 'value', {
        get() {
            const st = _vs(this);
            return st.dirty ? st.value : String(this.textContent || '');
        },
        set(v) {
            const st = _vs(this);
            st.dirty = true;
            st.value = v == null ? '' : String(v);
        },
        enumerable: true, configurable: true,
    });
    Object.defineProperty(HTMLTextAreaElement.prototype, 'defaultValue', {
        get() { return String(this.textContent || ''); },
        set(v) { this.textContent = String(v); },
        enumerable: true, configurable: true,
    });
    /// Form reset clears both dirty flags, which is what puts a control back on
    /// its markup default.
    _clearDirtyValue = (el) => {
        const st = _valueState.get(el);
        if (st) { st.dirty = false; st.checkedDirty = false; }
    };

    Object.defineProperty(HTMLInputElement.prototype, 'defaultValue', {
        get() { const v = this.getAttribute('value'); return v == null ? '' : v; },
        set(v) { this.setAttribute('value', String(v)); },
        enumerable: true, configurable: true,
    });
    for (const proto of [HTMLButtonElement, HTMLSelectElement, HTMLTextAreaElement]) {
        if (!proto) continue;
        _reflectStr(proto.prototype, 'name');
        _reflectBool(proto.prototype, 'disabled');
    }
    _reflectBool(HTMLTextAreaElement.prototype, 'required');
    _reflectBool(HTMLTextAreaElement.prototype, 'readOnly', 'readonly');
    _reflectStr(HTMLTextAreaElement.prototype, 'placeholder');

    // `labels` — the <label>s pointing at this control, live per spec.
    const _labelsFor = function () {
        const ids = [];
        try {
            const id = this.getAttribute('id');
            if (id) {
                const esc = String(id).replace(/(["\\])/g, '\\$1');
                const found = ops.op_dom_query_selector_all(
                    ops.op_dom_document_node(), `label[for="${esc}"]`,
                );
                for (let i = 0; i < found.length; i++) ids.push(found[i]);
            }
            // A control nested inside its own <label> is labelled by it.
            let n = this.parentNode;
            while (n && n.tagName) {
                if (n.tagName.toLowerCase() === 'label') {
                    const nid = _getNodeId(n);
                    if (ids.indexOf(nid) < 0) ids.push(nid);
                }
                n = n.parentNode;
            }
        } catch (_) { /* ignore */ }
        return new NodeList(ids);
    };
    for (const proto of [HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLButtonElement]) {
        if (!proto) continue;
        Object.defineProperty(proto.prototype, 'labels', {
            get: _labelsFor, enumerable: true, configurable: true,
        });
    }

    // Constraint validation. Input masking and multi-step sign-in forms — the
    // Epic login among them — gate on `checkValidity()` before advancing.
    class ValidityState {
        constructor(el) { this._el = el; }
        get valueMissing() {
            return !!this._el.required && String(this._el.value || '') === '';
        }
        get tooLong() {
            const m = this._el.maxLength;
            return m >= 0 && String(this._el.value || '').length > m;
        }
        get tooShort() {
            const m = this._el.minLength;
            const v = String(this._el.value || '');
            return m >= 0 && v.length > 0 && v.length < m;
        }
        get typeMismatch() {
            const t = String(this._el.type || '').toLowerCase();
            const v = String(this._el.value || '');
            if (!v) return false;
            if (t === 'email') return !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
            if (t === 'url') { try { new URL(v); return false; } catch (_) { return true; } }
            return false;
        }
        get patternMismatch() {
            const p = this._el.pattern;
            const v = String(this._el.value || '');
            if (!p || !v) return false;
            try { return !new RegExp(`^(?:${p})$`).test(v); } catch (_) { return false; }
        }
        get customError() { return !!this._el._customValidity; }
        get badInput() { return false; }
        get rangeOverflow() { return false; }
        get rangeUnderflow() { return false; }
        get stepMismatch() { return false; }
        get valid() {
            return !(this.valueMissing || this.tooLong || this.tooShort
                || this.typeMismatch || this.patternMismatch || this.customError);
        }
    }
    Object.defineProperty(ValidityState.prototype, Symbol.toStringTag, {
        value: 'ValidityState', configurable: true,
    });
    globalThis.ValidityState = ValidityState;

    for (const proto of [HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLButtonElement]) {
        if (!proto) continue;
        Object.defineProperty(proto.prototype, 'validity', {
            get() { return new ValidityState(this); }, enumerable: true, configurable: true,
        });
        Object.defineProperty(proto.prototype, 'validationMessage', {
            get() { return this._customValidity || ''; }, enumerable: true, configurable: true,
        });
        proto.prototype.setCustomValidity = function setCustomValidity(msg) {
            this._customValidity = String(msg || '');
        };
        proto.prototype.checkValidity = function checkValidity() {
            if (this.validity.valid) return true;
            this.dispatchEvent(new Event('invalid', { cancelable: true }));
            return false;
        };
        proto.prototype.reportValidity = function reportValidity() {
            return this.checkValidity();
        };
    }

    // Text-entry selection. Input masks read `selectionStart` after every
    // keystroke and write it back with `setSelectionRange`.
    for (const proto of [HTMLInputElement, HTMLTextAreaElement]) {
        if (!proto) continue;
        const len = function () { return String(this.value || '').length; };
        Object.defineProperty(proto.prototype, 'selectionStart', {
            get() { return this._selStart == null ? len.call(this) : this._selStart; },
            set(v) { this._selStart = v | 0; },
            enumerable: true, configurable: true,
        });
        Object.defineProperty(proto.prototype, 'selectionEnd', {
            get() { return this._selEnd == null ? len.call(this) : this._selEnd; },
            set(v) { this._selEnd = v | 0; },
            enumerable: true, configurable: true,
        });
        Object.defineProperty(proto.prototype, 'selectionDirection', {
            get() { return this._selDir || 'none'; },
            set(v) { this._selDir = String(v); },
            enumerable: true, configurable: true,
        });
        proto.prototype.setSelectionRange = function setSelectionRange(start, end, dir) {
            this._selStart = start | 0;
            this._selEnd = end | 0;
            this._selDir = dir ? String(dir) : 'none';
            this.dispatchEvent(new Event('select', { bubbles: true }));
        };
        proto.prototype.select = function select() {
            this.setSelectionRange(0, String(this.value || '').length);
        };
    }

    // ── Inline `on*` content attributes ──────────────────────────────────
    // `<button onclick="startAnalysis()">` was completely inert: elements had
    // no event-handler IDL attributes at all, so `el.onclick` read `undefined`
    // (Chrome: `null`) and `_fireListeners`, which invokes `target['on'+type]`,
    // found nothing to call. Every page that wires its controls in markup was
    // unclickable — including everything behind Cloudflare Rocket Loader,
    // where each control carries
    // `onclick="if (!window.__cfRLUnblockHandlers) return false; …"`.
    //
    // Chrome exposes these as enumerable accessors on `HTMLElement.prototype`
    // (the GlobalEventHandlers mixin), so defining them here closes a
    // fingerprint gap as well. The window-only handlers (WindowEventHandlers:
    // onunload, onpopstate, onstorage, …) stay off the element prototype,
    // exactly as in Chrome.
    const _elementEventHandlerNames = [
        'onabort', 'onanimationcancel', 'onanimationend', 'onanimationiteration',
        'onanimationstart', 'onauxclick', 'onbeforeinput', 'onbeforematch',
        'onbeforetoggle', 'onblur', 'oncancel', 'oncanplay', 'oncanplaythrough',
        'onchange', 'onclick', 'onclose', 'oncommand',
        'oncontentvisibilityautostatechange', 'oncontextlost', 'oncontextmenu',
        'oncontextrestored', 'oncuechange', 'ondblclick', 'ondrag', 'ondragend',
        'ondragenter', 'ondragleave', 'ondragover', 'ondragstart', 'ondrop',
        'ondurationchange', 'onemptied', 'onended', 'onerror', 'onfocus', 'onfocusin', 'onfocusout',
        'onformdata', 'ongotpointercapture', 'oninput', 'oninvalid', 'onkeydown',
        'onkeypress', 'onkeyup', 'onload', 'onloadeddata', 'onloadedmetadata',
        'onloadstart', 'onlostpointercapture', 'onmousedown', 'onmouseenter',
        'onmouseleave', 'onmousemove', 'onmouseout', 'onmouseover', 'onmouseup',
        'onmousewheel', 'onpause', 'onplay', 'onplaying', 'onpointercancel',
        'onpointerdown', 'onpointerenter', 'onpointerleave', 'onpointermove',
        'onpointerout', 'onpointerover', 'onpointerrawupdate', 'onpointerup',
        'onprogress', 'onratechange', 'onreset', 'onresize', 'onscroll',
        'onscrollend', 'onscrollsnapchange', 'onscrollsnapchanging', 'onsearch',
        'onsecuritypolicyviolation', 'onseeked', 'onseeking', 'onselect',
        'onselectionchange', 'onselectstart', 'onslotchange', 'onstalled',
        'onsubmit', 'onsuspend', 'ontimeupdate', 'ontoggle', 'ontransitioncancel',
        'ontransitionend', 'ontransitionrun', 'ontransitionstart',
        'onvolumechange', 'onwaiting', 'onwebkitanimationend',
        'onwebkitanimationiteration', 'onwebkitanimationstart',
        'onwebkittransitionend', 'onwheel',
    ];
    const _windowOnly = new Set([
        'onafterprint', 'onappinstalled', 'onbeforeinstallprompt', 'onbeforeprint',
        'onbeforeunload', 'onbeforexrselect', 'ongamepadconnected',
        'ongamepaddisconnected', 'onhashchange', 'onlanguagechange', 'onmessage',
        'onmessageerror', 'onoffline', 'ononline', 'onpagehide', 'onpagereveal',
        'onpageshow', 'onpageswap', 'onpopstate', 'onrejectionhandled',
        'onstorage', 'onunhandledrejection', 'onunload',
    ]);
    // Explicitly assigned handlers (`el.onclick = fn`) win over the attribute.
    const _onExplicit = new WeakMap();
    // Compiled attribute sources, keyed by element, invalidated when the
    // attribute text changes.
    const _onCompiled = new WeakMap();

    const _compileInlineHandler = (src) => {
        let compiled;
        try {
            compiled = new Function("event", src);
        } catch (_) {
            // A syntactically broken attribute is a no-op in Chrome too.
            return null;
        }
        // Returning false from an inline handler cancels the event
        // (`<form onsubmit="return false">`); a listener added through
        // addEventListener has no such rule, so it belongs here and not in
        // the dispatch code.
        return function (event) {
            const r = compiled.call(this, event);
            if (r === false && event && typeof event.preventDefault === "function") {
                event.preventDefault();
            }
            return r;
        };
    };

    for (const _name of _elementEventHandlerNames) {
        if (_windowOnly.has(_name)) continue;
        try {
            Object.defineProperty(HTMLElement.prototype, _name, {
                get() {
                    const explicit = _onExplicit.get(this);
                    if (explicit && _name in explicit) return explicit[_name];
                    let src = null;
                    try { src = this.getAttribute(_name); } catch (_) { /* detached */ }
                    if (typeof src !== "string") return null;
                    let cache = _onCompiled.get(this);
                    if (!cache) { cache = Object.create(null); _onCompiled.set(this, cache); }
                    const hit = cache[_name];
                    if (hit && hit.src === src) return hit.fn;
                    const fn = _compileInlineHandler(src);
                    cache[_name] = { src, fn };
                    return fn;
                },
                set(v) {
                    let explicit = _onExplicit.get(this);
                    if (!explicit) { explicit = Object.create(null); _onExplicit.set(this, explicit); }
                    explicit[_name] = typeof v === "function" ? v : null;
                },
                enumerable: true,
                configurable: true,
            });
        } catch (_) { /* ignore */ }
    }

    // Document carries GlobalEventHandlers too, and Chrome exposes each as an
    // accessor on `Document.prototype`. Ours had none, so
    // `'onvisibilitychange' in document` was false and any feature detection
    // over the set took the wrong branch. No content-attribute compilation
    // here — a document has no `on*` attributes to compile.
    for (const _name of _elementEventHandlerNames.concat([
        'onvisibilitychange', 'onreadystatechange', 'onfullscreenchange',
        'onfullscreenerror', 'onpointerlockchange', 'onpointerlockerror',
        'onfreeze', 'onresume', 'onprerenderingchange',
    ])) {
        if (_windowOnly.has(_name)) continue;
        try {
            Object.defineProperty(Document.prototype, _name, {
                get() {
                    const h = _onExplicit.get(this);
                    return h && _name in h ? h[_name] : null;
                },
                set(v) {
                    let h = _onExplicit.get(this);
                    if (!h) { h = Object.create(null); _onExplicit.set(this, h); }
                    h[_name] = typeof v === "function" ? v : null;
                },
                enumerable: true,
                configurable: true,
            });
        } catch (_) { /* ignore */ }
    }
    // Chrome 148 Document members this engine never defined.
    Object.defineProperty(Document.prototype, 'prerendering', {
        get() { return false; }, enumerable: true, configurable: true,
    });
    Object.defineProperty(Document.prototype, 'wasDiscarded', {
        get() { return false; }, enumerable: true, configurable: true,
    });

    globalThis.HTMLElement = HTMLElement;
    globalThis.HTMLDivElement = HTMLDivElement;
    globalThis.HTMLSpanElement = HTMLSpanElement;
    globalThis.HTMLParagraphElement = HTMLParagraphElement;
    globalThis.HTMLHeadingElement = HTMLHeadingElement;
    globalThis.HTMLAnchorElement = HTMLAnchorElement;
    globalThis.HTMLImageElement = HTMLImageElement;
    globalThis.HTMLInputElement = HTMLInputElement;
    globalThis.HTMLFormElement = HTMLFormElement;
    globalThis.HTMLButtonElement = HTMLButtonElement;
    globalThis.HTMLSelectElement = HTMLSelectElement;
    globalThis.HTMLTextAreaElement = HTMLTextAreaElement;
    globalThis.HTMLCanvasElement = HTMLCanvasElement;
    globalThis.HTMLScriptElement = HTMLScriptElement;
    globalThis.HTMLStyleElement = HTMLStyleElement;
    globalThis.HTMLLinkElement = HTMLLinkElement;
    globalThis.HTMLMetaElement = HTMLMetaElement;
    globalThis.HTMLTableElement = HTMLTableElement;
    globalThis.HTMLIFrameElement = HTMLIFrameElement;
    globalThis.HTMLVideoElement = HTMLVideoElement;
    globalThis.HTMLAudioElement = HTMLAudioElement;
    globalThis.HTMLBodyElement = HTMLBodyElement;
    globalThis.HTMLHeadElement = HTMLHeadElement;
    globalThis.HTMLHtmlElement = HTMLHtmlElement;
    globalThis.HTMLUListElement = HTMLUListElement;
    globalThis.HTMLOListElement = HTMLOListElement;
    globalThis.HTMLLIElement = HTMLLIElement;
    globalThis.HTMLTableRowElement = HTMLTableRowElement;
    globalThis.HTMLTableCellElement = HTMLTableCellElement;
    globalThis.HTMLTableSectionElement = HTMLTableSectionElement;
    globalThis.HTMLLabelElement = HTMLLabelElement;
    globalThis.HTMLOptionElement = HTMLOptionElement;
    globalThis.HTMLTemplateElement = HTMLTemplateElement;
    globalThis.HTMLPreElement = HTMLPreElement;
    globalThis.HTMLQuoteElement = HTMLQuoteElement;
    globalThis.SVGElement = Element;
    globalThis.Text = Text;
    globalThis.Comment = Comment;
    globalThis.DocumentFragment = DocumentFragment;
    globalThis.Document = Document;
    globalThis.NodeList = NodeList;
    globalThis.DOMTokenList = DOMTokenList;
    globalThis.DOMRect = DOMRect;
    globalThis.DOMRectReadOnly = DOMRect;
    globalThis.Range = Range;
    globalThis.Selection = Selection;
    globalThis.getSelection = function() { return _selection; };

    // Image constructor — new Image(width, height). Returns an
    // HTMLImageElement whose naturalWidth/naturalHeight/complete are
    // accessors defined on the prototype (getters; not writable).
    // Constructor return of an object is the caller's `new Image(...)`.
    globalThis.Image = function Image(width, height) {
        const el = _document.createElement("img");
        if (width !== undefined) el.setAttribute("width", String(width));
        if (height !== undefined) el.setAttribute("height", String(height));
        return el;
    };

    // DOMParser
    globalThis.DOMParser = class DOMParser {
        parseFromString(str, type) {
            // Returns a minimal document-like object
            const frag = _document.createElement("div");
            frag.innerHTML = str;
            return {
                documentElement: frag,
                body: frag,
                querySelector(sel) { return frag.querySelector(sel); },
                querySelectorAll(sel) { return frag.querySelectorAll(sel); },
                getElementById(id) { return frag.querySelector("#" + id); },
            };
        }
    };

    // --- MutationObserver (real implementation) ---
    const _moObservers = []; // { observer, target, options }

    class MutationRecord {
        constructor(type, target) {
            this.type = type;
            this.target = target;
            this.addedNodes = [];
            this.removedNodes = [];
            this.attributeName = null;
            this.oldValue = null;
            this.previousSibling = null;
            this.nextSibling = null;
        }
    }

    class MutationObserver {
        constructor(callback) {
            this._callback = callback;
            this._records = [];
            this._active = false;
            this._targets = new Map(); // nodeId → options
        }
        observe(target, options = {}) {
            const nodeId = _getNodeId(target);
            this._targets.set(nodeId, { target, options });
            this._active = true;
            _moObservers.push(this);
        }
        disconnect() {
            this._active = false;
            this._targets.clear();
            const idx = _moObservers.indexOf(this);
            if (idx !== -1) _moObservers.splice(idx, 1);
        }
        takeRecords() {
            const r = this._records.slice();
            this._records = [];
            return r;
        }
        _notify(record) {
            if (!this._active) return;
            this._records.push(record);
            // Schedule microtask to deliver
            if (this._records.length === 1) {
                Promise.resolve().then(() => {
                    if (!this._active) return;
                    const batch = this._records.slice();
                    this._records = [];
                    if (batch.length > 0) this._callback(batch, this);
                });
            }
        }
    }

    // Notify matching observers of a mutation
    function _notifyMO(type, targetNodeId, init) {
        for (const obs of _moObservers) {
            if (!obs._active) continue;
            // Check if this observer watches this target (or subtree ancestor)
            let matched = obs._targets.has(targetNodeId);
            if (!matched) {
                // Check subtree: walk ancestors
                for (const [watchedId, { options }] of obs._targets) {
                    if (options.subtree) {
                        // Walk up from targetNodeId to see if watchedId is ancestor
                        let nid = targetNodeId;
                        while (nid !== -1 && nid !== null) {
                            if (nid === watchedId) { matched = true; break; }
                            nid = ops.op_dom_get_parent(nid);
                        }
                    }
                    if (matched) break;
                }
            }
            if (!matched) continue;

            // Check options match
            const opts = obs._targets.get(targetNodeId)?.options ||
                         [...obs._targets.values()].find(v => v.options.subtree)?.options || {};
            if (type === "childList" && !opts.childList) continue;
            if (type === "attributes" && !opts.attributes) continue;
            if (type === "characterData" && !opts.characterData) continue;

            const record = new MutationRecord(type, init.target || null);
            if (init.addedNodes) record.addedNodes = init.addedNodes;
            if (init.removedNodes) record.removedNodes = init.removedNodes;
            if (init.attributeName) record.attributeName = init.attributeName;
            obs._notify(record);
        }
    }

    // Custom element lifecycle helper
    function _ceConnected(el) {
        if (el && el._ceUpgraded && typeof el.connectedCallback === "function") {
            try { el.connectedCallback(); } catch (e) { console.error(e); }
        }
    }
    function _ceDisconnected(el) {
        if (el && el._ceUpgraded && typeof el.disconnectedCallback === "function") {
            try { el.disconnectedCallback(); } catch (e) { console.error(e); }
        }
    }

    // Window frame registry: tracks appended iframes so window[0], window[1], etc.
    // work correctly. Some scripts access window.frames[0].navigator.webdriver
    // (which is window[0] since frames===window in our engine). Without this,
    // window[0] is undefined → TypeError "Cannot read properties of undefined
    // (reading 'webdriver')".
    const _appendedIframes = [];

    // Wrap DOM mutation methods to fire MO notifications
    const _origAppendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function(child) {
        const result = _origAppendChild.call(this, child);
        // Register iframes in the parent window's frame list (window[N] access)
        try {
            if (typeof HTMLIFrameElement !== 'undefined' && child instanceof HTMLIFrameElement) {
                const _fi = _appendedIframes.length;
                _appendedIframes.push(child);
                // Debug counter, on the engine namespace — see _setIfAppendCount
                try { _setIfAppendCount(_appendedIframes.length); } catch (_) {}
                // Define lazy getter for window[N] — contentWindow is created on demand
                Object.defineProperty(globalThis, String(_fi), {
                    get: function() { return _getIframeWindow(_appendedIframes[_fi]); },
                    configurable: true, enumerable: false,
                });
                // `window.length` is a live accessor now — see window_bootstrap.js.
            }
        } catch (_) {}
        if (_moObservers.length > 0) {
            _notifyMO("childList", _getNodeId(this), { target: this, addedNodes: [child] });
        }
        return result;
    };

    const _origRemoveChild = Node.prototype.removeChild;
    Node.prototype.removeChild = function(child) {
        const result = _origRemoveChild.call(this, child);
        if (_moObservers.length > 0) {
            _notifyMO("childList", _getNodeId(this), { target: this, removedNodes: [child] });
        }
        return result;
    };

    const _origInsertBefore = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function(newChild, refChild) {
        const result = _origInsertBefore.call(this, newChild, refChild);
        // Register iframes inserted via insertBefore (same logic as appendChild)
        try {
            if (typeof HTMLIFrameElement !== 'undefined' && newChild instanceof HTMLIFrameElement
                    && !_appendedIframes.includes(newChild)) {
                const _fi = _appendedIframes.length;
                _appendedIframes.push(newChild);
                try { _setIfAppendCount(_appendedIframes.length); } catch (_) {}
                Object.defineProperty(globalThis, String(_fi), {
                    get: function() { return _getIframeWindow(_appendedIframes[_fi]); },
                    configurable: true, enumerable: false,
                });
                try {
                    Object.defineProperty(globalThis, 'length', {
                        value: _appendedIframes.length, configurable: true, writable: true,
                    });
                } catch (_) {}
            }
        } catch (_) {}
        if (_moObservers.length > 0) {
            _notifyMO("childList", _getNodeId(this), { target: this, addedNodes: [newChild] });
        }
        return result;
    };

    const _origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
        const oldVal = this.getAttribute(name);
        _origSetAttribute.call(this, name, value);
        if (_moObservers.length > 0) {
            _notifyMO("attributes", _getNodeId(this), { target: this, attributeName: name });
        }
        // Custom element attributeChangedCallback
        if (this._ceUpgraded && typeof this.attributeChangedCallback === "function") {
            const observed = this.constructor.observedAttributes;
            if (Array.isArray(observed) && observed.includes(name)) {
                try { this.attributeChangedCallback(name, oldVal, value); } catch (e) { console.error(e); }
            }
        }
    };

    const _origRemoveAttribute = Element.prototype.removeAttribute;
    Element.prototype.removeAttribute = function(name) {
        const oldVal = this.getAttribute(name);
        _origRemoveAttribute.call(this, name);
        if (_moObservers.length > 0) {
            _notifyMO("attributes", _getNodeId(this), { target: this, attributeName: name });
        }
        // Custom element attributeChangedCallback
        if (this._ceUpgraded && typeof this.attributeChangedCallback === "function") {
            const observed = this.constructor.observedAttributes;
            if (Array.isArray(observed) && observed.includes(name)) {
                try { this.attributeChangedCallback(name, oldVal, null); } catch (e) { console.error(e); }
            }
        }
    };

    // Element.remove() also triggers childList on parent
    const _origRemove = Element.prototype.remove;
    Element.prototype.remove = function() {
        const parent = this.parentNode;
        _ceDisconnected(this);
        _origRemove.call(this);
        if (_moObservers.length > 0 && parent) {
            _notifyMO("childList", _getNodeId(parent), { target: parent, removedNodes: [this] });
        }
    };

    globalThis.MutationObserver = MutationObserver;
    globalThis.MutationRecord = MutationRecord;

    // --- iframe support (contentWindow / contentDocument) ---
    //
    // Many scripts perform iframe-realm checks:
    // they create or find an <iframe>, access `.contentWindow`, then pull
    // native constructors (TextEncoder, Function, Array, ...) from the iframe
    // window to compare against the main window's versions. A mismatch
    // reveals monkey-patching; an `undefined` contentWindow reveals a headless
    // browser that doesn't support iframes.
    //
    // We install `contentWindow` and `contentDocument` as GETTERS on
    // HTMLIFrameElement.prototype so EVERY iframe — whether parsed from HTML
    // or created via document.createElement — returns a valid window-shaped
    // Proxy that falls through to globalThis for any unknown property. The
    // per-iframe state is cached in a WeakMap keyed by the element.

    const _iframeState = new WeakMap();

    // Build a mirror realm: fresh constructors that mimic the parent's shape
    // but are reference-distinct, so cross-realm probes like
    //   iframe.contentWindow.Navigator !== Navigator
    //   iframe.contentWindow.Navigator.prototype !== Navigator.prototype
    // hold true while own-property-names lists remain identical. Each
    // mirrored function carries _nativeTag so Function.prototype.toString
    // produces "function NAME() { [native code] }" cross-realm.
    const _MIRRORED_CONSTRUCTORS = [
        "Navigator", "Window", "Document", "HTMLDocument",
        "EventTarget", "Node", "Element", "HTMLElement",
        "HTMLDivElement", "HTMLSpanElement", "HTMLBodyElement",
        "HTMLAnchorElement", "HTMLImageElement", "HTMLInputElement",
        "HTMLFormElement", "HTMLButtonElement", "HTMLSelectElement",
        "HTMLTextAreaElement", "HTMLCanvasElement", "HTMLScriptElement",
        "HTMLIFrameElement", "Event", "CustomEvent", "MouseEvent",
        "KeyboardEvent", "MessageEvent", "Array", "Object", "Function",
        "String", "Number", "Boolean", "Promise", "Error", "TypeError",
        "RangeError", "Map", "Set", "WeakMap", "WeakSet", "Date",
        "RegExp", "Symbol",
    ];

    // Capture the native-tag Symbol from the parent realm. stealth_bootstrap.js
    // exposes it as globalThis._nativeTag. We capture explicitly so the
    // freshToString and _mkNativeFn don't accidentally see undefined when
    // bare-identifier scope chain is shadowed by the IIFE parameter.
    const _NATIVE_TAG_SYMBOL = globalThis._nativeTag || Symbol.for('__browser_oxide_native__');

    function _mkNativeFn(name) {
        const fn = function() {};
        try {
            Object.defineProperty(fn, "name", { value: name, configurable: true });
            Object.defineProperty(fn, _NATIVE_TAG_SYMBOL, { value: name, configurable: true });
            // Per-instance toString returning native shape — used when the
            // patched Function.prototype.toString is bypassed by direct
            // .toString() calls. Mirrors stealth_bootstrap's _maskFunction.
            const ts = function toString() { return "function " + name + "() { [native code] }"; };
            Object.defineProperty(ts, _NATIVE_TAG_SYMBOL, { value: "toString", configurable: true });
            Object.defineProperty(ts, "name", { value: "toString", configurable: true });
            Object.defineProperty(fn, "toString", { value: ts, configurable: true });
        } catch (_) {}
        return fn;
    }

    // Constructors where `new w.X(...)` is genuinely "Illegal constructor"
    // in real Chrome (DOM interfaces with no exposed constructor). Calls
    // to `new` on these throw `TypeError: Illegal constructor`.
    // Constructors NOT in this set are real callable types — for those we
    // delegate `new` to the parent realm's constructor via `Reflect.construct`
    // so e.g. `new iframe.contentWindow.Function("return 1")` returns a
    // function in the iframe realm, matching real Chrome. Some scripts use
    // `new w.Function(...)` to materialize a fresh-realm function; if we
    // throw where real Chrome succeeds, that differs from real Chrome.
    const _ILLEGAL_CONSTRUCTORS = new Set([
        "Navigator", "Window", "Document", "HTMLDocument",
        "Node", "Element", "HTMLElement",
        "HTMLDivElement", "HTMLSpanElement", "HTMLBodyElement",
        "HTMLAnchorElement", "HTMLImageElement", "HTMLInputElement",
        "HTMLFormElement", "HTMLButtonElement", "HTMLSelectElement",
        "HTMLTextAreaElement", "HTMLCanvasElement", "HTMLScriptElement",
        "HTMLIFrameElement",
    ]);

    function _mkMirroredConstructor(parentCtor, name, freshGrandparentProto) {
        // Fresh constructor function — different identity than parent's.
        // For DOM-interface types real Chrome throws on `new`; for genuine
        // callable types (Function/Array/Map/Date/Event/...) we delegate to
        // the parent constructor via Reflect.construct so the result lives
        // in our fresh realm (via fresh.prototype = freshProto below).
        const isIllegal = _ILLEGAL_CONSTRUCTORS.has(name);
        const fresh = isIllegal
            ? function() {
                throw new TypeError("Failed to construct '" + name + "': Illegal constructor");
            }
            : function(...args) {
                try {
                    return Reflect.construct(parentCtor, args, fresh);
                } catch (e) {
                    // Symbol() throws on `new`; re-throw with the parent's
                    // exact shape (don't reword) so feature-detection that
                    // catches "Symbol is not a constructor" still matches.
                    throw e;
                }
            };
        try {
            Object.defineProperty(fresh, "name", { value: name, configurable: true });
            Object.defineProperty(fresh, _NATIVE_TAG_SYMBOL, { value: name, configurable: true });
            const ts = function toString() { return "function " + name + "() { [native code] }"; };
            Object.defineProperty(ts, _NATIVE_TAG_SYMBOL, { value: "toString", configurable: true });
            Object.defineProperty(ts, "name", { value: "toString", configurable: true });
            Object.defineProperty(fresh, "toString", { value: ts, configurable: true });
        } catch (_) {}

        // Build a fresh prototype mirroring own-property-names of parent's prototype.
        // Each method/getter/setter is a fresh function with native toString shape.
        let parentProto = null;
        try { parentProto = parentCtor && parentCtor.prototype; } catch (_) {}
        // The fresh prototype's own __proto__ must point at the FRESH grandparent
        // prototype (built earlier in _buildRemoteRealm's topological pass),
        // NOT at the parent realm's grandparent. Crossing realms here makes
        // a prototype-chain walk traverse the parent realm's full chain on
        // top of the fresh chain, multiplying its work O(N) → O(N²+).
        const freshProto = Object.create(freshGrandparentProto || Object.prototype);

        if (parentProto) {
            const propNames = Object.getOwnPropertyNames(parentProto);
            for (const propName of propNames) {
                if (propName === "constructor") continue;
                let desc;
                try { desc = Object.getOwnPropertyDescriptor(parentProto, propName); } catch (_) { continue; }
                if (!desc) continue;
                const newDesc = {
                    configurable: desc.configurable !== false,
                    enumerable: !!desc.enumerable,
                };
                if (desc.get || desc.set) {
                    if (desc.get) newDesc.get = _mkNativeFn("get " + propName);
                    if (desc.set) newDesc.set = _mkNativeFn("set " + propName);
                } else {
                    newDesc.writable = desc.writable !== false;
                    if (typeof desc.value === "function") {
                        // Function-valued props: replace with our fresh native-shape stub
                        // (so cross-realm Function.prototype.toString.call(this) returns
                        // "function NAME() { [native code] }").
                        newDesc.value = _mkNativeFn(propName);
                    } else {
                        newDesc.value = desc.value;
                    }
                }
                try { Object.defineProperty(freshProto, propName, newDesc); } catch (_) {}
            }
        }

        try {
            Object.defineProperty(freshProto, "constructor", {
                value: fresh, writable: true, enumerable: false, configurable: true,
            });
            Object.defineProperty(fresh, "prototype", {
                value: freshProto, writable: false, enumerable: false, configurable: false,
            });
        } catch (_) {}
        return fresh;
    }

    // For each mirrored constructor name, find the nearest ancestor in
    // _MIRRORED_CONSTRUCTORS by walking the real prototype chain. Returns
    // an array of names in topological order (ancestors before descendants)
    // and a name -> direct-parent-name map.
    function _topoSortMirrored(names) {
        const realCtors = {};
        for (const n of names) {
            try {
                const c = globalThis[n];
                if (typeof c === "function") realCtors[n] = c;
            } catch (_) {}
        }
        const directParent = {};
        for (const n of names) {
            const ctor = realCtors[n];
            if (!ctor) { directParent[n] = null; continue; }
            let proto = null;
            try { proto = Object.getPrototypeOf(ctor.prototype); } catch (_) {}
            let parentName = null;
            let guard = 0;
            while (proto && guard++ < 32) {
                for (const m of names) {
                    const mc = realCtors[m];
                    if (mc && mc.prototype === proto) { parentName = m; break; }
                }
                if (parentName) break;
                try { proto = Object.getPrototypeOf(proto); } catch (_) { break; }
            }
            directParent[n] = parentName;
        }
        const ordered = [];
        const remaining = new Set(names);
        while (remaining.size > 0) {
            let progress = false;
            for (const n of Array.from(remaining)) {
                const p = directParent[n];
                if (p == null || !remaining.has(p)) {
                    ordered.push(n);
                    remaining.delete(n);
                    progress = true;
                }
            }
            if (!progress) {
                // Defensive: cyclic dependency in the real prototype graph
                // shouldn't happen, but if it does, append remaining without
                // ordering rather than infinite-looping.
                for (const n of remaining) ordered.push(n);
                break;
            }
        }
        return { ordered: ordered, directParent: directParent };
    }

    // Module-level cache: every iframe in this realm shares the same set of
    // mirrored constructors. Some scripts tag function/descriptor objects on
    // a first scope-chain walk and re-read them on a later walk; without this
    // cache every _getIframeWindow() call rebuilt the realm and any such
    // sentinel property set by the script was lost on the second read.
    let _cachedRemoteRealm = null;

    function _buildRemoteRealm() {
        if (_cachedRemoteRealm) return _cachedRemoteRealm;
        const realm = {};
        const sorted = _topoSortMirrored(_MIRRORED_CONSTRUCTORS);
        for (const name of sorted.ordered) {
            try {
                const parentCtor = globalThis[name];
                if (typeof parentCtor !== "function") continue;
                const parentName = sorted.directParent[name];
                const freshGrandparentProto = parentName && realm[parentName]
                    ? realm[parentName].prototype
                    : Object.prototype;
                realm[name] = _mkMirroredConstructor(parentCtor, name, freshGrandparentProto);
            } catch (_) {}
        }
        _cachedRemoteRealm = realm;
        return realm;
    }

    // Monotonically-increasing ID for child realms; used as the Rust-side
    // cache key in IframeRealmStore (HashMap<u32, ...>).
    let _nextRealmId = 0;

    // Frame registry: window[0], window[1], ... and window.length.
    // Some scripts access child iframes via window[N]
    // (frames[N]), NOT via iframe.contentWindow. Real Chrome updates
    // window[N] and window.length when iframes are appended to the DOM.
    const _frameRegistry = [];

    // Register contentWindow cw at frame index _fi in the main window.
    // Pass the iframe element el so we can find its DOM position and also
    // handle cases where the iframe was inserted via a non-tracked method
    // (insertBefore, innerHTML, insertAdjacentHTML, etc.).
    function _registerFrame(cw, el) {
        // Try to find the iframe's true DOM position
        var _fi = -1;
        // First: check if el is already tracked in _appendedIframes
        if (el) {
            for (var _ai = 0; _ai < _appendedIframes.length; _ai++) {
                if (_appendedIframes[_ai] === el) { _fi = _ai; break; }
            }
        }
        // Second: if not tracked, query the DOM for its position
        if (_fi < 0) {
            try {
                var _all = document.getElementsByTagName && document.getElementsByTagName('iframe');
                if (_all) {
                    for (var _di = 0; _di < _all.length; _di++) {
                        if (_all[_di] === el) { _fi = _di; break; }
                    }
                }
            } catch (_) {}
        }
        // Fallback: use sequential registry length
        if (_fi < 0) {
            _fi = _frameRegistry.length;
        }
        // Track in registry
        while (_frameRegistry.length <= _fi) _frameRegistry.push(null);
        _frameRegistry[_fi] = cw;
        // Register in _appendedIframes if not already there (for lazy getter)
        if (el && _fi >= _appendedIframes.length) {
            while (_appendedIframes.length < _fi) _appendedIframes.push(null);
            _appendedIframes.push(el);
            try { _setIfAppendCount(_appendedIframes.length); } catch (_) {}
        }
        // Install as window[N] — replace lazy getter (if any) with actual value
        try {
            Object.defineProperty(globalThis, String(_fi), {
                value: cw, writable: true, enumerable: true, configurable: true,
            });
        } catch (_) {}
        // `window.length` counts the document's iframes directly — see window_bootstrap.js.
    }

    // Extract scheme+host+port from a URL without using new URL().
    // Returns "null" for non-http(s) URLs (data:, about:, etc.) or empty input.
    const _xOrigin = function(u) {
        var m = u && u.match(/^(https?:\/\/[^/?#:]+(?::\d+)?)/i);
        return m ? m[1].toLowerCase() : "null";
    };

    // Cross-origin windows are not fully opaque: the HTML spec keeps a small
    // surface reachable, and `postMessage` is the whole point of it — every
    // third-party widget (hCaptcha, Turnstile, payment frames, OAuth) talks home
    // through it. Throwing SecurityError on `postMessage` too, as this proxy used
    // to, makes those widgets hang forever waiting for a handshake that can never
    // start. Delivery is queued for Rust because the child is a separate isolate.
    function _xoWindowProxy(el, message) {
        const allowed = {
            postMessage(data, targetOrigin, transfer) {
                let json;
                try {
                    json = JSON.stringify({
                        data: data,
                        origin: (globalThis.location && globalThis.location.origin) || '',
                        targetOrigin: String(targetOrigin == null ? '*' : targetOrigin),
                    });
                } catch (_) {
                    // Structured-clone-able but not JSON-able (functions, cycles):
                    // real postMessage would clone it; we degrade to a string.
                    json = JSON.stringify({ data: String(data), origin: '', targetOrigin: '*' });
                }
                try { ops.op_iframe_post_to_child(_getNodeId(el), json); } catch (_) {}
            },
            closed: false,
            length: 0,
            opener: null,
            // Self-referential window handles stay readable cross-origin.
            get frames() { return allowed; },
            get self() { return allowed; },
            get window() { return allowed; },
            get top() { return globalThis.top; },
            get parent() { return globalThis; },
            blur() {},
            focus() {},
            close() {},
        };
        return new Proxy(allowed, {
            get(t, p) {
                if (typeof p === 'symbol') return undefined;
                if (p in t) return t[p];
                throw new DOMException(message, 'SecurityError');
            },
            set(t, p, v) {
                // `location` is write-only cross-origin; everything else throws.
                if (p === 'location') return true;
                throw new DOMException(message, 'SecurityError');
            },
            has(t, p) { return p in t; },
        });
    }

    function _getIframeWindow(el) {
        // A nested browsing context is created when the element is *inserted*,
        // so a freshly created `<iframe>` has none and `contentWindow` is null.
        // Handing one out anyway is a direct stealth signal: creepjs makes a
        // detached iframe, reads `contentWindow`, and counts anything truthy as
        // proof that the property has been proxied.
        //
        // The test is "has no parent at all", not `isConnected`: an iframe built
        // *inside another frame's* document is connected to that realm's tree,
        // and rejecting it broke the nested-iframe probe — which then fell back
        // to the top window and let the page be overwritten. An iframe parented
        // to a detached subtree still gets a window here; narrower than the spec,
        // and the shape that actually gets probed is covered.
        try {
            if (el && !el.parentNode) return null;
        } catch (_) { /* ignore */ }
        let state = _iframeState.get(el);
        if (state) {
            // Cross-origin transition: a script creates an iframe with no src, accesses
            // contentWindow (creates child realm), then sets src to a cross-origin URL and re-accesses.
            // When src changes to cross-origin, invalidate the cached realm and return a
            // SecurityError proxy — exactly what real Chrome does.
            try {
                const _cSrc = (el && typeof el.getAttribute === "function")
                    ? (el.getAttribute("src") || el.src || "")
                    : (el && el.src || "");
                if (_cSrc && _cSrc !== "about:blank" && !/^javascript:/i.test(_cSrc) && _cSrc !== "") {
                    const _pOrig = _xOrigin((globalThis.location && globalThis.location.href) || "");
                    const _sOrig = _xOrigin(_cSrc);
                    if (_sOrig !== _pOrig) {
                        const _xM = 'Blocked a frame with origin "' + _pOrig + '" from accessing a cross-origin frame.';
                        const _xo2 = _xoWindowProxy(el, _xM);
                        const _xoS2 = { contentWindow: _xo2, contentDocument: null, _realmId: undefined, _processedSrcdoc: '' };
                        _iframeState.set(el, _xoS2);
                        return _xo2;
                    }
                }
            } catch (_) {}
            // Re-run srcdoc scripts if srcdoc was set after initial contentWindow access.
            // A script may set iframe.srcdoc = "..." before or after first contentWindow
            // access; in either case we must execute the scripts in the child realm.
            if (state._realmId !== undefined) {
                let _cur = "";
                try { _cur = el.getAttribute("srcdoc") || el.srcdoc || ""; } catch (_) {}
                if (_cur && _cur !== state._processedSrcdoc) {
                    state._processedSrcdoc = _cur;
                    try {
                        const _re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
                        let _m2;
                        while ((_m2 = _re.exec(_cur)) !== null) {
                            const _s2 = _m2[1];
                            if (_s2 && _s2.trim()) {
                                try { ops.op_eval_in_child_realm(state._realmId, _s2); } catch (_) {}
                            }
                        }
                    } catch (_) {}
                }
            }
            return state.contentWindow;
        }

        // ── Cross-origin iframe detection ────────────────────
        // Some scripts create an iframe with a different origin (e.g. a
        // data: URI or cross-origin https URL) and expect a SecurityError
        // when accessing contentWindow.document. Return a Proxy that throws
        // SecurityError on any property read — matches real Chrome behaviour.
        try {
            const _iSrc = (el && typeof el.getAttribute === "function")
                ? (el.getAttribute("src") || el.src || "")
                : (el && el.src || "");
            if (_iSrc && _iSrc !== "about:blank" && !/^javascript:/i.test(_iSrc) && _iSrc !== "") {
                const _pOrigin = _xOrigin((globalThis.location && globalThis.location.href) || "");
                const _srcOrigin = _xOrigin(_iSrc);
                if (_srcOrigin !== _pOrigin) {
                    const _xMsg = 'Blocked a frame with origin "' + _pOrigin + '" from accessing a cross-origin frame.';
                    const _xo = _xoWindowProxy(el, _xMsg);
                    const _xoState = { contentWindow: _xo, contentDocument: null, _realmId: undefined, _processedSrcdoc: '' };
                    _iframeState.set(el, _xoState);
                    _registerFrame(_xo, el);
                    return _xo;
                }
            }
        } catch (_) {}

        // ── Build the iframe document shell ──────────────────────────────
        // srcdoc iframes: expose the source text for
        // reads (`iframe.contentDocument.body.innerHTML`).
        let _srcdoc = "";
        try {
            if (el && typeof el.getAttribute === "function") {
                _srcdoc = el.getAttribute("srcdoc") || "";
            }
            // Also check direct JS property (set via el.srcdoc = "...") since
            // property assignment may not update the HTML attribute in our DOM.
            if (!_srcdoc && el && typeof el.srcdoc === "string") {
                _srcdoc = el.srcdoc;
            }
        } catch (_) {}
        // Real elements, detached from the top document — not plain objects.
        //
        // The mirrors used to be object literals whose `appendChild` was a no-op
        // and whose `innerHTML` was a bare string field, so everything a frame
        // wrote into itself vanished: the markup was stored and then nothing
        // could find it again, `getElementById` on that same document included.
        // A widget that builds its probes inside a blank frame — which is how
        // most of them measure fonts, rects and SVG geometry — got an empty
        // answer and no error to explain it.
        const _mkHtmlMirror = (tag, inner) => {
            const el = _document.createElement(tag);
            if (inner) {
                try { el.innerHTML = inner; } catch (_) { /* ignore */ }
            }
            return el;
        };
        // An `about:blank` frame is not an empty object — it is a fully formed
        // empty document, `<html><head></head><body></body></html>`, and
        // `contentDocument.body` is an element there, never null. Gating these on
        // `srcdoc` handed a blank frame a document with no body at all. Scripts
        // reach for exactly that: a blank same-origin frame is the standard way
        // to obtain untouched native objects, and the first thing such a probe
        // does is look at `contentDocument.body`. Finding null, it waits for a
        // document that is already as loaded as it will ever be.
        const _docEl = _mkHtmlMirror("html", "");
        const _head = _mkHtmlMirror("head", "");
        // The frame's own markup belongs in its body, and the three are linked
        // into one tree so a selector run from the document reaches all of it.
        const _body = _mkHtmlMirror("body", _srcdoc);
        try {
            _docEl.appendChild(_head);
            _docEl.appendChild(_body);
        } catch (_) { /* ignore */ }
        const iframeDoc = {
            documentElement: _docEl,
            head: _head,
            body: _body,
            title: "",
            readyState: "complete",
            visibilityState: "visible",
            hidden: false,
            hasFocus() { return false; },
            // Searched for real, against the frame's own tree. These returned
            // nothing unconditionally, which made the document contradict
            // itself: markup went in through `body.innerHTML` and no query on
            // the same document could see it.
            querySelector(sel) {
                try { return _docEl.querySelector(sel); } catch (_) { return null; }
            },
            querySelectorAll(sel) {
                try { return _docEl.querySelectorAll(sel); } catch (_) { return new NodeList([]); }
            },
            getElementById(id) {
                const quoted = String(id).replace(/["\\]/g, "\\$&");
                try { return _docEl.querySelector('[id="' + quoted + '"]'); }
                catch (_) { return null; }
            },
            getElementsByTagName(tag) {
                const t = String(tag).toLowerCase();
                // The document's own three are not descendants of themselves.
                // `NodeList` is built from node ids, not from node objects.
                if (t === "html" && _docEl) return new NodeList([_getNodeId(_docEl)]);
                if (t === "body" && _body) return new NodeList([_getNodeId(_body)]);
                if (t === "head" && _head) return new NodeList([_getNodeId(_head)]);
                try { return _docEl.getElementsByTagName(tag); }
                catch (_) { return new NodeList([]); }
            },
            // Collections of an empty document are empty, not absent. A missing
            // method is not a smaller document — it is a different kind of
            // object, and the first thing a script does with one is call it:
            // `[...doc.getElementsByClassName('x')]` threw "not a function"
            // inside a widget's own probe frame and took its whole collector
            // down with it.
            getElementsByClassName(cls) {
                try { return _docEl.getElementsByClassName(cls); }
                catch (_) { return new NodeList([]); }
            },
            getElementsByName(name) {
                const quoted = String(name).replace(/["\\]/g, "\\$&");
                try { return _docEl.querySelectorAll('[name="' + quoted + '"]'); }
                catch (_) { return new NodeList([]); }
            },
            get forms() { return new NodeList([]); },
            get images() { return new NodeList([]); },
            get links() { return new NodeList([]); },
            get scripts() { return new NodeList([]); },
            get styleSheets() { return []; },
            get activeElement() { return _body; },
            // Derived, not assigned: the realm's window is wired up on more
            // than one construction path and only some of them reach the
            // assignment site.
            get location() {
                const view = iframeDoc.defaultView;
                return (view && view.location) || null;
            },
            nodeType: 9,
            nodeName: "#document",
            characterSet: "UTF-8",
            charset: "UTF-8",
            inputEncoding: "UTF-8",
            contentType: "text/html",
            compatMode: "CSS1Compat",
            doctype: null,
            referrer: "",
            cookie: "",
            createElement(tag) { return _document.createElement(tag); },
            createElementNS(ns, tag) { return _document.createElementNS(ns, tag); },
            createEvent(type) { return _document.createEvent(type); },
            createRange() { return _document.createRange(); },
            createTextNode(text) { return _document.createTextNode(text); },
            createComment(text) { return _document.createComment(text); },
            createDocumentFragment() { return _document.createDocumentFragment(); },
            createAttribute(name) { return _document.createAttribute(name); },
            importNode(node, deep) { return _document.importNode(node, deep); },
            adoptNode(node) { return _document.adoptNode(node); },
            elementFromPoint() { return null; },
            elementsFromPoint() { return []; },
            getSelection() { return null; },
            write(html) { return _document.write(html); },
            writeln(html) { return _document.writeln(html); },
            open() { return _document.open(); },
            close() { return _document.close(); },
            // A document is an EventTarget. Listeners are kept here rather than
            // forwarded to the parent document, which would let a frame's
            // handlers fire on the top page's events.
            addEventListener(type, fn) {
                if (typeof fn !== "function") return;
                (_docListeners[type] || (_docListeners[type] = [])).push(fn);
            },
            removeEventListener(type, fn) {
                const list = _docListeners[type];
                if (!list) return;
                const at = list.indexOf(fn);
                if (at >= 0) list.splice(at, 1);
            },
            dispatchEvent(ev) {
                const list = ev && _docListeners[ev.type];
                if (list) {
                    for (const fn of list.slice()) {
                        try { fn.call(iframeDoc, ev); } catch (_) { /* ignore */ }
                    }
                }
                return true;
            },
        };
        const _docListeners = Object.create(null);

        // ── Screen mirror ─────────────────────────────────────────────────
        const _parentScreen = globalThis.screen || {};
        const _iframeScreen = {
            availWidth:  _parentScreen.availWidth  || 1920,
            availHeight: _parentScreen.availHeight || 1080,
            width:       _parentScreen.width       || 1920,
            height:      _parentScreen.height      || 1080,
            availLeft:   _parentScreen.availLeft   || 0,
            availTop:    _parentScreen.availTop    || 0,
            colorDepth:  _parentScreen.colorDepth  || 24,
            pixelDepth:  _parentScreen.pixelDepth  || 24,
            orientation: _parentScreen.orientation,
        };
        if (!/Firefox\/|Gecko\/20100101/.test(
            (typeof navigator !== "undefined" && navigator.userAgent) || ""
        )) {
            _iframeScreen.isExtended = false;
        }

        // ── Obtain the child window object ───────────────────────────────
        // PRIMARY PATH: genuine v8::Context child realm.
        // op_create_child_realm returns the child global:
        //   - Real, realm-distinct native intrinsics (Object/Function/… ≠ parent)
        //   - constructor.name === "Window" (set up in Rust)
        //   - Genuine-native Function.prototype.toString in child realm
        //   - self/window/globalThis/frames self-refs (set in Rust)
        // Matches real Chrome, where contentWindow is a genuine realm rather
        // than a Proxy or a parent alias.
        const _realmId = _nextRealmId++;
        let cw = null;
        try {
            const _got = ops.op_create_child_realm(_realmId);
            if (_got && typeof _got === "object") cw = _got;
        } catch (_) {}

        if (cw) {
            // ── Populate child realm with DOM/FP properties ───────────────
            // CRITICAL: use op_set_child_realm_prop for properties that must be
            // visible to code running INSIDE the child realm (e.g. srcdoc
            // script eval). Direct `cw.x = v` from parent JS goes to the global PROXY's
            // own dict; code inside the realm reads from the INNER global.
            // op_set_child_realm_prop enters the child ContextScope and calls
            // child_global.set() which forwards via [[Set]] to the inner global.
            const _sp = (k, v) => {
                try { ops.op_set_child_realm_prop(_realmId, k, v); } catch (_) {}
            };

            // iframeDoc back-reference to default view (set before _sp calls)
            try { iframeDoc.defaultView = cw; } catch (_) {}
            // ...and the URL trio, which only make sense once the realm's own
            // location exists. A document with no `URL` is not something a
            // browser can produce.
            try {
                const href = (cw.location && cw.location.href) || "about:blank";
                iframeDoc.URL = href;
                iframeDoc.documentURI = href;
                iframeDoc.baseURI = href;
            } catch (_) { /* ignore */ }

            // Document
            _sp("document", iframeDoc);

            // Location stub — about:blank inherits the parent origin per HTML spec.
            // Some scripts read document.domain (= hostname) and
            // location.origin; empty values differ from real Chrome.
            const _pLoc = globalThis.location || {};
            _sp("location", {
                href: "about:blank",
                origin: _pLoc.origin || "null",
                pathname: "/",
                hash: "", search: "",
                host: _pLoc.host || "",
                hostname: _pLoc.hostname || "",
                port: _pLoc.port || "",
                protocol: _pLoc.protocol || "https:",
                assign() {}, replace() {}, reload() {},
                toString() { return "about:blank"; },
            });

            // Parent / top / name
            _sp("parent", globalThis);
            _sp("top", globalThis);
            _sp("name", "");

            // Screen mirror (some scripts read these from inside child realm)
            _sp("screen", _iframeScreen);
            _sp("availWidth",  _iframeScreen.availWidth);
            _sp("availHeight", _iframeScreen.availHeight);

            // Viewport dimensions
            _sp("innerWidth",   globalThis.innerWidth  || 1920);
            _sp("innerHeight",  globalThis.innerHeight || 1080);
            _sp("outerWidth",   globalThis.outerWidth  || 1920);
            _sp("outerHeight",  globalThis.outerHeight || 1080);
            _sp("scrollX", 0); _sp("scrollY", 0);
            _sp("pageXOffset", 0); _sp("pageYOffset", 0);
            // Window state properties some scripts expect to be present.
            _sp("closed", false);
            _sp("name", "");
            _sp("status", "");
            _sp("defaultStatus", "");
            _sp("screenTop", globalThis.screenTop || 0);
            _sp("screenLeft", globalThis.screenLeft || 0);
            _sp("screenX", globalThis.screenX || 0);
            _sp("screenY", globalThis.screenY || 0);
            // history stub — basic object so `.toString()` doesn't throw.
            _sp("history", { length: 0, state: null, scrollRestoration: "auto",
                back() {}, forward() {}, go() {}, pushState() {}, replaceState() {} });
            // Storage stubs — some scripts may call `.toString()` on these.
            const _storageStub = Object.create(null);
            Object.defineProperty(_storageStub, Symbol.toStringTag, { value: "Storage", configurable: true });
            _storageStub.length = 0;
            _storageStub.getItem = function getItem() { return null; };
            _storageStub.setItem = function setItem() {};
            _storageStub.removeItem = function removeItem() {};
            _storageStub.clear = function clear() {};
            _storageStub.key = function key() { return null; };
            try { _sp("localStorage", _storageStub); } catch (_) {}
            try { _sp("sessionStorage", _storageStub); } catch (_) {}
            // indexedDB — basic stub so typeof is "object".
            _sp("indexedDB", { open() {}, deleteDatabase() {}, databases() { return Promise.resolve([]); }, cmp() { return 0; } });
            // visualViewport — propagate from parent (some scripts may call .toString()).
            try { if (globalThis.visualViewport !== undefined) _sp("visualViewport", globalThis.visualViewport); } catch (_) {}

            // Event handler stubs — Chrome defines all on* handlers as null (data property,
            // enumerable:true) on the Window global. The child realm gets genuine V8 natives
            // but NOT these Window interface additions. Some scripts iterate the parent
            // window's enumerable properties and for each key check it in the child realm;
            // calling .toString() on the undefined value throws, while null.toString()
            // would throw too but with the correct Chrome-matching TypeError shape.
            // Setting them null here makes child[key] !== undefined for all on* keys.
            const _onHandlers = [
                'onabort','onafterprint','onanimationcancel','onanimationend',
                'onanimationiteration','onanimationstart','onappinstalled','onauxclick',
                'onbeforeinput','onbeforeinstallprompt','onbeforematch','onbeforeprint',
                'onbeforetoggle','onbeforeunload','onbeforexrselect','onblur',
                'oncancel','oncanplay','oncanplaythrough','onchange',
                'onclick','onclose','oncommand','oncontentvisibilityautostatechange',
                'oncontextlost','oncontextmenu','oncontextrestored','oncuechange',
                'ondblclick','ondrag','ondragend','ondragenter',
                'ondragleave','ondragover','ondragstart','ondrop',
                'ondurationchange','onemptied','onended','onfocus',
                'onformdata','ongamepadconnected','ongamepaddisconnected','ongotpointercapture',
                'onhashchange','oninput','oninvalid','onkeydown',
                'onkeypress','onkeyup','onlanguagechange','onload',
                'onloadeddata','onloadedmetadata','onloadstart','onlostpointercapture',
                'onmessage','onmessageerror','onmousedown','onmouseenter',
                'onmouseleave','onmousemove','onmouseout','onmouseover',
                'onmouseup','onmousewheel','onoffline','ononline',
                'onpagehide','onpagereveal','onpageshow','onpageswap',
                'onpause','onplay','onplaying','onpointercancel',
                'onpointerdown','onpointerenter','onpointerleave','onpointermove',
                'onpointerout','onpointerover','onpointerrawupdate','onpointerup','onpopstate',
                'onprogress','onratechange','onrejectionhandled','onreset',
                'onresize','onscroll','onscrollend','onscrollsnapchange',
                'onscrollsnapchanging','onsearch','onsecuritypolicyviolation','onseeked',
                'onseeking','onselect','onselectionchange','onselectstart',
                'onslotchange','onstalled','onstorage','onsubmit',
                'onsuspend','ontimeupdate','ontoggle','ontransitioncancel',
                'ontransitionend','ontransitionrun','ontransitionstart','onunhandledrejection',
                'onunload','onvolumechange','onwaiting','onwebkitanimationend',
                'onwebkitanimationiteration','onwebkitanimationstart','onwebkittransitionend','onwheel',
            ];
            for (const _oh of _onHandlers) {
                try { _sp(_oh, null); } catch (_) {}
            }

            // Blanket-copy ALL remaining enumerable parent-window properties to child
            // realm. Some scripts iterate parent window's enumerable props and
            // check them in child; any that are undefined in child cause errors.
            // Real Chrome child frames have the same complete set as parent.
            // We skip child-specific properties (document, location, self-refs) that
            // are already set above or will be overridden below with correct values.
            const _basSkip = new Set([
                'window','self','globalThis','frames','top','parent',
                'document','location','opener',
                'length',
                // Carefully configured below (accessor or child-specific value):
                'devicePixelRatio','navigator','fetch','postMessage',
                // Already set above:
                'screen','availWidth','availHeight','innerWidth','innerHeight',
                'outerWidth','outerHeight','scrollX','scrollY','pageXOffset','pageYOffset',
                'screenTop','screenLeft','screenX','screenY',
                'closed','name','status','defaultStatus',
                'history','localStorage','sessionStorage','indexedDB','visualViewport',
            ]);
            try {
                for (const _bk of Object.keys(globalThis)) {
                    if (_basSkip.has(_bk)) continue;
                    // Skip numeric frame indices (not enumerable in real Chrome iframes)
                    if (_bk.length <= 4 && /^\d+$/.test(_bk)) continue;
                    try {
                        const _bv = globalThis[_bk];
                        _sp(_bk, _bv !== undefined ? _bv : null);
                    } catch (_) {}
                }
            } catch (_) {}

            // devicePixelRatio: define as a native-tagged accessor so that
            // A script inspecting these sees both a proper descriptor (getter:fn,
            // not data) AND [native code] from Function.prototype.toString.
            // The eval runs inside the child realm so Symbol.for resolves via
            // the isolate-level global symbol registry (same symbol as parent).
            const _dprVal = globalThis.devicePixelRatio || 1;
            try {
                ops.op_eval_in_child_realm(_realmId,
                    `(function(){var _nt=Symbol.for('__browser_oxide_native__');var _g=function(){return ${_dprVal};};Object.defineProperty(_g,_nt,{value:'get devicePixelRatio',configurable:true});Object.defineProperty(_g,'name',{value:'get devicePixelRatio',configurable:true});var _s=function(v){Object.defineProperty(this,'devicePixelRatio',{value:v,writable:true,enumerable:true,configurable:true});};Object.defineProperty(_s,_nt,{value:'set devicePixelRatio',configurable:true});Object.defineProperty(_s,'name',{value:'set devicePixelRatio',configurable:true});Object.defineProperty(globalThis,'devicePixelRatio',{get:_g,set:_s,enumerable:true,configurable:true});})();`
                );
            } catch (_) {
                _sp("devicePixelRatio", _dprVal);
            }

            // ── iframe EventTarget + bidirectional postMessage (FP-E1) ───────
            // The child v8::Context has a genuine MessageEvent but NO
            // addEventListener/dispatchEvent: those live on the parent's
            // EventTarget/Window prototype chain, which the own-enumerable
            // blanket-copy above never reaches. So a framed document's
            // `window.addEventListener('message', …)` threw (swallowed),
            // leaving the iframe unable to receive OR answer messages. That
            // both (a) gates real iframe-based challenge flows (which load
            // the challenge in an <iframe> and postMessage with it) and (b)
            // differs from real Chrome (real iframes expose these). Install a
            // native-shaped EventTarget backed
            // by a realm-local listener registry + a `__deliverMessage` hook the
            // parent uses to post INTO the realm. `parent`/`top` identity is
            // left untouched (set to globalThis above) — replies route via the
            // delivered event's `source` (the standard postMessage pattern), so
            // no `iframe.contentWindow.parent === window` FP invariant changes.
            try {
                ops.op_eval_in_child_realm(_realmId,
                    "(function(){var _nt=Symbol.for('__browser_oxide_native__');var _L=Object.create(null);"
                    + "function _n(fn,nm){try{Object.defineProperty(fn,'name',{value:nm,configurable:true});"
                    + "Object.defineProperty(fn,_nt,{value:nm,configurable:true});var ts=function toString(){return 'function '+nm+'() { [native code] }'};"
                    + "Object.defineProperty(ts,_nt,{value:'toString',configurable:true});Object.defineProperty(ts,'name',{value:'toString',configurable:true});"
                    + "Object.defineProperty(fn,'toString',{value:ts,configurable:true});}catch(_){}return fn;}"
                    + "function ael(type,fn){if(!(typeof fn==='function'||(fn&&typeof fn.handleEvent==='function')))return;var t=String(type);(_L[t]||(_L[t]=[])).push(fn);}"
                    + "function rel(type,fn){var a=_L[String(type)];if(a){var i=a.indexOf(fn);if(i>=0)a.splice(i,1);}}"
                    + "function de(ev){try{var t=ev&&ev.type;var a=_L[t];if(a)a.slice().forEach(function(h){try{(typeof h==='function'?h:h.handleEvent).call(globalThis,ev);}catch(_){}});"
                    + "var on=globalThis['on'+t];if(typeof on==='function'){try{on.call(globalThis,ev);}catch(_){}}}catch(_){}return true;}"
                    + "Object.defineProperty(globalThis,'addEventListener',{value:_n(ael,'addEventListener'),writable:true,configurable:true});"
                    + "Object.defineProperty(globalThis,'removeEventListener',{value:_n(rel,'removeEventListener'),writable:true,configurable:true});"
                    + "Object.defineProperty(globalThis,'dispatchEvent',{value:_n(de,'dispatchEvent'),writable:true,configurable:true});"
                    + "Object.defineProperty(globalThis,'__deliverMessage',{value:function(data,origin,source){Promise.resolve().then(function(){try{de(new MessageEvent('message',{data:data,origin:origin||'',source:source||null}));}catch(_){}});},configurable:true});})();"
                );
            } catch (_) {}

            // child→parent reply target: a Proxy over the real parent window
            // whose ONLY override is postMessage — lands a 'message' on the MAIN
            // window with source === this iframe's contentWindow (cw), what
            // solvers assert (`event.source === iframe.contentWindow`). Exposed
            // to the framed doc as the delivered event's `source`, NOT as
            // `parent`, so the parent-identity invariant is preserved.
            const _parentOrigin = (globalThis.location && globalThis.location.origin) || "";
            const _rawChildOrigin = _xOrigin(el.getAttribute && el.getAttribute("src"));
            const _childOrigin = _rawChildOrigin === "null" ? _parentOrigin : _rawChildOrigin;
            const _postToParent = function postMessage(msg, targetOrigin) {
                if (targetOrigin != null && targetOrigin !== "*" && String(targetOrigin) !== _parentOrigin) return;
                Promise.resolve().then(() => {
                    try {
                        globalThis.dispatchEvent(new MessageEvent("message", {
                            data: msg,
                            origin: _childOrigin,
                            source: cw,
                        }));
                    } catch (_) {}
                });
            };
            let _msgSource = null;
            try {
                _msgSource = new Proxy(globalThis, {
                    get(t, p) { return (p === "postMessage") ? _postToParent : Reflect.get(t, p); },
                });
            } catch (_) { _msgSource = { postMessage: _postToParent }; }
            _sp("__msgSource", _msgSource);

            // parent→child: cw.postMessage(...) (and the framed doc's own
            // window.postMessage) deliver a 'message' INTO the child realm. Data
            // crosses the realm boundary as a JSON literal; the event's source
            // is the reply-routing proxy above.
            const _pm = function postMessage(msg, targetOrigin) {
                if (targetOrigin != null && targetOrigin !== "*" && String(targetOrigin) !== _childOrigin) return;
                Promise.resolve().then(() => {
                    try {
                        const _dj = JSON.stringify(msg === undefined ? null : msg);
                        const _oj = JSON.stringify(_parentOrigin);
                        ops.op_eval_in_child_realm(_realmId,
                            "try{globalThis.__deliverMessage((" + _dj + ")," + _oj + ",(globalThis.__msgSource||null));}catch(_){}"
                        );
                    } catch (_) {}
                });
            };
            _sp("postMessage", _pm);

            // Navigator: fresh instance proxying parent values.
            try {
                const _parentNav = globalThis.navigator;
                const _nav = Object.create(Object.prototype);
                for (const _k of [
                    "userAgent", "platform", "language", "languages",
                    "hardwareConcurrency", "deviceMemory", "maxTouchPoints",
                    "vendor", "vendorSub", "product", "productSub",
                    "appName", "appVersion", "appCodeName", "cookieEnabled",
                    "onLine", "doNotTrack", "pdfViewerEnabled",
                    "plugins", "mimeTypes",
                ]) {
                    try {
                        const _v = _parentNav[_k];
                        if (_v !== undefined) Object.defineProperty(_nav, _k, { value: _v, writable: true, configurable: true, enumerable: true });
                    } catch (_) {}
                }
                // webdriver: `false` in modern Chrome (property present,
                // value false; `undefined` would differ from real Chrome).
                // Some scripts check cw.navigator.webdriver; false is the
                // Chrome-faithful value.
                Object.defineProperty(_nav, 'webdriver', { value: false, writable: true, configurable: true, enumerable: true });
                _sp("navigator", _nav);
            } catch (_) {}

            // Own realm `fetch` — distinct reference (cw.fetch !== parent.fetch)
            try {
                const _ifetch = function fetch(...a) { return globalThis.fetch.apply(this, a); };
                Object.defineProperty(_ifetch, "name", { value: "fetch", configurable: true });
                Object.defineProperty(_ifetch, "length", { value: 1, configurable: true });
                Object.defineProperty(_ifetch, _NATIVE_TAG_SYMBOL, { value: "fetch", configurable: true });
                _sp("fetch", _ifetch);
            } catch (_) {}

            // Copy key browser APIs that some scripts read from the child realm.
            // e.g. reading MediaSource.isTypeSupported from inside the child realm.
            const _apisToCopy = [
                'MediaSource', 'MediaSourceHandle', 'MediaCapabilities',
                'MediaRecorder', 'MediaStream', 'MediaStreamTrack',
                'HTMLVideoElement', 'HTMLAudioElement', 'HTMLMediaElement',
                'AudioContext', 'OfflineAudioContext',
                'RTCPeerConnection', 'RTCDataChannel',
                'Blob', 'File', 'FileReader',
                'URL', 'URLSearchParams',
                'WebSocket', 'Worker',
                'CSS', 'crypto', 'performance',
                'structuredClone', 'queueMicrotask', 'reportError',
                'crossOriginIsolated', 'isSecureContext', 'origin',
                'CustomEvent', 'Event', 'EventTarget',
                'PromiseRejectionEvent', 'ErrorEvent',
                'MessageChannel', 'MessagePort', 'MessageEvent',
                'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
                'PerformanceObserver',
                'TextEncoder', 'TextDecoder',
                'AbortController', 'AbortSignal',
                'ReadableStream', 'WritableStream', 'TransformStream',
                'Request', 'Response', 'Headers', 'FormData',
                'XMLHttpRequest', 'DOMParser',
                'Node', 'Element', 'Document',
                'HTMLElement', 'DocumentFragment',
                'Notification',
                // Singleton constructors the npc/crs probes expect in child realm.
                'Navigator', 'Location', 'History', 'Screen',
                'Performance', 'Permissions', 'ScreenOrientation',
                // The canvas/graphics constructor surface. Without these,
                // an iframe child realm has `CanvasRenderingContext2D ===
                // undefined` (all ctx2d proto methods missing on the child
                // realm). A script that fetches such a constructor/method
                // from the child realm gets `undefined` and then accessing a
                // property on it throws `TypeError: Cannot read properties of
                // undefined`, which differs from real Chrome. Real Chrome
                // iframe realms expose the full set. Only names that are
                // genuine main-realm globals are copied (the loop skips
                // `undefined`), so this is Chrome-faithful, not a stub.
                'CanvasRenderingContext2D', 'HTMLCanvasElement',
                'OffscreenCanvas', 'ImageData', 'Path2D', 'ImageBitmap',
                'WebGLRenderingContext', 'WebGL2RenderingContext',
                'DOMMatrix', 'DOMMatrixReadOnly', 'DOMPoint',
                'DOMRect', 'DOMRectReadOnly',
            ];
            for (const _ak of _apisToCopy) {
                try {
                    const _v = globalThis[_ak];
                    if (_v !== undefined) _sp(_ak, _v);
                } catch (_) {}
            }

            // Some scripts read MediaSource.isTypeSupported from inside the
            // child realm. Wrap in IIFE to prevent __kms leaking into child realm globals
            // (some scripts detect unexpected global variables).
            // globalThis.X = Y inside an IIFE IS visible to subsequent op_eval_in_child_realm
            // calls because they all run in the same child v8::Context.
            try {
                ops.op_eval_in_child_realm(_realmId,
                    '(function(){\n' +
                    'var __kms=new Set(["video/mp4","video/webm","audio/mp4","audio/webm",' +
                    '"audio/mpeg","audio/aac","audio/x-m4a","audio/mp3","audio/x-wav",' +
                    '"audio/ogg","audio/acc","audio/mp4;codecs=\\"mp4a.40.2\\"",' +
                    '"video/mp4;codecs=\\"avc1.42E01E,mp4a.40.2\\"",' +
                    '"video/webm;codecs=\\"vp9\\""]);\n' +
                    'var _its=function isTypeSupported(t){if(typeof t!=="string")return false;var b=t.split(";")[0].trim();return __kms.has(t)||__kms.has(b);};\n' +
                    'if(typeof MediaSource==="undefined"||MediaSource===undefined){\n' +
                    'globalThis.MediaSource=function MediaSource(){throw new TypeError("Failed to construct \'MediaSource\': Illegal constructor");};\n' +
                    '}\n' +
                    'if(typeof MediaSource.isTypeSupported!=="function") MediaSource.isTypeSupported=_its;\n' +
                    'if(typeof MediaRecorder==="undefined"||MediaRecorder===undefined){\n' +
                    'globalThis.MediaRecorder=function MediaRecorder(){throw new TypeError("Failed to construct \'MediaRecorder\': Illegal constructor");};\n' +
                    '}\n' +
                    'if(typeof MediaRecorder.isTypeSupported!=="function") MediaRecorder.isTypeSupported=_its;\n' +
                    '})();\n'
                );
            } catch (_) {}

            // Align child realm globals with main window so the realms don't diverge.
            // Chrome without COOP/COEP: SharedArrayBuffer is disabled in all frames.
            // Our V8 child context natively has SAB; delete it to match.
            try {
                ops.op_eval_in_child_realm(_realmId,
                    'if(typeof SharedArrayBuffer!=="undefined"&&typeof globalThis.SharedArrayBuffer!=="undefined")' +
                    '{try{delete globalThis.SharedArrayBuffer;}catch(_){globalThis.SharedArrayBuffer=undefined;}}'
                );
            } catch (_) {}

            // Execute srcdoc scripts in the child realm.
            // Some scripts inject content via srcdoc to
            // run code inside the iframe. A real browser executes those
            // scripts; we extract and eval them in the child realm context.
            if (_srcdoc) {
                try {
                    const _scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
                    let _m;
                    while ((_m = _scriptRe.exec(_srcdoc)) !== null) {
                        const _src = _m[1];
                        if (_src && _src.trim()) {
                            try { ops.op_eval_in_child_realm(_realmId, _src); } catch (_) {}
                        }
                    }
                } catch (_) {}
            }

            // ── Same-origin src document: fetch + execute ────────
            // Real iframe-based challenge flows
            // point the iframe at a same-origin URL whose document
            // runs the challenge and postMessages the result to the parent.
            // Cross-origin src already returned a SecurityError proxy above, so
            // any src reaching here is same-origin. Fetch the doc, reflect its
            // URL into the child realm's location (challenge scripts read
            // location.search for ?parentOrigin=…), and execute its scripts in
            // document order. Bounded + best-effort: a failed/slow fetch is
            // swallowed and the (empty) realm is returned — never hangs the nav.
            let _iSrcUrl2 = "";
            try {
                const _rawSrc2 = (el && typeof el.getAttribute === "function")
                    ? (el.getAttribute("src") || el.src || "") : (el && el.src || "");
                if (_rawSrc2 && _rawSrc2 !== "about:blank"
                    && !/^javascript:/i.test(_rawSrc2) && !/^data:/i.test(_rawSrc2)) {
                    try { _iSrcUrl2 = new URL(_rawSrc2, (globalThis.location && globalThis.location.href) || undefined).href; }
                    catch (_) { _iSrcUrl2 = _rawSrc2; }
                }
            } catch (_) {}
            if (_iSrcUrl2) {
                try {
                    let _u2 = null;
                    try { _u2 = new URL(_iSrcUrl2); } catch (_) {}
                    if (_u2) {
                        _sp("location", {
                            href: _u2.href, origin: _u2.origin, pathname: _u2.pathname,
                            search: _u2.search, hash: _u2.hash, host: _u2.host,
                            hostname: _u2.hostname, port: _u2.port, protocol: _u2.protocol,
                            assign() {}, replace() {}, reload() {},
                            toString() { return _u2.href; },
                        });
                    }
                    const _docHtml = ops.op_net_fetch_sync(_iSrcUrl2, (globalThis.location && globalThis.location.href) || "");
                    if (_docHtml && typeof _docHtml === "string" && _docHtml.length < 5000000) {
                        const _tagRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
                        let _sm;
                        let _guard = 0;
                        while ((_sm = _tagRe.exec(_docHtml)) !== null && _guard++ < 64) {
                            const _attrs = _sm[1] || "";
                            const _inline = _sm[2] || "";
                            const _typeM = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(_attrs);
                            const _ty = _typeM ? _typeM[1].toLowerCase() : "";
                            if (_ty && _ty !== "text/javascript" && _ty !== "application/javascript" && _ty !== "module") continue;
                            const _srcM = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(_attrs);
                            if (_srcM) {
                                let _eu = _srcM[1];
                                try { _eu = new URL(_eu, _iSrcUrl2).href; } catch (_) {}
                                try {
                                    const _code = ops.op_net_fetch_sync(_eu, _iSrcUrl2);
                                    if (_code && typeof _code === "string") {
                                        try { ops.op_eval_in_child_realm(_realmId, _code); } catch (_) {}
                                    }
                                } catch (_) {}
                            } else if (_inline && _inline.trim()) {
                                try { ops.op_eval_in_child_realm(_realmId, _inline); } catch (_) {}
                            }
                        }
                    }
                } catch (_) {}
            }

            state = { contentWindow: cw, contentDocument: iframeDoc, _realmId: _realmId, _processedSrcdoc: _srcdoc };
            _iframeState.set(el, state);
            _registerFrame(cw, el);
            return cw;
        }

        // ── FALLBACK: Proxy-based approach (if op unavailable) ───────────
        // Keeps existing behaviour when op_create_child_realm is not accessible
        // (e.g. worker runtime that doesn't load dom_extension).
        const remoteRealm = _buildRemoteRealm();
        const iframeLocals = {
            document: iframeDoc,
            location: { href: "about:blank" },
            parent: globalThis,
            top: globalThis,
            self: null,
            frames: [],
            screen: _iframeScreen,
            innerWidth:  globalThis.innerWidth  || 1920,
            innerHeight: globalThis.innerHeight || 1080,
            outerWidth:  globalThis.outerWidth  || 1920,
            outerHeight: globalThis.outerHeight || 1080,
            scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0,
            postMessage(msg, origin) {
                Promise.resolve().then(() => {
                    globalThis.dispatchEvent(new MessageEvent("message", { data: msg, origin: origin || "" }));
                });
            },
        };
        try {
            if (remoteRealm.Window && remoteRealm.Window.prototype) {
                Object.setPrototypeOf(iframeLocals, remoteRealm.Window.prototype);
            }
        } catch (_) {}
        try {
            const _ifetch = function fetch(...a) { return globalThis.fetch.apply(this, a); };
            Object.defineProperty(_ifetch, "name", { value: "fetch", configurable: true });
            Object.defineProperty(_ifetch, "length", { value: 1, configurable: true });
            Object.defineProperty(_ifetch, _NATIVE_TAG_SYMBOL, { value: "fetch", configurable: true });
            iframeLocals.fetch = _ifetch;
        } catch (_) {}
        try {
            const _dg = function () { return globalThis.devicePixelRatio || 1; };
            const _ds = function(v) {
                Object.defineProperty(iframeLocals, "devicePixelRatio", {
                    value: v, writable: true, enumerable: true, configurable: true,
                });
            };
            Object.defineProperty(_dg, _NATIVE_TAG_SYMBOL, { value: "get devicePixelRatio", configurable: true });
            Object.defineProperty(_dg, "name", { value: "get devicePixelRatio", configurable: true });
            Object.defineProperty(_ds, _NATIVE_TAG_SYMBOL, { value: "set devicePixelRatio", configurable: true });
            Object.defineProperty(_ds, "name", { value: "set devicePixelRatio", configurable: true });
            Object.defineProperty(iframeLocals, "devicePixelRatio", {
                get: _dg, set: _ds, enumerable: true, configurable: true,
            });
        } catch (_) {}
        const iframeWindow = new Proxy(iframeLocals, {
            get(target, prop) {
                if (prop in target) return target[prop];
                if (typeof prop === "string" && prop in remoteRealm) return remoteRealm[prop];
                try { return globalThis[prop]; } catch { return undefined; }
            },
            has(target, prop) {
                return prop in target || prop in remoteRealm || prop in globalThis;
            },
            getOwnPropertyDescriptor(target, prop) {
                if (prop in target) {
                    return Object.getOwnPropertyDescriptor(target, prop);
                }
                if (typeof prop === "string" && prop in remoteRealm) {
                    return { value: remoteRealm[prop], writable: true, enumerable: true, configurable: true };
                }
                return undefined;
            },
        });
        iframeLocals.self = iframeWindow;
        iframeLocals.window = iframeWindow;
        iframeLocals.globalThis = iframeWindow;
        iframeLocals.frames = iframeWindow;
        iframeLocals.length = 0;
        state = { contentWindow: iframeWindow, contentDocument: iframeDoc };
        _iframeState.set(el, state);
        _registerFrame(iframeWindow, el);
        return iframeWindow;
    }
    function _getIframeDocument(el) {
        // Null for the same reason `contentWindow` is: no browsing context until
        // the element is in a document.
        if (_getIframeWindow(el) === null) return null;
        const state = _iframeState.get(el);
        return state ? state.contentDocument : null;
    }

    // Install on HTMLIFrameElement.prototype — covers parsed AND created iframes.
    if (typeof HTMLIFrameElement !== 'undefined') {
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
            get: function() {
                return _getIframeWindow(this);
            },
            configurable: true,
            enumerable: true,
        });
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', {
            get: function() { return _getIframeDocument(this); },
            configurable: true,
            enumerable: true,
        });
        // srcdoc setter: when a script sets iframe.srcdoc = "..." BEFORE the first
        // contentWindow access, the value lands on the element's own property dict
        // (no setter exists, so JS creates an own data property). Our fallback in
        // _getIframeWindow reads el.srcdoc if getAttribute("srcdoc") is empty.
        //
        // When srcdoc is set AFTER the first contentWindow access (child realm
        // already cached), this setter fires immediately and re-executes the scripts.
        const _srcdocValues = new WeakMap();
        Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
            get: function() { return _srcdocValues.get(this) || this.getAttribute('srcdoc') || ''; },
            set: function(v) {
                _srcdocValues.set(this, String(v));
                // Write the attribute too. Keeping the value only in the WeakMap
                // made the assignment invisible to everything that reads the DOM:
                // the host scans attributes to decide which frames exist, so a
                // script-built srcdoc frame was never given a browsing context —
                // and the frame lifecycle hook on `setAttribute` never fired.
                try { this.setAttribute('srcdoc', String(v)); } catch (_) { /* detached */ }
                const _st = _iframeState.get(this);
                if (_st && _st._realmId !== undefined && v && String(v) !== _st._processedSrcdoc) {
                    _st._processedSrcdoc = String(v);
                    try {
                        const _re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
                        let _m3;
                        while ((_m3 = _re.exec(String(v))) !== null) {
                            const _s3 = _m3[1];
                            if (_s3 && _s3.trim()) {
                                try { ops.op_eval_in_child_realm(_st._realmId, _s3); } catch (_) {}
                            }
                        }
                    } catch (_) {}
                }
            },
            configurable: true,
            enumerable: true,
        });
    }

    // Keep the createElement customElements-upgrade hook — still needed for
    // user-defined custom elements.
    const _origCreateElement = Document.prototype.createElement;
    Document.prototype.createElement = function(tag) {
        const el = _origCreateElement.call(this, tag);
        const ceEntry = globalThis._customElementsRegistry && globalThis._customElementsRegistry.get(tag.toLowerCase());
        if (ceEntry) {
            Object.setPrototypeOf(el, ceEntry.constructor.prototype);
            try { ceEntry.constructor.call(el); } catch (e) { console.error(e); }
            el._ceUpgraded = true;
        }
        return el;
    };

    // ================================================================
    // Native-code mask sweep for every JS-defined Web API method.
    //
    // Without this, Function.prototype.toString called on attachShadow,
    // queueMicrotask, Document.createElement, etc. returns the literal
    // JS source — including our deno_core op names like
    // `op_dom_attach_shadow`. Real Chrome returns
    // `function NAME() { [native code] }`; without masking, scripts that
    // inspect these would see our op names and detect the difference.
    //
    // Strategy: walk every named own property of every Web API
    // prototype we define, find any function-typed values + getters +
    // setters, and apply _maskFunction. Idempotent — re-masking a
    // tagged function is a no-op.
    if (typeof globalThis._maskFunction === 'function') {
        const _mask = globalThis._maskFunction;
        const _walkProto = (ctor, ctorName) => {
            if (!ctor) return;
            try { _mask(ctor, ctorName); } catch (_) {}
            const proto = ctor.prototype;
            if (!proto) return;
            for (const key of Object.getOwnPropertyNames(proto)) {
                if (key === 'constructor') continue;
                const desc = Object.getOwnPropertyDescriptor(proto, key);
                if (!desc) continue;
                try {
                    if (typeof desc.value === 'function') _mask(desc.value, key);
                    if (typeof desc.get === 'function') _mask(desc.get, `get ${key}`);
                    if (typeof desc.set === 'function') _mask(desc.set, `set ${key}`);
                } catch (_) {}
            }
        };
        // Every JS-defined Web API class in this bootstrap, plus
        // siblings from window_bootstrap, fetch_bootstrap,
        // canvas_bootstrap, etc. Listed by name so the sweep is
        // conservative — only masks what we've verified exists.
        const _toMask = [
            'EventTarget', 'Node', 'Element', 'HTMLElement',
            'Document', 'HTMLDocument', 'DocumentFragment',
            'ShadowRoot', 'Text', 'Comment', 'Attr',
            'NodeList', 'HTMLCollection', 'NamedNodeMap',
            'DOMTokenList', 'CSSStyleDeclaration',
            // Window-bootstrap-defined classes that previously leaked
            // their JS source via Function.prototype.toString.
            'Bluetooth', 'StorageManager', 'SharedWorker',
            'WorkerGlobalScope', 'NetworkInformation', 'MediaDevices',
            'ServiceWorkerContainer', 'Permissions', 'PermissionStatus',
            'Notification', 'Clipboard', 'CredentialsContainer',
            'PresentationConnection', 'XRSystem', 'GPUAdapter',
            // Canvas/Audio
            'AudioContext', 'BaseAudioContext', 'OfflineAudioContext',
            'AudioWorkletNode', 'OscillatorNode', 'GainNode',
            'AnalyserNode', 'BiquadFilterNode', 'DynamicsCompressorNode',
            // Workers
            'Worker', 'BroadcastChannel', 'MessageChannel', 'MessagePort',
            // Media
            'MediaRecorder', 'MediaSource', 'MediaSession',
            // HTML element subclasses (mostly empty markers, but their
            // class source still leaks via toString without masking).
            'HTMLDivElement', 'HTMLSpanElement', 'HTMLParagraphElement',
            'HTMLAnchorElement', 'HTMLImageElement', 'HTMLCanvasElement',
            'HTMLScriptElement', 'HTMLStyleElement', 'HTMLLinkElement',
            'HTMLMetaElement', 'HTMLTableElement', 'HTMLIFrameElement',
            'HTMLBodyElement', 'HTMLHtmlElement', 'HTMLHeadElement',
            'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement',
            'HTMLTextAreaElement', 'HTMLFormElement', 'HTMLLabelElement',
            'HTMLOptionElement', 'HTMLUListElement', 'HTMLOListElement',
            'HTMLLIElement', 'HTMLHeadingElement', 'HTMLHRElement',
            'HTMLBRElement', 'HTMLPreElement', 'HTMLBlockquoteElement',
            'HTMLVideoElement', 'HTMLAudioElement', 'HTMLMediaElement',
            'HTMLSourceElement', 'HTMLTrackElement', 'HTMLPictureElement',
            'HTMLTemplateElement', 'HTMLSlotElement', 'HTMLDialogElement',
            'HTMLDetailsElement', 'HTMLProgressElement', 'HTMLMeterElement',
        ];
        for (const name of _toMask) {
            const ctor = globalThis[name];
            if (typeof ctor === 'function') _walkProto(ctor, name);
        }

        // Top-level globalThis function-typed members that should be
        // native. queueMicrotask + fetch were the worst offenders —
        // both leaked their literal JS source via
        // Function.prototype.toString.
        const _topLevelFns = [
            'queueMicrotask', 'fetch', 'setTimeout', 'clearTimeout',
            'setInterval', 'clearInterval', 'requestAnimationFrame',
            'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
            'structuredClone', 'reportError',
            'getComputedStyle', 'matchMedia', 'scroll', 'scrollTo', 'scrollBy',
            'alert', 'confirm', 'prompt', 'open', 'close', 'focus', 'blur',
            'postMessage', 'addEventListener', 'removeEventListener',
            'dispatchEvent',
        ];
        for (const name of _topLevelFns) {
            const fn = globalThis[name];
            if (typeof fn === 'function') {
                try { _mask(fn, name); } catch (_) {}
            }
        }
    }

    // Minimal window stub
    globalThis.window = globalThis;
    globalThis.self = globalThis;

    // Expose node-id resolution to sibling bootstrap files that need it
    // (event_bootstrap.js wires listeners by nodeId, not by Node identity).
    // Installed non-enumerable; cleanup_bootstrap.js deletes __browser_oxide
    // before page scripts run. Callers must CAPTURE the helper during
    // their own bootstrap execution, not look it up per-call.
    Object.defineProperty(globalThis, '__browser_oxide', {
        value: { _getNodeId },
        enumerable: false,
        configurable: true,
        writable: false,
    });

    // Warm-reuse DOM-registry reaper. Every registry below is module-private
    // and keyed by (or holding) state that belongs to ONE document, yet it
    // lives as long as the `JsRuntime`. On the cold path that is exactly the
    // life of the page, so nothing was ever pruned; on the warm path
    // (`PagePool` / `Page::navigate_warm`) `replace_dom` swaps the document
    // underneath them and they accumulate forever. See
    // `Page::reset_for_reuse`, which calls this.
    //
    // `_nodeCache` is doubly wrong across a swap: it is keyed by `nodeId`, and
    // node IDs restart at zero for the new document, so a surviving entry
    // hands the NEW page's node the OLD page's wrapper (with the old page's
    // expandos on it). The `WeakRef` values do not save us — an old wrapper
    // stays alive as long as any listener closure references it.
    Object.defineProperty(globalThis, '__resetDomRegistries', {
        value: function __resetDomRegistries() {
            _nodeCache.clear();
            _scrollState.clear();
            _syncFetchInFlight.clear();
            // Observers registered by the previous page's scripts. Pages
            // routinely never call `disconnect()`, so this only shrinks on
            // reuse — each retained observer pins its callback closure and
            // every observed target wrapper.
            _moObservers.length = 0;
            _appendedIframes.length = 0;
            _frameRegistry.length = 0;
            try { _setIfAppendCount(0); } catch (_) {}
            // Re-seed the document wrapper: `_wrapNode` must keep returning
            // the singleton `_document` for the document node id, which
            // `replace_dom` preserves.
            try { _nodeCache.set(ops.op_dom_document_node(), new WeakRef(_document)); } catch (_) {}
        },
        writable: true,
        configurable: true,
        enumerable: false,
    });

    // Cross-realm messaging handle, captured here because this file runs while
    // `Deno` still exists. Everything that drives iframe postMessage runs later —
    // the parent bridge is injected by `iframe.rs` after the runtime is built, and
    // the host pumps queues through `Page::pump_iframe_messages` — by which point
    // `cleanup_bootstrap.js` has removed `Deno` and a `Deno.core.ops` lookup yields
    // null. That failure is silent: `postMessage` becomes a no-op and a widget
    // waiting on its embedder simply hangs forever. Non-enumerable, same discipline
    // as `__bo_input_api` and `__bo_mark_trusted`.
    try {
        Object.defineProperty(_boNs, "frames", {
            value: {
                postToParent(json) {
                    try { ops.op_iframe_post_to_parent(json); } catch (_) { /* no host */ }
                },
                postToChild(nodeId, json) {
                    try { ops.op_iframe_post_to_child(nodeId, json); } catch (_) { /* no host */ }
                },
                takeParentMessages() {
                    try { return ops.op_iframe_take_parent_messages(); } catch (_) { return []; }
                },
                takeChildMessages() {
                    try { return ops.op_iframe_take_child_messages(); } catch (_) { return []; }
                },
                // The `source` of a MessageEvent the host delivers up from a frame.
                // A widget replies with `event.source.postMessage(...)`, so a null
                // source silently ends the conversation at the embedder.
                windowForNode(nodeId) {
                    try {
                        const el = _wrapNode(nodeId);
                        return el ? el.contentWindow : null;
                    } catch (_) {
                        return null;
                    }
                },
                // Inverse of `windowForNode`. Message routing keys on node ids that
                // are otherwise invisible from script, so a frame that silently
                // receives nothing cannot be told apart from one that was never
                // registered without this.
                nodeIdOf(el) {
                    try { return _getNodeId(el); } catch (_) { return -1; }
                },
            },
            writable: false,
            configurable: true,
            enumerable: false,
        });
    } catch (_) { /* ignore */ }
})(globalThis);
