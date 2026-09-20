((globalThis) => {
    const ops = Deno && Deno.core && Deno.core.ops;
    // Captured before the internals purge below removes the global.
    const _maskRef = globalThis._maskFunction;
    const _isWorkerScope = Object.prototype.toString.call(globalThis) === '[object DedicatedWorkerGlobalScope]';
    // -- Per-page secure-context gating (Phase 7) --------------------
    // The V8 snapshot bootstraps with is_secure_context=true so all
    // [SecureContext]-only Web Platform APIs are baked in. On insecure
    // pages (data:/http:/about:blank) we strip them here to match real
    // Chrome.
    try {
        const _ops = Deno && Deno.core && Deno.core.ops;
        // Live, not a snapshot: a pooled page is built blank and navigated
        // afterwards, so anything that must track the document has to ask each
        // time. (The deletions below are one-shot by nature — a stripped global
        // cannot be un-stripped — but the crypto mask is re-evaluated per access.)
        const _isSecure = () => {
            try {
                return !!(_ops && _ops.op_is_secure_context && _ops.op_is_secure_context());
            } catch (_e) {
                return false;
            }
        };
        if (!_isSecure()) {
            // Methods + globals registered as values in the snapshot.
            // Navigator getters (mediaDevices, clipboard, ...) gate
            // themselves lazily so they don't need stripping.
            try { delete globalThis.Navigator.prototype.getBattery; } catch (_e) {}
            for (const k of ['caches', 'cookieStore', 'IdleDetector', 'EyeDropper', 'WebTransport']) {
                try { delete globalThis[k]; } catch (_e) {}
            }
            // Phase 7 — also strip the constructor *interfaces* for the
            // [SecureContext] APIs. Real Chrome 147 hides these from
            // `Object.getOwnPropertyNames(window)` on insecure pages.
            // Some scripts hash the global namespace.
            // Also: ApplePaySession, SharedArrayBuffer, webkitAudioContext,
            // DedicatedWorkerGlobalScope, WorkerGlobalScope, CSSPseudoElement
            // are absent from Chrome 147's globalThis on insecure pages —
            // verified against a real browser.
            // …but not inside a worker, where `WorkerGlobalScope` and
            // `DedicatedWorkerGlobalScope` are the realm's own interfaces and
            // must be present: `!self.document && self.WorkerGlobalScope` is how
            // a script decides it is in a worker at all, and stripping them made
            // libraries run their window path there and produce nothing. The
            // rule above is about a *window* on an insecure page, which is where
            // Chrome really does hide them.
            //
            // Read off the prototype rather than the global, because that is
            // what this loop is in the middle of deleting.
            const _inWorkerRealm =
                Object.prototype.toString.call(globalThis) === "[object DedicatedWorkerGlobalScope]";
            for (const k of [
                "SharedArrayBuffer", "webkitAudioContext",
                ...(_inWorkerRealm ? [] : ["DedicatedWorkerGlobalScope", "WorkerGlobalScope"]),
                "CSSPseudoElement",
                "ApplePaySession", "AuthenticatorAssertionResponse",
                "AuthenticatorAttestationResponse", "AuthenticatorResponse",
                "BatteryManager", "Bluetooth", "CacheStorage", "CookieStore",
                "Credential", "CredentialsContainer", "DevicePosture",
                "FederatedCredential", "FileSystemDirectoryHandle",
                "FileSystemFileHandle", "FileSystemHandle",
                "FileSystemWritableFileStream", "IdentityCredential",
                "IdentityProvider", "Keyboard", "KeyboardLayoutMap",
                "MediaDevices", "PasswordCredential", "PaymentRequest",
                "Presentation", "PresentationConnection",
                "PublicKeyCredential", "ServiceWorker",
                "ServiceWorkerContainer", "StorageManager", "SubtleCrypto",
                "VirtualKeyboard", "XRSession", "XRSystem",
                // Generic Sensor API — also [SecureContext]
                "Sensor", "Accelerometer", "AbsoluteOrientationSensor",
                "GravitySensor", "Gyroscope", "LinearAccelerationSensor",
                "Magnetometer", "OrientationSensor",
                "RelativeOrientationSensor",
            ]) {
                try { delete globalThis[k]; } catch (_e) {}
            }
        }

        // crypto.subtle + crypto.randomUUID are [SecureContext]. They
        // come from deno_core's crypto extension and are non-configurable
        // own properties. `delete` fails — replace `globalThis.crypto`
        // with a Proxy that hides those two keys.
        if (globalThis.crypto) {
            const _origCrypto = globalThis.crypto;
            // The mask has to track the *document*, not the moment this
            // bootstrap ran. A pooled page is built on a blank document and
            // then navigated, so a decision frozen here outlives the context
            // it was made for: the page ends up on https reporting
            // `isSecureContext === true` while these two stay hidden. No real
            // browser shows that combination, and code that branches on
            // secure context then takes the branch and finds nothing.
            const _hidden = (prop) =>
                (prop === 'subtle' || prop === 'randomUUID') && !_isSecure();
            const _maskedCrypto = new Proxy(_origCrypto, {
                get(target, prop, receiver) {
                    if (_hidden(prop)) return undefined;
                    const v = Reflect.get(target, prop, receiver);
                    return typeof v === 'function' ? v.bind(target) : v;
                },
                has(target, prop) {
                    if (_hidden(prop)) return false;
                    return Reflect.has(target, prop);
                },
                ownKeys(target) {
                    const keys = Reflect.ownKeys(target);
                    return _isSecure()
                        ? keys
                        : keys.filter((k) => k !== 'subtle' && k !== 'randomUUID');
                },
                getOwnPropertyDescriptor(target, prop) {
                    if (_hidden(prop)) return undefined;
                    return Reflect.getOwnPropertyDescriptor(target, prop);
                },
            });
            try {
                Object.defineProperty(globalThis, 'crypto', {
                    value: _maskedCrypto, configurable: true, enumerable: true, writable: true,
                });
            } catch (_e) {}
        }
    } catch (_e) { /* secure-context cleanup is best-effort */ }

    // -- Profile-conditional installs --------------------------------
    // These run AFTER the V8 startup snapshot is restored, so the
    // stealth profile is loaded and op-based reads return real values.
    // (Snapshot-time bootstraps see profile=None and would mis-gate.)
    try {
        const _hasProfile = ops && ops.op_has_stealth_profile && ops.op_has_stealth_profile();
        const _osName = (_hasProfile && ops.op_get_profile_value)
            ? (ops.op_get_profile_value("os_name") || "Linux")
            : "Linux";

        // ApplePaySession — present only on macOS Chrome AND only on
        // secure contexts (Apple Pay requires https). A missing constructor
        // on a macOS UA is a strong inconsistency versus a real browser.
        // Constructor + statics shaped to match
        // Chrome 147's ApplePaySession surface.
        const _ops2 = Deno && Deno.core && Deno.core.ops;
        const _isSecureForAP = _ops2 && _ops2.op_is_secure_context && _ops2.op_is_secure_context();
        if (_osName === "macOS" && _isSecureForAP && typeof globalThis.ApplePaySession === "undefined") {
            const _APP = function ApplePaySession(_version, _paymentRequest) {
                this.onvalidatemerchant = null;
                this.onpaymentauthorized = null;
                this.onpaymentmethodselected = null;
                this.onshippingcontactselected = null;
                this.onshippingmethodselected = null;
                this.oncouponcodechanged = null;
                this.oncancel = null;
            };
            _APP.prototype = {
                begin() {},
                abort() {},
                completeMerchantValidation() {},
                completePayment() {},
                completePaymentMethodSelection() {},
                completeShippingContactSelection() {},
                completeShippingMethodSelection() {},
                completeCouponCodeChange() {},
                addEventListener() {},
                removeEventListener() {},
            };
            _APP.STATUS_SUCCESS = 0;
            _APP.STATUS_FAILURE = 1;
            _APP.STATUS_INVALID_BILLING_POSTAL_ADDRESS = 2;
            _APP.STATUS_INVALID_SHIPPING_POSTAL_ADDRESS = 3;
            _APP.STATUS_INVALID_SHIPPING_CONTACT = 4;
            _APP.STATUS_PIN_REQUIRED = 5;
            _APP.STATUS_PIN_INCORRECT = 6;
            _APP.STATUS_PIN_LOCKOUT = 7;
            _APP.canMakePayments = function canMakePayments() { return true; };
            _APP.canMakePaymentsWithActiveCard = function canMakePaymentsWithActiveCard(_id) { return Promise.resolve(false); };
            _APP.openPaymentSetup = function openPaymentSetup(_id) { return Promise.resolve(false); };
            _APP.supportsVersion = function supportsVersion(version) { return version >= 1 && version <= 14; };
            Object.defineProperty(globalThis, 'ApplePaySession', {
                value: _APP,
                configurable: true,
                writable: true,
            });
        }

        // -- iOS Safari profile: strip 16 declined APIs + add iOS globals --
        // Per Apple's "16 web APIs declined for privacy" policy. The
        // single highest-ROI mobile patch — many leaks vanish at once.
        const _deviceClass = (_hasProfile && ops.op_get_profile_value)
            ? ops.op_get_profile_value("device_class")
            : "Desktop";
        if (_deviceClass !== "MobileAndroid") {
            for (const name of ["ContactsManager", "ContentIndex"]) {
                try { delete globalThis[name]; } catch (_) {}
            }
        }
        if (_deviceClass === "MobileIOS") {
            // 1. Delete 16 declined APIs from globalThis
            const _iosDeleted = [
                "Bluetooth", "USB", "USBAlternateInterface", "USBConfiguration",
                "USBConnectionEvent", "USBDevice", "USBEndpoint",
                "USBInTransferResult", "USBInterface",
                "USBIsochronousInTransferPacket", "USBIsochronousInTransferResult",
                "USBIsochronousOutPacket", "USBIsochronousOutTransferResult",
                "USBOutTransferResult",
                "HID", "HIDConnectionEvent", "HIDDevice", "HIDInputReportEvent",
                "Serial", "SerialPort",
                "NetworkInformation", "BatteryManager",
                "IdleDetector", "EyeDropper",
                // Chrome-only interfaces real Safari does NOT expose.
                // A `'X' in window` check against an iOS UA would flag these.
                "UserActivation", "Scheduling",
                "Sensor", "Accelerometer", "AbsoluteOrientationSensor",
                "GravitySensor", "Gyroscope", "LinearAccelerationSensor",
                "Magnetometer", "OrientationSensor", "RelativeOrientationSensor",
                // WebGPU is feature-flagged on iOS 18+ but defaults off
                "GPU", "GPUAdapter", "GPUDevice", "GPUQueue", "GPUBuffer",
                "GPUTexture", "GPUSampler", "GPUBindGroup", "GPUBindGroupLayout",
                "GPUPipelineLayout", "GPUShaderModule", "GPURenderPipeline",
                "GPUComputePipeline", "GPUCommandEncoder", "GPUCommandBuffer",
                "GPURenderPassEncoder", "GPUComputePassEncoder",
                "GPURenderBundleEncoder", "GPURenderBundle", "GPUCanvasContext",
                "GPUColorWrite", "GPUMapMode", "GPUTextureUsage",
                "GPUBufferUsage", "GPUShaderStage",
                // Speech recognition has limited iOS support, but webkit-prefixed
                // is the only form Safari ships
                "SpeechRecognition", "SpeechRecognitionEvent",
                "SpeechRecognitionErrorEvent",
            ];
            for (const k of _iosDeleted) {
                try { delete globalThis[k]; } catch (_e) {}
            }

            // 2. Strip Navigator.prototype methods/getters that iOS doesn't have.
            // Defense in depth: window_bootstrap.js W1.5 gate avoids
            // installing these on iOS profiles, but we also delete here in
            // case any prior pass re-installed them. Use `delete` (not
            // redefine-with-undefined-getter) so `'X' in navigator` returns
            // false — the descriptor must not be present.
            const _NavProto = globalThis.Navigator && globalThis.Navigator.prototype;
            if (_NavProto) {
                for (const k of [
                    "bluetooth", "usb", "serial", "hid", "requestMIDIAccess",
                    "getBattery", "connection", "getInstalledRelatedApps",
                    "scheduling", "userActivation",
                    // userAgentData absent on Safari (no UA-CH at all)
                    "userAgentData",
                    // deviceMemory absent on Safari
                    "deviceMemory",
                ]) {
                    try { delete _NavProto[k]; } catch (_e) {}
                }
            }

            // 3. PaymentRequest.prototype.hasEnrolledInstrument is Chrome/Edge-only
            //    Safari MUST NOT have it.
            if (globalThis.PaymentRequest && globalThis.PaymentRequest.prototype) {
                try { delete globalThis.PaymentRequest.prototype.hasEnrolledInstrument; } catch (_e) {}
            }

            // 4. window.orientation — legacy iOS-only property. Desktop browsers
            //    do NOT have this. Setting to 0 = portrait.
            try {
                Object.defineProperty(globalThis, "orientation", {
                    get: function() { return 0; },
                    configurable: true, enumerable: true,
                });
            } catch (_e) {}

            // 5. ontouchstart on window — every detection script's cheapest
            //    mobile-vs-desktop check
            try {
                Object.defineProperty(globalThis, "ontouchstart", {
                    value: null, configurable: true, writable: true, enumerable: true,
                });
            } catch (_e) {}

            // 6. DeviceMotionEvent.requestPermission + DeviceOrientationEvent.requestPermission
            //    iOS 13+ requires user-gesture-gated permission for these. The presence
            //    of these static methods is itself a strong iOS signal — Android does NOT
            //    expose these statics.
            if (globalThis.DeviceMotionEvent
                && typeof globalThis.DeviceMotionEvent.requestPermission !== "function") {
                try {
                    globalThis.DeviceMotionEvent.requestPermission =
                        function requestPermission() { return Promise.resolve("denied"); };
                } catch (_e) {}
            }
            if (globalThis.DeviceOrientationEvent
                && typeof globalThis.DeviceOrientationEvent.requestPermission !== "function") {
                try {
                    globalThis.DeviceOrientationEvent.requestPermission =
                        function requestPermission() { return Promise.resolve("denied"); };
                } catch (_e) {}
            }

            // 7. Sec-CH-UA-* JS surface absent on Safari — already handled
            //    above via userAgentData getter returning undefined.

            // 8. window.chrome must be absent on iOS Safari. Some scripts
            //    explicitly probe `typeof window.chrome` — Chrome
            //    returns "object", Safari "undefined". A positive hit under
            //    an iOS UA is a strong inconsistency.
            try { delete globalThis.chrome; } catch (_e) {}

            // 8b. navigator.permissions.query() — Safari 18 supports a much
            //     narrower permission name set than Chrome. Per WebKit:
            //     allowed = notifications, push, camera, microphone,
            //               geolocation, persistent-storage.
            //     Chrome-only names (midi, accelerometer, gyroscope,
            //     magnetometer, ambient-light-sensor, background-fetch,
            //     background-sync, clipboard-read, clipboard-write,
            //     display-capture, screen-wake-lock, system-wake-lock,
            //     window-management) must reject with TypeError on Safari
            //     to match real WebKit behavior. PLAN W1.5 (Plan §0 #6).
            try {
                if (globalThis.navigator && globalThis.navigator.permissions) {
                    const _safariAllowed = new Set([
                        'notifications', 'push', 'camera', 'microphone',
                        'geolocation', 'persistent-storage',
                    ]);
                    const _PProto = globalThis.navigator.permissions
                        && Object.getPrototypeOf(globalThis.navigator.permissions);
                    if (_PProto && typeof _PProto.query === 'function') {
                        const _origQuery = _PProto.query;
                        const safariQuery = function query(desc) {
                            const name = desc && typeof desc === 'object' ? desc.name : undefined;
                            if (typeof name !== 'string' || !_safariAllowed.has(name)) {
                                return Promise.reject(new TypeError(
                                    "Failed to execute 'query' on 'Permissions': "
                                    + (typeof name === 'string'
                                        ? "The provided value '" + name + "' is not a valid enum value of type PermissionName."
                                        : "parameter 1 is not of type 'PermissionDescriptor'.")
                                ));
                            }
                            return _origQuery.call(this, desc);
                        };
                        Object.defineProperty(_PProto, 'query', {
                            value: safariQuery, writable: true, enumerable: false, configurable: true,
                        });
                        // Preserve native-shape Function.prototype.toString output
                        // via the _nativeTag symbol installed by stealth_bootstrap.js.
                        const _tag = globalThis._nativeTag;
                        if (_tag) {
                            try { Object.defineProperty(safariQuery, _tag, { value: 'query', configurable: true }); } catch (_e) {}
                            try { Object.defineProperty(safariQuery, 'name', { value: 'query', configurable: true }); } catch (_e) {}
                        }
                    }
                }
            } catch (_e) {}

            // 9. navigator.plugins / navigator.mimeTypes empty on iOS
            //    (PluginArray length 0 is the canonical mobile-Safari shape).
            try {
                if (globalThis.navigator) {
                    const _emptyPlugins = Object.create(globalThis.PluginArray ? globalThis.PluginArray.prototype : null);
                    Object.defineProperty(_emptyPlugins, 'length', { get: () => 0, enumerable: true });
                    Object.defineProperty(_emptyPlugins, 'item', {
                        value: function item() { return null; },
                        writable: true, enumerable: false, configurable: true,
                    });
                    Object.defineProperty(_emptyPlugins, 'namedItem', {
                        value: function namedItem() { return null; },
                        writable: true, enumerable: false, configurable: true,
                    });
                    Object.defineProperty(_emptyPlugins, 'refresh', {
                        value: function refresh() {},
                        writable: true, enumerable: false, configurable: true,
                    });
                    Object.defineProperty(_emptyPlugins, Symbol.iterator, {
                        value: function* () {},
                        writable: true, enumerable: false, configurable: true,
                    });
                    Object.defineProperty(_NavProto, 'plugins', {
                        get: function() { return _emptyPlugins; },
                        configurable: true, enumerable: false,
                    });
                    const _emptyMimeTypes = Object.create(globalThis.MimeTypeArray ? globalThis.MimeTypeArray.prototype : null);
                    Object.defineProperty(_emptyMimeTypes, 'length', { get: () => 0, enumerable: true });
                    Object.defineProperty(_emptyMimeTypes, 'item', {
                        value: function item() { return null; },
                        writable: true, enumerable: false, configurable: true,
                    });
                    Object.defineProperty(_emptyMimeTypes, 'namedItem', {
                        value: function namedItem() { return null; },
                        writable: true, enumerable: false, configurable: true,
                    });
                    Object.defineProperty(_NavProto, 'mimeTypes', {
                        get: function() { return _emptyMimeTypes; },
                        configurable: true, enumerable: false,
                    });
                    // pdfViewerEnabled is false on mobile (no integrated PDF viewer)
                    Object.defineProperty(_NavProto, 'pdfViewerEnabled', {
                        get: function() { return false; },
                        configurable: true, enumerable: false,
                    });
                }
            } catch (_e) {}
        }
    } catch (_e) { /* profile-conditional installs are best-effort */ }

    // -- native-source masking of Web Platform constructors --------
    // Some scripts dump `String(globalThis.<ctor>)` for a
    // rotating list of Web Platform constructors/functions and feed
    // the result into a browser-fingerprint score. Without masking,
    // many probed names leak our polyfill source —
    // raw `class Worker {…}` / `function(input, init){…}` bodies, or
    // the wrong native name (constructors that extend our internal
    // EventTarget reported `function EventTarget() { [native code] }`,
    // `clearTimeout` reported `clearInterval`). Real Chrome returns
    // `function <Name>() { [native code] }` for every one of these.
    //
    // This MUST run here, not in stealth_bootstrap.js: the constructors
    // are defined by interfaces/shared_apis/streams/window/worker
    // bootstraps that are concatenated AFTER stealth_bootstrap.js (and
    // shared_apis/worker run at runtime, after the snapshot). This is
    // the universal last pass — it runs always for the page (even from
    // snapshot) and last for workers — and `_maskFunction` is still on
    // globalThis here (the `internals` purge below removes it after).
    try {
        const _mask = globalThis._maskFunction;
        if (typeof _mask === 'function') {
            // De-alias Chrome-distinct pairs our impl points at one
            // object. The fresh /tl `sfc` probe caught these: real
            // Chrome has clearTimeout!==clearInterval,
            // scroll!==scrollTo, DOMMatrix!==DOMMatrixReadOnly — each
            // is its own named native, so a single shared object can't
            // satisfy `String(globalThis[name])` for both names. We
            // split the secondary into a distinct delegator/subclass
            // (more Chrome-faithful; zero behavior change).
            try {
                if (typeof globalThis.clearTimeout === 'function'
                    && globalThis.clearInterval === globalThis.clearTimeout) {
                    const _ct = globalThis.clearTimeout;
                    globalThis.clearInterval = { clearInterval(id) { return _ct(id); } }.clearInterval;
                }
                if (typeof globalThis.scrollTo === 'function'
                    && globalThis.scroll === globalThis.scrollTo) {
                    const _st = globalThis.scrollTo;
                    globalThis.scroll = { scroll() { return _st.apply(this, arguments); } }.scroll;
                }
            } catch (_e) {}

            // Native NON-constructor functions must have NO own
            // `prototype` and must be non-constructable (`new fetch()`
            // throws in Chrome). A CLEAN production probe
            // (the challenge-vendor native-fn-shape clean probe — no capture shim)
            // confirmed setTimeout/setInterval/clearTimeout/
            // clearInterval/queueMicrotask/structuredClone are plain
            // `function` decls → carry `.prototype` + are
            // constructable (a real-browser inconsistency).
            // `function f(){}`'s `.prototype` is non-configurable so
            // `delete` fails — the only fix is to REPLACE with a
            // method-shorthand (`{[k](){}}[k]`): no `.prototype`,
            // non-constructable, name===k. Forwarding wrapper
            // preserves behavior (none use `this`/`new`). Only the
            // probe-confirmed-broken set is touched; already-correct
            // async/shorthand natives (fetch/atob/btoa/scrollTo/
            // reportError/console.*) are left alone.
            const _natMethod = (holder, key, nm) => {
                try {
                    const o = holder && holder[key];
                    if (typeof o !== 'function') return;
                    if (!Object.prototype.hasOwnProperty.call(o, 'prototype')) {
                        _mask(o, nm || key);
                        return;
                    }
                    const w = { [key]() { return o.apply(this, arguments); } }[key];
                    _mask(w, nm || key);
                    try { holder[key] = w; } catch (_e2) {}
                } catch (_e2) {}
            };
            for (const _k of ['setTimeout', 'setInterval', 'clearTimeout',
                'clearInterval', 'queueMicrotask', 'structuredClone']) {
                _natMethod(globalThis, _k);
            }
            try {
                const _ca = globalThis.chrome && globalThis.chrome.app;
                if (_ca) {
                    for (const _m of ['getDetails', 'getIsInstalled',
                        'installState', 'runningState']) {
                        _natMethod(_ca, _m);
                    }
                }
            } catch (_e) {}

            // (chrome.app.* are handled by _natMethod above — it both
            // native-masks toString [otherwise a probe would leak
            // "function getDetails() { return null; }"] and removes the
            // illegal `.prototype`/constructability.)
            // The commonly probed names, plus adjacent
            // standard constructors — all are
            // genuinely `[native code]` in real Chrome, so masking any
            // that exist on this profile is correct (missing ones are a
            // safe no-op via `_maskFunction`'s `if (!fn) return`).
            // [globalKey, maskName]. maskName differs from globalKey
            // only for the legacy webkit-prefixed aliases: in real
            // Chrome `webkitAudioContext === AudioContext` (same object),
            // so `String(webkitAudioContext)` is
            // `function AudioContext() { [native code] }`. Masking them
            // to their prefixed key would itself be a divergence.
            // Chrome's legacy webkit-prefixed globals. Their absence is not a
            // subtle statistical signal: a public detector rejected this engine
            // outright with "Chrome UA but webkitRequestAnimationFrame absent"
            // and marked the browser tampered on that single line.
            //
            // Shapes verified against Chrome: the constructors are the *same
            // object* as their unprefixed form, while the two animation-frame
            // functions are separate wrappers carrying their own prefixed names.
            // `webkitAudioContext` is deliberately not here — Chrome removed it.
            for (const [alias, base] of [
                ['webkitURL', 'URL'],
                ['webkitMediaStream', 'MediaStream'],
                ['webkitURL', 'URL'],
                ['WebKitMutationObserver', 'MutationObserver'],
                ['webkitSpeechRecognition', 'SpeechRecognition'],
                ['webkitRTCPeerConnection', 'RTCPeerConnection'],
                ['WebKitMutationObserver', 'MutationObserver'],
                ['webkitSpeechRecognition', 'SpeechRecognition'],
                ['webkitSpeechGrammar', 'SpeechGrammar'],
                ['webkitSpeechGrammarList', 'SpeechGrammarList'],
                ['webkitSpeechRecognitionError', 'SpeechRecognitionErrorEvent'],
                ['webkitSpeechRecognitionEvent', 'SpeechRecognitionEvent'],
            ]) {
                try {
                    // Overwrites an existing stub on purpose: the interface table
                    // creates these names as separate constructors, and in Chrome
                    // the prefixed name IS the unprefixed object. Two distinct
                    // constructors where a browser has one is the tell.
                    if (globalThis[base] !== undefined) {
                        Object.defineProperty(globalThis, alias, {
                            value: globalThis[base],
                            writable: true, enumerable: false, configurable: true,
                        });
                    }
                } catch (_e) {}
            }
            for (const [alias, base] of [
                ['webkitRequestAnimationFrame', 'requestAnimationFrame'],
                ['webkitCancelAnimationFrame', 'cancelAnimationFrame'],
            ]) {
                try {
                    if (globalThis[alias] !== undefined) continue;
                    const target = globalThis[base];
                    if (typeof target !== 'function') continue;
                    // Method shorthand: no `prototype`, not constructible — the
                    // shape of a native function.
                    const wrapper = ({ [alias](...args) { return target.apply(this, args); } })[alias];
                    // Enumerable, like every other window *method* in Chrome —
                    // its prefixed constructors are hidden but these two are not,
                    // and a detector that reads their descriptors compares the
                    // flags, not just the presence.
                    // Arity mirrors the function it forwards to; Chrome reports 1
                    // for both prefixed animation-frame aliases.
                    try {
                        Object.defineProperty(wrapper, 'length', {
                            value: target.length || 1, configurable: true,
                        });
                    } catch (_e) {}
                    Object.defineProperty(globalThis, alias, {
                        value: wrapper, writable: true, enumerable: true, configurable: true,
                    });
                    if (typeof globalThis._maskFunction === 'function') {
                        globalThis._maskFunction(wrapper, alias);
                    }
                } catch (_e) {}
            }

            const _sfcNames = [
                ['webkitMediaStream', 'MediaStream'],
                ['webkitRTCPeerConnection', 'RTCPeerConnection'],
                'fetch', 'clearTimeout', 'clearInterval', 'setTimeout',
                'setInterval', 'TouchEvent', 'AudioContext', 'OffscreenCanvas',
                'Bluetooth', 'StorageManager', 'scrollTo', 'scroll', 'scrollBy',
                'Worker', 'SharedWorker', 'ServiceWorker', 'WorkerGlobalScope',
                'DedicatedWorkerGlobalScope', 'FileReader', 'ImageBitmap',
                'DOMMatrix', 'DOMMatrixReadOnly', 'PerformanceObserver',
                'PerformanceEntry', 'ReportingObserver', 'ReadableStream',
                'WritableStream', 'TransformStream', 'ReadableStreamDefaultReader',
                'WritableStreamDefaultWriter', 'ReadableStreamDefaultController',
                'BroadcastChannel', 'MessagePort', 'MessageChannel',
                'EventSource', 'CompressionStream', 'DecompressionStream',
                'Crypto', 'SubtleCrypto', 'CloseEvent', 'AbortController',
                'AbortSignal', 'DOMException', 'URL', 'URLSearchParams',
                'FormData', 'Blob', 'File', 'FileList', 'RTCPeerConnection',
                'PressureObserver', 'InputDeviceCapabilities', 'MediaSession',
                'Touch', 'TouchList', 'EyeDropper', 'XMLHttpRequest',
                'XMLHttpRequestUpload', 'WebSocket', 'Notification', 'Image',
                'Audio', 'Headers', 'Request', 'Response', 'createImageBitmap',
                'structuredClone', 'queueMicrotask', 'reportError', 'atob',
                'btoa', 'ResizeObserver', 'IntersectionObserver',
                'MutationObserver', 'TextEncoder', 'TextDecoder', 'EventTarget',
                'Event', 'CustomEvent', 'MediaStream', 'MediaStreamTrack',
                'MediaRecorder', 'DOMRect', 'DOMRectReadOnly', 'DOMPoint',
                'DOMPointReadOnly', 'DOMQuad',
                // The WebGL/Canvas context
                // constructor OBJECTS themselves. Their prototype methods are
                // masked by the universal sweep, but String(WebGLRenderingContext)
                // is commonly enumerated and must be `[native code]`.
                'WebGLRenderingContext', 'WebGL2RenderingContext',
                'CanvasRenderingContext2D', 'WebGLContextEvent',
                // Event-subclass constructor
                // objects. event_bootstrap.js defines them as JS classes, so
                // String(MouseEvent) leaked `class MouseEvent extends ...`,
                // which differs from real Chrome. Masking sets `[native code]`
                // + the correct own `.name`. Real Chrome: every one is native.
                'UIEvent', 'MouseEvent', 'KeyboardEvent', 'InputEvent',
                'FocusEvent', 'PointerEvent', 'WheelEvent', 'MessageEvent',
                'ErrorEvent', 'ProgressEvent', 'AnimationEvent',
                'TransitionEvent', 'ClipboardEvent', 'PopStateEvent',
                'HashChangeEvent', 'StorageEvent', 'PageTransitionEvent',
                'BeforeUnloadEvent', 'DragEvent', 'SecurityPolicyViolationEvent',
                'CompositionEvent', 'DeviceMotionEvent', 'DeviceOrientationEvent',
            ];
            for (const _e of _sfcNames) {
                try {
                    const _key = Array.isArray(_e) ? _e[0] : _e;
                    const _nm = Array.isArray(_e) ? _e[1] : _e;
                    const _fn = globalThis[_key];
                    if (typeof _fn === 'function') _mask(_fn, _nm);
                } catch (_e2) {}
            }
        }
    } catch (_e) { /* sfc masking is best-effort */ }

    // -- Universal prototype mask sweep ----------
    // Many scripts inspect Function.prototype.toString
    // on patched prototype methods (Headers/Request/Response, XHR,
    // Observers, Streams, Event subclasses, IDB, Range, etc.). Walk
    // every globalThis constructor that has a .prototype, mask every
    // own-function method to `function NAME() { [native code] }`.
    // Runs AFTER all bootstraps (interfaces / shared_apis / streams /
    // events / canvas / window / worker) so it covers every prototype
    // installed by them — including bootstraps that run post-snapshot.
    // Safe on real V8 natives: `_maskAsNative` is idempotent — sets the
    // Symbol(__browser_oxide_native__) tag; if the function was already
    // native-toString-ing it stays so.
    try {
        const _mask = globalThis._maskAsNative;
        if (typeof _mask === 'function') {
            const _SKIP = new Set([Object.prototype, Function.prototype]);
            for (const _gname of Object.getOwnPropertyNames(globalThis)) {
                let _v;
                try { _v = globalThis[_gname]; } catch (_e) { continue; }
                if (typeof _v !== 'function') continue;
                const _p = _v.prototype;
                if (!_p || _SKIP.has(_p)) continue;
                const _methods = [];
                let _ns;
                try { _ns = Object.getOwnPropertyNames(_p); } catch (_e) { continue; }
                for (const _n of _ns) {
                    if (_n === 'constructor') continue;
                    let _d;
                    try { _d = Object.getOwnPropertyDescriptor(_p, _n); } catch (_e) { continue; }
                    // Collect ACCESSOR props too
                    // (get/set), not just data-value methods. _maskAsNative
                    // already masks desc.get/desc.set (stealth_bootstrap.js:94),
                    // but the sweep previously skipped accessor-only props, so
                    // ~15 injected getters/setters (Request.signal, Response.*,
                    // ReadableStream.locked, MessagePort.onmessage,
                    // URLSearchParams.size, WebSocket.*) leaked JS source under
                    // `getOwnPropertyDescriptor(proto,name).get.toString()` —
                    // a Function.toString integrity tell ~11 vendors probe.
                    if (
                        _d &&
                        (typeof _d.value === 'function' ||
                            typeof _d.get === 'function' ||
                            typeof _d.set === 'function')
                    ) {
                        _methods.push(_n);
                    }
                }
                if (_methods.length) {
                    try { _mask(_p, ..._methods); } catch (_e) {}
                }
            }
        }
    } catch (_e) { /* universal mask sweep is best-effort */ }

    // The engine namespace lives in a symbol-keyed slot on the global, because
    // the per-navigation init scripts (humanize.js, strict_api.js) have to find
    // it after this pass has deleted every string-keyed handle. Chrome's window
    // has no own symbols at all, so `Object.getOwnPropertySymbols(window).length`
    // is a one-line tell — the three reflection entry points that would report
    // it skip that one slot on the global object here. Any other object, and any
    // other symbol on the global, is reported unchanged.
    try {
        const hidden = (() => {
            const syms = Object.getOwnPropertySymbols(globalThis, 1);
            for (let i = 0; i < syms.length; i++) {
                const v = globalThis[syms[i]];
                if (v && v.__bo) return syms[i];
            }
            return null;
        })();
        if (hidden) {
            const mask = typeof _maskFunction === 'function' ? _maskFunction : (f) => f;
            const origSymbols = Object.getOwnPropertySymbols;
            const origOwnKeys = Reflect.ownKeys;
            const origDescriptors = Object.getOwnPropertyDescriptors;
            const strip = (list, target) =>
                (target === globalThis ? list.filter((k) => k !== hidden) : list);
            // The engine's own init scripts (injected per navigation, before any
            // page script) ask for the slot with a second argument. Chrome
            // ignores extra arguments here, so this costs nothing observable
            // unless someone calls it with two arguments and diffs the result.
            const getOwnPropertySymbols = function getOwnPropertySymbols(target) {
                const list = origSymbols(target);
                return arguments.length > 1 ? list : strip(list, target);
            };
            const ownKeys = function ownKeys(target) {
                return strip(origOwnKeys(target), target);
            };
            const getOwnPropertyDescriptors = function getOwnPropertyDescriptors(target) {
                const out = origDescriptors(target);
                if (target === globalThis) { try { delete out[hidden]; } catch (_e) {} }
                return out;
            };
            mask(getOwnPropertySymbols, 'getOwnPropertySymbols');
            mask(ownKeys, 'ownKeys');
            mask(getOwnPropertyDescriptors, 'getOwnPropertyDescriptors');
            Object.defineProperty(Object, 'getOwnPropertySymbols', {
                value: getOwnPropertySymbols, writable: true, enumerable: false, configurable: true,
            });
            Object.defineProperty(Reflect, 'ownKeys', {
                value: ownKeys, writable: true, enumerable: false, configurable: true,
            });
            Object.defineProperty(Object, 'getOwnPropertyDescriptors', {
                value: getOwnPropertyDescriptors, writable: true, enumerable: false, configurable: true,
            });
        }
    } catch (_e) { /* best effort */ }

    const internals = [
        'Deno',
        'ops',
        '_maskFunction',
        '_maskAsNative',
        '_nativeTag',
        '_customElementsRegistry',
        '__bootstrap',
        '__browser_oxide',
        // NOT '__syncCookiesFromNet': this purge runs before the host-move
        // block below, so listing it here deleted the function before it could
        // be preserved — and the engine's post-navigation call then silently
        // did nothing, leaving `document.cookie` empty for the page's whole
        // life while cookies kept flowing correctly at the HTTP layer.
        '__documentReadyState',
        '__drainCspViolations',
        '__onNodeInserted',
        '__errors',
    ];

    // -- Worker Scope Isolation (Phase 8) ---------------------------
    // Real Chrome Web Workers (DedicatedWorkerGlobalScope) have a very
    // clean namespace. They do NOT expose DOM, CSSOM, or Hardware APIs.
    // If we're in a worker, purge the illegal globals.
    const _isWorker = typeof DedicatedWorkerGlobalScope !== 'undefined' && 
                      globalThis instanceof DedicatedWorkerGlobalScope;
    const _workerIsGecko = (() => {
        try {
            return (ops && ops.op_has_stealth_profile && ops.op_has_stealth_profile())
                ? /Firefox\/|Gecko\/20100101/.test(ops.op_get_profile_value('user_agent') || '') : false;
        } catch (_e) { return false; }
    })();
    if (_isWorker && _workerIsGecko) {
        const _workerPurge = [
            'window', 'document', 'history', 'locationbar', 'menubar', 
            'personalbar', 'scrollbars', 'statusbar', 'toolbar', 'frames', 
            'parent', 'top', 'opener', 'frameElement', 'styleMedia', 
            'getComputedStyle', 'getSelection', 'matchMedia', 'alert', 
            'confirm', 'prompt', 'print', 'stop', 'open', 
            'focus', 'blur', 'moveBy', 'moveTo', 'resizeBy', 'resizeTo', 
            'scroll', 'scrollBy', 'scrollTo',
            'requestIdleCallback', 'cancelIdleCallback',
            // Constructors
            'Node', 'Element', 'HTMLElement', 'HTMLDocument', 'Document', 
            'CharacterData', 'Text', 'Comment', 'CDATASection', 'DocumentFragment', 
            'DocumentType', 'NamedNodeMap', 'Attr', 'NodeList', 'HTMLCollection', 
            'HTMLAllCollection', 'DOMTokenList', 'DOMImplementation', 'Range', 
            'Selection', 'DOMParser', 'XMLSerializer', 'XPathEvaluator', 
            'XPathExpression', 'XPathResult', 'XSLTProcessor', 'MutationObserver', 
            'MutationRecord', 'IntersectionObserver', 'ResizeObserver', 
            'PermissionStatus', 'Screen', 'ScreenOrientation', 'VisualViewport',
            'ViewTransition', 'Highlight', 'HighlightRegistry',
            // Hardware/Media (not allowed in workers)
            'Bluetooth', 'USB', 'HID', 'Serial', 'Gamepad', 'GamepadButton', 
            'GamepadEvent', 'GamepadHapticActuator', 'MediaStream', 'MediaStreamTrack', 
            'MediaRecorder', 'RTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 
            'RTCIceCandidate', 'RTCCertificate', 'Presentation', 'PresentationRequest',
            // CSS classes (100+)
            'CSS', 'CSSStyleSheet', 'CSSRule', 'CSSStyleRule', 'CSSMediaRule', 
            'CSSImportRule', 'CSSFontFaceRule', 'CSSPageRule', 'CSSKeyframesRule', 
            'CSSKeyframeRule', 'CSSNamespaceRule', 'CSSSupportsRule', 'CSSCounterStyleRule',
            // ... and all HTML*Element subclasses
        ];
        for (const k of Object.keys(globalThis)) {
            if (k.startsWith('HTML') || k.startsWith('SVG') || k.startsWith('CSS') || _workerPurge.includes(k)) {
                try { delete globalThis[k]; } catch (_) {}
            }
        }
    }

    if (ops && ops.op_cross_origin_isolated && !ops.op_cross_origin_isolated()) {
        internals.push('SharedArrayBuffer');
    }

    // -- Warm-reuse global-namespace reset ---------------------------
    // The last retention source for a pooled `Page`: properties page
    // scripts hang straight off the global (`window.__APP_STATE = …`,
    // `window.onscroll = …`, framework singletons). `globalThis` is the
    // same object for the whole life of the `JsRuntime`, so on the warm
    // path every one of those — and everything they transitively
    // reference — survives into the next navigation. A real browser gives
    // each navigation a fresh global; this is the closest equivalent that
    // keeps the expensive bootstrap intact.
    //
    // `__markGlobalsBaseline()` snapshots the engine-owned key set;
    // `__resetPageGlobals()` deletes everything added since. Rust re-marks
    // the baseline once more after it installs the post-bootstrap
    // instrumentation (`__cookieWrites` / `__scriptErrors` / the fetch +
    // XHR wrappers), which is why those names are also allowlisted below —
    // construction paths that skip the re-mark must not lose them.
    // Note `window === globalThis` here (dom_bootstrap.js), so scrubbing
    // the global object covers both.
    // Guarded: this file is executed TWICE per page — once from
    // `BrowserJsRuntime`'s constructor (before any page script) and again
    // from `build_page_with_scripts_*` after the document's scripts have
    // run. Only the first execution may seed the baseline; re-running the
    // definitions would also reset the closure variable and throw the real
    // baseline away.
    if (typeof globalThis.__resetPageGlobals !== 'function') {
        let _globalsBaseline = null;
        let _onHandlerBaseline = null;
        const _BASELINE_ALWAYS = [
            '_browser_oxide', '__cookieWrites', '__scriptErrors',
            '__bo_input_events', '__jsCookies',
        ];

        // `on*` handlers need value-level treatment, not just key-level.
        // `onscroll`, `onerror`, … already EXIST as own properties of the
        // global at bootstrap (default `null`), so a page that assigns
        // `window.onscroll = fn` mutates a baseline key rather than adding
        // one — the key-set diff below cannot see it, and the closure (plus
        // everything it captures) survives the navigation.
        //
        // Blanket-nulling them is wrong: the engine itself installs
        // `window.onerror` as its script-error instrumentation, once, and
        // does NOT re-install it on the warm path. So snapshot the values
        // at baseline and RESTORE them, which nulls page assignments while
        // preserving the engine's.
        // `on*` names from the object *and* its prototype chain. Own names alone
        // used to be enough, because a page's `document.onclick = fn` created an
        // own property. It no longer does: those handlers are now accessors on
        // `Document.prototype` (Chrome's shape) writing to a private store, so an
        // own-names sweep saw nothing and a page-authored handler survived into
        // the next navigation on a pooled page.
        const _onNames = (target) => {
            const names = new Set();
            let o = target;
            while (o && o !== Object.prototype) {
                try {
                    for (const k of Object.getOwnPropertyNames(o)) {
                        if (k.startsWith('on')) names.add(k);
                    }
                } catch (_e) { /* ignore */ }
                try { o = Object.getPrototypeOf(o); } catch (_e) { break; }
            }
            return names;
        };
        const _snapshotOnHandlers = (target) => {
            const m = new Map();
            if (!target) return m;
            for (const k of _onNames(target)) {
                try { m.set(k, target[k]); } catch (_e) {}
            }
            return m;
        };
        const _restoreOnHandlers = (target, baseline) => {
            if (!target || !baseline) return;
            const names = _onNames(target);
            for (const k of names) {
                try {
                    if (typeof target[k] !== 'function') continue;
                    const orig = baseline.get(k);
                    // Already the engine's own handler ⇒ leave it alone.
                    if (orig === target[k]) continue;
                    target[k] = (typeof orig === 'function') ? orig : null;
                } catch (_e) {}
            }
        };

        Object.defineProperty(globalThis, '__markGlobalsBaseline', {
            value: function __markGlobalsBaseline() {
                const seen = new Set(_BASELINE_ALWAYS);
                for (const k of Object.getOwnPropertyNames(globalThis)) seen.add(k);
                for (const s of Object.getOwnPropertySymbols(globalThis, 1)) seen.add(s);
                _globalsBaseline = seen;
                // `document` is a singleton that survives `replace_dom`, so
                // `document.onclick = fn` persists exactly like the window
                // case and needs the same treatment.
                _onHandlerBaseline = {
                    global: _snapshotOnHandlers(globalThis),
                    document: _snapshotOnHandlers(globalThis.document),
                };
            },
            writable: true, configurable: true, enumerable: false,
        });
        Object.defineProperty(globalThis, '__resetPageGlobals', {
            value: function __resetPageGlobals() {
                // No baseline ⇒ nothing to compare against; deleting on a
                // guess would strip the engine's own globals.
                if (!_globalsBaseline) return 0;
                let removed = 0;
                const keys = Object.getOwnPropertyNames(globalThis)
                    .concat(Object.getOwnPropertySymbols(globalThis, 1));
                for (const k of keys) {
                    if (_globalsBaseline.has(k)) continue;
                    // Best-effort: a page can install a non-configurable
                    // property, and `delete` cannot remove those.
                    try { if (delete globalThis[k]) removed++; } catch (_e) {}
                }
                if (_onHandlerBaseline) {
                    _restoreOnHandlers(globalThis, _onHandlerBaseline.global);
                    _restoreOnHandlers(globalThis.document, _onHandlerBaseline.document);
                }
                return removed;
            },
            writable: true, configurable: true, enumerable: false,
        });
        // Seed the baseline on this first execution: it runs as the last
        // bootstrap, before anything page-authored, so the global namespace
        // is exactly the engine's. Rust re-marks once more after installing
        // the post-bootstrap instrumentation. The `internals` purge below
        // only ever REMOVES keys, so marking before it is safe.
        globalThis.__markGlobalsBaseline();
    }

    for (const name of internals) {
        [globalThis, globalThis.window].forEach(obj => {
            if (!obj || !(name in obj)) return;
            try {
                const success = delete obj[name];
                if (!success) {
                    Object.defineProperty(obj, name, { enumerable: false, configurable: true });
                }
            } catch (e) {
                try {
                    Object.defineProperty(obj, name, { enumerable: false, configurable: true });
                } catch (e2) {}
            }
        });
    }

    // -- Every engine-provided function reports as native ------------
    //
    // Masking used to be a hand-kept list, and the list drifted: 25 interfaces —
    // `Navigator`, `Location`, `History`, `Screen`, `Performance` among them —
    // stringified as their own JS class source. `String(window.Navigator)` is one
    // line, every browser answers `function Navigator() { [native code] }`, and a
    // public detector reports the difference as tampered functions.
    //
    // A sweep instead of a list, run here: this bootstrap is the last thing
    // before the page's own scripts, so everything reachable is the engine's and
    // nothing of the page's can be caught by mistake.
    try {
        const mask = _maskRef;
        if (typeof mask === 'function') {
            const seen = new Set();
            const isNative = (fn) => {
                try { return String(Function.prototype.toString.call(fn)).indexOf('[native code]') >= 0; }
                catch (_e) { return true; }
            };
            const sweep = (obj, depth) => {
                if (!obj || depth > 1) return;
                let names;
                try { names = Object.getOwnPropertyNames(obj); } catch (_e) { return; }
                for (const key of names) {
                    if (key === 'caller' || key === 'callee' || key === 'arguments') continue;
                    let d;
                    try { d = Object.getOwnPropertyDescriptor(obj, key); } catch (_e) { continue; }
                    if (!d) continue;
                    for (const fn of [d.value, d.get, d.set]) {
                        if (typeof fn !== 'function' || seen.has(fn)) continue;
                        seen.add(fn);
                        if (isNative(fn)) continue;
                        const label = fn.name || key;
                        try { mask(fn, label); } catch (_e) {}
                    }
                    // One level down: a constructor's prototype carries the
                    // methods scripts actually reach for.
                    if (depth === 0 && typeof d.value === 'function' && d.value.prototype) {
                        sweep(d.value.prototype, 1);
                    }
                }
            };
            sweep(globalThis, 0);
        }
    } catch (_e) { /* best effort */ }

    // -- Arity of window methods, as Chrome reports it ----------------
    //
    // `Function.length` is a configurable own property and a bot check reads it
    // next to the name and the source: `setTimeout` declared as `(...args)`
    // reports 0 where every browser reports 1. Applied here because these are
    // defined across several bootstraps and some are replaced after their own.
    try {
        for (const [name, len] of [
            ['setTimeout', 1], ['setInterval', 1],
            ['clearTimeout', 0], ['clearInterval', 0],
            ['requestAnimationFrame', 1], ['cancelAnimationFrame', 1],
            ['requestIdleCallback', 1], ['cancelIdleCallback', 1],
            ['fetch', 1], ['queueMicrotask', 1], ['structuredClone', 1],
            ['atob', 1], ['btoa', 1], ['getComputedStyle', 1], ['matchMedia', 1],
        ]) {
            const fn = globalThis[name];
            if (typeof fn === 'function' && fn.length !== len) {
                try {
                    Object.defineProperty(fn, 'length', { value: len, configurable: true });
                } catch (_e) {}
            }
        }
    } catch (_e) { /* best effort */ }

    // -- Interfaces that belong to other realms or other browsers -----
    //
    // `WorkerGlobalScope`/`DedicatedWorkerGlobalScope` are a *worker's* own
    // interfaces and are not on a window; `ApplePaySession` is Safari's, not
    // Chrome's. Both were reachable here, and a global this engine has that the
    // browser it claims to be does not is exactly what a namespace comparison
    // reports as an unusual property. Verified against a real Chrome.
    try {
        const _inWorker =
            Object.prototype.toString.call(globalThis) === '[object DedicatedWorkerGlobalScope]';
        if (!_inWorker) {
            for (const k of ['WorkerGlobalScope', 'DedicatedWorkerGlobalScope', 'ApplePaySession']) {
                try { delete globalThis[k]; } catch (_e) {}
            }
        }
    } catch (_e) { /* best effort */ }

    // -- Host hooks off the global namespace --------------------------
    //
    // The engine's own state and the callbacks the host drives it through were
    // plain named globals: `_browser_oxide`, `__resetPageGlobals`,
    // `__pendingNavigation` and the rest. `Object.getOwnPropertyNames(window)`
    // listed all ten, one of them spelling out the engine's name, and comparing
    // that list against a real Chrome's is a standard check — a public bot
    // detector reports it as "unusual window properties".
    //
    // They move onto the symbol-keyed namespace, which no enumeration reaches,
    // and the host reaches them the same way it reaches `setCurrentScript`.
    try {
        const _ns = (function () {
            const syms = Object.getOwnPropertySymbols(globalThis, 1);
            for (let i = 0; i < syms.length; i++) {
                const v = globalThis[syms[i]];
                if (v && v.__bo) return v;
            }
            return null;
        })();
        if (_ns) {
            const host = { bo: globalThis._browser_oxide || null };
            for (const name of [
                '__bgSetTimeout', '__boResult', '__cancelAllListeners',
                '__cancelAllTimers', '__markGlobalsBaseline', '__pendingNavigation',
                '__resetCustomElements', '__resetDomRegistries', '__resetPageGlobals',
                '__ifAppendCount', '__jsCookies', '__syncCookiesFromNet',
            ]) {
                if (name in globalThis) host[name] = globalThis[name];
                try { delete globalThis[name]; } catch (_e) {}
            }
            try { delete globalThis._browser_oxide; } catch (_e) {}
            Object.defineProperty(_ns, 'host', {
                value: host, writable: true, enumerable: false, configurable: true,
            });
        }
    } catch (_e) { /* best effort */ }

    // WebIDL interface objects are non-enumerable; attributes and operations
    // are not. Bootstraps that install a constructor with a plain
    // `globalThis.X = …` make it enumerable, so it shows up in
    // `Object.keys(window)` where a real Chrome has nothing — 51 of them,
    // measured against a real-browser capture. Fixed here rather than at each
    // install site, so a constructor added later cannot reintroduce it.
    try {
        for (const name of Object.keys(globalThis)) {
            const first = name.charCodeAt(0);
            if (first < 65 || first > 90) continue;
            const d = Object.getOwnPropertyDescriptor(globalThis, name);
            if (!d || !d.enumerable || !d.configurable) continue;
            const v = d.value;
            if (typeof v !== 'function' || !v.prototype) continue;
            Object.defineProperty(globalThis, name, {
                value: v,
                writable: d.writable !== false,
                enumerable: false,
                configurable: true,
            });
        }
    } catch (_e) { /* best effort */ }

    // `queueMicrotask` is an operation, not an interface object, so Chrome
    // enumerates it. Ours was replaced above by assignment, which keeps
    // whatever enumerability deno_core gave it.
    try {
        const d = Object.getOwnPropertyDescriptor(globalThis, 'queueMicrotask');
        if (d && !d.enumerable && d.configurable) {
            Object.defineProperty(globalThis, 'queueMicrotask', { ...d, enumerable: true });
        }
    } catch (_e) { /* best effort */ }

    const CHROME_WINDOW_FOR_IN_ORDER = [
        'window', 'self', 'document', 'name', 'location', 'customElements', 'history',
        'navigation', 'locationbar', 'menubar', 'personalbar', 'scrollbars', 'statusbar',
        'toolbar', 'status', 'closed', 'frames', 'length', 'top', 'opener', 'parent',
        'frameElement', 'navigator', 'origin', 'external', 'screen', 'innerWidth',
        'innerHeight', 'scrollX', 'pageXOffset', 'scrollY', 'pageYOffset', 'visualViewport',
        'screenX', 'screenY', 'outerWidth', 'outerHeight', 'devicePixelRatio', 'event',
        'clientInformation', 'screenLeft', 'screenTop', 'styleMedia', 'onsearch',
        'onappinstalled', 'onbeforeinstallprompt', 'onabort', 'onbeforeinput',
        'onbeforematch', 'onbeforetoggle', 'onblur', 'oncancel', 'oncanplay',
        'oncanplaythrough', 'onchange', 'onclick', 'onclose', 'oncommand',
        'oncontentvisibilityautostatechange', 'oncontextlost', 'oncontextmenu',
        'oncontextrestored', 'oncuechange', 'ondblclick', 'ondrag', 'ondragend',
        'ondragenter', 'ondragleave', 'ondragover', 'ondragstart', 'ondrop',
        'ondurationchange', 'onemptied', 'onended', 'onerror', 'onfocus', 'onformdata',
        'oninput', 'oninvalid', 'onkeydown', 'onkeypress', 'onkeyup', 'onload',
        'onloadeddata', 'onloadedmetadata', 'onloadstart', 'onmousedown', 'onmouseenter',
        'onmouseleave', 'onmousemove', 'onmouseout', 'onmouseover', 'onmouseup',
        'onmousewheel', 'onpause', 'onplay', 'onplaying', 'onprogress', 'onratechange',
        'onreset', 'onresize', 'onscroll', 'onscrollend', 'onsecuritypolicyviolation',
        'onseeked', 'onseeking', 'onselect', 'onslotchange', 'onstalled', 'onsubmit',
        'onsuspend', 'ontimeupdate', 'ontoggle', 'onvolumechange', 'onwaiting',
        'onwebkitanimationend', 'onwebkitanimationiteration', 'onwebkitanimationstart',
        'onwebkittransitionend', 'onwheel', 'onauxclick', 'ongotpointercapture',
        'onlostpointercapture', 'onpointerdown', 'onpointermove', 'onpointerup',
        'onpointercancel', 'onpointerover', 'onpointerout', 'onpointerenter',
        'onpointerleave', 'onselectstart', 'onselectionchange', 'onanimationcancel',
        'onanimationend', 'onanimationiteration', 'onanimationstart', 'ontransitionrun',
        'ontransitionstart', 'ontransitionend', 'ontransitioncancel', 'onbeforexrselect',
        'onafterprint', 'onbeforeprint', 'onbeforeunload', 'onhashchange',
        'onlanguagechange', 'onmessage', 'onmessageerror', 'onoffline', 'ononline',
        'onpagehide', 'onpageshow', 'onpopstate', 'onrejectionhandled', 'onstorage',
        'onunhandledrejection', 'onunload', 'isSecureContext', 'crossOriginIsolated',
        'scheduler', 'performance', 'trustedTypes', 'crypto', 'indexedDB', 'localStorage',
        'sessionStorage', 'alert', 'atob', 'blur', 'btoa', 'cancelAnimationFrame',
        'cancelIdleCallback', 'captureEvents', 'clearInterval', 'clearTimeout', 'close',
        'confirm', 'createImageBitmap', 'fetch', 'find', 'focus', 'getComputedStyle',
        'getSelection', 'matchMedia', 'moveBy', 'moveTo', 'open', 'postMessage', 'print',
        'prompt', 'queueMicrotask', 'releaseEvents', 'reportError', 'requestAnimationFrame',
        'requestIdleCallback', 'resizeBy', 'resizeTo', 'scroll', 'scrollBy', 'scrollTo',
        'setInterval', 'setTimeout', 'stop', 'structuredClone',
        'webkitCancelAnimationFrame', 'webkitRequestAnimationFrame', 'chrome',
        'crashReport', 'cookieStore', 'ondevicemotion', 'ondeviceorientation',
        'ondeviceorientationabsolute', 'onpointerrawupdate', 'caches',
        'documentPictureInPicture', 'fetchLater', 'getScreenDetails',
        'queryLocalFonts', 'showDirectoryPicker', 'showOpenFilePicker',
        'showSaveFilePicker', 'originAgentCluster', 'viewport', 'onpageswap',
        'onpagereveal', 'credentialless', 'fence', 'launchQueue', 'speechSynthesis',
        'onscrollsnapchange', 'onscrollsnapchanging', 'ongamepadconnected',
        'ongamepaddisconnected', 'webkitRequestFileSystem',
        'webkitResolveLocalFileSystemURL', 'AppInit', '_epicEnableCookieGuard',
        '__tracking_base', 'Raven', '_epicTrackingCookieDomainId',
        '_epicTrackingCountryCode', '_epicTracking', '_sentryDebugIds',
        '_sentryDebugIdIdentifier', 'SENTRY_RELEASE', '__axiosInstance',
        'regeneratorRuntime', '__STATSIG__', '__store', '__SENTRY__', 'TEMPORARY',
        'PERSISTENT',
    ];
    try {
        const _nsw = (function () {
            const syms = Object.getOwnPropertySymbols(globalThis, 1);
            for (let i = 0; i < syms.length; i++) {
                const v = globalThis[syms[i]];
                if (v && v.__bo) return v;
            }
            return null;
        })();
        const _inWorker = typeof WorkerGlobalScope !== 'undefined'
            && globalThis instanceof WorkerGlobalScope;
        if (!_inWorker && (!_nsw || !_nsw.winOrdered)) {
            if (_nsw) _nsw.winOrdered = true;
            const movable = Object.getOwnPropertyNames(globalThis).filter((n) => {
                const d = Object.getOwnPropertyDescriptor(globalThis, n);
                return d && d.enumerable && d.configurable;
            });
            const known = CHROME_WINDOW_FOR_IN_ORDER.filter((n) => movable.indexOf(n) !== -1);
            const seen = new Set(known);
            const rest = movable.filter((n) => !seen.has(n));
            for (const name of known.concat(rest)) {
                const d = Object.getOwnPropertyDescriptor(globalThis, name);
                if (!d) continue;
                try {
                    delete globalThis[name];
                    Object.defineProperty(globalThis, name, d);
                } catch (_e) { /* leave it where it was */ }
            }
        }
    } catch (_e) { /* best effort */ }

    // Window attribute shapes, measured against Chrome 151: every one of these is
    // an accessor, and only the [Replaceable] half carries a setter. Individual
    // install sites drifted both ways — some stayed data properties, some got a
    // getter with no setter — so the shape is settled here, once.
    const WINDOW_GETTER_ONLY = [
        'window', 'document', 'top', 'customElements', 'history', 'closed',
        'frameElement', 'navigator', 'styleMedia', 'isSecureContext',
        'crossOriginIsolated', 'trustedTypes', 'crypto', 'indexedDB', 'localStorage',
        'sessionStorage', 'caches', 'cookieStore', 'documentPictureInPicture',
        'originAgentCluster', 'credentialless', 'fence', 'launchQueue',
        'speechSynthesis', 'crashReport',
    ];
    const WINDOW_WITH_SETTER = [
        'location', 'parent', 'self', 'name', 'navigation', 'locationbar', 'menubar',
        'personalbar', 'scrollbars', 'statusbar', 'toolbar', 'status', 'frames',
        'length', 'opener', 'origin', 'external', 'screen', 'innerWidth', 'innerHeight',
        'scrollX', 'pageXOffset', 'scrollY', 'pageYOffset', 'visualViewport', 'screenX',
        'screenY', 'outerWidth', 'outerHeight', 'devicePixelRatio', 'event',
        'clientInformation', 'screenLeft', 'screenTop', 'scheduler', 'performance',
        'viewport',
    ];
    try {
        const mask = (fn, name) => { try { if (_maskRef) _maskRef(fn, name); } catch (_e) {} return fn; };
        // [Replaceable]: assignment turns the property into a plain data property.
        const replaceable = (name) => mask(Object.getOwnPropertyDescriptor({
            set [name](v) {
                Object.defineProperty(globalThis, name, {
                    value: v, writable: true, enumerable: true, configurable: true,
                });
            },
        }, name).set, 'set ' + name);
        const reshape = (name, wantSetter) => {
            const d = Object.getOwnPropertyDescriptor(globalThis, name);
            if (!d || !d.configurable) return;
            let get = d.get;
            if (!get && !d.set) {
                const held = d.value;
                get = mask(Object.getOwnPropertyDescriptor(
                    { get [name]() { return held; } }, name).get, 'get ' + name);
            }
            if (!get) return;
            const set = wantSetter ? (d.set || replaceable(name)) : undefined;
            if (get === d.get && set === d.set) return;
            Object.defineProperty(globalThis, name, {
                get, set, enumerable: d.enumerable, configurable: true,
            });
        };
        for (const n of WINDOW_GETTER_ONLY) reshape(n, false);
        for (const n of WINDOW_WITH_SETTER) reshape(n, true);
    } catch (_e) { /* best effort */ }

    // [LegacyUnforgeable] attributes: non-configurable in Chrome. Locked after
    // the ordering pass and in place — a delete/redefine would move them to the
    // end of the enumeration the pass just fixed.
    try {
        for (const name of (_isWorkerScope ? [] : ['window', 'document', 'location', 'top'])) {
            const d = Object.getOwnPropertyDescriptor(globalThis, name);
            if (!d || !d.configurable || (!d.get && !d.set)) continue;
            Object.defineProperty(globalThis, name, {
                get: d.get, set: d.set, enumerable: d.enumerable, configurable: false,
            });
        }
    } catch (_e) { /* best effort */ }

    // Legacy quota constants Chrome carries on `Window` and `Window.prototype`.
    try {
        const define = (holder, name, value) => {
            if (holder && !Object.prototype.hasOwnProperty.call(holder, name)) {
                Object.defineProperty(holder, name, {
                    value, writable: false, enumerable: true, configurable: false,
                });
            }
        };
        for (const [name, value] of [['TEMPORARY', 0], ['PERSISTENT', 1]]) {
            define(globalThis.Window, name, value);
            define(globalThis.Window && globalThis.Window.prototype, name, value);
            if (!_isWorkerScope && !(name in globalThis)) define(globalThis, name, value);
        }
    } catch (_e) { /* best effort */ }

    const CHROME_NAVIGATOR_FOR_IN_ORDER = [
        'vendorSub', 'productSub', 'vendor', 'maxTouchPoints', 'scheduling',
        'userActivation', 'geolocation', 'doNotTrack', 'webkitTemporaryStorage',
        'webkitPersistentStorage', 'windowControlsOverlay', 'hardwareConcurrency',
        'cookieEnabled', 'appCodeName', 'appName', 'appVersion', 'platform', 'product',
        'userAgent', 'language', 'languages', 'onLine', 'webdriver', 'plugins', 'mimeTypes',
        'pdfViewerEnabled', 'connection', 'getGamepads', 'javaEnabled', 'sendBeacon',
        'vibrate', 'deprecatedRunAdAuctionEnforcesKAnonymity', 'protectedAudience',
        'bluetooth', 'clipboard', 'credentials', 'keyboard', 'managed', 'mediaDevices',
        'serviceWorker', 'virtualKeyboard', 'wakeLock', 'deviceMemory', 'userAgentData',
        'locks', 'storage', 'gpu', 'login', 'ink', 'mediaCapabilities', 'permissions',
        'devicePosture', 'hid', 'mediaSession', 'presentation', 'serial', 'usb', 'xr',
        'storageBuckets', 'adAuctionComponents', 'runAdAuction',
        'canLoadAdAuctionFencedFrame', 'canShare', 'share', 'clearAppBadge', 'getBattery',
        'getUserMedia', 'requestMIDIAccess', 'requestMediaKeySystemAccess', 'setAppBadge',
        'webkitGetUserMedia', 'clearOriginJoinedAdInterestGroups', 'createAuctionNonce',
        'joinAdInterestGroup', 'leaveAdInterestGroup', 'updateAdInterestGroups',
        'deprecatedReplaceInURN', 'deprecatedURNToURL', 'getInstalledRelatedApps',
        'getInterestGroupAdAuctionData', 'registerProtocolHandler',
        'unregisterProtocolHandler',
    ];
    try {
        const _np = globalThis.Navigator && globalThis.Navigator.prototype;
        if (_np) {
            const own = Object.getOwnPropertyNames(_np);
            const known = CHROME_NAVIGATOR_FOR_IN_ORDER.filter((n) => own.indexOf(n) !== -1);
            const rest = own.filter((n) => CHROME_NAVIGATOR_FOR_IN_ORDER.indexOf(n) === -1);
            for (const name of known.concat(rest)) {
                const d = Object.getOwnPropertyDescriptor(_np, name);
                if (!d || !d.configurable) continue;
                delete _np[name];
                Object.defineProperty(_np, name, d);
            }
        }
    } catch (_e) { /* best effort */ }


    // Interface inheritance as Chrome 152 has it. Only two kinds of change are
    // made: a prototype still hanging off Object.prototype gets its real parent,
    // and a prototype whose current parent is a Chrome ancestor gets the missing
    // levels in between. Constructors are re-parented the same way, except that
    // an illegal-constructor stub is never put under a real class — its
    // `super()` would start throwing.
    try {
        const _ns = (() => {
            try {
                const syms = Object.getOwnPropertySymbols(globalThis, 1);
                for (let i = 0; i < syms.length; i++) {
                    const v = globalThis[syms[i]];
                    if (v && v.__bo) return v;
                }
            } catch (_) {}
            return null;
        })();
        const stubs = (_ns && _ns.stubs) || new WeakSet();
        const parentOf = new Map();
        for (const group of "AbortController:TaskController;AbortSignal:TaskSignal;AbstractRange:NodeRange,OpaqueRange;Accelerometer:GravitySensor,LinearAccelerationSensor;Animation:CSSAnimation,CSSTransition;AnimationEffect:KeyframeEffect;AnimationTimeline:DocumentTimeline,ScrollTimeline;AnimationTrigger:TimelineTrigger;AudioNode:AnalyserNode,AudioDestinationNode,AudioScheduledSourceNode,AudioWorkletNode,BiquadFilterNode,ChannelMergerNode,ChannelSplitterNode,ConvolverNode,DelayNode,DynamicsCompressorNode,GainNode,IIRFilterNode,MediaElementAudioSourceNode,MediaStreamAudioDestinationNode,MediaStreamAudioSourceNode,PannerNode,ScriptProcessorNode,StereoPannerNode,WaveShaperNode;AudioScheduledSourceNode:AudioBufferSourceNode,ConstantSourceNode,OscillatorNode;AuthenticatorResponse:AuthenticatorAssertionResponse,AuthenticatorAttestationResponse;BaseAudioContext:AudioContext,OfflineAudioContext;Blob:File;CSSConditionRule:CSSContainerRule,CSSMediaRule,CSSSupportsRule;CSSGroupingRule:CSSConditionRule,CSSFunctionRule,CSSLayerBlockRule,CSSPageRule,CSSScopeRule,CSSStartingStyleRule;CSSMathValue:CSSMathClamp,CSSMathInvert,CSSMathMax,CSSMathMin,CSSMathNegate,CSSMathProduct,CSSMathSum;CSSNumericValue:CSSMathValue,CSSUnitValue;CSSRule:CSSCounterStyleRule,CSSFontFaceRule,CSSFontFeatureValuesRule,CSSFontPaletteValuesRule,CSSFunctionDeclarations,CSSGroupingRule,CSSImportRule,CSSKeyframeRule,CSSKeyframesRule,CSSLayerStatementRule,CSSMarginRule,CSSNamespaceRule,CSSNestedDeclarations,CSSPositionTryRule,CSSPropertyRule,CSSStyleRule,CSSViewTransitionRule;CSSStyleDeclaration:CSSFunctionDescriptors,CSSPositionTryDescriptors;CSSStyleValue:CSSImageValue,CSSKeywordValue,CSSNumericValue,CSSPositionValue,CSSTransformValue,CSSUnparsedValue;CSSTransformComponent:CSSMatrixComponent,CSSPerspective,CSSRotate,CSSScale,CSSSkew,CSSSkewX,CSSSkewY,CSSTranslate;CharacterData:Comment,ProcessingInstruction,Text;Credential:DigitalCredential,FederatedCredential,IdentityCredential,OTPCredential,PasswordCredential,PublicKeyCredential;DOMException:GPUPipelineError,IdentityCredentialError,OverconstrainedError,QuotaExceededError,RTCError,WebSocketError,WebTransportError;DOMMatrixReadOnly:DOMMatrix;DOMPointReadOnly:DOMPoint;DOMRectReadOnly:DOMRect;Document:HTMLDocument,XMLDocument;DocumentFragment:ShadowRoot;Element:HTMLElement,MathMLElement,SVGElement;Error:DOMException;Event:AnimationEvent,AnimationPlaybackEvent,AudioProcessingEvent,BeforeInstallPromptEvent,BeforeUnloadEvent,BlobEvent,CharacterBoundsUpdateEvent,ClipboardChangeEvent,ClipboardEvent,CloseEvent,CommandEvent,ContentVisibilityAutoStateChangeEvent,CookieChangeEvent,CustomEvent,DeviceMotionEvent,DeviceOrientationEvent,DocumentPictureInPictureEvent,ErrorEvent,FontFaceSetLoadEvent,FormDataEvent,GPUUncapturedErrorEvent,GamepadEvent,HIDConnectionEvent,HIDInputReportEvent,HashChangeEvent,IDBVersionChangeEvent,InterestEvent,MIDIConnectionEvent,MIDIMessageEvent,MediaEncryptedEvent,MediaKeyMessageEvent,MediaQueryListEvent,MediaStreamEvent,MediaStreamTrackEvent,MessageEvent,NavigateEvent,NavigationCurrentEntryChangeEvent,OfflineAudioCompletionEvent,PageRevealEvent,PageSwapEvent,PageTransitionEvent,PaymentRequestUpdateEvent,PictureInPictureEvent,PopStateEvent,PresentationConnectionAvailableEvent,PresentationConnectionCloseEvent,ProgressEvent,PromiseRejectionEvent,RTCDTMFToneChangeEvent,RTCDataChannelEvent,RTCErrorEvent,RTCPeerConnectionIceErrorEvent,RTCPeerConnectionIceEvent,RTCTrackEvent,SecurityPolicyViolationEvent,SensorErrorEvent,SnapEvent,SpeechRecognitionErrorEvent,SpeechRecognitionEvent,SpeechSynthesisEvent,StorageEvent,SubmitEvent,TaskPriorityChangeEvent,TextFormatUpdateEvent,TextUpdateEvent,ToggleEvent,TrackEvent,TransitionEvent,UIEvent,USBConnectionEvent,VirtualKeyboardGeometryChangeEvent,WebGLContextEvent,WindowControlsOverlayGeometryChangeEvent,XRInputSourceEvent,XRInputSourcesChangeEvent,XRLayerEvent,XRReferenceSpaceEvent,XRSessionEvent,XRVisibilityMaskChangeEvent;EventTarget:AbortSignal,Animation,AudioDecoder,AudioEncoder,AudioNode,BackgroundFetchRegistration,BaseAudioContext,BatteryManager,Bluetooth,BluetoothDevice,BluetoothRemoteGATTCharacteristic,BroadcastChannel,CaptureController,Clipboard,CloseWatcher,CookieStore,CreateMonitor,DevicePosture,DocumentPictureInPicture,EditContext,EventSource,FileReader,FontFaceSet,GPUDevice,HID,HIDDevice,IDBDatabase,IDBRequest,IDBTransaction,IdleDetector,LanguageModel,MIDIAccess,MIDIPort,MediaDevices,MediaKeySession,MediaQueryList,MediaRecorder,MediaSource,MediaStream,MediaStreamTrack,MessagePort,Navigation,NavigationHistoryEntry,NavigatorManagedData,NetworkInformation,Node,Notification,OffscreenCanvas,PaymentRequest,PaymentResponse,Performance,PermissionStatus,PictureInPictureWindow,PresentationAvailability,PresentationConnection,PresentationConnectionList,PresentationRequest,Profiler,RTCDTMFSender,RTCDataChannel,RTCDtlsTransport,RTCIceTransport,RTCPeerConnection,RTCSctpTransport,RemotePlayback,Screen,ScreenDetails,ScreenOrientation,Sensor,Serial,SerialPort,ServiceWorker,ServiceWorkerContainer,ServiceWorkerRegistration,SharedWorker,SourceBuffer,SourceBufferList,SpeechRecognition,SpeechSynthesis,SpeechSynthesisUtterance,TextTrack,TextTrackCue,TextTrackList,USB,VideoDecoder,VideoEncoder,VirtualKeyboard,VisualViewport,WakeLockSentinel,WebSocket,WindowControlsOverlay,Worker,XMLHttpRequestEventTarget,XRLayer,XRLightProbe,XRSession,XRSpace,XRSystem;FileSystemHandle:FileSystemDirectoryHandle,FileSystemFileHandle;GPUError:GPUInternalError,GPUOutOfMemoryError,GPUValidationError;HTMLCollection:HTMLFormControlsCollection,HTMLOptionsCollection;HTMLElement:HTMLAnchorElement,HTMLAreaElement,HTMLBRElement,HTMLBaseElement,HTMLBodyElement,HTMLButtonElement,HTMLCameraElement,HTMLCanvasElement,HTMLMicrophoneElement,HTMLDListElement,HTMLDataElement,HTMLDataListElement,HTMLDetailsElement,HTMLDialogElement,HTMLDirectoryElement,HTMLDivElement,HTMLEmbedElement,HTMLFencedFrameElement,HTMLFieldSetElement,HTMLFontElement,HTMLFormElement,HTMLFrameElement,HTMLFrameSetElement,HTMLGeolocationElement,HTMLHRElement,HTMLHeadElement,HTMLHeadingElement,HTMLHtmlElement,HTMLIFrameElement,HTMLImageElement,HTMLInputElement,HTMLLIElement,HTMLLabelElement,HTMLLegendElement,HTMLLinkElement,HTMLMapElement,HTMLMarqueeElement,HTMLMediaElement,HTMLMenuElement,HTMLMetaElement,HTMLMeterElement,HTMLModElement,HTMLOListElement,HTMLObjectElement,HTMLOptGroupElement,HTMLOptionElement,HTMLOutputElement,HTMLParagraphElement,HTMLParamElement,HTMLPictureElement,HTMLPreElement,HTMLProgressElement,HTMLQuoteElement,HTMLScriptElement,HTMLSelectElement,HTMLSelectedContentElement,HTMLSlotElement,HTMLSourceElement,HTMLSpanElement,HTMLStyleElement,HTMLTableCaptionElement,HTMLTableCellElement,HTMLTableColElement,HTMLTableElement,HTMLTableRowElement,HTMLTableSectionElement,HTMLTemplateElement,HTMLTextAreaElement,HTMLTimeElement,HTMLTitleElement,HTMLTrackElement,HTMLUListElement,HTMLUnknownElement,HTMLUserMediaElement;HTMLMediaElement:HTMLAudioElement,HTMLVideoElement;IDBCursor:IDBCursorWithValue;IDBRequest:IDBOpenDBRequest;MIDIPort:MIDIInput,MIDIOutput;MediaDeviceInfo:InputDeviceInfo;MediaStreamTrack:BrowserCaptureMediaStreamTrack,CanvasCaptureMediaStreamTrack,MediaStreamTrackGenerator;MouseEvent:DragEvent,PointerEvent,WheelEvent;Node:Attr,CharacterData,Document,DocumentFragment,DocumentType,Element;NodeList:RadioNodeList;NodeRange:Range,StaticRange;OrientationSensor:AbsoluteOrientationSensor,RelativeOrientationSensor;PaymentRequestUpdateEvent:PaymentMethodChangeEvent;PerformanceEntry:InteractionContentfulPaint,LargestContentfulPaint,LayoutShift,PerformanceElementTiming,PerformanceEventTiming,PerformanceLongAnimationFrameTiming,PerformanceLongTaskTiming,PerformanceMark,PerformanceMeasure,PerformancePaintTiming,PerformanceResourceTiming,PerformanceScriptTiming,PerformanceSoftNavigation,TaskAttributionTiming,VisibilityStateEntry;PerformanceResourceTiming:PerformanceNavigationTiming;ReportBody:CSPViolationReportBody,IntegrityViolationReportBody;SVGAnimationElement:SVGAnimateElement,SVGAnimateMotionElement,SVGAnimateTransformElement,SVGSetElement;SVGComponentTransferFunctionElement:SVGFEFuncAElement,SVGFEFuncBElement,SVGFEFuncGElement,SVGFEFuncRElement;SVGElement:SVGAnimationElement,SVGClipPathElement,SVGComponentTransferFunctionElement,SVGDescElement,SVGFEBlendElement,SVGFEColorMatrixElement,SVGFEComponentTransferElement,SVGFECompositeElement,SVGFEConvolveMatrixElement,SVGFEDiffuseLightingElement,SVGFEDisplacementMapElement,SVGFEDistantLightElement,SVGFEDropShadowElement,SVGFEFloodElement,SVGFEGaussianBlurElement,SVGFEImageElement,SVGFEMergeElement,SVGFEMergeNodeElement,SVGFEMorphologyElement,SVGFEOffsetElement,SVGFEPointLightElement,SVGFESpecularLightingElement,SVGFESpotLightElement,SVGFETileElement,SVGFETurbulenceElement,SVGFilterElement,SVGGradientElement,SVGGraphicsElement,SVGMPathElement,SVGMarkerElement,SVGMaskElement,SVGMetadataElement,SVGPatternElement,SVGScriptElement,SVGStopElement,SVGStyleElement,SVGTitleElement,SVGViewElement;SVGGeometryElement:SVGCircleElement,SVGEllipseElement,SVGLineElement,SVGPathElement,SVGPolygonElement,SVGPolylineElement,SVGRectElement;SVGGradientElement:SVGLinearGradientElement,SVGRadialGradientElement;SVGGraphicsElement:SVGAElement,SVGDefsElement,SVGForeignObjectElement,SVGGElement,SVGGeometryElement,SVGImageElement,SVGSVGElement,SVGSwitchElement,SVGSymbolElement,SVGTextContentElement,SVGUseElement;SVGTextContentElement:SVGTextPathElement,SVGTextPositioningElement;SVGTextPositioningElement:SVGTSpanElement,SVGTextElement;Screen:ScreenDetailed;ScrollTimeline:ViewTimeline;Sensor:Accelerometer,Gyroscope,OrientationSensor;SharedStorageModifierMethod:SharedStorageAppendMethod,SharedStorageClearMethod,SharedStorageDeleteMethod,SharedStorageSetMethod;SpeechSynthesisEvent:SpeechSynthesisErrorEvent;StylePropertyMapReadOnly:StylePropertyMap;StyleSheet:CSSStyleSheet;Text:CDATASection;TextTrackCue:VTTCue;UIEvent:CompositionEvent,FocusEvent,InputEvent,KeyboardEvent,MouseEvent,TextEvent,TouchEvent;WebGLObject:WebGLBuffer,WebGLFramebuffer,WebGLProgram,WebGLQuery,WebGLRenderbuffer,WebGLSampler,WebGLShader,WebGLSync,WebGLTexture,WebGLTransformFeedback,WebGLVertexArrayObject;Worklet:AudioWorklet;WritableStream:FileSystemWritableFileStream;XMLHttpRequestEventTarget:XMLHttpRequest,XMLHttpRequestUpload;XRCompositionLayer:XRCubeLayer,XRCylinderLayer,XREquirectLayer,XRProjectionLayer,XRQuadLayer;XRDepthInformation:XRCPUDepthInformation,XRWebGLDepthInformation;XRLayer:XRCompositionLayer,XRWebGLLayer;XRPose:XRJointPose,XRViewerPose;XRReferenceSpace:XRBoundedReferenceSpace;XRSpace:XRJointSpace,XRReferenceSpace;XRSubImage:XRWebGLSubImage".split(";")) {
            const [parent, children] = group.split(":");
            for (const child of children.split(",")) parentOf.set(child, parent);
        }
        const isChromeAncestor = (child, name) => {
            for (let x = parentOf.get(child), i = 0; x && i < 40; x = parentOf.get(x), i++) {
                if (x === name) return true;
            }
            return false;
        };
        const iface = (name) => {
            const f = globalThis[name];
            return (typeof f === "function" && f.prototype && typeof f.prototype === "object") ? f : null;
        };
        const nameOf = (proto) => {
            try {
                const c = Object.prototype.hasOwnProperty.call(proto, "constructor") && proto.constructor;
                return (c && iface(c.name) === c) ? c.name : null;
            } catch (_) { return null; }
        };
        for (const name of ['Keyboard']) {
            const C = iface(name);
            if (C && Object.getPrototypeOf(C.prototype) !== Object.prototype) {
                try {
                    Object.setPrototypeOf(C.prototype, Object.prototype);
                    Object.setPrototypeOf(C, Function.prototype);
                } catch (_) {}
            }
        }
        for (const [child, parent] of parentOf) {
            const C = iface(child);
            const P = iface(parent);
            if (!C || !P || C === P) continue;
            const cur = Object.getPrototypeOf(C.prototype);
            if (cur !== P.prototype) {
                const curName = (cur === Object.prototype || cur === null) ? null : nameOf(cur);
                if (cur === Object.prototype || cur === null || (curName && isChromeAncestor(child, curName))) {
                    try { Object.setPrototypeOf(C.prototype, P.prototype); } catch (_) {}
                }
            }
            if (child === "DOMException") continue;
            const curStatic = Object.getPrototypeOf(C);
            if (curStatic === P || (stubs.has(P) && !stubs.has(C))) continue;
            if (curStatic === Function.prototype || (curStatic && isChromeAncestor(child, curStatic.name))) {
                try { Object.setPrototypeOf(C, P); } catch (_) {}
            }
        }
    } catch (_e) { /* best effort */ }






    try {
        const ELEMENT_MEMBERS = 'src:HTMLEmbedElement,HTMLFrameElement,HTMLIFrameElement,HTMLImageElement,HTMLInputElement,HTMLMediaElement,HTMLScriptElement,HTMLSourceElement,HTMLTrackElement,Image;href:HTMLAnchorElement,HTMLAreaElement,HTMLBaseElement,HTMLLinkElement,SVGAElement,SVGFEImageElement,SVGFilterElement,SVGGradientElement,SVGImageElement,SVGMPathElement,SVGPatternElement,SVGScriptElement,SVGTextPathElement,SVGUseElement;async:HTMLScriptElement,SVGScriptElement;defer:HTMLScriptElement;rel:HTMLAnchorElement,HTMLAreaElement,HTMLFormElement,HTMLLinkElement,SVGAElement;type:HTMLAnchorElement,HTMLButtonElement,HTMLEmbedElement,HTMLFieldSetElement,HTMLInputElement,HTMLLIElement,HTMLLinkElement,HTMLOListElement,HTMLObjectElement,HTMLOutputElement,HTMLParamElement,HTMLScriptElement,HTMLSelectElement,HTMLSourceElement,HTMLStyleElement,HTMLTextAreaElement,HTMLUListElement,SVGAElement,SVGComponentTransferFunctionElement,SVGFEColorMatrixElement,SVGFETurbulenceElement,SVGScriptElement,SVGStyleElement;integrity:HTMLLinkElement,HTMLScriptElement;crossOrigin:HTMLImageElement,HTMLLinkElement,HTMLMediaElement,HTMLScriptElement,Image,SVGImageElement;referrerPolicy:HTMLAnchorElement,HTMLAreaElement,HTMLIFrameElement,HTMLImageElement,HTMLLinkElement,HTMLScriptElement,Image,SVGAElement;style:HTMLElement,MathMLElement,SVGElement;dataset:HTMLElement,MathMLElement,SVGElement;focus:HTMLElement,MathMLElement,SVGElement;blur:HTMLElement,MathMLElement,SVGElement;click:HTMLElement;offsetTop:HTMLElement;offsetLeft:HTMLElement;offsetWidth:HTMLElement;offsetHeight:HTMLElement;offsetParent:HTMLElement';
        const READONLY = new Set(('href:SVGAElement,SVGFEImageElement,SVGFilterElement,SVGGradientElement,'
            + 'SVGImageElement,SVGMPathElement,SVGPatternElement,SVGScriptElement,SVGTextPathElement,SVGUseElement;'
            + 'type:HTMLFieldSetElement,HTMLOutputElement,HTMLSelectElement,HTMLTextAreaElement,'
            + 'SVGComponentTransferFunctionElement,SVGFEColorMatrixElement,SVGFETurbulenceElement')
            .split(';').flatMap((group) => {
                const [member, targets] = group.split(':');
                return targets.split(',').map((t) => t + '.' + member);
            }));
        const E = globalThis.Element;
        if (E && E.prototype) {
            for (const group of ELEMENT_MEMBERS.split(';')) {
                const colon = group.indexOf(':');
                const member = group.slice(0, colon);
                const d = Object.getOwnPropertyDescriptor(E.prototype, member);
                if (!d || !d.configurable) continue;
                for (const targetName of group.slice(colon + 1).split(',')) {
                    let C;
                    try { C = globalThis[targetName]; } catch (_e) { continue; }
                    if (typeof C !== 'function' || !C.prototype) continue;
                    if (Object.prototype.hasOwnProperty.call(C.prototype, member)) continue;
                    // Reflected on an element, readonly on these: SVG `href` is an
                    // SVGAnimatedString and `type` is a readonly enum, so the
                    // setter Element carries for <a>/<input> must not come along.
                    const spread = (d.get && READONLY.has(targetName + '.' + member))
                        ? { get: d.get, set: undefined, enumerable: d.enumerable, configurable: d.configurable }
                        : d;
                    try { Object.defineProperty(C.prototype, member, spread); } catch (_e) {}
                }
                try { delete E.prototype[member]; } catch (_e) {}
            }
        }
    } catch (_e) { /* best effort */ }

    try {
        const MISPLACED = 'CSSStyleSheet>StyleSheet:disabled,media,ownerNode,parentStyleSheet,title,type;'
            + 'BaseAudioContext>AudioContext:resume;HTMLElement>Element:onsearch;'
            + 'Text>CharacterData:data,length;'
            + 'Comment>CharacterData:data;Attr>Node:nodeName,nodeType,nodeValue,textContent';
        const REMOVED = 'Document:onfocusin,onfocusout;HTMLElement:onfocusin,onfocusout;'
            + 'NavigatorManagedData:getAnnotatedAssetId,getAnnotatedLocation,getDirectoryId,getHostname,getSerialNumber';
        const protoOf = (name) => {
            let C;
            try { C = globalThis[name]; } catch (_e) { return null; }
            return (typeof C === 'function' && C.prototype && typeof C.prototype === 'object') ? C.prototype : null;
        };
        for (const group of MISPLACED.split(';')) {
            const colon = group.indexOf(':');
            const [fromName, toName] = group.slice(0, colon).split('>');
            const from = protoOf(fromName);
            const to = protoOf(toName);
            if (!from || !to) continue;
            for (const member of group.slice(colon + 1).split(',')) {
                const d = Object.getOwnPropertyDescriptor(from, member);
                if (!d || !d.configurable) continue;
                try {
                    if (!Object.prototype.hasOwnProperty.call(to, member)) Object.defineProperty(to, member, d);
                    delete from[member];
                } catch (_e) {}
            }
        }
        for (const group of REMOVED.split(';')) {
            const colon = group.indexOf(':');
            const proto = protoOf(group.slice(0, colon));
            if (!proto) continue;
            for (const member of group.slice(colon + 1).split(',')) {
                try { delete proto[member]; } catch (_e) {}
            }
        }
    } catch (_e) { /* best effort */ }

    try {
        const IDL_CONSTANTS = 'CSSRule:CHARSET_RULE=2,COUNTER_STYLE_RULE=11,FONT_FACE_RULE=5,FONT_FEATURE_VALUES_RULE=14,IMPORT_RULE=3,KEYFRAMES_RULE=7,KEYFRAME_RULE=8,MARGIN_RULE=9,MEDIA_RULE=4,NAMESPACE_RULE=10,PAGE_RULE=6,STYLE_RULE=1,SUPPORTS_RULE=12;DOMException:ABORT_ERR=20,DATA_CLONE_ERR=25,DOMSTRING_SIZE_ERR=2,HIERARCHY_REQUEST_ERR=3,INDEX_SIZE_ERR=1,INUSE_ATTRIBUTE_ERR=10,INVALID_ACCESS_ERR=15,INVALID_CHARACTER_ERR=5,INVALID_MODIFICATION_ERR=13,INVALID_NODE_TYPE_ERR=24,INVALID_STATE_ERR=11,NAMESPACE_ERR=14,NETWORK_ERR=19,NOT_FOUND_ERR=8,NOT_SUPPORTED_ERR=9,NO_DATA_ALLOWED_ERR=6,NO_MODIFICATION_ALLOWED_ERR=7,QUOTA_EXCEEDED_ERR=22,SECURITY_ERR=18,SYNTAX_ERR=12,TIMEOUT_ERR=23,TYPE_MISMATCH_ERR=17,URL_MISMATCH_ERR=21,VALIDATION_ERR=16,WRONG_DOCUMENT_ERR=4;Event:AT_TARGET=2,BUBBLING_PHASE=3,CAPTURING_PHASE=1,NONE=0;EventSource:CLOSED=2,CONNECTING=0,OPEN=1;FileReader:DONE=2,EMPTY=0,LOADING=1;GeolocationPositionError:PERMISSION_DENIED=1,POSITION_UNAVAILABLE=2,TIMEOUT=3;HTMLMediaElement:HAVE_CURRENT_DATA=2,HAVE_ENOUGH_DATA=4,HAVE_FUTURE_DATA=3,HAVE_METADATA=1,HAVE_NOTHING=0,NETWORK_EMPTY=0,NETWORK_IDLE=1,NETWORK_LOADING=2,NETWORK_NO_SOURCE=3;HTMLTrackElement:ERROR=3,LOADED=2,LOADING=1,NONE=0;KeyboardEvent:DOM_KEY_LOCATION_LEFT=1,DOM_KEY_LOCATION_NUMPAD=3,DOM_KEY_LOCATION_RIGHT=2,DOM_KEY_LOCATION_STANDARD=0;MediaError:MEDIA_ERR_ABORTED=1,MEDIA_ERR_DECODE=3,MEDIA_ERR_NETWORK=2,MEDIA_ERR_SRC_NOT_SUPPORTED=4;Node:ATTRIBUTE_NODE=2,CDATA_SECTION_NODE=4,COMMENT_NODE=8,DOCUMENT_FRAGMENT_NODE=11,DOCUMENT_NODE=9,DOCUMENT_POSITION_CONTAINED_BY=16,DOCUMENT_POSITION_CONTAINS=8,DOCUMENT_POSITION_DISCONNECTED=1,DOCUMENT_POSITION_FOLLOWING=4,DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC=32,DOCUMENT_POSITION_PRECEDING=2,DOCUMENT_TYPE_NODE=10,ELEMENT_NODE=1,ENTITY_NODE=6,ENTITY_REFERENCE_NODE=5,NOTATION_NODE=12,PROCESSING_INSTRUCTION_NODE=7,TEXT_NODE=3;PerformanceNavigation:TYPE_BACK_FORWARD=2,TYPE_NAVIGATE=0,TYPE_RELOAD=1,TYPE_RESERVED=255;Range:END_TO_END=2,END_TO_START=3,START_TO_END=1,START_TO_START=0;SVGAngle:SVG_ANGLETYPE_DEG=2,SVG_ANGLETYPE_GRAD=4,SVG_ANGLETYPE_RAD=3,SVG_ANGLETYPE_UNKNOWN=0,SVG_ANGLETYPE_UNSPECIFIED=1;SVGComponentTransferFunctionElement:SVG_FECOMPONENTTRANSFER_TYPE_DISCRETE=3,SVG_FECOMPONENTTRANSFER_TYPE_GAMMA=5,SVG_FECOMPONENTTRANSFER_TYPE_IDENTITY=1,SVG_FECOMPONENTTRANSFER_TYPE_LINEAR=4,SVG_FECOMPONENTTRANSFER_TYPE_TABLE=2,SVG_FECOMPONENTTRANSFER_TYPE_UNKNOWN=0;SVGFEBlendElement:SVG_FEBLEND_MODE_COLOR=15,SVG_FEBLEND_MODE_COLOR_BURN=8,SVG_FEBLEND_MODE_COLOR_DODGE=7,SVG_FEBLEND_MODE_DARKEN=4,SVG_FEBLEND_MODE_DIFFERENCE=11,SVG_FEBLEND_MODE_EXCLUSION=12,SVG_FEBLEND_MODE_HARD_LIGHT=9,SVG_FEBLEND_MODE_HUE=13,SVG_FEBLEND_MODE_LIGHTEN=5,SVG_FEBLEND_MODE_LUMINOSITY=16,SVG_FEBLEND_MODE_MULTIPLY=2,SVG_FEBLEND_MODE_NORMAL=1,SVG_FEBLEND_MODE_OVERLAY=6,SVG_FEBLEND_MODE_SATURATION=14,SVG_FEBLEND_MODE_SCREEN=3,SVG_FEBLEND_MODE_SOFT_LIGHT=10,SVG_FEBLEND_MODE_UNKNOWN=0;SVGFEColorMatrixElement:SVG_FECOLORMATRIX_TYPE_HUEROTATE=3,SVG_FECOLORMATRIX_TYPE_LUMINANCETOALPHA=4,SVG_FECOLORMATRIX_TYPE_MATRIX=1,SVG_FECOLORMATRIX_TYPE_SATURATE=2,SVG_FECOLORMATRIX_TYPE_UNKNOWN=0;SVGFECompositeElement:SVG_FECOMPOSITE_OPERATOR_ARITHMETIC=6,SVG_FECOMPOSITE_OPERATOR_ATOP=4,SVG_FECOMPOSITE_OPERATOR_IN=2,SVG_FECOMPOSITE_OPERATOR_OUT=3,SVG_FECOMPOSITE_OPERATOR_OVER=1,SVG_FECOMPOSITE_OPERATOR_UNKNOWN=0,SVG_FECOMPOSITE_OPERATOR_XOR=5;SVGFEConvolveMatrixElement:SVG_EDGEMODE_DUPLICATE=1,SVG_EDGEMODE_NONE=3,SVG_EDGEMODE_UNKNOWN=0,SVG_EDGEMODE_WRAP=2;SVGFEDisplacementMapElement:SVG_CHANNEL_A=4,SVG_CHANNEL_B=3,SVG_CHANNEL_G=2,SVG_CHANNEL_R=1,SVG_CHANNEL_UNKNOWN=0;SVGFEMorphologyElement:SVG_MORPHOLOGY_OPERATOR_DILATE=2,SVG_MORPHOLOGY_OPERATOR_ERODE=1,SVG_MORPHOLOGY_OPERATOR_UNKNOWN=0;SVGFETurbulenceElement:SVG_STITCHTYPE_NOSTITCH=2,SVG_STITCHTYPE_STITCH=1,SVG_STITCHTYPE_UNKNOWN=0,SVG_TURBULENCE_TYPE_FRACTALNOISE=1,SVG_TURBULENCE_TYPE_TURBULENCE=2,SVG_TURBULENCE_TYPE_UNKNOWN=0;SVGGradientElement:SVG_SPREADMETHOD_PAD=1,SVG_SPREADMETHOD_REFLECT=2,SVG_SPREADMETHOD_REPEAT=3,SVG_SPREADMETHOD_UNKNOWN=0;SVGLength:SVG_LENGTHTYPE_CM=6,SVG_LENGTHTYPE_EMS=3,SVG_LENGTHTYPE_EXS=4,SVG_LENGTHTYPE_IN=8,SVG_LENGTHTYPE_MM=7,SVG_LENGTHTYPE_NUMBER=1,SVG_LENGTHTYPE_PC=10,SVG_LENGTHTYPE_PERCENTAGE=2,SVG_LENGTHTYPE_PT=9,SVG_LENGTHTYPE_PX=5,SVG_LENGTHTYPE_UNKNOWN=0;SVGMarkerElement:SVG_MARKERUNITS_STROKEWIDTH=2,SVG_MARKERUNITS_UNKNOWN=0,SVG_MARKERUNITS_USERSPACEONUSE=1,SVG_MARKER_ORIENT_ANGLE=2,SVG_MARKER_ORIENT_AUTO=1,SVG_MARKER_ORIENT_UNKNOWN=0;SVGPreserveAspectRatio:SVG_MEETORSLICE_MEET=1,SVG_MEETORSLICE_SLICE=2,SVG_MEETORSLICE_UNKNOWN=0,SVG_PRESERVEASPECTRATIO_NONE=1,SVG_PRESERVEASPECTRATIO_UNKNOWN=0,SVG_PRESERVEASPECTRATIO_XMAXYMAX=10,SVG_PRESERVEASPECTRATIO_XMAXYMID=7,SVG_PRESERVEASPECTRATIO_XMAXYMIN=4,SVG_PRESERVEASPECTRATIO_XMIDYMAX=9,SVG_PRESERVEASPECTRATIO_XMIDYMID=6,SVG_PRESERVEASPECTRATIO_XMIDYMIN=3,SVG_PRESERVEASPECTRATIO_XMINYMAX=8,SVG_PRESERVEASPECTRATIO_XMINYMID=5,SVG_PRESERVEASPECTRATIO_XMINYMIN=2;SVGSVGElement:SVG_ZOOMANDPAN_DISABLE=1,SVG_ZOOMANDPAN_MAGNIFY=2,SVG_ZOOMANDPAN_UNKNOWN=0;SVGTextContentElement:LENGTHADJUST_SPACING=1,LENGTHADJUST_SPACINGANDGLYPHS=2,LENGTHADJUST_UNKNOWN=0;SVGTextPathElement:TEXTPATH_METHODTYPE_ALIGN=1,TEXTPATH_METHODTYPE_STRETCH=2,TEXTPATH_METHODTYPE_UNKNOWN=0,TEXTPATH_SPACINGTYPE_AUTO=1,TEXTPATH_SPACINGTYPE_EXACT=2,TEXTPATH_SPACINGTYPE_UNKNOWN=0;SVGTransform:SVG_TRANSFORM_MATRIX=1,SVG_TRANSFORM_ROTATE=4,SVG_TRANSFORM_SCALE=3,SVG_TRANSFORM_SKEWX=5,SVG_TRANSFORM_SKEWY=6,SVG_TRANSFORM_TRANSLATE=2,SVG_TRANSFORM_UNKNOWN=0;SVGUnitTypes:SVG_UNIT_TYPE_OBJECTBOUNDINGBOX=2,SVG_UNIT_TYPE_UNKNOWN=0,SVG_UNIT_TYPE_USERSPACEONUSE=1;SVGViewElement:SVG_ZOOMANDPAN_DISABLE=1,SVG_ZOOMANDPAN_MAGNIFY=2,SVG_ZOOMANDPAN_UNKNOWN=0;WebGL2RenderingContext:ACTIVE_ATTRIBUTES=35721,ACTIVE_TEXTURE=34016,ACTIVE_UNIFORMS=35718,ACTIVE_UNIFORM_BLOCKS=35382,ALIASED_LINE_WIDTH_RANGE=33902,ALIASED_POINT_SIZE_RANGE=33901,ALPHA=6406,ALPHA_BITS=3413,ALREADY_SIGNALED=37146,ALWAYS=519,ANY_SAMPLES_PASSED=35887,ANY_SAMPLES_PASSED_CONSERVATIVE=36202,ARRAY_BUFFER=34962,ARRAY_BUFFER_BINDING=34964,ATTACHED_SHADERS=35717,BACK=1029,BLEND=3042,BLEND_COLOR=32773,BLEND_DST_ALPHA=32970,BLEND_DST_RGB=32968,BLEND_EQUATION=32777,BLEND_EQUATION_ALPHA=34877,BLEND_EQUATION_RGB=32777,BLEND_SRC_ALPHA=32971,BLEND_SRC_RGB=32969,BLUE_BITS=3412,BOOL=35670,BOOL_VEC2=35671,BOOL_VEC3=35672,BOOL_VEC4=35673,BROWSER_DEFAULT_WEBGL=37444,BUFFER_SIZE=34660,BUFFER_USAGE=34661,BYTE=5120,CCW=2305,CLAMP_TO_EDGE=33071,COLOR=6144,COLOR_ATTACHMENT0=36064,COLOR_ATTACHMENT1=36065,COLOR_ATTACHMENT10=36074,COLOR_ATTACHMENT11=36075,COLOR_ATTACHMENT12=36076,COLOR_ATTACHMENT13=36077,COLOR_ATTACHMENT14=36078,COLOR_ATTACHMENT15=36079,COLOR_ATTACHMENT2=36066,COLOR_ATTACHMENT3=36067,COLOR_ATTACHMENT4=36068,COLOR_ATTACHMENT5=36069,COLOR_ATTACHMENT6=36070,COLOR_ATTACHMENT7=36071,COLOR_ATTACHMENT8=36072,COLOR_ATTACHMENT9=36073,COLOR_BUFFER_BIT=16384,COLOR_CLEAR_VALUE=3106,COLOR_WRITEMASK=3107,COMPARE_REF_TO_TEXTURE=34894,COMPILE_STATUS=35713,COMPRESSED_TEXTURE_FORMATS=34467,CONDITION_SATISFIED=37148,CONSTANT_ALPHA=32771,CONSTANT_COLOR=32769,CONTEXT_LOST_WEBGL=37442,COPY_READ_BUFFER=36662,COPY_READ_BUFFER_BINDING=36662,COPY_WRITE_BUFFER=36663,COPY_WRITE_BUFFER_BINDING=36663,CULL_FACE=2884,CULL_FACE_MODE=2885,CURRENT_PROGRAM=35725,CURRENT_QUERY=34917,CURRENT_VERTEX_ATTRIB=34342,CW=2304,DECR=7683,DECR_WRAP=34056,DELETE_STATUS=35712,DEPTH=6145,DEPTH24_STENCIL8=35056,DEPTH32F_STENCIL8=36013,DEPTH_ATTACHMENT=36096,DEPTH_BITS=3414,DEPTH_BUFFER_BIT=256,DEPTH_CLEAR_VALUE=2931,DEPTH_COMPONENT=6402,DEPTH_COMPONENT16=33189,DEPTH_COMPONENT24=33190,DEPTH_COMPONENT32F=36012,DEPTH_FUNC=2932,DEPTH_RANGE=2928,DEPTH_STENCIL=34041,DEPTH_STENCIL_ATTACHMENT=33306,DEPTH_TEST=2929,DEPTH_WRITEMASK=2930,DITHER=3024,DONT_CARE=4352,DRAW_BUFFER0=34853,DRAW_BUFFER1=34854,DRAW_BUFFER10=34863,DRAW_BUFFER11=34864,DRAW_BUFFER12=34865,DRAW_BUFFER13=34866,DRAW_BUFFER14=34867,DRAW_BUFFER15=34868,DRAW_BUFFER2=34855,DRAW_BUFFER3=34856,DRAW_BUFFER4=34857,DRAW_BUFFER5=34858,DRAW_BUFFER6=34859,DRAW_BUFFER7=34860,DRAW_BUFFER8=34861,DRAW_BUFFER9=34862,DRAW_FRAMEBUFFER=36009,DRAW_FRAMEBUFFER_BINDING=36006,DST_ALPHA=772,DST_COLOR=774,DYNAMIC_COPY=35050,DYNAMIC_DRAW=35048,DYNAMIC_READ=35049,ELEMENT_ARRAY_BUFFER=34963,ELEMENT_ARRAY_BUFFER_BINDING=34965,EQUAL=514,FASTEST=4353,FLOAT=5126,FLOAT_32_UNSIGNED_INT_24_8_REV=36269,FLOAT_MAT2=35674,FLOAT_MAT3=35675,FLOAT_MAT4=35676,FLOAT_VEC2=35664,FLOAT_VEC3=35665,FLOAT_VEC4=35666,FRAGMENT_SHADER=35632,FRAGMENT_SHADER_DERIVATIVE_HINT=35723,FRAMEBUFFER=36160,FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE=33301,FRAMEBUFFER_ATTACHMENT_BLUE_SIZE=33300,FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING=33296,FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE=33297,FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE=33302,FRAMEBUFFER_ATTACHMENT_GREEN_SIZE=33299,FRAMEBUFFER_ATTACHMENT_OBJECT_NAME=36049,FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE=36048,FRAMEBUFFER_ATTACHMENT_RED_SIZE=33298,FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE=33303,FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE=36051,FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER=36052,FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL=36050,FRAMEBUFFER_BINDING=36006,FRAMEBUFFER_COMPLETE=36053,FRAMEBUFFER_DEFAULT=33304,FRAMEBUFFER_INCOMPLETE_ATTACHMENT=36054,FRAMEBUFFER_INCOMPLETE_DIMENSIONS=36057,FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT=36055,FRAMEBUFFER_INCOMPLETE_MULTISAMPLE=36182,FRAMEBUFFER_UNSUPPORTED=36061,FRONT=1028,FRONT_AND_BACK=1032,FRONT_FACE=2886,FUNC_ADD=32774,FUNC_REVERSE_SUBTRACT=32779,FUNC_SUBTRACT=32778,GENERATE_MIPMAP_HINT=33170,GEQUAL=518,GREATER=516,GREEN_BITS=3411,HALF_FLOAT=5131,HIGH_FLOAT=36338,HIGH_INT=36341,IMPLEMENTATION_COLOR_READ_FORMAT=35739,IMPLEMENTATION_COLOR_READ_TYPE=35738,INCR=7682,INCR_WRAP=34055,INT=5124,INTERLEAVED_ATTRIBS=35980,INT_2_10_10_10_REV=36255,INT_SAMPLER_2D=36298,INT_SAMPLER_2D_ARRAY=36303,INT_SAMPLER_3D=36299,INT_SAMPLER_CUBE=36300,INT_VEC2=35667,INT_VEC3=35668,INT_VEC4=35669,INVALID_ENUM=1280,INVALID_FRAMEBUFFER_OPERATION=1286,INVALID_INDEX=4294967295,INVALID_OPERATION=1282,INVALID_VALUE=1281,INVERT=5386,KEEP=7680,LEQUAL=515,LESS=513,LINEAR=9729,LINEAR_MIPMAP_LINEAR=9987,LINEAR_MIPMAP_NEAREST=9985,LINES=1,LINE_LOOP=2,LINE_STRIP=3,LINE_WIDTH=2849,LINK_STATUS=35714,LOW_FLOAT=36336,LOW_INT=36339,LUMINANCE=6409,LUMINANCE_ALPHA=6410,MAX=32776,MAX_3D_TEXTURE_SIZE=32883,MAX_ARRAY_TEXTURE_LAYERS=35071,MAX_CLIENT_WAIT_TIMEOUT_WEBGL=37447,MAX_COLOR_ATTACHMENTS=36063,MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS=35379,MAX_COMBINED_TEXTURE_IMAGE_UNITS=35661,MAX_COMBINED_UNIFORM_BLOCKS=35374,MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS=35377,MAX_CUBE_MAP_TEXTURE_SIZE=34076,MAX_DRAW_BUFFERS=34852,MAX_ELEMENTS_INDICES=33001,MAX_ELEMENTS_VERTICES=33000,MAX_ELEMENT_INDEX=36203,MAX_FRAGMENT_INPUT_COMPONENTS=37157,MAX_FRAGMENT_UNIFORM_BLOCKS=35373,MAX_FRAGMENT_UNIFORM_COMPONENTS=35657,MAX_FRAGMENT_UNIFORM_VECTORS=36349,MAX_PROGRAM_TEXEL_OFFSET=35077,MAX_RENDERBUFFER_SIZE=34024,MAX_SAMPLES=36183,MAX_SERVER_WAIT_TIMEOUT=37137,MAX_TEXTURE_IMAGE_UNITS=34930,MAX_TEXTURE_LOD_BIAS=34045,MAX_TEXTURE_SIZE=3379,MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS=35978,MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS=35979,MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS=35968,MAX_UNIFORM_BLOCK_SIZE=35376,MAX_UNIFORM_BUFFER_BINDINGS=35375,MAX_VARYING_COMPONENTS=35659,MAX_VARYING_VECTORS=36348,MAX_VERTEX_ATTRIBS=34921,MAX_VERTEX_OUTPUT_COMPONENTS=37154,MAX_VERTEX_TEXTURE_IMAGE_UNITS=35660,MAX_VERTEX_UNIFORM_BLOCKS=35371,MAX_VERTEX_UNIFORM_COMPONENTS=35658,MAX_VERTEX_UNIFORM_VECTORS=36347,MAX_VIEWPORT_DIMS=3386,MEDIUM_FLOAT=36337,MEDIUM_INT=36340,MIN=32775,MIN_PROGRAM_TEXEL_OFFSET=35076,MIRRORED_REPEAT=33648,NEAREST=9728,NEAREST_MIPMAP_LINEAR=9986,NEAREST_MIPMAP_NEAREST=9984,NEVER=512,NICEST=4354,NONE=0,NOTEQUAL=517,NO_ERROR=0,OBJECT_TYPE=37138,ONE=1,ONE_MINUS_CONSTANT_ALPHA=32772,ONE_MINUS_CONSTANT_COLOR=32770,ONE_MINUS_DST_ALPHA=773,ONE_MINUS_DST_COLOR=775,ONE_MINUS_SRC_ALPHA=771,ONE_MINUS_SRC_COLOR=769,OUT_OF_MEMORY=1285,PACK_ALIGNMENT=3333,PACK_ROW_LENGTH=3330,PACK_SKIP_PIXELS=3332,PACK_SKIP_ROWS=3331,PIXEL_PACK_BUFFER=35051,PIXEL_PACK_BUFFER_BINDING=35053,PIXEL_UNPACK_BUFFER=35052,PIXEL_UNPACK_BUFFER_BINDING=35055,POINTS=0,POLYGON_OFFSET_FACTOR=32824,POLYGON_OFFSET_FILL=32823,POLYGON_OFFSET_UNITS=10752,QUERY_RESULT=34918,QUERY_RESULT_AVAILABLE=34919,R11F_G11F_B10F=35898,R16F=33325,R16I=33331,R16UI=33332,R32F=33326,R32I=33333,R32UI=33334,R8=33321,R8I=33329,R8UI=33330,R8_SNORM=36756,RASTERIZER_DISCARD=35977,READ_BUFFER=3074,READ_FRAMEBUFFER=36008,READ_FRAMEBUFFER_BINDING=36010,RED=6403,RED_BITS=3410,RED_INTEGER=36244,RENDERBUFFER=36161,RENDERBUFFER_ALPHA_SIZE=36179,RENDERBUFFER_BINDING=36007,RENDERBUFFER_BLUE_SIZE=36178,RENDERBUFFER_DEPTH_SIZE=36180,RENDERBUFFER_GREEN_SIZE=36177,RENDERBUFFER_HEIGHT=36163,RENDERBUFFER_INTERNAL_FORMAT=36164,RENDERBUFFER_RED_SIZE=36176,RENDERBUFFER_SAMPLES=36011,RENDERBUFFER_STENCIL_SIZE=36181,RENDERBUFFER_WIDTH=36162,RENDERER=7937,REPEAT=10497,REPLACE=7681,RG=33319,RG16F=33327,RG16I=33337,RG16UI=33338,RG32F=33328,RG32I=33339,RG32UI=33340,RG8=33323,RG8I=33335,RG8UI=33336,RG8_SNORM=36757,RGB=6407,RGB10_A2=32857,RGB10_A2UI=36975,RGB16F=34843,RGB16I=36233,RGB16UI=36215,RGB32F=34837,RGB32I=36227,RGB32UI=36209,RGB565=36194,RGB5_A1=32855,RGB8=32849,RGB8I=36239,RGB8UI=36221,RGB8_SNORM=36758,RGB9_E5=35901,RGBA=6408,RGBA16F=34842,RGBA16I=36232,RGBA16UI=36214,RGBA32F=34836,RGBA32I=36226,RGBA32UI=36208,RGBA4=32854,RGBA8=32856,RGBA8I=36238,RGBA8UI=36220,RGBA8_SNORM=36759,RGBA_INTEGER=36249,RGB_INTEGER=36248,RG_INTEGER=33320,SAMPLER_2D=35678,SAMPLER_2D_ARRAY=36289,SAMPLER_2D_ARRAY_SHADOW=36292,SAMPLER_2D_SHADOW=35682,SAMPLER_3D=35679,SAMPLER_BINDING=35097,SAMPLER_CUBE=35680,SAMPLER_CUBE_SHADOW=36293,SAMPLES=32937,SAMPLE_ALPHA_TO_COVERAGE=32926,SAMPLE_BUFFERS=32936,SAMPLE_COVERAGE=32928,SAMPLE_COVERAGE_INVERT=32939,SAMPLE_COVERAGE_VALUE=32938,SCISSOR_BOX=3088,SCISSOR_TEST=3089,SEPARATE_ATTRIBS=35981,SHADER_TYPE=35663,SHADING_LANGUAGE_VERSION=35724,SHORT=5122,SIGNALED=37145,SIGNED_NORMALIZED=36764,SRC_ALPHA=770,SRC_ALPHA_SATURATE=776,SRC_COLOR=768,SRGB=35904,SRGB8=35905,SRGB8_ALPHA8=35907,STATIC_COPY=35046,STATIC_DRAW=35044,STATIC_READ=35045,STENCIL=6146,STENCIL_ATTACHMENT=36128,STENCIL_BACK_FAIL=34817,STENCIL_BACK_FUNC=34816,STENCIL_BACK_PASS_DEPTH_FAIL=34818,STENCIL_BACK_PASS_DEPTH_PASS=34819,STENCIL_BACK_REF=36003,STENCIL_BACK_VALUE_MASK=36004,STENCIL_BACK_WRITEMASK=36005,STENCIL_BITS=3415,STENCIL_BUFFER_BIT=1024,STENCIL_CLEAR_VALUE=2961,STENCIL_FAIL=2964,STENCIL_FUNC=2962,STENCIL_INDEX8=36168,STENCIL_PASS_DEPTH_FAIL=2965,STENCIL_PASS_DEPTH_PASS=2966,STENCIL_REF=2967,STENCIL_TEST=2960,STENCIL_VALUE_MASK=2963,STENCIL_WRITEMASK=2968,STREAM_COPY=35042,STREAM_DRAW=35040,STREAM_READ=35041,SUBPIXEL_BITS=3408,SYNC_CONDITION=37139,SYNC_FENCE=37142,SYNC_FLAGS=37141,SYNC_FLUSH_COMMANDS_BIT=1,SYNC_GPU_COMMANDS_COMPLETE=37143,SYNC_STATUS=37140,TEXTURE=5890,TEXTURE0=33984,TEXTURE1=33985,TEXTURE10=33994,TEXTURE11=33995,TEXTURE12=33996,TEXTURE13=33997,TEXTURE14=33998,TEXTURE15=33999,TEXTURE16=34000,TEXTURE17=34001,TEXTURE18=34002,TEXTURE19=34003,TEXTURE2=33986,TEXTURE20=34004,TEXTURE21=34005,TEXTURE22=34006,TEXTURE23=34007,TEXTURE24=34008,TEXTURE25=34009,TEXTURE26=34010,TEXTURE27=34011,TEXTURE28=34012,TEXTURE29=34013,TEXTURE3=33987,TEXTURE30=34014,TEXTURE31=34015,TEXTURE4=33988,TEXTURE5=33989,TEXTURE6=33990,TEXTURE7=33991,TEXTURE8=33992,TEXTURE9=33993,TEXTURE_2D=3553,TEXTURE_2D_ARRAY=35866,TEXTURE_3D=32879,TEXTURE_BASE_LEVEL=33084,TEXTURE_BINDING_2D=32873,TEXTURE_BINDING_2D_ARRAY=35869,TEXTURE_BINDING_3D=32874,TEXTURE_BINDING_CUBE_MAP=34068,TEXTURE_COMPARE_FUNC=34893,TEXTURE_COMPARE_MODE=34892,TEXTURE_CUBE_MAP=34067,TEXTURE_CUBE_MAP_NEGATIVE_X=34070,TEXTURE_CUBE_MAP_NEGATIVE_Y=34072,TEXTURE_CUBE_MAP_NEGATIVE_Z=34074,TEXTURE_CUBE_MAP_POSITIVE_X=34069,TEXTURE_CUBE_MAP_POSITIVE_Y=34071,TEXTURE_CUBE_MAP_POSITIVE_Z=34073,TEXTURE_IMMUTABLE_FORMAT=37167,TEXTURE_IMMUTABLE_LEVELS=33503,TEXTURE_MAG_FILTER=10240,TEXTURE_MAX_LEVEL=33085,TEXTURE_MAX_LOD=33083,TEXTURE_MIN_FILTER=10241,TEXTURE_MIN_LOD=33082,TEXTURE_WRAP_R=32882,TEXTURE_WRAP_S=10242,TEXTURE_WRAP_T=10243,TIMEOUT_EXPIRED=37147,TIMEOUT_IGNORED=-1,TRANSFORM_FEEDBACK=36386,TRANSFORM_FEEDBACK_ACTIVE=36388,TRANSFORM_FEEDBACK_BINDING=36389,TRANSFORM_FEEDBACK_BUFFER=35982,TRANSFORM_FEEDBACK_BUFFER_BINDING=35983,TRANSFORM_FEEDBACK_BUFFER_MODE=35967,TRANSFORM_FEEDBACK_BUFFER_SIZE=35973,TRANSFORM_FEEDBACK_BUFFER_START=35972,TRANSFORM_FEEDBACK_PAUSED=36387,TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN=35976,TRANSFORM_FEEDBACK_VARYINGS=35971,TRIANGLES=4,TRIANGLE_FAN=6,TRIANGLE_STRIP=5,UNIFORM_ARRAY_STRIDE=35388,UNIFORM_BLOCK_ACTIVE_UNIFORMS=35394,UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES=35395,UNIFORM_BLOCK_BINDING=35391,UNIFORM_BLOCK_DATA_SIZE=35392,UNIFORM_BLOCK_INDEX=35386,UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER=35398,UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER=35396,UNIFORM_BUFFER=35345,UNIFORM_BUFFER_BINDING=35368,UNIFORM_BUFFER_OFFSET_ALIGNMENT=35380,UNIFORM_BUFFER_SIZE=35370,UNIFORM_BUFFER_START=35369,UNIFORM_IS_ROW_MAJOR=35390,UNIFORM_MATRIX_STRIDE=35389,UNIFORM_OFFSET=35387,UNIFORM_SIZE=35384,UNIFORM_TYPE=35383,UNPACK_ALIGNMENT=3317,UNPACK_COLORSPACE_CONVERSION_WEBGL=37443,UNPACK_FLIP_Y_WEBGL=37440,UNPACK_IMAGE_HEIGHT=32878,UNPACK_PREMULTIPLY_ALPHA_WEBGL=37441,UNPACK_ROW_LENGTH=3314,UNPACK_SKIP_IMAGES=32877,UNPACK_SKIP_PIXELS=3316,UNPACK_SKIP_ROWS=3315,UNSIGNALED=37144,UNSIGNED_BYTE=5121,UNSIGNED_INT=5125,UNSIGNED_INT_10F_11F_11F_REV=35899,UNSIGNED_INT_24_8=34042,UNSIGNED_INT_2_10_10_10_REV=33640,UNSIGNED_INT_5_9_9_9_REV=35902,UNSIGNED_INT_SAMPLER_2D=36306,UNSIGNED_INT_SAMPLER_2D_ARRAY=36311,UNSIGNED_INT_SAMPLER_3D=36307,UNSIGNED_INT_SAMPLER_CUBE=36308,UNSIGNED_INT_VEC2=36294,UNSIGNED_INT_VEC3=36295,UNSIGNED_INT_VEC4=36296,UNSIGNED_NORMALIZED=35863,UNSIGNED_SHORT=5123,UNSIGNED_SHORT_4_4_4_4=32819,UNSIGNED_SHORT_5_5_5_1=32820,UNSIGNED_SHORT_5_6_5=33635,VALIDATE_STATUS=35715,VENDOR=7936,VERSION=7938,VERTEX_ARRAY_BINDING=34229,VERTEX_ATTRIB_ARRAY_BUFFER_BINDING=34975,VERTEX_ATTRIB_ARRAY_DIVISOR=35070,VERTEX_ATTRIB_ARRAY_ENABLED=34338,VERTEX_ATTRIB_ARRAY_INTEGER=35069,VERTEX_ATTRIB_ARRAY_NORMALIZED=34922,VERTEX_ATTRIB_ARRAY_POINTER=34373,VERTEX_ATTRIB_ARRAY_SIZE=34339,VERTEX_ATTRIB_ARRAY_STRIDE=34340,VERTEX_ATTRIB_ARRAY_TYPE=34341,VERTEX_SHADER=35633,VIEWPORT=2978,WAIT_FAILED=37149,ZERO=0;WebGLRenderingContext:ACTIVE_ATTRIBUTES=35721,ACTIVE_TEXTURE=34016,ACTIVE_UNIFORMS=35718,ALIASED_LINE_WIDTH_RANGE=33902,ALIASED_POINT_SIZE_RANGE=33901,ALPHA=6406,ALPHA_BITS=3413,ALWAYS=519,ARRAY_BUFFER=34962,ARRAY_BUFFER_BINDING=34964,ATTACHED_SHADERS=35717,BACK=1029,BLEND=3042,BLEND_COLOR=32773,BLEND_DST_ALPHA=32970,BLEND_DST_RGB=32968,BLEND_EQUATION=32777,BLEND_EQUATION_ALPHA=34877,BLEND_EQUATION_RGB=32777,BLEND_SRC_ALPHA=32971,BLEND_SRC_RGB=32969,BLUE_BITS=3412,BOOL=35670,BOOL_VEC2=35671,BOOL_VEC3=35672,BOOL_VEC4=35673,BROWSER_DEFAULT_WEBGL=37444,BUFFER_SIZE=34660,BUFFER_USAGE=34661,BYTE=5120,CCW=2305,CLAMP_TO_EDGE=33071,COLOR_ATTACHMENT0=36064,COLOR_BUFFER_BIT=16384,COLOR_CLEAR_VALUE=3106,COLOR_WRITEMASK=3107,COMPILE_STATUS=35713,COMPRESSED_TEXTURE_FORMATS=34467,CONSTANT_ALPHA=32771,CONSTANT_COLOR=32769,CONTEXT_LOST_WEBGL=37442,CULL_FACE=2884,CULL_FACE_MODE=2885,CURRENT_PROGRAM=35725,CURRENT_VERTEX_ATTRIB=34342,CW=2304,DECR=7683,DECR_WRAP=34056,DELETE_STATUS=35712,DEPTH_ATTACHMENT=36096,DEPTH_BITS=3414,DEPTH_BUFFER_BIT=256,DEPTH_CLEAR_VALUE=2931,DEPTH_COMPONENT=6402,DEPTH_COMPONENT16=33189,DEPTH_FUNC=2932,DEPTH_RANGE=2928,DEPTH_STENCIL=34041,DEPTH_STENCIL_ATTACHMENT=33306,DEPTH_TEST=2929,DEPTH_WRITEMASK=2930,DITHER=3024,DONT_CARE=4352,DST_ALPHA=772,DST_COLOR=774,DYNAMIC_DRAW=35048,ELEMENT_ARRAY_BUFFER=34963,ELEMENT_ARRAY_BUFFER_BINDING=34965,EQUAL=514,FASTEST=4353,FLOAT=5126,FLOAT_MAT2=35674,FLOAT_MAT3=35675,FLOAT_MAT4=35676,FLOAT_VEC2=35664,FLOAT_VEC3=35665,FLOAT_VEC4=35666,FRAGMENT_SHADER=35632,FRAMEBUFFER=36160,FRAMEBUFFER_ATTACHMENT_OBJECT_NAME=36049,FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE=36048,FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE=36051,FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL=36050,FRAMEBUFFER_BINDING=36006,FRAMEBUFFER_COMPLETE=36053,FRAMEBUFFER_INCOMPLETE_ATTACHMENT=36054,FRAMEBUFFER_INCOMPLETE_DIMENSIONS=36057,FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT=36055,FRAMEBUFFER_UNSUPPORTED=36061,FRONT=1028,FRONT_AND_BACK=1032,FRONT_FACE=2886,FUNC_ADD=32774,FUNC_REVERSE_SUBTRACT=32779,FUNC_SUBTRACT=32778,GENERATE_MIPMAP_HINT=33170,GEQUAL=518,GREATER=516,GREEN_BITS=3411,HIGH_FLOAT=36338,HIGH_INT=36341,IMPLEMENTATION_COLOR_READ_FORMAT=35739,IMPLEMENTATION_COLOR_READ_TYPE=35738,INCR=7682,INCR_WRAP=34055,INT=5124,INT_VEC2=35667,INT_VEC3=35668,INT_VEC4=35669,INVALID_ENUM=1280,INVALID_FRAMEBUFFER_OPERATION=1286,INVALID_OPERATION=1282,INVALID_VALUE=1281,INVERT=5386,KEEP=7680,LEQUAL=515,LESS=513,LINEAR=9729,LINEAR_MIPMAP_LINEAR=9987,LINEAR_MIPMAP_NEAREST=9985,LINES=1,LINE_LOOP=2,LINE_STRIP=3,LINE_WIDTH=2849,LINK_STATUS=35714,LOW_FLOAT=36336,LOW_INT=36339,LUMINANCE=6409,LUMINANCE_ALPHA=6410,MAX_COMBINED_TEXTURE_IMAGE_UNITS=35661,MAX_CUBE_MAP_TEXTURE_SIZE=34076,MAX_FRAGMENT_UNIFORM_VECTORS=36349,MAX_RENDERBUFFER_SIZE=34024,MAX_TEXTURE_IMAGE_UNITS=34930,MAX_TEXTURE_SIZE=3379,MAX_VARYING_VECTORS=36348,MAX_VERTEX_ATTRIBS=34921,MAX_VERTEX_TEXTURE_IMAGE_UNITS=35660,MAX_VERTEX_UNIFORM_VECTORS=36347,MAX_VIEWPORT_DIMS=3386,MEDIUM_FLOAT=36337,MEDIUM_INT=36340,MIRRORED_REPEAT=33648,NEAREST=9728,NEAREST_MIPMAP_LINEAR=9986,NEAREST_MIPMAP_NEAREST=9984,NEVER=512,NICEST=4354,NONE=0,NOTEQUAL=517,NO_ERROR=0,ONE=1,ONE_MINUS_CONSTANT_ALPHA=32772,ONE_MINUS_CONSTANT_COLOR=32770,ONE_MINUS_DST_ALPHA=773,ONE_MINUS_DST_COLOR=775,ONE_MINUS_SRC_ALPHA=771,ONE_MINUS_SRC_COLOR=769,OUT_OF_MEMORY=1285,PACK_ALIGNMENT=3333,POINTS=0,POLYGON_OFFSET_FACTOR=32824,POLYGON_OFFSET_FILL=32823,POLYGON_OFFSET_UNITS=10752,RED_BITS=3410,RENDERBUFFER=36161,RENDERBUFFER_ALPHA_SIZE=36179,RENDERBUFFER_BINDING=36007,RENDERBUFFER_BLUE_SIZE=36178,RENDERBUFFER_DEPTH_SIZE=36180,RENDERBUFFER_GREEN_SIZE=36177,RENDERBUFFER_HEIGHT=36163,RENDERBUFFER_INTERNAL_FORMAT=36164,RENDERBUFFER_RED_SIZE=36176,RENDERBUFFER_STENCIL_SIZE=36181,RENDERBUFFER_WIDTH=36162,RENDERER=7937,REPEAT=10497,REPLACE=7681,RGB=6407,RGB565=36194,RGB5_A1=32855,RGB8=32849,RGBA=6408,RGBA4=32854,RGBA8=32856,SAMPLER_2D=35678,SAMPLER_CUBE=35680,SAMPLES=32937,SAMPLE_ALPHA_TO_COVERAGE=32926,SAMPLE_BUFFERS=32936,SAMPLE_COVERAGE=32928,SAMPLE_COVERAGE_INVERT=32939,SAMPLE_COVERAGE_VALUE=32938,SCISSOR_BOX=3088,SCISSOR_TEST=3089,SHADER_TYPE=35663,SHADING_LANGUAGE_VERSION=35724,SHORT=5122,SRC_ALPHA=770,SRC_ALPHA_SATURATE=776,SRC_COLOR=768,STATIC_DRAW=35044,STENCIL_ATTACHMENT=36128,STENCIL_BACK_FAIL=34817,STENCIL_BACK_FUNC=34816,STENCIL_BACK_PASS_DEPTH_FAIL=34818,STENCIL_BACK_PASS_DEPTH_PASS=34819,STENCIL_BACK_REF=36003,STENCIL_BACK_VALUE_MASK=36004,STENCIL_BACK_WRITEMASK=36005,STENCIL_BITS=3415,STENCIL_BUFFER_BIT=1024,STENCIL_CLEAR_VALUE=2961,STENCIL_FAIL=2964,STENCIL_FUNC=2962,STENCIL_INDEX8=36168,STENCIL_PASS_DEPTH_FAIL=2965,STENCIL_PASS_DEPTH_PASS=2966,STENCIL_REF=2967,STENCIL_TEST=2960,STENCIL_VALUE_MASK=2963,STENCIL_WRITEMASK=2968,STREAM_DRAW=35040,SUBPIXEL_BITS=3408,TEXTURE=5890,TEXTURE0=33984,TEXTURE1=33985,TEXTURE10=33994,TEXTURE11=33995,TEXTURE12=33996,TEXTURE13=33997,TEXTURE14=33998,TEXTURE15=33999,TEXTURE16=34000,TEXTURE17=34001,TEXTURE18=34002,TEXTURE19=34003,TEXTURE2=33986,TEXTURE20=34004,TEXTURE21=34005,TEXTURE22=34006,TEXTURE23=34007,TEXTURE24=34008,TEXTURE25=34009,TEXTURE26=34010,TEXTURE27=34011,TEXTURE28=34012,TEXTURE29=34013,TEXTURE3=33987,TEXTURE30=34014,TEXTURE31=34015,TEXTURE4=33988,TEXTURE5=33989,TEXTURE6=33990,TEXTURE7=33991,TEXTURE8=33992,TEXTURE9=33993,TEXTURE_2D=3553,TEXTURE_BINDING_2D=32873,TEXTURE_BINDING_CUBE_MAP=34068,TEXTURE_CUBE_MAP=34067,TEXTURE_CUBE_MAP_NEGATIVE_X=34070,TEXTURE_CUBE_MAP_NEGATIVE_Y=34072,TEXTURE_CUBE_MAP_NEGATIVE_Z=34074,TEXTURE_CUBE_MAP_POSITIVE_X=34069,TEXTURE_CUBE_MAP_POSITIVE_Y=34071,TEXTURE_CUBE_MAP_POSITIVE_Z=34073,TEXTURE_MAG_FILTER=10240,TEXTURE_MIN_FILTER=10241,TEXTURE_WRAP_S=10242,TEXTURE_WRAP_T=10243,TRIANGLES=4,TRIANGLE_FAN=6,TRIANGLE_STRIP=5,UNPACK_ALIGNMENT=3317,UNPACK_COLORSPACE_CONVERSION_WEBGL=37443,UNPACK_FLIP_Y_WEBGL=37440,UNPACK_PREMULTIPLY_ALPHA_WEBGL=37441,UNSIGNED_BYTE=5121,UNSIGNED_INT=5125,UNSIGNED_SHORT=5123,UNSIGNED_SHORT_4_4_4_4=32819,UNSIGNED_SHORT_5_5_5_1=32820,UNSIGNED_SHORT_5_6_5=33635,VALIDATE_STATUS=35715,VENDOR=7936,VERSION=7938,VERTEX_ATTRIB_ARRAY_BUFFER_BINDING=34975,VERTEX_ATTRIB_ARRAY_ENABLED=34338,VERTEX_ATTRIB_ARRAY_NORMALIZED=34922,VERTEX_ATTRIB_ARRAY_POINTER=34373,VERTEX_ATTRIB_ARRAY_SIZE=34339,VERTEX_ATTRIB_ARRAY_STRIDE=34340,VERTEX_ATTRIB_ARRAY_TYPE=34341,VERTEX_SHADER=35633,VIEWPORT=2978,ZERO=0;WebSocket:CLOSED=3,CLOSING=2,CONNECTING=0,OPEN=1;WheelEvent:DOM_DELTA_LINE=1,DOM_DELTA_PAGE=2,DOM_DELTA_PIXEL=0;XMLHttpRequest:DONE=4,HEADERS_RECEIVED=2,LOADING=3,OPENED=1,UNSENT=0;XPathResult:ANY_TYPE=0,ANY_UNORDERED_NODE_TYPE=8,BOOLEAN_TYPE=3,FIRST_ORDERED_NODE_TYPE=9,NUMBER_TYPE=1,ORDERED_NODE_ITERATOR_TYPE=5,ORDERED_NODE_SNAPSHOT_TYPE=7,STRING_TYPE=2,UNORDERED_NODE_ITERATOR_TYPE=4,UNORDERED_NODE_SNAPSHOT_TYPE=6';
        const IDL_HANDLERS = 'AbortSignal:onabort;Animation:oncancel,onfinish,onremove;AudioContext:onerror,onsinkchange;AudioDecoder:ondequeue;AudioEncoder:ondequeue;AudioScheduledSourceNode:onended;AudioWorkletNode:onprocessorerror;BackgroundFetchRegistration:onprogress;BaseAudioContext:onstatechange;BluetoothDevice:ongattserverdisconnected;BluetoothRemoteGATTCharacteristic:oncharacteristicvaluechanged;BroadcastChannel:onmessage,onmessageerror;CaptureController:onzoomlevelchange;Clipboard:onclipboardchange;CloseWatcher:oncancel,onclose;CookieStore:onchange;CreateMonitor:ondownloadprogress;DevicePosture:onchange;Document:onbeforecopy,onbeforecut,onbeforepaste,onbeforexrselect,oncopy,oncut,onpaste,onwebkitfullscreenchange,onwebkitfullscreenerror;DocumentPictureInPicture:onenter;EditContext:oncharacterboundsupdate,oncompositionend,oncompositionstart,ontextformatupdate,ontextupdate;Element:onbeforecopy,onbeforecut,onbeforepaste,onfullscreenchange,onfullscreenerror,onsearch,onwebkitfullscreenchange,onwebkitfullscreenerror;EventSource:onerror,onmessage,onopen;FileReader:onabort,onerror,onload,onloadend,onloadstart,onprogress;HIDDevice:oninputreport;HTMLBodyElement:onafterprint,onbeforeprint,onbeforeunload,onblur,onerror,onfocus,ongamepadconnected,ongamepaddisconnected,onhashchange,onlanguagechange,onload,onmessage,onmessageerror,onoffline,ononline,onpagehide,onpageshow,onpopstate,onrejectionhandled,onresize,onscroll,onstorage,onunhandledrejection,onunload;HTMLElement:onbeforexrselect,oncopy,oncut,onpaste;HTMLFrameSetElement:onafterprint,onbeforeprint,onbeforeunload,onblur,onerror,onfocus,ongamepadconnected,ongamepaddisconnected,onhashchange,onlanguagechange,onload,onmessage,onmessageerror,onoffline,ononline,onpagehide,onpageshow,onpopstate,onrejectionhandled,onresize,onscroll,onstorage,onunhandledrejection,onunload;HTMLGeolocationElement:onlocation,onpromptaction,onpromptdismiss,onvalidationstatuschange;HTMLMediaElement:onencrypted,onwaitingforkey;HTMLVideoElement:onenterpictureinpicture,onleavepictureinpicture;IDBDatabase:onabort,onclose,onerror,onversionchange;IDBOpenDBRequest:onblocked,onupgradeneeded;IDBRequest:onerror,onsuccess;IDBTransaction:onabort,oncomplete,onerror;IdleDetector:onchange;LanguageModel:oncontextoverflow;MIDIAccess:onstatechange;MIDIInput:onmidimessage;MIDIPort:onstatechange;MathMLElement:onabort,onanimationcancel,onanimationend,onanimationiteration,onanimationstart,onauxclick,onbeforeinput,onbeforematch,onbeforetoggle,onbeforexrselect,onblur,oncancel,oncanplay,oncanplaythrough,onchange,onclick,onclose,oncommand,oncontentvisibilityautostatechange,oncontextlost,oncontextmenu,oncontextrestored,oncopy,oncuechange,oncut,ondblclick,ondrag,ondragend,ondragenter,ondragleave,ondragover,ondragstart,ondrop,ondurationchange,onemptied,onended,onerror,onfocus,onformdata,ongotpointercapture,oninput,oninvalid,onkeydown,onkeypress,onkeyup,onload,onloadeddata,onloadedmetadata,onloadstart,onlostpointercapture,onmousedown,onmouseenter,onmouseleave,onmousemove,onmouseout,onmouseover,onmouseup,onmousewheel,onpaste,onpause,onplay,onplaying,onpointercancel,onpointerdown,onpointerenter,onpointerleave,onpointermove,onpointerout,onpointerover,onpointerrawupdate,onpointerup,onprogress,onratechange,onreset,onresize,onscroll,onscrollend,onscrollsnapchange,onscrollsnapchanging,onsecuritypolicyviolation,onseeked,onseeking,onselect,onselectionchange,onselectstart,onslotchange,onstalled,onsubmit,onsuspend,ontimeupdate,ontoggle,ontransitioncancel,ontransitionend,ontransitionrun,ontransitionstart,onvolumechange,onwaiting,onwebkitanimationend,onwebkitanimationiteration,onwebkitanimationstart,onwebkittransitionend,onwheel;MediaDevices:ondevicechange;MediaKeySession:onkeystatuseschange,onmessage;MediaRecorder:ondataavailable,onerror,onpause,onresume,onstart,onstop;MediaSource:onsourceclose,onsourceended,onsourceopen;MediaStream:onactive,onaddtrack,oninactive,onremovetrack;MediaStreamTrack:oncapturehandlechange,onended,onmute,onunmute;MessagePort:onmessageerror;Navigation:oncurrententrychange,onnavigate,onnavigateerror,onnavigatesuccess;NavigationHistoryEntry:ondispose;NavigatorManagedData:onmanagedconfigurationchange;Notification:onclick,onclose,onerror,onshow;OfflineAudioContext:oncomplete;OffscreenCanvas:oncontextlost,oncontextrestored;PaymentRequest:onpaymentmethodchange,onshippingaddresschange,onshippingoptionchange;PaymentResponse:onpayerdetailchange;PictureInPictureWindow:onresize;PresentationAvailability:onchange;PresentationConnection:onclose,onconnect,onmessage,onterminate;PresentationConnectionList:onconnectionavailable;PresentationRequest:onconnectionavailable;RTCDTMFSender:ontonechange;RTCDataChannel:onbufferedamountlow,onclose,onclosing,onerror,onmessage,onopen;RTCDtlsTransport:onerror,onstatechange;RTCIceTransport:ongatheringstatechange,onselectedcandidatepairchange,onstatechange;RTCPeerConnection:onaddstream,onconnectionstatechange,ondatachannel,onicecandidate,onicecandidateerror,oniceconnectionstatechange,onicegatheringstatechange,onnegotiationneeded,onremovestream,onsignalingstatechange,ontrack;RTCSctpTransport:onstatechange;RemotePlayback:onconnect,onconnecting,ondisconnect;SVGAnimationElement:onbegin,onend,onrepeat;SVGElement:onabort,onanimationcancel,onanimationend,onanimationiteration,onanimationstart,onauxclick,onbeforeinput,onbeforematch,onbeforetoggle,onbeforexrselect,onblur,oncancel,oncanplay,oncanplaythrough,onchange,onclick,onclose,oncommand,oncontentvisibilityautostatechange,oncontextlost,oncontextmenu,oncontextrestored,oncopy,oncuechange,oncut,ondblclick,ondrag,ondragend,ondragenter,ondragleave,ondragover,ondragstart,ondrop,ondurationchange,onemptied,onended,onerror,onfocus,onformdata,ongotpointercapture,oninput,oninvalid,onkeydown,onkeypress,onkeyup,onload,onloadeddata,onloadedmetadata,onloadstart,onlostpointercapture,onmousedown,onmouseenter,onmouseleave,onmousemove,onmouseout,onmouseover,onmouseup,onmousewheel,onpaste,onpause,onplay,onplaying,onpointercancel,onpointerdown,onpointerenter,onpointerleave,onpointermove,onpointerout,onpointerover,onpointerrawupdate,onpointerup,onprogress,onratechange,onreset,onresize,onscroll,onscrollend,onscrollsnapchange,onscrollsnapchanging,onsecuritypolicyviolation,onseeked,onseeking,onselect,onselectionchange,onselectstart,onslotchange,onstalled,onsubmit,onsuspend,ontimeupdate,ontoggle,ontransitioncancel,ontransitionend,ontransitionrun,ontransitionstart,onvolumechange,onwaiting,onwebkitanimationend,onwebkitanimationiteration,onwebkitanimationstart,onwebkittransitionend,onwheel;Screen:onchange;ScreenDetails:oncurrentscreenchange,onscreenschange;ScreenOrientation:onchange;ScriptProcessorNode:onaudioprocess;Sensor:onactivate,onerror,onreading;SerialPort:onconnect,ondisconnect;ServiceWorker:onerror,onstatechange;ServiceWorkerContainer:oncontrollerchange,onmessage,onmessageerror;ServiceWorkerRegistration:onupdatefound;ShadowRoot:onslotchange;SharedWorker:onerror;SourceBuffer:onabort,onerror,onupdate,onupdateend,onupdatestart;SourceBufferList:onaddsourcebuffer,onremovesourcebuffer;SpeechRecognition:onaudioend,onaudiostart,onend,onerror,onnomatch,onresult,onsoundend,onsoundstart,onspeechend,onspeechstart,onstart;SpeechSynthesisUtterance:onboundary,onend,onerror,onmark,onpause,onresume,onstart;TaskSignal:onprioritychange;TextTrack:oncuechange;TextTrackCue:onenter,onexit;TextTrackList:onaddtrack,onchange,onremovetrack;VideoDecoder:ondequeue;VideoEncoder:ondequeue;VirtualKeyboard:ongeometrychange;WakeLockSentinel:onrelease;WebSocket:onclose,onerror,onmessage,onopen;WindowControlsOverlay:ongeometrychange;Worker:onerror,onmessage;XMLHttpRequest:onreadystatechange;XMLHttpRequestEventTarget:onabort,onerror,onload,onloadend,onloadstart,onprogress,ontimeout;XRCubeLayer:onredraw;XRCylinderLayer:onredraw;XREquirectLayer:onredraw;XRLightProbe:onreflectionchange;XRQuadLayer:onredraw;XRReferenceSpace:onreset;XRSession:onend,oninputsourceschange,onselect,onselectend,onselectstart,onsqueeze,onsqueezeend,onsqueezestart,onvisibilitychange,onvisibilitymaskchange;XRSystem:ondevicechange';
        const IDL_ARIA = 'Element:ariaActionsElements,ariaActiveDescendantElement,ariaAtomic,ariaAutoComplete,ariaBrailleLabel,ariaBrailleRoleDescription,ariaBusy,ariaChecked,ariaColCount,ariaColIndex,ariaColIndexText,ariaColSpan,ariaControlsElements,ariaCurrent,ariaDescribedByElements,ariaDescription,ariaDetailsElements,ariaDisabled,ariaErrorMessageElements,ariaExpanded,ariaFlowToElements,ariaHasPopup,ariaHidden,ariaInvalid,ariaKeyShortcuts,ariaLabel,ariaLabelledByElements,ariaLevel,ariaLive,ariaModal,ariaMultiLine,ariaMultiSelectable,ariaOrientation,ariaPlaceholder,ariaPosInSet,ariaPressed,ariaReadOnly,ariaRelevant,ariaRequired,ariaRoleDescription,ariaRowCount,ariaRowIndex,ariaRowIndexText,ariaRowSpan,ariaSelected,ariaSetSize,ariaSort,ariaValueMax,ariaValueMin,ariaValueNow,ariaValueText;ElementInternals:ariaActionsElements,ariaActiveDescendantElement,ariaAtomic,ariaAutoComplete,ariaBrailleLabel,ariaBrailleRoleDescription,ariaBusy,ariaChecked,ariaColCount,ariaColIndex,ariaColIndexText,ariaColSpan,ariaControlsElements,ariaCurrent,ariaDescribedByElements,ariaDescription,ariaDetailsElements,ariaDisabled,ariaErrorMessageElements,ariaExpanded,ariaFlowToElements,ariaHasPopup,ariaHidden,ariaInvalid,ariaKeyShortcuts,ariaLabel,ariaLabelledByElements,ariaLevel,ariaLive,ariaModal,ariaMultiLine,ariaMultiSelectable,ariaOrientation,ariaPlaceholder,ariaPosInSet,ariaPressed,ariaReadOnly,ariaRelevant,ariaRequired,ariaRoleDescription,ariaRowCount,ariaRowIndex,ariaRowIndexText,ariaRowSpan,ariaSelected,ariaSetSize,ariaSort,ariaValueMax,ariaValueMin,ariaValueNow,ariaValueText';
        const _maskIdl = typeof _maskRef === 'function' ? _maskRef : (f) => f;
        const ifaceOf = (name) => {
            let C;
            try { C = globalThis[name]; } catch (_e) { return null; }
            return (typeof C === 'function' && C.prototype && typeof C.prototype === 'object') ? C : null;
        };
        for (const group of IDL_CONSTANTS.split(';')) {
            const split = group.indexOf(':');
            const C = ifaceOf(group.slice(0, split));
            if (!C) continue;
            for (const entry of group.slice(split + 1).split(',')) {
                const eq = entry.indexOf('=');
                const name = entry.slice(0, eq);
                const value = Number(entry.slice(eq + 1));
                for (const target of [C, C.prototype]) {
                    if (Object.prototype.hasOwnProperty.call(target, name)) continue;
                    try {
                        Object.defineProperty(target, name, {
                            value, writable: false, enumerable: true, configurable: false,
                        });
                    } catch (_e) {}
                }
            }
        }
        const handlerSlots = new WeakMap();
        const defineHandler = (proto, name) => {
            const get = Object.getOwnPropertyDescriptor({
                get [name]() {
                    const slots = handlerSlots.get(this);
                    return (slots && slots[name]) || null;
                },
            }, name).get;
            const set = Object.getOwnPropertyDescriptor({
                set [name](v) {
                    let slots = handlerSlots.get(this);
                    if (!slots) handlerSlots.set(this, (slots = { __proto__: null }));
                    slots[name] = (typeof v === 'object' && v !== null) || typeof v === 'function' ? v : null;
                },
            }, name).set;
            _maskIdl(get, 'get ' + name);
            _maskIdl(set, 'set ' + name);
            Object.defineProperty(proto, name, { get, set, enumerable: true, configurable: true });
        };
        for (const group of IDL_HANDLERS.split(';')) {
            const split = group.indexOf(':');
            const C = ifaceOf(group.slice(0, split));
            if (!C) continue;
            for (const name of group.slice(split + 1).split(',')) {
                if (Object.prototype.hasOwnProperty.call(C.prototype, name)) continue;
                try { defineHandler(C.prototype, name); } catch (_e) {}
            }
        }
        const ariaSlots = new WeakMap();
        const defineAria = (proto, name, reflect) => {
            const attribute = 'aria-' + name.slice(4).toLowerCase();
            const get = Object.getOwnPropertyDescriptor({
                get [name]() {
                    if (reflect && typeof this.getAttribute === 'function') {
                        return this.hasAttribute(attribute) ? this.getAttribute(attribute) : null;
                    }
                    const slots = ariaSlots.get(this);
                    return slots && name in slots ? slots[name] : null;
                },
            }, name).get;
            const set = Object.getOwnPropertyDescriptor({
                set [name](v) {
                    if (reflect && typeof this.setAttribute === 'function') {
                        if (v === null || v === undefined) this.removeAttribute(attribute);
                        else this.setAttribute(attribute, `${v}`);
                        return;
                    }
                    let slots = ariaSlots.get(this);
                    if (!slots) ariaSlots.set(this, (slots = { __proto__: null }));
                    slots[name] = v === undefined ? null : v;
                },
            }, name).set;
            _maskIdl(get, 'get ' + name);
            _maskIdl(set, 'set ' + name);
            Object.defineProperty(proto, name, { get, set, enumerable: true, configurable: true });
        };
        for (const group of IDL_ARIA.split(';')) {
            const split = group.indexOf(':');
            const ifaceName = group.slice(0, split);
            const C = ifaceOf(ifaceName);
            if (!C) continue;
            for (const name of group.slice(split + 1).split(',')) {
                if (Object.prototype.hasOwnProperty.call(C.prototype, name)) continue;
                const reflect = ifaceName === 'Element' && !/Elements?$/.test(name);
                try { defineAria(C.prototype, name, reflect); } catch (_e) {}
            }
        }
    } catch (_e) { /* best effort */ }

    try {
        const CTOR_LENGTHS = 'AnimationPlaybackEvent:1,Attr:0,AudioBufferSourceNode:1,AudioData:1,AudioDecoder:1,AudioEncoder:1,AudioNode:0,AudioParam:0,AudioProcessingEvent:2,AudioScheduledSourceNode:0,AudioWorkletNode:2,BeforeInstallPromptEvent:1,BeforeUnloadEvent:0,BlobEvent:2,ByteLengthQueuingStrategy:1,CSSKeywordValue:1,CSSMathClamp:3,CSSMathInvert:1,CSSMathNegate:1,CSSMatrixComponent:1,CSSPerspective:1,CSSPositionValue:2,CSSRotate:1,CSSScale:2,CSSSkew:2,CSSSkewX:1,CSSSkewY:1,CSSStyleSheet:0,CSSTransformValue:1,CSSTranslate:2,CSSUnitValue:2,CSSUnparsedValue:1,CSSVariableReferenceValue:1,CanvasRenderingContext2D:0,ChannelMergerNode:1,ChannelSplitterNode:1,CharacterBoundsUpdateEvent:1,ClipboardItem:1,CommandEvent:1,Comment:0,CompositionEvent:1,CompressionStream:1,ConstantSourceNode:1,ContentVisibilityAutoStateChangeEvent:1,ConvolverNode:1,CookieChangeEvent:1,CookieStore:0,CountQueuingStrategy:1,DOMError:1,DOMTokenList:0,DecompressionStream:1,DelayNode:1,DeviceMotionEvent:1,DeviceOrientationEvent:1,Document:0,DocumentFragment:0,DocumentPictureInPictureEvent:2,EncodedAudioChunk:1,EncodedVideoChunk:1,FederatedCredential:1,FileSystemObserver:1,FontFace:2,FontFaceSetLoadEvent:1,FormDataEvent:2,GPUInternalError:1,GPUOutOfMemoryError:1,GPUPipelineError:1,GPUUncapturedErrorEvent:2,GPUValidationError:1,GamepadEvent:1,HIDConnectionEvent:2,IDBCursor:0,IDBDatabase:0,IDBKeyRange:0,IDBObjectStore:0,IDBRequest:0,IDBTransaction:0,IDBVersionChangeEvent:1,IIRFilterNode:2,Image:0,ImageCapture:1,ImageData:2,ImageDecoder:1,InputDeviceCapabilities:0,InterestEvent:1,KeyboardLayoutMap:0,KeyframeEffect:1,MIDIConnectionEvent:1,MIDIMessageEvent:1,MediaElementAudioSourceNode:2,MediaEncryptedEvent:1,MediaKeyMessageEvent:2,MediaMetadata:0,MediaQueryList:0,MediaQueryListEvent:1,MediaRecorder:1,MediaStreamAudioDestinationNode:1,MediaStreamAudioSourceNode:2,MediaStreamEvent:1,MediaStreamTrackEvent:2,MediaStreamTrackGenerator:1,MediaStreamTrackProcessor:1,MutationRecord:0,NavigateEvent:2,NavigationCurrentEntryChangeEvent:2,Node:0,NodeList:0,Notification:1,OfflineAudioCompletionEvent:2,OfflineAudioContext:1,OverconstrainedError:1,PageRevealEvent:1,PageSwapEvent:1,PannerNode:1,PasswordCredential:1,PaymentMethodChangeEvent:1,PaymentRequest:1,PaymentRequestUpdateEvent:1,PerformanceMark:1,PeriodicWave:1,PictureInPictureEvent:2,PresentationConnectionAvailableEvent:2,PresentationConnectionCloseEvent:2,PresentationRequest:1,Profiler:1,RTCDTMFToneChangeEvent:2,RTCDataChannelEvent:2,RTCEncodedAudioFrame:1,RTCEncodedVideoFrame:1,RTCError:1,RTCErrorEvent:2,RTCIceCandidate:0,RTCPeerConnection:0,RTCPeerConnectionIceErrorEvent:2,RTCPeerConnectionIceEvent:1,RTCRtpScriptTransform:1,RTCSessionDescription:0,RTCTrackEvent:2,ReadableStream:0,ReadableStreamBYOBReader:1,ReadableStreamDefaultController:0,ReportingObserver:1,Response:0,SecurityPolicyViolationEvent:1,SensorErrorEvent:2,SharedStorageAppendMethod:2,SharedStorageDeleteMethod:1,SharedStorageSetMethod:2,SharedWorker:1,SpeechRecognitionErrorEvent:1,SpeechRecognitionEvent:1,SpeechRecognitionPhrase:1,SpeechSynthesisErrorEvent:2,SpeechSynthesisEvent:2,StaticRange:1,StereoPannerNode:1,SubmitEvent:1,TaskPriorityChangeEvent:2,Text:0,TextFormatUpdateEvent:1,TextUpdateEvent:1,ToggleEvent:1,TrackEvent:1,TransformStream:0,URL:1,USBAlternateInterface:2,USBConfiguration:2,USBConnectionEvent:2,USBEndpoint:3,USBInTransferResult:1,USBInterface:2,USBIsochronousInTransferPacket:1,USBIsochronousInTransferResult:1,USBIsochronousOutTransferPacket:1,USBIsochronousOutTransferResult:1,USBOutTransferResult:1,VTTCue:3,ValidityState:0,VideoDecoder:1,VideoEncoder:1,VideoFrame:1,ViewTransition:0,VirtualKeyboardGeometryChangeEvent:1,WaveShaperNode:1,WebGL2RenderingContext:0,WebGLContextEvent:1,WebGLRenderingContext:0,WebSocket:1,WebSocketStream:1,WebTransport:1,WindowControlsOverlayGeometryChangeEvent:2,Worker:1,WritableStream:0,WritableStreamDefaultController:0,XRInputSourceEvent:2,XRInputSourcesChangeEvent:2,XRLayerEvent:2,XRReferenceSpaceEvent:2,XRSessionEvent:2,XRVisibilityMaskChangeEvent:2,XRWebGLBinding:2,XRWebGLLayer:2';
        const MEMBER_LENGTHS = 'AbortController.prototype.abort:0,AbortSignal.abort:0,AudioBuffer.prototype.copyFromChannel:2,AudioBuffer.prototype.copyToChannel:2,AudioParam.prototype.cancelAndHoldAtTime:1,AudioParam.prototype.cancelScheduledValues:1,AudioParam.prototype.exponentialRampToValueAtTime:2,AudioParam.prototype.linearRampToValueAtTime:2,AudioParam.prototype.setTargetAtTime:3,AudioParam.prototype.setValueAtTime:2,AudioParam.prototype.setValueCurveAtTime:3,BaseAudioContext.prototype.decodeAudioData:1,BroadcastChannel.prototype.postMessage:1,CSSStyleSheet.prototype.insertRule:1,CanvasRenderingContext2D.prototype.arc:5,CanvasRenderingContext2D.prototype.createImageData:1,CanvasRenderingContext2D.prototype.drawImage:3,CanvasRenderingContext2D.prototype.ellipse:7,CanvasRenderingContext2D.prototype.isPointInPath:2,CanvasRenderingContext2D.prototype.isPointInStroke:2,CanvasRenderingContext2D.prototype.setTransform:0,CookieStore.prototype.get:0,CookieStore.prototype.getAll:0,CookieStore.prototype.set:1,CredentialsContainer.prototype.create:0,CredentialsContainer.prototype.get:0,CredentialsContainer.prototype.store:1,CustomElementRegistry.prototype.define:2,CustomEvent.prototype.initCustomEvent:1,DOMTokenList.prototype.add:0,DOMTokenList.prototype.forEach:1,DOMTokenList.prototype.remove:0,Document.prototype.createNodeIterator:1,Document.prototype.createTreeWalker:1,Document.prototype.execCommand:1,Document.prototype.importNode:1,Document.prototype.startViewTransition:0,Document.prototype.write:0,Document.prototype.writeln:0,Element.prototype.animate:1,Element.prototype.attachShadow:1,Element.prototype.scrollBy:0,Element.prototype.scrollIntoView:0,Element.prototype.scrollTo:0,Element.prototype.toggleAttribute:1,Event.prototype.initEvent:1,EventCounts.prototype.forEach:1,EventTarget.prototype.addEventListener:2,EventTarget.prototype.removeEventListener:2,EventTarget.prototype.when:1,EyeDropper.prototype.open:0,FileReader.prototype.readAsText:1,FormData.prototype.forEach:1,HTMLCanvasElement.prototype.toBlob:1,HTMLCanvasElement.prototype.toDataURL:0,HTMLFormElement.prototype.requestSubmit:0,HTMLInputElement.prototype.setSelectionRange:2,HTMLTextAreaElement.prototype.setSelectionRange:2,History.prototype.go:0,History.prototype.pushState:2,History.prototype.replaceState:2,IDBCursor.prototype.continue:0,IDBDatabase.prototype.createObjectStore:1,IDBDatabase.prototype.transaction:1,IDBFactory.prototype.open:1,IDBObjectStore.prototype.add:1,IDBObjectStore.prototype.count:0,IDBObjectStore.prototype.createIndex:2,IDBObjectStore.prototype.getAll:0,IDBObjectStore.prototype.getAllKeys:0,IDBObjectStore.prototype.openCursor:0,IDBObjectStore.prototype.put:1,IdentityProvider.getUserInfo:1,Ink.prototype.requestPresenter:0,Keyboard.prototype.lock:0,KeyboardLayoutMap.prototype.forEach:1,MediaSession.prototype.setPositionState:0,MediaSource.prototype.addSourceBuffer:1,MediaSource.prototype.removeSourceBuffer:1,MediaSource.prototype.setLiveSeekableRange:2,MouseEvent.prototype.initMouseEvent:1,Navigator.prototype.canShare:0,Navigator.prototype.clearOriginJoinedAdInterestGroups:1,Navigator.prototype.deprecatedURNToURL:1,Navigator.prototype.leaveAdInterestGroup:0,Navigator.prototype.requestMIDIAccess:0,Navigator.prototype.sendBeacon:1,Navigator.prototype.setAppBadge:0,Navigator.prototype.share:0,NavigatorManagedData.prototype.getManagedConfiguration:1,NodeList.prototype.forEach:1,Notification.requestPermission:0,OffscreenCanvas.prototype.convertToBlob:0,OffscreenCanvas.prototype.getContext:1,PaymentRequest.prototype.show:0,Performance.prototype.getEntriesByName:1,Performance.prototype.measure:1,Performance.prototype.setResourceTimingBufferSize:1,Plugin.prototype.item:1,Plugin.prototype.namedItem:1,PressureObserver.prototype.observe:1,RTCDataChannel.prototype.send:1,RTCPeerConnection.generateCertificate:1,RTCPeerConnection.prototype.addIceCandidate:0,RTCPeerConnection.prototype.addStream:1,RTCPeerConnection.prototype.addTrack:1,RTCPeerConnection.prototype.createDataChannel:1,RTCPeerConnection.prototype.createOffer:0,RTCPeerConnection.prototype.removeTrack:1,RTCPeerConnection.prototype.setLocalDescription:0,Range.prototype.collapse:0,ReadableStream.prototype.cancel:0,ReadableStream.prototype.getReader:0,ReadableStream.prototype.pipeThrough:1,ReadableStream.prototype.pipeTo:1,ReadableStreamDefaultController.prototype.enqueue:0,ReadableStreamDefaultController.prototype.error:0,ReadableStreamDefaultReader.prototype.cancel:0,Selection.prototype.collapse:1,ServiceWorker.prototype.postMessage:1,ServiceWorkerContainer.prototype.register:1,SpeechSynthesis.prototype.speak:1,SubtleCrypto.prototype.decrypt:3,SubtleCrypto.prototype.deriveBits:2,SubtleCrypto.prototype.deriveKey:5,SubtleCrypto.prototype.encrypt:3,SubtleCrypto.prototype.exportKey:2,SubtleCrypto.prototype.generateKey:3,SubtleCrypto.prototype.importKey:5,SubtleCrypto.prototype.sign:3,SubtleCrypto.prototype.unwrapKey:7,SubtleCrypto.prototype.verify:4,SubtleCrypto.prototype.wrapKey:4,TextDecoder.prototype.decode:0,TextEncoder.prototype.encode:0,UIEvent.prototype.initUIEvent:1,URLSearchParams.prototype.delete:1,URLSearchParams.prototype.forEach:1,URLSearchParams.prototype.has:1,WebGLRenderingContext.prototype.activeTexture:1,WebGLRenderingContext.prototype.attachShader:2,WebGLRenderingContext.prototype.bindBuffer:2,WebGLRenderingContext.prototype.bindFramebuffer:2,WebGLRenderingContext.prototype.bindRenderbuffer:2,WebGLRenderingContext.prototype.bindTexture:2,WebGLRenderingContext.prototype.blendEquation:1,WebGLRenderingContext.prototype.blendFunc:2,WebGLRenderingContext.prototype.bufferData:3,WebGLRenderingContext.prototype.checkFramebufferStatus:1,WebGLRenderingContext.prototype.colorMask:4,WebGLRenderingContext.prototype.compileShader:1,WebGLRenderingContext.prototype.createShader:1,WebGLRenderingContext.prototype.deleteBuffer:1,WebGLRenderingContext.prototype.deleteFramebuffer:1,WebGLRenderingContext.prototype.deleteProgram:1,WebGLRenderingContext.prototype.deleteRenderbuffer:1,WebGLRenderingContext.prototype.deleteShader:1,WebGLRenderingContext.prototype.deleteTexture:1,WebGLRenderingContext.prototype.depthFunc:1,WebGLRenderingContext.prototype.depthMask:1,WebGLRenderingContext.prototype.disable:1,WebGLRenderingContext.prototype.disableVertexAttribArray:1,WebGLRenderingContext.prototype.drawArrays:3,WebGLRenderingContext.prototype.drawElements:4,WebGLRenderingContext.prototype.enable:1,WebGLRenderingContext.prototype.enableVertexAttribArray:1,WebGLRenderingContext.prototype.framebufferRenderbuffer:4,WebGLRenderingContext.prototype.framebufferTexture2D:5,WebGLRenderingContext.prototype.generateMipmap:1,WebGLRenderingContext.prototype.getAttribLocation:2,WebGLRenderingContext.prototype.getProgramInfoLog:1,WebGLRenderingContext.prototype.getProgramParameter:2,WebGLRenderingContext.prototype.getShaderInfoLog:1,WebGLRenderingContext.prototype.getShaderParameter:2,WebGLRenderingContext.prototype.getUniformLocation:2,WebGLRenderingContext.prototype.linkProgram:1,WebGLRenderingContext.prototype.pixelStorei:2,WebGLRenderingContext.prototype.renderbufferStorage:4,WebGLRenderingContext.prototype.scissor:4,WebGLRenderingContext.prototype.shaderSource:2,WebGLRenderingContext.prototype.texImage2D:6,WebGLRenderingContext.prototype.texParameteri:3,WebGLRenderingContext.prototype.uniform1f:2,WebGLRenderingContext.prototype.uniform1i:2,WebGLRenderingContext.prototype.uniform2f:3,WebGLRenderingContext.prototype.uniform3f:4,WebGLRenderingContext.prototype.uniform4f:5,WebGLRenderingContext.prototype.uniformMatrix4fv:3,WebGLRenderingContext.prototype.useProgram:1,WebGLRenderingContext.prototype.vertexAttribPointer:6,WebSocket.prototype.close:0,Worker.prototype.postMessage:1,WritableStream.prototype.abort:0,WritableStreamDefaultController.prototype.error:0,WritableStreamDefaultWriter.prototype.abort:0,WritableStreamDefaultWriter.prototype.write:0,XMLHttpRequest.prototype.send:0,XRSystem.prototype.requestSession:1';
        const parseTable = (text) => {
            const map = new Map();
            for (const entry of text.split(',')) {
                const i = entry.lastIndexOf(':');
                if (i > 0) map.set(entry.slice(0, i), +entry.slice(i + 1));
            }
            return map;
        };
        const ctorLengths = parseTable(CTOR_LENGTHS);
        const memberLengths = parseTable(MEMBER_LENGTHS);
        const setLength = (fn, want) => {
            if (typeof fn !== 'function' || fn.length === want) return;
            try { Object.defineProperty(fn, 'length', { value: want, configurable: true }); } catch (_e) {}
        };
        const ECMA_BUILTINS = new Set(['Object', 'Function', 'Array', 'Number', 'Boolean', 'String', 'Symbol',
            'Date', 'Promise', 'RegExp', 'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError',
            'SyntaxError', 'TypeError', 'URIError', 'SuppressedError', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
            'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
            'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'BigInt', 'Map', 'Set',
            'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry', 'Proxy', 'Iterator', 'DisposableStack',
            'AsyncDisposableStack', 'Temporal', 'Intl', 'WebAssembly', 'Atomics', 'JSON', 'Math', 'Reflect']);
        for (const name of Object.getOwnPropertyNames(globalThis)) {
            if (name.charCodeAt(0) < 65 || name.charCodeAt(0) > 90) continue;
            if (ECMA_BUILTINS.has(name)) continue;
            let C;
            try { C = globalThis[name]; } catch (_e) { continue; }
            if (typeof C !== 'function' || !C.prototype || typeof C.prototype !== 'object') continue;
            if (C.name !== name) continue;
            if (ctorLengths.has(name)) setLength(C, ctorLengths.get(name));
            for (const isProto of [false, true]) {
                const target = isProto ? C.prototype : C;
                let keys;
                try { keys = Object.getOwnPropertyNames(target); } catch (_e) { continue; }
                for (const key of keys) {
                    if (key === 'prototype') {
                        const pd = Object.getOwnPropertyDescriptor(target, key);
                        if (pd && pd.writable) {
                            try { Object.defineProperty(target, key, { writable: false }); } catch (_e) {}
                        }
                        continue;
                    }
                    if (!isProto && (key === 'length' || key === 'name')) continue;
                    if (key.charCodeAt(0) === 95) continue;
                    const d = Object.getOwnPropertyDescriptor(target, key);
                    if (!d) continue;
                    const lengthKey = name + (isProto ? '.prototype.' : '.') + key;
                    if (memberLengths.has(lengthKey)) setLength(d.value, memberLengths.get(lengthKey));
                    if (key === 'constructor' || !d.configurable) continue;
                    let want;
                    if (d.get || d.set) {
                        want = { get: d.get, set: d.set, enumerable: true, configurable: true };
                        if (d.enumerable) continue;
                    } else if (typeof d.value === 'function') {
                        if (d.enumerable && d.writable) continue;
                        want = { value: d.value, writable: true, enumerable: true, configurable: true };
                    } else if (/^[A-Z][A-Z0-9_]*$/.test(key)
                        && (typeof d.value === 'number' || typeof d.value === 'string')) {
                        if (d.enumerable && !d.writable && !d.configurable) continue;
                        want = { value: d.value, writable: false, enumerable: true, configurable: false };
                    } else {
                        if (d.enumerable && d.writable) continue;
                        want = { value: d.value, writable: true, enumerable: true, configurable: true };
                    }
                    try { Object.defineProperty(target, key, want); } catch (_e) {}
                }
            }
        }
        if (globalThis.window === globalThis) {
            const GLOBAL_LENGTHS = 'alert:0,confirm:0,prompt:0,open:0,postMessage:1,moveBy:2,moveTo:2,'
                + 'resizeBy:2,resizeTo:2,scrollBy:0,scrollTo:0,fetchLater:1,'
                + 'webkitRequestFileSystem:3,webkitResolveLocalFileSystemURL:2';
            for (const [key, want] of parseTable(GLOBAL_LENGTHS)) {
                let f;
                try { f = globalThis[key]; } catch (_e) { continue; }
                setLength(f, want);
            }
        }
    } catch (_e) { /* best effort */ }

    {
        const _inWorkerScope = Object.prototype.toString.call(globalThis) === '[object DedicatedWorkerGlobalScope]';
        const _workerUA = (() => {
            try {
                return (ops && ops.op_has_stealth_profile && ops.op_has_stealth_profile())
                    ? (ops.op_get_profile_value('user_agent') || '') : '';
            } catch (_e) { return ''; }
        })();
        if (_inWorkerScope && !/Firefox\/|Gecko\/20100101/.test(_workerUA)) try {
            const W = globalThis;
            const svc = (() => {
                try {
                    const syms = Object.getOwnPropertySymbols(W, 1);
                    for (let i = 0; i < syms.length; i++) {
                        const v = W[syms[i]];
                        if (v && v.__bo && v.services) return v.services;
                    }
                } catch (_e) {}
                return null;
            })();
            const WGS = W.WorkerGlobalScope, DWGS = W.DedicatedWorkerGlobalScope, ET = W.EventTarget;
            if (svc && typeof WGS === 'function' && typeof DWGS === 'function' && typeof ET === 'function') {
                const ORDER = 'Object,Function,Array,Number,parseFloat,parseInt,Infinity,NaN,undefined,Boolean,String,Symbol,Date,Promise,RegExp,Error,AggregateError,EvalError,RangeError,ReferenceError,SyntaxError,TypeError,URIError,globalThis,JSON,Math,Intl,ArrayBuffer,Atomics,Uint8Array,Int8Array,Uint16Array,Int16Array,Uint32Array,Int32Array,BigUint64Array,BigInt64Array,Uint8ClampedArray,Float32Array,Float64Array,DataView,Map,BigInt,Set,Iterator,WeakMap,WeakSet,Proxy,Reflect,FinalizationRegistry,WeakRef,decodeURI,decodeURIComponent,encodeURI,encodeURIComponent,escape,unescape,eval,isFinite,isNaN,console,WebSocketStream,WebSocketError,RestrictionTarget,RTCTransformEvent,RTCRtpScriptTransformer,RTCDataChannel,QuotaExceededError,PushSubscriptionOptions,PushSubscription,PushManager,PeriodicSyncManager,Origin,Notification,CropTarget,BackgroundFetchRegistration,BackgroundFetchRecord,BackgroundFetchManager,XMLHttpRequestUpload,XMLHttpRequestEventTarget,XMLHttpRequest,WritableStreamDefaultWriter,WritableStreamDefaultController,WritableStream,WorkerNavigator,WorkerLocation,WorkerGlobalScope,Worker,WebSocket,WebGLVertexArrayObject,WebGLUniformLocation,WebGLTransformFeedback,WebGLTexture,WebGLSync,WebGLShaderPrecisionFormat,WebGLShader,WebGLSampler,WebGLRenderingContext,WebGLRenderbuffer,WebGLQuery,WebGLProgram,WebGLObject,WebGLFramebuffer,WebGLContextEvent,WebGLBuffer,WebGLActiveInfo,WebGL2RenderingContext,VideoFrame,VideoColorSpace,UserActivation,URLSearchParams,URLPattern,URL,TrustedTypePolicyFactory,TrustedTypePolicy,TrustedScriptURL,TrustedScript,TrustedHTML,TransformStreamDefaultController,TransformStream,TextMetrics,TextEncoderStream,TextEncoder,TextDecoderStream,TextDecoder,TaskSignal,TaskPriorityChangeEvent,TaskController,SyncManager,Subscriber,SourceBufferList,SourceBuffer,SecurityPolicyViolationEvent,Scheduler,Response,Request,ReportingObserver,ReportBody,ReadableStreamDefaultReader,ReadableStreamDefaultController,ReadableStreamBYOBRequest,ReadableStreamBYOBReader,ReadableStream,ReadableByteStreamController,RTCEncodedVideoFrame,RTCEncodedAudioFrame,PromiseRejectionEvent,ProgressEvent,Permissions,PermissionStatus,PerformanceServerTiming,PerformanceResourceTiming,PerformanceObserverEntryList,PerformanceObserver,PerformanceMeasure,PerformanceMark,PerformanceEntry,Performance,Path2D,OffscreenCanvasRenderingContext2D,OffscreenCanvas,Observable,NetworkInformation,NavigatorUAData,MessagePort,MessageEvent,MessageChannel,MediaSourceHandle,MediaSource,MediaCapabilities,ImageData,ImageBitmapRenderingContext,ImageBitmap,IDBVersionChangeEvent,IDBTransaction,IDBRequest,IDBRecord,IDBOpenDBRequest,IDBObjectStore,IDBKeyRange,IDBIndex,IDBFactory,IDBDatabase,IDBCursorWithValue,IDBCursor,Headers,FormData,FontFaceSet,FontFace,FileReaderSync,FileReader,FileList,File,EventTarget,EventSource,Event,ErrorEvent,EncodedVideoChunk,EncodedAudioChunk,DedicatedWorkerGlobalScope,DecompressionStream,DOMStringList,DOMRectReadOnly,DOMRect,DOMQuad,DOMPointReadOnly,DOMPoint,DOMMatrixReadOnly,DOMMatrix,DOMException,CustomEvent,Crypto,CountQueuingStrategy,CompressionStream,CloseEvent,CanvasPattern,CanvasGradient,CSSSkewY,CSSSkewX,ByteLengthQueuingStrategy,BroadcastChannel,Blob,AudioData,AbortSignal,AbortController,name,onmessage,onmessageerror,cancelAnimationFrame,close,postMessage,requestAnimationFrame,onrtctransform,webkitRequestFileSystem,webkitRequestFileSystemSync,webkitResolveLocalFileSystemSyncURL,webkitResolveLocalFileSystemURL,Temporal,SuppressedError,DisposableStack,AsyncDisposableStack,Float16Array,WebAssembly,AudioDecoder,AudioEncoder,Cache,CacheStorage,CreateMonitor,CryptoKey,FileSystemSyncAccessHandle,GPU,GPUAdapter,GPUAdapterInfo,GPUBindGroup,GPUBindGroupLayout,GPUBuffer,GPUBufferUsage,GPUCanvasContext,GPUColorWrite,GPUCommandBuffer,GPUCommandEncoder,GPUCompilationInfo,GPUCompilationMessage,GPUComputePassEncoder,GPUComputePipeline,GPUDevice,GPUDeviceLostInfo,GPUError,GPUExternalTexture,GPUInternalError,GPUMapMode,GPUOutOfMemoryError,GPUPipelineError,GPUPipelineLayout,GPUQuerySet,GPUQueue,GPURenderBundle,GPURenderBundleEncoder,GPURenderPassEncoder,GPURenderPipeline,GPUSampler,GPUShaderModule,GPUShaderStage,GPUSupportedFeatures,GPUSupportedLimits,GPUTexture,GPUTextureUsage,GPUTextureView,GPUUncapturedErrorEvent,GPUValidationError,IdleDetector,ImageDecoder,ImageTrack,ImageTrackList,NavigationPreloadManager,ServiceWorkerRegistration,StorageManager,SubtleCrypto,VideoDecoder,VideoEncoder,WGSLLanguageFeatures,WebTransport,WebTransportBidirectionalStream,WebTransportDatagramDuplexStream,WebTransportError,BarcodeDetector,FileSystemDirectoryHandle,FileSystemFileHandle,FileSystemHandle,FileSystemWritableFileStream,FileSystemObserver,HID,HIDConnectionEvent,HIDDevice,HIDInputReportEvent,Lock,LockManager,PressureObserver,PressureRecord,Serial,SerialPort,StorageBucket,StorageBucketManager,USB,USBAlternateInterface,USBConfiguration,USBConnectionEvent,USBDevice,USBEndpoint,USBInTransferResult,USBInterface,USBIsochronousInTransferPacket,USBIsochronousInTransferResult,USBIsochronousOutTransferPacket,USBIsochronousOutTransferResult,USBOutTransferResult'.split(',');
                const PARENTS = new Map('AggregateError:Error,EvalError:Error,RangeError:Error,ReferenceError:Error,SyntaxError:Error,TypeError:Error,URIError:Error,Uint8Array:TypedArray,Int8Array:TypedArray,Uint16Array:TypedArray,Int16Array:TypedArray,Uint32Array:TypedArray,Int32Array:TypedArray,BigUint64Array:TypedArray,BigInt64Array:TypedArray,Uint8ClampedArray:TypedArray,Float32Array:TypedArray,Float64Array:TypedArray,WebSocketError:DOMException,RTCTransformEvent:Event,RTCDataChannel:EventTarget,QuotaExceededError:DOMException,Notification:EventTarget,BackgroundFetchRegistration:EventTarget,XMLHttpRequestUpload:XMLHttpRequestEventTarget,XMLHttpRequestEventTarget:EventTarget,XMLHttpRequest:XMLHttpRequestEventTarget,WorkerGlobalScope:EventTarget,Worker:EventTarget,WebSocket:EventTarget,WebGLVertexArrayObject:WebGLObject,WebGLTransformFeedback:WebGLObject,WebGLTexture:WebGLObject,WebGLSync:WebGLObject,WebGLShader:WebGLObject,WebGLSampler:WebGLObject,WebGLRenderbuffer:WebGLObject,WebGLQuery:WebGLObject,WebGLProgram:WebGLObject,WebGLFramebuffer:WebGLObject,WebGLContextEvent:Event,WebGLBuffer:WebGLObject,TaskSignal:AbortSignal,TaskPriorityChangeEvent:Event,TaskController:AbortController,SourceBufferList:EventTarget,SourceBuffer:EventTarget,SecurityPolicyViolationEvent:Event,PromiseRejectionEvent:Event,ProgressEvent:Event,PermissionStatus:EventTarget,PerformanceResourceTiming:PerformanceEntry,PerformanceMeasure:PerformanceEntry,PerformanceMark:PerformanceEntry,Performance:EventTarget,OffscreenCanvas:EventTarget,NetworkInformation:EventTarget,MessagePort:EventTarget,MessageEvent:Event,MediaSource:EventTarget,IDBVersionChangeEvent:Event,IDBTransaction:EventTarget,IDBRequest:EventTarget,IDBOpenDBRequest:IDBRequest,IDBDatabase:EventTarget,IDBCursorWithValue:IDBCursor,FontFaceSet:EventTarget,FileReader:EventTarget,File:Blob,EventSource:EventTarget,ErrorEvent:Event,DedicatedWorkerGlobalScope:WorkerGlobalScope,DOMRect:DOMRectReadOnly,DOMPoint:DOMPointReadOnly,DOMMatrix:DOMMatrixReadOnly,DOMException:Error,CustomEvent:Event,CloseEvent:Event,CSSSkewY:CSSTransformComponent,CSSSkewX:CSSTransformComponent,BroadcastChannel:EventTarget,AbortSignal:EventTarget,SuppressedError:Error,Float16Array:TypedArray,AudioDecoder:EventTarget,AudioEncoder:EventTarget,CreateMonitor:EventTarget,GPUDevice:EventTarget,GPUInternalError:GPUError,GPUOutOfMemoryError:GPUError,GPUPipelineError:DOMException,GPUUncapturedErrorEvent:Event,GPUValidationError:GPUError,IdleDetector:EventTarget,ServiceWorkerRegistration:EventTarget,VideoDecoder:EventTarget,VideoEncoder:EventTarget,WebTransportError:DOMException,FileSystemDirectoryHandle:FileSystemHandle,FileSystemFileHandle:FileSystemHandle,FileSystemWritableFileStream:WritableStream,HID:EventTarget,HIDConnectionEvent:Event,HIDDevice:EventTarget,HIDInputReportEvent:Event,Serial:EventTarget,SerialPort:EventTarget,USB:EventTarget,USBConnectionEvent:Event'.split(',').map((e) => e.split(':')));
                const mask = typeof _maskRef === 'function' ? _maskRef : (f) => f;
                const apply = Reflect.apply;
                const recv = (o) => {
                    if (o !== undefined && o !== null && o !== W) throw new TypeError('Illegal invocation');
                };
                const valueOf = (k) => {
                    const d = Object.getOwnPropertyDescriptor(W, k);
                    if (!d) return undefined;
                    if ('value' in d) return d.value;
                    try { return d.get ? apply(d.get, W, []) : undefined; } catch (_e) { return undefined; }
                };
                const method = (name, length, impl) => {
                    const f = { [name](...args) { recv(this); return apply(impl, W, args); } }[name];
                    Object.defineProperty(f, 'length', { value: length, configurable: true });
                    mask(f, name);
                    return { value: f, writable: true, enumerable: true, configurable: true };
                };
                const accessor = (name, get, set) => {
                    const g = Object.getOwnPropertyDescriptor({ get [name]() { recv(this); return get(); } }, name).get;
                    mask(g, 'get ' + name);
                    let s;
                    if (set) {
                        s = Object.getOwnPropertyDescriptor({ set [name](v) { recv(this); set(v); } }, name).set;
                        mask(s, 'set ' + name);
                    }
                    return { get: g, set: s, enumerable: true, configurable: true };
                };
                const replaceable = (name) => (v) => {
                    Object.defineProperty(W, name, { value: v, writable: true, enumerable: true, configurable: true });
                };
                const slots = { __proto__: null };
                const handler = (name) => accessor(name, () => slots[name] || null, (v) => {
                    slots[name] = (typeof v === 'object' && v !== null) || typeof v === 'function' ? v : null;
                });

                const impl = { __proto__: null };
                for (const k of ['location', 'navigator', 'performance', 'crypto', 'indexedDB', 'createImageBitmap',
                    'fetch', 'importScripts', 'atob', 'btoa', 'queueMicrotask', 'structuredClone', 'clearInterval',
                    'clearTimeout', 'setInterval', 'setTimeout', 'postMessage', 'close', 'requestAnimationFrame',
                    'cancelAnimationFrame']) impl[k] = valueOf(k);

                const secure = (() => {
                    try { return !!ops.op_is_secure_context(); } catch (_e) { return false; }
                })();
                const isolated = (() => {
                    try { return !!ops.op_cross_origin_isolated(); } catch (_e) { return false; }
                })();
                const single = (name) => (typeof W[name] === 'function' ? svc.make(W[name]) : undefined);
                const scheduler = single('Scheduler');
                const caches = secure ? single('CacheStorage') : undefined;
                const trustedTypes = single('TrustedTypePolicyFactory');
                const fonts = single('FontFaceSet');
                const origin = (() => {
                    try { return impl.location ? impl.location.origin : 'null'; } catch (_e) { return 'null'; }
                })();
                const reportError = (value) => {
                    let delivered = false;
                    try {
                        const event = new W.ErrorEvent('error', {
                            error: value,
                            message: value && value.message !== undefined ? String(value.message) : String(value),
                            cancelable: true,
                        });
                        W.dispatchEvent(event);
                        delivered = event.defaultPrevented;
                    } catch (_e) {}
                    if (!delivered) {
                        try { console.error('Uncaught', value); } catch (_e) {}
                    }
                };
                const fileSystemError = () => svc.domError(
                    'It was determined that certain files are unsafe for access within a Web application, or that too many calls are being made on file resources.',
                    'SecurityError');

                const wgsMembers = [
                    ['self', accessor('self', () => W)],
                    ['location', accessor('location', () => impl.location)],
                    ['onerror', handler('onerror')],
                    ['onlanguagechange', handler('onlanguagechange')],
                    ['navigator', accessor('navigator', () => impl.navigator)],
                    ['onrejectionhandled', handler('onrejectionhandled')],
                    ['onunhandledrejection', handler('onunhandledrejection')],
                    ['origin', accessor('origin', () => origin, replaceable('origin'))],
                    ['performance', accessor('performance', () => impl.performance, replaceable('performance'))],
                    ['trustedTypes', accessor('trustedTypes', () => trustedTypes)],
                    ['crypto', accessor('crypto', () => impl.crypto)],
                    ['indexedDB', accessor('indexedDB', () => impl.indexedDB)],
                    ['fonts', accessor('fonts', () => fonts)],
                    ['createImageBitmap', method('createImageBitmap', 1, impl.createImageBitmap)],
                    ['fetch', method('fetch', 1, impl.fetch)],
                    ['importScripts', method('importScripts', 0, impl.importScripts)],
                    ['constructor', Object.getOwnPropertyDescriptor(WGS.prototype, 'constructor')],
                    ['isSecureContext', accessor('isSecureContext', () => secure)],
                    ['crossOriginIsolated', accessor('crossOriginIsolated', () => isolated)],
                    ['scheduler', accessor('scheduler', () => scheduler, replaceable('scheduler'))],
                    ['caches', secure ? accessor('caches', () => caches) : null],
                    ['atob', method('atob', 1, impl.atob)],
                    ['btoa', method('btoa', 1, impl.btoa)],
                    ['queueMicrotask', method('queueMicrotask', 1, impl.queueMicrotask)],
                    ['reportError', method('reportError', 1, reportError)],
                    ['structuredClone', method('structuredClone', 1, impl.structuredClone)],
                    ['clearInterval', method('clearInterval', 0, impl.clearInterval)],
                    ['clearTimeout', method('clearTimeout', 0, impl.clearTimeout)],
                    ['setInterval', method('setInterval', 1, impl.setInterval)],
                    ['setTimeout', method('setTimeout', 1, impl.setTimeout)],
                ];
                for (const k of Object.getOwnPropertyNames(WGS.prototype)) {
                    try { delete WGS.prototype[k]; } catch (_e) {}
                }
                for (const [name, descriptor] of wgsMembers) {
                    if (!descriptor) continue;
                    try { Object.defineProperty(WGS.prototype, name, descriptor); } catch (_e) {}
                }
                const wgsTag = Object.getOwnPropertyDescriptor(WGS.prototype, Symbol.toStringTag);
                if (wgsTag) {
                    delete WGS.prototype[Symbol.toStringTag];
                    Object.defineProperty(WGS.prototype, Symbol.toStringTag, wgsTag);
                }
                try { Object.setPrototypeOf(WGS.prototype, ET.prototype); } catch (_e) {}

                for (const target of [DWGS.prototype, DWGS]) {
                    for (const [name, value] of [['TEMPORARY', 0], ['PERSISTENT', 1]]) {
                        try {
                            Object.defineProperty(target, name, {
                                value, writable: false, enumerable: true, configurable: false,
                            });
                        } catch (_e) {}
                    }
                }
                const dwgsCtor = Object.getOwnPropertyDescriptor(DWGS.prototype, 'constructor');
                if (dwgsCtor) {
                    delete DWGS.prototype.constructor;
                    Object.defineProperty(DWGS.prototype, 'constructor', dwgsCtor);
                }
                const dwgsTag = Object.getOwnPropertyDescriptor(DWGS.prototype, Symbol.toStringTag);
                if (dwgsTag) {
                    delete DWGS.prototype[Symbol.toStringTag];
                    Object.defineProperty(DWGS.prototype, Symbol.toStringTag, dwgsTag);
                }

                const members = {
                    __proto__: null,
                    name: accessor('name', () => slots.name || '', replaceable('name')),
                    onmessage: handler('onmessage'),
                    onmessageerror: handler('onmessageerror'),
                    cancelAnimationFrame: method('cancelAnimationFrame', 1, impl.cancelAnimationFrame),
                    close: method('close', 0, impl.close),
                    postMessage: method('postMessage', 1, impl.postMessage),
                    requestAnimationFrame: method('requestAnimationFrame', 1, impl.requestAnimationFrame),
                    onrtctransform: handler('onrtctransform'),
                    webkitRequestFileSystem: method('webkitRequestFileSystem', 2, (type, size, successCallback, errorCallback) => {
                        if (typeof errorCallback === 'function') {
                            setTimeout(() => errorCallback(fileSystemError()), 0);
                        }
                    }),
                    webkitRequestFileSystemSync: method('webkitRequestFileSystemSync', 2, () => {
                        throw fileSystemError();
                    }),
                    webkitResolveLocalFileSystemSyncURL: method('webkitResolveLocalFileSystemSyncURL', 1, () => {
                        throw fileSystemError();
                    }),
                    webkitResolveLocalFileSystemURL: method('webkitResolveLocalFileSystemURL', 2, (url, successCallback, errorCallback) => {
                        if (typeof errorCallback === 'function') {
                            setTimeout(() => errorCallback(fileSystemError()), 0);
                        }
                    }),
                };

                const keep = new Set(ORDER);
                if (isolated) keep.add('SharedArrayBuffer');
                for (const k of Object.getOwnPropertyNames(W)) {
                    if (keep.has(k)) continue;
                    try { delete W[k]; } catch (_e) {}
                }
                for (const name of ORDER) {
                    if (name in members) continue;
                    if (Object.prototype.hasOwnProperty.call(W, name)) continue;
                    if (!/^[A-Z]/.test(name)) continue;
                    try { svc.iface(name, PARENTS.get(name)); } catch (_e) {}
                }
                for (const [child, parent] of PARENTS) {
                    const C = W[child], P = W[parent];
                    if (typeof C !== 'function' || typeof P !== 'function' || !C.prototype || !P.prototype) continue;
                    if (Object.getPrototypeOf(C.prototype) !== Object.prototype) continue;
                    try {
                        Object.setPrototypeOf(C.prototype, P.prototype);
                        Object.setPrototypeOf(C, P);
                    } catch (_e) {}
                }
                for (const [name, length] of [['WebTransport', 1], ['Worker', 1]]) {
                    const C = W[name];
                    if (typeof C === 'function' && C.length !== length) {
                        try { Object.defineProperty(C, 'length', { value: length, configurable: true }); } catch (_e) {}
                    }
                }
                const present = Object.getOwnPropertyNames(W);
                let prefix = 0;
                while (prefix < ORDER.length && prefix < present.length && present[prefix] === ORDER[prefix]) prefix++;
                for (let i = prefix; i < ORDER.length; i++) {
                    const name = ORDER[i];
                    const descriptor = members[name] || Object.getOwnPropertyDescriptor(W, name);
                    if (!descriptor) continue;
                    try {
                        delete W[name];
                        Object.defineProperty(W, name, descriptor);
                    } catch (_e) {}
                }
            }
        } catch (_e) { /* best effort */ }
    }

})(globalThis);