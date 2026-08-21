// Per-frame diagnostic tape, installed before the frame's own scripts.
//
// A widget that rebuilds its browsing context — hCaptcha does this on every
// challenge reload — takes any probe attached from outside with it. Hooks
// installed by hand therefore never survive to the moment worth observing, and
// each attempt costs a full round of reproduction. Injecting from the engine
// puts the tape in place before the frame runs a line of its own, and a fresh
// realm gets a fresh one automatically.
//
// Enabled by `BROWSER_OXIDE_FRAME_TRACE`; never injected otherwise, since it
// wraps APIs the page can see.
((globalThis) => {
    const ns = (function () {
        try {
            const syms = Object.getOwnPropertySymbols(globalThis);
            for (let i = 0; i < syms.length; i++) {
                const v = globalThis[syms[i]];
                if (v && v.__bo) return v;
            }
        } catch (_e) { /* ignore */ }
        return null;
    })();
    if (!ns || ns.trace) return;

    const log = [];
    const t0 = Date.now();
    const at = () => Date.now() - t0;
    // Ring buffer: a tape that stops at a cap goes blind exactly when the
    // interesting part starts, since the first seconds of a widget's life are
    // the noisiest.
    const push = (message, detail) => {
        if (log.length >= 2000) log.shift();
        const record = Object.assign({ ts: at(), message }, detail || {});
        log.push(JSON.stringify(record));
    };
    const short = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").slice(0, n);

    ns.trace = {
        log,
        dump: (tail) => log.slice(-(tail || 2000)).join("\n") || "",
        clear: () => { log.length = 0; },
        record: push,
    };

    // Which surface a context belongs to. A widget that renders into a canvas
    // it never attaches — and then presents the result some other way — makes
    // "the canvas is empty" meaningless without knowing *which* canvas was
    // asked. Numbering them at creation is what makes the tape readable.
    let canvasSeq = 0;
    const canvasName = (c) => {
        if (!c) return "?";
        try {
            if (!c.__boName) {
                c.__boName = "cv" + ++canvasSeq;
            }
            return c.__boName + "[" + (c.width | 0) + "x" + (c.height | 0) + "]"
                + (c.isConnected ? "+дом" : "-дом");
        } catch (_e) { return "?"; }
    };

    // --- drawing ---------------------------------------------------------
    try {
        const P = globalThis.CanvasRenderingContext2D
            && globalThis.CanvasRenderingContext2D.prototype;
        if (P && typeof P.drawImage === "function") {
            const orig = P.drawImage;
            let drawLogs = 0;
            P.drawImage = function (src, ...rest) {
                try {
                    const s = src || {};
                    if (drawLogs++ < 120) {
                        push("drawImage→" + canvasName(this.canvas) + " арг=" + (rest.length + 1)
                            + " ист=" + String(s.tagName || (s.constructor && s.constructor.name) || typeof s)
                            + " nat=" + (s.naturalWidth !== undefined ? s.naturalWidth + "x" + s.naturalHeight : "—")
                            + " готово=" + s.complete
                            + " decId=" + s._decodedImageId
                            + " → " + rest.map((v) => (typeof v === "number" ? Math.round(v) : v)).join(","));
                    }
                } catch (_e) { /* ignore */ }
                return orig.call(this, src, ...rest);
            };
        }
    } catch (_e) { /* ignore */ }

    const hash = (value) => {
        const s = String(value == null ? "" : value); let h = 2166136261;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        return (h >>> 0).toString(16);
    };
    const payload = (value) => {
        let keys = [];
        try {
            const parsed = typeof value === "string" ? JSON.parse(value) : value;
            if (parsed && typeof parsed === "object") keys = Object.keys(parsed).slice(0, 40);
        } catch (_e) { /* opaque payload */ }
        return { type: value === null ? "null" : typeof value, keys, hash: hash(value) };
    };
    const motionSummary = (body) => {
        let request = body;
        try {
            if (typeof request === "string") {
                try { request = JSON.parse(request); }
                catch (_e) { request = Object.fromEntries(new URLSearchParams(request)); }
            }
            if (!request || typeof request !== "object") return null;
            let motion = request.motionData || request.motion_data;
            if (typeof motion === "string") motion = JSON.parse(motion);
            if (!motion || typeof motion !== "object") return null;
            const points = [], series = {};
            for (const name of Object.keys(motion).slice(0, 40)) {
                const list = motion[name];
                if (!Array.isArray(list) || !list.some(Array.isArray)) continue;
                let invalid = 0, zero = 0, valid = 0;
                for (const p of list) {
                    if (!Array.isArray(p) || typeof p[0] !== "number" || typeof p[1] !== "number"
                        || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
                        invalid++;
                        continue;
                    }
                    valid++;
                    if (p[0] === 0 && p[1] === 0) zero++;
                    points.push([p[0], p[1]]);
                }
                series[name] = { count: list.length, valid, invalid, zero };
            }
            const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
            const canvases = [].map.call(document.querySelectorAll("canvas"), c => {
                const r = c.getBoundingClientRect();
                return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
            }).filter(r => r[2] > 0 && r[3] > 0);
            const viewport = [Number(globalThis.innerWidth) || 0, Number(globalThis.innerHeight) || 0];
            return {
                series,
                bounds: points.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null,
                viewport, canvases,
                outsideViewport: points.some(p => p[0] < 0 || p[1] < 0 || p[0] >= viewport[0] || p[1] >= viewport[1]),
            };
        } catch (_e) { return null; }
    };

    // --- postMessage routing -------------------------------------------
    try {
        const repeats = new Map();
        const note = (direction, data, targetOrigin, source) => {
            const sig = direction + ":" + hash(JSON.stringify(data));
            const frequency = (repeats.get(sig) || 0) + 1;
            repeats.set(sig, frequency);
            push("postMessage " + direction, {
                kind: "postMessage", direction,
                senderOrigin: String(globalThis.location && globalThis.location.origin || "null"),
                targetOrigin: targetOrigin == null ? "*" : String(targetOrigin),
                source: source === globalThis ? "self" : typeof source,
                payload: payload(data), frequency,
            });
        };
        const originalPost = globalThis.postMessage;
        if (typeof originalPost === "function") {
            globalThis.postMessage = function postMessage(data, targetOrigin) {
                note("self", data, targetOrigin, globalThis);
                return originalPost.apply(this, arguments);
            };
        }
        globalThis.addEventListener("message", (event) => {
            note("in", event.data, event.origin, event.source);
        }, true);
    } catch (_e) { /* ignore */ }

    // --- слушатели указателя ------------------------------------------------
    //
    // Records both halves of the question a dead gesture poses: what the widget
    // subscribed to, and whether our dispatch ever reaches it.
    try {
        const WATCH = {
            pointerdown: 1, pointermove: 1, pointerup: 1, click: 1, mousedown: 1,
            mouseup: 1, mousemove: 1, touchstart: 1, touchmove: 1, touchend: 1,
        };
        const desc = (t) => {
            try {
                if (!t) return "?";
                if (t === globalThis) return "window";
                if (t === globalThis.document) return "document";
                const id = t.id ? "#" + t.id : "";
                const cls = t.className && typeof t.className === "string"
                    ? "." + t.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
                return (t.tagName || t.constructor && t.constructor.name || "?") + id + cls;
            } catch (_e) { return "?"; }
        };
        const origAdd = EventTarget.prototype.addEventListener;
        let subs = 0, fires = 0;
        EventTarget.prototype.addEventListener = function (type, fn, opts) {
            if (WATCH[type] && typeof fn === "function") {
                if (subs < 40) { subs++; push("подписка " + type + " на " + desc(this)
                    + (opts && opts.capture ? " [capture]" : "")); }
                const wrapped = function (ev) {
                    try {
                        if (fires < 120) {
                            fires++;
                            push("СРАБОТАЛ " + type + " на " + desc(this)
                                + " цель=" + desc(ev && ev.target)
                                + " доверено=" + (ev && ev.isTrusted)
                                + " @" + Math.round((ev && ev.clientX) || 0)
                                + "," + Math.round((ev && ev.clientY) || 0), {
                                    kind: "input", phase: type,
                                    target: desc(ev && ev.target), currentTarget: desc(this),
                                    client: [Number(ev && ev.clientX) || 0, Number(ev && ev.clientY) || 0],
                                    screen: [Number(ev && ev.screenX) || 0, Number(ev && ev.screenY) || 0],
                                    buttons: Number(ev && ev.buttons) || 0,
                                    trusted: Boolean(ev && ev.isTrusted),
                                    hitTest: desc(document.elementFromPoint(
                                        Number(ev && ev.clientX) || 0, Number(ev && ev.clientY) || 0)),
                                });
                        }
                    } catch (_e) { /* ignore */ }
                    return fn.apply(this, arguments);
                };
                try { fn.__boWrapped = wrapped; } catch (_e) { /* ignore */ }
                return origAdd.call(this, type, wrapped, opts);
            }
            return origAdd.call(this, type, fn, opts);
        };
        const origRemove = EventTarget.prototype.removeEventListener;
        EventTarget.prototype.removeEventListener = function (type, fn, opts) {
            if (fn && fn.__boWrapped) return origRemove.call(this, type, fn.__boWrapped, opts);
            return origRemove.call(this, type, fn, opts);
        };
    } catch (_e) { /* ignore */ }

    // --- createImageBitmap ------------------------------------------------
    try {
        if (typeof globalThis.createImageBitmap === "function") {
            const origCIB = globalThis.createImageBitmap;
            let cib = 0;
            globalThis.createImageBitmap = function createImageBitmap(image) {
                const n = ++cib;
                let desc = "?";
                try {
                    const s = image || {};
                    desc = String(s.tagName || (s.constructor && s.constructor.name) || typeof s)
                        + "[" + (s.width || s.naturalWidth || 0) + "x" + (s.height || s.naturalHeight || 0) + "]"
                        + (s.type ? " " + s.type : "");
                } catch (_e) { /* ignore */ }
                push("createImageBitmap#" + n + " ист=" + desc + " арг=" + arguments.length);
                let p;
                try {
                    p = origCIB.apply(this, arguments);
                } catch (e) {
                    push("createImageBitmap#" + n + " бросил " + e);
                    throw e;
                }
                return Promise.resolve(p).then(
                    (bm) => {
                        push("createImageBitmap#" + n + " → " + (bm && bm.width) + "x" + (bm && bm.height));
                        return bm;
                    },
                    (e) => { push("createImageBitmap#" + n + " отказ " + e); throw e; },
                );
            };
        }
    } catch (_e) { /* ignore */ }

    // --- image loading ---------------------------------------------------
    try {
        const proto = globalThis.HTMLImageElement && globalThis.HTMLImageElement.prototype;
        const d = proto && Object.getOwnPropertyDescriptor(proto, "src");
        if (d && d.set) {
            let n = 0;
            Object.defineProperty(proto, "src", {
                configurable: true,
                enumerable: d.enumerable,
                get: d.get,
                set(v) {
                    const id = "img" + ++n;
                    const started = Date.now();
                    push(id + " src= " + short(v, 70));
                    try {
                        this.addEventListener("load", () => push(
                            id + " ЗАГРУЖЕН " + this.naturalWidth + "x" + this.naturalHeight
                            + " за " + ((Date.now() - started) / 1000).toFixed(1) + "с"
                        ), { once: true });
                        this.addEventListener("error", () => push(
                            id + " ОШИБКА за " + ((Date.now() - started) / 1000).toFixed(1) + "с"
                        ), { once: true });
                    } catch (_e) { /* ignore */ }
                    return d.set.call(this, v);
                },
            });
        }
    } catch (_e) { /* ignore */ }

    // --- the widget's own traffic ---------------------------------------
    const interesting = /getcaptcha|checkcaptcha|verify|siteverify|hsw|hsj/i;
    try {
        const of = globalThis.fetch;
        globalThis.fetch = function (u, opt) {
            const url = String((u && u.url) || u);
            const sent = opt && opt.body;
            return of.apply(this, arguments).then((r) => {
                if (interesting.test(url)) {
                    try {
                        r.clone().text().then((t) => push("captcha fetch", {
                            kind: "captcha", url: short(url, 120), status: r.status,
                            request: payload(sent), motion: motionSummary(sent),
                            response: payload(t), pass: /"pass"\s*:\s*true/.test(t),
                        }), () => {});
                    } catch (_e) { /* ignore */ }
                }
                return r;
            }, (e) => {
                if (interesting.test(url)) push("fetch ПРОВАЛ " + short(url, 55) + " :: " + e.message);
                throw e;
            });
        };
    } catch (_e) { /* ignore */ }

    try {
        const X = globalThis.XMLHttpRequest && globalThis.XMLHttpRequest.prototype;
        if (X) {
            const oo = X.open;
            const os = X.send;
            X.open = function (m, u) { this.__boUrl = String(u); return oo.apply(this, arguments); };
            X.send = function (b) {
                const self = this;
                const sent = b;
                try {
                    self.addEventListener("load", () => {
                        if (interesting.test(self.__boUrl || "")) {
                            push("captcha xhr", {
                                kind: "captcha", url: short(self.__boUrl, 120), status: self.status,
                                request: payload(sent), motion: motionSummary(sent), response: payload(self.responseText),
                                pass: /"pass"\s*:\s*true/.test(self.responseText || ""),
                            });
                        }
                    });
                } catch (_e) { /* ignore */ }
                return os.apply(this, arguments);
            };
        }
    } catch (_e) { /* ignore */ }

    // --- how the result is presented ------------------------------------
    try {
        const CP = globalThis.HTMLCanvasElement && globalThis.HTMLCanvasElement.prototype;
        if (CP && typeof CP.toDataURL === "function") {
            const orig = CP.toDataURL;
            CP.toDataURL = function (...args) {
                const out = orig.apply(this, args);
                push("toDataURL " + canvasName(this) + " → " + (out ? out.length + " симв" : "пусто"));
                return out;
            };
        }
    } catch (_e) { /* ignore */ }

    // Where a canvas ends up, if anywhere. `appendChild` is only one of the
    // ways; a surface presented as a background never lands in the tree at all.
    try {
        const N = globalThis.Node && globalThis.Node.prototype;
        if (N) {
            const oa = N.appendChild;
            N.appendChild = function (child) {
                try {
                    if (child && child.tagName === "CANVAS") {
                        push("append " + canvasName(child) + " → "
                            + short(this.tagName + "." + (this.className || ""), 30));
                    }
                } catch (_e) { /* ignore */ }
                return oa.apply(this, arguments);
            };
        }
    } catch (_e) { /* ignore */ }

    // A background set from a data URL is how a rendered surface usually
    // reaches the page when the canvas itself stays detached.
    try {
        const SP = globalThis.CSSStyleDeclaration && globalThis.CSSStyleDeclaration.prototype;
        if (SP) {
            const d = Object.getOwnPropertyDescriptor(SP, "backgroundImage");
            if (d && d.set) {
                Object.defineProperty(SP, "backgroundImage", {
                    configurable: true,
                    enumerable: d.enumerable,
                    get: d.get,
                    set(v) {
                        push("background-image = " + short(v, 60));
                        return d.set.call(this, v);
                    },
                });
            }
        }
    } catch (_e) { /* ignore */ }

    // --- failures --------------------------------------------------------
    try {
        globalThis.addEventListener("error", (e) => push("ОШИБКА: " + short(e.message, 180)));
        globalThis.addEventListener("unhandledrejection", (e) => push(
            "REJECT: " + short((e.reason && (e.reason.stack || e.reason.message)) || e.reason, 220)
        ));
        const oe = console.error;
        console.error = function (...args) {
            try {
                push("console.error: " + short(args.map((a) => (a && a.stack) || String(a)).join(" "), 220));
            } catch (_e) { /* ignore */ }
            return oe.apply(console, args);
        };
    } catch (_e) { /* ignore */ }

    push("трассировщик установлен", {
        kind: "frame", event: "create",
        url: short(globalThis.location && globalThis.location.href, 160),
        viewport: [Number(globalThis.innerWidth) || 0, Number(globalThis.innerHeight) || 0],
        dpr: Number(globalThis.devicePixelRatio) || 1,
    });
})(globalThis);
