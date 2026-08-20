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
    const at = () => "+" + ((Date.now() - t0) / 1000).toFixed(1) + "с ";
    // Ring buffer: a tape that stops at a cap goes blind exactly when the
    // interesting part starts, since the first seconds of a widget's life are
    // the noisiest.
    const push = (line) => {
        if (log.length >= 400) log.shift();
        log.push(at() + line);
    };
    const short = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").slice(0, n);

    ns.trace = {
        log,
        dump: (tail) => log.slice(-(tail || 60)).join("\n") || "(пусто)",
        clear: () => { log.length = 0; },
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
            P.drawImage = function (src, ...rest) {
                try {
                    const s = src || {};
                    push("drawImage→" + canvasName(this.canvas) + " арг=" + (rest.length + 1)
                        + " ист=" + String(s.tagName || (s.constructor && s.constructor.name) || typeof s)
                        + " nat=" + (s.naturalWidth !== undefined ? s.naturalWidth + "x" + s.naturalHeight : "—")
                        + " готово=" + s.complete
                        + " decId=" + s._decodedImageId
                        + " → " + rest.map((v) => (typeof v === "number" ? Math.round(v) : v)).join(","));
                } catch (_e) { /* ignore */ }
                return orig.call(this, src, ...rest);
            };
        }
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
                                + "," + Math.round((ev && ev.clientY) || 0));
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
            const sent = opt && opt.body ? short(opt.body, 200) : "";
            return of.apply(this, arguments).then((r) => {
                if (interesting.test(url)) {
                    try {
                        r.clone().text().then((t) => push(
                            "fetch " + r.status + " " + short(url.replace(/^https?:\/\//, ""), 55)
                            + (sent ? "\n    ОТПРАВЛЕНО: " + sent : "")
                            + "\n    ОТВЕТ: " + short(t, 260)
                        ), () => {});
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
                const sent = b ? short(b, 200) : "";
                try {
                    self.addEventListener("load", () => {
                        if (interesting.test(self.__boUrl || "")) {
                            push("xhr " + self.status + " "
                                + short(String(self.__boUrl).replace(/^https?:\/\//, ""), 55)
                                + (sent ? "\n    ОТПРАВЛЕНО: " + sent : "")
                                + "\n    ОТВЕТ: " + short(self.responseText, 260));
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

    push("трассировщик установлен в " + short(globalThis.location && globalThis.location.hash, 40));
})(globalThis);
