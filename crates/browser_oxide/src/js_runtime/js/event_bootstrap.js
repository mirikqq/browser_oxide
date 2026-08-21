((globalThis) => {
    // ---- Trusted-event authenticity (v0.1.0 behavioral E1) ----------------
    // `isTrusted` MUST be both unforgeable and shaped like a real browser's:
    //   * a GETTER on Event.prototype — NOT an own data property. Scripts
    //     that read `getOwnPropertyDescriptor(evt,'isTrusted')` can flag an
    //     own-data `isTrusted` as synthetic (real browsers expose it via
    //     the prototype).
    //   * backed by a MODULE-PRIVATE WeakSet that page JS cannot reach. The
    //     old design keyed trust off `Symbol.for('__bo_trusted__')` — the
    //     GLOBAL symbol registry — so any page could re-derive the symbol and
    //     forge a trusted event (`new Event('x', {[Symbol.for(...)]: true})`).
    // Only our privileged init scripts mint trust, via `_markTrusted`, handed
    // off below through a temp global they capture-and-delete before any page
    // script runs. There is no in-band (options/symbol) path from page JS.
    const _trustedEvents = new WeakSet();
    const _markTrusted = (ev) => {
        try { if (ev && typeof ev === 'object') _trustedEvents.add(ev); } catch (_) {}
        return ev;
    };

    class Event {
        constructor(type, options = {}) {
            this.type = type;
            this.bubbles = !!options.bubbles;
            this.cancelable = !!options.cancelable;
            this.composed = !!options.composed;
            this.defaultPrevented = false;
            this.target = null;
            this.currentTarget = null;
            this.eventPhase = 0;
            // NOTE: `isTrusted` is intentionally NOT set here. It is a prototype
            // getter (installed below) reading the private WeakSet — default
            // false for page-constructed events; trusted only when our
            // privileged dispatch path calls `_markTrusted(ev)`.
            this.timeStamp = performance.now();
            this._stopped = false;
            this._stoppedImmediate = false;
        }
        preventDefault() {
            if (this.cancelable) this.defaultPrevented = true;
        }
        /// Legacy initialiser, still used by plenty of shipped code — including
        /// hCaptcha's own error path, which threw `initEvent is not a function`
        /// and in doing so swallowed whatever error it was reporting.
        initEvent(type, bubbles, cancelable) {
            this.type = String(type);
            this.bubbles = !!bubbles;
            this.cancelable = !!cancelable;
        }
        stopPropagation() { this._stopped = true; }
        stopImmediatePropagation() { this._stopped = true; this._stoppedImmediate = true; }
        composedPath() {
            const path = [];
            let node = this.target;
            while (node) { path.push(node); node = node.parentNode; }
            // The window closes the path, as it does in a browser.
            if (path.length && path[path.length - 1] === globalThis.document) {
                path.push(globalThis);
            } else if (this.target === globalThis.document) {
                path.push(globalThis);
            }
            return path;
        }
        // Phase constants
        static NONE = 0;
        static CAPTURING_PHASE = 1;
        static AT_TARGET = 2;
        static BUBBLING_PHASE = 3;
    }

    // isTrusted as an inherited, native-masked prototype accessor backed by the
    // private WeakSet. Subclasses (CustomEvent, MouseEvent, …) inherit it. The
    // descriptor shape matches real Chrome: {get: ƒ, set: undefined,
    // enumerable: true, configurable: true}.
    Object.defineProperty(Event.prototype, 'isTrusted', {
        configurable: true,
        enumerable: true,
        get: (typeof _maskFunction === 'function')
            ? _maskFunction(function () { return _trustedEvents.has(this); }, 'get isTrusted')
            : function () { return _trustedEvents.has(this); },
    });

    class CustomEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            this.detail = options.detail !== undefined ? options.detail : null;
        }
        initCustomEvent(type, bubbles, cancelable, detail) {
            this.type = type;
            this.bubbles = bubbles;
            this.cancelable = cancelable;
            this.detail = detail;
        }
    }

    // --- UI Event hierarchy ---
    class UIEvent extends Event {
        initUIEvent(type, bubbles, cancelable, view, detail) {
            this.initEvent(type, bubbles, cancelable);
            this.view = view || null;
            this.detail = detail || 0;
        }
        constructor(type, options = {}) {
            super(type, options);
            this.view = options.view || globalThis;
            this.detail = options.detail || 0;
        }
    }

    // Offset of an event's point inside its target's box.
    const _mouseOffset = (ev, horizontal) => {
        try {
            const t = ev.target;
            if (!t || typeof t.getBoundingClientRect !== "function") return 0;
            const r = t.getBoundingClientRect();
            const v = horizontal ? ev.clientX - r.left : ev.clientY - r.top;
            return Number.isFinite(v) ? v : 0;
        } catch (_e) {
            return 0;
        }
    };

    class MouseEvent extends UIEvent {
        constructor(type, options = {}) {
            super(type, { bubbles: true, cancelable: true, ...options });
            this.screenX = options.screenX || 0;
            this.screenY = options.screenY || 0;
            this.clientX = options.clientX || 0;
            this.clientY = options.clientY || 0;
            this.pageX = options.pageX || this.clientX;
            this.pageY = options.pageY || this.clientY;
            this.button = options.button || 0;
            this.buttons = options.buttons || 0;
            this.ctrlKey = !!options.ctrlKey;
            this.shiftKey = !!options.shiftKey;
            this.altKey = !!options.altKey;
            this.metaKey = !!options.metaKey;
            this.relatedTarget = options.relatedTarget || null;
            this.movementX = options.movementX || 0;
            this.movementY = options.movementY || 0;
        }
        // `offsetX`/`offsetY` are not init members — Chrome computes them from
        // the event's target when they are read, and they are accessors on the
        // prototype, not own properties.
        //
        // They used to be own properties pinned at 0, and canvas hit-testing is
        // built on them: `const x = e.offsetX, y = e.offsetY` is how a widget
        // turns a click into a point on its bitmap. Every click therefore landed
        // on the canvas origin, outside anything drawn — the handler ran, the
        // event was trusted, and nothing was ever selected or picked up.
        get offsetX() { return _mouseOffset(this, true); }
        get offsetY() { return _mouseOffset(this, false); }
        // Standard aliases used by hCaptcha's parallel motion stream. Missing
        // accessors stringify as `null` inside its [x,y,time] arrays even while
        // clientX/clientY are valid.
        get x() { return this.clientX; }
        get y() { return this.clientY; }
        // Relative to the nearest positioned ancestor in Chrome; page
        // coordinates match that whenever nothing in the chain is positioned,
        // and they are what code falling back from `offsetX` expects to find.
        get layerX() { return this.pageX; }
        get layerY() { return this.pageY; }
        get which() { return this.button + 1; }
        initMouseEvent(type, bubbles, cancelable, view, detail, screenX, screenY,
                       clientX, clientY, ctrlKey, altKey, shiftKey, metaKey,
                       button, relatedTarget) {
            this.initUIEvent(type, bubbles, cancelable, view, detail);
            this.screenX = screenX || 0;
            this.screenY = screenY || 0;
            this.clientX = clientX || 0;
            this.clientY = clientY || 0;
            this.ctrlKey = !!ctrlKey;
            this.altKey = !!altKey;
            this.shiftKey = !!shiftKey;
            this.metaKey = !!metaKey;
            this.button = button || 0;
            this.relatedTarget = relatedTarget || null;
        }
        getModifierState(key) { return false; }
    }

    class KeyboardEvent extends UIEvent {
        constructor(type, options = {}) {
            super(type, { bubbles: true, cancelable: true, ...options });
            this.key = options.key || "";
            this.code = options.code || "";
            this.keyCode = options.keyCode || 0;
            this.charCode = options.charCode || 0;
            this.which = options.which || options.keyCode || 0;
            this.ctrlKey = !!options.ctrlKey;
            this.shiftKey = !!options.shiftKey;
            this.altKey = !!options.altKey;
            this.metaKey = !!options.metaKey;
            this.repeat = !!options.repeat;
            this.isComposing = !!options.isComposing;
            this.location = options.location || 0;
        }
        getModifierState(key) { return false; }
    }

    class InputEvent extends UIEvent {
        constructor(type, options = {}) {
            super(type, { bubbles: true, cancelable: false, ...options });
            this.data = options.data || null;
            this.inputType = options.inputType || "";
            this.isComposing = !!options.isComposing;
        }
    }

    class FocusEvent extends UIEvent {
        constructor(type, options = {}) {
            super(type, options);
            this.relatedTarget = options.relatedTarget || null;
        }
    }

    class PointerEvent extends MouseEvent {
        constructor(type, options = {}) {
            super(type, options);
            this.pointerId = options.pointerId || 0;
            this.width = options.width || 1;
            this.height = options.height || 1;
            this.pressure = options.pressure || 0;
            this.tangentialPressure = options.tangentialPressure || 0;
            this.tiltX = options.tiltX || 0;
            this.tiltY = options.tiltY || 0;
            this.twist = options.twist || 0;
            this.pointerType = options.pointerType || "mouse";
            this.isPrimary = options.isPrimary !== undefined ? options.isPrimary : true;
            this.altitudeAngle = options.altitudeAngle !== undefined
                ? options.altitudeAngle : Math.PI / 2;
            this.azimuthAngle = options.azimuthAngle || 0;
            this.persistentDeviceId = options.persistentDeviceId || 0;
        }
        // Dispatched events carry no coalesced or predicted samples, which is
        // also what Chrome reports for one it did not coalesce. Missing entirely,
        // they threw out of any move handler that asked — and a drag handler is
        // the usual caller.
        getCoalescedEvents() { return [this]; }
        getPredictedEvents() { return []; }
    }

    class WheelEvent extends MouseEvent {
        constructor(type, options = {}) {
            super(type, options);
            this.deltaX = options.deltaX || 0;
            this.deltaY = options.deltaY || 0;
            this.deltaZ = options.deltaZ || 0;
            this.deltaMode = options.deltaMode || 0;
        }
        static DOM_DELTA_PIXEL = 0;
        static DOM_DELTA_LINE = 1;
        static DOM_DELTA_PAGE = 2;
    }

    class TouchEvent extends UIEvent {
        constructor(type, options = {}) {
            super(type, { bubbles: true, cancelable: true, ...options });
            this.touches = options.touches || [];
            this.targetTouches = options.targetTouches || [];
            this.changedTouches = options.changedTouches || [];
            this.ctrlKey = !!options.ctrlKey;
            this.shiftKey = !!options.shiftKey;
            this.altKey = !!options.altKey;
            this.metaKey = !!options.metaKey;
        }
    }

    class MessageEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            this.data = options.data !== undefined ? options.data : null;
            this.origin = options.origin || "";
            this.lastEventId = options.lastEventId || "";
            this.source = options.source || null;
            this.ports = options.ports || [];
        }
    }

    class ErrorEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            this.message = options.message || "";
            this.filename = options.filename || "";
            this.lineno = options.lineno || 0;
            this.colno = options.colno || 0;
            this.error = options.error || null;
        }
    }

    class ProgressEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            this.lengthComputable = !!options.lengthComputable;
            this.loaded = options.loaded || 0;
            this.total = options.total || 0;
        }
    }

    class AnimationEvent extends Event {
        constructor(type, options = {}) {
            super(type, { bubbles: true, ...options });
            this.animationName = options.animationName || "";
            this.elapsedTime = options.elapsedTime || 0;
            this.pseudoElement = options.pseudoElement || "";
        }
    }

    class TransitionEvent extends Event {
        constructor(type, options = {}) {
            super(type, { bubbles: true, ...options });
            this.propertyName = options.propertyName || "";
            this.elapsedTime = options.elapsedTime || 0;
            this.pseudoElement = options.pseudoElement || "";
        }
    }

    class ClipboardEvent extends Event {
        constructor(type, options = {}) {
            super(type, { bubbles: true, cancelable: true, ...options });
            this.clipboardData = options.clipboardData || null;
        }
    }

    class PopStateEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            this.state = options.state !== undefined ? options.state : null;
        }
    }

    class HashChangeEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            this.oldURL = options.oldURL || "";
            this.newURL = options.newURL || "";
        }
    }

    class StorageEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            this.key = options.key || null;
            this.oldValue = options.oldValue || null;
            this.newValue = options.newValue || null;
            this.url = options.url || "";
            this.storageArea = options.storageArea || null;
        }
    }

    class PageTransitionEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            this.persisted = !!options.persisted;
        }
    }

    class BeforeUnloadEvent extends Event {
        constructor(type, options = {}) {
            super(type, { cancelable: true, ...options });
            this.returnValue = "";
        }
    }

    class DragEvent extends MouseEvent {
        constructor(type, options = {}) {
            super(type, options);
            this.dataTransfer = options.dataTransfer || null;
        }
    }

    // --- EventTarget core logic ---
    const _nodeListeners = new Map(); // nodeId → Map<eventType, [{callback, capture, once}]>
    let _objListeners = new WeakMap(); // object → Map<eventType, [{callback, capture, once}]>

    // Warm-reuse listener reaper — the events-side analogue of
    // `timer_bootstrap.js`'s `__cancelAllTimers()`. A pooled `Page`
    // (`PagePool` / `Page::navigate_warm`) keeps ONE `JsRuntime` alive across
    // navigations, so both registries above outlive the document they were
    // populated for. Two distinct failures follow:
    //
    //   * Leak. `_objListeners` is keyed by target *object*; listeners a page
    //     attaches to `window`/`globalThis` (analytics, scroll handlers, …)
    //     are keyed against the one global that is never collected for the
    //     life of the isolate, so those callbacks — and every closure
    //     variable they capture, which can be the page's whole object graph —
    //     are retained forever. `_nodeListeners` is worse: it is a *strong*
    //     Map that is never pruned at all. Measured at ~10 MB/page of live
    //     (non-GC-able) V8 heap on real product pages, unbounded.
    //   * Cross-page misfire. `_nodeListeners` is keyed by `nodeId`, and node
    //     IDs restart from zero when `replace_dom` swaps the document. The
    //     previous page's handler for node 42 therefore fires on the *new*
    //     page's node 42.
    //
    // Called from `Page::reset_for_reuse` alongside `__cancelAllTimers()`.
    // Non-enumerable so it does not widen `Object.getOwnPropertyNames(window)`.
    Object.defineProperty(globalThis, '__cancelAllListeners', {
        value: function __cancelAllListeners() {
            _nodeListeners.clear();
            // Reassign rather than clear: WeakMap has no `clear()`, and the
            // whole point is to drop the `window`-keyed entry.
            _objListeners = new WeakMap();
        },
        writable: true,
        configurable: true,
        enumerable: false,
    });

    const _getNodeIdOrMinusOne = (globalThis.__browser_oxide && globalThis.__browser_oxide._getNodeId)
        ? globalThis.__browser_oxide._getNodeId
        : (() => -1);

    function _getListenersMap(target) {
        const nodeId = _getNodeIdOrMinusOne(target);
        // Node IDs: >0 for elements/text, 0 for document (sometimes), -999 for window.
        // We use the Map for any node that has a stable ID.
        if (nodeId !== -1) {
            let m = _nodeListeners.get(nodeId);
            if (!m) { m = new Map(); _nodeListeners.set(nodeId, m); }
            return m;
        } else {
            let m = _objListeners.get(target);
            if (!m) { m = new Map(); _objListeners.set(target, m); }
            return m;
        }
    }

    function _getListeners(target, type) {
        const nodeMap = _getListenersMap(target);
        let arr = nodeMap.get(type);
        if (!arr) { arr = []; nodeMap.set(type, arr); }
        return arr;
    }

    const _addEventListener = function addEventListener(type, callback, options) {
        if (typeof callback !== "function" && typeof callback !== "object") return;
        const capture = typeof options === "boolean" ? options : !!(options && options.capture);
        const once = typeof options === "object" && options ? !!options.once : false;
        const passive = typeof options === "object" && options ? !!options.passive : false;
        const listeners = _getListeners(this, type);
        // Prevent duplicate
        if (listeners.some(l => l.callback === callback && l.capture === capture)) return;
        listeners.push({ callback, capture, once, passive });
    };

    const _removeEventListener = function removeEventListener(type, callback, options) {
        const capture = typeof options === "boolean" ? options : !!(options && options.capture);
        const listeners = _getListeners(this, type);
        const idx = listeners.findIndex(l => l.callback === callback && l.capture === capture);
        if (idx !== -1) listeners.splice(idx, 1);
    };

    const _dispatchEvent = function dispatchEvent(event) {
        if (!(event instanceof Event)) {
            throw new TypeError("Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.");
        }
        event.target = this;
        const nodeId = _getNodeIdOrMinusOne(this);

        // Build propagation path (target → root) if it's a DOM node.
        // Real Chrome's EventTarget.prototype.dispatchEvent handles the
        // tree-walk automatically if 'this' is a Node.
        const path = [];
        if (nodeId !== -1 && this.parentNode !== undefined) {
            let current = this;
            while (current) {
                path.push(current);
                current = current.parentNode;
            }
        }
        // The window is the last stop on the path, and it was missing.
        //
        // Propagation ended at `document`, so a listener bound to `window` —
        // which is where page-wide handlers live, and where behavioural
        // telemetry records pointer motion — never saw a single event. A widget
        // scoring the gesture read an empty motion trace, a drag implementation
        // listening on the window got no moves at all, and an answer derived
        // from "the last position the pointer was seen at" came out as the
        // origin because the pointer had never been seen.
        if (path.length && path[path.length - 1] === globalThis.document) {
            path.push(globalThis);
        } else if (this === globalThis.document) {
            path.push(this, globalThis);
        }

        // Capture phase (root → target)
        if (path.length > 0 && !event._stopped) {
            for (let i = path.length - 1; i > 0; i--) {
                event.currentTarget = path[i];
                event.eventPhase = 1;
                _fireListeners(path[i], event, true);
                if (event._stopped) break;
            }
        }

        // Target phase
        if (!event._stopped) {
            event.currentTarget = this;
            event.eventPhase = 2;
            _fireListeners(this, event, false);
            _fireListeners(this, event, true);
        }

        // Bubble phase (target → root)
        if (path.length > 0 && !event._stopped && event.bubbles) {
            for (let i = 1; i < path.length; i++) {
                event.currentTarget = path[i];
                event.eventPhase = 3;
                _fireListeners(path[i], event, false);
                if (event._stopped) break;
            }
        }

        event.eventPhase = 0;
        event.currentTarget = null;
        return !event.defaultPrevented;
    };

    /// Surface an exception nobody caught, the way a browser does: fire a
    /// cancelable `error` event on the window, and log it if no handler
    /// cancelled it.
    ///
    /// The engine used to swallow these completely — a throw from a timer
    /// callback, an injected `<script>`, or a page's own top-level code
    /// reached neither `window.onerror` nor the console. Pages that report
    /// errors through `window.onerror` saw nothing, and every silent failure
    /// (a framework bailing out mid-hydration, say) was invisible from the
    /// outside, which is both a behavioural difference from Chrome and the
    /// reason such failures were undiagnosable here.
    function _reportUncaught(err, source, lineno, colno) {
        let handled = false;
        try {
            const msg = (err && err.message)
                ? `Uncaught ${(err.name || "Error")}: ${err.message}`
                : `Uncaught ${String(err)}`;
            let event = null;
            try {
                event = new ErrorEvent("error", {
                    message: msg,
                    filename: source || "",
                    lineno: lineno || 0,
                    colno: colno || 0,
                    error: err,
                    cancelable: true,
                });
            } catch (_) { /* ErrorEvent not up yet */ }
            if (event) {
                _dispatchEvent.call(globalThis, event);
                handled = !!event.defaultPrevented;
            }
            if (!handled) {
                try { console.error(err); } catch (_) { /* ignore */ }
            }
        } catch (_) { /* reporting must never throw */ }
        return handled;
    }

    /// An exception out of an event handler, with enough context to find it:
    /// the message alone says nothing about which dispatch it came from.
    function _reportListenerError(err, event, target, handler) {
        let where = "";
        try {
            const type = (event && event.type) || "?";
            const tag = target && target.tagName
                ? target.tagName.toLowerCase()
                : (target === globalThis ? "window" : (target && target.nodeName) || "?");
            let src = "";
            try {
                if (typeof handler === "function") {
                    src = " | обработчик: " + String(handler).replace(/\s+/g, " ").slice(0, 200);
                }
            } catch (_) { /* ignore */ }
            where = ` [событие ${type} на ${tag}]${src}`;
        } catch (_) { /* ignore */ }
        try {
            console.error(err, where);
        } catch (_) { /* ignore */ }
    }

    function _fireListeners(target, event, capturePhase) {
        // --- 1. Fire on* handler (Target phase only, not capture phase) ---
        if (!capturePhase && !event._stoppedImmediate) {
            const handlerName = `on${event.type}`;
            const handler = target[handlerName];
            if (typeof handler === "function") {
                try {
                    // `window.onerror` is the one OnErrorEventHandler: for an
                    // ErrorEvent on the window it takes
                    // (message, source, lineno, colno, error), not the event,
                    // and cancels by returning true rather than by
                    // preventDefault.
                    if (target === globalThis && event.type === "error"
                        && typeof event.message === "string") {
                        const r = handler.call(
                            target, event.message, event.filename,
                            event.lineno, event.colno, event.error,
                        );
                        if (r === true) event.preventDefault();
                    } else {
                        handler.call(target, event);
                    }
                } catch (e) {
                    _reportListenerError(e, event, target, handler);
                }
            }
        }

        // --- 2. Fire registered listeners ---
        const listeners = _getListeners(target, event.type);
        const toRemove = [];
        for (let i = 0; i < listeners.length; i++) {
            const l = listeners[i];
            if (l.capture !== capturePhase) continue;
            if (event._stoppedImmediate) break;
            // Each listener is isolated. Letting one throw out of the loop
            // aborted the whole dispatch: every listener after it — and the rest
            // of `dispatchEvent` — was skipped, so one widget's bad handler took
            // down handlers that had nothing to do with it. The spec says report
            // the exception and carry on.
            try {
                if (typeof l.callback === "function") {
                    l.callback.call(target, event);
                } else if (l.callback && typeof l.callback.handleEvent === "function") {
                    l.callback.handleEvent(event);
                }
            } catch (e) {
                _reportListenerError(e, event, target, l.callback);
            }
            if (l.once) toRemove.push(i);
        }
        for (let i = toRemove.length - 1; i >= 0; i--) {
            listeners.splice(toRemove[i], 1);
        }
    }

    // Install on EventTarget.prototype — this is the canonical location.
    // Real Chrome has them as configurable/writable/enumerable=true.
    const _ET = globalThis.EventTarget;
    if (_ET && _ET.prototype) {
        const proto = _ET.prototype;
        Object.defineProperty(proto, 'addEventListener', {
            value: _addEventListener, writable: true, enumerable: true, configurable: true,
        });
        Object.defineProperty(proto, 'removeEventListener', {
            value: _removeEventListener, writable: true, enumerable: true, configurable: true,
        });
        Object.defineProperty(proto, 'dispatchEvent', {
            value: _dispatchEvent, writable: true, enumerable: true, configurable: true,
        });
    }

    // Ensure Node.prototype does NOT shadow these. Real Chrome's
    // Node.prototype does not have its own addEventListener.
    const origNodeProto = globalThis.Node.prototype;
    if (origNodeProto) {
        delete origNodeProto.addEventListener;
        delete origNodeProto.removeEventListener;
        delete origNodeProto.dispatchEvent;
    }

    // Native-code masking — some scripts run
    // `Function.prototype.toString.call(addEventListener)` against both
    // window-level and prototype-level methods. Each must serialize as
    // `function NAME() { [native code] }`, as in a real browser.
    if (typeof _maskFunction === 'function') {
        _maskFunction(_addEventListener, 'addEventListener');
        _maskFunction(_removeEventListener, 'removeEventListener');
        _maskFunction(_dispatchEvent, 'dispatchEvent');
    }

    // Window (globalThis) inheritance: real Chrome's Window inherits from
    // EventTarget via the prototype chain. Our Window setup (Window →
    // WindowProperties → EventTarget) should already handle this, but
    // we ensure the global aliases are correct.
    const _winProto = Object.getPrototypeOf(globalThis);
    if (_winProto && _winProto !== Object.prototype) {
        // Just ensure they are there if not inherited.
        if (!('addEventListener' in _winProto)) {
            Object.defineProperty(_winProto, 'addEventListener', {
                value: _addEventListener, writable: true, enumerable: true, configurable: true,
            });
        }
        if (!('removeEventListener' in _winProto)) {
            Object.defineProperty(_winProto, 'removeEventListener', {
                value: _removeEventListener, writable: true, enumerable: true, configurable: true,
            });
        }
        if (!('dispatchEvent' in _winProto)) {
            Object.defineProperty(_winProto, 'dispatchEvent', {
                value: _dispatchEvent, writable: true, enumerable: true, configurable: true,
            });
        }
    } else {
        globalThis.addEventListener = _addEventListener;
        globalThis.removeEventListener = _removeEventListener;
        globalThis.dispatchEvent = _dispatchEvent;
    }

    // Export all event classes
    // SecurityPolicyViolationEvent — what real Chrome dispatches on
    // `document` (and propagates to `window`) when a CSP rule blocks
    // a fetch. Sites can listen for `securitypolicyviolation` to log
    // their own violations; we must surface the same shape so that
    // analytics/telemetry code probing the event fires correctly.
    // Spec: https://www.w3.org/TR/CSP3/#securitypolicyviolationevent
    class SecurityPolicyViolationEvent extends Event {
        constructor(type, init) {
            super(type, init || {});
            const i = init || {};
            this.blockedURI = String(i.blockedURI ?? "");
            this.documentURI = String(i.documentURI ?? (typeof location !== 'undefined' ? location.href : ""));
            this.referrer = String(i.referrer ?? (typeof document !== 'undefined' && document.referrer ? document.referrer : ""));
            this.violatedDirective = String(i.violatedDirective ?? "");
            this.effectiveDirective = String(i.effectiveDirective ?? this.violatedDirective);
            this.originalPolicy = String(i.originalPolicy ?? "");
            this.disposition = String(i.disposition ?? "enforce");
            this.sample = String(i.sample ?? "");
            this.sourceFile = String(i.sourceFile ?? "");
            this.statusCode = +i.statusCode || 0;
            this.lineNumber = +i.lineNumber || 0;
            this.columnNumber = +i.columnNumber || 0;
        }
    }

    globalThis.Event = Event;
    globalThis.CustomEvent = CustomEvent;
    globalThis.SecurityPolicyViolationEvent = SecurityPolicyViolationEvent;
    globalThis.UIEvent = UIEvent;
    globalThis.MouseEvent = MouseEvent;
    globalThis.KeyboardEvent = KeyboardEvent;
    globalThis.InputEvent = InputEvent;
    globalThis.FocusEvent = FocusEvent;
    globalThis.PointerEvent = PointerEvent;
    globalThis.WheelEvent = WheelEvent;
    globalThis.TouchEvent = TouchEvent;
    globalThis.MessageEvent = MessageEvent;
    globalThis.ErrorEvent = ErrorEvent;
    // Only a name in the interface list until now, so `new
    // PromiseRejectionEvent(...)` produced something without `.reason` /
    // `.promise` — useless for the `unhandledrejection` delivery below.
    class PromiseRejectionEvent extends Event {
        constructor(type, init) {
            super(type, init || {});
            const i = init || {};
            this.promise = i.promise;
            this.reason = i.reason;
        }
    }
    Object.defineProperty(PromiseRejectionEvent.prototype, Symbol.toStringTag, {
        value: "PromiseRejectionEvent", configurable: true,
    });
    globalThis.PromiseRejectionEvent = PromiseRejectionEvent;
    globalThis.ProgressEvent = ProgressEvent;
    globalThis.AnimationEvent = AnimationEvent;
    globalThis.TransitionEvent = TransitionEvent;
    globalThis.ClipboardEvent = ClipboardEvent;
    globalThis.PopStateEvent = PopStateEvent;
    globalThis.HashChangeEvent = HashChangeEvent;
    globalThis.StorageEvent = StorageEvent;
    globalThis.PageTransitionEvent = PageTransitionEvent;
    globalThis.BeforeUnloadEvent = BeforeUnloadEvent;
    globalThis.DragEvent = DragEvent;
    // EventTarget is already defined in dom_bootstrap.js as the base of
    // the Node prototype chain — do not reassign it here or the
    // `document instanceof EventTarget` check will break.

    // Privileged handoff of the trusted-event minter (behavioral E1/E2). Our
    // init scripts (humanize.js) capture this into a closure and `delete` it
    // synchronously at their top — before any page script runs — so page JS
    // never observes it. Non-enumerable to keep it off Object.keys scans even
    // in the brief window before capture.
    try {
        Object.defineProperty(globalThis, '__bo_mark_trusted', {
            value: _markTrusted,
            configurable: true,
            enumerable: false,
            writable: false,
        });
    } catch (_) { /* ignore */ }

    // Timers and the host both need the uncaught-error reporter, and both run
    // long after this file: park it on the engine's symbol-keyed namespace
    // rather than adding a named global the page could enumerate.
    try {
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
        if (_ns) _ns.reportUncaught = _reportUncaught;
    } catch (_) { /* ignore */ }

    // Unhandled promise rejections reach `window.onunhandledrejection` /
    // `unhandledrejection` listeners, as in a browser. Without this hook
    // deno_core drains them into its own default (a process-level
    // exception this engine ignores), so a page whose async bootstrap
    // rejected simply stopped, reporting nothing anywhere.
    //
    // Returning `true` tells deno_core the rejection is accounted for; we
    // return it only when a page handler actually cancelled the event, so a
    // genuinely unhandled rejection still reaches the console.
    try {
        Deno.core.setUnhandledPromiseRejectionHandler((promise, reason) => {
            try {
                const event = new PromiseRejectionEvent("unhandledrejection", {
                    promise, reason, cancelable: true,
                });
                _dispatchEvent.call(globalThis, event);
                if (event.defaultPrevented) return true;
            } catch (_) { /* fall through to the log */ }
            try {
                console.error("Uncaught (in promise)", reason);
            } catch (_) { /* ignore */ }
            return true;
        });
    } catch (_) { /* ignore */ }
})(globalThis);
