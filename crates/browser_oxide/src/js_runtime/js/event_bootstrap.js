((globalThis) => {
    // Looked up once at module load — dom_bootstrap.js runs first and has
    // already installed it — rather than scanning
    // `Object.getOwnPropertySymbols(globalThis, 1)` on every single dispatch,
    // which `_dispatchEvent` is.
    const _boNs = (function () {
        try {
            const syms = Object.getOwnPropertySymbols(globalThis, 1);
            for (let i = 0; i < syms.length; i++) {
                const v = globalThis[syms[i]];
                if (v && v.__bo) return v;
            }
        } catch (_e) { /* ignore */ }
        return null;
    })();
    const _idl = (_boNs && _boNs.idl) || {
        own: (obj) => obj,
        read: () => undefined,
        fields: () => {},
    };

    // ---- Trusted-event authenticity (v0.1.0 behavioral E1) ----------------
    // `isTrusted` MUST be both unforgeable and shaped like a real browser's:
    //   * an own, non-configurable GETTER on every event instance — NOT a data
    //     property and not a member of Event.prototype. Chrome 153 reports
    //     {get: f, set: undefined, enumerable: true, configurable: false} on
    //     the instance, and `Event.prototype` carries no `isTrusted` at all
    //     ([LegacyUnforgeable] in the IDL).
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

    const _isTrustedGetter = (() => {
        const get = function () { return _trustedEvents.has(this); };
        return (typeof _maskFunction === 'function')
            ? _maskFunction(get, 'get isTrusted') : get;
    })();

    // Chrome keeps every event attribute on the prototype as an accessor and
    // leaves the instance without own properties; ours were plain instance data
    // properties, which a surface diff sees immediately. The state lives in a
    // WeakMap now and `_evFields` installs the IDL accessors.
    const _evStates = new WeakMap();
    const _evOwn = (ev) => {
        let st = _evStates.get(ev);
        if (!st) _evStates.set(ev, (st = { __proto__: null }));
        return st;
    };
    const _evGet = (ev, name, fallback) => {
        const st = _evStates.get(ev);
        return st && name in st ? st[name] : fallback;
    };
    const _evFields = (proto, names) => {
        for (const name of names) {
            if (Object.prototype.hasOwnProperty.call(proto, name)) continue;
            const get = Object.getOwnPropertyDescriptor({
                get [name]() { return _evGet(this, name, undefined); },
            }, name).get;
            if (typeof _maskFunction === 'function') _maskFunction(get, 'get ' + name);
            Object.defineProperty(proto, name, { get, enumerable: true, configurable: true });
        }
    };

    class Event {
        constructor(type, options = {}) {
            const _st = _evOwn(this);
            _st.type = String(type);
            _st.bubbles = !!options.bubbles;
            _st.cancelable = !!options.cancelable;
            _st.composed = !!options.composed;
            _st.defaultPrevented = false;
            _st.target = null;
            _st.currentTarget = null;
            _st.eventPhase = 0;
            // `isTrusted` reads the private WeakSet — false for page-constructed
            // events, true only when our privileged dispatch path calls
            // `_markTrusted(ev)`.
            Object.defineProperty(this, 'isTrusted', {
                get: _isTrustedGetter, enumerable: true, configurable: false,
            });
            _st.timeStamp = performance.now();
            _st._stopped = false;
            _st._stoppedImmediate = false;
        }
        preventDefault() {
            const _st = _evOwn(this);
            if (this.cancelable) _st.defaultPrevented = true;
        }
        /// Legacy initialiser, still used by plenty of shipped code — including
        /// hCaptcha's own error path, which threw `initEvent is not a function`
        /// and in doing so swallowed whatever error it was reporting.
        initEvent(type, bubbles, cancelable) {
            const _st = _evOwn(this);
            _st.type = String(type);
            _st.bubbles = !!bubbles;
            _st.cancelable = !!cancelable;
        }
        stopPropagation() {
            const _st = _evOwn(this); _st._stopped = true; }
        stopImmediatePropagation() {
            const _st = _evOwn(this); _st._stopped = true; _st._stoppedImmediate = true; }
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
    _evFields(Event.prototype, ["bubbles", "cancelable", "composed", "currentTarget", "defaultPrevented", "eventPhase", "target", "timeStamp", "type"]);


    class CustomEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            const _st = _evOwn(this);
            _st.detail = options.detail !== undefined ? options.detail : null;
        }
        initCustomEvent(type, bubbles, cancelable, detail) {
            const _st = _evOwn(this);
            _st.type = type;
            _st.bubbles = bubbles;
            _st.cancelable = cancelable;
            _st.detail = detail;
        }
    }
    _evFields(CustomEvent.prototype, ["detail"]);

    // `which` lives on UIEvent.prototype in Chrome, never on the subclasses;
    // a legacy `which` passed through an init dict is remembered here.
    const _whichSlot = new WeakMap();

    // --- UI Event hierarchy ---
    class UIEvent extends Event {
        initUIEvent(type, bubbles, cancelable, view, detail) {
            const _st = _evOwn(this);
            this.initEvent(type, bubbles, cancelable);
            _st.view = view || null;
            _st.detail = detail || 0;
        }
        get which() {
            const forced = _whichSlot.get(this);
            if (forced !== undefined) return forced;
            if (typeof this.keyCode === "number") return this.keyCode;
            return typeof this.button === "number" ? this.button + 1 : 0;
        }
        constructor(type, options = {}) {
            super(type, options);
            const _st = _evOwn(this);
            _st.view = options.view || globalThis;
            _st.detail = options.detail || 0;
            if (options.which != null) _whichSlot.set(this, options.which | 0);
        }
    }
    _evFields(UIEvent.prototype, ["detail", "view"]);

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
            const _st = _evOwn(this);
            _st.screenX = options.screenX || 0;
            _st.screenY = options.screenY || 0;
            _st.clientX = options.clientX || 0;
            _st.clientY = options.clientY || 0;
            _st.pageX = options.pageX || this.clientX;
            _st.pageY = options.pageY || this.clientY;
            _st.button = options.button || 0;
            _st.buttons = options.buttons || 0;
            _st.ctrlKey = !!options.ctrlKey;
            _st.shiftKey = !!options.shiftKey;
            _st.altKey = !!options.altKey;
            _st.metaKey = !!options.metaKey;
            _st.relatedTarget = options.relatedTarget || null;
            _st.movementX = options.movementX || 0;
            _st.movementY = options.movementY || 0;
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
        initMouseEvent(type, bubbles, cancelable, view, detail, screenX, screenY,
                       clientX, clientY, ctrlKey, altKey, shiftKey, metaKey,
                       button, relatedTarget) {
            const _st = _evOwn(this);
            this.initUIEvent(type, bubbles, cancelable, view, detail);
            _st.screenX = screenX || 0;
            _st.screenY = screenY || 0;
            _st.clientX = clientX || 0;
            _st.clientY = clientY || 0;
            _st.ctrlKey = !!ctrlKey;
            _st.altKey = !!altKey;
            _st.shiftKey = !!shiftKey;
            _st.metaKey = !!metaKey;
            _st.button = button || 0;
            _st.relatedTarget = relatedTarget || null;
        }
        getModifierState(key) { return false; }
    }
    _evFields(MouseEvent.prototype, ["altKey", "button", "buttons", "clientX", "clientY", "ctrlKey", "metaKey", "movementX", "movementY", "pageX", "pageY", "relatedTarget", "screenX", "screenY", "shiftKey"]);

    class KeyboardEvent extends UIEvent {
        constructor(type, options = {}) {
            super(type, { bubbles: true, cancelable: true, ...options });
            const _st = _evOwn(this);
            _st.key = options.key || "";
            _st.code = options.code || "";
            _st.keyCode = options.keyCode || 0;
            _st.charCode = options.charCode || 0;
            _whichSlot.set(this, options.which || options.keyCode || 0);
            _st.ctrlKey = !!options.ctrlKey;
            _st.shiftKey = !!options.shiftKey;
            _st.altKey = !!options.altKey;
            _st.metaKey = !!options.metaKey;
            _st.repeat = !!options.repeat;
            _st.isComposing = !!options.isComposing;
            _st.location = options.location || 0;
        }
        getModifierState(key) { return false; }
    }
    _evFields(KeyboardEvent.prototype, ["altKey", "charCode", "code", "ctrlKey", "isComposing", "key", "keyCode", "location", "metaKey", "repeat", "shiftKey"]);

    class InputEvent extends UIEvent {
        constructor(type, options = {}) {
            super(type, { bubbles: true, cancelable: false, ...options });
            const _st = _evOwn(this);
            _st.data = options.data || null;
            _st.inputType = options.inputType || "";
            _st.isComposing = !!options.isComposing;
        }
    }
    _evFields(InputEvent.prototype, ["data", "inputType", "isComposing"]);

    class FocusEvent extends UIEvent {
        constructor(type, options = {}) {
            super(type, options);
            const _st = _evOwn(this);
            _st.relatedTarget = options.relatedTarget || null;
        }
    }
    _evFields(FocusEvent.prototype, ["relatedTarget"]);

    class PointerEvent extends MouseEvent {
        constructor(type, options = {}) {
            super(type, options);
            const _st = _evOwn(this);
            _st.pointerId = options.pointerId || 0;
            _st.width = options.width || 1;
            _st.height = options.height || 1;
            _st.pressure = options.pressure || 0;
            _st.tangentialPressure = options.tangentialPressure || 0;
            _st.tiltX = options.tiltX || 0;
            _st.tiltY = options.tiltY || 0;
            _st.twist = options.twist || 0;
            _st.pointerType = options.pointerType || "mouse";
            _st.isPrimary = options.isPrimary !== undefined ? options.isPrimary : true;
            _st.altitudeAngle = options.altitudeAngle !== undefined
                ? options.altitudeAngle : Math.PI / 2;
            _st.azimuthAngle = options.azimuthAngle || 0;
            _st.persistentDeviceId = options.persistentDeviceId || 0;
        }
        // Dispatched events carry no coalesced or predicted samples, which is
        // also what Chrome reports for one it did not coalesce. Missing entirely,
        // they threw out of any move handler that asked — and a drag handler is
        // the usual caller.
        getCoalescedEvents() { return [this]; }
        getPredictedEvents() { return []; }
    }
    _evFields(PointerEvent.prototype, ["altitudeAngle", "azimuthAngle", "height", "isPrimary", "persistentDeviceId", "pointerId", "pointerType", "pressure", "tangentialPressure", "tiltX", "tiltY", "twist", "width"]);

    class WheelEvent extends MouseEvent {
        constructor(type, options = {}) {
            super(type, options);
            const _st = _evOwn(this);
            _st.deltaX = options.deltaX || 0;
            _st.deltaY = options.deltaY || 0;
            _st.deltaZ = options.deltaZ || 0;
            _st.deltaMode = options.deltaMode || 0;
        }
        static DOM_DELTA_PIXEL = 0;
        static DOM_DELTA_LINE = 1;
        static DOM_DELTA_PAGE = 2;
    }
    _evFields(WheelEvent.prototype, ["deltaMode", "deltaX", "deltaY", "deltaZ"]);

    class TouchEvent extends UIEvent {
        constructor(type, options = {}) {
            super(type, { bubbles: true, cancelable: true, ...options });
            const _st = _evOwn(this);
            _st.touches = options.touches || [];
            _st.targetTouches = options.targetTouches || [];
            _st.changedTouches = options.changedTouches || [];
            _st.ctrlKey = !!options.ctrlKey;
            _st.shiftKey = !!options.shiftKey;
            _st.altKey = !!options.altKey;
            _st.metaKey = !!options.metaKey;
        }
    }
    _evFields(TouchEvent.prototype, ["altKey", "changedTouches", "ctrlKey", "metaKey", "shiftKey", "targetTouches", "touches"]);

    class MessageEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            const _st = _evOwn(this);
            _st.data = options.data !== undefined ? options.data : null;
            _st.origin = options.origin || "";
            _st.lastEventId = options.lastEventId || "";
            _st.source = options.source || null;
            _st.ports = options.ports || [];
        }
    }
    _evFields(MessageEvent.prototype, ["data", "lastEventId", "origin", "ports", "source"]);

    class ErrorEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            const _st = _evOwn(this);
            _st.message = options.message || "";
            _st.filename = options.filename || "";
            _st.lineno = options.lineno || 0;
            _st.colno = options.colno || 0;
            _st.error = options.error || null;
        }
    }
    _evFields(ErrorEvent.prototype, ["colno", "error", "filename", "lineno", "message"]);

    class ProgressEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            const _st = _evOwn(this);
            _st.lengthComputable = !!options.lengthComputable;
            _st.loaded = options.loaded || 0;
            _st.total = options.total || 0;
        }
    }
    _evFields(ProgressEvent.prototype, ["lengthComputable", "loaded", "total"]);

    class AnimationEvent extends Event {
        constructor(type, options = {}) {
            super(type, { bubbles: true, ...options });
            const _st = _evOwn(this);
            _st.animationName = options.animationName || "";
            _st.elapsedTime = options.elapsedTime || 0;
            _st.pseudoElement = options.pseudoElement || "";
        }
    }
    _evFields(AnimationEvent.prototype, ["animationName", "elapsedTime", "pseudoElement"]);

    class TransitionEvent extends Event {
        constructor(type, options = {}) {
            super(type, { bubbles: true, ...options });
            const _st = _evOwn(this);
            _st.propertyName = options.propertyName || "";
            _st.elapsedTime = options.elapsedTime || 0;
            _st.pseudoElement = options.pseudoElement || "";
        }
    }
    _evFields(TransitionEvent.prototype, ["elapsedTime", "propertyName", "pseudoElement"]);

    class ClipboardEvent extends Event {
        constructor(type, options = {}) {
            super(type, { bubbles: true, cancelable: true, ...options });
            const _st = _evOwn(this);
            _st.clipboardData = options.clipboardData || null;
        }
    }
    _evFields(ClipboardEvent.prototype, ["clipboardData"]);

    class PopStateEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            const _st = _evOwn(this);
            _st.state = options.state !== undefined ? options.state : null;
        }
    }
    _evFields(PopStateEvent.prototype, ["state"]);

    class HashChangeEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            const _st = _evOwn(this);
            _st.oldURL = options.oldURL || "";
            _st.newURL = options.newURL || "";
        }
    }
    _evFields(HashChangeEvent.prototype, ["newURL", "oldURL"]);

    class StorageEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            const _st = _evOwn(this);
            _st.key = options.key || null;
            _st.oldValue = options.oldValue || null;
            _st.newValue = options.newValue || null;
            _st.url = options.url || "";
            _st.storageArea = options.storageArea || null;
        }
    }
    _evFields(StorageEvent.prototype, ["key", "newValue", "oldValue", "storageArea", "url"]);

    class PageTransitionEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            const _st = _evOwn(this);
            _st.persisted = !!options.persisted;
        }
    }
    _evFields(PageTransitionEvent.prototype, ["persisted"]);

    class BeforeUnloadEvent extends Event {
        constructor(type, options = {}) {
            super(type, { cancelable: true, ...options });
            const _st = _evOwn(this);
            _st.returnValue = "";
        }
    }
    Object.defineProperty(BeforeUnloadEvent.prototype, "returnValue", {
        get() { return _evGet(this, "returnValue", ""); },
        set(v) { _evOwn(this).returnValue = v; },
        enumerable: true, configurable: true,
    });

    class DragEvent extends MouseEvent {
        constructor(type, options = {}) {
            super(type, options);
            const _st = _evOwn(this);
            _st.dataTransfer = options.dataTransfer || null;
        }
    }
    _evFields(DragEvent.prototype, ["dataTransfer"]);

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
        if (callback == null) return;
        if (typeof callback !== "function" && typeof callback !== "object") return;
        const capture = typeof options === "boolean" ? options : !!(options && options.capture);
        const once = typeof options === "object" && options ? !!options.once : false;
        const passive = typeof options === "object" && options ? !!options.passive : false;
        const signal = options && options.signal;
        if (signal && signal.aborted) return;
        const listeners = _getListeners(this, type);
        // Prevent duplicate
        if (listeners.some(l => l.callback === callback && l.capture === capture)) return;
        const listener = { callback, capture, once, passive, signal, removed: false };
        if (signal) {
            listener.abort = () => _removeListener(listeners, listener);
            signal.addEventListener('abort', listener.abort, { once: true });
        }
        listeners.push(listener);
    };

    function _removeListener(listeners, listener) {
        listener.removed = true;
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
        if (listener.signal) listener.signal.removeEventListener('abort', listener.abort);
    }

    const _removeEventListener = function removeEventListener(type, callback, options) {
        const capture = typeof options === "boolean" ? options : !!(options && options.capture);
        const listeners = _getListeners(this, type);
        const idx = listeners.findIndex(l => l.callback === callback && l.capture === capture);
        if (idx !== -1) _removeListener(listeners, listeners[idx]);
    };

    // Pointer capture retargeting.
    //
    // `setPointerCapture` had no effect on dispatch at all: `_pointerCaptures`
    // (dom_bootstrap.js) recorded the capture and fired `gotpointercapture`,
    // but every later `pointermove`/`pointerup` still went to whatever
    // `elementFromPoint` said, exactly as if nothing had been captured. A drag
    // implementation that captures on `pointerdown` — the standard pattern,
    // and the one a "move this piece" challenge uses — lost track of what it
    // was dragging the moment the pointer drifted off the piece's own box,
    // which a fast or coarse synthetic path does constantly. The widget's own
    // drag state then answered a question that was never actually asked:
    // where the piece ended up relative to nothing it was tracking.
    const _RETARGETS_ON_CAPTURE = new Set([
        "pointermove", "pointerup", "pointercancel", "mousemove", "mouseup",
    ]);
    // Implicit release happens after `mouseup`, not `pointerup`: every caller
    // in this engine fires pointerup then its mouse-compat pairing for the
    // same up gesture (POINTER_JS, humanize.js), so releasing only after the
    // second means both still see the same capture. `pointercancel` has no
    // such pairing and releases on its own.
    const _RELEASES_CAPTURE = new Set(["mouseup", "pointercancel"]);

    const _dispatchEvent = function dispatchEvent(event) {
        if (!(event instanceof Event)) {
            throw new TypeError("Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.");
        }
        let dispatchTarget = this;
        if (_RETARGETS_ON_CAPTURE.has(event.type)) {
            try {
                const pid = (typeof event.pointerId === "number") ? event.pointerId : 1;
                const captured = _boNs && _boNs.capturedTarget && _boNs.capturedTarget(pid);
                if (captured) dispatchTarget = captured;
            } catch (_e) { /* ignore */ }
        }
        _evOwn(event).target = dispatchTarget;
        const nodeId = _getNodeIdOrMinusOne(dispatchTarget);

        // Build propagation path (target → root) if it's a DOM node.
        // Real Chrome's EventTarget.prototype.dispatchEvent handles the
        // tree-walk automatically if 'this' is a Node.
        const path = [];
        if (nodeId !== -1 && dispatchTarget.parentNode !== undefined) {
            let current = dispatchTarget;
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
        } else if (dispatchTarget === globalThis.document) {
            path.push(dispatchTarget, globalThis);
        }

        // Capture phase (root → target)
        if (path.length > 0 && !_evGet(event, '_stopped', false)) {
            for (let i = path.length - 1; i > 0; i--) {
                _evOwn(event).currentTarget = path[i];
                _evOwn(event).eventPhase = 1;
                _fireListeners(path[i], event, true);
                if (_evGet(event, '_stopped', false)) break;
            }
        }

        // Target phase
        if (!_evGet(event, '_stopped', false)) {
            _evOwn(event).currentTarget = dispatchTarget;
            _evOwn(event).eventPhase = 2;
            _fireListeners(dispatchTarget, event, false);
            _fireListeners(dispatchTarget, event, true);
        }

        // Bubble phase (target → root)
        if (path.length > 0 && !_evGet(event, '_stopped', false) && event.bubbles) {
            for (let i = 1; i < path.length; i++) {
                _evOwn(event).currentTarget = path[i];
                _evOwn(event).eventPhase = 3;
                _fireListeners(path[i], event, false);
                if (_evGet(event, '_stopped', false)) break;
            }
        }

        _evOwn(event).eventPhase = 0;
        _evOwn(event).currentTarget = null;

        if (_RELEASES_CAPTURE.has(event.type)) {
            try {
                const pid = (typeof event.pointerId === "number") ? event.pointerId : 1;
                if (_boNs && _boNs.releaseCapture) _boNs.releaseCapture(pid, dispatchTarget);
            } catch (_e) { /* ignore */ }
        }

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
        if (!capturePhase && !_evGet(event, '_stoppedImmediate', false)) {
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
        for (const l of listeners.slice()) {
            if (l.removed || l.capture !== capturePhase) continue;
            if (_evGet(event, '_stoppedImmediate', false)) break;
            // Remove before invoking: a once listener can dispatch recursively.
            if (l.once) _removeListener(listeners, l);
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
        if (_ET && _ET.prototype && Object.getPrototypeOf(_winProto) === Object.prototype) {
            try {
                if (typeof Deno.core.ops.op_dom_document_node === 'function') {
                    const _windowProperties = Object.create(_ET.prototype);
                    Object.defineProperty(_windowProperties, Symbol.toStringTag, {
                        value: 'WindowProperties', configurable: true,
                    });
                    Object.setPrototypeOf(_winProto, _windowProperties);
                } else {
                    Object.setPrototypeOf(_winProto, _ET.prototype);
                }
            } catch (_) { /* fall back to own copies below */ }
        }
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
            const _st = _evOwn(this);
            const i = init || {};
            _st.blockedURI = String(i.blockedURI ?? "");
            _st.documentURI = String(i.documentURI ?? (typeof location !== 'undefined' ? location.href : ""));
            _st.referrer = String(i.referrer ?? (typeof document !== 'undefined' && document.referrer ? document.referrer : ""));
            _st.violatedDirective = String(i.violatedDirective ?? "");
            _st.effectiveDirective = String(i.effectiveDirective ?? this.violatedDirective);
            _st.originalPolicy = String(i.originalPolicy ?? "");
            _st.disposition = String(i.disposition ?? "enforce");
            _st.sample = String(i.sample ?? "");
            _st.sourceFile = String(i.sourceFile ?? "");
            _st.statusCode = +i.statusCode || 0;
            _st.lineNumber = +i.lineNumber || 0;
            _st.columnNumber = +i.columnNumber || 0;
        }
    }
    _evFields(SecurityPolicyViolationEvent.prototype, ["blockedURI", "columnNumber", "disposition", "documentURI", "effectiveDirective", "lineNumber", "originalPolicy", "referrer", "sample", "sourceFile", "statusCode", "violatedDirective"]);

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
            const _st = _evOwn(this);
            const i = init || {};
            _st.promise = i.promise;
            _st.reason = i.reason;
        }
    }
    _evFields(PromiseRejectionEvent.prototype, ["promise", "reason"]);
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
    // synchronously at their top — before any page script runs. It lives on the
    // engine's symbol-keyed namespace rather than a named global, so a page
    // loaded without humanize never shows it among window's properties.
    try {
        if (_boNs) {
            Object.defineProperty(_boNs, 'markTrusted', {
                value: _markTrusted,
                configurable: true,
                enumerable: false,
                writable: false,
            });
        }
    } catch (_) { /* ignore */ }

    // Timers and the host both need the uncaught-error reporter, and both run
    // long after this file: park it on the engine's symbol-keyed namespace
    // rather than adding a named global the page could enumerate.
    try {
        const _ns = (function () {
            try {
                const syms = Object.getOwnPropertySymbols(globalThis, 1);
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

    // PerformanceObserver / PerformanceEntry / ReportingObserver
    if (!globalThis.PerformanceObserver) {
        globalThis.PerformanceObserver = class PerformanceObserver {
            #cb;
            constructor(cb) { this.#cb = cb; }
            observe() {}
            disconnect() {}
            takeRecords() { return []; }
        };
        // Real Chrome exposes supportedEntryTypes as a static GETTER, not a
        // data property. Fingerprinters do Object.getOwnPropertyDescriptor
        // and a data descriptor is distinctive.
        Object.defineProperty(globalThis.PerformanceObserver, "supportedEntryTypes", {
            get() {
                return ["element", "event", "first-input", "largest-contentful-paint",
                        "layout-shift", "longtask", "mark", "measure", "navigation",
                        "paint", "resource", "visibility-state"];
            },
            configurable: true,
            enumerable: true,
        });
    }
    if (!globalThis.PerformanceEntry) {
        globalThis.PerformanceEntry = class PerformanceEntry {
            constructor() {
                const _st = _idl.own(this); _st.name = ""; _st.entryType = ""; _st.startTime = 0; _st.duration = 0; }
            toJSON() { return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration }; }
        };
    _idl.fields(PerformanceEntry.prototype, ["duration", "entryType", "name", "startTime"]);
    }

    if (!globalThis.ReportingObserver) {
        globalThis.ReportingObserver = class ReportingObserver {
            constructor() {}
            observe() {}
            disconnect() {}
            takeRecords() { return []; }
        };
    }

    if (!globalThis.BroadcastChannel) {
        globalThis.BroadcastChannel = class BroadcastChannel extends EventTarget {
            constructor(name) {
                super();
                _evOwn(this).name = String(name);
                this.onmessage = null;
                this.onmessageerror = null;
            }
            postMessage() {}
            close() {}
        };
        _evFields(globalThis.BroadcastChannel.prototype, ["name"]);
    }

    // Proper MessageChannel / MessagePort
    // implementation per HTML spec §9.4. The pre-fix no-op stub broke
    // any worker that relays via a channel. Behavior:
    //   - paired ports route postMessage bidirectionally
    //   - port stays in "non-started" mode until start() / onmessage
    //     setter / addEventListener('message') is called (HTML spec
    //     enables-message-dispatch trigger). Messages queued before
    //     enabling are delivered when enabled.
    //   - close() detaches the port from its pair; further postMessage
    //     is a silent no-op (spec: discard).
    // Structured-clone is approximated via globalThis.structuredClone
    // (the engine ships a real impl in structured_clone.js); falls back
    // to identity if unavailable so tests that bypass the polyfill
    // still see the right wiring.
    {
        const _PortPaired = new WeakMap();   // port → paired port
        const _PortQueue = new WeakMap();    // port → Array<msg> queued pre-start
        const _PortEnabled = new WeakMap();  // port → bool (start gate)
        const _PortClosed = new WeakMap();   // port → bool

        const _clone = (data) => {
            try {
                if (typeof globalThis.structuredClone === 'function') {
                    return globalThis.structuredClone(data);
                }
            } catch (_e) {}
            return data;
        };

        const _enable = (port) => {
            if (_PortEnabled.get(port)) return;
            _PortEnabled.set(port, true);
            const q = _PortQueue.get(port);
            if (!q || !q.length) return;
            _PortQueue.set(port, []);
            // Drain synchronously. HTML spec routes via the event loop;
            // we drain inline so that `port.onmessage = fn; port.start()`
            // sees its queued messages before control returns to the
            // caller (deno_core's microtask drain across `execute_script`
            // boundaries isn't reliable for this).
            for (const msg of q) _deliver(port, msg);
        };

        // Spec: addEventListener('message', …) implicitly enables dispatch, the
        // same as the onmessage setter. Chrome does that in C++; an override on
        // MessagePort.prototype would be an own method Chrome does not have, so
        // the check happens here instead — a queued port with a message
        // listener counts as started.
        const _hasMessageListener = (port) => {
            const map = _objListeners.get(port);
            const list = map && map.get('message');
            return !!(list && list.length);
        };

        const _deliver = (port, data) => {
            if (_PortClosed.get(port)) return;
            if (!_PortEnabled.get(port) && _hasMessageListener(port)) _enable(port);
            if (!_PortEnabled.get(port)) {
                let q = _PortQueue.get(port);
                if (!q) { q = []; _PortQueue.set(port, q); }
                q.push(data);
                return;
            }
            // Deliver as a MACROTASK, not synchronously. React 18's concurrent
            // scheduler is built on a MessageChannel: it sets port1.onmessage =
            // performWorkUntilDeadline and calls port2.postMessage(null) to
            // schedule the NEXT chunk of work, REQUIRING that callback to run on
            // a later task so it can yield between units. Synchronous re-entrant
            // delivery (the previous behaviour) ran performWorkUntilDeadline
            // inside postMessage — re-entering the scheduler — so the concurrent
            // render never completed and `#root` stayed an empty shell (the
            // thin-render gap on duolingo/douyin/adidas/ozon/wildberries). The
            // event loop drives this timer during the nav drain, so React's
            // render chain now runs to completion.
            const _fire = () => {
                if (_PortClosed.get(port)) return;
                try {
                    const ev = new MessageEvent('message', { data, bubbles: false, cancelable: false });
                    // dispatchEvent fires both addEventListener handlers AND the
                    // on-property (deno_core's EventTarget auto-promotes
                    // `onmessage`). Calling the on-property explicitly too would
                    // double-fire it.
                    port.dispatchEvent(ev);
                } catch (_e) {}
            };
            const _sched = globalThis.__bgSetTimeout || globalThis.setTimeout;
            try { _sched(_fire, 0); } catch (_e) { _fire(); }
        };

        globalThis.MessagePort = class MessagePort extends EventTarget {
            #onmessage;
            constructor() {
                super();
                this.#onmessage = null;
                this.onmessageerror = null;
            }
            get onmessage() { return this.#onmessage; }
            set onmessage(fn) {
                this.#onmessage = (typeof fn === 'function') ? fn : null;
                // Spec: setting onmessage implicitly enables dispatch.
                if (this.#onmessage) _enable(this);
            }
            postMessage(data /*, transfer */) {
                if (_PortClosed.get(this)) return;
                const paired = _PortPaired.get(this);
                if (!paired) return;
                const cloned = _clone(data);
                // Delivery to the PAIRED port (spec semantics).
                _deliver(paired, cloned);
            }
            start() { _enable(this); }
            close() {
                _PortClosed.set(this, true);
                // Detach from pair so the other side stops being able
                // to deliver to us. Pair is preserved on the other
                // port's side so its close() still works.
                const paired = _PortPaired.get(this);
                if (paired) _PortPaired.delete(this);
            }
        };

        // Re-tag the constructor + prototype methods so the universal
        // mask sweep (cleanup_bootstrap) tags them with the right name;
        // they are already function declarations so their identity is
        // fine. The Symbol-tagged closures (_PortPaired et al.) live in
        // the bootstrap IIFE scope and survive the snapshot.

        globalThis.MessageChannel = class MessageChannel {
            constructor() {
                const _st = _evOwn(this);
                _st.port1 = new globalThis.MessagePort();
                _st.port2 = new globalThis.MessagePort();
                _PortPaired.set(_st.port1, _st.port2);
                _PortPaired.set(_st.port2, _st.port1);
            }
        };
        _evFields(globalThis.MessageChannel.prototype, ["port1", "port2"]);
    }

    if (!globalThis.EventSource) {
        globalThis.EventSource = class EventSource extends EventTarget {
            static CONNECTING = 0;
            static OPEN = 1;
            static CLOSED = 2;
            constructor(url) {
                super();
                const _st = _evOwn(this);
                _st.url = String(url);
                _st.readyState = 0;
                _st.withCredentials = false;
                this.onopen = null;
                this.onmessage = null;
                this.onerror = null;
            }
            close() { _evOwn(this).readyState = 2; }
        };
        _evFields(globalThis.EventSource.prototype, ["url", "readyState", "withCredentials"]);
    }

    // CompressionStream / DecompressionStream (Chrome 80+)
    if (!globalThis.CompressionStream) {
        globalThis.CompressionStream = class CompressionStream {
            constructor() {
                const st = _evOwn(this);
                st.readable = new globalThis.ReadableStream();
                st.writable = new globalThis.WritableStream();
            }
        };
        _evFields(globalThis.CompressionStream.prototype, ["readable", "writable"]);
    }
    if (!globalThis.DecompressionStream) {
        globalThis.DecompressionStream = class DecompressionStream {
            constructor() {
                const st = _evOwn(this);
                st.readable = new globalThis.ReadableStream();
                st.writable = new globalThis.WritableStream();
            }
        };
        _evFields(globalThis.DecompressionStream.prototype, ["readable", "writable"]);
    }

    // CloseEvent for WebSocket
    if (!globalThis.CloseEvent) {
        const CloseEvent = class CloseEvent extends Event {
            constructor(type, options = {}) {
                super(type, options);
                const _st = _evOwn(this);
                _st.code = options.code || 1000;
                _st.reason = options.reason || "";
                _st.wasClean = options.wasClean !== undefined ? options.wasClean : true;
            }
        };
        _evFields(CloseEvent.prototype, ["code", "reason", "wasClean"]);
        globalThis.CloseEvent = CloseEvent;
    }

    // PressureObserver / PressureRecord — Compute Pressure API
    // (https://w3c.github.io/compute-pressure/). Chrome 125+. Commonly probed.
    if (!globalThis.PressureObserver) {
        class PressureRecord {
            constructor(source = 'cpu', state = 'nominal') {
                const _st = _idl.own(this);
                _st.source = source;
                _st.state = state;
                _st.time = performance.now();
            }
            toJSON() { return { source: this.source, state: this.state, time: this.time }; }
        }
    _idl.fields(PressureRecord.prototype, ["source", "state", "time"]);
        Object.defineProperty(PressureRecord.prototype, Symbol.toStringTag, {
            value: 'PressureRecord', configurable: true,
        });
        globalThis.PressureRecord = PressureRecord;

        class PressureObserver {
            #callback;
            #observing;
            #options;
            constructor(callback, options = {}) {
                this.#callback = callback;
                this.#options = options;
                this.#observing = new Set();
            }
            observe(source, _options) {
                this.#observing.add(source);
                return Promise.resolve();
            }
            unobserve(source) { this.#observing.delete(source); }
            disconnect() { this.#observing.clear(); }
            takeRecords() { return []; }
            static get knownSources() { return ['cpu']; }
        }
        Object.defineProperty(PressureObserver.prototype, Symbol.toStringTag, {
            value: 'PressureObserver', configurable: true,
        });
        globalThis.PressureObserver = PressureObserver;
    }

})(globalThis);
