// worker_bootstrap.js — runs inside a dedicated Worker V8 isolate.
//
// Sets up the worker-side surface: `self`, postMessage, onmessage dispatch,
// close, and a navigator stub. A setInterval-driven poll loop drains
// parent→worker messages via op_worker_self_recv and fires onmessage events.

((globalThis) => {
    const ops = Deno.core.ops;
    const _browser_oxide = globalThis.__browser_oxide;

    // Helper: read from stealth profile or use default
    const _p = (key, fallback) => {
        if (ops.op_has_stealth_profile && ops.op_has_stealth_profile()) {
            const v = ops.op_get_profile_value(key);
            return v !== "" ? v : fallback;
        }
        return fallback;
    };
    const _pInt = (key, fallback) => {
        const v = _p(key, "");
        return v !== "" ? parseInt(v, 10) : fallback;
    };
    const _pJson = (key, fallback) => {
        const v = _p(key, "");
        if (v !== "") try { return JSON.parse(v); } catch {}
        return fallback;
    };
    // Firefox/Gecko coherence (mirrors window_bootstrap). The worker realm must
    // not leak Chrome-only APIs under a Firefox UA — bot-detection sensors also
    // run inside workers, so a Chrome-shaped WorkerNavigator there is the same
    // impersonation tell as on the main thread.
    const _isFirefox = () => /Firefox\//.test(_p("user_agent", ""));

    // The global object doubles as WorkerGlobalScope / DedicatedWorkerGlobalScope / self.
    const self = globalThis;
    self.self = self;

    // ...and the interfaces have to exist, because that is how a script decides
    // it is in a worker at all. The canonical test is
    // `!self.document && self.WorkerGlobalScope`, and with the second half
    // missing a library takes its *window* path inside the worker: it finds
    // nothing it expects, throws nothing anyone sees, and posts nothing back.
    // Measured on creepjs, whose worker collector produced no data at all and
    // left four of its own probes reading properties of `undefined`.
    //
    // Chained onto the current global prototype rather than replacing it, so
    // everything already installed there stays reachable.
    try {
        if (!self.WorkerGlobalScope) {
            const _globalProto = Object.getPrototypeOf(self);
            class WorkerGlobalScope {}
            Object.setPrototypeOf(WorkerGlobalScope.prototype, _globalProto);
            class DedicatedWorkerGlobalScope extends WorkerGlobalScope {}
            for (const [ctor, name] of [
                [WorkerGlobalScope, "WorkerGlobalScope"],
                [DedicatedWorkerGlobalScope, "DedicatedWorkerGlobalScope"],
            ]) {
                Object.defineProperty(ctor.prototype, Symbol.toStringTag, {
                    value: name, configurable: true,
                });
                Object.defineProperty(self, name, {
                    value: ctor, writable: true, enumerable: false, configurable: true,
                });
                if (typeof globalThis._maskFunction === "function") {
                    globalThis._maskFunction(ctor, name);
                }
            }
            Object.setPrototypeOf(self, DedicatedWorkerGlobalScope.prototype);
        }
    } catch (_) { /* ignore */ }

    const _svc = (() => {
        try {
            const syms = Object.getOwnPropertySymbols(globalThis, 1);
            for (let i = 0; i < syms.length; i++) {
                const v = globalThis[syms[i]];
                if (v && v.__bo && v.services) return v.services;
            }
        } catch (_) {}
        return null;
    })();

    if (_svc) {
        const WL = _svc.iface("WorkerLocation");
        let _url = null;
        try {
            const raw = (ops && typeof ops.op_worker_self_url === "function") ? ops.op_worker_self_url() : "";
            if (raw) _url = new URL(raw);
        } catch (_) {}
        const _part = (k) => (_url ? _url[k] : "");
        for (const k of ["origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash", "href"]) {
            _svc.acc(WL.prototype, k, () => _part(k));
        }
        _svc.fn(WL.prototype, "toString", 0, () => _part("href"));
        _svc.layout(WL.prototype, ["origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash",
            "href", "toString", "constructor"]);
        const _location = _svc.make(WL);
        Object.defineProperty(self, "location", {
            get: () => _location, enumerable: true, configurable: true,
        });
    }

    // Intl timezone and locale come from ICU's defaults, which the runtime set
    // to the profile's (`js_runtime/intl.rs`); nothing to patch here.

    if (_svc) {
        const WN = _svc.iface("WorkerNavigator");
        const _secure = (() => {
            try { return !!ops.op_is_secure_context(); } catch (_) { return false; }
        })();
        let _languages = null;
        const _singletons = { __proto__: null };
        const _single = (name) => {
            if (!(name in _singletons)) {
                _singletons[name] = typeof self[name] === "function" ? _svc.make(self[name]) : undefined;
            }
            return _singletons[name];
        };
        const _firefox = _isFirefox();
        const _skip = new Set(_firefox
            ? ["connection", "hid", "serial", "usb", "deviceMemory", "userAgentData", "storageBuckets", "gpu"]
            : (_secure ? [] : ["hid", "serial", "usb", "deviceMemory", "userAgentData", "locks", "storage", "gpu", "storageBuckets"]));
        const _members = [
            ["hardwareConcurrency", () => _pInt("hardware_concurrency", 8)],
            ["appCodeName", () => "Mozilla"],
            ["appName", () => "Netscape"],
            ["appVersion", () => _p("app_version", "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36")],
            ["platform", () => _p("platform", "Win32")],
            ["product", () => "Gecko"],
            ["userAgent", () => _p("user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36")],
            ["language", () => _p("language", "en-US")],
            ["languages", () => (_languages ||= Object.freeze(_pJson("languages", ["en-US", "en"])))],
            ["onLine", () => true],
            ["connection", () => _single("NetworkInformation")],
            ["constructor", null],
            ["hid", () => _single("HID")],
            ["mediaCapabilities", () => _single("MediaCapabilities")],
            ["permissions", () => _single("Permissions")],
            ["serial", () => _single("Serial")],
            ["usb", () => _single("USB")],
            ["deviceMemory", () => Math.min(_pInt("device_memory", 8), 8)],
            ["userAgentData", () => _single("NavigatorUAData")],
            ["locks", () => _single("LockManager")],
            ["storage", () => _single("StorageManager")],
            ["gpu", () => _single("GPU")],
            ["storageBuckets", () => _single("StorageBucketManager")],
        ];
        const _order = [];
        for (const [name, get] of _members) {
            if (_skip.has(name)) continue;
            if (get) _svc.acc(WN.prototype, name, get);
            _order.push(name);
        }
        if (_firefox) {
            _svc.acc(WN.prototype, "oscpu", () => {
                const m = _p("user_agent", "").match(/\(([^)]*)\)/);
                return m ? m[1].replace(/;?\s*rv:[0-9.]+\s*/, "").replace(/^Macintosh;\s*/, "").trim() : "";
            });
            _svc.acc(WN.prototype, "buildID", () => "20181001000000");
            _order.push("oscpu", "buildID");
        }
        _svc.layout(WN.prototype, _order);
        const _navigator = _svc.make(WN);
        Object.defineProperty(self, "navigator", {
            get: () => _navigator, enumerable: true, configurable: true,
        });
    }

    if (_svc && typeof globalThis.Performance === "function") {
        const _performance = _svc.make(globalThis.Performance);
        Object.defineProperty(self, "performance", {
            get: () => _performance, enumerable: true, configurable: true,
        });
    }

    // --- postMessage: send a message to the parent thread ---
    self.postMessage = ({ postMessage(message) {
        const transfer = arguments[1];
        const transferList = Array.isArray(transfer)
            ? transfer
            : (transfer && Array.isArray(transfer.transfer) ? transfer.transfer : []);
        for (const t of transferList) {
            if (
                t !== null &&
                !(t instanceof ArrayBuffer) &&
                !(ArrayBuffer.isView && ArrayBuffer.isView(t))
            ) {
                throw new TypeError(
                    "postMessage: transferable must be an ArrayBuffer or view"
                );
            }
        }
        let wire;
        try {
            wire =
                (_browser_oxide &&
                    _browser_oxide.serializeForWire &&
                    _browser_oxide.serializeForWire(message)) ||
                message;
        } catch (e) {
            // DataCloneError — propagate.
            throw e;
        }
        let payload;
        try {
            payload = JSON.stringify({ data: wire });
        } catch (_e) {
            payload = JSON.stringify({ data: null });
        }
        ops.op_worker_self_post(payload);
    } }).postMessage;

    // --- close: terminate this worker ---
    // Terminating a worker from inside is rare; the parent handles cleanup.
    // We DO stop the message-pump interval here so a self-closed worker stops
    // holding `pending_intervals > 0` forever (06_ENGINE_CORRECTNESS #8) — a
    // closed DedicatedWorkerGlobalScope must not keep a live 5 ms poll.
    let _pumpId = 0;
    self.close = ({ close() {
        if (_pumpId) {
            try { clearInterval(_pumpId); } catch (_e) {}
            _pumpId = 0;
        }
        // parent.terminate() still drives real shutdown via AtomicBool.
    } }).close;

    // --- Poll loop: drain parent→worker messages and fire message events ---
    function drainOnce() {
        while (true) {
            const s = ops.op_worker_self_recv();
            if (!s) break;
            let payload;
            try {
                payload = JSON.parse(s);
            } catch (e) {
                continue;
            }
            const deserializer =
                _browser_oxide && _browser_oxide.deserializeFromWire;
            const data = deserializer
                ? deserializer(payload && payload.data)
                : payload && payload.data;
            const event = {
                type: "message",
                data,
                origin: "",
                lastEventId: "",
                source: null,
                ports: [],
                timeStamp: Date.now(),
            };
            // Use Event constructor from interfaces_bootstrap
            const ev = new MessageEvent("message", { data });
            self.dispatchEvent(ev);
        }
    }
    // Prime the pump every 5ms. In a later pass this can be driven by the
    // event loop directly instead of setInterval. Capture the id so
    // self.close() can clear it (see above).
    _pumpId = setInterval(drainOnce, 5);

    // --- importScripts: classic-worker synchronous script loader ---
    self.importScripts = ({ importScripts(...urls) {
        for (const raw of urls) {
            const url = String(raw);
            let source;
            if (url.startsWith("blob:")) {
                source = ops.op_blob_fetch_text(url);
                if (!source) throw new Error("importScripts failed to load blob URL " + url);
            } else if (url.startsWith("data:")) {
                const comma = url.indexOf(",");
                if (comma < 0) throw new Error("importScripts: malformed data URL");
                const meta = url.slice(5, comma);
                const body = url.slice(comma + 1);
                if (meta.endsWith(";base64")) {
                    source = atob(decodeURIComponent(body));
                } else {
                    source = decodeURIComponent(body);
                }
            } else if (url.startsWith("http://") || url.startsWith("https://")) {
                source = ops.op_worker_sync_fetch(url);
                if (!source) throw new Error("importScripts failed to load " + url);
            } else {
                throw new Error("importScripts: unsupported URL scheme: " + url);
            }
            (0, eval)(source);
        }
    } }).importScripts;

    // MediaSource + MediaRecorder.isTypeSupported in Worker realm.
    // Some scripts read .isTypeSupported in a Worker context; without
    // this it would be an undefined receiver — real Chrome has
    // MediaSource available in DedicatedWorker since Chrome 108.
    const _mediaTypes = new Set([
        "video/mp4", 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
        'video/mp4;codecs="avc1.640028"', "video/webm",
        'video/webm;codecs="vp8,vorbis"', 'video/webm;codecs="vp9"',
        'video/webm;codecs="vp9,opus"', "audio/mp4",
        'audio/mp4;codecs="mp4a.40.2"', "audio/webm",
        'audio/webm;codecs=opus', 'audio/webm;codecs=vorbis',
    ]);
    if (!globalThis.MediaSource) {
        globalThis.MediaSource = class MediaSource {
            static isTypeSupported(type) {
                if (typeof type !== 'string') return false;
                if (_mediaTypes.has(type)) return true;
                const base = type.split(';')[0].trim();
                return _mediaTypes.has(base);
            }
        };
    }
    if (!globalThis.MediaRecorder) {
        globalThis.MediaRecorder = class MediaRecorder {
            static isTypeSupported(type) {
                if (typeof type !== 'string') return false;
                if (_mediaTypes.has(type)) return true;
                const base = type.split(';')[0].trim();
                return _mediaTypes.has(base);
            }
        };
    }
})(globalThis);
