((globalThis) => {
    const _boNs = (() => {
        try {
            const syms = Object.getOwnPropertySymbols(globalThis, 1);
            for (let i = 0; i < syms.length; i++) {
                const v = globalThis[syms[i]];
                if (v && v.__bo) return v;
            }
        } catch (_e) {}
        return null;
    })();
    const _idl = (_boNs && _boNs.idl) || {
        own: (obj) => obj,
        read: () => undefined,
        fields: () => {},
    };
    const ops = Deno.core.ops;
    const _browser_oxide = {
        __documentReadyState: "loading",
        __pendingNavigation: null,
        __perfResourceEntries: [],
        __fetchLog: [],
        __cspViolations: [],
        __drainCspViolations: () => {
            const v = [..._browser_oxide.__cspViolations];
            _browser_oxide.__cspViolations = [];
            return v;
        }
    };
    Object.defineProperty(globalThis, '_browser_oxide', { value: _browser_oxide, configurable: true, enumerable: false, writable: true });

    if (globalThis.WebAssembly) {
        // Streaming stubs
        WebAssembly.instantiateStreaming = async function(source, importObject) {
            const resp = await source;
            const bytes = await resp.arrayBuffer();
            return WebAssembly.instantiate(bytes, importObject);
        };
        WebAssembly.compileStreaming = async function(source) {
            const resp = await source;
            const bytes = await resp.arrayBuffer();
            return WebAssembly.compile(bytes);
        };
    }

    // Masking helpers are provided by stealth_bootstrap.js
    const _maskFunction = globalThis._maskFunction;
    const _maskAsNative = globalThis._maskAsNative;

    // ── Faithful global `Window` interface.
    // Real Chrome 147: typeof Window==="function",
    // window.constructor.name==="Window", window instanceof Window,
    // window instanceof EventTarget, chain
    //   window → Window.prototype → EventTarget.prototype → Object.prototype.
    // Our engine had NO global Window → fails the most universal
    // real-browser invariant (commonly checked) and starved
    // _buildRemoteRealm so iframe contentWindow.constructor was "Object".
    (function () {
        if (typeof globalThis.Window === "function") return;
        const _ET = globalThis.EventTarget;
        function Window() {
            throw new TypeError("Illegal constructor");
        }
        try {
            const _globalProto = Object.getPrototypeOf(globalThis);
            if (typeof _ET === "function") Object.setPrototypeOf(Window, _ET);
            if (_globalProto && _globalProto !== Object.prototype) {
                Window.prototype = _globalProto;
            } else if (typeof _ET === "function") {
                Window.prototype = Object.create(_ET.prototype);
            } else {
                Window.prototype = Object.create(Object.prototype);
            }
            Object.defineProperty(Window.prototype, "constructor", {
                value: Window, writable: true, enumerable: false, configurable: true,
            });
            Object.defineProperty(Window, "name", { value: "Window", configurable: true });
            Object.defineProperty(Window, "prototype", {
                value: Window.prototype, writable: false, enumerable: false, configurable: false,
            });
            Object.defineProperty(Window.prototype, Symbol.toStringTag, {
                value: "Window", configurable: true,
            });
            if (typeof _maskFunction === "function") _maskFunction(Window, "Window");
            globalThis.Window = Window;
            // NOTE: do NOT Object.setPrototypeOf(globalThis, Window.prototype)
            // here — deno_core's V8 global object is special; swapping its
            // [[Prototype]] breaks `ops`/secure-context resolution
            // (regressed Notification.permission default→denied,
            // chrome147_parity). The global's existing prototype object IS
            // adopted as `Window.prototype` above instead, and
            // event_bootstrap.js links it to EventTarget through a
            // WindowProperties object, which gives the Chrome chain without
            // touching the global itself.
        } catch (_) {}
    })();

    // --- Global self-references (window, self, top, parent, frames) ---
    // Chrome alignment — handled by Deno defaults for now to avoid snapshot conflicts.

    // Helper: read from stealth profile or use default
    const _p = (key, fallback) => {
        if (ops.op_has_stealth_profile()) {
            const v = ops.op_get_profile_value(key);
            return v !== "" ? v : fallback;
        }
        return fallback;
    };

    // Helper: is the document a secure context? Drives the IDL
    // `[SecureContext]` extended attribute — gates the ~18 modern
    // Web Platform APIs (mediaDevices, serviceWorker, clipboard,
    // credentials, usb, etc.) so they're undefined on
    // about:blank/data:/http: but defined on https:/wss:/file:/
    // http://localhost. Phase 7 fix.
    const _secure = () => ops.op_is_secure_context();
    const _pInt = (key, fallback) => {
        const v = _p(key, "");
        return v !== "" ? parseInt(v, 10) : fallback;
    };
    const _pFloat = (key, fallback) => {
        const v = _p(key, "");
        return v !== "" ? parseFloat(v) : fallback;
    };
    const _pJson = (key, fallback) => {
        const v = _p(key, "");
        if (v !== "") try { return JSON.parse(v); } catch {}
        return fallback;
    };
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

    // iOS surface gating. Real iOS Safari has no UA-Client-Hints,
    // no `chrome` global, and no NetworkInformation / UserActivation /
    // deviceMemory / scheduling / IdleDetector / getInstalledRelatedApps.
    // A script checking `('chrome' in window) || ('userActivation' in
    // navigator) || ('deviceMemory' in navigator) || ('connection' in
    // navigator)` against an iOS UA would flag any positive hit as
    // inconsistent. These are Chrome-family APIs that must not appear on
    // the iPhone 15 Pro Safari profile.
    const _isMobileIOS = () => _p("device_class", "Desktop") === "MobileIOS";

    // Firefox/Gecko coherence. Under a firefox_135_* preset the JS surface
    // must NOT expose Chrome-family APIs (window.chrome, navigator.userAgentData,
    // navigator.deviceMemory) — their mere presence under a `Firefox/` UA is a
    // 100% impersonation tell that bot-detection sensors score. It must instead
    // expose the Gecko-only surface (navigator.oscpu, buildID, mozInnerScreen*).
    const _isFirefox = () => /Firefox\//.test(_p("user_agent", ""));
    // navigator.oscpu (Gecko-only): the platform token from the UA parenthetical
    // with the `; rv:NNN` suffix and a leading `Macintosh; ` stripped — e.g.
    // "Intel Mac OS X 14.5", "Windows NT 10.0; Win64; x64", "Linux x86_64".
    const _firefoxOscpu = () => {
        const ua = _p("user_agent", "");
        const m = ua.match(/\(([^)]*)\)/);
        if (!m) return "";
        return m[1].replace(/;?\s*rv:[0-9.]+\s*/, "").replace(/^Macintosh;\s*/, "").trim();
    };

    // ================================================================
    // Prototype-install helpers — kNoScriptId-safe layout
    // ================================================================
    const _defProtoGetter = (proto, name, getter, setter) => {
        Object.defineProperty(proto, name, {
            get: getter,
            set: setter,
            // Enumerable: a WebIDL attribute on an interface prototype is, and
            // `Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent')`
            // is among the handful of descriptors a bot check actually reads.
            enumerable: true,
            configurable: true,
        });
        _maskFunction(getter, `get ${name}`);
        if (setter) _maskFunction(setter, `set ${name}`);
    };
    const _defProtoMethod = (proto, name, fn) => {
        // WebIDL methods are NOT constructors. Using object literal
        // method shorthand ensures the function lacks a [[Construct]]
        // internal slot. Preserve fn.length so Function.prototype.length
        // reflection matches real Chrome's WebIDL method arity (e.g.
        // addEventListener=1, getUserMedia=1, enumerateDevices=0).
        const wrapped = ({ [name](...args) { return fn.apply(this, args); } })[name];
        try {
            Object.defineProperty(wrapped, 'length', { value: fn.length, configurable: true });
        } catch (_) {}
        Object.defineProperty(proto, name, {
            value: wrapped, writable: true, enumerable: true, configurable: true,
        });
        _maskFunction(wrapped, name);
    };

    // ================================================================
    // Navigator class + prototype — kNoScriptId-safe layout
    // ================================================================
    const _NavProto = globalThis.Navigator.prototype;
    // Navigator's attributes reject a foreign receiver, as every platform
    // object's do: `Object.getOwnPropertyDescriptor(Navigator.prototype,
    // 'userAgent').get.call({})` throws `TypeError: Illegal invocation` in a
    // browser. Ours returned a value for any `this`, and that is the check
    // fingerprinters run to decide a property has been redefined — creepjs
    // records it as a lie against `Navigator.webdriver` specifically, which then
    // counts as "webdriver is on" no matter what the property actually says.
    //
    // Only the receiver is checked; the getters themselves ignore `this`.
    //
    // Method shorthand, not a function expression: the latter carries a
    // `prototype` and is constructible, neither of which a native getter is —
    // wrapping every accessor in one would trade this tell for a worse one.
    const _navBrand = (getter) => ({
        get() {
            if (!(this instanceof Navigator)) {
                throw new TypeError("Illegal invocation");
            }
            return getter.call(this);
        },
    }).get;
    // Closure slots, not globals. Every symbol left on `globalThis` is one more
    // entry `Object.getOwnPropertySymbols(window)` reports, and Chrome's window
    // has none at all — a service slot the engine talks to itself through has no
    // business being visible to the page.
    let _syncFrameIndicesRef = null;
    let _currentDispatchedEvent;

    const _defNav = (name, getter) =>
        _defProtoGetter(_NavProto, name, _navBrand(getter));
    const _defNavMethod = (name, fn) => _defProtoMethod(_NavProto, name, fn);

    // Stable-object references — object getters return the same reference
    // on every call, matching the behavior of real DOM-wrapped properties.
    const _navConnection = _svc.make(globalThis.NetworkInformation);

    let PluginArray = globalThis.PluginArray || class PluginArray {};
    let MimeTypeArray = globalThis.MimeTypeArray || class MimeTypeArray {};
    let Plugin = globalThis.Plugin || class Plugin {};
    let MimeType = globalThis.MimeType || class MimeType {};

    // 1. Setup Plugin.prototype
    const _PluginProto = Plugin.prototype;
    Object.defineProperty(_PluginProto, Symbol.toStringTag, { value: "Plugin", enumerable: false, configurable: true });
    _defProtoGetter(_PluginProto, 'name', function() { return _idl.own(this)._name || ""; });
    _defProtoGetter(_PluginProto, 'description', function() { return _idl.own(this)._desc || ""; });
    _defProtoGetter(_PluginProto, 'filename', function() { return _idl.own(this)._file || ""; });
    _defProtoGetter(_PluginProto, 'length', function() { return 0; });
    _defProtoMethod(_PluginProto, 'item', function item() { return null; });
    _defProtoMethod(_PluginProto, 'namedItem', function namedItem() { return null; });

    // Setup MimeType.prototype
    const _MimeTypeProto = MimeType.prototype;
    Object.defineProperty(_MimeTypeProto, Symbol.toStringTag, { value: "MimeType", enumerable: false, configurable: true });
    _defProtoGetter(_MimeTypeProto, 'type', function() { return _idl.own(this)._type || ""; });
    _defProtoGetter(_MimeTypeProto, 'description', function() { return _idl.own(this)._desc || ""; });
    _defProtoGetter(_MimeTypeProto, 'suffixes', function() { return _idl.own(this)._suffixes || ""; });
    _defProtoGetter(_MimeTypeProto, 'enabledPlugin', function() { return _idl.own(this)._plugin || null; });

    // The values live in the engine's IDL state, not on the object: a real
    // Chrome Plugin/MimeType has no own properties at all, and everything a
    // page can read comes off the prototype accessors above.
    const _makePlugin = (name, desc, file) => {
        const p = Object.create(_PluginProto);
        const st = _idl.own(p);
        st._name = name;
        st._desc = desc;
        st._file = file;
        st._mimeTypes = [];
        return p;
    };
    const _makeMime = (type, suffixes, desc, plugin) => {
        const m = Object.create(_MimeTypeProto);
        const st = _idl.own(m);
        st._type = type;
        st._suffixes = suffixes;
        st._desc = desc;
        st._plugin = plugin;
        return m;
    };

    // Canonical Chrome 133 plugin set. All real Chrome 133 browsers ship
    // exactly these 5 plugins + 2 mime types; the profile fields
    // plugins_count / mime_types_count let a profile CLAIM a subset.
    //
    // IMPORTANT: the bootstrap runs at V8-snapshot-build time with NO
    // stealth profile installed, so any eager `_pInt` read here captures
    // the default (5/2) into the snapshot. Count resolution MUST happen
    // lazily via getters so each runtime navigator.plugins.length call
    // reads the live profile.
    const _PDF_DESC = "Portable Document Format";
    const _PDF_FILE = "internal-pdf-viewer";
    const _allPlugins = [
        _makePlugin("PDF Viewer", _PDF_DESC, _PDF_FILE),
        _makePlugin("Chrome PDF Viewer", _PDF_DESC, _PDF_FILE),
        _makePlugin("Chromium PDF Viewer", _PDF_DESC, _PDF_FILE),
        _makePlugin("Microsoft Edge PDF Viewer", _PDF_DESC, _PDF_FILE),
        _makePlugin("WebKit built-in PDF", _PDF_DESC, _PDF_FILE),
    ];
    const _allMimes = [
        _makeMime("application/pdf", "pdf", _PDF_DESC, _allPlugins[0]),
        _makeMime("text/pdf", "pdf", _PDF_DESC, _allPlugins[0]),
    ];
    // Cross-link: each plugin reports the same mime type list per Chrome.
    _allPlugins.forEach(p => { _idl.own(p)._mimeTypes = _allMimes; });

    // Runtime count resolvers — clamped to physical array size so a probe
    // that walks plugins[i] for i<length never hits undefined.
    //
    // Memoized on first call so repeated probes (some fingerprint scripts
    // spread `[...navigator.plugins]` for every WebIDL
    // member they audit) hit a cached number instead of re-reading the
    // profile and re-computing the clamp on each numeric-index getter.
    // The first call still happens at runtime — by which time the profile
    // IS installed (we cannot eager-cache here because window_bootstrap.js
    // is evaluated at snapshot build-time without a profile).
    let _pluginsLenCache = -1;
    const _pluginsLen = () => {
        if (_pluginsLenCache < 0) {
            _pluginsLenCache = Math.max(0, Math.min(_allPlugins.length, _pInt("plugins_count", _allPlugins.length)));
        }
        return _pluginsLenCache;
    };
    let _mimesLenCache = -1;
    const _mimesLen = () => {
        if (_mimesLenCache < 0) {
            _mimesLenCache = Math.max(0, Math.min(_allMimes.length, _pInt("mime_types_count", _allMimes.length)));
        }
        return _mimesLenCache;
    };

    // 2. Setup PluginArray.prototype — length + item() dispatch via live count.
    const _PluginArrayProto = PluginArray.prototype;
    Object.defineProperty(_PluginArrayProto, Symbol.toStringTag, { value: "PluginArray", enumerable: false, configurable: true });
    Object.defineProperty(_PluginArrayProto, 'length', { get: () => _pluginsLen(), enumerable: false, configurable: true });
    _defProtoMethod(_PluginArrayProto, 'item', function item(i) {
        const n = _pluginsLen();
        return (i >= 0 && i < n) ? _allPlugins[i] : null;
    });
    _defProtoMethod(_PluginArrayProto, 'namedItem', function namedItem(n) {
        const len = _pluginsLen();
        for (let i = 0; i < len; i++) if (_allPlugins[i].name === n) return _allPlugins[i];
        return null;
    });

    _defProtoMethod(_PluginArrayProto, 'refresh', () => {});
    // Symbol.iterator iterates the live sliced range.
    Object.defineProperty(_PluginArrayProto, Symbol.iterator, {
        value: function iter() {
            const n = _pluginsLen();
            let i = 0;
            const self = this;
            return {
                next() {
                    if (i < n) return { value: self[i++], done: false };
                    return { value: undefined, done: true };
                },
                [Symbol.iterator]() { return this; }
            };
        },
        configurable: true,
    });

    // Setup MimeTypeArray.prototype — same pattern.
    const _MimeTypeArrayProto = MimeTypeArray.prototype;
    Object.defineProperty(_MimeTypeArrayProto, Symbol.toStringTag, { value: "MimeTypeArray", enumerable: false, configurable: true });
    Object.defineProperty(_MimeTypeArrayProto, 'length', { get: () => _mimesLen(), enumerable: false, configurable: true });
    _defProtoMethod(_MimeTypeArrayProto, 'item', function item(i) {
        const n = _mimesLen();
        return (i >= 0 && i < n) ? _allMimes[i] : null;
    });
    _defProtoMethod(_MimeTypeArrayProto, 'namedItem', function namedItem(n) {
        const len = _mimesLen();
        for (let i = 0; i < len; i++) if (_allMimes[i].type === n) return _allMimes[i];
        return null;
    });
    Object.defineProperty(_MimeTypeArrayProto, Symbol.iterator, {
        value: function iter() {
            const n = _mimesLen();
            let i = 0;
            const self = this;
            return {
                next() {
                    if (i < n) return { value: self[i++], done: false };
                    return { value: undefined, done: true };
                },
                [Symbol.iterator]() { return this; }
            };
        },
        configurable: true,
    });

    // Instance: install index accessors that gate on live count.
    const _navPlugins = Object.create(_PluginArrayProto);
    _allPlugins.forEach((p, i) => {
        Object.defineProperty(_navPlugins, i, {
            get: () => (i < _pluginsLen() ? p : undefined),
            enumerable: true,
            configurable: true,
        });
        // Named getter for plugin name
        Object.defineProperty(_navPlugins, p.name, {
            get: () => (i < _pluginsLen() ? p : undefined),
            enumerable: false,
            configurable: true,
        });
    });

    // Plugin instance behaves like a MimeTypeArray over its mime types.
    _allPlugins.forEach(p => {
        Object.defineProperty(p, 'length', { get: () => _mimesLen(), enumerable: false, configurable: true });
        _idl.own(p)._mimeTypes.forEach((m, i) => {
             Object.defineProperty(p, i, {
                get: () => (i < _mimesLen() ? m : undefined),
                enumerable: true,
                configurable: true,
            });
            Object.defineProperty(p, m.type, {
                get: () => (i < _mimesLen() ? m : undefined),
                enumerable: false,
                configurable: true,
            });
        });
        Object.defineProperty(p, 'item', {
            value: function item(i) {
                const n = _mimesLen();
                return (i >= 0 && i < n) ? _idl.own(p)._mimeTypes[i] : null;
            },
            enumerable: false, configurable: true,
        });
        Object.defineProperty(p, 'namedItem', {
            value: function namedItem(n) {
                const len = _mimesLen();
                for (let i = 0; i < len; i++) if (_idl.own(p)._mimeTypes[i].type === n) return _idl.own(p)._mimeTypes[i];
                return null;
            },
            enumerable: false, configurable: true,
        });
        // Mask the per-instance item/namedItem so toString returns
        // `function NAME() { [native code] }` instead of leaking source,
        // which a script inspecting these methods would otherwise see.
        try { _maskAsNative(p, 'item', 'namedItem'); } catch (_) {}
    });

    const _navMimeTypes = Object.create(_MimeTypeArrayProto);
    _allMimes.forEach((m, i) => {
        Object.defineProperty(_navMimeTypes, i, {
            get: () => (i < _mimesLen() ? m : undefined),
            enumerable: true,
            configurable: true,
        });
        // Named getter for mime type
        Object.defineProperty(_navMimeTypes, m.type, {
            get: () => (i < _mimesLen() ? m : undefined),
            enumerable: false,
            configurable: true,
        });
    });

    let MediaDevices = globalThis.MediaDevices || class MediaDevices {};
    const _navMediaDevices = Object.create(MediaDevices.prototype);
    // enumerateDevices: apply the two spec behaviors real Chrome does and we
    // previously missed:
    //   (1) WebIDL camelCase on output (deviceId / groupId — NOT snake_case).
    //       The profile ships snake_case; we transform here.
    //   (2) label === "" until the corresponding permission is GRANTED
    //       (audioinput/audiooutput → microphone; videoinput → camera).
    //       Leaking populated labels pre-permission is a classic automation
    //       tell. §6.6 item 9 / item 7.
    _navMediaDevices.enumerateDevices = ({
        enumerateDevices() {
            const raw = _pJson("media_devices", []);
            const permFor = (kind) => {
                if (kind === "videoinput") return _svc.permissionState("camera");
                if (kind === "audioinput" || kind === "audiooutput") return _svc.permissionState("microphone");
                return "granted"; // unknown kinds — don't blank
            };
            const out = raw.map((d) => {
                const granted = permFor(d.kind) === "granted";
                const deviceId = granted ? (d.deviceId != null ? d.deviceId : (d.device_id || "")) : "";
                const groupId = granted ? (d.groupId != null ? d.groupId : (d.group_id || "")) : "";
                const label = granted ? (d.label || "") : "";
                return { deviceId, kind: d.kind || "", label, groupId };
            });
            return Promise.resolve(out);
        }
    }).enumerateDevices;
    _maskFunction(_navMediaDevices.enumerateDevices, 'enumerateDevices');

    _navMediaDevices.getUserMedia = ({ getUserMedia() { return Promise.reject(new Error("Permission denied")); } }).getUserMedia;
    _maskFunction(_navMediaDevices.getUserMedia, 'getUserMedia');

    _navMediaDevices.getDisplayMedia = ({ getDisplayMedia() { return Promise.reject(new Error("Permission denied")); } }).getDisplayMedia;
    _maskFunction(_navMediaDevices.getDisplayMedia, 'getDisplayMedia');

    _navMediaDevices.getSupportedConstraints = ({
        getSupportedConstraints() {
            return { aspectRatio: true, autoGainControl: true, brightness: true, channelCount: true, colorTemperature: true, contrast: true, deviceId: true, displaySurface: true, echoCancellation: true, exposureCompensation: true, exposureMode: true, exposureTime: true, facingMode: true, focusDistance: true, focusMode: true, frameRate: true, groupId: true, height: true, iso: true, latency: true, noiseSuppression: true, pan: true, pointsOfInterest: true, resizeMode: true, sampleRate: true, sampleSize: true, saturation: true, sharpness: true, suppressLocalAudioPlayback: true, tilt: true, torch: true, whiteBalanceMode: true, width: true, zoom: true };
        }
    }).getSupportedConstraints;
    _maskFunction(_navMediaDevices.getSupportedConstraints, 'getSupportedConstraints');

    _navMediaDevices.addEventListener = ({ addEventListener() {} }).addEventListener;
    _maskFunction(_navMediaDevices.addEventListener, 'addEventListener');

    _navMediaDevices.removeEventListener = ({ removeEventListener() {} }).removeEventListener;
    _maskFunction(_navMediaDevices.removeEventListener, 'removeEventListener');

    _navMediaDevices.dispatchEvent = ({ dispatchEvent() { return true; } }).dispatchEvent;
    _maskFunction(_navMediaDevices.dispatchEvent, 'dispatchEvent');

    const _navPermissions = _svc.make(globalThis.Permissions);

    // ================================================================
    // WebAuthn + FedCM (detection-shape only)
    // ----------------------------------------------------------------
    // Some scripts probe:
    //   typeof window.PublicKeyCredential
    //   PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
    //   PublicKeyCredential.isConditionalMediationAvailable()
    //   PublicKeyCredential.getClientCapabilities()  (Chrome 133+)
    //   navigator.credentials.create({publicKey:...}) — must reject as
    //     NotAllowedError after a realistic delay (not synchronous TypeError)
    //   navigator.credentials.get({identity:...}) — FedCM branch
    //   typeof IdentityCredential, typeof IdentityProvider
    // No real authenticator is implemented — this is a shape stub. Profile
    // fields has_platform_authenticator and conditional_mediation drive the
    // resolved values.
    // ================================================================

    class AuthenticatorResponse {}
    Object.defineProperty(AuthenticatorResponse.prototype, Symbol.toStringTag,
        { value: "AuthenticatorResponse", configurable: true });
    class AuthenticatorAttestationResponse extends AuthenticatorResponse {}
    Object.defineProperty(AuthenticatorAttestationResponse.prototype, Symbol.toStringTag,
        { value: "AuthenticatorAttestationResponse", configurable: true });
    class AuthenticatorAssertionResponse extends AuthenticatorResponse {}
    Object.defineProperty(AuthenticatorAssertionResponse.prototype, Symbol.toStringTag,
        { value: "AuthenticatorAssertionResponse", configurable: true });
    globalThis.AuthenticatorResponse = AuthenticatorResponse;
    globalThis.AuthenticatorAttestationResponse = AuthenticatorAttestationResponse;
    globalThis.AuthenticatorAssertionResponse = AuthenticatorAssertionResponse;

    class PublicKeyCredential {
        constructor() { throw new TypeError("Illegal constructor"); }
    }
    Object.defineProperty(PublicKeyCredential.prototype, Symbol.toStringTag,
        { value: "PublicKeyCredential", configurable: true });
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = ({
        isUserVerifyingPlatformAuthenticatorAvailable() {
            return Promise.resolve(_p("has_platform_authenticator", "false") === "true");
        }
    }).isUserVerifyingPlatformAuthenticatorAvailable;
    _maskFunction(PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable, 'isUserVerifyingPlatformAuthenticatorAvailable');

    PublicKeyCredential.isConditionalMediationAvailable = ({
        isConditionalMediationAvailable() {
            return Promise.resolve(_p("conditional_mediation", "true") === "true");
        }
    }).isConditionalMediationAvailable;
    _maskFunction(PublicKeyCredential.isConditionalMediationAvailable, 'isConditionalMediationAvailable');

    // Chrome 133+ surface — see web.dev/articles/webauthn-client-capabilities.
    PublicKeyCredential.getClientCapabilities = ({
        getClientCapabilities() {
            const uvpa = _p("has_platform_authenticator", "false") === "true";
            return Promise.resolve({
                conditionalCreate: false,
                conditionalGet: true,
                hybridTransport: true,
                passkeyPlatformAuthenticator: uvpa,
                userVerifyingPlatformAuthenticator: uvpa,
                relatedOrigins: true,
                signalAllAcceptedCredentials: true,
                signalCurrentUserDetails: true,
                signalUnknownCredential: true,
            });
        }
    }).getClientCapabilities;
    _maskFunction(PublicKeyCredential.getClientCapabilities, 'getClientCapabilities');
    globalThis.PublicKeyCredential = PublicKeyCredential;

    class IdentityCredential {
        constructor() { throw new TypeError("Illegal constructor"); }
    }
    Object.defineProperty(IdentityCredential.prototype, Symbol.toStringTag,
        { value: "IdentityCredential", configurable: true });
    globalThis.IdentityCredential = IdentityCredential;

    class IdentityProvider {}
    IdentityProvider.getUserInfo = ({
        getUserInfo() {
            return Promise.reject(new DOMException("Not allowed", "NotAllowedError"));
        }
    }).getUserInfo;
    _maskFunction(IdentityProvider.getUserInfo, 'getUserInfo');
    globalThis.IdentityProvider = IdentityProvider;

    function _fedcmGet(_identity) {
        // No real IdP wiring. Reject the way Chrome does after the user dismisses
        // (NotAllowedError) — scripts probing this only assert reject-shape + delay.
        return new Promise((_, rej) => setTimeout(() =>
            rej(new DOMException("User declined or no eligible accounts.",
                "NotAllowedError")), 200));
    }

    class CredentialsContainer {}
    Object.defineProperty(CredentialsContainer.prototype, Symbol.toStringTag,
        { value: "CredentialsContainer", configurable: true });
    CredentialsContainer.prototype.create = ({
        create(opts) {
            if (!opts || typeof opts !== "object") {
                return Promise.reject(new TypeError(
                    "Failed to execute 'create' on 'CredentialsContainer': 1 argument required."));
            }
            if (opts.publicKey) {
                // Realistic ~120 ms delay then NotAllowedError — matches Chrome with no UV.
                return new Promise((_, rej) => setTimeout(() =>
                    rej(new DOMException(
                        "The operation either timed out or was not allowed; see https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.",
                        "NotAllowedError")), 120));
            }
            return Promise.resolve(null);
        }
    }).create;
    _maskFunction(CredentialsContainer.prototype.create, 'create');

    CredentialsContainer.prototype.get = ({
        get(opts) {
            if (opts && opts.identity) return _fedcmGet(opts.identity);
            if (opts && opts.publicKey) {
                return new Promise((_, rej) => setTimeout(() =>
                    rej(new DOMException(
                        "The operation either timed out or was not allowed; see https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.",
                        "NotAllowedError")), 120));
            }
            return Promise.resolve(null);
        }
    }).get;
    _maskFunction(CredentialsContainer.prototype.get, 'get');

    CredentialsContainer.prototype.store = ({ store() { return Promise.resolve(undefined); } }).store;
    _maskFunction(CredentialsContainer.prototype.store, 'store');

    CredentialsContainer.prototype.preventSilentAccess = ({ preventSilentAccess() { return Promise.resolve(undefined); } }).preventSilentAccess;
    _maskFunction(CredentialsContainer.prototype.preventSilentAccess, 'preventSilentAccess');

    globalThis.CredentialsContainer = CredentialsContainer;
    const _navCredentials = Object.create(CredentialsContainer.prototype);

    class Bluetooth extends EventTarget {
        constructor() { super(); }
    }
    Object.defineProperty(Bluetooth.prototype, Symbol.toStringTag, {
        value: "Bluetooth", configurable: true,
    });
    Bluetooth.prototype.getAvailability = ({ getAvailability() { return Promise.resolve(false); } }).getAvailability;
    _maskFunction(Bluetooth.prototype.getAvailability, 'getAvailability');

    Bluetooth.prototype.requestDevice = ({ requestDevice() { return Promise.reject(new DOMException("User denied", "NotFoundError")); } }).requestDevice;
    _maskFunction(Bluetooth.prototype.requestDevice, 'requestDevice');

    globalThis.Bluetooth = Bluetooth;
    const _navBluetooth = Object.create(Bluetooth.prototype);

    const _navUsb = _svc.make(globalThis.USB);
    const _navSerial = _svc.make(globalThis.Serial);
    const _navHid = _svc.make(globalThis.HID);
    const _navLocks = _svc.make(globalThis.LockManager);

    // navigator.keyboard — Keyboard API (commonly probed by fingerprint scripts).
    // Real Chrome exposes a Keyboard instance with getLayoutMap() returning a
    // KeyboardLayoutMap: a Map<string, string> of physical key code → character.
    // An empty {} or missing getLayoutMap is an immediate lie signal.
    const _qwertyLayout = new Map([
        ['Backquote', '`'], ['Digit1', '1'], ['Digit2', '2'], ['Digit3', '3'],
        ['Digit4', '4'], ['Digit5', '5'], ['Digit6', '6'], ['Digit7', '7'],
        ['Digit8', '8'], ['Digit9', '9'], ['Digit0', '0'], ['Minus', '-'],
        ['Equal', '='],
        ['KeyQ', 'q'], ['KeyW', 'w'], ['KeyE', 'e'], ['KeyR', 'r'], ['KeyT', 't'],
        ['KeyY', 'y'], ['KeyU', 'u'], ['KeyI', 'i'], ['KeyO', 'o'], ['KeyP', 'p'],
        ['BracketLeft', '['], ['BracketRight', ']'], ['Backslash', '\\'],
        ['KeyA', 'a'], ['KeyS', 's'], ['KeyD', 'd'], ['KeyF', 'f'], ['KeyG', 'g'],
        ['KeyH', 'h'], ['KeyJ', 'j'], ['KeyK', 'k'], ['KeyL', 'l'],
        ['Semicolon', ';'], ['Quote', "'"],
        ['KeyZ', 'z'], ['KeyX', 'x'], ['KeyC', 'c'], ['KeyV', 'v'], ['KeyB', 'b'],
        ['KeyN', 'n'], ['KeyM', 'm'],
        ['Comma', ','], ['Period', '.'], ['Slash', '/'],
        ['Space', ' '],
        ['F1', 'F1'], ['F2', 'F2'], ['F3', 'F3'], ['F4', 'F4'],
        ['F5', 'F5'], ['F6', 'F6'], ['F7', 'F7'], ['F8', 'F8'],
        ['F9', 'F9'], ['F10', 'F10'], ['F11', 'F11'], ['F12', 'F12'],
        ['Numpad0', '0'], ['Numpad1', '1'], ['Numpad2', '2'], ['Numpad3', '3'],
        ['Numpad4', '4'], ['Numpad5', '5'], ['Numpad6', '6'], ['Numpad7', '7'],
        ['Numpad8', '8'], ['Numpad9', '9'],
        ['NumpadAdd', '+'], ['NumpadSubtract', '-'], ['NumpadMultiply', '*'],
        ['NumpadDivide', '/'], ['NumpadDecimal', '.'],
    ]);

    class KeyboardLayoutMap {
        #m;
        constructor(map) { this.#m = map; }
        get size() { return this.#m.size; }
        get(key) { return this.#m.get(key); }
        has(key) { return this.#m.has(key); }
        entries() { return this.#m.entries(); }
        keys() { return this.#m.keys(); }
        values() { return this.#m.values(); }
        forEach(cb, thisArg) { return this.#m.forEach(cb, thisArg); }
        [Symbol.iterator]() {
            const it = this.#m[Symbol.iterator]();
            return {
                next() { return it.next(); },
                [Symbol.iterator]() { return this; }
            };
        }
    }
    Object.defineProperty(KeyboardLayoutMap.prototype, Symbol.toStringTag, {
        value: 'KeyboardLayoutMap', configurable: true,
    });
    globalThis.KeyboardLayoutMap = KeyboardLayoutMap;

    class Keyboard extends EventTarget {
        getLayoutMap() {
            return Promise.resolve(new KeyboardLayoutMap(_qwertyLayout));
        }
        lock(keyCodes) { return Promise.resolve(); }
        unlock() {}
    }
    Object.defineProperty(Keyboard.prototype, Symbol.toStringTag, {
        value: 'Keyboard', configurable: true,
    });
    globalThis.Keyboard = Keyboard;
    const _navKeyboard = new Keyboard();

    const _navStorage = _svc.make(globalThis.StorageManager);

    class ServiceWorkerContainer extends EventTarget {
        constructor() {
            super();
            const _st = _idl.own(this);
            _st.controller = null;
            this.oncontrollerchange = null;
            this.onmessage = null;
            _st.ready = Promise.resolve({
                active: null, installing: null, waiting: null, scope: "/",
                unregister() { return Promise.resolve(true); },
            });
        }
    }
    _idl.fields(ServiceWorkerContainer.prototype, ["controller", "ready"]);
    Object.defineProperty(ServiceWorkerContainer.prototype, Symbol.toStringTag, {
        value: "ServiceWorkerContainer", configurable: true,
    });
    ServiceWorkerContainer.prototype.register = ({
        register(scriptURL, options) {
            return Promise.resolve({
                scope: (options && options.scope) || "/",
                active: { scriptURL, state: "activated" },
                installing: null,
                waiting: null,
                updateViaCache: "imports",
                update() { return Promise.resolve(this); },
                unregister() { return Promise.resolve(true); },
                addEventListener() {},
                removeEventListener() {},
            });
        }
    }).register;
    _maskFunction(ServiceWorkerContainer.prototype.register, 'register');

    ServiceWorkerContainer.prototype.getRegistrations = ({ getRegistrations() { return Promise.resolve([]); } }).getRegistrations;
    _maskFunction(ServiceWorkerContainer.prototype.getRegistrations, 'getRegistrations');

    ServiceWorkerContainer.prototype.getRegistration = ({ getRegistration() { return Promise.resolve(undefined); } }).getRegistration;
    _maskFunction(ServiceWorkerContainer.prototype.getRegistration, 'getRegistration');

    ServiceWorkerContainer.prototype.startMessages = ({ startMessages() {} }).startMessages;
    _maskFunction(ServiceWorkerContainer.prototype.startMessages, 'startMessages');

    globalThis.ServiceWorkerContainer = ServiceWorkerContainer;
    const _navServiceWorker = new ServiceWorkerContainer();
    const _navClipboard = (() => {
        const _CProto = globalThis.Clipboard && globalThis.Clipboard.prototype;
        const c = _CProto ? Object.create(_CProto) : {};
        c.readText = ({ readText() { return Promise.resolve(""); } }).readText;
        _maskFunction(c.readText, 'readText');

        c.writeText = ({ writeText() { return Promise.resolve(); } }).writeText;
        _maskFunction(c.writeText, 'writeText');

        return c;
    })();
    Object.defineProperty(_navClipboard, Symbol.toStringTag, { value: "Clipboard", configurable: true });
    const _navGeolocation = (() => {
        const _GProto = globalThis.Geolocation && globalThis.Geolocation.prototype;
        const g = _GProto ? Object.create(_GProto) : {};
        g.getCurrentPosition = ({
            getCurrentPosition(ok, err, options) {
                if (typeof err === "function") setTimeout(() => err({ code: 1, message: "User denied Geolocation" }), 0);
            }
        }).getCurrentPosition;
        _maskFunction(g.getCurrentPosition, 'getCurrentPosition');

        g.watchPosition = ({
            watchPosition(ok, err, options) {
                if (typeof err === "function") setTimeout(() => err({ code: 1, message: "User denied Geolocation" }), 0);
                return 0;
            }
        }).watchPosition;
        _maskFunction(g.watchPosition, 'watchPosition');

        g.clearWatch = ({ clearWatch() {} }).clearWatch;
        _maskFunction(g.clearWatch, 'clearWatch');

        return g;
    })();
    Object.defineProperty(_navGeolocation, Symbol.toStringTag, { value: "Geolocation", configurable: true });
    const _navWakeLock = {};
    Object.defineProperty(_navWakeLock, Symbol.toStringTag, { value: "WakeLock", configurable: true });
    const _navMediaSession = {};
    const _navScheduling = (() => {
        const _SProto = globalThis.Scheduling && globalThis.Scheduling.prototype;
        const s = _SProto ? Object.create(_SProto) : {};
        s.isInputPending = function isInputPending() { return false; };
        return s;
    })();

    Object.defineProperty(_navScheduling, Symbol.toStringTag, { value: "Scheduling", configurable: true });
    const _navUserActivation = (() => {
        const _UAProto = globalThis.UserActivation && globalThis.UserActivation.prototype;
        const u = _UAProto ? Object.create(_UAProto) : {};
        Object.defineProperties(u, {
            isActive: { get: () => false, enumerable: true },
            hasBeenActive: { get: () => false, enumerable: true },
        });
        return u;
    })();
    Object.defineProperty(_navUserActivation, Symbol.toStringTag, { value: "UserActivation", configurable: true });
    // navigator.languages is CACHED per runtime — Chrome returns the same
    // frozen array reference on every access, so we memoize after the first
    // lazy read (bootstrap time has no profile; the cache must be deferred).
    // Assertions tested elsewhere: Object.isFrozen === true, identity stable.
    let _navLanguagesCache = null;
    const _getNavLanguages = () => {
        if (_navLanguagesCache === null) {
            _navLanguagesCache = Object.freeze(_pJson("languages", ["en-US", "en"]));
        }
        return _navLanguagesCache;
    };

    // Scalar getters — read from stealth profile each call (idempotent).
    _defNav('userAgent', () => _p("user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"));
    _defNav('platform', () => _p("platform", "Win32"));
    // Read vendor/vendorSub from the profile
    // (default "Google Inc."/"") instead of hard-coding. The worker realm
    // already reads `_p("vendor")` (worker_bootstrap.js:152), so hard-coding
    // here leaked vendor="Google Inc." under a firefox_135_* preset (a
    // 100% impersonation breaker) AND mismatched the worker. No-op for
    // chrome presets (profile vendor == "Google Inc.").
    // Firefox reports vendor="" (empty); `_p` treats an empty profile value as
    // missing and would fall back to "Google Inc.", so special-case it.
    _defNav('vendor', () => _isFirefox() ? "" : _p("vendor", "Google Inc."));
    _defNav('vendorSub', () => _p("vendor_sub", ""));
    // productSub is "20100101" on Gecko, "20030107" on Blink/WebKit.
    _defNav('productSub', () => _isFirefox() ? "20100101" : "20030107");
    // navigator.oscpu + navigator.buildID are Gecko-only. buildID is frozen to
    // "20181001000000" on all modern Firefox (anti-fingerprinting). Their
    // ABSENCE under a Firefox UA is itself a tell, so define them for FF only.
    if (_isFirefox()) {
        _defNav('oscpu', () => _firefoxOscpu());
        _defNav('buildID', () => "20181001000000");
    }
    _defNav('appVersion', () => _p("user_agent", "").replace("Mozilla/", ""));
    _defNav('appCodeName', () => "Mozilla");
    _defNav('appName', () => "Netscape");
    _defNav('product', () => "Gecko");
    _defNav('language', () => _p("language", "ru-RU"));
    _defNav('languages', _getNavLanguages);
    _defNav('onLine', () => true);
    _defNav('cookieEnabled', () => true);
    _defNav('hardwareConcurrency', () => _pInt("hardware_concurrency", 8));
    // navigator.deviceMemory is [SecureContext] — undefined on
    // data:/http:/about:blank. Phase 7. Skip entirely on iOS (real
    // Safari has no NavigatorDeviceMemory interface) and on Firefox
    // (Gecko has no NavigatorDeviceMemory interface — Chrome-only).
    if (!_isMobileIOS() && !_isFirefox()) {
        // Real Chrome clamps navigator.deviceMemory
        // to a max of 8 (spec: one of 0.25/0.5/1/2/4/8). Some presets carry
        // device_memory=16 (for the Sec-CH-Device-Memory header + physical
        // coherence), which leaked a JS value Chrome never reports — a
        // deterministic tell. Clamp the JS getter to <=8 while leaving the
        // header/physical value intact.
        _defNav('deviceMemory', () => _secure() ? Math.min(_pInt("device_memory", 8), 8) : undefined);
    }
    _defNav('maxTouchPoints', () => _pInt("max_touch_points", 0));
    _defNav('pdfViewerEnabled', () => true);
    // webdriver: present on Navigator.prototype per W3C WebDriver spec.
    // Modern Chrome (>=89, incl. the Chrome-148 we impersonate) ALWAYS
    // defines navigator.webdriver: it returns `false` for normal
    // browsing (`undefined` differs from a real modern browser). This is
    // consistent with worker_bootstrap.js (already `false`). The prior
    // "returns undefined" was a wrong assumption. Some scripts also check
    // the getter source, so it is masked native via _maskFunction.
    Object.defineProperty(Navigator.prototype, 'webdriver', {
        // Arrow, like every other navigator getter here: a plain function
        // expression carries a `prototype` and is constructible, and a native
        // getter is neither. `Object.getOwnPropertyNames(get)` read
        // `length,name,prototype` against `length,name` everywhere else — a
        // difference that names this one property as the patched one.
        get: _maskFunction(_navBrand(() => false), 'get webdriver'),
        enumerable: true,
        configurable: true
    });
    _defNav('doNotTrack', () => null);

    // Object getters — stable references.
    // navigator.connection (NetworkInformation API) — Chrome-only. Real
    // Safari and Firefox have no `connection` on Navigator (Gecko gates it
    // behind a pref, off by default). Skip on iOS + Firefox.
    if (!_isMobileIOS() && !_isFirefox()) {
        Object.defineProperty(_NavProto, 'connection', { get: () => _navConnection, enumerable: true, configurable: true });
    }
    Object.defineProperty(_NavProto, 'plugins', { get: () => _navPlugins, enumerable: true, configurable: true });
    Object.defineProperty(_NavProto, 'mimeTypes', { get: () => _navMimeTypes, enumerable: true, configurable: true });
    // Navigator getters. Properties marked /* SC */ are
    // [SecureContext]-only per their IDL — return undefined on
    // insecure contexts so the surface matches real Chrome on
    // data:/http:/about:blank URLs. Phase 7 fix.
    Object.defineProperty(_NavProto, 'mediaDevices', { get: () => _secure() ? _navMediaDevices : undefined, enumerable: true, configurable: true });
    Object.defineProperty(_NavProto, 'permissions', { get: () => _navPermissions, enumerable: true, configurable: true });
    Object.defineProperty(_NavProto, 'credentials', { get: () => _secure() ? _navCredentials : undefined, enumerable: true, configurable: true });
    Object.defineProperty(_NavProto, 'bluetooth', { get: () => _secure() ? _navBluetooth : undefined, enumerable: true, configurable: true });
    Object.defineProperty(_NavProto, 'usb', { get: () => _secure() ? _navUsb : undefined, enumerable: true, configurable: true });
    Object.defineProperty(_NavProto, 'serial', { get: () => _secure() ? _navSerial : undefined, enumerable: true, configurable: true });
    Object.defineProperty(_NavProto, 'hid', { get: () => _secure() ? _navHid : undefined, enumerable: true, configurable: true });
    Object.defineProperty(_NavProto, 'keyboard', { get: () => _secure() ? _navKeyboard : undefined, enumerable: true, configurable: true });
    Object.defineProperty(_NavProto, 'locks', { get: () => _secure() ? _navLocks : undefined, enumerable: true, configurable: true });
    Object.defineProperty(_NavProto, 'storage', { get: () => _secure() ? _navStorage : undefined, enumerable: true, configurable: true });
    Object.defineProperty(_NavProto, 'serviceWorker', { get: () => _secure() ? _navServiceWorker : undefined, enumerable: true, configurable: true });
    Object.defineProperty(_NavProto, 'clipboard', { get: () => _secure() ? _navClipboard : undefined, enumerable: true, configurable: true });
    Object.defineProperty(_NavProto, 'geolocation', { get: () => _navGeolocation, enumerable: true, configurable: true });
    Object.defineProperty(_NavProto, 'wakeLock', { get: () => _secure() ? _navWakeLock : undefined, enumerable: true, configurable: true });

    // Apply native masking to all getters
    _maskAsNative(_NavProto, 'userAgent', 'platform', 'vendor', 'vendorSub', 'productSub', 
        'appVersion', 'appCodeName', 'appName', 'product', 'language', 'languages', 
        'onLine', 'cookieEnabled', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 
        'pdfViewerEnabled', 'webdriver', 'connection', 'plugins', 'mimeTypes', 
        'mediaDevices', 'permissions', 'credentials', 'bluetooth', 'usb', 'serial', 
        'hid', 'keyboard', 'locks', 'storage', 'serviceWorker', 'clipboard', 
        'geolocation', 'wakeLock');
    _defNav('mediaSession', () => _navMediaSession);
    // navigator.scheduling.isInputPending — Chrome-only. Real Safari has
    // no Scheduling interface. navigator.userActivation — Chrome 88+ only.
    if (!_isMobileIOS()) {
        _defNav('scheduling', () => _navScheduling);
        _defNav('userActivation', () => _navUserActivation);
    }

    // Prototype methods.
    _defNavMethod('javaEnabled', function javaEnabled() { return false; });
    // Real sendBeacon: fires a fetch with keepalive=true so the server
    // actually receives the payload. A no-op stub silently drops data that
    // challenge scripts send on completion, blocking
    // the session from being upgraded.
    _defNavMethod('sendBeacon', function sendBeacon(url, data) {
        try {
            let absUrl = String(url);
            if (!/^https?:/i.test(absUrl)) {
                const _base = globalThis.location && globalThis.location.href || 'about:blank';
                // Empty url resolves to the document URL (real Chrome:
                // sendBeacon('', data) POSTs to location.href). Handle it
                // explicitly — our URL polyfill throws on `new URL('', base)`,
                // which the outer catch swallowed, so a challenge
                // beacon (sendBeacon('', sensorData)) silently failed with
                // "relative URL without a base".
                absUrl = (absUrl === '') ? _base : new URL(absUrl, _base).href;
            }
            let init = { method: 'POST', keepalive: true, credentials: 'include' };
            if (data != null) {
                if (typeof data === 'string') {
                    init.body = data;
                    init.headers = { 'content-type': 'text/plain;charset=UTF-8' };
                } else if (data instanceof Blob) {
                    init.body = data;
                    if (data.type) init.headers = { 'content-type': data.type };
                } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
                    init.body = data;
                    init.headers = { 'content-type': 'application/octet-stream' };
                } else if (typeof FormData !== 'undefined' && data instanceof FormData) {
                    init.body = data;
                } else if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) {
                    init.body = String(data);
                    init.headers = { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' };
                } else {
                    init.body = String(data);
                    init.headers = { 'content-type': 'text/plain;charset=UTF-8' };
                }
            }
            // Fire and forget — sendBeacon is non-blocking by spec.
            Promise.resolve().then(() => fetch(absUrl, init).catch(() => {}));
            return true;
        } catch (_) {
            return false;
        }
    });
    // BatteryManager — must be a real class extending EventTarget so
    // `Object.getPrototypeOf(b).constructor.name === "BatteryManager"`
    // and `b instanceof EventTarget` both hold.
    class BatteryManager extends EventTarget {
        constructor() {
            super();
        }
    }
    Object.defineProperty(BatteryManager.prototype, Symbol.toStringTag, {
        value: "BatteryManager", configurable: true,
    });

    // Some scripts use a for..in traversal that requires these to be
    // enumerable. Standard WebIDL members are non-enumerable, but such a
    // traversal expects to see these values. Moving them to
    // the prototype as enumerable getters satisfies both:
    // 1. Instance has 0 own properties (parity).
    // 2. for..in on instance still finds them (parity).
    const _defBatGetter = (name, val) => {
        const getter = function() { return val; };
        Object.defineProperty(BatteryManager.prototype, name, {
            get: getter,
            enumerable: true,
            configurable: true,
        });
        _maskFunction(getter, `get ${name}`);
    };
    const _defBatProp = (name) => {
        let _val = null;
        const getter = function() { return _val; };
        const setter = function(v) { _val = v; };
        Object.defineProperty(BatteryManager.prototype, name, {
            get: getter,
            set: setter,
            enumerable: true,
            configurable: true,
        });
        _maskFunction(getter, `get ${name}`);
        _maskFunction(setter, `set ${name}`);
    };

    // Per-session randomized values. The canonical headless battery tell is
    // `{level:1, charging:true, chargingTime:0, dischargingTime:Infinity}`
    // — every headless browser ships that exact combination because the
    // default constants are intuitive. Real Chrome on a laptop varies:
    // charging is false ~70% of typical sessions (battery-powered), level
    // is uniform-ish in [0.20, 0.95], and chargingTime/dischargingTime are
    // finite when on battery. We seed once at module init so reads are
    // stable within the page (real BatteryManager doesn't tick by the
    // second either — events fire on state change).
    const _batCharging = Math.random() < 0.3; // ~30% plugged in
    const _batLevel = (() => {
        const v = 0.20 + Math.random() * 0.75;
        // Round to 2 decimal places — real Chrome rounds level to 0.01 since
        // a 2021 privacy reduction (https://crbug.com/661792).
        return Math.round(v * 100) / 100;
    })();
    const _batChargingTime = _batCharging
        ? Math.round(1800 + Math.random() * 7200) // 30 min – 2.5 h to full
        : Infinity;
    const _batDischargingTime = _batCharging
        ? Infinity
        : Math.round(3600 + Math.random() * 21600); // 1 – 7 h remaining

    _defBatGetter('charging', _batCharging);
    _defBatGetter('chargingTime', _batChargingTime);
    _defBatGetter('dischargingTime', _batDischargingTime);
    _defBatGetter('level', _batLevel);
    _defBatProp('onchargingchange');
    _defBatProp('onchargingtimechange');
    _defBatProp('ondischargingtimechange');
    _defBatProp('onlevelchange');

    globalThis.BatteryManager = BatteryManager;
    const _batteryInstance = new BatteryManager();
    // getBattery is [SecureContext] — exists only on https/wss/file/
    // localhost. On data:/http:, real Chrome reports
    // `TypeError: navigator.getBattery is not a function`. Phase 7.
    if (_secure()) {
        _defNavMethod('getBattery', function getBattery() {
            return Promise.resolve(_batteryInstance);
        });
    }
    if (_isFirefox()) {
        _defNavMethod('mozGetUserMedia', function mozGetUserMedia(c, s, e) { if (e) e(new Error("Permission denied")); });
    } else {
        _defNavMethod('getUserMedia', function getUserMedia(constraints, success, error) {
            if (error) error(new Error("Permission denied"));
            return undefined;
        });
        _defNavMethod('webkitGetUserMedia', function webkitGetUserMedia(c, s, e) { if (e) e(new Error("Permission denied")); });
    }
    if (_secure()) {
        _defNavMethod('requestMIDIAccess', function requestMIDIAccess(options) {
            return Promise.reject(new DOMException("Permission denied", "SecurityError"));
        });
    }
    // Additional Navigator.prototype methods that some scripts walk via
    // computed names. Missing any of these causes
    // `obj[computed_name](...) is not a function` errors in such scripts.
    _defNavMethod('vibrate', function vibrate(pattern) { return false; });
    _defNavMethod('getGamepads', function getGamepads() { return [null, null, null, null]; });
    _defNavMethod('registerProtocolHandler', function registerProtocolHandler(scheme, url) {});
    _defNavMethod('unregisterProtocolHandler', function unregisterProtocolHandler(scheme, url) {});
    _defNavMethod('requestMediaKeySystemAccess', function requestMediaKeySystemAccess(keySystem, configs) {
        // org.w3.clearkey is required by the W3C EME spec on all platforms.
        // com.widevine.alpha is available on Windows and macOS (not Linux desktop).
        // com.microsoft.playready is Windows-only.
        // Returning NotSupportedError unconditionally differs from a real
        // browser and is commonly probed.
        const _ks = String(keySystem);
        const _os = _p("os_name", "Windows");
        const _isWin = _os === "Windows";
        const _isMac = _os === "macOS";

        const _supported = (
            _ks === 'org.w3.clearkey' ||
            (_ks === 'com.widevine.alpha' && (_isWin || _isMac)) ||
            (_ks === 'com.microsoft.playready' && _isWin)
        );

        if (!_supported) {
            return Promise.reject(new DOMException(
                "Failed to execute 'requestMediaKeySystemAccess' on 'Navigator': " +
                "Requested configuration is not supported.",
                "NotSupportedError"
            ));
        }

        // Build a minimal MediaKeySystemAccess object.
        // Real Chrome exposes: keySystem (string), getConfiguration() (object),
        // createMediaKeys() (Promise<MediaKeys>).
        const _access = {
            keySystem: _ks,
            getConfiguration: function getConfiguration() {
                return configs && configs.length ? Object.assign({}, configs[0]) : {};
            },
            createMediaKeys: function createMediaKeys() {
                // Return a minimal MediaKeys stub; sufficient for capability probes.
                const _mk = {
                    createSession: function createSession() {
                        return {
                            sessionId: '', expiration: NaN, closed: Promise.resolve(),
                            keyStatuses: new Map(),
                            addEventListener: function() {}, removeEventListener: function() {},
                            generateRequest: function() { return Promise.resolve(); },
                            load: function() { return Promise.resolve(false); },
                            update: function() { return Promise.resolve(); },
                            close: function() { return Promise.resolve(); },
                            remove: function() { return Promise.resolve(); },
                        };
                    },
                    setServerCertificate: function() { return Promise.resolve(false); },
                };
                return Promise.resolve(_mk);
            },
        };
        return Promise.resolve(_access);
    });
    _defNavMethod('canShare', function canShare(data) { return false; });
    _defNavMethod('share', function share(data) {
        return Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    });
    _defNavMethod('clearAppBadge', function clearAppBadge() { return Promise.resolve(); });
    _defNavMethod('setAppBadge', function setAppBadge(count) { return Promise.resolve(); });

    const _tagProto = (ctor, name) => Object.defineProperty(ctor.prototype, Symbol.toStringTag, {
        value: name, configurable: true,
    });
    const _rejectNotAllowed = (what) => Promise.reject(
        new DOMException(`${what}: not allowed`, 'NotAllowedError'));

    class DeprecatedStorageQuota {}
    _tagProto(DeprecatedStorageQuota, 'DeprecatedStorageQuota');
    _defProtoMethod(DeprecatedStorageQuota.prototype, 'queryUsageAndQuota',
        function queryUsageAndQuota(successCallback, errorCallback) {
            if (typeof successCallback === 'function') successCallback(0, 0);
        });
    _defProtoMethod(DeprecatedStorageQuota.prototype, 'requestQuota',
        function requestQuota(newQuota, successCallback, errorCallback) {
            if (typeof successCallback === 'function') successCallback(newQuota | 0);
        });
    const _navTemporaryStorage = Object.create(DeprecatedStorageQuota.prototype);
    const _navPersistentStorage = Object.create(DeprecatedStorageQuota.prototype);

    class ProtectedAudience {}
    _tagProto(ProtectedAudience, 'ProtectedAudience');
    _defProtoMethod(ProtectedAudience.prototype, 'queryFeatureSupport',
        function queryFeatureSupport(feature) { return false; });
    globalThis.ProtectedAudience = ProtectedAudience;
    const _navProtectedAudience = Object.create(ProtectedAudience.prototype);

    class NavigatorManagedData extends EventTarget {}
    _tagProto(NavigatorManagedData, 'NavigatorManagedData');
    for (const _m of ['getManagedConfiguration', 'getDirectoryId', 'getHostname',
                      'getSerialNumber', 'getAnnotatedAssetId', 'getAnnotatedLocation']) {
        _defProtoMethod(NavigatorManagedData.prototype, _m,
            function () { return _rejectNotAllowed('managed'); });
    }
    globalThis.NavigatorManagedData = NavigatorManagedData;
    const _navManaged = new NavigatorManagedData();

    class NavigatorLogin {}
    _tagProto(NavigatorLogin, 'NavigatorLogin');
    _defProtoMethod(NavigatorLogin.prototype, 'setStatus',
        function setStatus(status) { return Promise.resolve(undefined); });
    globalThis.NavigatorLogin = NavigatorLogin;
    const _navLogin = Object.create(NavigatorLogin.prototype);

    class Ink {}
    _tagProto(Ink, 'Ink');
    _defProtoMethod(Ink.prototype, 'requestPresenter', function requestPresenter(param) {
        return Promise.reject(new DOMException('Ink presenter unavailable', 'NotSupportedError'));
    });
    globalThis.Ink = Ink;
    const _navInk = Object.create(Ink.prototype);

    class Presentation {}
    _tagProto(Presentation, 'Presentation');
    _defProtoGetter(Presentation.prototype, 'defaultRequest', () => null, (_v) => {});
    _defProtoGetter(Presentation.prototype, 'receiver', () => null);
    globalThis.Presentation = Presentation;
    const _navPresentation = Object.create(Presentation.prototype);

    class XRSystem extends EventTarget {}
    _tagProto(XRSystem, 'XRSystem');
    _defProtoMethod(XRSystem.prototype, 'isSessionSupported', function isSessionSupported(mode) {
        return Promise.resolve(false);
    });
    _defProtoMethod(XRSystem.prototype, 'requestSession', function requestSession(mode, options) {
        return Promise.reject(new DOMException('No XR device', 'NotSupportedError'));
    });
    globalThis.XRSystem = XRSystem;
    const _navXr = new XRSystem();

    const _navStorageBuckets = _svc.make(globalThis.StorageBucketManager);

    _defNav('webkitTemporaryStorage', () => _navTemporaryStorage);
    _defNav('webkitPersistentStorage', () => _navPersistentStorage);
    if (_secure()) {
        _defNav('protectedAudience', () => _navProtectedAudience);
        _defNav('managed', () => _navManaged);
        _defNav('login', () => _navLogin);
        _defNav('ink', () => _navInk);
        _defNav('presentation', () => _navPresentation);
        _defNav('xr', () => _navXr);
        _defNav('storageBuckets', () => _navStorageBuckets);
        _defNav('deprecatedRunAdAuctionEnforcesKAnonymity', () => true);

        _defNavMethod('runAdAuction', function runAdAuction(config) {
            return Promise.resolve(null);
        });
        _defNavMethod('joinAdInterestGroup', function joinAdInterestGroup(group) {
            return Promise.resolve(undefined);
        });
        _defNavMethod('leaveAdInterestGroup', function leaveAdInterestGroup(group) {
            return Promise.resolve(undefined);
        });
        _defNavMethod('updateAdInterestGroups', function updateAdInterestGroups() {});
        _defNavMethod('clearOriginJoinedAdInterestGroups',
            function clearOriginJoinedAdInterestGroups(owner, interestGroupsToKeep) {
                return Promise.resolve(undefined);
            });
        _defNavMethod('createAuctionNonce', function createAuctionNonce() {
            return Promise.resolve(crypto.randomUUID());
        });
        _defNavMethod('adAuctionComponents', function adAuctionComponents(numAdComponents) {
            throw new DOMException(
                "Failed to execute 'adAuctionComponents' on 'Navigator': " +
                'May only be called from a frame that was loaded from an ad auction.',
                'NotAllowedError');
        });
        _defNavMethod('canLoadAdAuctionFencedFrame', function canLoadAdAuctionFencedFrame() {
            return true;
        });
        _defNavMethod('deprecatedReplaceInURN', function deprecatedReplaceInURN(urnOrConfig, replacements) {
            return Promise.reject(new TypeError('Passed URN is not valid.'));
        });
        _defNavMethod('deprecatedURNToURL', function deprecatedURNToURL(urnOrConfig, sendReports) {
            return Promise.resolve(null);
        });
        _defNavMethod('getInterestGroupAdAuctionData', function getInterestGroupAdAuctionData(config) {
            return Promise.reject(new DOMException(
                'getInterestGroupAdAuctionData API not available.', 'NotSupportedError'));
        });
    }

    // Symbol.toStringTag — some scripts check Object.prototype.toString.call(navigator)
    // and expect "[object Navigator]". Without this, it returns "[object Object]".
    Object.defineProperty(_NavProto, Symbol.toStringTag, {
        value: "Navigator", configurable: true,
    });

    // Instantiate — zero own properties.
    const _navigator = globalThis.navigator || Object.create(_NavProto);
    Object.setPrototypeOf(_navigator, _NavProto);
    globalThis.navigator = _navigator;

    // location — Proxy-based, tracks URL components and navigation requests
    const _locationData = {
        href: "about:blank",
        protocol: "https:",
        host: "",
        hostname: "",
        port: "",
        pathname: "/",
        search: "",
        hash: "",
        origin: "null",
    };

    function _parseLocationUrl(url) {
        const s = String(url);
        // Special-scheme URLs (about:, data:, javascript:, blob:, mailto:,
        // tel:, chrome:, chrome-extension:, view-source:) are absolute — they
        // replace the current location entirely, they don't join against the
        // base. Our embedded URL constructor was joining `about:blank`
        // against an http(s) base and producing `https://host/about:blank`
        // (a path with a colon), which the navigate loop then tried to fetch.
        // Detect special schemes and short-circuit the join. Pinned by the
        // iphey.com regression where JS sets `location.href = 'about:blank'`
        // during a fingerprint check and broke same-page rendering.
        if (/^(about|data|javascript|blob|mailto|tel|chrome|chrome-extension|view-source):/i.test(s)) {
            _locationData.href = s;
            // Clear sub-fields so a downstream consumer doesn't see stale
            // pieces of the previous URL.
            _locationData.protocol = (s.split(':', 1)[0] || '') + ':';
            _locationData.host = '';
            _locationData.hostname = '';
            _locationData.port = '';
            _locationData.pathname = '';
            _locationData.search = '';
            _locationData.hash = '';
            _locationData.origin = 'null';
            return;
        }
        try {
            const u = new URL(s, _locationData.href !== "about:blank" ? _locationData.href : undefined);
            _locationData.href = u.href;
            _locationData.protocol = u.protocol;
            _locationData.host = u.host;
            _locationData.hostname = u.hostname;
            _locationData.port = u.port;
            _locationData.pathname = u.pathname;
            _locationData.search = u.search;
            _locationData.hash = u.hash;
            _locationData.origin = u.origin;
        } catch {
            _locationData.href = s;
        }
    }

    // Pending-navigation signal — generic primitive used by the Rust driver
    // to loop through challenge flows. Any location.reload/assign/replace or
    // location.href = ... sets this; <meta http-equiv="refresh"> does too.
    // Matches the behavior of a real browser's navigation algorithm without
    // any per-engine awareness.

    // Location class and instance
    const _LocProto = globalThis.Location.prototype;
    Object.defineProperty(_LocProto, Symbol.toStringTag, { value: "Location", enumerable: false, configurable: true });

    // Every Location member is [LegacyUnforgeable]: in Chrome they are own,
    // non-configurable properties of `window.location` itself, and
    // `Location.prototype` carries nothing but `constructor`. They are built on
    // this holder first so the existing masking helpers still name them, then
    // copied onto the instance below.
    const _locHolder = {};
    function _defLoc(prop, getter, setter) {
        _defProtoGetter(_locHolder, prop, getter, setter);
    }

    // Signal the Rust event loop that a navigation is pending. Without this,
    // `run_until_idle(30s)` runs to its full ceiling before the retry GET
    // fires — too late for sites with a few-second navigation-timing window. With it,
    // run_until_idle returns within ~150ms (just enough microtask tail to
    // let in-flight fetch().then(setCookie) land in the jar). See
    // crates/js_runtime/src/extensions/nav_ext.rs.
    const _signalNav = () => { try { ops.op_set_pending_nav(); } catch (_) {} };

    // Mirror `_browser_oxide.__pendingNavigation` onto `globalThis.__pendingNavigation`
    // — JS-side consumers (and the navigation_primitives tests) read it
    // off globalThis per the documented contract at the top of this
    // section. We keep _browser_oxide as the underlying store so the existing
    // Rust event-loop driver and per-call assignments keep working.
    Object.defineProperty(globalThis, '__pendingNavigation', {
        get: () => _browser_oxide.__pendingNavigation,
        set: (v) => { _browser_oxide.__pendingNavigation = v; },
        configurable: true,
        enumerable: false,
    });

    _defLoc('href', () => _locationData.href, (v) => {
        _parseLocationUrl(v);
        _browser_oxide.__pendingNavigation = { url: _locationData.href, kind: "assign" };
        _signalNav();
    });
    _defLoc('origin', () => _locationData.origin);
    _defLoc('protocol', () => _locationData.protocol, (v) => {
        _parseLocationUrl(v + "//" + _locationData.host + _locationData.pathname);
        _browser_oxide.__pendingNavigation = 
 { url: _locationData.href, kind: "assign" };
        _signalNav();
    });
    _defLoc('host', () => _locationData.host, (v) => {
        _parseLocationUrl(_locationData.protocol + "//" + v + _locationData.pathname);
        _browser_oxide.__pendingNavigation = 
 { url: _locationData.href, kind: "assign" };
        _signalNav();
    });
    _defLoc('hostname', () => _locationData.hostname, (v) => {
        _parseLocationUrl(_locationData.protocol + "//" + v + (_locationData.port ? ":" + _locationData.port : "") + _locationData.pathname);
        _browser_oxide.__pendingNavigation = 
 { url: _locationData.href, kind: "assign" };
        _signalNav();
    });
    _defLoc('port', () => _locationData.port);
    _defLoc('pathname', () => _locationData.pathname);
    _defLoc('search', () => _locationData.search);
    _defLoc('hash', () => _locationData.hash, (v) => {
        _locationData.hash = String(v).startsWith('#') ? v : '#' + v;
        _locationData.href = _locationData.origin + _locationData.pathname + _locationData.search + _locationData.hash;
    });
    _defLoc('ancestorOrigins', () => {
        const _ao = { length: 0, item: () => null, contains: () => false };
        _ao[Symbol.iterator] = function*() {};
        return _ao;
    });

    _defProtoMethod(_locHolder, 'assign', (url) => {
        _parseLocationUrl(url);
        _browser_oxide.__pendingNavigation = 
 { url: _locationData.href, kind: "assign" };
        _signalNav();
    });
    _defProtoMethod(_locHolder, 'replace', (url) => {
        _parseLocationUrl(url);
        _browser_oxide.__pendingNavigation = 
 { url: _locationData.href, kind: "replace" };
        _signalNav();
    });
    _defProtoMethod(_locHolder, 'reload', () => {
        _browser_oxide.__pendingNavigation = 
 { url: _locationData.href, kind: "reload" };
        _signalNav();
    });
    _defProtoMethod(_locHolder, 'toString', function() { return this.href; });

    _maskAsNative(_locHolder, 'assign', 'replace', 'reload', 'toString');

    const _locationInstance = Object.create(_LocProto);
    {
        const order = ['ancestorOrigins', 'href', 'origin', 'protocol', 'host', 'hostname',
            'port', 'pathname', 'search', 'hash', 'assign', 'reload', 'replace', 'toString'];
        Object.defineProperty(_locationInstance, 'valueOf', {
            value: Object.prototype.valueOf, writable: false, enumerable: false, configurable: false,
        });
        for (const key of order) {
            const d = Object.getOwnPropertyDescriptor(_locHolder, key);
            if (!d) continue;
            Object.defineProperty(_locationInstance, key, d.get || d.set
                ? { get: d.get, set: d.set, enumerable: true, configurable: false }
                : { value: d.value, writable: false, enumerable: true, configurable: false });
        }
        Object.defineProperty(_locationInstance, Symbol.toPrimitive, {
            value: undefined, writable: false, enumerable: false, configurable: false,
        });
    }
    try {
        // Delete Deno's location getter if it exists
        delete globalThis.location;
    } catch(e) {}
    try {
        Object.defineProperty(globalThis, 'location', {
            value: _locationInstance,
            writable: true,
            enumerable: true,
            configurable: true
        });
    } catch(e) {
        globalThis.location = _locationInstance;
    }

    // Frame-tree globals. Measured against a live Chrome 151: every one of
    // these is an accessor, `window`/`top` are [LegacyUnforgeable] and so
    // non-configurable, and the [Replaceable] ones carry a setter that turns
    // the property into a plain data property. `window`/`self`/`frames` used to
    // be non-configurable data properties here, which `getOwnPropertyDescriptor`
    // reports as `.get === undefined` — a difference no real browser shows.
    const _frameLinks = { parent: globalThis, top: globalThis };
    const _replaceableSetter = (key) => Object.getOwnPropertyDescriptor({
        set [key](v) {
            Object.defineProperty(globalThis, key, {
                value: v, writable: true, enumerable: true, configurable: true,
            });
        },
    }, key).set;
    const _defFrameRef = (key, read, configurable, replaceable) => {
        const get = Object.getOwnPropertyDescriptor({ get [key]() { return read(); } }, key).get;
        const desc = { get, enumerable: true, configurable };
        if (replaceable) desc.set = _replaceableSetter(key);
        Object.defineProperty(globalThis, key, desc);
        _maskFunction(get, `get ${key}`);
        if (desc.set) _maskFunction(desc.set, `set ${key}`);
    };
    const _thisWindow = () => globalThis;
    _defFrameRef('window', _thisWindow, true, false);
    _defFrameRef('self', _thisWindow, true, true);
    _defFrameRef('frames', _thisWindow, true, true);
    // `parent`/`top` read through `_frameLinks` so a child realm can be pointed
    // at a bridge to its real parent; as self-referential data properties a
    // child's `parent.postMessage` just talked to itself.
    _defFrameRef('parent', () => _frameLinks.parent, true, true);
    _defFrameRef('top', () => _frameLinks.top, true, false);
    // Privileged setter for the child-frame installer. It lives on the
    // symbol-keyed namespace rather than as a `__bo_*` global: a string key is
    // listed by `Object.getOwnPropertyNames(window)` whether enumerable or not,
    // and that sweep is exactly what fingerprinting scripts run.
    try {
        const _ns = (function(){try{var s=Object.getOwnPropertySymbols(globalThis, 1);for(var i=0;i<s.length;i++){var v=globalThis[s[i]];if(v&&v.__bo)return v;}}catch(e){}return null;})();
        if (_ns) {
            Object.defineProperty(_ns, 'setFrameLinks', {
                value: (parent, top) => {
                    if (parent) _frameLinks.parent = parent;
                    if (top) _frameLinks.top = top;
                },
                configurable: true, enumerable: false, writable: false,
            });
        }
    } catch (_) { /* ignore */ }
    globalThis.opener = null;
    // window.length = number of child browsing contexts, read live.
    //
    // It used to be a counter maintained by a hook on `appendChild`, which only
    // ever sees a frame appended *directly*. A frame that arrives inside an
    // inserted subtree — a DocumentFragment, an `innerHTML` — was never counted:
    // measured with three iframes in the document and `length` still reporting
    // two, which no browser does and which is a single line to check.
    //
    // `[Replaceable]` per WebIDL: assigning to it replaces the accessor with the
    // assigned value, rather than throwing or being silently dropped.
    try {
        Object.defineProperty(globalThis, 'length', {
            get() {
                try {
                    const n = document.querySelectorAll('iframe').length;
                    if (typeof _syncFrameIndicesRef === 'function') _syncFrameIndicesRef();
                    return n;
                } catch (_) { return 0; }
            },
            set(v) {
                Object.defineProperty(globalThis, 'length', {
                    value: v, writable: true, enumerable: true, configurable: true,
                });
            },
            configurable: true, enumerable: true,
        });
    } catch (_) {}

    // screen — prototype-backed so own-descriptor probe returns undefined.
    const _ScreenProto = Screen.prototype;
    // Derive orientation from the profile's screen
    // geometry instead of hard-coding landscape-primary. A portrait mobile
    // preset (iPhone: height > width) previously reported landscape-primary —
    // a screen/orientation contradiction that fingerprint scripts
    // flag. Desktop presets (width >= height) keep landscape-primary.
    const _scrW0 = _pInt("screen_width", 1920);
    const _scrH0 = _pInt("screen_height", 1080);
    const _screenOrientation = {
        type: _scrH0 > _scrW0 ? "portrait-primary" : "landscape-primary",
        angle: 0,
        onchange: null,
    };
    // ScreenOrientation is its own interface in Chrome, so expose it too.
    const _ScreenOrientationProto = ScreenOrientation.prototype;

    _defProtoGetter(_ScreenProto, 'width', () => _pInt("screen_width", 1920));
    _defProtoGetter(_ScreenProto, 'height', () => _pInt("screen_height", 1080));
    _defProtoGetter(_ScreenProto, 'availWidth', () => _pInt("screen_avail_width", 1920));
    _defProtoGetter(_ScreenProto, 'availHeight', () => _pInt("screen_avail_height", 1040));
    _defProtoGetter(_ScreenProto, 'availLeft', () => 0);
    _defProtoGetter(_ScreenProto, 'availTop', () => _pInt("screen_avail_top", 0));
    _defProtoGetter(_ScreenProto, 'colorDepth', () => _pInt("screen_color_depth", 24));
    _defProtoGetter(_ScreenProto, 'pixelDepth', () => _pInt("screen_color_depth", 24));
    _defProtoGetter(_ScreenProto, 'orientation', () => _screenOrientation);
    _defProtoGetter(_ScreenProto, 'isExtended', () => false);
    Object.defineProperty(_ScreenProto, Symbol.toStringTag, { value: "Screen", configurable: true });
    Object.defineProperty(ScreenOrientation.prototype, Symbol.toStringTag, { value: "ScreenOrientation", configurable: true });
    const _screenInstance = Object.create(_ScreenProto);
    Object.defineProperty(globalThis, 'screen', {
        get: function() { return _screenInstance; },
        enumerable: true,
        configurable: true
    });

    // Misc globals scripts commonly check for
    // isSecureContext: per-URL, computed from scheme on the Rust side
    // (https/wss/file or http://localhost). Drives the ~18
    // secure-context-only Web Platform APIs at IDL `[SecureContext]`.
    Object.defineProperty(globalThis, 'isSecureContext', {
        get: () => ops.op_is_secure_context(),
        configurable: true,
        enumerable: true,
    });
    // crossOriginIsolated must reflect actual COOP+COEP state from the
    // response headers — see crates/browser_oxide/src/net/headers.rs.
    // Backed by an op so it's true iff the runtime was constructed with
    // BrowserRuntimeOptions { cross_origin_isolated: true, .. }.
    Object.defineProperty(globalThis, 'crossOriginIsolated', {
        get: () => ops.op_cross_origin_isolated(),
        configurable: true,
        enumerable: true,
    });
    Object.defineProperty(globalThis, 'origin', {
        get() { return globalThis.location ? globalThis.location.origin : "null"; },
        configurable: true, enumerable: true,
    });
    // Window metrics must resolve LAZILY — bootstrap runs at V8-snapshot
    // build time with no profile installed; eager values get baked as
    // defaults and never update when the profile loads.
    // A frame's viewport is the frame's own box, not the top-level window's.
    //
    // Every realm read `inner_width`/`inner_height` straight off the profile, so
    // a widget inside a 302x76 iframe was told it had the full 1536x713 window
    // to lay itself out in — and laid out for a window it did not have. The
    // engine writes the frame's measured box into the namespace (see
    // `ChildIframe::set_frame_geometry`); the top-level realm has none and falls
    // through to the profile.
    const _frameBox = () => {
        try {
            const syms = Object.getOwnPropertySymbols(globalThis, 1);
            for (let i = 0; i < syms.length; i++) {
                const v = globalThis[syms[i]];
                if (v && v.__bo) return v.frame || null;
            }
        } catch (_e) { /* ignore */ }
        return null;
    };
    Object.defineProperty(globalThis, 'innerWidth', {
        get: () => { const f = _frameBox(); return f ? f.w : _pInt("inner_width", 1920); },
        configurable: true, enumerable: true,
    });
    Object.defineProperty(globalThis, 'innerHeight', {
        get: () => { const f = _frameBox(); return f ? f.h : _pInt("inner_height", 1080); },
        configurable: true, enumerable: true,
    });
    Object.defineProperty(globalThis, 'outerWidth',  { get: () => _pInt("outer_width", 1920),   configurable: true, enumerable: true });
    Object.defineProperty(globalThis, 'outerHeight', { get: () => _pInt("outer_height", 1080),  configurable: true, enumerable: true });
    Object.defineProperty(globalThis, 'devicePixelRatio', { get: _maskFunction(function() { return _pFloat("device_pixel_ratio", 2.0); }, 'get devicePixelRatio'), configurable: true, enumerable: true });

    // Scroll + screen position — OWN accessor properties on the window
    // instance (globalThis), per real Chrome (verified against a real
    // browser):
    //
    //   Object.getOwnPropertyDescriptor(window, 'scrollX')
    //     → { get: f, set: f, enumerable: true, configurable: true }
    //   Object.getOwnPropertyDescriptor(Window.prototype, 'scrollX')
    //     → undefined (NOT on the prototype)
    //
    // The Phase 6 D2 attempt put them on Window.prototype based on a
    // wrong reading of the spec; Phase 7 reverts that.
    //
    // Backing storage is module-scope state, mutated by scrollTo()/
    // scrollBy(). screenX/Y are always 0 on a windowless engine.
    let _scrollX = 0;
    let _scrollY = 0;

    Object.defineProperty(globalThis, 'scrollX', {
        get: function() { return _scrollX; },
        set: function(_v) { /* read-only per spec; setter exists in descriptor */ },
        enumerable: true, configurable: true,
    });
    Object.defineProperty(globalThis, 'scrollY', {
        get: function() { return _scrollY; },
        set: function(_v) {},
        enumerable: true, configurable: true,
    });
    Object.defineProperty(globalThis, 'pageXOffset', {
        get: function() { return _scrollX; },
        set: function(_v) {},
        enumerable: true, configurable: true,
    });
    Object.defineProperty(globalThis, 'pageYOffset', {
        get: function() { return _scrollY; },
        set: function(_v) {},
        enumerable: true, configurable: true,
    });
    // The virtual window sits in the screen's available area, which is where a
    // real one opens: flush left, below whatever the OS reserves at the top.
    // Pinning both to 0 contradicted a profile whose `screen.availTop` is not
    // zero — a menu bar the window would have to be sitting under.
    Object.defineProperty(globalThis, 'screenX', {
        get: function() { return 0; },
        set: function(_v) {},
        enumerable: true, configurable: true,
    });
    Object.defineProperty(globalThis, 'screenY', {
        get: function() {
            try {
                const t = globalThis.screen && globalThis.screen.availTop;
                return typeof t === 'number' ? t : 0;
            } catch (_e) { return 0; }
        },
        set: function(_v) {},
        enumerable: true, configurable: true,
    });
    Object.defineProperty(globalThis, 'screenLeft', {
        get: function() { return 0; },
        set: function(_v) {},
        enumerable: true, configurable: true,
    });
    Object.defineProperty(globalThis, 'screenTop', {
        get: function() { return 0; },
        set: function(_v) {},
        enumerable: true, configurable: true,
    });
    // window.mozInnerScreenX / mozInnerScreenY are Gecko-only (CSS-px
    // coordinates of the content viewport's top-left). Their absence under a
    // Firefox UA is a tell, so expose them on the Firefox profile. X is 0 on a
    // windowless engine; Y reflects the browser chrome height (~74 CSS px).
    if (_isFirefox()) {
        Object.defineProperty(globalThis, 'mozInnerScreenX', {
            get: function() { return 0; }, enumerable: true, configurable: true,
        });
        Object.defineProperty(globalThis, 'mozInnerScreenY', {
            get: function() { return 74; }, enumerable: true, configurable: true,
        });
    }

    globalThis.scrollTo = ({
        scrollTo(xOrOptions, y) {
            if (typeof xOrOptions === "object" && xOrOptions !== null) {
                _scrollX = xOrOptions.left || 0;
                _scrollY = xOrOptions.top || 0;
            } else {
                _scrollX = xOrOptions || 0;
                _scrollY = y || 0;
            }
        }
    }).scrollTo;
    _maskFunction(globalThis.scrollTo, 'scrollTo');

    globalThis.scroll = globalThis.scrollTo;

    globalThis.scrollBy = ({
        scrollBy(xOrOptions, y) {
            if (typeof xOrOptions === "object" && xOrOptions !== null) {
                globalThis.scrollTo(_scrollX + (xOrOptions.left || 0), _scrollY + (xOrOptions.top || 0));
            } else {
                globalThis.scrollTo(_scrollX + (xOrOptions || 0), _scrollY + (y || 0));
            }
        }
    }).scrollBy;
    _maskFunction(globalThis.scrollBy, 'scrollBy');

    // window.chrome (CRITICAL — commonly checked object).
    //
    // Real Chrome: `window.chrome` is a special non-configurable plain
    // object; it is NOT wrapped in a named class like Navigator/Screen.
    // Its sub-namespaces (chrome.app, chrome.runtime, chrome.csi,
    // chrome.loadTimes) are also plain objects, but `chrome.loadTimes`
    // and `chrome.csi` are actual native functions whose .toString()
    // returns the native-code shape.
    //
    // Probes to defend:
    // 1. typeof chrome === 'object'
    // 2. chrome.loadTimes.toString() contains '[native code]'
    // 3. chrome.csi.toString() contains '[native code]'
    // 4. chrome.runtime.onMessage / onConnect presence for extension contexts
    // 5. Object.getOwnPropertyNames(chrome).length > 0 in real Chrome,
    //    so leaving chrome as a plain object here is CORRECT — we don't
    //    want zero own properties like navigator.
    const _chromeCsi = ({
        csi() {
            return { startE: Date.now(), onloadT: Date.now(), pageT: Date.now(), tran: 15 };
        }
    }).csi;
    _maskFunction(_chromeCsi, 'csi');

    const _chromeLoadTimes = ({
        loadTimes() {
            // For HTTP/2 pages these are true/"h2"; for about:blank/non-HTTP they are false/"".
            const _isHttp = globalThis.location && /^https?:/.test(globalThis.location.protocol);
            return {
                commitLoadTime: Date.now()/1000,
                connectionInfo: _isHttp ? "h2" : "",
                finishDocumentLoadTime: Date.now()/1000,
                finishLoadTime: Date.now()/1000,
                firstPaintAfterLoadTime: 0,
                firstPaintTime: Date.now()/1000,
                navigationType: "Other",
                npnNegotiatedProtocol: _isHttp ? "h2" : "",
                requestTime: Date.now()/1000,
                startLoadTime: Date.now()/1000,
                wasAlternateProtocolAvailable: _isHttp,
                wasFetchedViaSpdy: _isHttp,
                wasNpnNegotiated: _isHttp,
            };
        }
    }).loadTimes;
    _maskFunction(_chromeLoadTimes, 'loadTimes');

    // Real Chrome 147 on a regular page (no extensions): {app, csi, loadTimes}
    // chrome.runtime is ONLY present in extension contexts — absent on regular pages.
    // chrome.webstore was removed in Chrome 126.
    // Adding either is a classic bot-detection signal.
    // iOS Safari and Firefox MUST NOT have `window.chrome` — a
    // `('chrome' in window)` check against an iOS or Firefox UA would flag
    // it instantly.
    if (!_isMobileIOS() && !_isFirefox()) {
        globalThis.chrome = {
            app: {
                isInstalled: false,
                InstallState: {DISABLED:"disabled",INSTALLED:"installed",NOT_INSTALLED:"not_installed"},
                RunningState: {CANNOT_RUN:"cannot_run",READY_TO_RUN:"ready_to_run",RUNNING:"running"},
                // Chrome 147 exposes these functions on chrome.app (commonly checked):
                getDetails: function getDetails() { return null; },
                getIsInstalled: function getIsInstalled() { return false; },
                installState: function installState(cb) { if (typeof cb === 'function') setTimeout(() => cb('not_installed'), 0); },
                runningState: function runningState() { return 'cannot_run'; },
            },
            csi: _chromeCsi,
            loadTimes: _chromeLoadTimes,
        };
    }

    // --- Document visibility/hidden stubs ---
    Object.defineProperty(Document.prototype, 'visibilityState', { get() { return 'visible'; }, enumerable: false, configurable: true });
    Object.defineProperty(Document.prototype, 'hidden', { get() { return false; }, enumerable: false, configurable: true });
    Object.defineProperty(Document.prototype, 'webkitVisibilityState', { get() { return 'visible'; }, enumerable: false, configurable: true });
    Object.defineProperty(Document.prototype, 'webkitHidden', { get() { return false; }, enumerable: false, configurable: true });

    if (globalThis.navigator) {
        // Match Chrome 148's exact descriptor for webdriver:
        //   { get: ƒ, set: undefined, enumerable: true, configurable: true }
        // Some scripts verify the enumerable bit
        // specifically — the older `enumerable: false`
        // here was a divergence. Real Chrome's webdriver getter is
        // owned-on-prototype and IS enumerable (visible to for..in on
        // Navigator.prototype).
        // webdriver: defined identically to the Navigator.prototype block
        // above — `false` (Chrome-148-faithful).
        Object.defineProperty(_NavProto, 'webdriver', {
            // Arrow, like every other navigator getter here: a plain function
        // expression carries a `prototype` and is constructible, and a native
        // getter is neither. `Object.getOwnPropertyNames(get)` read
        // `length,name,prototype` against `length,name` everywhere else — a
        // difference that names this one property as the patched one.
        get: _maskFunction(_navBrand(() => false), 'get webdriver'),
            enumerable: true,
            configurable: true
        });

        // navigator.plugins / mimeTypes are defined at the top of this file
        // (search for _allPlugins). Count is driven by profile.plugins_count
        // and profile.mime_types_count. Do not override here.
    }

    // NOTE: real Chrome has NO `navigator.devicePixelRatio` — verified
    // CDP-free (`'devicePixelRatio' in navigator` === false,
    // getOwnPropertyDescriptor(navigator,'devicePixelRatio') === undefined).
    // devicePixelRatio is a Window-only property. The previous
    // `_defNav('devicePixelRatio', …)` added a property no real browser
    // exposes — observable via
    // `getOwnPropertyDescriptor(navigator,'devicePixelRatio')`.
    // Removed for parity.

    if (globalThis.Screen) {
        const _ScreenProto = Screen.prototype;
        _defProtoGetter(_ScreenProto, 'availLeft', () => 0);
        _defProtoGetter(_ScreenProto, 'availTop', () => _pInt("screen_avail_top", 0));
        _defProtoGetter(_ScreenProto, 'colorDepth', () => _pInt("screen_color_depth", 24));
        _defProtoGetter(_ScreenProto, 'pixelDepth', () => _pInt("screen_color_depth", 24));
    }


    const _hunt = (obj, name) => {
        return obj;
    };
    globalThis.navigator = _hunt(globalThis.navigator, 'navigator');
    globalThis.document = _hunt(globalThis.document, 'document');
    // Only re-bind chrome where it was actually installed — assigning
    // `undefined` would still create a `chrome` own property and trip
    // a `('chrome' in window)` check on iOS or Firefox.
    if (!_isMobileIOS() && !_isFirefox()) {
        globalThis.chrome = _hunt(globalThis.chrome, 'chrome');
    }
    globalThis.performance = _hunt(globalThis.performance, 'performance');

    // navigator.userAgentData (Client Hints API)
    //
    // Every hint reads from the StealthProfile at call-time so HTTP
    // Sec-CH-UA-* headers and the JS surface never diverge (a classic
    // fingerprint scoring axis). Eager
    // reads at bootstrap time would capture defaults because the V8
    // snapshot is built with no profile installed.
    //
    // Chrome exposes low-entropy fields synchronously (brands, mobile,
    // platform). High-entropy values go through getHighEntropyValues()
    // which returns a Promise and rejects on invalid descriptor shape.
    {
        const _navUaData = _svc.make(globalThis.NavigatorUAData);
        _defNav('userAgentData', () => (_isFirefox() ? undefined : (_secure() ? _navUaData : undefined)));
    }

    // Notification
    // globalThis.Notification = class Notification { static permission = "default"; };

    // Worker / SharedWorker / ServiceWorker classes. Our runtime has a
    // crates/workers module but doesn't auto-expose the constructor to JS.
    // Several fingerprint probes check `typeof Worker === 'function'` as a
    // presence test, and some spawn a Worker to cross-check navigator.
    // This is a minimal stub that lets fingerprint probes pass their
    // Real Worker — spawns an OS thread with its own V8 isolate, drives
    // a poll loop that delivers parent←worker messages to onmessage.
    if (!globalThis.Worker) {
        const _wops = Deno.core.ops;

        function _resolveWorkerScript(url) {
            const s = String(url);
            if (s.startsWith('blob:')) {
                try { return _wops.op_blob_fetch_text(s) || ''; } catch (e) { return ''; }
            }
            // Anything not already absolute is resolved against the document's
            // base, the same as any other subresource URL.
            //
            // This used to read a base off a `__browser_oxide` global that the
            // cleanup pass deletes, so it was always empty and *every* relative
            // worker URL failed — `new Worker('./worker.js')`, the most common
            // form there is, fired an error event instead of starting.
            // `new URL(…, base)` also covers the shapes the old prefix-join got
            // wrong: root-relative `/w.js` and protocol-relative `//host/w.js`.
            let full = s;
            if (!/^https?:/i.test(s)) {
                try {
                    const base = (typeof document !== 'undefined' && document.baseURI)
                        || (typeof location !== 'undefined' && location.href) || '';
                    if (!base) return '';
                    full = new URL(s, base).href;
                } catch (e) { return ''; }
            }
            if (/^https?:/i.test(full)) {
                try { return _wops.op_worker_sync_fetch(full) || ''; } catch (e) { return ''; }
            }
            return '';
        }

        globalThis.Worker = class Worker extends EventTarget {
            constructor(scriptURL, options) {
                super();
                _idl.own(this)._url = String(scriptURL);
                _idl.own(this)._options = options || {};
                _idl.own(this)._name = (options && options.name) || '';
                // `type: 'module'` enables ES module semantics for the
                // worker body (import.meta.url, async module eval,
                // top-level await). Default is 'classic'.
                _idl.own(this)._type = (options && options.type) || 'classic';
                const isModule = _idl.own(this)._type === 'module';
                // The handler attributes are accessors on Worker.prototype,
                // as in Chrome; assigning them here would leave own properties
                // on an object that has none in a real browser.

                const script = _resolveWorkerScript(_idl.own(this)._url);
                if (!script) {
                    // Script resolution failed; defer to next tick and fire error.
                    _idl.own(this)._id = 0;
                    const self = this;
                    Promise.resolve().then(() => {
                        _dispatchTo(self, 'error', {
                            message: 'Worker script could not be resolved: ' + _idl.own(self)._url,
                            filename: _idl.own(self)._url,
                            lineno: 0,
                            colno: 0,
                        });
                    });
                    return;
                }

                // Pass the resolved script URL so the
                // worker realm can install `self.location` consistent
                // with real Chrome's WorkerLocation. Some workers
                // read `self.location.origin` to
                // gate execution; empty location silently bails.
                _idl.own(this)._id = _wops.op_worker_spawn(script, _idl.own(this)._name, isModule, _idl.own(this)._url);
                if (_idl.own(this)._id <= 0) {
                    _idl.own(this)._id = 0;
                    return;
                }

                // W5b-deep fix (commit pending): replace the prior
                // setInterval(5) polling with an async-await chain
                // backed by op_worker_await_message. The old impl
                // pinned the V8 event loop's `is_pending=true` for the
                // lifetime of every Worker, blocking SPA hydration
                // completion detection (twitter, x.com, etc.). The new
                // pump suspends on a tokio::sync::Notify so the loop
                // is only marked pending while there's an actual
                // pending message — same correctness, no perpetual
                // pinning.
                const self = this;
                const _drainOnce = () => {
                    if (!_idl.own(self)._id) return;
                    _wops.op_worker_await_message(_idl.own(self)._id).then((raw) => {
                        if (!raw || !_idl.own(self)._id) return; // worker died
                        const deserializer =
                            _browser_oxide && _browser_oxide.deserializeFromWire;
                        let payload = null;
                        try { payload = JSON.parse(raw); }
                        catch (e) { return _drainOnce(); }
                        // An uncaught error in the worker arrives on the same
                        // channel, told apart by its key. Without this a worker
                        // that threw on its first line was indistinguishable
                        // from one that is simply still working.
                        if (payload && payload.error) {
                            const err = payload.error;
                            try {
                                _dispatchTo(self, 'error', {
                                    message: String(err.message || ''),
                                    filename: String(err.filename || ''),
                                    lineno: err.lineno | 0,
                                    colno: err.colno | 0,
                                });
                            } catch (_) {}
                            return _drainOnce();
                        }
                        const data = deserializer
                            ? deserializer(payload && payload.data)
                            : payload && payload.data;
                        try { _dispatchTo(self, 'message', { data, origin: '', lastEventId: '', source: null, ports: [] }); }
                        catch (_) {}
                        _drainOnce(); // chain next await
                    }).catch(() => {});
                };
                _drainOnce();
            }

            postMessage(message, transfer) {
                if (!_idl.own(this)._id) return;
                // Transferables: accepted as an array. Each entry (an
                // ArrayBuffer or view) is reachable from the message
                // and will be serialized with it. Real browsers
                // detach the source after transfer — V8 detachment
                // isn't exposed here, so the source stays readable.
                // For fingerprint-shape probes this is acceptable.
                const transferList = Array.isArray(transfer) ? transfer : [];
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
                // Wire-serialize so ArrayBuffer/TypedArray/Map/Set/
                // Date/RegExp survive the JSON hop to the worker.
                let wire;
                try {
                    wire =
                        (_browser_oxide &&
                            _browser_oxide.serializeForWire &&
                            _browser_oxide.serializeForWire(message)) ||
                        message;
                } catch (e) {
                    // DataCloneError (e.g. function inside message).
                    // Propagate to the caller so they see the same
                    // error Chrome would throw.
                    throw e;
                }
                let payload;
                try {
                    payload = JSON.stringify({ data: wire });
                } catch (_e) {
                    payload = JSON.stringify({ data: null });
                }
                _wops.op_worker_post_to_worker(_idl.own(this)._id, payload);
            }

            terminate() {
                if (_idl.own(this)._id) {
                    try { _wops.op_worker_terminate(_idl.own(this)._id); } catch (e) {}
                    _idl.own(this)._id = 0;
                }
                if (this._pollTimer) {
                    clearInterval(this._pollTimer);
                    this._pollTimer = null;
                }
            }

        };
        Object.defineProperty(globalThis.Worker.prototype, Symbol.toStringTag, {
            value: 'Worker',
            configurable: true,
        });
    }
    const _dispatchTo = (target, type, init) => {
        const Ctor = type === 'error' ? globalThis.ErrorEvent
            : (type === 'message' || type === 'messageerror') ? globalThis.MessageEvent
                : globalThis.Event;
        let ev;
        try { ev = new Ctor(type, init); } catch (_e) { ev = Object.assign({ type }, init); }
        let dispatched = false;
        try { dispatched = target.dispatchEvent(ev) !== undefined; } catch (_e) {}
        if (!dispatched) {
            const on = target['on' + type];
            if (typeof on === 'function') { try { on.call(target, ev); } catch (_e) {} }
        }
        return ev;
    };

    if (!globalThis.SharedWorker) {
        globalThis.SharedWorker = class SharedWorker extends EventTarget {
            #url;
            constructor(scriptURL, options) {
                super();
                const _st = _idl.own(this);
                _st.port = new MessageChannel().port1;
                this.onerror = null;
                this.#url = String(scriptURL);
            }
        };
    _idl.fields(SharedWorker.prototype, ["port"]);
    }
    if (!globalThis.ServiceWorker) {
        globalThis.ServiceWorker = class ServiceWorker extends EventTarget {
            constructor() {
                super();
                const _st = _idl.own(this);
                _st.scriptURL = "";
                _st.state = "activated";
                this.onstatechange = null;
            }
            postMessage() {}
        };
    _idl.fields(ServiceWorker.prototype, ["scriptURL", "state"]);
    }
    if (!globalThis.WorkerGlobalScope) {
        // WorkerGlobalScope is the class that Worker's `self` is an instance
        // of. fpCollect checks `typeof WorkerGlobalScope === 'function'`.
        globalThis.WorkerGlobalScope = class WorkerGlobalScope {};
    }
    if (!globalThis.DedicatedWorkerGlobalScope) {
        globalThis.DedicatedWorkerGlobalScope = class DedicatedWorkerGlobalScope extends globalThis.WorkerGlobalScope {};
    }

    // ================================================================
    // Batch 2: additional Web API stubs for fingerprint coverage
    // Chrome 131 exposes these as globals; fingerprint probes do
    // `typeof X === 'function'` checks against them.
    // ================================================================

    if (!globalThis.FileReader) {
        // Real FileReader — see shared_apis_bootstrap.js for the canonical
        // doc + rationale. This is the secondary install path used
        // when shared_apis hasn't run first.
        const _readerEncode2 = (bytes) => {
            let bin = '';
            const CHUNK = 0x8000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
            }
            return btoa(bin);
        };
        const _readerDispatch2 = (self, name) => {
            const ev = { target: self, type: name };
            if (self['on' + name]) setTimeout(() => self['on' + name](ev), 0);
        };
        globalThis.FileReader = class FileReader extends EventTarget {
            static EMPTY = 0;
            static LOADING = 1;
            static DONE = 2;
            constructor() {
                super();
                this.readyState = 0;
                this.result = null;
                this.error = null;
                this.onload = null;
                this.onloadstart = null;
                this.onloadend = null;
                this.onprogress = null;
                this.onerror = null;
                this.onabort = null;
            }
            readAsText(blob, encoding) {
                try {
                    const bytes = (blob && _idl.own(blob)._data) ? _idl.own(blob)._data : new Uint8Array(0);
                    const dec = new TextDecoder(encoding || 'utf-8');
                    this.result = dec.decode(bytes);
                } catch (e) { this.error = e; this.result = null; }
                this.readyState = 2;
                _readerDispatch2(this, 'load'); _readerDispatch2(this, 'loadend');
            }
            readAsDataURL(blob) {
                try {
                    const bytes = (blob && _idl.own(blob)._data) ? _idl.own(blob)._data : new Uint8Array(0);
                    const b64 = _readerEncode2(bytes);
                    const mime = (blob && blob.type) || 'application/octet-stream';
                    this.result = `data:${mime};base64,${b64}`;
                } catch (e) { this.error = e; this.result = null; }
                this.readyState = 2;
                _readerDispatch2(this, 'load'); _readerDispatch2(this, 'loadend');
            }
            readAsArrayBuffer(blob) {
                try {
                    const bytes = (blob && _idl.own(blob)._data) ? _idl.own(blob)._data : new Uint8Array(0);
                    const buf = new ArrayBuffer(bytes.byteLength);
                    new Uint8Array(buf).set(bytes);
                    this.result = buf;
                } catch (e) { this.error = e; this.result = null; }
                this.readyState = 2;
                _readerDispatch2(this, 'load'); _readerDispatch2(this, 'loadend');
            }
            readAsBinaryString(blob) {
                try {
                    const bytes = (blob && _idl.own(blob)._data) ? _idl.own(blob)._data : new Uint8Array(0);
                    let bin = '';
                    const CHUNK = 0x8000;
                    for (let i = 0; i < bytes.length; i += CHUNK) {
                        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
                    }
                    this.result = bin;
                } catch (e) { this.error = e; this.result = null; }
                this.readyState = 2;
                _readerDispatch2(this, 'load'); _readerDispatch2(this, 'loadend');
            }
            abort() { this.readyState = 2; _readerDispatch2(this, 'abort'); _readerDispatch2(this, 'loadend'); }
        };
    }

    // ── ImageBitmap / createImageBitmap.
    //
    // These used to be stubs: `createImageBitmap()` resolved with an empty
    // `ImageBitmap` carrying no pixels at all. Nothing threw, so a page saw a
    // successful decode — and every later `ctx.drawImage(bitmap, …)` hit
    // drawImage's "unknown source" branch and silently drew nothing. A captcha
    // that decodes its challenge tiles through `createImageBitmap` therefore
    // painted its surface hundreds of times and left it fully transparent.
    //
    // The bitmap is backed by a real canvas surface, so `drawImage` reaches it
    // through the ordinary canvas-source path (`_canvasId`) with no new op.
    {
        const _bmp = new WeakMap();

        const ImageBitmap = class ImageBitmap {
            constructor() { throw new TypeError("Illegal constructor"); }
            get width() { const s = _bmp.get(this); return s ? s.w : 0; }
            get height() { const s = _bmp.get(this); return s ? s.h : 0; }
            close() { const s = _bmp.get(this); if (s) { s.w = 0; s.h = 0; s.canvas = null; } }
        };
        Object.defineProperty(ImageBitmap.prototype, Symbol.toStringTag, {
            value: "ImageBitmap", configurable: true,
        });
        // Read by CanvasRenderingContext2D.prototype.drawImage to find the
        // backing surface. Non-enumerable, like the canvas element's own.
        const _bmpCanvasId = (o) => {
            const st = _bmp.get(o);
            return st && st.canvas ? _idl.own(st.canvas)._canvasId : undefined;
        };
        if (_boNs) _boNs.bitmapCanvasId = _bmpCanvasId;
        globalThis.ImageBitmap = ImageBitmap;
        if (typeof _maskFunction === "function") _maskFunction(ImageBitmap, "ImageBitmap");

        const _newCanvas = (w, h) => {
            let c = null;
            if (typeof document !== "undefined" && document && typeof document.createElement === "function") {
                c = document.createElement("canvas");
            } else if (typeof globalThis.OffscreenCanvas === "function") {
                try { c = new globalThis.OffscreenCanvas(w, h); } catch (_) { c = null; }
            }
            if (!c) return null;
            c.width = w; c.height = h;
            return c;
        };

        const _newImage = () => {
            if (typeof globalThis.Image === "function") return new globalThis.Image();
            if (typeof document !== "undefined" && document && typeof document.createElement === "function") {
                return document.createElement("img");
            }
            return null;
        };

        // Resolve any accepted source into something drawImage understands:
        // a decoded <img> or a canvas surface.
        const _drawable = async (src) => {
            if (!src || (typeof src !== "object" && typeof src !== "function")) {
                throw new TypeError(
                    "Failed to execute 'createImageBitmap' on 'Window': The provided value is not of type '(HTMLImageElement or SVGImageElement or HTMLVideoElement or HTMLCanvasElement or Blob or ImageData or ImageBitmap or OffscreenCanvas)'");
            }
            if (_idl.own(src)._canvasId !== undefined || _bmpCanvasId(src) !== undefined) return src;
            if (_boNs && _boNs.decodedImageId && _boNs.decodedImageId(src) >= 0) return src;
            // An <img> still in flight.
            if (typeof src.decode === "function" && "src" in src) {
                await src.decode();
                return src;
            }
            // ImageData.
            if (src.data && (src.width | 0) > 0 && (src.height | 0) > 0) {
                const c = _newCanvas(src.width | 0, src.height | 0);
                const cx = c && c.getContext("2d");
                if (!cx) throw new DOMException("The source image could not be decoded.", "InvalidStateError");
                cx.putImageData(src, 0, 0);
                return c;
            }
            // Blob / File — decoded by loading it through an <img>.
            if (typeof src.arrayBuffer === "function" || typeof src.size === "number") {
                const img = _newImage();
                if (!img || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
                    throw new DOMException("The source image could not be decoded.", "InvalidStateError");
                }
                const url = URL.createObjectURL(src);
                try {
                    img.src = url;
                    if (typeof img.decode === "function") await img.decode();
                    else await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
                } finally {
                    try { URL.revokeObjectURL(url); } catch (_) {}
                }
                return img;
            }
            throw new TypeError(
                "Failed to execute 'createImageBitmap' on 'Window': The provided value is not of type '(HTMLImageElement or SVGImageElement or HTMLVideoElement or HTMLCanvasElement or Blob or ImageData or ImageBitmap or OffscreenCanvas)'");
        };

        const _makeBitmap = async (args) => {
            const source = args[0];
            // (image[, options]) and (image, sx, sy, sw, sh[, options]).
            const cropped = args.length >= 5;
            const opts = (cropped ? args[5] : args[1]) || {};

            const d = await _drawable(source);
            const nw = d.naturalWidth || d.width || 0;
            const nh = d.naturalHeight || d.height || 0;
            if (!nw || !nh) {
                throw new DOMException("The source image could not be decoded.", "InvalidStateError");
            }

            let sx = cropped ? (args[1] | 0) : 0;
            let sy = cropped ? (args[2] | 0) : 0;
            let sw = cropped ? (args[3] | 0) : nw;
            let sh = cropped ? (args[4] | 0) : nh;
            if (sw < 0) { sx += sw; sw = -sw; }
            if (sh < 0) { sy += sh; sh = -sh; }
            if (!sw || !sh) {
                throw new RangeError(
                    "Failed to execute 'createImageBitmap' on 'Window': The crop rect width is 0.");
            }

            let ow = opts.resizeWidth | 0;
            let oh = opts.resizeHeight | 0;
            if (ow && !oh) oh = Math.max(1, Math.round(sh * (ow / sw)));
            else if (oh && !ow) ow = Math.max(1, Math.round(sw * (oh / sh)));
            else if (!ow && !oh) { ow = sw; oh = sh; }

            const c = _newCanvas(ow, oh);
            const cx = c && c.getContext("2d");
            if (!cx) throw new DOMException("The source image could not be decoded.", "InvalidStateError");
            if (opts.imageOrientation === "flipY") { cx.translate(0, oh); cx.scale(1, -1); }
            cx.drawImage(d, sx, sy, sw, sh, 0, 0, ow, oh);

            const bm = Object.create(ImageBitmap.prototype);
            _bmp.set(bm, { w: ow, h: oh, canvas: c });
            return bm;
        };

        // Chrome's is a plain native function of length 1 that returns a
        // promise — not an async function, whose prototype would give it away.
        const createImageBitmap = function createImageBitmap(image) {
            try { return _makeBitmap(arguments); } catch (e) { return Promise.reject(e); }
        };
        globalThis.createImageBitmap = createImageBitmap;
        if (typeof _maskFunction === "function") _maskFunction(createImageBitmap, "createImageBitmap");
    }

    // Path2D DELIBERATELY NOT STUBBED. Our JS-class stub creates non-native
    // method descriptors observable via `Object
    // .getOwnPropertyDescriptor(Path2D.prototype, 'addPath')` — a class
    // method is a data descriptor, real Chrome's is a native accessor.
    // Better to report `typeof Path2D === 'undefined'` than to expose a
    // stub whose descriptors differ from real Chrome.

    // Streams, channels, EventSource, compression — second batch-2 block
    if (!globalThis.ReadableStream) {
        globalThis.ReadableStream = class ReadableStream {
            constructor() { this.locked = false; }
            getReader() { return { read: () => Promise.resolve({ done: true, value: undefined }), releaseLock() {}, closed: Promise.resolve(), cancel: () => Promise.resolve() }; }
            pipeTo() { return Promise.resolve(); }
            pipeThrough(t) { return t.readable; }
            tee() { return [new ReadableStream(), new ReadableStream()]; }
            cancel() { return Promise.resolve(); }
        };
    }
    if (!globalThis.WritableStream) {
        globalThis.WritableStream = class WritableStream {
            constructor() { this.locked = false; }
            getWriter() { return { write: () => Promise.resolve(), close: () => Promise.resolve(), abort: () => Promise.resolve(), releaseLock() {}, closed: Promise.resolve(), ready: Promise.resolve() }; }
            close() { return Promise.resolve(); }
            abort() { return Promise.resolve(); }
        };
    }
    if (!globalThis.TransformStream) {
        globalThis.TransformStream = class TransformStream {
            constructor() {
                this.readable = new globalThis.ReadableStream();
                this.writable = new globalThis.WritableStream();
            }
        };
    }
    if (!globalThis.ReadableStreamDefaultReader) globalThis.ReadableStreamDefaultReader = class ReadableStreamDefaultReader {};
    if (!globalThis.WritableStreamDefaultWriter) globalThis.WritableStreamDefaultWriter = class WritableStreamDefaultWriter {};




    // end batch 2

    // speechSynthesis — prototype-backed; bot tests check getVoices().length > 0
    class SpeechSynthesis {}
    globalThis.SpeechSynthesis = SpeechSynthesis;
    const _SSProto = SpeechSynthesis.prototype;
    const _ssVoices = [
        {name:"Google US English",lang:"en-US",localService:false,default:true,voiceURI:"Google US English"},
        {name:"Google UK English Female",lang:"en-GB",localService:false,default:false,voiceURI:"Google UK English Female"},
        {name:"Google UK English Male",lang:"en-GB",localService:false,default:false,voiceURI:"Google UK English Male"},
    ];
    _defProtoGetter(_SSProto, 'pending', () => false);
    _defProtoGetter(_SSProto, 'speaking', () => false);
    _defProtoGetter(_SSProto, 'paused', () => false);
    // Event handler attribute, so it has a setter: assigning to a getter-only
    // property throws in strict mode, and `speechSynthesis.onvoiceschanged = fn`
    // is the ordinary way to wait for the voice list. A page that does it gets
    // a TypeError out of a line that cannot fail in a browser.
    const _ssVoicesChanged = new WeakMap();
    _defProtoGetter(
        _SSProto,
        'onvoiceschanged',
        function onvoiceschanged() { return _ssVoicesChanged.get(this) || null; },
        function onvoiceschanged(fn) {
            _ssVoicesChanged.set(this, typeof fn === "function" ? fn : null);
        },
    );
    _defProtoMethod(_SSProto, 'getVoices', function getVoices() { return _ssVoices.slice(); });
    _defProtoMethod(_SSProto, 'speak', function speak() {});
    _defProtoMethod(_SSProto, 'cancel', function cancel() {});
    _defProtoMethod(_SSProto, 'pause', function pause() {});
    _defProtoMethod(_SSProto, 'resume', function resume() {});
    Object.defineProperty(_SSProto, Symbol.toStringTag, { value: "SpeechSynthesis", configurable: true });
    globalThis.speechSynthesis = Object.create(_SSProto);

    // Performance stub state — installed on Performance.prototype below.
    const _perfMemory = {
        jsHeapSizeLimit: 4294705152,
        totalJSHeapSize: 10000000,
        usedJSHeapSize: 8000000,
    };

    // Intl timezone and locale: nothing to patch here. The runtime sets the
    // profile's zone and locale as ICU's defaults before bootstrap
    // (`js_runtime/intl.rs`), which is where V8 reads local time, the `Intl`
    // defaults and every `toLocale*String` — so the natives stay untouched and
    // cannot disagree with each other.

    // =========================================================
    // PerformanceNavigationTiming + PerformanceResourceTiming
    // Some scripts read performance.getEntriesByType
    // ('navigation') and ('resource') to verify timing consistency against
    // expected Chrome distributions. Returning empty arrays differs from
    // a real browser.
    //
    // We synthesize a realistic set of entries based on the time the page
    // has been loaded, with sub-timings that look like a real Chrome on
    // broadband.
    // =========================================================
    if (globalThis.performance) {
        // Anchor performance.timeOrigin to the
        // Rust-side PerfState origin (wall-clock at the moment t=0 was
        // captured for op_perf_now_humanized). This preserves the Web
        // Platform invariant `timeOrigin + performance.now() ≈ Date.now()`
        // that some scripts check. Before the fix, the local
        // `Date.now() - loadEventEnd` computation drifted out of sync with
        // the Rust monotonic clock.
        const _perfOrigin = (() => {
            try {
                const v = ops && ops.op_perf_time_origin_ms
                    && ops.op_perf_time_origin_ms();
                if (typeof v === 'number' && isFinite(v) && v > 0) return v;
            } catch (e) {}
            return Date.now();
        })();
        // Navigation timing constants (relative to the navigation start)
        const _perfNav = {
            name: globalThis.location?.href || "about:blank",
            entryType: "navigation",
            startTime: 0,
            duration: 0,
            initiatorType: "navigation",
            nextHopProtocol: "h2",
            workerStart: 0,
            redirectStart: 0,
            redirectEnd: 0,
            fetchStart: 0.1,
            domainLookupStart: 2.1,
            domainLookupEnd: 15.2,
            connectStart: 15.2,
            secureConnectionStart: 28.5,
            connectEnd: 78.3,
            requestStart: 78.4,
            responseStart: 145.6,
            responseEnd: 189.2,
            transferSize: 45678,
            encodedBodySize: 45000,
            decodedBodySize: 156789,
            serverTiming: [],
            unloadEventStart: 0,
            unloadEventEnd: 0,
            domInteractive: 320.5,
            domContentLoadedEventStart: 325.1,
            domContentLoadedEventEnd: 328.7,
            domComplete: 512.3,
            loadEventStart: 512.3,
            loadEventEnd: 515.9,
            type: "navigate",
            redirectCount: 0,
            activationStart: 0,
        };
        const _perfTimingStart = _perfOrigin - Math.round(_perfNav.loadEventEnd);
        const _perfTiming = {
            navigationStart: _perfTimingStart,
            unloadEventStart: 0,
            unloadEventEnd: 0,
            redirectStart: 0,
            redirectEnd: 0,
            fetchStart: _perfTimingStart + Math.round(_perfNav.fetchStart),
            domainLookupStart: _perfTimingStart + Math.round(_perfNav.domainLookupStart),
            domainLookupEnd: _perfTimingStart + Math.round(_perfNav.domainLookupEnd),
            connectStart: _perfTimingStart + Math.round(_perfNav.connectStart),
            connectEnd: _perfTimingStart + Math.round(_perfNav.connectEnd),
            secureConnectionStart: _perfTimingStart + Math.round(_perfNav.secureConnectionStart),
            requestStart: _perfTimingStart + Math.round(_perfNav.requestStart),
            responseStart: _perfTimingStart + Math.round(_perfNav.responseStart),
            responseEnd: _perfTimingStart + Math.round(_perfNav.responseEnd),
            domLoading: _perfTimingStart + Math.round(_perfNav.responseStart),
            domInteractive: _perfTimingStart + Math.round(_perfNav.domInteractive),
            domContentLoadedEventStart: _perfTimingStart + Math.round(_perfNav.domContentLoadedEventStart),
            domContentLoadedEventEnd: _perfTimingStart + Math.round(_perfNav.domContentLoadedEventEnd),
            domComplete: _perfTimingStart + Math.round(_perfNav.domComplete),
            loadEventStart: _perfTimingStart + Math.round(_perfNav.loadEventStart),
            loadEventEnd: _perfTimingStart + Math.round(_perfNav.loadEventEnd),
        };
        const _perfNavigation = {
            type: 0,
            redirectCount: 0,
            TYPE_NAVIGATE: 0,
            TYPE_RELOAD: 1,
            TYPE_BACK_FORWARD: 2,
            TYPE_RESERVED: 255,
        };

        const _buildResourceEntries = () => {
            const entries = [];
            const origin = globalThis.location?.origin || "https://example.com";
            const base = _perfNav.fetchStart;
            let offset = 10;
            const _internalEntries = _browser_oxide.__perfResourceEntries || [];
            const _rustEntries = (ops.op_perf_get_resource_timings && ops.op_perf_get_resource_timings()) || [];
            // The DOM scan below (source of truth for a synthetic
            // `Page::from_html` page with no real fetches) and the Rust
            // navigation pipeline both know about the same `<script src>`/
            // `<link href>` sub-resources on a REAL navigation — without
            // this, every one of them showed up twice, once from each
            // source, with two different (and both partly fake) timings
            // for what real Chrome reports as a single fetch.
            const _rustNames = new Set(_rustEntries.map((rt) => rt.name));

            const mk = (name, startOffset, duration, type, size) => ({
                name,
                entryType: "resource",
                startTime: base + startOffset,
                duration,
                initiatorType: type,
                nextHopProtocol: "h2",
                workerStart: 0,
                redirectStart: 0,
                redirectEnd: 0,
                fetchStart: base + startOffset,
                domainLookupStart: base + startOffset,
                domainLookupEnd: base + startOffset,
                connectStart: base + startOffset,
                connectEnd: base + startOffset,
                secureConnectionStart: base + startOffset,
                requestStart: base + startOffset + 5,
                responseStart: base + startOffset + duration - 15,
                responseEnd: base + startOffset + duration,
                transferSize: size + 300,
                encodedBodySize: size,
                decodedBodySize: size * 3,
                serverTiming: [],
                renderBlockingStatus: "non-blocking",
            });

            // Also used to give `_rustEntries` (below) a real
            // `initiatorType` instead of a blanket "other" — real Chrome
            // reports "script"/"link" for exactly these DOM-sourced kinds.
            const _scriptSrcs = new Set();
            const _linkHrefs = new Set();
            const _linkStylesheets = new Set();
            const _imgSrcs = new Set();
            if (globalThis.document) {
                const scripts = globalThis.document.scripts || [];
                for (let i = 0; i < scripts.length; i++) {
                    if (scripts[i].src) _scriptSrcs.add(scripts[i].src);
                }
                // Chrome reports `initiatorType: "link"` for everything a
                // `<link>` pulls, not just stylesheets — `rel=preload` fonts
                // and `modulepreload` scripts land there too. That wider set
                // only *classifies* fetches that really happened; the
                // placeholder loop below stays on stylesheets, since inventing
                // an entry for a resource we never requested is its own lie.
                const links = globalThis.document.getElementsByTagName('link') || [];
                for (let i = 0; i < links.length; i++) {
                    const rel = (links[i].rel || '').toLowerCase();
                    if (!links[i].href) continue;
                    if (rel === 'stylesheet') _linkStylesheets.add(links[i].href);
                    if (rel === 'stylesheet' || rel === 'preload' || rel === 'modulepreload') {
                        _linkHrefs.add(links[i].href);
                    }
                }
                const images = globalThis.document.images || [];
                for (let i = 0; i < images.length; i++) {
                    if (images[i].src) _imgSrcs.add(images[i].src);
                }
                for (const src of _scriptSrcs) {
                    if (!_rustNames.has(src)) {
                        entries.push(mk(src, offset, 50, "script", 48600));
                        offset += 15;
                    }
                }
                for (const href of _linkStylesheets) {
                    if (!_rustNames.has(href)) {
                        entries.push(mk(href, offset, 30, "link", 12500));
                        offset += 10;
                    }
                }
                for (const src of _imgSrcs) {
                    if (!_rustNames.has(src)) {
                        entries.push(mk(src, offset, 80, "img", 25000));
                        offset += 20;
                    }
                }
            }

            for (const req of _internalEntries) {
                const sTime = req.startTime || (base + offset);
                const e = mk(req.url, sTime - base, req.duration || 100, req.type || "xmlhttprequest", req.size || 1024);
                e.startTime = sTime;
                e.fetchStart = sTime;
                e.domainLookupStart = sTime;
                e.domainLookupEnd = sTime;
                e.connectStart = sTime;
                e.connectEnd = sTime;
                e.secureConnectionStart = sTime;
                e.requestStart = sTime + 5;
                e.responseStart = sTime + (req.duration || 100) - 15;
                e.responseEnd = sTime + (req.duration || 100);
                entries.push(e);
                offset += Math.max(10, (req.duration || 100) * 0.1);
            }

            for (const rt of _rustEntries) {
                // Real `initiatorType`, not a blanket "other", when this
                // fetch corresponds to a `<script src>`/`<link
                // rel=stylesheet>` actually on the page — same distinction
                // real Chrome makes.
                const rtType = _scriptSrcs.has(rt.name) ? "script"
                    : _linkHrefs.has(rt.name) ? "link"
                    : _imgSrcs.has(rt.name) ? "img"
                    : "other";
                const e = mk(rt.name, 0, rt.duration, rtType, 0);
                e.startTime = rt.start_time;
                e.fetchStart = rt.fetch_start;
                e.domainLookupStart = rt.domain_lookup_start;
                e.domainLookupEnd = rt.domain_lookup_end;
                e.connectStart = rt.connect_start;
                e.connectEnd = rt.connect_end;
                e.secureConnectionStart = rt.secure_connection_start;
                e.requestStart = rt.request_start;
                e.responseStart = rt.response_start;
                e.responseEnd = rt.response_end;
                // `mk()` was built with size=0 above — the transfer-encoding
                // byte count (compressed on the wire) isn't tracked
                // separately from the decoded body, so rather than run it
                // through `mk()`'s size*3 placeholder ratio (fabricating a
                // *different* wrong number), report the one real figure we
                // have — decoded body bytes — and the closest honest
                // estimate for the other two: uncompressed-equivalent
                // (encodedBodySize = decodedBodySize) plus the same small
                // header-overhead constant `mk()` uses elsewhere in this
                // function. A real 0-byte fetch (204, HEAD) still reports
                // zeros for all three, same as `mk()`'s own default.
                if (rt.decoded_body_size > 0) {
                    e.decodedBodySize = rt.decoded_body_size;
                    e.encodedBodySize = rt.decoded_body_size;
                    e.transferSize = rt.decoded_body_size + 300;
                }
                entries.push(e);
            }

            if (entries.length === 0) {
                // Some scripts probe
                // `performance.getEntriesByType('resource').length` and
                // a near-empty list is a tell. Synthesize the typical
                // resource shape of a generic page: favicon + main JS
                // bundle + main CSS bundle + analytics ping + sw.
                entries.push(mk(`${origin}/favicon.ico`, 25, 42, "img", 1024));
                entries.push(mk(`${origin}/main.js`, 12, 87, "script", 58600));
                entries.push(mk(`${origin}/main.css`, 8, 33, "link", 14200));
                entries.push(mk(`${origin}/analytics.gif?t=` + (Date.now() % 1_000_000), 65, 18, "img", 35));
                entries.push(mk(`${origin}/sw.js`, 95, 14, "script", 1840));
            }
            return entries;
        };
        const _navEntry = () => {
            const entry = Object.assign({}, _perfNav);
            entry.duration = performance.now();
            
            if (globalThis.document && globalThis.document.readyState !== 'complete') {
                entry.domComplete = 0;
                entry.loadEventStart = 0;
                entry.loadEventEnd = 0;
            }
            if (globalThis.document && globalThis.document.readyState === 'loading') {
                entry.domInteractive = 0;
                entry.domContentLoadedEventStart = 0;
                entry.domContentLoadedEventEnd = 0;
            }
            
            return entry;
        };

        // ================================================================
        // Install on Performance.prototype — not on the instance.
        // ================================================================
        // deno_core only provides `performance.now()` natively; everything
        // else is our JS. Previously we assigned stubs directly to the
        // instance, which left 14 own properties (Chrome has zero) and
        // exposed raw JS source via `getEntries.toString()`. Now we build
        // a Performance class, install every accessor/method on the
        // prototype, reparent the existing performance instance to it,
        // and strip the legacy own properties.
        const _PerfProto = Performance.prototype;
        Object.defineProperty(_PerfProto, Symbol.toStringTag, { value: "Performance", configurable: true });

        // Preserve the native `now` before we reparent — deno_core installs
        // it as an own property on the instance with a native-code toString.
        const _origNow = globalThis.performance.now && globalThis.performance.now.bind(globalThis.performance);

        // Measured against Chrome 151 on this very page: the values are
        // byte-precise (38215185 / 33091241 — neither divisible by 100000),
        // identical across reads in one synchronous block, and they grow when
        // the page allocates. A previous note here claimed Chrome quantizes to
        // 100 KB buckets and rounded accordingly, which made every value we
        // reported a multiple of 100000 — something real Chrome never shows.
        //
        // V8's own heap totals have all three properties for free, so report
        // those. Refreshed on a coarse clock so a tight read loop sees one
        // stable value while the number still tracks real allocation.
        let _perfMemCache = null;
        let _perfMemAt = 0;
        const _PERF_MEM_TTL_MS = 1000;
        _defProtoGetter(_PerfProto, 'memory', () => {
            const now = Date.now();
            if (!_perfMemCache || now - _perfMemAt > _PERF_MEM_TTL_MS) {
                let total = 0;
                let used = 0;
                try {
                    const stats = ops.op_perf_heap_stats();
                    total = stats[0];
                    used = stats[1];
                } catch (_) {}
                if (total > 0 && used > 0) {
                    _perfMemCache = {
                        jsHeapSizeLimit: 4294705152,
                        totalJSHeapSize: total,
                        usedJSHeapSize: used,
                    };
                    _perfMemAt = now;
                }
            }
            return _perfMemCache;
        });
        _defProtoGetter(_PerfProto, 'timing', () => {
            const timing = Object.assign({}, _perfTiming);
            if (globalThis.document && globalThis.document.readyState !== 'complete') {
                timing.domComplete = 0;
                timing.loadEventStart = 0;
                timing.loadEventEnd = 0;
            }
            if (globalThis.document && globalThis.document.readyState === 'loading') {
                timing.domInteractive = 0;
                timing.domContentLoadedEventStart = 0;
                timing.domContentLoadedEventEnd = 0;
            }
            return timing;
        });
        // timeOrigin is the modern HRT epoch (t=0
        // for performance.now()), NOT the legacy navigationStart
        // (`_perfTimingStart`, which trails by ~loadEventEnd ms to
        // synthesize a plausible navigation timeline). The Web Platform
        // invariant `timeOrigin + performance.now() ≈ Date.now()` is
        // observable — only the live wall-clock at the
        // PerfState origin (per-page; the snapshot-captured `_perfOrigin`
        // is stale because the bootstrap runs at snapshot-build time)
        // satisfies it. Read the op on every access — cheap (returns a
        // stored f64) and keeps the invariant on the per-page PerfState.
        _defProtoGetter(_PerfProto, 'timeOrigin', () => {
            try {
                const v = ops && ops.op_perf_time_origin_ms
                    && ops.op_perf_time_origin_ms();
                if (typeof v === 'number' && isFinite(v) && v > 0) return v;
            } catch (e) {}
            return _perfOrigin;
        });
        _defProtoGetter(_PerfProto, 'navigation', () => _perfNavigation);
        {
            const slot = new WeakMap();
            _defProtoGetter(_PerfProto, 'onresourcetimingbufferfull',
                function () { return slot.get(this) || null; },
                function (v) { slot.set(this, typeof v === 'function' ? v : null); });
        }

        _defProtoMethod(_PerfProto, 'getEntries', function getEntries() {
            return [_navEntry(), ..._buildResourceEntries()];
        });
        _defProtoMethod(_PerfProto, 'getEntriesByType', function getEntriesByType(type) {
            if (type === "navigation") return [_navEntry()];
            if (type === "resource") {
                return globalThis.performance.getEntries().filter(e => e.entryType === 'resource');
            }
            if (type === "mark" || type === "measure") return [];
            if (type === "paint") {
                return [
                    { name: "first-paint", entryType: "paint", startTime: 156.3, duration: 0 },
                    { name: "first-contentful-paint", entryType: "paint", startTime: 189.7, duration: 0 },
                ];
            }
            return [];
        });
        _defProtoMethod(_PerfProto, 'getEntriesByName', function getEntriesByName(name, type) {
            return globalThis.performance
                .getEntries()
                .filter((e) => e.name === name && (!type || e.entryType === type));
        });
        _defProtoMethod(_PerfProto, 'mark', function mark(name) {
            return { name, entryType: "mark", startTime: performance.now(), duration: 0 };
        });
        _defProtoMethod(_PerfProto, 'measure', function measure(name, startMark, endMark) {
            return { name, entryType: "measure", startTime: 0, duration: 0 };
        });
        _defProtoMethod(_PerfProto, 'clearMarks', function clearMarks() {});
        _defProtoMethod(_PerfProto, 'clearMeasures', function clearMeasures() {});
        _defProtoMethod(_PerfProto, 'clearResourceTimings', function clearResourceTimings() {
            // No-op for now, as we dynamically fetch from document.
        });
        _defProtoMethod(_PerfProto, 'setResourceTimingBufferSize', function setResourceTimingBufferSize() {});
        _defProtoMethod(_PerfProto, 'toJSON', function toJSON() {
            // Read live via the op so a snapshot-
            // hosted value doesn't leak.
            let to = _perfOrigin;
            try {
                const v = ops && ops.op_perf_time_origin_ms
                    && ops.op_perf_time_origin_ms();
                if (typeof v === 'number' && isFinite(v) && v > 0) to = v;
            } catch (e) {}
            return { timeOrigin: to };
        });

        if (_origNow) {
            _defProtoMethod(_PerfProto, 'now', function now() { return _origNow(); });
        }

        // Reparent the existing performance instance onto Performance.prototype
        // and strip the legacy own properties. Matches real Chrome, which has
        // zero own properties on the performance instance.
        try {
            Object.setPrototypeOf(globalThis.performance, _PerfProto);
        } catch (e) { /* immutable proto — fall back below */ }
        for (const p of Object.getOwnPropertyNames(globalThis.performance)) {
            try { delete globalThis.performance[p]; } catch {}
        }
        // If setPrototypeOf failed (rare) we fall back to a fresh instance
        // that still exposes `now` via a captured closure.
        if (Object.getPrototypeOf(globalThis.performance) !== _PerfProto) {
            globalThis.performance = Object.create(_PerfProto);
        }
    }

    // ================================================================
    // Crypto / SubtleCrypto classes + prototype — kNoScriptId-safe.
    // ================================================================
    // Real Chrome exposes `window.crypto` as an instance of `Crypto`
    // with all methods on `Crypto.prototype` and a `subtle` accessor
    // returning an instance of `SubtleCrypto`. The `digest` method is
    // native-code backed; challenge scripts commonly call it to hash
    // challenge payloads (SHA-256 over TextEncoder-produced bytes).
    //
    // Previously we had `globalThis.crypto = {}` with `getRandomValues`
    // and `randomUUID` as own properties, and NO `subtle` at all —
    // causing `crypto.subtle.digest` to throw "Cannot read properties
    // of undefined (reading 'digest')". Now we expose full classes
    // backed by Rust ops for real SHA-1/256/384/512 digest.
    class Crypto {}
    globalThis.Crypto = Crypto;
    const _CryptoProto = Crypto.prototype;

    class SubtleCrypto {}
    globalThis.SubtleCrypto = SubtleCrypto;
    const _SubtleProto = SubtleCrypto.prototype;
    const _subtleInstance = Object.create(_SubtleProto);

    // Coerce BufferSource → Uint8Array for op bridging.
    const _toBytes = (src) => {
        if (src == null) return new Uint8Array(0);
        if (src instanceof Uint8Array) return src;
        if (src instanceof ArrayBuffer) return new Uint8Array(src);
        if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
        return new Uint8Array(src);
    };

    _defProtoMethod(_SubtleProto, 'digest', function digest(algorithm, data) {
        try {
            const algName = typeof algorithm === 'string' ? algorithm : (algorithm && algorithm.name) || "";
            const bytes = _toBytes(data);
            const out = ops.op_crypto_digest(String(algName), bytes);
            // Real Web Crypto returns a Promise<ArrayBuffer>.
            return Promise.resolve(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
        } catch (e) {
            return Promise.reject(e);
        }
    });
    // Stubs for sign/verify/encrypt/decrypt/generateKey/importKey/exportKey/deriveKey/deriveBits/wrapKey/unwrapKey.
    // Real implementations are expensive; most callers only use digest(),
    // so we expose the methods as native-shaped no-ops that reject.
    const _subtleNotImplemented = (name) => function (...args) {
        return Promise.reject(new DOMException(`${name} not implemented`, "NotSupportedError"));
    };
    for (const m of ['sign','verify','encrypt','decrypt','generateKey','importKey','exportKey','deriveKey','deriveBits','wrapKey','unwrapKey']) {
        _defProtoMethod(_SubtleProto, m, _subtleNotImplemented(m));
    }

    // Crypto.prototype.getRandomValues — backed by the Rust op.
    _defProtoMethod(_CryptoProto, 'getRandomValues', function getRandomValues(arr) {
        if (!ArrayBuffer.isView(arr)) {
            throw new TypeError("getRandomValues expects an ArrayBufferView");
        }
        if (arr.byteLength > 65536) {
            throw new DOMException("QuotaExceededError", "QuotaExceededError");
        }
        // We need a Uint8Array view to pass to the op.
        const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
        ops.op_crypto_random_fill(u8);
        return arr;
    });
    _defProtoMethod(_CryptoProto, 'randomUUID', function randomUUID() {
        // Generate 16 random bytes, then format per RFC 4122 v4.
        const b = new Uint8Array(16);
        ops.op_crypto_random_fill(b);
        b[6] = (b[6] & 0x0f) | 0x40; // version
        b[8] = (b[8] & 0x3f) | 0x80; // variant
        const hex = [];
        for (let i = 0; i < 16; i++) hex.push(b[i].toString(16).padStart(2, '0'));
        return `${hex.slice(0,4).join('')}-${hex.slice(4,6).join('')}-${hex.slice(6,8).join('')}-${hex.slice(8,10).join('')}-${hex.slice(10,16).join('')}`;
    });
    _defProtoGetter(_CryptoProto, 'subtle', () => _subtleInstance);

    Object.defineProperty(_CryptoProto, Symbol.toStringTag, { value: "Crypto", configurable: true });
    Object.defineProperty(_SubtleProto, Symbol.toStringTag, { value: "SubtleCrypto", configurable: true });

    // Reparent or create the crypto instance.
    let _cryptoInstance = Object.create(_CryptoProto);
    globalThis.crypto = _cryptoInstance;

    // ================================================================
    // TextEncoder / TextDecoder — Chrome-shaped, kNoScriptId-safe.
    // ================================================================
    // deno_core at our version ships without deno_web, so we have no
    // native TextEncoder. Our JS stub must match Chrome's exact shape
    // because some scripts probe it:
    //
    //   1. new TextEncoder().encoding === "utf-8"   (a GETTER on proto)
    //   2. TextEncoder.prototype.encodeInto exists
    //   3. TextEncoder.toString().includes("[native code]")
    //   4. TextEncoder.prototype.encode.toString().includes("[native code]")
    //   5. Object.getOwnPropertyDescriptor(TextEncoder.prototype, 'encoding')
    //      returns an accessor descriptor ({ get: ƒ, set: undefined, ... })
    //
    // Prior bug: we exposed a plain `class TextEncoder { encode(){...} }`,
    // which failed every one of these probes. A common failing probe
    // (the one that throws "Cannot read properties of undefined") is
    // `new TextEncoder().encoding.charCodeAt(0)` — `encoding`
    // was undefined, so `.charCodeAt` threw.
    if (!globalThis.TextEncoder || !TextEncoder.prototype.encodeInto) {
        class TextEncoder {
            constructor() {}
            encode(str) {
                str = String(str == null ? "" : str);
                const buf = [];
                for (let i = 0; i < str.length; i++) {
                    let c = str.charCodeAt(i);
                    // UTF-16 surrogate pair handling
                    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
                        const low = str.charCodeAt(i + 1);
                        if (low >= 0xDC00 && low <= 0xDFFF) {
                            c = 0x10000 + ((c - 0xD800) << 10) + (low - 0xDC00);
                            i++;
                        }
                    }
                    if (c < 0x80) {
                        buf.push(c);
                    } else if (c < 0x800) {
                        buf.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
                    } else if (c < 0x10000) {
                        buf.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
                    } else {
                        buf.push(
                            0xf0 | (c >> 18),
                            0x80 | ((c >> 12) & 0x3f),
                            0x80 | ((c >> 6) & 0x3f),
                            0x80 | (c & 0x3f),
                        );
                    }
                }
                return new Uint8Array(buf);
            }
            encodeInto(source, destination) {
                if (!(destination instanceof Uint8Array)) {
                    throw new TypeError("encodeInto destination must be a Uint8Array");
                }
                source = String(source == null ? "" : source);
                let read = 0;
                let written = 0;
                for (let i = 0; i < source.length; i++) {
                    let c = source.charCodeAt(i);
                    let extraChar = 0;
                    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < source.length) {
                        const low = source.charCodeAt(i + 1);
                        if (low >= 0xDC00 && low <= 0xDFFF) {
                            c = 0x10000 + ((c - 0xD800) << 10) + (low - 0xDC00);
                            extraChar = 1;
                        }
                    }
                    let bytes;
                    if (c < 0x80) bytes = [c];
                    else if (c < 0x800) bytes = [0xc0 | (c >> 6), 0x80 | (c & 0x3f)];
                    else if (c < 0x10000) bytes = [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)];
                    else bytes = [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)];
                    if (written + bytes.length > destination.length) break;
                    for (let j = 0; j < bytes.length; j++) destination[written + j] = bytes[j];
                    written += bytes.length;
                    read += 1 + extraChar;
                    if (extraChar) i++;
                }
                return { read, written };
            }
        }
        globalThis.TextEncoder = TextEncoder;
        // `encoding` is a GETTER on TextEncoder.prototype that always returns "utf-8".
        _defProtoGetter(TextEncoder.prototype, 'encoding', () => "utf-8");
        // Mask encode, encodeInto, and the constructor as native.
        _defProtoMethod(TextEncoder.prototype, 'encode', TextEncoder.prototype.encode);
        _defProtoMethod(TextEncoder.prototype, 'encodeInto', TextEncoder.prototype.encodeInto);
        try {
            Object.defineProperty(TextEncoder, 'toString', {
                value: function toString() { return 'function TextEncoder() { [native code] }'; },
                configurable: true,
            });
            Object.defineProperty(TextEncoder, _nativeTag, { value: 'TextEncoder', configurable: true });
            Object.defineProperty(TextEncoder, 'name', { value: 'TextEncoder', configurable: true });
        } catch {}
    }

    // atob / btoa
    if (!globalThis.atob) {
        globalThis.atob = ({
            atob(s) {
                if (arguments.length === 0) {
                    throw new TypeError("Failed to execute 'atob' on 'Window': 1 argument required, but only 0 present.");
                }
                const input = String(s).replace(/[\t\n\f\r ]/g, "");
                if (input.length === 0) return "";
                
                const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
                let out = "";
                for (let i = 0; i < input.length; i += 4) {
                    const a = chars.indexOf(input[i]), b = chars.indexOf(input[i+1]);
                    const c = chars.indexOf(input[i+2]), d = chars.indexOf(input[i+3]);
                    out += String.fromCharCode((a << 2) | (b >> 4));
                    if (c !== -1 && c !== 64) out += String.fromCharCode(((b & 15) << 4) | (c >> 2));
                    if (d !== -1 && d !== 64) out += String.fromCharCode(((c & 3) << 6) | d);
                }
                return out;
            }
        }).atob;
        _maskFunction(globalThis.atob, 'atob');
    }
    const _origStringify = JSON.stringify;
    if (!globalThis.btoa) {
        globalThis.btoa = ({
            btoa(s) {
                if (arguments.length === 0) {
                    throw new TypeError("Failed to execute 'btoa' on 'Window': 1 argument required, but only 0 present.");
                }
                const str = String(s);
                for (let i = 0; i < str.length; i++) {
                    if (str.charCodeAt(i) > 255) {
                        throw new DOMException("Failed to execute 'btoa' on 'Window': The string to be encoded contains characters outside of the Latin1 range.", "InvalidCharacterError");
                    }
                }
            const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let out = "";
            for (let i = 0; i < str.length; i += 3) {
                const a = str.charCodeAt(i), b = str.charCodeAt(i+1), c = str.charCodeAt(i+2);
                out += chars[a >> 2] + chars[((a & 3) << 4) | (b >> 4)];
                out += (isNaN(b) ? "=" : chars[((b & 15) << 2) | (c >> 6)]);
                out += (isNaN(c) ? "=" : chars[c & 63]);
            }
            return out;
        }
        }).btoa;
        _maskFunction(globalThis.btoa, 'btoa');
    }

    // localStorage / sessionStorage persistent stubs (backed by Rust DomState)
    const LOCAL_STORAGE_QUOTA = 5242880; // 5 MB
    
    function getStorageAreaSize(type) {
        const keys = ops.op_dom_storage_keys(type);
        let size = 0;
        for (const k of keys) {
            const v = ops.op_dom_storage_get(type, k);
            size += String(k).length + (v ? String(v).length : 0);
        }
        return size;
    }

    function setStorageItem(type, key, value) {
        const valStr = String(value);
        const newSize = String(key).length + valStr.length;
        const oldVal = ops.op_dom_storage_get(type, key);
        const oldSize = oldVal ? String(key).length + String(oldVal).length : 0;
        
        const currentSize = getStorageAreaSize(type);
        if (currentSize - oldSize + newSize > LOCAL_STORAGE_QUOTA) {
            throw new DOMException(
                "Failed to execute 'setItem' on 'Storage': Setting the value of '" + key + "' exceeded the quota.",
                'QuotaExceededError'
            );
        }
        
        ops.op_dom_storage_set(type, key, valStr);
        return true;
    }

    function makeStorage(type) {
        const STORAGE_METHODS = ["getItem", "setItem", "removeItem", "clear", "key", "length"];
        return new Proxy({}, {
            get(target, key) {
                if (key === "getItem") return (k) => ops.op_dom_storage_get(type, String(k));
                if (key === "setItem") return (k, v) => { setStorageItem(type, String(k), v); };
                if (key === "removeItem") return (k) => { ops.op_dom_storage_remove(type, String(k)); };
                if (key === "clear") return () => { ops.op_dom_storage_clear(type); };
                if (key === "key") return (i) => ops.op_dom_storage_keys(type)[i] ?? null;
                if (key === "length") return ops.op_dom_storage_keys(type).length;

                // Fallback to getting the item directly if it's not a method
                return ops.op_dom_storage_get(type, String(key)) ?? undefined;
            },
            // V8 Proxy invariant: `has` must agree with `ownKeys` about what
            // keys exist. Without an explicit trap, V8 falls back to the empty
            // target object — which says "no keys" and contradicts ownKeys's
            // real list. The reconciliation is hot work that fingerprint scripts hit
            // repeatedly via `'name' in storage` style probes.
            has(target, key) {
                if (STORAGE_METHODS.includes(key)) return true;
                return ops.op_dom_storage_get(type, String(key)) !== null;
            },
            set(target, key, value) { return setStorageItem(type, String(key), value); },
            deleteProperty(target, key) {
                ops.op_dom_storage_remove(type, String(key));
                return true;
            },
            ownKeys() {
                return ops.op_dom_storage_keys(type);
            },
            getOwnPropertyDescriptor(target, key) {
                const val = ops.op_dom_storage_get(type, String(key));
                if (val !== null) {
                    return { value: val, enumerable: true, configurable: true, writable: true };
                }
            }
        });
    }
    globalThis.localStorage = makeStorage("local");
    globalThis.sessionStorage = makeStorage("session");

    // MutationObserver — real implementation in dom_bootstrap.js

    // Task#2: real Chrome exposes `IntersectionObserverEntry` as a
    // global whose PROTOTYPE carries `intersectionRatio` /
    // `isIntersecting` (readonly accessors). duolingo's
    // `supportsIntersectionObserver` capability gate checks exactly
    // `"IntersectionObserverEntry" in window && "intersectionRatio" in
    // window.IntersectionObserverEntry.prototype && "isIntersecting" in
    // …prototype`; without a real entry class the homepage
    // self-redirects to /errors/not-supported.html. Class getters land
    // on the prototype, satisfying the `in prototype` checks.
    globalThis.IntersectionObserverEntry = class IntersectionObserverEntry {
        #i;
        constructor(init = {}) { this.#i = init || {}; }
        get target() { return this.#i.target ?? null; }
        get isIntersecting() { return this.#i.isIntersecting ?? false; }
        get intersectionRatio() { return this.#i.intersectionRatio ?? 0; }
        get boundingClientRect() { return this.#i.boundingClientRect ?? null; }
        get intersectionRect() { return this.#i.intersectionRect ?? null; }
        get rootBounds() { return this.#i.rootBounds ?? null; }
        get time() { return this.#i.time ?? 0; }
    };

    // IntersectionObserver — fires immediately since all elements are "in viewport" in headless
    globalThis.IntersectionObserver = class IntersectionObserver {
        #callback;
        #elements;
        #options;
        constructor(callback, options = {}) {
            this.#callback = callback;
            this.#options = options;
            this.#elements = new Set();
        }
        observe(target) {
            this.#elements.add(target);
            // In headless mode, all elements are considered intersecting
            Promise.resolve().then(() => {
                if (!this.#elements.has(target)) return;
                const entry = new globalThis.IntersectionObserverEntry({
                    target,
                    isIntersecting: true,
                    intersectionRatio: 1.0,
                    boundingClientRect: target.getBoundingClientRect ? target.getBoundingClientRect() : {},
                    intersectionRect: target.getBoundingClientRect ? target.getBoundingClientRect() : {},
                    rootBounds: null,
                    time: performance.now(),
                });
                this.#callback([entry], this);
            });
        }
        unobserve(target) { this.#elements.delete(target); }
        disconnect() { this.#elements.clear(); }
        takeRecords() { return []; }
    };

    // ResizeObserver — fires on observe() with current dimensions
    globalThis.ResizeObserver = class ResizeObserver {
        #callback;
        #elements;
        constructor(callback) {
            this.#callback = callback;
            this.#elements = new Set();
        }
        observe(target) {
            this.#elements.add(target);
            Promise.resolve().then(() => {
                if (!this.#elements.has(target)) return;
                const entry = {
                    target,
                    contentRect: target.getBoundingClientRect ? target.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 },
                    borderBoxSize: [{ inlineSize: target.offsetWidth || 0, blockSize: target.offsetHeight || 0 }],
                    contentBoxSize: [{ inlineSize: target.offsetWidth || 0, blockSize: target.offsetHeight || 0 }],
                };
                this.#callback([entry], this);
            });
        }
        unobserve(target) { this.#elements.delete(target); }
        disconnect() { this.#elements.clear(); }
    };

    // requestIdleCallback stub
    globalThis.requestIdleCallback = ({
        requestIdleCallback(cb) {
            return setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 1);
        }
    }).requestIdleCallback;
    _maskFunction(globalThis.requestIdleCallback, 'requestIdleCallback');

    globalThis.cancelIdleCallback = ({
        cancelIdleCallback(id) {
            return clearTimeout(id);
        }
    }).cancelIdleCallback;
    _maskFunction(globalThis.cancelIdleCallback, 'cancelIdleCallback');

    // getComputedStyle — reads inline style from actual element, falls back to CSS defaults.
    // CAPTURE _getNodeId at bootstrap time: cleanup_bootstrap.js deletes
    // __browser_oxide before page scripts run, so per-call lookup degrades to
    // nodeId=0 (same bug that broke event_stop_propagation). This was why
    // every getComputedStyle() call returned the same root-element defaults
    // regardless of which element was passed.
    const _compStyleCache = new WeakMap();
    const _getNodeIdForCompStyle = (globalThis.__browser_oxide && globalThis.__browser_oxide._getNodeId)
        ? globalThis.__browser_oxide._getNodeId
        : (() => 0);
    globalThis.getComputedStyle = ({
        getComputedStyle(element, pseudoElt) {
            // Chrome throws here; returning null instead turns a catchable call-site
            // error into a `null.fontSize` TypeError deep inside the caller (this is
            // what killed Epic's login render inside a CSS unit converter).
            if (element === null || element === undefined) {
                throw new TypeError(
                    "Failed to execute 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'."
                );
            }
            let styleProxy = _compStyleCache.get(element);
            if (styleProxy) return styleProxy;

            const nodeId = _getNodeIdForCompStyle(element);
            // Create an instance of CSSStyleDeclaration.
            const style = Object.create(globalThis.CSSStyleDeclaration.prototype || Object.prototype);
        // The returned declaration is *live*: per spec it reflects the element's
        // current state on every read, so the snapshot may not outlive the access
        // that needed it. Memoising it once per element — as this did — froze the
        // element at whatever it looked like the first time anything asked. A page
        // that reveals a node by rewriting its inline style then reads back the
        // state it started in, which is indistinguishable from "the reveal did not
        // happen" and stalls anything waiting on it.
        //
        // Only enumeration goes through the bulk op; a single property read asks
        // for that property.
        let keys = null;
        function snapshot() {
            const c = ops.op_dom_get_all_computed_styles(nodeId);
            keys = Object.keys(c);
            return c;
        }
        styleProxy = new Proxy(style, {
            get(target, prop) {
                if (prop === "getPropertyValue") {
                    return (name) => ops.op_dom_get_computed_style(nodeId, name);
                }
                if (prop === "setProperty" || prop === "removeProperty") {
                    return () => {}; // read-only
                }
                if (prop === "length") {
                    snapshot();
                    return keys.length;
                }
                if (prop === Symbol.toStringTag) return "CSSStyleDeclaration";
                if (typeof prop === "string") {
                    if (/^\d+$/.test(prop)) {
                        snapshot();
                        return keys[parseInt(prop, 10)];
                    }
                    const kebab = prop.replace(/[A-Z]/g, m => "-" + m.toLowerCase());
                    return ops.op_dom_get_computed_style(nodeId, kebab);
                }
                return undefined;
            }
        });
        _compStyleCache.set(element, styleProxy);
        return styleProxy;
        }
    }).getComputedStyle;
    _maskFunction(globalThis.getComputedStyle, 'getComputedStyle');

    // Base64 → Uint8Array, self-contained so it does not depend on a global
    // `atob` a page could have shadowed by the time a response arrives.
    const _xhrB64ToBytes = (b64) => {
        if (!b64) return new Uint8Array(0);
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        const clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, "");
        const len = clean.length;
        const out = new Uint8Array(Math.floor(len * 3 / 4));
        let o = 0;
        for (let i = 0; i < len; i += 4) {
            const a = chars.indexOf(clean[i]), b = chars.indexOf(clean[i + 1]);
            const c = chars.indexOf(clean[i + 2]), d = chars.indexOf(clean[i + 3]);
            out[o++] = (a << 2) | (b >> 4);
            if (c !== -1 && c !== 64) out[o++] = ((b & 15) << 4) | (c >> 2);
            if (d !== -1 && d !== 64) out[o++] = ((c & 3) << 6) | d;
        }
        return out.subarray(0, o);
    };

    /// The `.response` value for a finished XHR, from the raw response bytes.
    ///
    /// It used to be `_idl.own(xhr).response = xhr.responseText` unconditionally — every
    /// `responseType` came back as the lossy UTF-8 text, so `responseType =
    /// "arraybuffer"` handed a page a buffer built from a string that had
    /// already lost every non-UTF-8 byte to U+FFFD, and `"blob"` wrapped that
    /// same corrupted text. A binary payload (a PNG, a protobuf, a signed
    /// token) read through XHR came back mangled the identical way a `fetch()`
    /// arrayBuffer used to.
    const _xhrResponseFor = (xhr, bytes, text, contentType) => {
        switch (xhr.responseType) {
            case "arraybuffer":
                return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            case "blob": {
                const b = new Blob([]);
                _idl.own(b)._data = bytes;
                b.size = bytes.byteLength;
                b.type = contentType || "";
                return b;
            }
            case "json":
                try { return JSON.parse(text); } catch (_e) { return null; }
            case "":
            case "text":
            default:
                return text;
        }
    };

    // XMLHttpRequest stub (built on fetch)
    // XMLHttpRequest — must extend EventTarget and expose the full Chrome
    // shape. Some scripts monkey-patch `XMLHttpRequest.prototype.send`
    // and walk computed-name chains through the instance, so any missing
    // property (upload, responseType, withCredentials, timeout, response,
    // responseXML, abort, dispatchEvent, etc.) surfaces as
    //   `obj[<computed>.<computed>.<computed>.<computed>] is not a function`
    // during their execution.
    globalThis.XMLHttpRequest = class XMLHttpRequest extends EventTarget {
        constructor() {
            super();
            const _st = _idl.own(this);
            _st.readyState = 0;
            _st.status = 0;
            _st.statusText = "";
            _st.responseText = "";
            _st.responseXML = null;
            _st.response = "";
            this.responseType = "";
            _st.responseURL = "";
            this.withCredentials = false;
            this.timeout = 0;
            _idl.own(this)._method = "GET";
            _idl.own(this)._url = "";
            _idl.own(this)._async = true;
            _idl.own(this)._headers = {};
            _idl.own(this)._respHeaders = {};
            _idl.own(this)._aborted = false;
            // Event handler properties — match Chrome's XHR interface.
            this.onreadystatechange = null;
            this.onload = null;
            this.onloadstart = null;
            this.onloadend = null;
            this.onerror = null;
            this.onabort = null;
            this.ontimeout = null;
            this.onprogress = null;
            // upload — XMLHttpRequestUpload, also an EventTarget.
            const _XHRU = class XMLHttpRequestUpload extends EventTarget {
                constructor() {
                    super();
                    this.onload = null;
                    this.onloadstart = null;
                    this.onloadend = null;
                    this.onerror = null;
                    this.onabort = null;
                    this.ontimeout = null;
                    this.onprogress = null;
                }
            };
            Object.defineProperty(_XHRU.prototype, Symbol.toStringTag, { value: "XMLHttpRequestUpload", configurable: true });
            _st.upload = new _XHRU();
        }
        static UNSENT = 0;
        static OPENED = 1;
        static HEADERS_RECEIVED = 2;
        static LOADING = 3;
        static DONE = 4;
        open(method, url, async = true, user, password) {
            const _st = _idl.own(this);
            console.log(`[XHR] open ${method} ${url}`);
            _idl.own(this)._method = String(method || "GET").toUpperCase();
            let urlStr = String(url || "");
            if (urlStr && !urlStr.startsWith('http') && !urlStr.startsWith('data:') && !urlStr.startsWith('blob:')) {
                try {
                    let base = globalThis.location ? globalThis.location.href : 'about:blank';
                    if (base === 'about:blank' || base === 'javascript:;' || base === '') {
                        try { base = globalThis.parent.location.href; } catch(e) {}
                    }
                    const old = urlStr;
                    urlStr = new URL(urlStr, base).href;
                } catch(e) {
                }
            }
            _idl.own(this)._url = urlStr;
            _idl.own(this)._async = async !== false;
            _idl.own(this)._headers = {};
            _idl.own(this)._respHeaders = {};
            _idl.own(this)._aborted = false;
            _st.readyState = 1;
            _st.status = 0;
            _st.statusText = "";
            _st.responseText = "";
            _st.response = "";
            _st.responseURL = "";
            try {
                const ev = new Event("readystatechange");
                if (typeof this.dispatchEvent === 'function') this.dispatchEvent(ev);
                if (this.onreadystatechange) this.onreadystatechange.call(this, ev);
            } catch {}
        }
        setRequestHeader(name, value) {
            _idl.own(this)._headers[String(name)] = String(value);
        }
        overrideMimeType(mime) { this._overrideMime = String(mime); }
        send(body) {
            console.log(`[XHR] send ${_idl.own(this)._method} ${_idl.own(this)._url}`);
            const xhr = this;
            if (_idl.own(xhr)._aborted) return;
            const fireEvent = (type) => {
                try {
                    const ev = new Event(type);
                    if (typeof xhr.dispatchEvent === 'function') xhr.dispatchEvent(ev);
                    const handler = xhr['on' + type];
                    if (typeof handler === 'function') handler.call(xhr, ev);
                } catch {}
            };

            // Encode body for the sync op (marker-prefixed like op_fetch).
            let bodyEncoded = '';
            if (body !== null && body !== undefined) {
                if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
                    const bytes = body instanceof ArrayBuffer
                        ? new Uint8Array(body)
                        : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
                    let bin = '';
                    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
                    bodyEncoded = 'b:' + btoa(bin);
                } else if (typeof FormData !== 'undefined' && body instanceof FormData) {
                    // Same multipart serialization
                    // the fetch path does — XHR.send(formData) must produce a real
                    // multipart/form-data body with a boundary, and the browser sets
                    // the Content-Type itself (overriding any setRequestHeader). Used
                    // by challenge scripts that POST proofs via
                    // synchronous XHR.
                    const boundary = '----browserOxideFormBoundary' +
                        Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
                    let mp = '';
                    body.forEach((value, name) => {
                        mp += '--' + boundary + '\r\n';
                        if (typeof Blob !== 'undefined' && value instanceof Blob) {
                            mp += 'Content-Disposition: form-data; name="' + name + '"; filename="' +
                                (value.name || 'blob') + '"\r\n';
                            mp += 'Content-Type: ' + (value.type || 'application/octet-stream') + '\r\n\r\n';
                            mp += String(value) + '\r\n';
                        } else {
                            mp += 'Content-Disposition: form-data; name="' + name + '"\r\n\r\n';
                            mp += String(value) + '\r\n';
                        }
                    });
                    mp += '--' + boundary + '--\r\n';
                    bodyEncoded = 's:' + mp;
                    // Force the browser-controlled Content-Type (drop any prior variant).
                    for (const k of Object.keys(_idl.own(xhr)._headers)) {
                        if (k.toLowerCase() === 'content-type') delete _idl.own(xhr)._headers[k];
                    }
                    _idl.own(xhr)._headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary;
                } else if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
                    bodyEncoded = 's:' + body.toString();
                    const hasCT = Object.keys(_idl.own(xhr)._headers).some((k) => k.toLowerCase() === 'content-type');
                    if (!hasCT) _idl.own(xhr)._headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
                } else {
                    bodyEncoded = 's:' + String(body);
                }
            }

            // For synchronous XHR (async=false) — required by scripts that call
            // xhr.open('POST', url, false) + xhr.send() and read xhr.status immediately
            // after send() returns. The async fetch() path can never satisfy this because
            // it requires V8 to yield, which doesn't happen when a proof-of-work busy-wait is running.
            if (!_idl.own(xhr)._async && typeof ops !== 'undefined' && typeof ops.op_net_xhr_sync === 'function') {
                const startTime = performance.now();
                try {
                    const origin = (globalThis.location && globalThis.location.origin !== 'null')
                        ? globalThis.location.origin : '';
                    const headersJson = JSON.stringify(
                        Object.entries(_idl.own(xhr)._headers).map(([k, v]) => [k, String(v)])
                    );
                    const resultJson = ops.op_net_xhr_sync(
                        _idl.own(xhr)._url, _idl.own(xhr)._method, headersJson, bodyEncoded, origin
                    );
                    const result = JSON.parse(resultJson);
                    
                    const _internalEntries = _browser_oxide.__perfResourceEntries;
                    if (_internalEntries) {
                        _internalEntries.push({ url: _idl.own(xhr)._url, type: "xmlhttprequest", startTime, duration: performance.now() - startTime, size: result.body ? result.body.length : 0 });
                    }
                    
                    _idl.own(xhr).status = result.status || 0;
                    _idl.own(xhr).statusText = '';
                    _idl.own(xhr).responseURL = result.url || _idl.own(xhr)._url;
                    if (Array.isArray(result.headers)) {
                        for (const [k, v] of result.headers) {
                            _idl.own(xhr)._respHeaders[String(k).toLowerCase()] = String(v);
                        }
                    }
                    _idl.own(xhr).responseText = result.body || '';
                    {
                        const bytes = _xhrB64ToBytes(result.bodyBase64 || '');
                        const ct = _idl.own(xhr)._respHeaders['content-type'] || '';
                        _idl.own(xhr).response = _xhrResponseFor(xhr, bytes, xhr.responseText, ct);
                    }
                    _idl.own(xhr).readyState = 2; fireEvent('readystatechange');
                    _idl.own(xhr).readyState = 3; fireEvent('readystatechange');
                    _idl.own(xhr).readyState = 4; fireEvent('readystatechange');
                    fireEvent('load');
                    fireEvent('loadend');
                } catch(e) {
                    _idl.own(xhr).readyState = 4;
                    fireEvent('readystatechange');
                    fireEvent('error');
                    fireEvent('loadend');
                }
                return;
            }

            // Fallback: async fetch() path (used only when op_net_xhr_sync is unavailable).
            fireEvent('loadstart');
            fetch(_idl.own(xhr)._url, {
                method: _idl.own(xhr)._method,
                headers: _idl.own(xhr)._headers,
                body,
                credentials: xhr.withCredentials ? 'include' : 'same-origin',
            })
                .then(async (resp) => {
                    const _internalEntries = _browser_oxide.__perfResourceEntries;
                    if (_internalEntries && _internalEntries.length > 0) {
                        _internalEntries[_internalEntries.length - 1].type = "xmlhttprequest";
                    }
                    if (_idl.own(xhr)._aborted) return;
                    _idl.own(xhr).status = resp.status;
                    _idl.own(xhr).statusText = resp.statusText || "";
                    _idl.own(xhr).responseURL = resp.url || _idl.own(xhr)._url;
                    try {
                        if (resp.headers && typeof resp.headers.forEach === 'function') {
                            resp.headers.forEach((v, k) => { _idl.own(xhr)._respHeaders[String(k).toLowerCase()] = String(v); });
                        }
                    } catch {}
                    _idl.own(xhr).readyState = 2;
                    fireEvent('readystatechange');
                    _idl.own(xhr).readyState = 3;
                    fireEvent('readystatechange');
                    _idl.own(xhr).responseText = await resp.text();
                    {
                        const buf = await resp.arrayBuffer();
                        const bytes = new Uint8Array(buf);
                        const ct = _idl.own(xhr)._respHeaders['content-type'] || '';
                        _idl.own(xhr).response = _xhrResponseFor(xhr, bytes, xhr.responseText, ct);
                    }
                    _idl.own(xhr).readyState = 4;
                    fireEvent('readystatechange');
                    fireEvent('load');
                    fireEvent('loadend');
                })
                .catch((e) => {
                    if (_idl.own(xhr)._aborted) return;
                    _idl.own(xhr).readyState = 4;
                    fireEvent('readystatechange');
                    fireEvent('error');
                    fireEvent('loadend');
                });
        }
        abort() {
            const _st = _idl.own(this);
            _idl.own(this)._aborted = true;
            _st.readyState = 0;
            try {
                const ev = new Event("abort");
                if (typeof this.dispatchEvent === 'function') this.dispatchEvent(ev);
                if (this.onabort) this.onabort.call(this, ev);
            } catch {}
        }
        getResponseHeader(name) {
            return _idl.own(this)._respHeaders[String(name).toLowerCase()] || null;
        }
        getAllResponseHeaders() {
            return Object.entries(_idl.own(this)._respHeaders)
                .map(([k, v]) => `${k}: ${v}`)
                .join("\r\n");
        }
    };
    _idl.fields(XMLHttpRequest.prototype, ["readyState", "response", "responseText", "responseURL", "responseXML", "status", "statusText", "upload"]);
    Object.defineProperty(globalThis.XMLHttpRequest.prototype, Symbol.toStringTag, { value: "XMLHttpRequest", configurable: true });

    // WebSocket — real connections via tokio-tungstenite ops
    // Every event goes through `dispatchEvent`, which also invokes the matching
    // `on*` attribute. Calling `this.onmessage(...)` directly — as this class used
    // to — meant `ws.addEventListener('message', fn)` received nothing at all,
    // so any library that registers listeners instead of assigning `onmessage`
    // (which is most of them) saw a socket that opened and then went silent.
    globalThis.WebSocket = class WebSocket extends EventTarget {
        #origin;
        #wsId;
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        constructor(url, protocols) {
            super();
            const _st = _idl.own(this);
            _st.url = url;
            _st.readyState = WebSocket.CONNECTING;
            // `MessageEvent.origin` for the socket's own origin, as a browser
            // reports it.
            try {
                this.#origin = new URL(String(url)).origin.replace(/^ws/, "http");
            } catch (_) { this.#origin = ""; }
            this.onopen = null;
            this.onmessage = null;
            this.onclose = null;
            this.onerror = null;
            this.#wsId = -1;

            // Connect asynchronously
            ops.op_ws_connect(String(url)).then((result) => {
                if (result.ok) {
                    this.#wsId = result.id;
                    _st.readyState = WebSocket.OPEN;
                    this.dispatchEvent(new Event("open"));
                    // Start receive loop
                    this.#pollMessages();
                } else {
                    _st.readyState = WebSocket.CLOSED;
                    this.dispatchEvent(new Event("error"));
                    this.dispatchEvent(new CloseEvent("close", { code: 1006, reason: result.error, wasClean: false }));
                }
            }).catch((e) => {
                _st.readyState = WebSocket.CLOSED;
                this.dispatchEvent(new Event("error"));
            });
        }
        async #pollMessages() {
            while (this.readyState === WebSocket.OPEN && this.#wsId >= 0) {
                try {
                    const msg = await ops.op_ws_recv(this.#wsId);
                    if (!msg && msg !== "") {
                        // Connection closed
                        _st.readyState = WebSocket.CLOSED;
                        this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
                        break;
                    }
                    if (msg !== "") {
                        this.dispatchEvent(new MessageEvent("message", {
                            data: msg, origin: this.#origin,
                        }));
                    }
                } catch (e) {
                    _st.readyState = WebSocket.CLOSED;
                    this.dispatchEvent(new Event("error"));
                    break;
                }
            }
        }
        send(data) {
            if (this.readyState === WebSocket.OPEN && this.#wsId >= 0) {
                ops.op_ws_send(this.#wsId, String(data));
            }
        }
        close(code, reason) {
            const _st = _idl.own(this);
            if (this.#wsId >= 0) {
                ops.op_ws_close(this.#wsId);
                this.#wsId = -1;
            }
            _st.readyState = WebSocket.CLOSED;
            this.dispatchEvent(new CloseEvent("close", {
                code: code || 1000, reason: reason || "",
            }));
        }
        get bufferedAmount() { return 0; }
        get extensions() { return ""; }
        get protocol() { return ""; }
        get binaryType() { return "blob"; }
        set binaryType(v) {}
    };
    _idl.fields(WebSocket.prototype, ["readyState", "url"]);


    // --- history — prototype-backed ---
    const _historyStack = [{ state: null, title: "", url: globalThis.location?.href || "about:blank" }];
    let _historyIndex = 0;
    const _HistoryProto = History.prototype;
    _defProtoGetter(_HistoryProto, 'length', () => _historyStack.length);
    _defProtoGetter(_HistoryProto, 'state', () => _historyStack[_historyIndex]?.state || null);
    // Writable, as in a browser: `history.scrollRestoration = 'manual'` is the
    // documented way to opt out of scroll restoration, and a getter-only property
    // makes that assignment throw. Angular does it during bootstrap, so the throw
    // aborted the framework's initialisation before the application rendered.
    {
        const _scrollRestoration = new WeakMap();
        _defProtoGetter(
            _HistoryProto,
            'scrollRestoration',
            function scrollRestoration() { return _scrollRestoration.get(this) || "auto"; },
            function scrollRestoration(v) {
                const value = String(v);
                if (value === "auto" || value === "manual") _scrollRestoration.set(this, value);
            },
        );
    }
    _defProtoMethod(_HistoryProto, 'pushState', function pushState(state, title, url) {
        _historyStack.splice(_historyIndex + 1);
        _historyStack.push({ state, title, url: url || "" });
        _historyIndex = _historyStack.length - 1;
    });
    _defProtoMethod(_HistoryProto, 'replaceState', function replaceState(state, title, url) {
        _historyStack[_historyIndex] = { state, title, url: url || "" };
    });
    _defProtoMethod(_HistoryProto, 'back', function back() { if (_historyIndex > 0) _historyIndex--; });
    _defProtoMethod(_HistoryProto, 'forward', function forward() { if (_historyIndex < _historyStack.length - 1) _historyIndex++; });
    _defProtoMethod(_HistoryProto, 'go', function go(delta) {
        const idx = _historyIndex + (delta || 0);
        if (idx >= 0 && idx < _historyStack.length) _historyIndex = idx;
    });
    Object.defineProperty(_HistoryProto, Symbol.toStringTag, { value: "History", configurable: true });
    globalThis.history = Object.create(_HistoryProto);

    // =========================================================
    // matchMedia — covers the 12 standard CSS Media Queries Level 5
    // features that fingerprint scripts probe. Profile-driven defaults
    // (light theme, fine pointer, hover-capable) for the desktop
    // chrome_130_* presets. Returns a real `class MediaQueryList
    // extends EventTarget` instead of a plain object literal so
    // `mql instanceof MediaQueryList` and
    // `Object.prototype.toString.call(mql) === "[object MediaQueryList]"`
    // both hold (the prior shim failed both probes).
    //
    // Supported features (matches Chrome 130+ on macOS desktop):
    //   prefers-color-scheme  : light | dark | no-preference
    //   prefers-reduced-motion: reduce | no-preference
    //   prefers-reduced-data  : reduce | no-preference
    //   prefers-reduced-transparency: reduce | no-preference
    //   prefers-contrast      : more | less | custom | no-preference
    //   inverted-colors       : inverted | none
    //   forced-colors         : active | none
    //   pointer / any-pointer : none | coarse | fine
    //   hover  / any-hover    : none | hover
    //   color  / color-gamut  / monochrome / dynamic-range
    //   orientation           : landscape | portrait
    //   resolution            : matching dppx
    //   width / height / device-width / device-height (min/max/exact)
    //   aspect-ratio / device-aspect-ratio
    //   display-mode          : browser | standalone | fullscreen | minimal-ui
    //   update / overflow-block / overflow-inline
    //   scripting / scan / grid
    // =========================================================
    {
        const _profileFeature = (key, fallback) => {
            try { return _p(key, fallback); } catch (_e) { return fallback; }
        };

        // Feature -> (value-string -> bool) for the chosen profile defaults.
        const _featureValue = (name) => {
            // Honor profile fields when they exist; else use desktop default.
            switch (name) {
                case "prefers-color-scheme":
                    return _profileFeature("prefers_color_scheme", "light");
                case "prefers-reduced-motion": return "no-preference";
                case "prefers-reduced-data": return "no-preference";
                case "prefers-reduced-transparency": return "no-preference";
                case "prefers-contrast": return "no-preference";
                case "inverted-colors": return "none";
                case "forced-colors": return "none";
                case "pointer":
                case "any-pointer":
                    return _profileFeature("pointer_type", "fine");
                case "hover":
                case "any-hover":
                    return _profileFeature("hover_capability", "hover");
                case "display-mode": return "browser";
                case "update": return "fast";
                case "overflow-block": return "scroll";
                case "overflow-inline": return "scroll";
                case "scripting": return "enabled";
                case "scan": return "progressive";
                case "grid": return "0";
                case "color-gamut":
                    // Matches real-browser color-gamut reporting:
                    // real macOS/iPhone Chrome reports "p3" (wide gamut);
                    // Win/Linux/Android typically report "srgb". Profile-
                    // driven default with srgb fallback.
                    return _profileFeature("color_gamut", "srgb");
                case "dynamic-range": return "standard";
                case "orientation": return _orientationValue();
                default: return null;
            }
        };

        // Numeric features
        const _numericFeature = (name) => {
            switch (name) {
                case "width":
                case "device-width":
                    return _pInt("inner_width", 1920);
                case "height":
                case "device-height":
                    return _pInt("inner_height", 1080);
                case "color":
                    // Bits per color channel; Chrome reports 8.
                    return 8;
                case "monochrome":
                    return 0;
                case "resolution":
                    // Reported as dppx; matches devicePixelRatio.
                    return _pFloat("device_pixel_ratio", 1);
                case "device-pixel-ratio":
                    return _pFloat("device_pixel_ratio", 1);
                case "aspect-ratio":
                case "device-aspect-ratio": {
                    const w = _pInt("inner_width", 1920);
                    const h = _pInt("inner_height", 1080);
                    return h > 0 ? w / h : 16 / 9;
                }
                default: return null;
            }
        };

        // Orientation is enum-valued ("landscape"/"portrait"), so it lives
        // in the enumerated-feature path even though the source is a
        // numeric comparison. Moved out of _numericFeature to avoid
        // tripping the `typeof num === "number"` check below.
        const _orientationValue = () => {
            const w = _pInt("inner_width", 1920);
            const h = _pInt("inner_height", 1080);
            return w >= h ? "landscape" : "portrait";
        };

        // Parse a single feature predicate like
        //   "prefers-color-scheme: light"
        //   "min-width: 1024px"
        //   "(pointer)"  (existence — true if any value is supported)
        const _evalSingle = (feat) => {
            feat = feat.trim().toLowerCase();
            if (!feat) return false;

            // (feature) without value → "is this feature supported with any
            // non-none value?"
            if (!feat.includes(":")) {
                const numeric = _numericFeature(feat);
                if (numeric !== null) {
                    if (typeof numeric === "number") return numeric > 0;
                    return true;
                }
                const enumVal = _featureValue(feat);
                if (enumVal !== null) return enumVal !== "none" && enumVal !== "no-preference" && enumVal !== "0";
                return false;
            }

            // "feature: value" — split, trim
            const colonIdx = feat.indexOf(":");
            let name = feat.slice(0, colonIdx).trim();
            const valueStr = feat.slice(colonIdx + 1).trim();

            // Range prefixes — min-* / max-*.
            let cmp = "eq";
            if (name.startsWith("min-")) { cmp = "min"; name = name.slice(4); }
            else if (name.startsWith("max-")) { cmp = "max"; name = name.slice(4); }

            // Numeric features (width / height / resolution / aspect-ratio)
            const num = _numericFeature(name);
            if (num !== null && typeof num === "number") {
                // Parse value: "1024px" / "1.5dppx" / "16/9" / "2"
                let target;
                if (valueStr.endsWith("px")) target = parseFloat(valueStr);
                else if (valueStr.endsWith("dppx")) target = parseFloat(valueStr);
                else if (valueStr.endsWith("dpi")) target = parseFloat(valueStr) / 96;
                else if (valueStr.includes("/")) {
                    const [a, b] = valueStr.split("/").map(parseFloat);
                    target = b > 0 ? a / b : NaN;
                }
                else target = parseFloat(valueStr);
                if (Number.isNaN(target)) return false;
                if (cmp === "min") return num >= target;
                if (cmp === "max") return num <= target;
                return Math.abs(num - target) < 1e-6;
            }

            // Enumerated features
            const enumVal = _featureValue(name);
            if (enumVal !== null) return enumVal === valueStr;

            return false;
        };

        // Evaluate a full media query string. Supports comma-separated
        // alternatives, `and`, `not`, `only`, parens.
        const _evalQuery = (query) => {
            if (typeof query !== "string") return false;
            const q = query.trim().toLowerCase();
            if (!q || q === "all" || q === "screen") return true;
            // Comma = OR.
            if (q.includes(",")) return q.split(",").some(_evalQuery);
            // Strip leading "only " — same semantics as the bare query.
            const stripped = q.startsWith("only ") ? q.slice(5).trim() : q;
            // Strip leading "not " — invert.
            if (stripped.startsWith("not ")) return !_evalQuery(stripped.slice(4));
            // Match "(features) and (more)" — split on AND.
            const tokens = stripped.split(/\s+and\s+/);
            return tokens.every(tok => {
                tok = tok.trim();
                // Bare media type like "screen" / "print" — accept screen.
                if (tok === "screen" || tok === "all") return true;
                if (tok === "print") return false;
                // Strip parens.
                if (tok.startsWith("(") && tok.endsWith(")")) tok = tok.slice(1, -1);
                return _evalSingle(tok);
            });
        };

        class MediaQueryList extends EventTarget {
            #matches;
            #media;
            #onchange;
            constructor(query) {
                super();
                this.#media = String(query || "");
                this.#matches = _evalQuery(this.#media);
                this.#onchange = null;
            }
            get matches() { return this.#matches; }
            get media() { return this.#media; }
            get onchange() { return this.#onchange; }
            set onchange(v) { this.#onchange = (typeof v === "function") ? v : null; }
            // Deprecated aliases — kept for legacy compat (Safari, etc.).
            addListener(cb) { try { this.addEventListener("change", cb); } catch(_) {} }
            removeListener(cb) { try { this.removeEventListener("change", cb); } catch(_) {} }
        }
        Object.defineProperty(MediaQueryList.prototype, Symbol.toStringTag, {
            value: "MediaQueryList", configurable: true,
        });
        globalThis.MediaQueryList = MediaQueryList;

        globalThis.matchMedia = ({
            matchMedia(query) {
                return new MediaQueryList(query);
            }
        }).matchMedia;
        if (typeof _maskFunction === "function") {
            _maskFunction(globalThis.matchMedia, "matchMedia");
        }
        }

        // --- window.open/close/postMessage ---
        globalThis.open = ({ open(url, target, features) { return null; } }).open;
        _maskFunction(globalThis.open, "open");

        globalThis.close = ({ close() {} }).close;
        _maskFunction(globalThis.close, "close");

        globalThis.postMessage = ({
        postMessage(message, targetOrigin, transfer) {
            const recipientOrigin = globalThis.location?.origin || "null";
            const wanted = targetOrigin == null ? "/" : String(targetOrigin);
            if (wanted !== "*" && wanted !== "/" && wanted !== recipientOrigin) return;
            // Use structuredClone if available to match browser behavior.
            // If not available (e.g. during very early bootstrap), fall back to reference.
            let cloned = message;
            try {
                if (typeof globalThis.structuredClone === 'function') {
                    cloned = globalThis.structuredClone(message, { transfer });
                }
            } catch (e) {
                // DataCloneError — propagate as-is (matches Chrome)
                throw e;
            }
            // Fire message event asynchronously
            Promise.resolve().then(() => {
                const event = new MessageEvent("message", {
                    data: cloned,
                    origin: recipientOrigin,
                    source: globalThis,
                });
                globalThis.dispatchEvent(event);
            });
        }
        }).postMessage;
        _maskFunction(globalThis.postMessage, "postMessage");

        globalThis.stop = ({ stop() {} }).stop;
        _maskFunction(globalThis.stop, "stop");

        globalThis.print = ({ print() {} }).print;
        _maskFunction(globalThis.print, "print");

        globalThis.confirm = ({ confirm(msg) { return true; } }).confirm;
        _maskFunction(globalThis.confirm, "confirm");

        globalThis.alert = ({ alert(msg) {} }).alert;
        _maskFunction(globalThis.alert, "alert");

        globalThis.prompt = ({ prompt(msg, def) { return def || null; } }).prompt;
        _maskFunction(globalThis.prompt, "prompt");



    // --- DOMException ---
    if (!globalThis.DOMException) {
        globalThis.DOMException = class DOMException extends Error {
            constructor(message, name) {
                super(message);
                this.name = name || "Error";
            }
        };
        // See shared_apis_bootstrap.js: `code` must be a prototype getter, otherwise a
        // page polyfill that redefines it getter-only makes the constructor throw.
        Object.defineProperty(globalThis.DOMException.prototype, "code", {
            get() {
                const codes = {
                    IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4,
                    InvalidCharacterError: 5, NoModificationAllowedError: 7, NotFoundError: 8,
                    NotSupportedError: 9, InUseAttributeError: 10, InvalidStateError: 11,
                    SyntaxError: 12, InvalidModificationError: 13, NamespaceError: 14,
                    InvalidAccessError: 15, TypeMismatchError: 17, SecurityError: 18,
                    NetworkError: 19, AbortError: 20, URLMismatchError: 21,
                    QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24,
                    DataCloneError: 25,
                };
                return codes[this.name] || 0;
            },
            enumerable: true, configurable: true,
        });
    }

    function _randomUUID() {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
            try { return globalThis.crypto.randomUUID(); } catch (e) {}
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    // --- FormData ---
    globalThis.FormData = class FormData {
        #data;
        constructor() { this.#data = []; }
        append(name, value) { this.#data.push([String(name), value]); }
        delete(name) { this.#data = this.#data.filter(([k]) => k !== name); }
        get(name) { const p = this.#data.find(([k]) => k === name); return p ? p[1] : null; }
        getAll(name) { return this.#data.filter(([k]) => k === name).map(([, v]) => v); }
        has(name) { return this.#data.some(([k]) => k === name); }
        set(name, value) { this.delete(name); this.append(name, value); }
        forEach(cb, thisArg) { for (const [k, v] of this.#data) cb.call(thisArg, v, k, this); }
        keys() { return this.#data.map(([k]) => k)[Symbol.iterator](); }
        values() { return this.#data.map(([, v]) => v)[Symbol.iterator](); }
        entries() { return this.#data[Symbol.iterator](); }
        [Symbol.iterator]() { return this.entries(); }
    };

    // --- customElements registry with lifecycle ---
    const _customElementsRegistry = new Map();
    const _whenDefinedPromises = new Map(); // name -> { promise, resolve }

    function _tryCallLifecycle(el, name, ...args) {
        try { if (typeof el[name] === "function") el[name](...args); } catch (e) { console.error(e); }
    }

    function _upgradeElement(el, entry) {
        if (el._ceUpgraded) return;
        el._ceUpgraded = true;
        // Set prototype to the custom element class
        Object.setPrototypeOf(el, entry.constructor.prototype);
        try { entry.constructor.call(el); } catch (e) { console.error(e); }
    }

    // CustomElementRegistry — prototype-backed, matches real Chrome class name.
    class CustomElementRegistry {}
    globalThis.CustomElementRegistry = CustomElementRegistry;
    const _CERProto = CustomElementRegistry.prototype;
    _defProtoMethod(_CERProto, 'define', function define(name, constructor, options) {
        const lowerName = name.toLowerCase();
        _customElementsRegistry.set(lowerName, { constructor, options });
        const pending = _whenDefinedPromises.get(lowerName);
        if (pending) { pending.resolve(constructor); _whenDefinedPromises.delete(lowerName); }
        try {
            const existing = document.querySelectorAll(lowerName);
            for (let i = 0; i < existing.length; i++) {
                const el = existing[i];
                _upgradeElement(el, { constructor });
                _tryCallLifecycle(el, "connectedCallback");
            }
        } catch (e) {}
    });
    _defProtoMethod(_CERProto, 'get', function get(name) {
        const entry = _customElementsRegistry.get(name.toLowerCase());
        return entry ? entry.constructor : undefined;
    });
    _defProtoMethod(_CERProto, 'whenDefined', function whenDefined(name) {
        const lowerName = name.toLowerCase();
        if (_customElementsRegistry.has(lowerName)) return Promise.resolve(_customElementsRegistry.get(lowerName).constructor);
        if (!_whenDefinedPromises.has(lowerName)) {
            let resolve;
            const promise = new Promise(r => { resolve = r; });
            _whenDefinedPromises.set(lowerName, { promise, resolve });
        }
        return _whenDefinedPromises.get(lowerName).promise;
    });
    _defProtoMethod(_CERProto, 'upgrade', function upgrade(root) {
        for (const [name, entry] of _customElementsRegistry) {
            try {
                const els = root.querySelectorAll(name);
                for (let i = 0; i < els.length; i++) _upgradeElement(els[i], entry);
            } catch (e) {}
        }
    });
    Object.defineProperty(_CERProto, Symbol.toStringTag, { value: "CustomElementRegistry", configurable: true });
    globalThis.customElements = Object.create(_CERProto);

    // Store reference for DOM hooks
    globalThis._customElementsRegistry = _customElementsRegistry;

    // --- Blob ---

    // --- OffscreenCanvas ---
    // Chrome since 69 ships OffscreenCanvas as a global. Its absence reads
    // as a "not really Chrome" signal. We expose a minimal class
    // that satisfies constructor checks and typeof checks; `getContext` is a
    // no-op stub that returns null (the sensor VM falls through to fallback
    // paths when null is returned).
    if (!globalThis.OffscreenCanvas) {
        class OffscreenCanvas {
            constructor(width, height) {
                this.width = width | 0;
                this.height = height | 0;
            }
            getContext(_type, _opts) { return null; }
            transferToImageBitmap() {
                // Minimal ImageBitmap stub — not callable for real rendering.
                return { width: this.width, height: this.height, close() {} };
            }
            convertToBlob(options) {
                return Promise.resolve(new Blob([], { type: (options && options.type) || "image/png" }));
            }
        }
        Object.defineProperty(OffscreenCanvas.prototype, Symbol.toStringTag, {
            value: "OffscreenCanvas", configurable: true,
        });
        globalThis.OffscreenCanvas = OffscreenCanvas;
    }

    // --- File (extends Blob) ---
    if (!globalThis.File) {
        globalThis.File = class File extends Blob {
            constructor(parts, name, options = {}) {
                super(parts, options);
                this.name = name;
                this.lastModified = options.lastModified || Date.now();
            }
        };
    }

    // --- IndexedDB ---
    //
    // In-memory implementation backed by JS Maps plus a sorted keys
    // array per store for ordered cursor iteration. Spec compliance
    // is scoped to the fingerprint-probe subset: open → upgrade →
    // transaction → put/get/delete/clear/count/getAll/openCursor,
    // IDBKeyRange (bound/only/lower/upper), version upgrade lifecycle,
    // deep-clone isolation on put/get so stored values don't leak
    // mutations back to the caller. Persistent storage is NOT
    // implemented — every page load starts with an empty DB registry,
    // which is fine for scraping (no cross-session state).

    // ================================================================
    // WebRTC leak prevention — block real IP exposure via ICE candidates
    // ================================================================
    globalThis.RTCDataChannel = class RTCDataChannel extends EventTarget {
        constructor() {
            super(); const _st = _idl.own(this); _st.label = ""; _st.readyState = "connecting"; this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null; }
        send() {}
        close() {}
    };
    _idl.fields(RTCDataChannel.prototype, ["label", "readyState"]);
    const _rtcHexDigit = () => Math.floor(Math.random() * 16).toString(16);
    const _rtcDigits = (n) => {
        let out = String(1 + Math.floor(Math.random() * 9));
        for (let i = 1; i < n; i++) out += Math.floor(Math.random() * 10);
        return out;
    };
    const _rtcBase64ish = (n) => {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let out = '';
        for (let i = 0; i < n; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
        return out;
    };
    const _rtcFingerprint = () => {
        const bytes = [];
        for (let i = 0; i < 32; i++) {
            bytes.push((_rtcHexDigit() + _rtcHexDigit()).toUpperCase());
        }
        return bytes.join(':');
    };
    const _rtcUuid4 = () => {
        let out = '';
        for (let i = 0; i < 36; i++) {
            if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
            else if (i === 14) out += '4';
            else if (i === 19) out += (8 + Math.floor(Math.random() * 4)).toString(16);
            else out += _rtcHexDigit();
        }
        return out;
    };

    globalThis.RTCPeerConnection = class RTCPeerConnection extends EventTarget {
        #channels;
        #ice;
        #recvAudio;
        #recvVideo;
        constructor(config) {
            super();
            const _st = _idl.own(this);
            _st.localDescription = null;
            _st.remoteDescription = null;
            _st.signalingState = "stable";
            _st.iceConnectionState = "new";
            _st.iceGatheringState = "new";
            _st.connectionState = "new";
            this.onicecandidate = null;
            this.oniceconnectionstatechange = null;
            this.onsignalingstatechange = null;
            this.ondatachannel = null;
            this.ontrack = null;
            this.#channels = [];
            // Set (and latched — real transceivers persist across
            // renegotiation) by createOffer({offerToReceiveAudio/Video}).
            // A fingerprint probe that requests both and then regexes the
            // SDP for `m=audio`/`m=video` lines got `null` for both from
            // the old data-channel-only SDP — a structural tell no real
            // WebRTC stack produces for that call.
            this.#recvAudio = false;
            this.#recvVideo = false;
            // Per-connection identity, the way a browser mints one: ICE
            // credentials and a DTLS certificate fingerprint are fresh for every
            // RTCPeerConnection, so these are random rather than profile-derived.
            this.#ice = {
                sessionId: _rtcDigits(19),
                ufrag: _rtcBase64ish(4),
                pwd: _rtcBase64ish(24),
                fingerprint: _rtcFingerprint(),
                mdns: _rtcUuid4() + '.local',
                port: 50000 + Math.floor(Math.random() * 15000),
                foundation: String(Math.floor(Math.random() * 4000000000)),
            };
        }
        // A Chrome-shaped offer for a data channel. The stub this replaces was
        // four lines with no media section, no ICE credentials and no candidate,
        // which is not something any WebRTC stack emits — detectors parse the SDP
        // for exactly those fields and reported the transport as blocked or
        // unsupported because none of them were there.
        // Shared per-mid transport lines every BUNDLEd m-section repeats.
        #transportLines(setup, mid) {
            const ice = this.#ice;
            return [
                'a=ice-ufrag:' + ice.ufrag,
                'a=ice-pwd:' + ice.pwd,
                'a=ice-options:trickle',
                'a=fingerprint:sha-256 ' + ice.fingerprint,
                'a=setup:' + setup,
                'a=mid:' + mid,
            ];
        }
        // recvonly section for a codec list, matching what this same
        // connection's RTCRtpSender/Receiver.getCapabilities() advertises —
        // a detector that cross-checks the SDP against that API sees the
        // same codecs in both places, not a mismatch.
        #mediaSection(kind, setup, mid, payloads) {
            const proto = 'UDP/TLS/RTP/SAVPF';
            const pts = payloads.map(p => p.pt).join(' ');
            const lines = [
                `m=${kind} 9 ${proto} ${pts}`,
                'c=IN IP4 0.0.0.0',
                'a=rtcp:9 IN IP4 0.0.0.0',
                ...this.#transportLines(setup, mid),
                'a=recvonly',
                'a=rtcp-mux',
            ];
            if (kind === 'video') lines.push('a=rtcp-rsize');
            for (const p of payloads) {
                lines.push(`a=rtpmap:${p.pt} ${p.rtpmap}`);
                if (p.fmtp) lines.push(`a=fmtp:${p.pt} ${p.fmtp}`);
                if (kind === 'video') {
                    lines.push(`a=rtcp-fb:${p.pt} goog-remb`);
                    lines.push(`a=rtcp-fb:${p.pt} transport-cc`);
                    lines.push(`a=rtcp-fb:${p.pt} ccm fir`);
                    lines.push(`a=rtcp-fb:${p.pt} nack`);
                    lines.push(`a=rtcp-fb:${p.pt} nack pli`);
                }
            }
            return lines;
        }
        // A Chrome-shaped offer for a data channel (and, once requested,
        // recvonly audio/video m-sections). The stub this replaces was
        // four lines with no media section, no ICE credentials and no candidate,
        // which is not something any WebRTC stack emits — detectors parse the SDP
        // for exactly those fields and reported the transport as blocked or
        // unsupported because none of them were there.
        #buildSdp(setup) {
            const ice = this.#ice;
            const mids = ['0'];
            const sections = [[
                'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
                'c=IN IP4 0.0.0.0',
                ...this.#transportLines(setup, '0'),
                'a=sctp-port:5000',
                'a=max-message-size:262144',
            ]];
            if (this.#recvAudio) {
                const mid = String(mids.length);
                mids.push(mid);
                sections.push(this.#mediaSection('audio', setup, mid, [
                    { pt: 111, rtpmap: 'opus/48000/2', fmtp: 'minptime=10;useinbandfec=1' },
                    { pt: 0, rtpmap: 'PCMU/8000' },
                    { pt: 8, rtpmap: 'PCMA/8000' },
                ]));
            }
            if (this.#recvVideo) {
                const mid = String(mids.length);
                mids.push(mid);
                sections.push(this.#mediaSection('video', setup, mid, [
                    { pt: 96, rtpmap: 'VP8/90000' },
                    { pt: 98, rtpmap: 'VP9/90000', fmtp: 'profile-id=0' },
                    { pt: 102, rtpmap: 'H264/90000', fmtp: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
                ]));
            }
            const lines = [
                'v=0',
                `o=- ${ice.sessionId} 2 IN IP4 127.0.0.1`,
                's=-',
                't=0 0',
                'a=group:BUNDLE ' + mids.join(' '),
                'a=extmap-allow-mixed',
                'a=msid-semantic: WMS',
                ...sections.flat(),
            ];
            return lines.join('\r\n') + '\r\n';
        }
        createDataChannel(label, options) {
            const ch = new RTCDataChannel();
            _idl.own(ch).label = String(label);
            this.#channels.push(ch);
            return ch;
        }
        createOffer(options) {
            // Legacy RTCOfferOptions — deprecated in favor of addTransceiver,
            // but real Chrome still honours them by implicitly adding a
            // recvonly transceiver, and it's exactly what fingerprint
            // probes (no camera/mic, just checking capability) send.
            if (options?.offerToReceiveAudio) this.#recvAudio = true;
            if (options?.offerToReceiveVideo) this.#recvVideo = true;
            return Promise.resolve({ type: "offer", sdp: this.#buildSdp('actpass') });
        }
        createAnswer() {
            return Promise.resolve({ type: "answer", sdp: this.#buildSdp('active') });
        }
        #applySignalingState(desc, isLocal) {
            const _st = _idl.own(this);
            // Minimal offer/answer state machine — real Chrome moves
            // through have-{local,remote}-offer on an offer and back to
            // stable on the matching answer. Leaving this at the
            // constructor's "stable" forever (the old behaviour) is a
            // tell: no real connection sits in "stable" right after
            // setLocalDescription(offer).
            if (!desc || !desc.type) return;
            if (desc.type === 'offer') {
                _st.signalingState = isLocal ? 'have-local-offer' : 'have-remote-offer';
            } else if (desc.type === 'answer' || desc.type === 'rollback') {
                _st.signalingState = 'stable';
            }
            try { this.dispatchEvent(new Event('signalingstatechange')); } catch (_) { /* ignore */ }
            if (this.onsignalingstatechange) this.onsignalingstatechange();
        }
        setLocalDescription(desc) {
            const _st = _idl.own(this);
            _st.localDescription = desc;
            this.#applySignalingState(desc, true);
            // Real Chrome (since 2019, mDNS-anonymized) emits an mDNS host
            // candidate followed by `null` to signal gathering complete.
            // Returning ONLY `{candidate: null}` is itself a tell — every
            // legitimate Chrome session yields at least one mDNS host.
            // The `<uuid>.local` form is privacy-preserving (no real IP).
            //
            // Built from this connection's own identity so the candidate and the
            // SDP agree: a host line whose credentials belong to a different
            // session is exactly the kind of internal contradiction a detector
            // looks for.
            const ice = this.#ice;
            const candidate = `candidate:${ice.foundation} 1 udp 2113937151 ${ice.mdns} `
                + `${ice.port} typ host generation 0 ufrag ${ice.ufrag} network-cost 999`;
            const iceCandidate = new globalThis.RTCIceCandidate({
                candidate, sdpMid: '0', sdpMLineIndex: 0,
            });
            // Chrome folds gathered candidates into the local description, so a
            // script that reads `pc.localDescription.sdp` after gathering sees
            // them there and not only through the event.
            if (desc && typeof desc.sdp === 'string' && desc.sdp.indexOf('a=candidate') < 0) {
                const withCandidate = desc.sdp
                    + 'a=' + candidate + '\r\n'
                    + 'a=end-of-candidates\r\n';
                _st.localDescription = { type: desc.type, sdp: withCandidate };
            }
            _st.iceGatheringState = "gathering";
            // Both halves: the handler attribute and a dispatched event, because
            // a page may use either and a browser fires both.
            const emit = (value) => {
                let ev = null;
                try {
                    ev = new Event('icecandidate');
                    Object.defineProperty(ev, 'candidate', {
                        value, enumerable: true, configurable: true,
                    });
                    this.dispatchEvent(ev);
                } catch (_) { /* ignore */ }
                if (this.onicecandidate) this.onicecandidate(ev || { candidate: value });
            };
            setTimeout(() => {
                emit(iceCandidate);
                setTimeout(() => {
                    emit(null);
                    _st.iceGatheringState = "complete";
                    try {
                        this.dispatchEvent(new Event('icegatheringstatechange'));
                    } catch (_) { /* ignore */ }
                }, 12);
            }, 8);
            return Promise.resolve();
        }
        setRemoteDescription(desc) {
            const _st = _idl.own(this);
            _st.remoteDescription = desc;
            this.#applySignalingState(desc, false);
            return Promise.resolve();
        }
        addIceCandidate(c) { return Promise.resolve(); }
        addTrack() { return { track: null }; }
        addStream() {}
        removeTrack() {}
        getStats() { return Promise.resolve(new Map()); }
        getSenders() { return []; }
        getReceivers() { return []; }
        getTransceivers() { return []; }
        close() {
            const _st = _idl.own(this);
            _st.signalingState = "closed";
            _st.iceConnectionState = "closed";
            _st.connectionState = "closed";
        }
        // No `addEventListener`/`removeEventListener` overrides here: they used
        // to be empty stubs shadowing the real EventTarget methods, so a listener
        // registered the standard way was silently dropped. Every WebRTC probe
        // that watches for `icecandidate` through `addEventListener` — which is
        // the usual form — then saw nothing and reported the transport blocked.
    };
    _idl.fields(RTCPeerConnection.prototype, ["connectionState", "iceConnectionState", "iceGatheringState", "localDescription", "remoteDescription", "signalingState"]);
    globalThis.RTCPeerConnection.generateCertificate = () => Promise.resolve({});
    globalThis.webkitRTCPeerConnection = globalThis.RTCPeerConnection;
    globalThis.RTCSessionDescription = class RTCSessionDescription { constructor(d) { this.type = d?.type; this.sdp = d?.sdp; } };
    // Chrome parses the candidate line into named fields, and probes read them
    // directly — `event.candidate.foundation` was undefined here.
    globalThis.RTCIceCandidate = class RTCIceCandidate {
        constructor(c) {
            const _st = _idl.own(this);
            _st.candidate = c?.candidate || "";
            _st.sdpMid = c?.sdpMid ?? null;
            _st.sdpMLineIndex = c?.sdpMLineIndex ?? null;
            const m = /^candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)/.exec(this.candidate);
            _st.foundation = m ? m[1] : null;
            _st.component = m ? (m[2] === '1' ? 'rtp' : 'rtcp') : null;
            _st.protocol = m ? m[3].toLowerCase() : null;
            _st.priority = m ? Number(m[4]) : null;
            _st.address = m ? m[5] : null;
            _st.port = m ? Number(m[6]) : null;
            _st.type = m ? m[7] : null;
            _st.tcpType = null;
            _st.relatedAddress = null;
            _st.relatedPort = null;
            const uf = /\bufrag (\S+)/.exec(this.candidate);
            _st.usernameFragment = uf ? uf[1] : (c?.usernameFragment ?? null);
        }
        toJSON() {
            return {
                candidate: this.candidate,
                sdpMid: this.sdpMid,
                sdpMLineIndex: this.sdpMLineIndex,
                usernameFragment: this.usernameFragment,
            };
        }
    };
    _idl.fields(RTCIceCandidate.prototype, ["address", "candidate", "component", "foundation", "port", "priority", "protocol", "relatedAddress", "relatedPort", "sdpMLineIndex", "sdpMid", "tcpType", "type", "usernameFragment"]);

    // ================================================================
    // Font enumeration spoofing — return OS-appropriate fonts
    // ================================================================
    {
        const _osName = _p("os_name", "Linux");
        // Chrome default fonts by OS
        const _fontsByOS = {
            "Windows": ["Arial","Arial Black","Calibri","Cambria","Comic Sans MS","Consolas","Courier New","Georgia","Impact","Lucida Console","Segoe UI","Tahoma","Times New Roman","Trebuchet MS","Verdana"],
            "macOS": ["Arial","Arial Black","Courier New","Georgia","Helvetica","Helvetica Neue","Lucida Grande","Menlo","Monaco","SF Pro","Times New Roman","Trebuchet MS","Verdana"],
            "Linux": ["Arial","Courier New","DejaVu Sans","DejaVu Sans Mono","DejaVu Serif","Liberation Mono","Liberation Sans","Liberation Serif","Noto Sans","Times New Roman","Ubuntu","Verdana"],
        };
        const _fonts = _fontsByOS[_osName] || _fontsByOS["Linux"];
        const _fontSet = new Set(_fonts.map(f => f.toLowerCase()));

        const _fontWeightNum = (w) => {
            const named = {
                thin: 100, "extra-light": 200, "ultra-light": 200, light: 300,
                normal: 400, regular: 400, medium: 500, "semi-bold": 600,
                "demi-bold": 600, bold: 700, "extra-bold": 800, "ultra-bold": 800,
                black: 900, heavy: 900,
            }[String(w).toLowerCase().trim()];
            if (named) return named;
            const n = parseInt(w, 10);
            return Number.isFinite(n) ? n : 400;
        };
        const _localFontSrc = /^\s*local\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)\s*$/;

        // FontFace and FontFaceSet, built as real interfaces.
        //
        // Both used to be hand-rolled object literals: `document.fonts` was a
        // plain `{}` whose every member was an own enumerable property, so
        // `Object.prototype.toString.call(document.fonts)` said
        // `[object Object]` where Chrome says `[object FontFaceSet]`, and
        // `Object.keys(document.fonts)` listed 14 names where Chrome lists
        // none. Shapes below are from a Chrome 148 capture; member order is
        // creation order, which is what getOwnPropertyNames reports.
        const _ffState = new WeakMap();
        const _FF_DEFAULTS = {
            style: "normal", weight: "normal", stretch: "normal",
            unicodeRange: "U+0-10FFFF", variant: "normal",
            featureSettings: "normal", display: "auto",
            ascentOverride: "normal", descentOverride: "normal",
            lineGapOverride: "normal", sizeAdjust: "100%",
            variationSettings: "normal",
        };

        function FontFace(family, source, descriptors) {
            const st = Object.assign({}, _FF_DEFAULTS, {
                family: String(family),
                source,
                status: "unloaded",
                loadPromise: null,
            });
            for (const k of Object.keys(_FF_DEFAULTS)) {
                if (descriptors && descriptors[k] !== undefined) st[k] = String(descriptors[k]);
            }
            // `loaded` must be a Promise from construction, and an unsettled
            // rejection here would surface as an unhandled rejection.
            st.loaded = new Promise((res, rej) => { st.resolve = res; st.reject = rej; });
            st.loaded.catch(() => {});
            _ffState.set(this, st);
        }
        Object.defineProperty(FontFace, "length", { value: 2, configurable: true });
        _maskFunction(FontFace, "FontFace");

        const _ffGet = (obj) => _ffState.get(obj) || {};
        // Descriptor attributes come before status/loaded/load in Chrome's
        // prototype, and `variationSettings` sits AFTER `load` — not with its
        // fellow descriptors.
        for (const name of ["family", "style", "weight", "stretch", "unicodeRange",
                            "variant", "featureSettings", "display", "ascentOverride",
                            "descentOverride", "lineGapOverride", "sizeAdjust"]) {
            _defProtoGetter(FontFace.prototype,
                name,
                function () { return _ffGet(this)[name]; },
                function (v) { const s = _ffState.get(this); if (s) s[name] = String(v); });
        }
        _defProtoGetter(FontFace.prototype, "status", function () { return _ffGet(this).status; });
        _defProtoGetter(FontFace.prototype, "loaded", function () { return _ffGet(this).loaded; });
        _defProtoMethod(FontFace.prototype, "load", function load() {
            const st = _ffState.get(this);
            if (!st) return Promise.reject(new TypeError("Illegal invocation"));
            if (st.loadPromise) return st.loadPromise;
            st.status = "loading";
            // A `local(name)` source is a presence probe, and real browsers
            // reject it for a font that is not installed — resolving it
            // unconditionally makes every probed name come back "installed",
            // which is itself the tell. `url(...)` sources are not probes.
            const m = _localFontSrc.exec(String(st.source || ""));
            if (m) {
                const localName = (m[1] ?? m[2] ?? m[3] ?? "").trim();
                const italic = /italic|oblique/i.test(String(st.style));
                if (!ops.op_font_family_available(localName, _fontWeightNum(st.weight), italic, _osName)) {
                    st.status = "error";
                    const err = new DOMException('Failed to load local font: "' + localName + '"', "NetworkError");
                    st.reject(err);
                    st.loadPromise = Promise.reject(err);
                    st.loadPromise.catch(() => {});
                    return st.loadPromise;
                }
            }
            st.status = "loaded";
            st.resolve(this);
            st.loadPromise = Promise.resolve(this);
            return st.loadPromise;
        });
        _defProtoGetter(FontFace.prototype, "variationSettings",
            function () { return _ffGet(this).variationSettings; },
            function (v) { const s = _ffState.get(this); if (s) s.variationSettings = String(v); });
        Object.defineProperty(FontFace.prototype, Symbol.toStringTag, {
            value: "FontFace", configurable: true,
        });
        // `constructor` lands last in Chrome's property order, not first as a
        // function's own prototype object gives it. Order is creation order,
        // so it has to be deleted and re-added rather than redefined in place.
        delete FontFace.prototype.constructor;
        Object.defineProperty(FontFace.prototype, "constructor", {
            value: FontFace, writable: true, enumerable: false, configurable: true,
        });
        globalThis.FontFace = FontFace;

        // FontFaceSet. Chrome does NOT expose the interface object on window,
        // and its prototype carries no own `constructor` — so
        // `document.fonts.constructor.name` reads through to `EventTarget`.
        const _fontFaceSetProto = Object.create(globalThis.EventTarget.prototype);
        const _setState = new WeakMap();
        const _setFaces = (o) => (_setState.get(o) || { faces: [] }).faces;

        for (const ev of ["onloading", "onloadingdone", "onloadingerror"]) {
            _defProtoGetter(_fontFaceSetProto, ev,
                function () { const s = _setState.get(this); return (s && s[ev]) || null; },
                function (v) { const s = _setState.get(this); if (s) s[ev] = v; });
        }
        _defProtoGetter(_fontFaceSetProto, "ready", function () {
            const s = _setState.get(this);
            return s ? s.ready : Promise.resolve(this);
        });
        _defProtoGetter(_fontFaceSetProto, "status", function () { return "loaded"; });
        _defProtoGetter(_fontFaceSetProto, "size", function () { return _setFaces(this).length; });

        // Chrome's `check` answers "can this be painted now", so an unknown
        // family is `true` — it falls back to a system font. Only an
        // unparseable font shorthand is an error. Ours used to return whether
        // the family was installed, inverting the answer for every web font
        // the page itself declares and for every bogus name a probe tries.
        _defProtoMethod(_fontFaceSetProto, "check", function check(font, ...rest) {
            const text = rest[0];
            if (!/\d\s*(px|pt|pc|in|cm|mm|q|em|rem|ex|ch|vh|vw|vmin|vmax|%)\s+\S/i.test(String(font))) {
                throw new DOMException("Failed to execute 'check' on 'FontFaceSet': Could not resolve '" + font + "' as a font.", "SyntaxError");
            }
            return true;
        });
        _defProtoMethod(_fontFaceSetProto, "load", function load(font, ...rest) {
            const text = rest[0];
            try { this.check(font, text); } catch (e) { return Promise.reject(e); }
            return Promise.resolve(_setFaces(this).slice());
        });
        _defProtoMethod(_fontFaceSetProto, "add", function add(face) {
            const f = _setState.get(this);
            if (f && !f.faces.includes(face)) f.faces.push(face);
            return this;
        });
        _defProtoMethod(_fontFaceSetProto, "clear", function clear() {
            const f = _setState.get(this);
            if (f) f.faces.length = 0;
        });
        _defProtoMethod(_fontFaceSetProto, "delete", function (face) {
            const f = _setState.get(this);
            if (!f) return false;
            const i = f.faces.indexOf(face);
            if (i < 0) return false;
            f.faces.splice(i, 1);
            return true;
        });
        _defProtoMethod(_fontFaceSetProto, "entries", function entries() {
            return _setFaces(this).map(f => [f, f])[Symbol.iterator]();
        });
        _defProtoMethod(_fontFaceSetProto, "forEach", function forEach(cb, ...rest) {
            const thisArg = rest[0];
            for (const f of _setFaces(this)) cb.call(thisArg, f, f, this);
        });
        _defProtoMethod(_fontFaceSetProto, "has", function has(face) {
            return _setFaces(this).includes(face);
        });
        _defProtoMethod(_fontFaceSetProto, "keys", function keys() {
            return _setFaces(this)[Symbol.iterator]();
        });
        _defProtoMethod(_fontFaceSetProto, "values", function values() {
            return _setFaces(this)[Symbol.iterator]();
        });
        Object.defineProperty(_fontFaceSetProto, Symbol.toStringTag, {
            value: "FontFaceSet", configurable: true,
        });
        Object.defineProperty(_fontFaceSetProto, Symbol.iterator, {
            value: _fontFaceSetProto.values, writable: true, configurable: true,
        });

        if (typeof globalThis.FontFaceSet !== "function") {
            const FontFaceSet = { FontFaceSet() { throw new TypeError("Illegal constructor"); } }.FontFaceSet;
            Object.defineProperty(FontFaceSet, "length", { value: 0, configurable: true });
            Object.defineProperty(FontFaceSet, "prototype", {
                value: _fontFaceSetProto, writable: false, enumerable: false, configurable: false,
            });
            Object.defineProperty(_fontFaceSetProto, "constructor", {
                value: FontFaceSet, writable: true, enumerable: false, configurable: true,
            });
            Object.setPrototypeOf(FontFaceSet, globalThis.EventTarget);
            _maskFunction(FontFaceSet, "FontFaceSet");
            Object.defineProperty(globalThis, "FontFaceSet", {
                value: FontFaceSet, writable: true, enumerable: false, configurable: true,
            });
        }

        // The document's own `@font-face` rules — NOT the installed system
        // fonts, which is what this set used to hold. Chrome reports 0 on a
        // page that declares none, and one entry per rule on a page that does.
        const _documentFaceSet = () => {
            const set = Object.create(_fontFaceSetProto);
            const faces = [];
            let declared = [];
            try { declared = ops.op_dom_font_faces() || []; } catch (_) {}
            for (const d of declared) {
                const f = new FontFace(d.family, "", {
                    style: d.style, weight: d.weight, stretch: d.stretch,
                    unicodeRange: d.unicode_range, variant: d.variant,
                    featureSettings: d.feature_settings, display: d.display,
                    ascentOverride: d.ascent_override, descentOverride: d.descent_override,
                    lineGapOverride: d.line_gap_override, sizeAdjust: d.size_adjust,
                    variationSettings: d.variation_settings,
                });
                const st = _ffState.get(f);
                st.status = "loaded";
                st.resolve(f);
                faces.push(f);
            }
            _setState.set(set, { faces, ready: Promise.resolve(set) });
            return set;
        };

        // `document.fonts` is a prototype getter in Chrome, not an own data
        // property of the document instance.
        if (globalThis.Document) {
            const _fontsByDoc = new WeakMap();
            _defProtoGetter(globalThis.Document.prototype, "fonts", function () {
                let set = _fontsByDoc.get(this);
                if (!set) { set = _documentFaceSet(); _fontsByDoc.set(this, set); }
                return set;
            });
        }
    }

    // ================================================================
    // Apple Pay — macOS-only window.ApplePaySession
    // ================================================================
    // ApplePaySession is installed POST-snapshot in cleanup_bootstrap.js
    // because the V8 startup snapshot is built without a stealth profile,
    // so a snapshot-time `_p("os_name")` would always read "Linux" and
    // skip the install for every page. cleanup runs once per JsRuntime
    // creation with the profile loaded, which is the correct gating point.

    // ================================================================
    // Battery API — realistic values (already exists but enhance)
    // ================================================================
    // Already defined above in navigator — the existing implementation is sufficient.

    // ================================================================
    // Speech synthesis — OS-specific voices
    // ================================================================
    {
        const _osName = _p("os_name", "Linux");
        const _voicesByOS = {
            "Windows": [
                {name:"Microsoft David",lang:"en-US",localService:true,default:true,voiceURI:"Microsoft David"},
                {name:"Microsoft Zira",lang:"en-US",localService:true,default:false,voiceURI:"Microsoft Zira"},
                {name:"Microsoft Mark",lang:"en-US",localService:true,default:false,voiceURI:"Microsoft Mark"},
                {name:"Google US English",lang:"en-US",localService:false,default:false,voiceURI:"Google US English"},
                {name:"Google UK English Female",lang:"en-GB",localService:false,default:false,voiceURI:"Google UK English Female"},
            ],
            "macOS": [
                {name:"Alex",lang:"en-US",localService:true,default:true,voiceURI:"com.apple.voice.compact.en-US.Samantha"},
                {name:"Samantha",lang:"en-US",localService:true,default:false,voiceURI:"com.apple.voice.compact.en-US.Samantha"},
                {name:"Victoria",lang:"en-US",localService:true,default:false,voiceURI:"com.apple.speech.synthesis.voice.Victoria"},
                {name:"Google US English",lang:"en-US",localService:false,default:false,voiceURI:"Google US English"},
            ],
            "Linux": [
                {name:"Google US English",lang:"en-US",localService:false,default:true,voiceURI:"Google US English"},
                {name:"Google UK English Female",lang:"en-GB",localService:false,default:false,voiceURI:"Google UK English Female"},
                {name:"Google UK English Male",lang:"en-GB",localService:false,default:false,voiceURI:"Google UK English Male"},
            ],
        };
        const _voices = _voicesByOS[_osName] || _voicesByOS["Linux"];
        // Override the existing speechSynthesis with OS-aware voices
        globalThis.speechSynthesis.getVoices = function() { return _voices; };
    }

    // ================================================================
    // Media codecs — Chrome-correct isTypeSupported / canPlayType
    // ================================================================
    {
        const _supportedTypes = new Set([
            "video/mp4", 'video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
            'video/mp4; codecs="avc1.4D401E"', 'video/mp4; codecs="avc1.64001E"',
            "video/webm", 'video/webm; codecs="vp8"', 'video/webm; codecs="vp8, vorbis"',
            'video/webm; codecs="vp9"', 'video/webm; codecs="vp09.00.10.08"',
            "audio/mp4", 'audio/mp4; codecs="mp4a.40.2"',
            "audio/webm", 'audio/webm; codecs="opus"', 'audio/webm; codecs="vorbis"',
            "audio/mpeg", "audio/ogg", 'audio/ogg; codecs="vorbis"', 'audio/ogg; codecs="opus"',
            "audio/wav", 'audio/wav; codecs="1"', "audio/flac",
            // Chrome accepts these codec MIME aliases too. Some scripts test
            // audio/x-m4a and audio/aac (and the common misspelling "acc")
            // and read the verdict from MediaSource.isTypeSupported. Without
            // these entries we return false where Chrome returns true.
            "audio/x-m4a", "audio/aac", "audio/acc",
            "audio/mp3", "audio/x-wav",
        ]);

        // Removed redundant MediaSource definition here; it is defined further down.

        // `canPlayType` belongs on HTMLMediaElement.prototype, where Chrome
        // keeps it. It used to be installed per element by a patched
        // `document.createElement`, which left both an own `canPlayType` on
        // every <video>/<audio> and an own `createElement` on the document —
        // two own properties no real document has.
        //
        // The shim must be _maskFunction'd or its raw source leaks via
        // `el.canPlayType + ""`, `el.canPlayType.toString()`, AND
        // cross-realm `iframe.contentWindow.Function.prototype.toString.call(el.canPlayType)`.
        {
            const _canPlayTypeShim = function canPlayType(type) {
                if (_supportedTypes.has(type)) return "probably";
                const base = String(type).split(';')[0].trim();
                if (_supportedTypes.has(base)) return "maybe";
                return "";
            };
            if (typeof _maskFunction === "function") {
                _maskFunction(_canPlayTypeShim, "canPlayType");
            }
            const _mediaProto = globalThis.HTMLMediaElement
                && globalThis.HTMLMediaElement.prototype;
            if (_mediaProto) {
                Object.defineProperty(_mediaProto, "canPlayType", {
                    value: _canPlayTypeShim, writable: true, enumerable: true, configurable: true,
                });
            }
        }

        // MediaRecorder — Chrome ships this as a real constructor with
        // a static isTypeSupported(mimeType) for codec capability checks.
        // Without it, a script reading isTypeSupported throws
        // "Cannot read properties of undefined (reading 'isTypeSupported')".
        // Stub class — produces no recordings but answers capability
        // probes correctly using the same _supportedTypes set.
        // Removed redundant MediaRecorder definition here; it is defined further down.
    }

    // ================================================================
    // Stubs for Web APIs that scripts commonly probe. All defined
    // as globalThis classes + (where applicable) navigator/window
    // accessors. These return defined-but-functionally-stub objects
    // so scripts that read `.SOME_PROPERTY` get a non-undefined
    // receiver.
    // ================================================================


    // MediaSourceHandle — wraps MediaSource for transfer to Worker.
    // (https://w3c.github.io/media-source/#mediasourcehandle-interface).
    // Commonly probed. Stub class with toString tag.
    if (!globalThis.MediaSourceHandle) {
        class MediaSourceHandle {}
        Object.defineProperty(MediaSourceHandle.prototype, Symbol.toStringTag, {
            value: 'MediaSourceHandle', configurable: true,
        });
        globalThis.MediaSourceHandle = MediaSourceHandle;
    }

    // DocumentPictureInPicture — Document Picture-in-Picture API
    // (https://wicg.github.io/document-picture-in-picture/). Chrome 116+.
    // Commonly probed. Singleton on window.
    if (!globalThis.DocumentPictureInPicture) {
        class DocumentPictureInPicture extends EventTarget {
            constructor() { super(); this._window = null; }
            get window() { return this._window; }
            requestWindow(_options) {
                // We don't actually open a PiP window in headless. Reject
                // to match Chrome's headless behavior.
                return Promise.reject(new DOMException(
                    'Document PiP requires a user gesture',
                    'NotAllowedError'
                ));
            }
        }
        Object.defineProperty(DocumentPictureInPicture.prototype, Symbol.toStringTag, {
            value: 'DocumentPictureInPicture', configurable: true,
        });
        globalThis.DocumentPictureInPicture = DocumentPictureInPicture;
        const _docPip = new DocumentPictureInPicture();
        Object.defineProperty(globalThis, 'documentPictureInPicture', {
            get: () => _docPip, configurable: true, enumerable: true,
        });
    }

    // navigator.userActivation — UserActivation interface
    // (https://html.spec.whatwg.org/multipage/interaction.html#useractivation).
    // Reports whether the user has interacted with the page (gestures).
    // Probed by various scripts.
    // Chrome 88+ only — real Safari (any platform) has no UserActivation
    // interface. Skip the class install AND the navigator binding on iOS.
    if (!_isMobileIOS() && typeof globalThis.UserActivation === 'undefined') {
        class UserActivation {
            #hasBeenActive;
            #isActive;
            constructor() {
                this.#hasBeenActive = false;
                this.#isActive = false;
            }
            get hasBeenActive() { return this.#hasBeenActive; }
            get isActive() { return this.#isActive; }
        }
        Object.defineProperty(UserActivation.prototype, Symbol.toStringTag, {
            value: 'UserActivation', configurable: true,
        });
        globalThis.UserActivation = UserActivation;
        const _userAct = new UserActivation();
        // Wire onto navigator (and Navigator.prototype when accessor-defined).
        try {
            Object.defineProperty(navigator, 'userActivation', {
                get: () => _userAct, configurable: true, enumerable: true,
            });
        } catch (_e) {}
    }

    // --- Native code masking ---
    // Some scripts check Function.prototype.toString() for polyfilled APIs.
    // Real Chrome returns "function X() { [native code] }" for built-in functions.
    // Wrap our polyfills so toString() returns the native format.

    // Mask navigator methods
    _maskAsNative(navigator, 'javaEnabled', 'sendBeacon', 'getBattery');
    if (navigator.keyboard) _maskAsNative(navigator.keyboard, 'getLayoutMap', 'lock', 'unlock');
    _maskAsNative(PluginArray.prototype, 'item', 'namedItem', 'refresh');
    _maskAsNative(MimeTypeArray.prototype, 'item', 'namedItem');
    _maskAsNative(Plugin.prototype, 'item', 'namedItem');
    // Mask WebRTC
    _maskAsNative(globalThis.RTCPeerConnection.prototype, 'createOffer', 'createAnswer',
        'setLocalDescription', 'setRemoteDescription', 'addIceCandidate', 'close',
        'createDataChannel', 'getStats', 'getSenders', 'getReceivers', 'getTransceivers',
        'addTrack', 'removeTrack');
    _maskAsNative(globalThis.RTCPeerConnection, 'generateCertificate');
    
    // Mask document.write
    if (globalThis.document) {
        _maskAsNative(Object.getPrototypeOf(globalThis.document), 'write', 'writeln');
    }
    // Mask MediaSource
    if (globalThis.MediaSource) _maskAsNative(globalThis.MediaSource, 'isTypeSupported');
    // Mask speechSynthesis
    _maskAsNative(globalThis.speechSynthesis, 'getVoices', 'speak', 'cancel', 'pause', 'resume');
    if (navigator.permissions) _maskAsNative(navigator.permissions, 'query');
    if (navigator.mediaDevices) _maskAsNative(navigator.mediaDevices, 'enumerateDevices');
    if (navigator.clipboard) _maskAsNative(navigator.clipboard, 'readText', 'writeText');
    if (navigator.storage) _maskAsNative(navigator.storage, 'estimate');
    if (navigator.serviceWorker) _maskAsNative(navigator.serviceWorker, 'register', 'getRegistrations', 'getRegistration', 'startMessages');

    // Mask window methods
    _maskAsNative(globalThis, 'fetch', 'alert', 'confirm', 'prompt', 'open', 'close',
        'scrollTo', 'scroll', 'scrollBy', 'getComputedStyle', 'matchMedia',
        'getSelection', 'postMessage', 'requestIdleCallback', 'atob', 'btoa');

    // Mask document methods
    if (globalThis.document) {
        _maskAsNative(globalThis.document, 'createElement', 'createTextNode',
            'createDocumentFragment', 'createEvent', 'createRange',
            'getElementById', 'querySelector', 'querySelectorAll',
            'getElementsByTagName', 'getElementsByClassName',
            'write', 'writeln', 'execCommand', 'hasFocus',
            'elementFromPoint', 'elementsFromPoint', 'getSelection',
            'importNode', 'adoptNode');
    }

    // ================================================================
    // Error stack trace filtering.
    // Remove deno_core internal frames AND all browser_oxide bootstrap
    // script names from Error.stack. An earlier trace
    // showed `at h (<init_script_0>:51:34)`, exposing a
    // browser_oxide-internal script name. Real Chrome's stack frames
    // never show such tags; they show either real URLs or <anonymous>.
    //
    // Filter strategy: drop any frame whose filename is angle-bracketed
    // (`<...>`), `<anonymous>` included. Our bootstraps are compiled with
    // resourceName "<anonymous>" (see runtime.rs), so their frames are the
    // ONLY ones whose getFileName() returns the literal "<anonymous>". Real
    // eval()/Function() frames report a NULL filename (isEval() true) — the
    // "<anonymous>" they display is synthesised by getEvalOrigin formatting
    // below, not by getFileName — so they survive this filter untouched.
    // Dropping "<anonymous>" therefore strips leaked internal DOM-machinery
    // frames (_onNodeInserted, appendChild, _evalAsScript) that real Chrome —
    // where those operations are native and invisible — never shows, while
    // still catching `<bootstrap>`, `<init_script_N>`, `<worker_bootstrap>`,
    // etc. without per-name additions.
    // ================================================================
    Error.prepareStackTrace = function(err, frames) {
        const filtered = frames.filter(f => {
            const file = f.getFileName() || '';
            if (file.startsWith('ext:') || file.startsWith('deno:')) return false;
            if (file.includes('core/')) return false;
            if (file.startsWith('<') && file.endsWith('>')) {
                return false;
            }
            return true;
        });
        if (filtered.length === 0) {
            return err.toString() + '\n    at <anonymous>:1:1';
        }
        // V8's own CallSite formatting, reproduced. The previous version emitted
        // `at fn (file:line:col)` and nothing else, so the receiver was always
        // missing: real Chrome writes `at Talon.updateIfNeeded (…)` and
        // `at Object._0x3375a3 [as execute] (…)`. Talon ships `new Error().stack`
        // verbatim in its payload, so that shape is compared directly.
        const _fileLocation = (f) => {
            if (f.isNative && f.isNative()) return 'native';
            let s = (f.getScriptNameOrSourceURL && f.getScriptNameOrSourceURL())
                || f.getFileName()
                || (f.isEval && f.isEval() && f.getEvalOrigin && f.getEvalOrigin())
                || '<anonymous>';
            const line = f.getLineNumber();
            if (line !== null && line !== undefined) {
                s += ':' + line;
                const col = f.getColumnNumber();
                if (col) s += ':' + col;
            }
            return s;
        };
        const _frame = (f) => {
            let out = '';
            let addSuffix = true;
            const fn = f.getFunctionName();
            const isCtor = f.isConstructor && f.isConstructor();
            const isMethodCall = !((f.isToplevel && f.isToplevel()) || isCtor);
            if (isMethodCall) {
                const typeName = f.getTypeName && f.getTypeName();
                const methodName = f.getMethodName && f.getMethodName();
                if (fn) {
                    if (typeName && fn.indexOf(typeName) !== 0) out += typeName + '.';
                    out += fn;
                    if (methodName
                        && fn.lastIndexOf('.' + methodName) !== fn.length - methodName.length - 1) {
                        out += ' [as ' + methodName + ']';
                    }
                } else {
                    out += (typeName ? typeName + '.' : '') + (methodName || '<anonymous>');
                }
            } else if (isCtor) {
                out += 'new ' + (fn || '<anonymous>');
            } else if (fn) {
                out += fn;
            } else {
                out += _fileLocation(f);
                addSuffix = false;
            }
            if (addSuffix) out += ' (' + _fileLocation(f) + ')';
            return '    at ' + out;
        };
        return err.toString() + '\n' + filtered.map(_frame).join('\n');
    };

    // ================================================================
    // performance.now() — humanized via op_perf_now_humanized.
    //
    // Real Chrome 130 quantizes to 100 µs but with hardware/scheduler jitter
    // around the step. A perfect 100 µs grid (Math.round * 10 / 10) gives
    // `set(diffs).size === 1` for hot loops, which differs from real Chrome.
    //
    // The op applies LogNormal(μ=ln 8 µs, σ=0.4) jitter clamped [0,35] µs
    // plus rare exponential spike. Installed on Performance.prototype so the
    // own-descriptor probe still returns undefined on the instance.
    // ================================================================
    if (typeof globalThis.Performance === 'function' && globalThis.performance) {
        const _PProto = globalThis.Performance.prototype;
        _defProtoMethod(_PProto, 'now', function now() {
            return ops.op_perf_now_humanized();
        });
    }

    // ================================================================
    // VisualViewport — Chrome surface that fingerprint scripts probe to
    // detect mobile vs desktop AND to detect headless absence. Real
    // Chrome exposes a singleton instance accessible as
    // MediaSource + MediaRecorder.isTypeSupported in window realm.
    // Some scripts read .isTypeSupported.
    (() => {
        // Some scripts test audio/x-m4a + audio/aac + audio/acc and read
        // the boolean verdict. Real Chrome returns true; without these
        // entries we return false, a real engine gap. Brought in line with
        // the first _supportedTypes Set above (the canPlayType one).
        const _supportedTypes = new Set([
            "video/mp4", 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
            'video/mp4;codecs="avc1.640028"', "video/webm",
            'video/webm;codecs="vp8,vorbis"', 'video/webm;codecs="vp9"',
            'video/webm;codecs="vp9,opus"', "audio/mp4",
            'audio/mp4;codecs="mp4a.40.2"', "audio/webm",
            'audio/webm;codecs=opus', 'audio/webm;codecs=vorbis',
            // Codec MIME aliases some scripts test:
            "audio/x-m4a", "audio/aac", "audio/acc",
            "audio/mpeg", "audio/ogg", "audio/wav", "audio/flac",
            "audio/mp3", "audio/x-wav",
        ]);
        
        const _isTypeSupported = ({
            isTypeSupported(type) {
                if (typeof type !== 'string') return false;
                if (_supportedTypes.has(type)) return true;
                const base = type.split(';')[0].trim();
                return _supportedTypes.has(base);
            }
        }).isTypeSupported;
        _maskFunction(_isTypeSupported, "isTypeSupported");

        class SourceBufferList extends EventTarget {
            constructor() {
                super(); const _st = _idl.own(this); _st.length = 0; }
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
    _idl.fields(SourceBufferList.prototype, ["length"]);
        _maskFunction(SourceBufferList, "SourceBufferList");

        // Replace stubs with real (non-throwing) constructors so a script
        // can call `new MediaSource()` during init without aborting.
        (() => {
            class MediaSource extends EventTarget {
                constructor() {
                    super();
                    const _st = _idl.own(this);
                    _st.readyState = 'closed';
                    this.duration = NaN;
                    _st.sourceBuffers = new SourceBufferList();
                    _st.activeSourceBuffers = new SourceBufferList();
                }
                addSourceBuffer() { throw new DOMException('InvalidStateError'); }
                removeSourceBuffer() { throw new DOMException('InvalidStateError'); }
                endOfStream() {}
                setLiveSeekableRange() {}
                clearLiveSeekableRange() {}
                static isTypeSupported(type) { return _isTypeSupported(type); }
                static get canConstructInDedicatedWorker() { return false; }
            }
    _idl.fields(MediaSource.prototype, ["activeSourceBuffers", "readyState", "sourceBuffers"]);
            _maskFunction(MediaSource, "MediaSource");
            globalThis.MediaSource = MediaSource;
        })();
        (() => {
            class MediaRecorder extends EventTarget {
                constructor(stream, options) {
                    super();
                    const _st = _idl.own(this);
                    _st.stream = stream || null;
                    _st.mimeType = (options && options.mimeType) || '';
                    _st.state = 'inactive';
                    _st.audioBitsPerSecond = 0;
                    _st.videoBitsPerSecond = 0;
                }
                start() {}
                stop() {}
                pause() {}
                resume() {}
                requestData() {}
                static isTypeSupported(type) { return _isTypeSupported(type); }
            }
    _idl.fields(MediaRecorder.prototype, ["audioBitsPerSecond", "mimeType", "state", "stream", "videoBitsPerSecond"]);
            _maskFunction(MediaRecorder, "MediaRecorder");
            globalThis.MediaRecorder = MediaRecorder;
        })();

        const _getCapabilities = ({
            getCapabilities(kind) {
                return {
                    codecs: kind === 'audio' ? [
                        { channels: 2, clockRate: 48000, mimeType: "audio/opus" },
                        { channels: 1, clockRate: 8000, mimeType: "audio/PCMU" },
                        { channels: 1, clockRate: 8000, mimeType: "audio/PCMA" }
                    ] : [
                        { clockRate: 90000, mimeType: "video/VP8" },
                        { clockRate: 90000, mimeType: "video/VP9", sdpFmtpLine: "profile-id=0" },
                        { clockRate: 90000, mimeType: "video/H264", sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f" }
                    ],
                    headerExtensions: []
                };
            }
        }).getCapabilities;
        _maskFunction(_getCapabilities, "getCapabilities");

        if (globalThis.RTCRtpReceiver) {
            Object.defineProperty(globalThis.RTCRtpReceiver, 'getCapabilities', {
                value: _getCapabilities, configurable: true, writable: true, enumerable: false
            });
            _maskFunction(globalThis.RTCRtpReceiver, "RTCRtpReceiver");
        }
        if (globalThis.RTCRtpSender) {
            Object.defineProperty(globalThis.RTCRtpSender, 'getCapabilities', {
                value: _getCapabilities, configurable: true, writable: true, enumerable: false
            });
            _maskFunction(globalThis.RTCRtpSender, "RTCRtpSender");
        }
    })();

    // `window.visualViewport`. Properties are layout-derived but for
    // a stationary viewport without pinch-zoom they equal the layout
    // viewport scaled by 1.0. Spec:
    // https://www.w3.org/TR/visual-viewport/
    // ================================================================
    {
        class VisualViewport extends EventTarget {
            get offsetLeft() { return 0; }
            get offsetTop() { return 0; }
            get pageLeft() { return 0; }
            get pageTop() { return 0; }
            get width() { return _pInt("inner_width", 1920); }
            get height() { return _pInt("inner_height", 1080); }
            get scale() { return 1; }
            get onresize() { return null; }
            set onresize(_v) {}
            get onscroll() { return null; }
            set onscroll(_v) {}
            get onscrollend() { return null; }
            set onscrollend(_v) {}
        }
        Object.defineProperty(VisualViewport.prototype, Symbol.toStringTag, {
            value: "VisualViewport", configurable: true,
        });
        globalThis.VisualViewport = VisualViewport;
        const _vv = new VisualViewport();
        Object.defineProperty(globalThis, 'visualViewport', {
            get() { return _vv; }, configurable: true, enumerable: true,
        });
    }

    // ================================================================
    // InputDeviceCapabilities — present on UIEvent.sourceCapabilities
    // in real Chrome. Sites probe `event.sourceCapabilities` on the
    // first user-input event to confirm a real input device fired it.
    // We define the constructor; integration with synthesized events
    // is deferred to the input_ext humanization layer.
    // ================================================================
    {
        class InputDeviceCapabilities {
            constructor(init) {
                const _st = _idl.own(this);
                _st.firesTouchEvents = !!(init && init.firesTouchEvents);
            }
        }
    _idl.fields(InputDeviceCapabilities.prototype, ["firesTouchEvents"]);
        Object.defineProperty(InputDeviceCapabilities.prototype, Symbol.toStringTag, {
            value: "InputDeviceCapabilities", configurable: true,
        });
        globalThis.InputDeviceCapabilities = InputDeviceCapabilities;
    }

    // ================================================================
    // MediaSession — `navigator.mediaSession` is a real `MediaSession`
    // instance in Chrome, not a plain `{}`. Sites use its presence to
    // gate playback-state UI and to drive system media controls.
    // Spec: https://w3c.github.io/mediasession/
    // ================================================================
    {
        const _validStates = new Set(["none", "playing", "paused"]);
        class MediaMetadata {
            constructor(init) {
                init = init || {};
                this.title = String(init.title || "");
                this.artist = String(init.artist || "");
                this.album = String(init.album || "");
                this.artwork = Array.isArray(init.artwork) ? init.artwork.slice() : [];
            }
        }
        Object.defineProperty(MediaMetadata.prototype, Symbol.toStringTag, {
            value: "MediaMetadata", configurable: true,
        });
        globalThis.MediaMetadata = MediaMetadata;

        class MediaSession {
            #handlers;
            #metadata;
            #playbackState;
            constructor() {
                this.#playbackState = "none";
                this.#metadata = null;
                this.#handlers = new Map();
            }
            get playbackState() { return this.#playbackState; }
            set playbackState(v) {
                const s = String(v);
                if (_validStates.has(s)) this.#playbackState = s;
            }
            get metadata() { return this.#metadata; }
            set metadata(v) {
                this.#metadata = v instanceof MediaMetadata ? v : null;
            }
            setActionHandler(action, handler) {
                if (handler == null) {
                    this.#handlers.delete(String(action));
                } else if (typeof handler === "function") {
                    this.#handlers.set(String(action), handler);
                }
            }
            setPositionState(_state) { /* spec accepts {duration, position, playbackRate} */ }
            setCameraActive(_active) { /* video conferencing extension */ }
            setMicrophoneActive(_active) { /* video conferencing extension */ }
        }
        Object.defineProperty(MediaSession.prototype, Symbol.toStringTag, {
            value: "MediaSession", configurable: true,
        });
        globalThis.MediaSession = MediaSession;
        const _ms = new MediaSession();
        // Override the placeholder navigator.mediaSession (was {}).
        try {
            Object.defineProperty(_NavProto, 'mediaSession', {
                get() { return _ms; }, configurable: true, enumerable: true,
            });
        } catch (_) {
            navigator.mediaSession = _ms;
        }
    }

    // ================================================================
    // MediaCapabilities — `navigator.mediaCapabilities` is a real
    // `MediaCapabilities` instance in every modern Chrome / Safari /
    // Firefox. Many scripts probe it; when the property is `undefined`
    // the probe throws `Cannot read properties of undefined (reading '…')`
    // and the resulting error differs from a real browser.
    // Spec: https://w3c.github.io/media-capabilities/
    // Gated to non-Gecko UAs: Firefox's MediaCapabilities returns
    // {supported: true} for fewer codec families and exact shape match
    // is hard to fake. Pre-v3 firefox passes without this surface.
    // ================================================================
    if (!/Firefox\/|Gecko\/20100101/.test(_p("user_agent", "")) && typeof globalThis.MediaCapabilities === "function") {
        const _mc = _svc.make(globalThis.MediaCapabilities);
        Object.defineProperty(_NavProto, 'mediaCapabilities', {
            get() { return _mc; }, configurable: true, enumerable: true,
        });
    }

    // ================================================================
    // HTMLVideoElement.prototype.requestVideoFrameCallback — Chrome/Safari.
    // Firefox added it in 132 but with subtly different metadata shape.
    // Adding our Chrome-shaped impl to a Firefox profile creates a tell
    // that fingerprint scripts can detect. Gate to
    // non-Gecko profiles. Spec: https://wicg.github.io/video-rvfc/
    // ================================================================
    const _isGeckoUA = /Firefox\/|Gecko\/20100101/.test(
        _p("user_agent", "")
    );
    if (!_isGeckoUA && typeof globalThis.HTMLVideoElement !== "undefined" &&
        typeof globalThis.HTMLVideoElement.prototype.requestVideoFrameCallback !== "function") {
        let _rvfcSeq = 1;
        const _pendingRvfc = new Map();
        const _requestVideoFrameCallback = function requestVideoFrameCallback(cb) {
            if (typeof cb !== "function") {
                throw new TypeError(
                    "Failed to execute 'requestVideoFrameCallback' on 'HTMLVideoElement': " +
                    "The callback provided as parameter 1 is not a function.");
            }
            const id = _rvfcSeq++;
            // Schedule a single callback ~1 frame ahead. Real Chrome
            // fires when a new frame is presented; without playback we
            // approximate the rAF cadence.
            const handle = setTimeout(() => {
                _pendingRvfc.delete(id);
                try {
                    cb(performance.now(), {
                        presentationTime: performance.now(),
                        expectedDisplayTime: performance.now() + 16.67,
                        width: 0, height: 0,
                        mediaTime: 0, presentedFrames: 0,
                        processingDuration: 0,
                    });
                } catch (_) {}
            }, 16);
            _pendingRvfc.set(id, handle);
            return id;
        };
        const _cancelVideoFrameCallback = function cancelVideoFrameCallback(id) {
            const handle = _pendingRvfc.get(id);
            if (handle != null) {
                clearTimeout(handle);
                _pendingRvfc.delete(id);
            }
        };
        Object.defineProperty(globalThis.HTMLVideoElement.prototype, "requestVideoFrameCallback", {
            value: _requestVideoFrameCallback, configurable: true, writable: true,
        });
        Object.defineProperty(globalThis.HTMLVideoElement.prototype, "cancelVideoFrameCallback", {
            value: _cancelVideoFrameCallback, configurable: true, writable: true,
        });
        try {
            _maskAsNative(globalThis.HTMLVideoElement.prototype,
                "requestVideoFrameCallback", "cancelVideoFrameCallback");
        } catch (_) {}
    }

    // ================================================================
    // Emerging APIs that scripts commonly probe for existence
    // ================================================================

    // navigator.gpu (WebGPU) — prototype getter so own-descriptor probe
    // returns undefined on the instance (kNoScriptId-safe).
    if (!_NavProto.hasOwnProperty('gpu')) {
        const _navGpu = _svc.make(globalThis.GPU);
        // WebGPU is [SecureContext] — undefined on data:/http:/about:blank.
        _defNav('gpu', () => _secure() ? _navGpu : undefined);
    }

    // Storage Access API: installed on Document.prototype further down, which
    // is where Chrome has it — the instance must stay own-property-free.

    // CSS.supports()
    if (!globalThis.CSS) globalThis.CSS = {};
    if (!globalThis.CSS.escape) {
        // CSSOM `CSS.escape` — serialise a string as a CSS identifier. Widely used by
        // component libraries and by anything that builds selectors from ids/names;
        // its absence is a plain TypeError at the call site.
        globalThis.CSS.escape = function escape(value) {
            const s = String(value);
            let out = "";
            for (let i = 0; i < s.length; i++) {
                const c = s.charCodeAt(i);
                const ch = s[i];
                if (c === 0x0000) {
                    out += "�";
                } else if (
                    (c >= 0x0001 && c <= 0x001f) || c === 0x007f ||
                    (i === 0 && c >= 0x0030 && c <= 0x0039) ||
                    (i === 1 && c >= 0x0030 && c <= 0x0039 && s.charCodeAt(0) === 0x002d)
                ) {
                    out += "\\" + c.toString(16) + " ";
                } else if (i === 0 && c === 0x002d && s.length === 1) {
                    out += "\\" + ch;
                } else if (
                    c >= 0x0080 || c === 0x002d || c === 0x005f ||
                    (c >= 0x0030 && c <= 0x0039) ||
                    (c >= 0x0041 && c <= 0x005a) ||
                    (c >= 0x0061 && c <= 0x007a)
                ) {
                    out += ch;
                } else {
                    out += "\\" + ch;
                }
            }
            return out;
        };
    }
    if (!globalThis.CSS.supports) {
        const _cssSupported = new Set([
            "display:grid", "display:flex", "display:block", "display:inline",
            "position:sticky", "position:fixed", "position:absolute",
            "gap:1px", "aspect-ratio:1", "container-type:inline-size",
            "color:oklch(0 0 0)", "color:color-mix(in srgb,red,blue)",
            "backdrop-filter:blur(1px)", "overflow:clip",
            "translate:none", "rotate:none", "scale:none",
            "accent-color:auto", "overscroll-behavior:contain",
        ]);
        globalThis.CSS.supports = function(prop, val) {
            if (val === undefined) {
                // Single argument: CSS.supports("display: grid")
                return _cssSupported.has(prop.replace(/\s+/g, '').toLowerCase()) || true;
            }
            return _cssSupported.has(`${prop.toLowerCase()}:${val.toLowerCase()}`) || true;
        };
    }

    // navigator.scheduling is already defined on Navigator.prototype above
    // with isInputPending() — no need to re-install on the instance.

    // crossOriginIsolated is now installed as an op-backed getter near the
    // top of window_bootstrap.js (search for op_cross_origin_isolated).
    // No fallback needed — defineProperty above runs before any user JS.

    // ================================================================
    // Trusted Types API (Chrome 83+)
    // Some scripts and CSP policies check window.trustedTypes presence.
    // ================================================================
    if (!globalThis.trustedTypes) {
        globalThis.trustedTypes = _svc.make(globalThis.TrustedTypePolicyFactory);
    }

    // ================================================================
    // Scheduler API (Chrome 104+)
    // window.scheduler.postTask / scheduler.yield are commonly checked.
    // ================================================================
    if (!globalThis.scheduler) {
        globalThis.scheduler = _svc.make(globalThis.Scheduler);
    }

    // ================================================================
    // reportError (Chrome 95+) — dispatches an ErrorEvent on window.
    // ================================================================
    if (!globalThis.reportError) {
        globalThis.reportError = ({
            reportError(err) {
                const evt = new ErrorEvent('error', { error: err, message: err && err.message || String(err), bubbles: true, cancelable: true });
                globalThis.dispatchEvent(evt);
            }
        }).reportError;
        _maskAsNative(globalThis, 'reportError');
    }

    // ================================================================
    // Touch / TouchEvent constructors — present in Chrome on all platforms.
    // Desktop Chrome defines them even though touch isn't available.
    // Some scripts check typeof Touch / typeof TouchEvent.
    // ================================================================
    if (!globalThis.Touch) {
        globalThis.Touch = function Touch(init) {
            if (!init || init.identifier === undefined || !init.target) {
                throw new TypeError("Failed to construct 'Touch': required members identifier and target");
            }
            const _st = _idl.own(this);
            _st.identifier = init.identifier;
            _st.target = init.target;
            _st.clientX = init.clientX || 0;
            _st.clientY = init.clientY || 0;
            _st.screenX = init.screenX || 0;
            _st.screenY = init.screenY || 0;
            _st.pageX = init.pageX || 0;
            _st.pageY = init.pageY || 0;
            _st.radiusX = init.radiusX || 0;
            _st.radiusY = init.radiusY || 0;
            _st.rotationAngle = init.rotationAngle || 0;
            _st.force = init.force || 0;
            _st.altitudeAngle = init.altitudeAngle || 0;
            _st.azimuthAngle = init.azimuthAngle || 0;
            _st.touchType = init.touchType || 'direct';
        };
        globalThis.Touch.prototype = Object.create(Object.prototype, {
            constructor: { value: globalThis.Touch, configurable: true, writable: true },
            [Symbol.toStringTag]: { value: "Touch", configurable: true },
        });
        _idl.fields(globalThis.Touch.prototype, ["clientX", "clientY", "force", "identifier", "pageX", "pageY", "radiusX", "radiusY", "rotationAngle", "screenX", "screenY", "target"]);
        _maskAsNative(globalThis.Touch);
    }
    if (!globalThis.TouchEvent) {
        globalThis.TouchEvent = function TouchEvent(type, init) {
            const base = new Event(type || 'touchstart', init || {});
            base.touches = (init && init.touches) ? init.touches : new TouchList();
            base.targetTouches = (init && init.targetTouches) ? init.targetTouches : new TouchList();
            base.changedTouches = (init && init.changedTouches) ? init.changedTouches : new TouchList();
            base.altKey = (init && init.altKey) || false;
            base.ctrlKey = (init && init.ctrlKey) || false;
            base.metaKey = (init && init.metaKey) || false;
            base.shiftKey = (init && init.shiftKey) || false;
            return base;
        };
        globalThis.TouchEvent.prototype = Object.create(Event.prototype, {
            constructor: { value: globalThis.TouchEvent, configurable: true, writable: true },
        });
        _maskAsNative(globalThis.TouchEvent);
    }
    if (!globalThis.TouchList) {
        globalThis.TouchList = function TouchList() { _idl.own(this).length = 0; };
        _idl.fields(globalThis.TouchList.prototype, ["length"]);
        globalThis.TouchList.prototype.item = function(i) { return this[i] || null; };
        _maskAsNative(globalThis.TouchList);
    }

    // ================================================================
    // SharedArrayBuffer — only available with cross-origin isolation.
    // Chrome hides it (returns undefined) without COOP+COEP headers.
    // Most sites don't set these headers, so SAB is undefined on most pages.
    // V8 doesn't let us delete built-in globals, so we shadow with a getter
    // that returns undefined, matching Chrome's non-isolated behavior.
    // ================================================================
    if (!ops.op_cross_origin_isolated()) {
        try {
            Object.defineProperty(globalThis, 'SharedArrayBuffer', {
                get: () => undefined,
                configurable: true,
                enumerable: false,
            });
        } catch(_) {}
    }

    // ================================================================
    // Phase 6 D4 — Missing-constructor batch (10 surfaces)
    //
    // Real Chrome 147 macOS exposes these surfaces. Most are
    // "present-but-doesn't-work" — Chrome ships the constructor /
    // instance with the right shape, but invoking the network/IO path
    // either rejects (network APIs) or no-ops (UI APIs). We mirror the
    // shape so detection probes don't see absence.
    //
    // ================================================================

    // (1) globalThis.caches — CacheStorage (Service Worker spec)
    // Spec: https://w3c.github.io/ServiceWorker/#cachestorage
    // [SecureContext] — undefined on insecure contexts. Phase 7.
    if (_secure() && typeof globalThis.caches === "undefined") {
        Object.defineProperty(globalThis, "caches", {
            value: _svc.make(globalThis.CacheStorage), configurable: true, enumerable: true, writable: false,
        });
    }

    // (2) globalThis.cookieStore — async Cookie Store API
    // Spec: https://wicg.github.io/cookie-store/
    // [SecureContext] — undefined on insecure contexts. Phase 7.
    // Real Chrome exposes a CookieStore INSTANCE on globalThis (not a
    // constructor) when secure. Our prior `_illegalCtor("CookieStore")`
    // from interfaces_bootstrap is replaced unconditionally so the
    // *constructor* exists on globalThis as a real class — but the
    // instance binding `globalThis.cookieStore` is gated on secure.
    {
        // Real Chrome's CookieStore is [Exposed] but has no public
        // constructor — `new CookieStore()` throws "Failed to construct
        // 'CookieStore': Illegal constructor". We mirror that, while
        // still being able to materialise the `globalThis.cookieStore`
        // instance via a private symbol that's only known to this file.
        const _internalBuild = Symbol("CookieStore.internalBuild");
        class CookieStore extends EventTarget {
            constructor(token) {
                super();
                if (token !== _internalBuild) {
                    throw new TypeError(
                        "Failed to construct 'CookieStore': Illegal constructor"
                    );
                }
            }
            get(_name) { return Promise.resolve(null); }
            getAll(_name) { return Promise.resolve([]); }
            set(_optionsOrName, _value) { return Promise.resolve(); }
            delete(_optionsOrName) { return Promise.resolve(); }
        }
        Object.defineProperty(CookieStore.prototype, Symbol.toStringTag, {
            value: "CookieStore", configurable: true,
        });
        // Override the earlier _illegalCtor binding from interfaces_bootstrap.
        Object.defineProperty(globalThis, "CookieStore", {
            value: CookieStore, configurable: true, writable: true,
        });
        if (_secure()) {
            Object.defineProperty(globalThis, "cookieStore", {
                value: new CookieStore(_internalBuild), configurable: true, enumerable: true,
            });
        }
    }

    // (3) performance.eventCounts — EventCounts Map
    // Spec: https://wicg.github.io/event-timing/#eventcounts
    // Real Chrome 147 pre-populates this with 36 known event-type keys
    // at value 0. Insertion order matches Chromium's EventTypeNames
    // enumeration — some scripts probe `eventCounts.size > 0` and
    // `Array.from(eventCounts.keys()).slice(0, 10)`. First-10 captured
    // from a real browser confirm: pointerdown, touchend, input,
    // keydown, mouseleave, mouseenter, drop, beforeinput, pointerenter,
    // dragend. Phase 7.
    if (globalThis.performance && typeof globalThis.performance.eventCounts === "undefined") {
        let _EventCounts_get_inner;
        class EventCounts {
            static {
                _EventCounts_get_inner = (o) => o.#inner;
            }
            #inner;
            constructor() { this.#inner = new Map(); }
            get size() { return this.#inner.size; }
            get(name) { return this.#inner.get(String(name)); }
            has(name) { return this.#inner.has(String(name)); }
            entries() { return this.#inner.entries(); }
            keys() { return this.#inner.keys(); }
            values() { return this.#inner.values(); }
            forEach(cb, thisArg) { this.#inner.forEach(cb, thisArg); }
            [Symbol.iterator]() { return this.#inner[Symbol.iterator](); }
        }
        Object.defineProperty(EventCounts.prototype, Symbol.toStringTag, {
            value: "EventCounts", configurable: true,
        });
        globalThis.EventCounts = EventCounts;
        const _ec = new EventCounts();
        for (const k of [
            "pointerdown", "touchend", "input", "keydown",
            "mouseleave", "mouseenter", "drop", "beforeinput",
            "pointerenter", "dragend", "dragstart", "dragenter",
            "dragover", "dragleave", "drag", "pointerout",
            "pointerleave", "pointercancel", "pointermove", "pointerup",
            "pointerover", "wheel", "click", "auxclick",
            "contextmenu", "dblclick", "mousedown", "mouseup",
            "mousemove", "mouseout", "mouseover", "keyup",
            "keypress", "compositionstart", "compositionupdate", "compositionend",
        ]) {
            _EventCounts_get_inner(_ec).set(k, 0);
        }
        // Mount on Performance.prototype, not the instance — real Chrome
        // exposes eventCounts as a prototype getter so
        // Object.getOwnPropertyNames(performance) is empty. If we set it
        // as an own property, fingerprint scripts that count
        // performance's own props would flag it as "modified
        // performance".
        try {
            const _PerfProto = globalThis.Performance && globalThis.Performance.prototype
                ? globalThis.Performance.prototype
                : Object.getPrototypeOf(globalThis.performance);
            Object.defineProperty(_PerfProto, "eventCounts", {
                get: () => _ec, configurable: true, enumerable: true,
            });
        } catch (_e) {}
    }

    // (4) Notification.requestPermission — upgrade the existing minimal
    // Notification class to a full constructor + Promise-returning
    // requestPermission. Real Chrome's requestPermission returns a
    // Promise that resolves to "default" / "granted" / "denied".
    // Both Promise and legacy callback forms are supported per spec.
    {
        class Notification extends EventTarget {
            constructor(title, options) {
                super();
                const _st = _idl.own(this);
                if (arguments.length === 0) {
                    throw new TypeError("Failed to construct 'Notification': 1 argument required, but only 0 present.");
                }
                _st.title = String(title);
                _st.dir = (options && options.dir) || "auto";
                _st.lang = (options && options.lang) || "";
                _st.body = (options && options.body) || "";
                _st.tag = (options && options.tag) || "";
                _st.icon = (options && options.icon) || "";
                _st.image = (options && options.image) || "";
                _st.badge = (options && options.badge) || "";
                _st.data = (options && options.data) ?? null;
                _st.silent = (options && options.silent) ?? null;
                _st.requireInteraction = !!(options && options.requireInteraction);
                _st.actions = (options && options.actions) || [];
                _st.timestamp = Date.now();
                this.onclick = null;
                this.onerror = null;
                this.onclose = null;
                this.onshow = null;
            }
            close() {}
        }
    _idl.fields(Notification.prototype, ["title", "dir", "lang", "body", "tag", "icon", "badge", "data", "silent", "requireInteraction", "actions", "timestamp"]);
        Object.defineProperty(Notification.prototype, Symbol.toStringTag, {
            value: "Notification", configurable: true,
        });
        // Phase 7 — Chrome's "default" on secure contexts; "denied"
        // on insecure (data:/http:/about:blank) per Notification API
        // spec which gates the prompt UI on secure context.
        Object.defineProperty(Notification, "permission", {
            get: () => _secure() ? "default" : "denied", configurable: true,
        });
        Object.defineProperty(Notification, "maxActions", {
            get: () => 2, configurable: true, enumerable: true,
        });
        Notification.requestPermission = ({
            requestPermission(deprecatedCallback) {
                // Always resolves to "default" — we never actually grant; matches
                // headless Chrome behaviour and avoids a tell when the user
                // never clicks the (non-existent) browser permission UI.
                const result = "default";
                const promise = Promise.resolve(result);
                // Legacy callback form support (Notification spec § Permission).
                if (typeof deprecatedCallback === "function") {
                    Promise.resolve().then(() => {
                        try { deprecatedCallback(result); } catch (_e) {}
                    });
                }
                return promise;
            }
        }).requestPermission;
        _maskFunction(Notification.requestPermission, "requestPermission");
        _maskFunction(Notification, "Notification");
        globalThis.Notification = Notification;
    }

    // (5) ApplePaySession — macOS/iOS only surface.
    (() => {
        const ApplePaySession = ({
            ApplePaySession() { throw new TypeError("Illegal constructor"); }
        }).ApplePaySession;
        ApplePaySession.canMakePayments = ({ canMakePayments() { return true; } }).canMakePayments;
        ApplePaySession.canMakePaymentsWithActiveCard = ({ canMakePaymentsWithActiveCard() { return Promise.resolve(true); } }).canMakePaymentsWithActiveCard;
        ApplePaySession.supportsVersion = ({ supportsVersion() { return true; } }).supportsVersion;
        _maskFunction(ApplePaySession, 'ApplePaySession');
        _maskFunction(ApplePaySession.canMakePayments, 'canMakePayments');
        _maskFunction(ApplePaySession.canMakePaymentsWithActiveCard, 'canMakePaymentsWithActiveCard');
        _maskFunction(ApplePaySession.supportsVersion, 'supportsVersion');
        Object.defineProperty(globalThis, 'ApplePaySession', {
            get: () => _p("os_name", "") === "macOS" ? ApplePaySession : undefined,
            configurable: true, enumerable: false
        });
    })();


    // (6) IdleDetector — User Idle Detection API (Chrome 94+)
    // Spec: https://wicg.github.io/idle-detection/
    // [SecureContext] — undefined on insecure contexts. Phase 7.
    // Chrome-only — real Safari has no IdleDetector. Skip on iOS.
    if (!_isMobileIOS() && _secure() && typeof globalThis.IdleDetector === "undefined") {
        class IdleDetector extends EventTarget {
            constructor() {
                super();
                const _st = _idl.own(this);
                _st.userState = null;
                _st.screenState = null;
                this.onchange = null;
            }
            start(_options) { return Promise.reject(new DOMException("Not allowed", "NotAllowedError")); }
            abort() {}
        }
    _idl.fields(IdleDetector.prototype, ["screenState", "userState"]);
        Object.defineProperty(IdleDetector.prototype, Symbol.toStringTag, {
            value: "IdleDetector", configurable: true,
        });
        IdleDetector.requestPermission = function requestPermission() {
            return Promise.resolve("default");
        };
        if (typeof _maskFunction === "function") {
            _maskFunction(IdleDetector.requestPermission, "requestPermission");
        }
        globalThis.IdleDetector = IdleDetector;
    }

    // (6) EyeDropper — Color picker constructor (Chrome 95+)
    // Spec: https://wicg.github.io/eyedropper-api/
    // [SecureContext] — undefined on insecure contexts. Phase 7.
    if (_secure() && typeof globalThis.EyeDropper === "undefined") {
        class EyeDropper {
            constructor() {}
            open(_options) {
                return Promise.reject(new DOMException("The user canceled the selection", "AbortError"));
            }
        }
        Object.defineProperty(EyeDropper.prototype, Symbol.toStringTag, {
            value: "EyeDropper", configurable: true,
        });
        globalThis.EyeDropper = EyeDropper;
    }

    // (7) navigator.virtualKeyboard — Virtual Keyboard API (Chrome 94+)
    // Spec: https://w3c.github.io/virtual-keyboard/
    {
        class VirtualKeyboard extends EventTarget {
            constructor() {
                super();
                this._overlaysContent = false;
                this._boundingRect = { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
                this.ongeometrychange = null;
            }
            get overlaysContent() { return this._overlaysContent; }
            set overlaysContent(v) { this._overlaysContent = !!v; }
            get boundingRect() { return this._boundingRect; }
            show() {}
            hide() {}
        }
        Object.defineProperty(VirtualKeyboard.prototype, Symbol.toStringTag, {
            value: "VirtualKeyboard", configurable: true,
        });
        globalThis.VirtualKeyboard = VirtualKeyboard;
        try {
            const _vk = new VirtualKeyboard();
            // VirtualKeyboard is [SecureContext]. Phase 7.
            Object.defineProperty(_NavProto, "virtualKeyboard", {
                get: () => _secure() ? _vk : undefined, configurable: true, enumerable: true,
            });
        } catch (_e) {}
    }

    // (8) navigator.devicePosture — Device Posture API (Chrome 132+)
    // Spec: https://w3c.github.io/device-posture/
    {
        class DevicePosture extends EventTarget {
            constructor() {
                super();
                _idl.own(this)._type = "continuous"; // Desktop default
                this.onchange = null;
            }
            get type() { return _idl.own(this)._type; }
        }
        Object.defineProperty(DevicePosture.prototype, Symbol.toStringTag, {
            value: "DevicePosture", configurable: true,
        });
        globalThis.DevicePosture = DevicePosture;
        try {
            const _dp = new DevicePosture();
            // DevicePosture is [SecureContext]. Phase 7.
            Object.defineProperty(_NavProto, "devicePosture", {
                get: () => _secure() ? _dp : undefined, configurable: true, enumerable: true,
            });
        } catch (_e) {}
    }

    // (9) navigator.windowControlsOverlay — PWA Window Controls Overlay
    // Spec: https://wicg.github.io/window-controls-overlay/
    // Outside an installed PWA context this object exists with
    // visible:false and an empty rect — match that.
    {
        class WindowControlsOverlay extends EventTarget {
            constructor() {
                super();
                this._visible = false;
                this.ongeometrychange = null;
            }
            get visible() { return this._visible; }
            getTitlebarAreaRect() {
                return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0,
                         toJSON() { return {x:0,y:0,width:0,height:0,top:0,right:0,bottom:0,left:0}; } };
            }
        }
        Object.defineProperty(WindowControlsOverlay.prototype, Symbol.toStringTag, {
            value: "WindowControlsOverlay", configurable: true,
        });
        globalThis.WindowControlsOverlay = WindowControlsOverlay;
        try {
            const _wco = new WindowControlsOverlay();
            Object.defineProperty(_NavProto, "windowControlsOverlay", {
                get: () => _wco, configurable: true, enumerable: true,
            });
        } catch (_e) {}
    }

    // (10) Document.prototype.startViewTransition — View Transitions API
    // Spec: https://drafts.csswg.org/css-view-transitions-1/
    // Real Chrome 111+ exposes this method on Document.prototype.
    if (globalThis.Document && typeof globalThis.Document.prototype.startViewTransition === "undefined") {
        class ViewTransition {
            constructor(updateCallback) {
                const _st = _idl.own(this);
                // The view-transition lifecycle: ready Promise resolves
                // when the snapshot is ready; finished resolves after
                // the transition completes. updateCallbackDone resolves
                // after the user's callback finishes.
                let cbResult = Promise.resolve();
                if (typeof updateCallback === "function") {
                    try { cbResult = Promise.resolve(updateCallback()); }
                    catch (e) { cbResult = Promise.reject(e); }
                }
                _st.updateCallbackDone = cbResult;
                // No real animation in headless — resolve immediately.
                _st.ready = cbResult.then(() => {});
                _st.finished = cbResult.then(() => {});
                _st.types = new Set();
            }
            skipTransition() {}
        }
    _idl.fields(ViewTransition.prototype, ["finished", "ready", "types", "updateCallbackDone"]);
        Object.defineProperty(ViewTransition.prototype, Symbol.toStringTag, {
            value: "ViewTransition", configurable: true,
        });
        globalThis.ViewTransition = ViewTransition;
        const _startViewTransition = function startViewTransition(updateCallback) {
            return new ViewTransition(updateCallback);
        };
        if (typeof _maskFunction === "function") {
            _maskFunction(_startViewTransition, "startViewTransition");
        }
        Object.defineProperty(globalThis.Document.prototype, "startViewTransition", {
            value: _startViewTransition, configurable: true, writable: true,
        });
    }

    // (11) Document.prototype.hasStorageAccess / requestStorageAccess (Storage Access API)
    // Chrome 130+. Cross-site trackers probe these heavily.
    if (globalThis.Document && typeof globalThis.Document.prototype.hasStorageAccess === "undefined") {
        const _hasStorageAccess = function hasStorageAccess() { return Promise.resolve(false); };
        const _requestStorageAccess = function requestStorageAccess() { 
            return Promise.reject(new DOMException("The request was denied.", "NotAllowedError")); 
        };
        if (typeof _maskFunction === "function") {
            _maskFunction(_hasStorageAccess, "hasStorageAccess");
            _maskFunction(_requestStorageAccess, "requestStorageAccess");
        }
        Object.defineProperty(globalThis.Document.prototype, "hasStorageAccess", {
            value: _hasStorageAccess, configurable: true, writable: true,
        });
        Object.defineProperty(globalThis.Document.prototype, "requestStorageAccess", {
            value: _requestStorageAccess, configurable: true, writable: true,
        });
    }

    // (12) Document.prototype.hasPrivateToken / hasRedemptionRecord (Trust Tokens API)
    // Chrome 130+ ad-fraud prevention APIs. Absence differs from real Chrome.
    if (globalThis.Document && typeof globalThis.Document.prototype.hasPrivateToken === "undefined") {
        // Both resolve `false` for an issuer with nothing stored — measured
        // against Chrome 151, which answers in under a millisecond. Rejecting
        // with NotSupportedError was wrong three ways at once: no real Chrome
        // reports the API as unsupported, callers chain `.then` without a
        // `.catch` (hCaptcha's does, and a rejection derails the request it
        // gates), and our rejection took ~290 ms where Chrome takes none.
        _defProtoMethod(globalThis.Document.prototype, "hasPrivateToken",
            function hasPrivateToken(issuer) { return Promise.resolve(false); });
        _defProtoMethod(globalThis.Document.prototype, "hasRedemptionRecord",
            function hasRedemptionRecord(issuer) { return Promise.resolve(false); });
    }
    // (13) PaymentRequest — Payment Request API (W3C Recommendation, Sept 2022).
    // Spec: https://www.w3.org/TR/payment-request/
    // [SecureContext] — undefined on insecure contexts. cleanup_bootstrap.js
    // already deletes "PaymentRequest" from globalThis on insecure pages.
    //
    // canMakePayment() resolves true for "https://google.com/pay" and
    // "basic-card" methods — matches real Chrome with no enrolled card
    // (handler is registered, instrument is not). hasEnrolledInstrument()
    // resolves false: Chrome/Edge-only method that mirrors a fresh profile.
    // PaymentRequest is rarely stubbed by competing engines; some scripts
    // feature-detect it as a real-browser
    // signal even when they don't drive the show() flow.
    //
    // interfaces_bootstrap.js installs an illegal-constructor stub first,
    // so we check for the .canMakePayment method (only present on a real
    // implementation) rather than typeof === undefined.
    const _PRStub = globalThis.PaymentRequest;
    if (_secure() && (typeof _PRStub !== "function"
        || typeof (_PRStub.prototype && _PRStub.prototype.canMakePayment) !== "function")) {
        class PaymentRequest extends EventTarget {
            #methods;
            constructor(methodData, details, options = {}) {
                super();
                if (!Array.isArray(methodData) || methodData.length === 0) {
                    throw new TypeError("Failed to construct 'PaymentRequest': At least one payment method is required");
                }
                if (!details || !details.total) {
                    throw new TypeError("Failed to construct 'PaymentRequest': required member total is undefined.");
                }
                this.#methods = methodData;
                const _id = (details && details.id)
                    || (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
                        ? globalThis.crypto.randomUUID()
                        : Date.now().toString(36) + Math.random().toString(36).slice(2));
                Object.defineProperty(this, "id", { value: _id, enumerable: true, configurable: true });
                Object.defineProperty(this, "shippingAddress", { value: null, enumerable: true, configurable: true });
                Object.defineProperty(this, "shippingOption", { value: null, enumerable: true, configurable: true });
                Object.defineProperty(this, "shippingType", { value: null, enumerable: true, configurable: true });
                this.onshippingaddresschange = null;
                this.onshippingoptionchange = null;
                this.onpaymentmethodchange = null;
            }
            show(_detailsPromise) {
                // Real Chrome requires a user gesture and a registered
                // merchant. Without them, show() rejects with AbortError.
                // DOMException is unreliable at snapshot time (snapshot
                // builds don't always have it available); use Error with
                // .name set, which detectors check via e.name === "AbortError".
                const err = new Error("User closed the Payment Request UI.");
                err.name = "AbortError";
                return Promise.reject(err);
            }
            abort() {
                return Promise.resolve(undefined);
            }
            canMakePayment() {
                const ok = this.#methods.some(m =>
                    m && (m.supportedMethods === "https://google.com/pay"
                        || m.supportedMethods === "basic-card")
                );
                return Promise.resolve(ok);
            }
            hasEnrolledInstrument() {
                return Promise.resolve(false);
            }
        }
        Object.defineProperty(PaymentRequest.prototype, Symbol.toStringTag, {
            value: "PaymentRequest", configurable: true,
        });
        PaymentRequest.securePaymentConfirmationAvailability = function securePaymentConfirmationAvailability() {
            return Promise.resolve("unavailable-no-user-verifying-platform-authenticator");
        };
        if (typeof _maskFunction === "function") {
            _maskFunction(PaymentRequest, "PaymentRequest");
            _maskFunction(PaymentRequest.prototype.show, "show");
            _maskFunction(PaymentRequest.prototype.abort, "abort");
            _maskFunction(PaymentRequest.prototype.canMakePayment, "canMakePayment");
            _maskFunction(PaymentRequest.prototype.hasEnrolledInstrument, "hasEnrolledInstrument");
            _maskFunction(PaymentRequest.securePaymentConfirmationAvailability, "securePaymentConfirmationAvailability");
        }
        globalThis.PaymentRequest = PaymentRequest;

        class PaymentResponse extends EventTarget {
            constructor() {
                super();
                throw new TypeError("Illegal constructor");
            }
        }
        Object.defineProperty(PaymentResponse.prototype, Symbol.toStringTag, {
            value: "PaymentResponse", configurable: true,
        });
        if (typeof _maskFunction === "function") {
            _maskFunction(PaymentResponse, "PaymentResponse");
        }
        globalThis.PaymentResponse = PaymentResponse;

        class PaymentMethodChangeEvent extends Event {
            constructor(type, init) {
                super(type, init || {});
                const _init = init || {};
                Object.defineProperty(this, "methodName", { value: _init.methodName || "", enumerable: true, configurable: true });
                Object.defineProperty(this, "methodDetails", { value: _init.methodDetails || null, enumerable: true, configurable: true });
            }
        }
        Object.defineProperty(PaymentMethodChangeEvent.prototype, Symbol.toStringTag, {
            value: "PaymentMethodChangeEvent", configurable: true,
        });
        if (typeof _maskFunction === "function") {
            _maskFunction(PaymentMethodChangeEvent, "PaymentMethodChangeEvent");
        }
        globalThis.PaymentMethodChangeEvent = PaymentMethodChangeEvent;

        class PaymentRequestUpdateEvent extends Event {
            constructor(type, init) {
                super(type, init || {});
            }
            updateWith(_detailsPromise) {
                // Outside an active show() flow this silently no-ops,
                // matching Chrome behavior on stale events.
            }
        }
        Object.defineProperty(PaymentRequestUpdateEvent.prototype, Symbol.toStringTag, {
            value: "PaymentRequestUpdateEvent", configurable: true,
        });
        if (typeof _maskFunction === "function") {
            _maskFunction(PaymentRequestUpdateEvent, "PaymentRequestUpdateEvent");
            _maskFunction(PaymentRequestUpdateEvent.prototype.updateWith, "updateWith");
        }
        globalThis.PaymentRequestUpdateEvent = PaymentRequestUpdateEvent;
    }

    // (14) navigator.getInstalledRelatedApps — Get Installed Related Apps API.
    // Spec: https://wicg.github.io/get-installed-related-apps/
    // Chrome/Edge-only. Returns Promise<[]> on a fresh profile (no PWAs
    // installed). Absence under a Chrome UA is itself a signal — some
    // scripts can probe `'getInstalledRelatedApps' in navigator` against
    // the UA family. Skip on iOS (Safari has no such method).
    if (!_isMobileIOS() && typeof navigator !== "undefined" && typeof navigator.getInstalledRelatedApps !== "function") {
        _defNavMethod("getInstalledRelatedApps", function getInstalledRelatedApps() {
            return Promise.resolve([]);
        });
    }

    // fetch(), Headers, Request, Response are now provided by fetch_bootstrap.js
    // (wired to real net::HttpClient via op_fetch)

    // NOTE: secure-context API gating is split:
    // - Navigator getters (mediaDevices, clipboard, ...) lazily check
    //   _secure() at access time — they work directly off the snapshot.
    // - Globals + getBattery are always registered into the snapshot
    //   (snapshot bootstraps with is_secure_context=true) and then
    //   stripped per-page in cleanup_bootstrap.js when the actual page
    //   URL is insecure.

    {
        class WindowControlsOverlay extends EventTarget {
            constructor() { super(); }
            get visible() { return false; }
            getTitlebarAreaRect() { return { x: 0, y: 0, width: 0, height: 0 }; } // Avoid DOMRect dependency
        }
        Object.defineProperty(WindowControlsOverlay.prototype, Symbol.toStringTag, {
            value: "WindowControlsOverlay", configurable: true,
        });
        globalThis.WindowControlsOverlay = WindowControlsOverlay;
        const _wco = new WindowControlsOverlay();
        _defNav('windowControlsOverlay', () => _wco);
    }

    Object.defineProperty(globalThis, 'external', {
        value: {
            AddSearchProvider() {},
            IsSearchProviderInstalled() {},
        },
        configurable: true, enumerable: true, writable: true,
    });
    // Window members Chrome has and this engine did not. Not interfaces — the
    // interface table cannot create them — so they are declared here. A missing
    // name is the same kind of namespace difference as an extra one: both show up
    // when a detector diffs `Object.getOwnPropertyNames(window)` against a real
    // browser's, which is precisely what the "unusual window properties" check is.
    (() => {
        const nativeFn = (name, impl) => {
            const fn = ({ [name](...args) { return impl.apply(this, args); } })[name];
            if (typeof globalThis._maskFunction === 'function') globalThis._maskFunction(fn, name);
            return fn;
        };
        const define = (name, value) => {
            if (name in globalThis) return;
            Object.defineProperty(globalThis, name, {
                value, writable: true, enumerable: true, configurable: true,
            });
        };
        // Window geometry and focus verbs. A headless window cannot honour them,
        // and Chrome ignores most of them for a non-script-opened window too, so
        // no-ops match the observable behaviour.
        for (const name of ['blur', 'focus', 'moveBy', 'moveTo', 'resizeBy', 'resizeTo',
                            'captureEvents', 'releaseEvents']) {
            define(name, nativeFn(name, () => undefined));
        }
        define('find', nativeFn('find', () => false));
        // Legacy `window.event`: the event currently being dispatched, undefined
        // outside a dispatch.
        if (!('event' in globalThis)) {
            Object.defineProperty(globalThis, 'event', {
                get() { return _currentDispatchedEvent; },
                set(v) { _currentDispatchedEvent = v; },
                enumerable: true, configurable: true,
            });
        }
        // Handler attributes default to null, like every other `on…` on Window.
        for (const name of ['onerror', 'ondevicemotion', 'ondeviceorientation',
                            'ondeviceorientationabsolute']) {
            define(name, null);
        }
        // Async entry points that need a permission or a user gesture this engine
        // never has: they exist and reject, which is what Chrome does when the
        // request is denied.
        const denied = (name) => nativeFn(name, () =>
            Promise.reject(new DOMException('Permission denied', 'NotAllowedError')));
        for (const name of ['getScreenDetails', 'queryLocalFonts', 'showDirectoryPicker',
                            'showOpenFilePicker', 'showSaveFilePicker']) {
            define(name, denied(name));
        }
        define('fetchLater', nativeFn('fetchLater', () => ({ activated: false })));
        define('webkitRequestFileSystem', nativeFn('webkitRequestFileSystem',
            (_type, _size, _ok, err) => { if (typeof err === 'function') err(new DOMException('', 'SecurityError')); }));
        define('webkitResolveLocalFileSystemURL', nativeFn('webkitResolveLocalFileSystemURL',
            (_url, _ok, err) => { if (typeof err === 'function') err(new DOMException('', 'SecurityError')); }));
        // Objects, shaped enough to be inspected without throwing.
        define('navigation', globalThis.Navigation ? Object.create(globalThis.Navigation.prototype) : {});
        define('documentPictureInPicture', globalThis.DocumentPictureInPicture
            ? Object.create(globalThis.DocumentPictureInPicture.prototype) : {});
    })();

    globalThis.clientInformation = globalThis.navigator;
    // No `offscreenBuffering` and no `defaultStatus`: Chrome removed both, and a
    // global we have that the browser we claim to be does not is the worse
    // direction to differ in. Measured against a real-browser capture, this was
    // the last own window property we had and it did not.
    globalThis.name = "";
    globalThis.status = "";
    
    // (Phase J) Iframe indexing parity: define window[0], window[1] etc.
    // Real Chrome has numeric own-properties for each child frame.
    const _defineIframeGetter = (index) => {
        Object.defineProperty(globalThis, index, {
            get: () => {
                // If we have iframes, return the contentWindow of the i-th one.
                // Our Page layer manages the children.
                const iframes = document.querySelectorAll('iframe');
                return iframes[index] ? iframes[index].contentWindow : undefined;
            },
            configurable: true, enumerable: true
        });
    };
    // Exactly as many as there are frames, and no more. Five were defined
    // unconditionally, so `Object.getOwnPropertyNames(window)` on a page with no
    // frames at all listed "0".."4" — five names a real browser does not have,
    // and comparing that list against Chrome's is a standard check.
    const _syncFrameIndices = () => {
        let count = 0;
        try { count = document.querySelectorAll('iframe').length; } catch (_) {}
        for (let i = 0; i < count; i++) {
            if (!Object.getOwnPropertyDescriptor(globalThis, String(i))) _defineIframeGetter(i);
        }
        for (let i = count; i < 32; i++) {
            const d = Object.getOwnPropertyDescriptor(globalThis, String(i));
            if (!d) break;
            if (d.configurable) { try { delete globalThis[String(i)]; } catch (_) {} }
        }
    };
    _syncFrameIndicesRef = _syncFrameIndices;

    // On the prototype, where Chrome keeps it: `Object.getOwnPropertySymbols(window)`
    // is empty there, and every symbol we leave on the global is one more entry a
    // namespace comparison can see.
    try {
        Object.defineProperty(Object.getPrototypeOf(globalThis), Symbol.toStringTag, {
            value: "Window", configurable: true,
        });
    } catch (_) {
    

    Object.defineProperty(globalThis, Symbol.toStringTag, { value: "Window", configurable: true });
    }

    // Warm-reuse custom-element reaper. Both registries hold page-supplied
    // constructors (and, for `whenDefined`, unresolved promise resolvers)
    // for the life of the `JsRuntime`, so on a pooled `Page` they retain
    // every class every previously-loaded document ever defined. Clearing
    // also fixes a correctness bug: re-`define()`ing a name the *previous*
    // page had already registered is a no-op today, so the new page's
    // element class never upgrades. Called by `Page::reset_for_reuse`.
    Object.defineProperty(globalThis, '__resetCustomElements', {
        value: function __resetCustomElements() {
            _customElementsRegistry.clear();
            _whenDefinedPromises.clear();
        },
        writable: true,
        configurable: true,
        enumerable: false,
    });

    // -- Window attributes are accessors, not data properties --------
    //
    // In Chrome every `on…` handler and the window's own attributes (`screen`,
    // `history`, `navigator`, `innerWidth`, …) are getter/setter pairs on the
    // instance: 184 accessors against 49 plain values. This engine had it the
    // other way round — 20 accessors and 258 values — so a descriptor sweep of
    // `window`, which is one loop for a detector, disagreed on two hundred
    // properties at once.
    //
    // Converted in place at the end of setup, keeping whatever value each one
    // already holds, so behaviour is untouched: reading returns the same thing
    // and assignment still lands in the same slot.
    (() => {
        const INSTANCE_ATTRS = [
            'document', 'location',
            'self', 'name', 'customElements', 'history', 'navigation', 'locationbar',
            'menubar', 'personalbar', 'scrollbars', 'statusbar', 'toolbar', 'status',
            'closed', 'frames', 'length', 'opener', 'frameElement', 'navigator',
            'origin', 'external', 'screen', 'innerWidth', 'innerHeight', 'scrollX',
            'pageXOffset', 'scrollY', 'pageYOffset', 'visualViewport', 'screenX',
            'screenY', 'outerWidth', 'outerHeight', 'devicePixelRatio', 'event',
            'clientInformation', 'screenLeft', 'screenTop', 'styleMedia',
            'isSecureContext', 'crossOriginIsolated', 'scheduler', 'performance',
            'trustedTypes', 'crypto', 'indexedDB', 'localStorage', 'sessionStorage',
            'caches', 'cookieStore', 'documentPictureInPicture',
            'originAgentCluster', 'viewport', 'credentialless', 'fence', 'launchQueue',
            'speechSynthesis', 'crashReport',
        ];
        // Readonly-without-[Replaceable] attributes have no setter at all in
        // Chrome; giving every one a setter was its own descriptor mismatch.
        const GETTER_ONLY = new Set([
            'window', 'document', 'top', 'customElements', 'history', 'closed',
            'frameElement', 'navigator', 'styleMedia', 'isSecureContext',
            'crossOriginIsolated', 'trustedTypes', 'crypto', 'indexedDB',
            'localStorage', 'sessionStorage', 'caches', 'cookieStore',
            'documentPictureInPicture', 'originAgentCluster',
            'credentialless', 'fence', 'launchQueue', 'speechSynthesis',
            'crashReport',
        ]);
        const slots = Object.create(null);
        const convert = (name) => {
            let d;
            try { d = Object.getOwnPropertyDescriptor(globalThis, name); } catch (_) { return; }
            if (!d || d.get || d.set || !d.configurable) return;
            slots[name] = d.value;
            const get = ({ [name]() { return slots[name]; } })[name];
            const set = GETTER_ONLY.has(name)
                ? undefined
                : ({ [name](v) { slots[name] = v; } })[name];
            if (typeof globalThis._maskFunction === 'function') {
                globalThis._maskFunction(get, 'get ' + name);
                if (set) globalThis._maskFunction(set, 'set ' + name);
            }
            try {
                Object.defineProperty(globalThis, name, {
                    get, set, enumerable: true, configurable: true,
                });
            } catch (_) { /* ignore */ }
        };
        for (const name of Object.getOwnPropertyNames(globalThis)) {
            if (/^on[a-z]/.test(name)) convert(name);
        }
        for (const name of INSTANCE_ATTRS) convert(name);
    })();

})(globalThis);
