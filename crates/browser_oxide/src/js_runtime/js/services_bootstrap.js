((globalThis) => {
    const ops = Deno.core.ops;
    const _boNs = (() => {
        try {
            const syms = Object.getOwnPropertySymbols(globalThis, 1);
            for (let i = 0; i < syms.length; i++) {
                const v = globalThis[syms[i]];
                if (v && v.__bo) return v;
            }
        } catch (_) {}
        return null;
    })();
    const _mask = typeof globalThis._maskFunction === "function" ? globalThis._maskFunction : (f) => f;
    const _isWindow = typeof ops.op_dom_document_node === "function";
    const _apply = Reflect.apply;
    const _p = (key, fallback) => {
        try {
            if (ops.op_has_stealth_profile && ops.op_has_stealth_profile()) {
                const v = ops.op_get_profile_value(key);
                return v !== "" ? v : fallback;
            }
        } catch (_) {}
        return fallback;
    };
    const _pInt = (key, fallback) => {
        const v = _p(key, "");
        return v !== "" ? parseInt(v, 10) : fallback;
    };
    const _pFloat = (key, fallback) => {
        const v = _p(key, "");
        return v !== "" ? parseFloat(v) : fallback;
    };
    const _secure = () => {
        try { return !!ops.op_is_secure_context(); } catch (_) { return false; }
    };
    const _isFirefox = () => /Firefox\/|Gecko\/20100101/.test(_p("user_agent", ""));
    const _domError = (message, name) => new globalThis.DOMException(message, name);
    const _exec = (method, iface) => `Failed to execute '${method}' on '${iface}'`;

    const _iface = (name, parentName) => {
        const existing = globalThis[name];
        const P = parentName ? globalThis[parentName] : null;
        if (typeof existing === "function" && existing.prototype) {
            if (typeof P === "function" && Object.getPrototypeOf(existing.prototype) === Object.prototype) {
                try {
                    Object.setPrototypeOf(existing.prototype, P.prototype);
                    Object.setPrototypeOf(existing, P);
                } catch (_) {}
            }
            return existing;
        }
        const C = {
            [name]: function () {
                throw new TypeError(`Failed to construct '${name}': Illegal constructor`);
            },
        }[name];
        if (typeof P === "function") {
            Object.setPrototypeOf(C, P);
            Object.setPrototypeOf(C.prototype, P.prototype);
        }
        Object.defineProperty(C, "prototype", { writable: false });
        Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
        Object.defineProperty(globalThis, name, { value: C, writable: true, enumerable: false, configurable: true });
        _mask(C, name);
        return C;
    };

    const _brands = new WeakMap();
    const _make = (C) => {
        const o = Object.create(C.prototype);
        let set = _brands.get(C.prototype);
        if (!set) _brands.set(C.prototype, (set = new WeakSet()));
        set.add(o);
        return o;
    };
    const _check = (proto, o) => {
        const set = _brands.get(proto);
        if (set && set.has(o)) return;
        // A real implementation further down the chain counts too: Range is a
        // NodeRange in Chrome, and reads `startContainer` through its accessor.
        if (o !== null && (typeof o === "object" || typeof o === "function")
            && proto.isPrototypeOf(o)) {
            return;
        }
        throw new TypeError("Illegal invocation");
    };
    const _acc = (proto, name, get, set) => {
        const g = Object.getOwnPropertyDescriptor({
            get [name]() { _check(proto, this); return _apply(get, this, []); },
        }, name).get;
        _mask(g, "get " + name);
        let s;
        if (set) {
            s = Object.getOwnPropertyDescriptor({
                set [name](v) {
                    _check(proto, this);
                    if (arguments.length < 1) {
                        throw new TypeError(`Failed to set the '${name}' property on '${proto[Symbol.toStringTag]}': 1 argument required, but only 0 present.`);
                    }
                    _apply(set, this, [v]);
                },
            }, name).set;
            _mask(s, "set " + name);
        }
        Object.defineProperty(proto, name, { get: g, set: s, enumerable: true, configurable: true });
    };
    const _fn = (proto, name, length, impl, promise) => {
        const f = {
            [name](...args) {
                if (!promise) {
                    _check(proto, this);
                    return _apply(impl, this, args);
                }
                try {
                    _check(proto, this);
                    return Promise.resolve(_apply(impl, this, args));
                } catch (e) {
                    return Promise.reject(e);
                }
            },
        }[name];
        Object.defineProperty(f, "length", { value: length, configurable: true });
        _mask(f, name);
        Object.defineProperty(proto, name, { value: f, writable: true, enumerable: true, configurable: true });
    };
    const _fnP = (proto, name, length, impl) => _fn(proto, name, length, impl, true);
    const _handlers = new WeakMap();
    const _handler = (proto, name) => _acc(proto, name,
        function () {
            const m = _handlers.get(this);
            return (m && m[name]) || null;
        },
        function (v) {
            let m = _handlers.get(this);
            if (!m) _handlers.set(this, (m = { __proto__: null }));
            m[name] = (typeof v === "object" && v !== null) || typeof v === "function" ? v : null;
        });
    const _layout = (proto, order) => {
        const saved = [];
        for (const k of order) {
            const d = Object.getOwnPropertyDescriptor(proto, k);
            if (d) saved.push([k, d]);
        }
        for (const [k] of saved) delete proto[k];
        for (const [k, d] of saved) Object.defineProperty(proto, k, d);
        for (const sym of [Symbol.toStringTag, Symbol.iterator]) {
            const d = Object.getOwnPropertyDescriptor(proto, sym);
            if (d) {
                delete proto[sym];
                Object.defineProperty(proto, sym, d);
            }
        }
    };
    const _need = (args, count, where) => {
        if (args.length < count) {
            throw new TypeError(`${where}: ${count} argument${count === 1 ? "" : "s"} required, but only ${args.length} present.`);
        }
    };
    const _setlike = (proto, dataOf) => {
        _acc(proto, "size", function () { return dataOf(this).size; });
        _fn(proto, "entries", 0, function () { return dataOf(this).entries(); });
        _fn(proto, "forEach", 1, function (cb, thisArg) {
            if (typeof cb !== "function") {
                throw new TypeError(`${_exec("forEach", proto[Symbol.toStringTag])}: The callback provided as parameter 1 is not a function.`);
            }
            for (const v of dataOf(this)) _apply(cb, thisArg, [v, v, this]);
        });
        _fn(proto, "has", 1, function (v) { return dataOf(this).has(`${v}`); });
        _fn(proto, "keys", 0, function () { return dataOf(this).values(); });
        _fn(proto, "values", 0, function () { return dataOf(this).values(); });
        Object.defineProperty(proto, Symbol.iterator, { value: proto.values, writable: true, configurable: true });
    };

    {
        const C = _iface("Scheduler");
        _fnP(C.prototype, "postTask", 1, function (callback, options) {
            if (typeof callback !== "function") {
                throw new TypeError(`${_exec("postTask", "Scheduler")}: parameter 1 is not of type 'Function'.`);
            }
            const opts = options == null ? {} : options;
            const signal = opts.signal;
            const delay = Math.max(0, +opts.delay || 0);
            return new Promise((resolve, reject) => {
                if (signal && signal.aborted) {
                    reject(signal.reason);
                    return;
                }
                const id = setTimeout(() => {
                    try { resolve(callback()); } catch (e) { reject(e); }
                }, delay);
                if (signal && typeof signal.addEventListener === "function") {
                    signal.addEventListener("abort", () => {
                        clearTimeout(id);
                        reject(signal.reason);
                    }, { once: true });
                }
            });
        });
        _fnP(C.prototype, "yield", 0, function () {
            return new Promise((resolve) => setTimeout(resolve, 0));
        });
        _layout(C.prototype, ["postTask", "yield", "constructor"]);
    }

    {
        const C = _iface("NetworkInformation", "EventTarget");
        _handler(C.prototype, "onchange");
        _acc(C.prototype, "effectiveType", () => _p("connection_effective_type", "4g"));
        _acc(C.prototype, "rtt", () => Math.round(_pInt("connection_rtt", 50) / 25) * 25);
        _acc(C.prototype, "downlink", () => Math.round(_pFloat("connection_downlink", 10) * 40) / 40);
        _acc(C.prototype, "saveData", () => false);
        _layout(C.prototype, ["onchange", "effectiveType", "rtt", "downlink", "saveData", "constructor"]);
    }

    const _PERMISSION_STATES = {
        __proto__: null,
        "notifications": "prompt",
        "geolocation": "prompt",
        "camera": "prompt",
        "microphone": "prompt",
        "midi": "prompt",
        "push": "prompt",
        "persistent-storage": "granted",
        "background-sync": "granted",
        "background-fetch": "granted",
        "clipboard-read": "prompt",
        "clipboard-write": "granted",
        "payment-handler": "granted",
        "accelerometer": "granted",
        "gyroscope": "granted",
        "magnetometer": "granted",
        "ambient-light-sensor": "granted",
        "screen-wake-lock": "granted",
        "nfc": "prompt",
        "display-capture": "prompt",
        "window-management": "prompt",
    };
    const _SC_GATED_PERMISSIONS = new Set([
        "geolocation", "camera", "microphone", "midi", "push",
        "notifications", "clipboard-read", "nfc", "display-capture", "window-management",
    ]);
    const _permissionState = (name) => {
        if (!_secure() && _SC_GATED_PERMISSIONS.has(name)) return "denied";
        return _PERMISSION_STATES[name] || "prompt";
    };
    {
        const PS = _iface("PermissionStatus", "EventTarget");
        const names = new WeakMap();
        _acc(PS.prototype, "name", function () { return names.get(this); });
        _acc(PS.prototype, "state", function () { return _permissionState(names.get(this)); });
        _handler(PS.prototype, "onchange");
        _layout(PS.prototype, ["name", "state", "onchange", "constructor"]);

        const C = _iface("Permissions");
        _fnP(C.prototype, "query", 1, function (descriptor) {
            const where = _exec("query", "Permissions");
            _need(arguments, 1, where);
            if (descriptor !== null && descriptor !== undefined && typeof descriptor !== "object" && typeof descriptor !== "function") {
                throw new TypeError(`${where}: The provided value is not of type 'PermissionDescriptor'.`);
            }
            const name = descriptor == null ? undefined : descriptor.name;
            if (name === undefined) {
                throw new TypeError(`${where}: Failed to read the 'name' property from 'PermissionDescriptor': Required member is undefined.`);
            }
            const key = `${name}`;
            if (!(key in _PERMISSION_STATES)) {
                throw new TypeError(`${where}: Failed to read the 'name' property from 'PermissionDescriptor': The provided value '${key}' is not a valid enum value of type PermissionName.`);
            }
            const status = _make(PS);
            names.set(status, key);
            return status;
        });
        _layout(C.prototype, ["query", "constructor"]);
    }

    {
        const L = _iface("Lock");
        const lockData = new WeakMap();
        _acc(L.prototype, "name", function () { return lockData.get(this).name; });
        _acc(L.prototype, "mode", function () { return lockData.get(this).mode; });
        _layout(L.prototype, ["name", "mode", "constructor"]);

        const held = [];
        const pending = [];
        const grantable = (req) => {
            for (const h of held) {
                if (h.name !== req.name) continue;
                if (req.mode === "exclusive" || h.mode === "exclusive") return false;
            }
            return true;
        };
        const settle = () => {
            for (let i = 0; i < pending.length; i++) {
                const req = pending[i];
                const blockedEarlier = pending.slice(0, i).some((r) => r.name === req.name);
                if (blockedEarlier || !grantable(req)) continue;
                pending.splice(i, 1);
                i--;
                grant(req);
            }
        };
        const grant = (req) => {
            const lock = _make(L);
            lockData.set(lock, { name: req.name, mode: req.mode });
            const entry = { name: req.name, mode: req.mode, clientId: "", lock };
            held.push(entry);
            Promise.resolve().then(() => req.callback(lock)).then((v) => {
                release(entry);
                req.resolve(v);
            }, (e) => {
                release(entry);
                req.reject(e);
            });
        };
        const release = (entry) => {
            const i = held.indexOf(entry);
            if (i >= 0) held.splice(i, 1);
            settle();
        };
        const C = _iface("LockManager");
        _fnP(C.prototype, "request", 2, function (name, optionsOrCallback, maybeCallback) {
            const where = _exec("request", "LockManager");
            _need(arguments, 2, where);
            let options = {};
            let callback = maybeCallback;
            if (arguments.length === 2) {
                callback = optionsOrCallback;
            } else if (optionsOrCallback != null) {
                options = optionsOrCallback;
            }
            if (typeof callback !== "function") {
                throw new TypeError(`${where}: parameter ${arguments.length === 2 ? 2 : 3} is not of type 'Function'.`);
            }
            const key = `${name}`;
            if (key.startsWith("-")) {
                throw _domError(`${where}: Names cannot start with '-'.`, "NotSupportedError");
            }
            const mode = options.mode === undefined ? "exclusive" : `${options.mode}`;
            if (mode !== "exclusive" && mode !== "shared") {
                throw new TypeError(`${where}: Failed to read the 'mode' property from 'LockOptions': The provided value '${mode}' is not a valid enum value of type LockMode.`);
            }
            const signal = options.signal;
            if (signal && signal.aborted) return Promise.reject(signal.reason);
            return new Promise((resolve, reject) => {
                const req = { name: key, mode, callback, resolve, reject };
                if (options.steal) {
                    for (let i = held.length - 1; i >= 0; i--) if (held[i].name === key) held.splice(i, 1);
                    grant(req);
                    return;
                }
                const queuedAhead = pending.some((r) => r.name === key);
                if (!queuedAhead && grantable(req)) {
                    grant(req);
                    return;
                }
                if (options.ifAvailable) {
                    Promise.resolve().then(() => callback(null)).then(resolve, reject);
                    return;
                }
                pending.push(req);
                if (signal && typeof signal.addEventListener === "function") {
                    signal.addEventListener("abort", () => {
                        const i = pending.indexOf(req);
                        if (i >= 0) {
                            pending.splice(i, 1);
                            reject(signal.reason);
                        }
                    }, { once: true });
                }
            });
        });
        _fnP(C.prototype, "query", 0, function () {
            return {
                held: held.map((h) => ({ name: h.name, mode: h.mode, clientId: h.clientId })),
                pending: pending.map((r) => ({ name: r.name, mode: r.mode, clientId: "" })),
            };
        });
        _layout(C.prototype, ["query", "request", "constructor"]);
    }

    {
        const C = _iface("StorageManager");
        _fnP(C.prototype, "estimate", 0, function () {
            return {
                quota: 128849018880,
                usage: 0,
                usageDetails: {},
            };
        });
        _fnP(C.prototype, "persisted", 0, function () { return false; });
        _fnP(C.prototype, "getDirectory", 0, function () {
            throw _domError("The request is not allowed by the user agent or the platform in the current context.", "SecurityError");
        });
        const order = ["estimate", "persisted", "constructor", "getDirectory"];
        if (_isWindow) {
            _fnP(C.prototype, "persist", 0, function () { return false; });
            order.push("persist");
        }
        _layout(C.prototype, order);

        const B = _iface("StorageBucketManager");
        _fnP(B.prototype, "delete", 1, function () {
            _need(arguments, 1, _exec("delete", "StorageBucketManager"));
            return undefined;
        });
        _fnP(B.prototype, "keys", 0, function () { return []; });
        _fnP(B.prototype, "open", 1, function () {
            _need(arguments, 1, _exec("open", "StorageBucketManager"));
            throw _domError("Unknown error occurred while opening a bucket.", "UnknownError");
        });
        _layout(B.prototype, ["delete", "keys", "open", "constructor"]);

        const Cache = _iface("Cache");
        const cacheFns = [["add", 1, () => { throw new TypeError(`${_exec("add", "Cache")}: Request failed`); }],
            ["addAll", 1, () => { throw new TypeError(`${_exec("addAll", "Cache")}: Request failed`); }],
            ["delete", 1, () => false], ["keys", 0, () => []], ["match", 1, () => undefined],
            ["matchAll", 0, () => []], ["put", 2, () => undefined]];
        for (const [name, len, impl] of cacheFns) _fnP(Cache.prototype, name, len, impl);
        _layout(Cache.prototype, ["add", "addAll", "delete", "keys", "match", "matchAll", "put", "constructor"]);

        const CS = _iface("CacheStorage");
        const opened = new Map();
        _fnP(CS.prototype, "delete", 1, function (name) { return opened.delete(`${name}`); });
        _fnP(CS.prototype, "has", 1, function (name) { return opened.has(`${name}`); });
        _fnP(CS.prototype, "keys", 0, function () { return Array.from(opened.keys()); });
        _fnP(CS.prototype, "match", 1, function () { return undefined; });
        _fnP(CS.prototype, "open", 1, function (name) {
            _need(arguments, 1, _exec("open", "CacheStorage"));
            const key = `${name}`;
            if (!opened.has(key)) opened.set(key, _make(Cache));
            return opened.get(key);
        });
        _layout(CS.prototype, ["delete", "has", "keys", "match", "open", "constructor"]);
    }

    if (!_isFirefox()) {
        const decodingTypes = new Set(["file", "media-source", "webrtc"]);
        const encodingTypes = new Set(["record", "webrtc"]);
        const families = [
            "video/mp4", "video/webm", "video/h264", "video/h265", "video/hevc",
            "video/avc", "video/vp8", "video/vp9", "video/av1", "video/avs3",
            "audio/mp4", "audio/webm", "audio/aac", "audio/mpeg", "audio/opus",
            "audio/vorbis", "audio/flac", "audio/wav", "audio/ogg",
            "application/x-mpegurl",
        ];
        const supportsType = (ct) => {
            const t = String(ct || "").trim().toLowerCase();
            return !!t && families.some((f) => t.indexOf(f) === 0);
        };
        const info = (cfg, decoding) => {
            const audio = cfg.audio && typeof cfg.audio === "object" ? cfg.audio : null;
            const video = cfg.video && typeof cfg.video === "object" ? cfg.video : null;
            let supported = (decoding ? decodingTypes : encodingTypes).has(cfg.type);
            if (supported && audio) supported = supportsType(audio.contentType);
            if (supported && video) supported = supportsType(video.contentType);
            return { supported, smooth: supported, powerEfficient: supported, configuration: cfg };
        };
        const C = _iface("MediaCapabilities");
        for (const [name, decoding, enumName] of [["decodingInfo", true, "MediaDecodingType"], ["encodingInfo", false, "MediaEncodingType"]]) {
            _fnP(C.prototype, name, 1, function (configuration) {
                const where = _exec(name, "MediaCapabilities");
                _need(arguments, 1, where);
                if (configuration == null || typeof configuration !== "object") {
                    throw new TypeError(`${where}: Failed to read the 'type' property from '${decoding ? "MediaDecodingConfiguration" : "MediaEncodingConfiguration"}': Required member is undefined.`);
                }
                if (!(decoding ? decodingTypes : encodingTypes).has(configuration.type)) {
                    throw new TypeError(`${where}: Failed to read the 'type' property from '${decoding ? "MediaDecodingConfiguration" : "MediaEncodingConfiguration"}': The provided value '${configuration.type}' is not a valid enum value of type ${enumName}.`);
                }
                return info(configuration, decoding);
            });
        }
        _layout(C.prototype, ["decodingInfo", "encodingInfo", "constructor"]);
    }

    for (const [name, list, request, requestLength] of [
        ["HID", "getDevices", "requestDevice", 1],
        ["Serial", "getPorts", "requestPort", 0],
        ["USB", "getDevices", "requestDevice", 1],
    ]) {
        const C = _iface(name, "EventTarget");
        _handler(C.prototype, "onconnect");
        _handler(C.prototype, "ondisconnect");
        _fnP(C.prototype, list, 0, function () { return []; });
        const order = ["onconnect", "ondisconnect", list, "constructor"];
        if (_isWindow) {
            _fnP(C.prototype, request, requestLength, function () {
                throw _domError(`${_exec(request, name)}: Must be handling a user gesture to show a permission request.`, "SecurityError");
            });
            order.push(request);
        }
        _layout(C.prototype, order);
    }

    {
        const platform = () => _p("os_name", "Windows");
        const browserFull = () => _p("browser_version", "130.0.6723.91");
        const platformVersion = () => {
            const v = _p("platform_version", "");
            if (v) return v;
            if (platform() === "Linux") return "";
            const ver = _p("os_version", "");
            const parts = ver.split(".");
            if (parts.length >= 3) return ver;
            if (parts.length === 2) return parts[0] + "." + parts[1] + ".0";
            if (parts.length === 1 && parts[0]) return parts[0] + ".0.0";
            return "";
        };
        const pairs = () => {
            try {
                const v = JSON.parse(_p("ua_brands", ""));
                if (Array.isArray(v) && v.length === 3) return v;
            } catch (_) {}
            const m = browserFull().split(".")[0];
            return [["Chromium", m], ["Google Chrome", m], ["Not?A_Brand", "99"]];
        };
        let low = null, full = null;
        const lowBrands = () => (low ||= Object.freeze(pairs().map(([brand, version]) => Object.freeze({ brand, version }))));
        const fullBrands = () => (full ||= Object.freeze(pairs().map(([brand, version]) =>
            Object.freeze({ brand, version: brand.startsWith("Not") ? version + ".0.0.0" : browserFull() }))));
        const C = _iface("NavigatorUAData");
        _acc(C.prototype, "brands", () => lowBrands());
        _acc(C.prototype, "mobile", () => false);
        _acc(C.prototype, "platform", () => platform());
        _fnP(C.prototype, "getHighEntropyValues", 1, function (hints) {
            const where = _exec("getHighEntropyValues", "NavigatorUAData");
            _need(arguments, 1, where);
            if (hints === null || (typeof hints !== "object" && typeof hints !== "function") || typeof hints[Symbol.iterator] !== "function") {
                throw new TypeError(`${where}: The provided value cannot be converted to a sequence.`);
            }
            const result = { brands: lowBrands(), mobile: false, platform: platform() };
            for (const raw of hints) {
                switch (`${raw}`) {
                    case "architecture": result.architecture = _p("cpu_architecture", "x86"); break;
                    case "bitness": result.bitness = _p("cpu_bitness", "64"); break;
                    case "formFactors": result.formFactors = ["Desktop"]; break;
                    case "fullVersionList": result.fullVersionList = fullBrands(); break;
                    case "model": result.model = _p("ua_model", ""); break;
                    case "platformVersion": result.platformVersion = platformVersion(); break;
                    case "uaFullVersion": result.uaFullVersion = browserFull(); break;
                    case "wow64": result.wow64 = _p("ua_wow64", "false") === "true"; break;
                }
            }
            return result;
        });
        _fn(C.prototype, "toJSON", 0, function () {
            return {
                brands: lowBrands().map((b) => ({ brand: b.brand, version: b.version })),
                mobile: false,
                platform: platform(),
            };
        });
        _layout(C.prototype, ["brands", "mobile", "platform", "getHighEntropyValues", "toJSON", "constructor"]);
    }

    {
        const LIMITS = [
            ["maxTextureDimension1D", 16384], ["maxTextureDimension2D", 16384],
            ["maxTextureDimension3D", 2048], ["maxTextureArrayLayers", 2048],
            ["maxBindGroups", 4], ["maxBindGroupsPlusVertexBuffers", 24],
            ["maxBindingsPerBindGroup", 1000],
            ["maxDynamicUniformBuffersPerPipelineLayout", 8],
            ["maxDynamicStorageBuffersPerPipelineLayout", 8],
            ["maxSampledTexturesPerShaderStage", 16], ["maxSamplersPerShaderStage", 16],
            ["maxStorageBuffersPerShaderStage", 10], ["maxStorageTexturesPerShaderStage", 8],
            ["maxUniformBuffersPerShaderStage", 12], ["maxUniformBufferBindingSize", 65536],
            ["maxStorageBufferBindingSize", 134217728],
            ["minUniformBufferOffsetAlignment", 256], ["minStorageBufferOffsetAlignment", 256],
            ["maxVertexBuffers", 8], ["maxBufferSize", 268435456], ["maxVertexAttributes", 30],
            ["maxVertexBufferArrayStride", 2048], ["maxInterStageShaderVariables", 16],
            ["maxColorAttachments", 8], ["maxColorAttachmentBytesPerSample", 32],
            ["maxComputeWorkgroupStorageSize", 32768], ["maxComputeInvocationsPerWorkgroup", 1024],
            ["maxComputeWorkgroupSizeX", 1024], ["maxComputeWorkgroupSizeY", 1024],
            ["maxComputeWorkgroupSizeZ", 64], ["maxComputeWorkgroupsPerDimension", 65535],
            ["maxImmediateSize", 0], ["constructor"],
            ["maxStorageBuffersInFragmentStage", 10], ["maxStorageTexturesInFragmentStage", 8],
            ["maxStorageBuffersInVertexStage", 10], ["maxStorageTexturesInVertexStage", 8],
        ];
        const FEATURES = [
            "depth-clip-control", "depth32float-stencil8", "texture-compression-bc",
            "texture-compression-etc2", "texture-compression-astc", "timestamp-query",
            "indirect-first-instance", "shader-f16", "rg11b10ufloat-renderable",
            "bgra8unorm-storage", "float32-filterable",
        ];
        const WGSL = [
            "readonly_and_readwrite_storage_textures", "packed_4x8_integer_dot_product",
            "unrestricted_pointer_parameters", "pointer_composite_access",
        ];
        const sets = new WeakMap();
        const dataOf = (o) => sets.get(o);

        const Limits = _iface("GPUSupportedLimits");
        for (const [name, value] of LIMITS) {
            if (name !== "constructor") _acc(Limits.prototype, name, () => value);
        }
        _layout(Limits.prototype, LIMITS.map((e) => e[0]));

        const Features = _iface("GPUSupportedFeatures");
        _setlike(Features.prototype, dataOf);
        _layout(Features.prototype, ["size", "entries", "forEach", "has", "keys", "values", "constructor"]);

        const Wgsl = _iface("WGSLLanguageFeatures");
        _setlike(Wgsl.prototype, dataOf);
        _layout(Wgsl.prototype, ["size", "entries", "forEach", "has", "keys", "values", "constructor"]);

        const renderer = () => `${_p("webgl_unmasked_renderer", "")} ${_p("webgl_unmasked_vendor", "")}`.toLowerCase();
        const adapterIdentity = () => {
            const r = renderer();
            if (r.includes("nvidia")) return ["nvidia", "ampere"];
            if (r.includes("amd") || r.includes("radeon")) return ["amd", "gen-3"];
            if (r.includes("intel")) return ["intel", "gen-12lp"];
            return ["apple", "metal-3"];
        };
        const Info = _iface("GPUAdapterInfo");
        const infoFields = [["vendor", () => adapterIdentity()[0]], ["architecture", () => adapterIdentity()[1]],
            ["device", () => ""], ["description", () => ""], ["subgroupMinSize", () => 4],
            ["subgroupMaxSize", () => 128], ["isFallbackAdapter", () => false]];
        for (const [name, get] of infoFields) _acc(Info.prototype, name, get);
        _layout(Info.prototype, ["vendor", "architecture", "device", "description", "subgroupMinSize", "subgroupMaxSize", "isFallbackAdapter", "constructor"]);

        const newSet = (C, values) => {
            const o = _make(C);
            sets.set(o, new Set(values));
            return o;
        };
        const parts = new WeakMap();
        const Queue = _iface("GPUQueue");
        const queueLabels = new WeakMap();
        _acc(Queue.prototype, "label", function () { return queueLabels.get(this) || ""; },
            function (v) { queueLabels.set(this, `${v}`); });
        for (const [name, len] of [["copyExternalImageToTexture", 3], ["submit", 1], ["writeBuffer", 3], ["writeTexture", 4]]) {
            _fn(Queue.prototype, name, len, function () { return undefined; });
        }
        _fnP(Queue.prototype, "onSubmittedWorkDone", 0, function () { return undefined; });
        _layout(Queue.prototype, ["label", "copyExternalImageToTexture", "onSubmittedWorkDone", "submit", "writeBuffer", "writeTexture", "constructor"]);

        const Device = _iface("GPUDevice", "EventTarget");
        const devLabels = new WeakMap();
        _acc(Device.prototype, "features", function () { return parts.get(this).features; });
        _acc(Device.prototype, "limits", function () { return parts.get(this).limits; });
        _acc(Device.prototype, "adapterInfo", function () { return parts.get(this).info; });
        _acc(Device.prototype, "lost", function () { return parts.get(this).lost; });
        _acc(Device.prototype, "queue", function () { return parts.get(this).queue; });
        _handler(Device.prototype, "onuncapturederror");
        _acc(Device.prototype, "label", function () { return devLabels.get(this) || ""; },
            function (v) { devLabels.set(this, `${v}`); });
        const deviceFns = [["createBindGroup", 1], ["createBindGroupLayout", 1], ["createBuffer", 1],
            ["createCommandEncoder", 0], ["createComputePipeline", 1], ["createPipelineLayout", 1],
            ["createQuerySet", 1], ["createRenderBundleEncoder", 1], ["createRenderPipeline", 1],
            ["createSampler", 0], ["createShaderModule", 1], ["createTexture", 1], ["destroy", 0],
            ["importExternalTexture", 1], ["pushErrorScope", 1]];
        for (const [name, len] of deviceFns) _fn(Device.prototype, name, len, function () { return undefined; });
        _fnP(Device.prototype, "createComputePipelineAsync", 1, function () { return undefined; });
        _fnP(Device.prototype, "createRenderPipelineAsync", 1, function () { return undefined; });
        _fnP(Device.prototype, "popErrorScope", 0, function () { return null; });
        _layout(Device.prototype, ["features", "limits", "adapterInfo", "lost", "queue", "onuncapturederror", "label",
            "createBindGroup", "createBindGroupLayout", "createBuffer", "createCommandEncoder", "createComputePipeline",
            "createComputePipelineAsync", "createPipelineLayout", "createQuerySet", "createRenderBundleEncoder",
            "createRenderPipeline", "createRenderPipelineAsync", "createSampler", "createShaderModule", "createTexture",
            "destroy", "importExternalTexture", "popErrorScope", "pushErrorScope", "constructor"]);

        const Adapter = _iface("GPUAdapter");
        _acc(Adapter.prototype, "features", function () { return parts.get(this).features; });
        _acc(Adapter.prototype, "limits", function () { return parts.get(this).limits; });
        _acc(Adapter.prototype, "info", function () { return parts.get(this).info; });
        _fnP(Adapter.prototype, "requestDevice", 0, function () {
            const own = parts.get(this);
            const device = _make(Device);
            parts.set(device, {
                features: newSet(Features, FEATURES),
                limits: _make(Limits),
                info: own.info,
                lost: new Promise(() => {}),
                queue: _make(Queue),
            });
            return device;
        });
        _layout(Adapter.prototype, ["features", "limits", "info", "requestDevice", "constructor"]);

        const Gpu = _iface("GPU");
        let wgsl = null;
        _acc(Gpu.prototype, "wgslLanguageFeatures", () => (wgsl ||= newSet(Wgsl, WGSL)));
        _fn(Gpu.prototype, "getPreferredCanvasFormat", 0, () => "bgra8unorm");
        _fnP(Gpu.prototype, "requestAdapter", 0, function () {
            const adapter = _make(Adapter);
            parts.set(adapter, {
                features: newSet(Features, FEATURES),
                limits: _make(Limits),
                info: _make(Info),
            });
            return adapter;
        });
        _layout(Gpu.prototype, ["wgslLanguageFeatures", "getPreferredCanvasFormat", "requestAdapter", "constructor"]);

        for (const [name, entries] of [
            ["GPUBufferUsage", [["MAP_READ", 1], ["MAP_WRITE", 2], ["COPY_SRC", 4], ["COPY_DST", 8], ["INDEX", 16],
                ["VERTEX", 32], ["UNIFORM", 64], ["STORAGE", 128], ["INDIRECT", 256], ["QUERY_RESOLVE", 512]]],
            ["GPUColorWrite", [["RED", 1], ["GREEN", 2], ["BLUE", 4], ["ALPHA", 8], ["ALL", 15]]],
            ["GPUMapMode", [["READ", 1], ["WRITE", 2]]],
            ["GPUShaderStage", [["VERTEX", 1], ["FRAGMENT", 2], ["COMPUTE", 4]]],
            ["GPUTextureUsage", [["COPY_SRC", 1], ["COPY_DST", 2], ["TEXTURE_BINDING", 4], ["STORAGE_BINDING", 8],
                ["RENDER_ATTACHMENT", 16], ["TRANSIENT_ATTACHMENT", 32]]],
        ]) {
            const ns = {};
            for (const [k, v] of entries) {
                Object.defineProperty(ns, k, { value: v, writable: false, enumerable: true, configurable: false });
            }
            Object.defineProperty(ns, Symbol.toStringTag, { value: name, configurable: true });
            Object.defineProperty(globalThis, name, { value: ns, writable: true, enumerable: false, configurable: true });
        }
    }

    {
        const values = new WeakMap();
        const kinds = [["TrustedHTML", "createHTML"], ["TrustedScript", "createScript"], ["TrustedScriptURL", "createScriptURL"]];
        const ctors = {};
        for (const [name] of kinds) {
            const C = _iface(name);
            ctors[name] = C;
            _fn(C.prototype, "toJSON", 0, function () { return values.get(this); });
            _fn(C.prototype, "toString", 0, function () { return values.get(this); });
            _layout(C.prototype, ["toJSON", "toString", "constructor"]);
        }
        const wrap = (name, value) => {
            const o = _make(ctors[name]);
            values.set(o, value);
            return o;
        };
        const Policy = _iface("TrustedTypePolicy");
        const policies = new WeakMap();
        _acc(Policy.prototype, "name", function () { return policies.get(this).name; });
        for (const [name, method] of kinds) {
            _fn(Policy.prototype, method, 1, function (input, ...args) {
                const p = policies.get(this);
                const rule = p.rules[method];
                if (typeof rule !== "function") {
                    throw new TypeError(`${_exec(method, "TrustedTypePolicy")}: Policy ${p.name}'s TrustedTypePolicyOptions did not specify a '${method}' member.`);
                }
                const out = rule(`${input}`, ...args);
                return wrap(name, out === undefined || out === null ? "" : `${out}`);
            });
        }
        _layout(Policy.prototype, ["name", "createHTML", "createScript", "createScriptURL", "constructor"]);

        const Factory = _iface("TrustedTypePolicyFactory");
        let emptyHTML = null, emptyScript = null, defaultPolicy = null;
        const created = new Set();
        _acc(Factory.prototype, "emptyHTML", () => (emptyHTML ||= wrap("TrustedHTML", "")));
        _acc(Factory.prototype, "emptyScript", () => (emptyScript ||= wrap("TrustedScript", "")));
        _acc(Factory.prototype, "defaultPolicy", () => defaultPolicy);
        _fn(Factory.prototype, "createPolicy", 1, function (policyName, options) {
            const where = _exec("createPolicy", "TrustedTypePolicyFactory");
            _need(arguments, 1, where);
            const key = `${policyName}`;
            if (key === "default" && defaultPolicy) {
                throw new TypeError(`${where}: Policy "default" already exists.`);
            }
            const rules = options == null ? {} : options;
            const policy = _make(Policy);
            policies.set(policy, {
                name: key,
                rules: {
                    createHTML: rules.createHTML,
                    createScript: rules.createScript,
                    createScriptURL: rules.createScriptURL,
                },
            });
            created.add(key);
            if (key === "default") defaultPolicy = policy;
            return policy;
        });
        _fn(Factory.prototype, "getAttributeType", 2, function (tagName, attribute) {
            _need(arguments, 2, _exec("getAttributeType", "TrustedTypePolicyFactory"));
            const a = `${attribute}`.toLowerCase();
            if (a.startsWith("on")) return "TrustedScript";
            const t = `${tagName}`.toLowerCase();
            if ((t === "iframe" && a === "srcdoc")) return "TrustedHTML";
            if ((t === "script" && a === "src")) return "TrustedScriptURL";
            return null;
        });
        _fn(Factory.prototype, "getPropertyType", 2, function (tagName, property) {
            _need(arguments, 2, _exec("getPropertyType", "TrustedTypePolicyFactory"));
            const p = `${property}`;
            const t = `${tagName}`.toLowerCase();
            if (p === "innerHTML" || p === "outerHTML" || (t === "iframe" && p === "srcdoc")) return "TrustedHTML";
            if (t === "script" && (p === "innerText" || p === "textContent" || p === "text")) return "TrustedScript";
            if (t === "script" && p === "src") return "TrustedScriptURL";
            return null;
        });
        _fn(Factory.prototype, "getTypeMapping", 0, function () { return {}; });
        for (const [name] of kinds) {
            const method = name === "TrustedHTML" ? "isHTML" : name === "TrustedScript" ? "isScript" : "isScriptURL";
            _fn(Factory.prototype, method, 1, function (value) {
                const set = _brands.get(ctors[name].prototype);
                return !!set && (typeof value === "object" && value !== null) && set.has(value);
            });
        }
        _layout(Factory.prototype, ["emptyHTML", "emptyScript", "defaultPolicy", "createPolicy", "getAttributeType",
            "getPropertyType", "getTypeMapping", "isHTML", "isScript", "isScriptURL", "constructor"]);
    }

    {
        const subs = new WeakMap();
        const Sub = _iface("Subscriber");
        const state = (s) => subs.get(s);
        const teardown = (st) => {
            if (!st.active) return;
            st.active = false;
            st.controller.abort();
            const list = st.teardowns.splice(0).reverse();
            for (const t of list) {
                try { t(); } catch (e) { queueMicrotask(() => { throw e; }); }
            }
        };
        _acc(Sub.prototype, "active", function () { return state(this).active; });
        _acc(Sub.prototype, "signal", function () { return state(this).controller.signal; });
        _fn(Sub.prototype, "addTeardown", 1, function (fn) {
            const st = state(this);
            if (typeof fn !== "function") {
                throw new TypeError(`${_exec("addTeardown", "Subscriber")}: The callback provided as parameter 1 is not a function.`);
            }
            if (st.active) st.teardowns.push(fn);
            else fn();
        });
        _fn(Sub.prototype, "complete", 0, function () {
            const st = state(this);
            if (!st.active) return;
            const cb = st.observer.complete;
            teardown(st);
            if (typeof cb === "function") cb();
        });
        _fn(Sub.prototype, "error", 1, function (err) {
            const st = state(this);
            if (!st.active) {
                queueMicrotask(() => { throw err; });
                return;
            }
            const cb = st.observer.error;
            teardown(st);
            if (typeof cb === "function") cb(err);
            else queueMicrotask(() => { throw err; });
        });
        _fn(Sub.prototype, "next", 1, function (value) {
            const st = state(this);
            if (st.active && typeof st.observer.next === "function") st.observer.next(value);
        });
        _layout(Sub.prototype, ["active", "signal", "addTeardown", "complete", "error", "next", "constructor"]);

        const callbacks = new WeakMap();
        const toObserver = (o) => {
            if (typeof o === "function") return { next: o };
            if (o == null) return {};
            return { next: o.next, error: o.error, complete: o.complete };
        };
        const subscribe = (observable, observer, options) => {
            const st = { active: true, observer: toObserver(observer), teardowns: [], controller: new AbortController() };
            const s = _make(Sub);
            subs.set(s, st);
            const signal = options && options.signal;
            if (signal) {
                if (signal.aborted) {
                    teardown(st);
                    return;
                }
                signal.addEventListener("abort", () => teardown(st), { once: true });
            }
            try {
                callbacks.get(observable)(s);
            } catch (e) {
                s.error(e);
            }
        };
        let OC;
        const make = (fn) => new OC(fn);
        OC = function Observable(callback) {
            if (!new.target) {
                throw new TypeError("Failed to construct 'Observable': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
            }
            if (arguments.length < 1) {
                throw new TypeError("Failed to construct 'Observable': 1 argument required, but only 0 present.");
            }
            if (typeof callback !== "function") {
                throw new TypeError("Failed to construct 'Observable': parameter 1 is not of type 'Function'.");
            }
            callbacks.set(this, callback);
            let set = _brands.get(OC.prototype);
            if (!set) _brands.set(OC.prototype, (set = new WeakSet()));
            set.add(this);
        };
        Object.defineProperty(OC, "prototype", { writable: false });
        Object.defineProperty(OC.prototype, Symbol.toStringTag, { value: "Observable", configurable: true });
        _mask(OC, "Observable");
        const proto = OC.prototype;
        const fromIterable = (value) => make((s) => {
            try {
                for (const v of value) {
                    if (!s.active) break;
                    s.next(v);
                }
                s.complete();
            } catch (e) {
                s.error(e);
            }
        });
        const from = (value) => {
            if (value instanceof OC) return value;
            if (value != null && typeof value[Symbol.asyncIterator] === "function") {
                return make((s) => {
                    (async () => {
                        try {
                            for await (const v of value) {
                                if (!s.active) break;
                                s.next(v);
                            }
                            s.complete();
                        } catch (e) {
                            s.error(e);
                        }
                    })();
                });
            }
            if (value != null && typeof value[Symbol.iterator] === "function") return fromIterable(value);
            if (value != null && typeof value.then === "function") {
                return make((s) => {
                    Promise.resolve(value).then((v) => { s.next(v); s.complete(); }, (e) => s.error(e));
                });
            }
            throw new TypeError("Failed to execute 'from' on 'Observable': Cannot convert value to an Observable. Input value must be an Observable, async iterable, iterable, or Promise.");
        };
        Object.defineProperty(OC, "from", {
            value: _mask({ from(value) { return from(value); } }.from, "from"),
            writable: true, enumerable: true, configurable: true,
        });
        const op = (name, length, body) => _fn(proto, name, length, body);
        const promiseOp = (name, length, body) => _fnP(proto, name, length, body);
        const src = (o, s, observer) => subscribe(o, observer, { signal: s.signal });
        const both = (a, b) => (b ? (typeof AbortSignal.any === "function" ? AbortSignal.any([a, b]) : a) : a);
        op("catch", 1, function (cb) {
            const source = this;
            return make((s) => src(source, s, {
                next: (v) => s.next(v),
                error: (e) => {
                    let next;
                    try { next = from(cb(e)); } catch (err) { s.error(err); return; }
                    src(next, s, { next: (v) => s.next(v), error: (x) => s.error(x), complete: () => s.complete() });
                },
                complete: () => s.complete(),
            }));
        });
        op("drop", 1, function (amount) {
            const source = this;
            let n = +amount;
            return make((s) => src(source, s, {
                next: (v) => { if (n > 0) n--; else s.next(v); },
                error: (e) => s.error(e),
                complete: () => s.complete(),
            }));
        });
        promiseOp("every", 1, function (predicate, options) {
            const source = this;
            return new Promise((resolve, reject) => {
                const c = new AbortController();
                let i = 0;
                subscribe(source, {
                    next: (v) => {
                        let ok;
                        try { ok = predicate(v, i++); } catch (e) { reject(e); c.abort(); return; }
                        if (!ok) { resolve(false); c.abort(); }
                    },
                    error: reject,
                    complete: () => resolve(true),
                }, { signal: both(c.signal, options && options.signal) });
            });
        });
        op("filter", 1, function (predicate) {
            const source = this;
            return make((s) => {
                let i = 0;
                src(source, s, {
                    next: (v) => {
                        let ok;
                        try { ok = predicate(v, i++); } catch (e) { s.error(e); return; }
                        if (ok) s.next(v);
                    },
                    error: (e) => s.error(e),
                    complete: () => s.complete(),
                });
            });
        });
        op("finally", 1, function (cb) {
            const source = this;
            return make((s) => {
                s.addTeardown(() => cb());
                src(source, s, { next: (v) => s.next(v), error: (e) => s.error(e), complete: () => s.complete() });
            });
        });
        const reducer = (name, length, run) => promiseOp(name, length, function (...args) {
            const source = this;
            return new Promise((resolve, reject) => run(source, args, resolve, reject));
        });
        reducer("find", 1, (source, [predicate, options], resolve, reject) => {
            const c = new AbortController();
            let i = 0;
            subscribe(source, {
                next: (v) => {
                    let ok;
                    try { ok = predicate(v, i++); } catch (e) { reject(e); c.abort(); return; }
                    if (ok) { resolve(v); c.abort(); }
                },
                error: reject,
                complete: () => resolve(undefined),
            }, { signal: both(c.signal, options && options.signal) });
        });
        reducer("first", 0, (source, [options], resolve, reject) => {
            const c = new AbortController();
            subscribe(source, {
                next: (v) => { resolve(v); c.abort(); },
                error: reject,
                complete: () => reject(new RangeError("No values in Observable")),
            }, { signal: both(c.signal, options && options.signal) });
        });
        op("flatMap", 1, function (mapper) {
            const source = this;
            return make((s) => {
                const queue = [];
                let inner = false, outerDone = false, i = 0;
                const run = (v) => {
                    let next;
                    try { next = from(mapper(v, i++)); } catch (e) { s.error(e); return; }
                    inner = true;
                    src(next, s, {
                        next: (x) => s.next(x),
                        error: (e) => s.error(e),
                        complete: () => {
                            inner = false;
                            if (queue.length) run(queue.shift());
                            else if (outerDone) s.complete();
                        },
                    });
                };
                src(source, s, {
                    next: (v) => { if (inner) queue.push(v); else run(v); },
                    error: (e) => s.error(e),
                    complete: () => { outerDone = true; if (!inner && !queue.length) s.complete(); },
                });
            });
        });
        reducer("forEach", 1, (source, [cb, options], resolve, reject) => {
            const c = new AbortController();
            let i = 0;
            subscribe(source, {
                next: (v) => {
                    try { cb(v, i++); } catch (e) { reject(e); c.abort(); }
                },
                error: reject,
                complete: () => resolve(undefined),
            }, { signal: both(c.signal, options && options.signal) });
        });
        op("inspect", 0, function (callbacksOrNext) {
            const source = this;
            const cbs = typeof callbacksOrNext === "function" ? { next: callbacksOrNext } : (callbacksOrNext || {});
            return make((s) => {
                if (typeof cbs.subscribe === "function") cbs.subscribe();
                if (typeof cbs.abort === "function") s.signal.addEventListener("abort", () => cbs.abort(s.signal.reason), { once: true });
                src(source, s, {
                    next: (v) => { try { if (cbs.next) cbs.next(v); } catch (e) { s.error(e); return; } s.next(v); },
                    error: (e) => { try { if (cbs.error) cbs.error(e); } catch (x) { s.error(x); return; } s.error(e); },
                    complete: () => { try { if (cbs.complete) cbs.complete(); } catch (x) { s.error(x); return; } s.complete(); },
                });
            });
        });
        reducer("last", 0, (source, [options], resolve, reject) => {
            let has = false, last;
            subscribe(source, {
                next: (v) => { has = true; last = v; },
                error: reject,
                complete: () => (has ? resolve(last) : reject(new RangeError("No values in Observable"))),
            }, { signal: options && options.signal });
        });
        op("map", 1, function (mapper) {
            const source = this;
            return make((s) => {
                let i = 0;
                src(source, s, {
                    next: (v) => {
                        let out;
                        try { out = mapper(v, i++); } catch (e) { s.error(e); return; }
                        s.next(out);
                    },
                    error: (e) => s.error(e),
                    complete: () => s.complete(),
                });
            });
        });
        reducer("reduce", 1, (source, args, resolve, reject) => {
            const [fn] = args;
            let acc = args[1], has = args.length > 1, i = 0;
            subscribe(source, {
                next: (v) => {
                    if (!has) { acc = v; has = true; i++; return; }
                    try { acc = fn(acc, v, i++); } catch (e) { reject(e); }
                },
                error: reject,
                complete: () => (has ? resolve(acc) : reject(new TypeError("Reduce of empty Observable with no initial value"))),
            }, { signal: args[2] && args[2].signal });
        });
        reducer("some", 1, (source, [predicate, options], resolve, reject) => {
            const c = new AbortController();
            let i = 0;
            subscribe(source, {
                next: (v) => {
                    let ok;
                    try { ok = predicate(v, i++); } catch (e) { reject(e); c.abort(); return; }
                    if (ok) { resolve(true); c.abort(); }
                },
                error: reject,
                complete: () => resolve(false),
            }, { signal: both(c.signal, options && options.signal) });
        });
        op("subscribe", 0, function (observer, options) {
            subscribe(this, observer, options);
        });
        op("switchMap", 1, function (mapper) {
            const source = this;
            return make((s) => {
                let current = null, outerDone = false, i = 0;
                src(source, s, {
                    next: (v) => {
                        if (current) current.abort();
                        const c = new AbortController();
                        current = c;
                        let next;
                        try { next = from(mapper(v, i++)); } catch (e) { s.error(e); return; }
                        subscribe(next, {
                            next: (x) => s.next(x),
                            error: (e) => s.error(e),
                            complete: () => { if (current === c) current = null; if (outerDone && !current) s.complete(); },
                        }, { signal: both(s.signal, c.signal) });
                    },
                    error: (e) => s.error(e),
                    complete: () => { outerDone = true; if (!current) s.complete(); },
                });
            });
        });
        op("take", 1, function (amount) {
            const source = this;
            const total = +amount;
            return make((s) => {
                let left = total;
                if (left <= 0) {
                    s.complete();
                    return;
                }
                src(source, s, {
                    next: (v) => {
                        s.next(v);
                        if (--left <= 0) s.complete();
                    },
                    error: (e) => s.error(e),
                    complete: () => s.complete(),
                });
            });
        });
        op("takeUntil", 1, function (notifier) {
            const source = this;
            const stop = from(notifier);
            return make((s) => {
                src(stop, s, { next: () => s.complete(), error: (e) => s.error(e) });
                if (s.active) src(source, s, { next: (v) => s.next(v), error: (e) => s.error(e), complete: () => s.complete() });
            });
        });
        reducer("toArray", 0, (source, [options], resolve, reject) => {
            const out = [];
            subscribe(source, { next: (v) => out.push(v), error: reject, complete: () => resolve(out) },
                { signal: options && options.signal });
        });
        _layout(proto, ["catch", "drop", "every", "filter", "finally", "find", "first", "flatMap", "forEach", "inspect",
            "last", "map", "reduce", "some", "subscribe", "switchMap", "take", "takeUntil", "toArray", "constructor"]);
        Object.defineProperty(globalThis, "Observable", { value: OC, writable: true, enumerable: false, configurable: true });

        const ET = globalThis.EventTarget;
        if (typeof ET === "function") {
            const when = {
                when(type, options) {
                    const target = this;
                    if (target === null || (typeof target !== "object" && typeof target !== "function")) {
                        throw new TypeError("Illegal invocation");
                    }
                    if (arguments.length < 1) {
                        throw new TypeError(`${_exec("when", "EventTarget")}: 1 argument required, but only 0 present.`);
                    }
                    const eventType = `${type}`;
                    const opts = options == null ? {} : options;
                    return make((s) => {
                        target.addEventListener(eventType, (event) => {
                            if (opts.preventDefault && typeof event.preventDefault === "function") event.preventDefault();
                            s.next(event);
                        }, { capture: !!opts.capture, passive: opts.passive, signal: s.signal });
                    });
                },
            }.when;
            _mask(when, "when");
            Object.defineProperty(ET.prototype, "when", { value: when, writable: true, enumerable: true, configurable: true });
            const order = ["addEventListener", "dispatchEvent", "removeEventListener", "when", "constructor"];
            const saved = [];
            for (const k of order) {
                const d = Object.getOwnPropertyDescriptor(ET.prototype, k);
                if (d) saved.push([k, d]);
            }
            for (const [k] of saved) delete ET.prototype[k];
            for (const [k, d] of saved) Object.defineProperty(ET.prototype, k, d);
            const tag = Object.getOwnPropertyDescriptor(ET.prototype, Symbol.toStringTag);
            if (tag) {
                delete ET.prototype[Symbol.toStringTag];
                Object.defineProperty(ET.prototype, Symbol.toStringTag, tag);
            }
        }
    }

    {
        const C = _iface("Performance", "EventTarget");
        const P = C.prototype;
        const marks = [];
        const shared = (name, len, impl) => {
            if (!Object.prototype.hasOwnProperty.call(P, name)) {
                const f = { [name](...args) { return _apply(impl, this, args); } }[name];
                Object.defineProperty(f, "length", { value: len, configurable: true });
                _mask(f, name);
                Object.defineProperty(P, name, { value: f, writable: true, enumerable: true, configurable: true });
            }
        };
        const sharedGetter = (name, get, set) => {
            if (!Object.prototype.hasOwnProperty.call(P, name)) {
                const g = Object.getOwnPropertyDescriptor({ get [name]() { return _apply(get, this, []); } }, name).get;
                _mask(g, "get " + name);
                let s;
                if (set) {
                    s = Object.getOwnPropertyDescriptor({ set [name](v) { _apply(set, this, [v]); } }, name).set;
                    _mask(s, "set " + name);
                }
                Object.defineProperty(P, name, { get: g, set: s, enumerable: true, configurable: true });
            }
        };
        const now = () => {
            try { return ops.op_perf_now_humanized(); } catch (_) { return Date.now() - origin; }
        };
        const origin = Date.now();
        sharedGetter("timeOrigin", () => {
            try {
                const v = ops.op_perf_time_origin_ms && ops.op_perf_time_origin_ms();
                if (typeof v === "number" && isFinite(v) && v > 0) return v;
            } catch (_) {}
            return origin;
        });
        const bufferFull = new WeakMap();
        sharedGetter("onresourcetimingbufferfull", function () { return bufferFull.get(this) || null; },
            function (v) { bufferFull.set(this, (typeof v === "object" && v !== null) || typeof v === "function" ? v : null); });
        shared("clearMarks", 0, (name) => {
            for (let i = marks.length - 1; i >= 0; i--) {
                if (marks[i].entryType === "mark" && (name === undefined || marks[i].name === `${name}`)) marks.splice(i, 1);
            }
        });
        shared("clearMeasures", 0, (name) => {
            for (let i = marks.length - 1; i >= 0; i--) {
                if (marks[i].entryType === "measure" && (name === undefined || marks[i].name === `${name}`)) marks.splice(i, 1);
            }
        });
        shared("clearResourceTimings", 0, () => undefined);
        shared("getEntries", 0, () => marks.slice());
        shared("getEntriesByName", 1, (name, type) => marks.filter((e) => e.name === `${name}` && (type === undefined || e.entryType === `${type}`)));
        shared("getEntriesByType", 1, (type) => marks.filter((e) => e.entryType === `${type}`));
        shared("mark", 1, (name, options) => {
            const entry = {
                name: `${name}`, entryType: "mark",
                startTime: options && options.startTime !== undefined ? +options.startTime : now(),
                duration: 0, detail: options && options.detail !== undefined ? options.detail : null,
            };
            marks.push(entry);
            return entry;
        });
        shared("measure", 1, (name, startOrOptions, endMark) => {
            const at = (m) => {
                if (m === undefined) return undefined;
                if (typeof m === "number") return m;
                const found = marks.filter((e) => e.entryType === "mark" && e.name === `${m}`).pop();
                if (!found) {
                    throw _domError(`Failed to execute 'measure' on 'Performance': The mark '${m}' does not exist.`, "SyntaxError");
                }
                return found.startTime;
            };
            let start = 0, end = now();
            if (startOrOptions && typeof startOrOptions === "object") {
                start = at(startOrOptions.start) ?? 0;
                end = at(startOrOptions.end) ?? (startOrOptions.duration !== undefined ? start + +startOrOptions.duration : end);
            } else {
                start = at(startOrOptions) ?? 0;
                end = at(endMark) ?? end;
            }
            const entry = { name: `${name}`, entryType: "measure", startTime: start, duration: end - start, detail: null };
            marks.push(entry);
            return entry;
        });
        shared("setResourceTimingBufferSize", 1, () => undefined);
        shared("toJSON", 0, function () { return { timeOrigin: this.timeOrigin }; });
        shared("now", 0, () => now());
        Object.defineProperty(P, Symbol.toStringTag, { value: "Performance", configurable: true });
    }

    if (!_isWindow) {
        const C = _iface("FontFaceSet", "EventTarget");
        const faces = new WeakMap();
        const setOf = (o) => faces.get(o) || [];
        _handler(C.prototype, "onloading");
        _handler(C.prototype, "onloadingdone");
        _handler(C.prototype, "onloadingerror");
        _acc(C.prototype, "ready", function () { return Promise.resolve(this); });
        _acc(C.prototype, "status", () => "loaded");
        _acc(C.prototype, "size", function () { return setOf(this).length; });
        _fn(C.prototype, "check", 1, function (font) {
            _need(arguments, 1, _exec("check", "FontFaceSet"));
            if (!/\d\s*(px|pt|pc|in|cm|mm|q|em|rem|ex|ch|vh|vw|vmin|vmax|%)\s+\S/i.test(`${font}`)) {
                throw _domError(`${_exec("check", "FontFaceSet")}: Could not resolve '${font}' as a font.`, "SyntaxError");
            }
            return true;
        });
        _fnP(C.prototype, "load", 1, function (font) {
            _need(arguments, 1, _exec("load", "FontFaceSet"));
            return setOf(this).slice();
        });
        _fn(C.prototype, "add", 1, function (face) {
            let list = faces.get(this);
            if (!list) faces.set(this, (list = []));
            if (!list.includes(face)) list.push(face);
            return this;
        });
        _fn(C.prototype, "clear", 0, function () {
            const list = faces.get(this);
            if (list) list.length = 0;
        });
        _fn(C.prototype, "delete", 1, function (face) {
            const list = faces.get(this);
            if (!list) return false;
            const i = list.indexOf(face);
            if (i < 0) return false;
            list.splice(i, 1);
            return true;
        });
        _fn(C.prototype, "entries", 0, function () { return setOf(this).map((f) => [f, f])[Symbol.iterator](); });
        _fn(C.prototype, "forEach", 1, function (cb, thisArg) {
            for (const f of setOf(this)) _apply(cb, thisArg, [f, f, this]);
        });
        _fn(C.prototype, "has", 1, function (face) { return setOf(this).includes(face); });
        _fn(C.prototype, "keys", 0, function () { return setOf(this)[Symbol.iterator](); });
        _fn(C.prototype, "values", 0, function () { return setOf(this)[Symbol.iterator](); });
        Object.defineProperty(C.prototype, Symbol.iterator, { value: C.prototype.values, writable: true, configurable: true });
        _layout(C.prototype, ["onloading", "onloadingdone", "onloadingerror", "ready", "status", "size", "check", "load",
            "add", "clear", "delete", "entries", "forEach", "has", "keys", "values", "constructor"]);
    }

    const _idlState = _boNs && _boNs.idl;
    if (_isWindow) {
        const stubs = [
            ["CSSPseudoElement", null, ["type", "element", "parent"], [["pseudo", 1]]],
            ["HTMLCameraElement", "HTMLElement", ["error", "oncancel", "onerror", "ontrack", "track"], [["setConstraints", 0]]],
            ["HTMLUserMediaElement", "HTMLElement", ["error", "onstream", "oncancel", "onerror", "stream"], [["setConstraints", 0]]],
            ["HTMLMicrophoneElement", "HTMLElement", ["error", "oncancel", "onerror", "ontrack", "track"], [["setConstraints", 0]]],
            ["InteractionContentfulPaint", "PerformanceEntry", ["largestContentfulPaint", "interactionId", "paintTime", "presentationTime"], [["toJSON", 0]]],
            ["NodeRange", "AbstractRange", ["startContainer", "endContainer"], []],
            ["OpaqueRange", "AbstractRange", [], [["disconnect", 0], ["getBoundingClientRect", 0], ["getClientRects", 0]]],
            ["PerformanceSoftNavigation", "PerformanceEntry", ["navigationType", "interactionId", "paintTime", "presentationTime"], [["getLargestInteractionContentfulPaint", 0]]],
            ["PermissionsPolicy", null, [], [["allowedFeatures", 0], ["features", 0], ["allowsFeature", 1], ["getAllowlistForFeature", 1]]],
        ];
        for (const [name, parent, accessors, methods] of stubs) {
            const C = _iface(name, parent);
            const order = [];
            for (const member of accessors) {
                if (!Object.prototype.hasOwnProperty.call(C.prototype, member)) {
                    // Read through the shared IDL state so a real implementation
                    // further down the chain (Range, say) can back these.
                    _acc(C.prototype, member,
                        function () { return _idlState ? _idlState.read(this, member, null) : null; },
                        member.startsWith("on") ? () => undefined : undefined);
                }
                order[order.length] = member;
            }
            for (const [member, length] of methods) {
                if (!Object.prototype.hasOwnProperty.call(C.prototype, member)) {
                    _fn(C.prototype, member, length, () => (member.startsWith("get") ? [] : undefined));
                }
                order[order.length] = member;
            }
            order[order.length] = "constructor";
            _layout(C.prototype, order);
        }

        const named = [
            ["Image", "HTMLImageElement", "img", 0],
            ["Audio", "HTMLAudioElement", "audio", 0],
            ["Option", "HTMLOptionElement", "option", 0],
        ];
        for (const [name, element, tag, length] of named) {
            const Element = globalThis[element];
            if (typeof Element !== "function" || !Element.prototype) continue;
            const C = {
                [name]: function (a, b, c, d) {
                    if (!new.target) {
                        throw new TypeError(`Failed to construct '${name}': Please use the 'new' operator, this DOM object constructor cannot be called as a function.`);
                    }
                    const node = globalThis.document.createElement(tag);
                    if (name === "Image") {
                        if (a !== undefined) node.setAttribute("width", `${a}`);
                        if (b !== undefined) node.setAttribute("height", `${b}`);
                    } else if (name === "Audio") {
                        if (a !== undefined) {
                            node.setAttribute("src", `${a}`);
                            node.setAttribute("preload", "auto");
                        }
                    } else {
                        if (a !== undefined) node.textContent = `${a}`;
                        if (b !== undefined) node.setAttribute("value", `${b}`);
                        if (c) node.setAttribute("selected", "");
                        if (d !== undefined) node.selected = !!d;
                    }
                    return node;
                },
            }[name];
            Object.defineProperty(C, "length", { value: length, configurable: true });
            Object.defineProperty(C, "prototype", { value: Element.prototype, writable: false, enumerable: false, configurable: false });
            _mask(C, name);
            Object.defineProperty(globalThis, name, { value: C, writable: true, enumerable: false, configurable: true });
        }

        {
            const filter = { NodeFilter() { throw new TypeError("Illegal constructor"); } }.NodeFilter;
            delete filter.prototype;
            Object.defineProperty(filter, "length", { value: 0, configurable: true });
            _mask(filter, "NodeFilter");
            for (const [key, value] of [["FILTER_ACCEPT", 1], ["FILTER_REJECT", 2], ["FILTER_SKIP", 3],
                ["SHOW_ALL", 4294967295], ["SHOW_ELEMENT", 1], ["SHOW_ATTRIBUTE", 2], ["SHOW_TEXT", 4],
                ["SHOW_CDATA_SECTION", 8], ["SHOW_ENTITY_REFERENCE", 16], ["SHOW_ENTITY", 32],
                ["SHOW_PROCESSING_INSTRUCTION", 64], ["SHOW_COMMENT", 128], ["SHOW_DOCUMENT", 256],
                ["SHOW_DOCUMENT_TYPE", 512], ["SHOW_DOCUMENT_FRAGMENT", 1024], ["SHOW_NOTATION", 2048]]) {
                Object.defineProperty(filter, key, { value, writable: false, enumerable: true, configurable: false });
            }
            Object.defineProperty(globalThis, "NodeFilter", { value: filter, writable: true, enumerable: false, configurable: true });
        }

        {
            const Unit = _iface("CSSUnitValue", "CSSNumericValue");
            const data = new WeakMap();
            if (!Object.prototype.hasOwnProperty.call(Unit.prototype, "value")) {
                _acc(Unit.prototype, "value", function () { return data.get(this).value; },
                    function (v) { data.get(this).value = +v; });
                _acc(Unit.prototype, "unit", function () { return data.get(this).unit; });
                const Styled = _iface("CSSStyleValue", null);
                if (!Object.prototype.hasOwnProperty.call(Styled.prototype, "toString")) {
                    _fn(Styled.prototype, "toString", 0, function () {
                        const d = data.get(this);
                        if (!d) return "";
                        return d.unit === "number" ? `${d.value}` : (d.unit === "percent" ? `${d.value}%` : `${d.value}${d.unit}`);
                    });
                }
                _layout(Unit.prototype, ["value", "unit", "constructor"]);
            }
            const unit = (value, name) => {
                const o = _make(Unit);
                data.set(o, { value: +value, unit: name });
                return o;
            };
            const units = ["number", "percent", "em", "ex", "ch", "ic", "rem", "rex", "rch", "ric", "lh", "rlh",
                "vw", "vh", "vi", "vb", "vmin", "vmax", "svw", "svh", "svi", "svb", "svmin", "svmax",
                "lvw", "lvh", "lvi", "lvb", "lvmin", "lvmax", "dvw", "dvh", "dvi", "dvb", "dvmin", "dvmax",
                "cqw", "cqh", "cqi", "cqb", "cqmin", "cqmax", "cm", "mm", "Q", "in", "pt", "pc", "px",
                "deg", "grad", "rad", "turn", "s", "ms", "Hz", "kHz", "dpi", "dpcm", "dppx", "x", "fr", "cap", "rcap"];
            const CSS = globalThis.CSS && typeof globalThis.CSS === "object" ? globalThis.CSS : {};
            for (const name of units) {
                if (typeof CSS[name] === "function") continue;
                const f = { [name](value) { return unit(value, name === "percent" ? "percent" : name); } }[name];
                Object.defineProperty(f, "length", { value: 1, configurable: true });
                _mask(f, name);
                Object.defineProperty(CSS, name, { value: f, writable: true, enumerable: true, configurable: true });
            }
            if (typeof CSS.registerProperty !== "function") {
                const f = { registerProperty(definition) {
                    if (definition == null || typeof definition !== "object") {
                        throw new TypeError(`${_exec("registerProperty", "CSS")}: The provided value is not of type 'PropertyDefinition'.`);
                    }
                } }.registerProperty;
                Object.defineProperty(f, "length", { value: 1, configurable: true });
                _mask(f, "registerProperty");
                Object.defineProperty(CSS, "registerProperty", { value: f, writable: true, enumerable: true, configurable: true });
            }
            if (!Object.prototype.hasOwnProperty.call(CSS, "highlights")) {
                const registry = typeof globalThis.HighlightRegistry === "function" ? _make(globalThis.HighlightRegistry) : new Map();
                Object.defineProperty(CSS, "highlights", {
                    get: _mask(Object.getOwnPropertyDescriptor({ get highlights() { return registry; } }, "highlights").get, "get highlights"),
                    enumerable: true, configurable: true,
                });
            }
            if (!Object.prototype.hasOwnProperty.call(CSS, "paintWorklet") && typeof globalThis.Worklet === "function") {
                const worklet = _make(globalThis.Worklet);
                Object.defineProperty(CSS, "paintWorklet", {
                    get: _mask(Object.getOwnPropertyDescriptor({ get paintWorklet() { return worklet; } }, "paintWorklet").get, "get paintWorklet"),
                    enumerable: true, configurable: true,
                });
            }
            Object.defineProperty(CSS, Symbol.toStringTag, { value: "CSS", configurable: true });
            Object.defineProperty(globalThis, "CSS", { value: CSS, writable: true, enumerable: false, configurable: true });
        }

        if (!Object.prototype.hasOwnProperty.call(globalThis, "offscreenBuffering")) {
            let buffering = true;
            Object.defineProperty(globalThis, "offscreenBuffering", {
                get: _mask(Object.getOwnPropertyDescriptor({ get offscreenBuffering() { return buffering; } }, "offscreenBuffering").get, "get offscreenBuffering"),
                set: _mask(Object.getOwnPropertyDescriptor({ set offscreenBuffering(v) { buffering = v; } }, "offscreenBuffering").set, "set offscreenBuffering"),
                enumerable: false, configurable: true,
            });
        }
    }

    if (_boNs) {
        _boNs.services = {
            make: _make,
            iface: _iface,
            permissionState: _permissionState,
            layout: _layout,
            acc: _acc,
            fn: _fn,
            fnP: _fnP,
            handler: _handler,
            exec: _exec,
            domError: _domError,
            need: _need,
        };
    }
})(globalThis);
