((globalThis) => {
    const ops = Deno.core.ops;
    const _nativeTag = Symbol.for('__browser_oxide_native__');
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
    const _idl = (_boNs && _boNs.idl) || {
        own: (obj) => obj,
        read: () => undefined,
        fields: () => {},
    };
    
    // Helpers used by various bootstraps. Ensure they exist in Workers too.
    const _defNav = (name, get) => Object.defineProperty(globalThis.navigator, name, { get, enumerable: true, configurable: true });
    const _defProtoGetter = (proto, name, get) => Object.defineProperty(proto, name, { get, enumerable: true, configurable: true });
    const _defProtoMethod = (proto, name, value) => {
        Object.defineProperty(proto, name, { value, writable: true, enumerable: true, configurable: true });
        _maskAsNative(proto, name);
    };
    const _maskAsNative = globalThis._maskAsNative || ((...args) => {
        for (const item of args) {
            if (typeof item === 'function') {
                try {
                    Object.defineProperty(item, 'toString', {
                        value: function toString() { return `function ${item.name || ''}() { [native code] }`; },
                        configurable: true
                    });
                } catch (_) {}
            } else if (item && typeof item === 'object') {
                for (const key of Object.getOwnPropertyNames(item)) {
                    if (typeof item[key] === 'function') _maskAsNative(item[key]);
                }
            }
        }
    });
    const _p = (key, fallback) => {
        if (ops.op_has_stealth_profile && ops.op_has_stealth_profile()) {
            const v = ops.op_get_profile_value(key);
            return v !== "" ? v : fallback;
        }
        return fallback;
    };

    // ================================================================
    // DOMException — Chrome-shaped.
    // ================================================================
    // Legacy code table from the DOM spec; names not listed map to 0.
    const _DOM_EXCEPTION_LEGACY_CODES = {
        IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4,
        InvalidCharacterError: 5, NoModificationAllowedError: 7, NotFoundError: 8,
        NotSupportedError: 9, InUseAttributeError: 10, InvalidStateError: 11,
        SyntaxError: 12, InvalidModificationError: 13, NamespaceError: 14,
        InvalidAccessError: 15, TypeMismatchError: 17, SecurityError: 18,
        NetworkError: 19, AbortError: 20, URLMismatchError: 21,
        QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24,
        DataCloneError: 25,
    };
    if (!globalThis.DOMException) {
        globalThis.DOMException = class DOMException extends Error {
            constructor(message = "", name = "Error") {
                super(message);
                const _st = _idl.own(this);
                _st.message = String(message);
                _st.name = String(name);
                // Error's constructor leaves an own `message`; Chrome's
                // DOMException carries no own properties at all.
                delete this.message;
            }
        };
        _idl.fields(globalThis.DOMException.prototype, ["name", "message"]);
        // `code` is a prototype getter in Chrome, not an own data property. Assigning
        // `this.code` in the constructor throws once a page-supplied polyfill (core-js
        // ships one) redefines `code` as getter-only — which killed the whole module.
        Object.defineProperty(globalThis.DOMException.prototype, "code", {
            get() { return _DOM_EXCEPTION_LEGACY_CODES[this.name] || 0; },
            enumerable: true, configurable: true,
        });
        Object.defineProperty(globalThis.DOMException.prototype, Symbol.toStringTag, { value: "DOMException", configurable: true });
        _maskAsNative(globalThis.DOMException);
    }

    // ================================================================
    // atob / btoa — Chrome-shaped.
    // ================================================================
    if (!globalThis.atob) {
        globalThis.atob = function atob(s) {
            if (arguments.length === 0) throw new TypeError("Failed to execute 'atob' on 'Window': 1 argument required, but only 0 present.");
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
        };
        _maskAsNative(globalThis.atob);
    }
    if (!globalThis.btoa) {
        globalThis.btoa = function btoa(s) {
            if (arguments.length === 0) throw new TypeError("Failed to execute 'btoa' on 'Window': 1 argument required, but only 0 present.");
            const str = String(s);
            for (let i = 0; i < str.length; i++) {
                if (str.charCodeAt(i) > 255) throw new DOMException("Failed to execute 'btoa' on 'Window': The string to be encoded contains characters outside of the Latin1 range.", "InvalidCharacterError");
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
        };
        _maskAsNative(globalThis.btoa);
    }

    // ================================================================
    // Crypto / SubtleCrypto classes + prototype.
    // ================================================================
    class Crypto {}
    globalThis.Crypto = Crypto;
    const _CryptoProto = Crypto.prototype;

    class SubtleCrypto {}
    globalThis.SubtleCrypto = SubtleCrypto;
    const _SubtleProto = SubtleCrypto.prototype;
    const _subtleInstance = Object.create(_SubtleProto);

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
            return Promise.resolve(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
        } catch (e) { return Promise.reject(e); }
    });
    const _subtleNotImplemented = (name) => function (...args) {
        return Promise.reject(new DOMException(`${name} not implemented`, "NotSupportedError"));
    };
    for (const m of ['sign','verify','encrypt','decrypt','generateKey','importKey','exportKey','deriveKey','deriveBits','wrapKey','unwrapKey']) {
        _defProtoMethod(_SubtleProto, m, _subtleNotImplemented(m));
    }

    _defProtoMethod(_CryptoProto, 'getRandomValues', function getRandomValues(arr) {
        if (!ArrayBuffer.isView(arr)) throw new TypeError("getRandomValues expects an ArrayBufferView");
        if (arr.byteLength > 65536) throw new DOMException("QuotaExceededError", "QuotaExceededError");
        const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
        ops.op_crypto_random_fill(u8);
        return arr;
    });
    _defProtoMethod(_CryptoProto, 'randomUUID', function randomUUID() {
        const b = new Uint8Array(16);
        ops.op_crypto_random_fill(b);
        b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
        const hex = [];
        for (let i = 0; i < 16; i++) hex.push(b[i].toString(16).padStart(2, '0'));
        return `${hex.slice(0,4).join('')}-${hex.slice(4,6).join('')}-${hex.slice(6,8).join('')}-${hex.slice(8,10).join('')}-${hex.slice(10,16).join('')}`;
    });
    _defProtoGetter(_CryptoProto, 'subtle', () => _subtleInstance);

    Object.defineProperty(_CryptoProto, Symbol.toStringTag, { value: "Crypto", configurable: true });
    Object.defineProperty(_SubtleProto, Symbol.toStringTag, { value: "SubtleCrypto", configurable: true });

    globalThis.crypto = Object.create(_CryptoProto);

    // ================================================================
    // TextEncoder / TextDecoder.
    // ================================================================
    if (!globalThis.TextEncoder || !TextEncoder.prototype.encodeInto) {
        class TextEncoder {
            constructor() {}
            encode(str) {
                str = String(str == null ? "" : str);
                const buf = [];
                for (let i = 0; i < str.length; i++) {
                    let c = str.charCodeAt(i);
                    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
                        const low = str.charCodeAt(i + 1);
                        if (low >= 0xDC00 && low <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (low - 0xDC00); i++; }
                    }
                    if (c < 0x80) buf.push(c);
                    else if (c < 0x800) buf.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
                    else if (c < 0x10000) buf.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
                    else buf.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
                }
                return new Uint8Array(buf);
            }
            encodeInto(source, destination) {
                if (!(destination instanceof Uint8Array)) throw new TypeError("encodeInto destination must be a Uint8Array");
                source = String(source == null ? "" : source);
                let read = 0, written = 0;
                for (let i = 0; i < source.length; i++) {
                    let c = source.charCodeAt(i);
                    let extraChar = 0;
                    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < source.length) {
                        const low = source.charCodeAt(i + 1);
                        if (low >= 0xDC00 && low <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (low - 0xDC00); extraChar = 1; }
                    }
                    let bytes;
                    if (c < 0x80) bytes = [c];
                    else if (c < 0x800) bytes = [0xc0 | (c >> 6), 0x80 | (c & 0x3f)];
                    else if (c < 0x10000) bytes = [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)];
                    else bytes = [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)];
                    if (written + bytes.length > destination.length) break;
                    for (let j = 0; j < bytes.length; j++) destination[written + j] = bytes[j];
                    written += bytes.length; read += 1 + extraChar; if (extraChar) i++;
                }
                return { read, written };
            }
        }
        globalThis.TextEncoder = TextEncoder;
        _defProtoGetter(TextEncoder.prototype, 'encoding', () => "utf-8");
        _defProtoMethod(TextEncoder.prototype, 'encode', TextEncoder.prototype.encode);
        _defProtoMethod(TextEncoder.prototype, 'encodeInto', TextEncoder.prototype.encodeInto);
        _maskAsNative(TextEncoder);
    }
    if (!globalThis.TextDecoder || !('encoding' in TextDecoder.prototype)) {
        let _TextDecoder_get_label, _TextDecoder_get_fatal, _TextDecoder_get_ignoreBOM;
        class TextDecoder {
            static {
                _TextDecoder_get_label = (o) => o.#label;
                _TextDecoder_get_fatal = (o) => o.#fatal;
                _TextDecoder_get_ignoreBOM = (o) => o.#ignoreBOM;
            }
            #fatal;
            #ignoreBOM;
            #label;
            constructor(label = "utf-8", options = {}) {
                this.#label = String(label).toLowerCase(); this.#fatal = !!options.fatal; this.#ignoreBOM = !!options.ignoreBOM;
            }
            decode(buf, options) {
                if (buf === undefined) return "";
                let bytes = _toBytes(buf);
                let str = "", i = 0;
                if (!this.#ignoreBOM && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
                while (i < bytes.length) {
                    const b0 = bytes[i];
                    if (b0 < 0x80) { str += String.fromCharCode(b0); i++; }
                    else if ((b0 & 0xe0) === 0xc0 && i + 1 < bytes.length) { const cp = ((b0 & 0x1f) << 6) | (bytes[i+1] & 0x3f); str += String.fromCharCode(cp); i += 2; }
                    else if ((b0 & 0xf0) === 0xe0 && i + 2 < bytes.length) { const cp = ((b0 & 0x0f) << 12) | ((bytes[i+1] & 0x3f) << 6) | (bytes[i+2] & 0x3f); str += String.fromCharCode(cp); i += 3; }
                    else if ((b0 & 0xf8) === 0xf0 && i + 3 < bytes.length) {
                        let cp = ((b0 & 0x07) << 18) | ((bytes[i+1] & 0x3f) << 12) | ((bytes[i+2] & 0x3f) << 6) | (bytes[i+3] & 0x3f);
                        cp -= 0x10000; str += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3ff)); i += 4;
                    }
                    else { if (this.#fatal) throw new TypeError("The encoded data was not valid."); str += "\uFFFD"; i++; }
                }
                return str;
            }
        }
        globalThis.TextDecoder = TextDecoder;
        _defProtoGetter(TextDecoder.prototype, 'encoding', function encoding() { return _TextDecoder_get_label(this) || "utf-8"; });
        _defProtoGetter(TextDecoder.prototype, 'fatal', function fatal() { return _TextDecoder_get_fatal(this); });
        _defProtoGetter(TextDecoder.prototype, 'ignoreBOM', function ignoreBOM() { return _TextDecoder_get_ignoreBOM(this); });
        _defProtoMethod(TextDecoder.prototype, 'decode', TextDecoder.prototype.decode);
        _maskAsNative(TextDecoder);
    }

    // ================================================================
    // URL / URLSearchParams use the same parser as the network stack.
    {
        const _uspMap = new WeakMap(), _uspURLs = new WeakMap(), _urlMap = new WeakMap();
        const usv = value => String(value).toWellFormed();
        function URLSearchParams(init = '') {
            let pairs = [];
            if (init != null && typeof init === 'object') {
                if (typeof init[Symbol.iterator] === 'function') {
                    for (const entry of init) {
                        if (entry == null || typeof entry !== 'object') throw new TypeError('Expected a name/value pair');
                        const pair = Array.from(entry);
                        if (pair.length !== 2) throw new TypeError('Expected a name/value pair');
                        pairs.push(pair.map(usv));
                    }
                } else {
                    pairs = Object.entries(init).map(([key, value]) => [usv(key), usv(value)]);
                }
            } else if (init != null) {
                pairs = ops.op_url_search_params_parse(usv(init).replace(/^\?/, ''));
            }
            _uspMap.set(this, pairs);
        }
        function updateParams(params) {
            const url = _uspURLs.get(params);
            if (url) {
                const state = _urlMap.get(url);
                state.data = ops.op_url_set(state.data.href, 'search', params.toString());
            }
        }
        URLSearchParams.prototype.get = function(name) {
            name = usv(name);
            const pair = _uspMap.get(this).find(([key]) => key === name);
            return pair ? pair[1] : null;
        };
        URLSearchParams.prototype.getAll = function(name) {
            name = usv(name);
            return _uspMap.get(this).filter(([key]) => key === name).map(([, value]) => value);
        };
        URLSearchParams.prototype.has = function(name, value) {
            name = usv(name);
            if (value !== undefined) value = usv(value);
            return _uspMap.get(this).some(([key, val]) => key === name && (value === undefined || val === value));
        };
        URLSearchParams.prototype.set = function(name, value) {
            name = usv(name); value = usv(value);
            let found = false;
            const pairs = _uspMap.get(this).filter(pair => {
                if (pair[0] !== name) return true;
                if (found) return false;
                found = true; pair[1] = value; return true;
            });
            if (!found) pairs.push([name, value]);
            _uspMap.set(this, pairs);
            updateParams(this);
        };
        URLSearchParams.prototype.append = function(name, value) {
            _uspMap.get(this).push([usv(name), usv(value)]);
            updateParams(this);
        };
        URLSearchParams.prototype.delete = function(name, value) {
            name = usv(name);
            if (value !== undefined) value = usv(value);
            _uspMap.set(this, _uspMap.get(this).filter(([key, val]) => key !== name || (value !== undefined && val !== value)));
            updateParams(this);
        };
        URLSearchParams.prototype.sort = function() {
            _uspMap.get(this).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
            updateParams(this);
        };
        URLSearchParams.prototype.toString = function() { return ops.op_url_search_params_serialize(_uspMap.get(this)); };
        URLSearchParams.prototype.forEach = function(callback, thisArg) {
            for (const [key, value] of this) callback.call(thisArg, value, key, this);
        };
        URLSearchParams.prototype.entries = function*() {
            for (let i = 0; i < _uspMap.get(this).length; i++) yield _uspMap.get(this)[i].slice();
        };
        URLSearchParams.prototype.keys = function*() { for (const [key] of this) yield key; };
        URLSearchParams.prototype.values = function*() { for (const [, value] of this) yield value; };
        URLSearchParams.prototype[Symbol.iterator] = URLSearchParams.prototype.entries;
        Object.defineProperty(URLSearchParams.prototype, 'size', { get() { return _uspMap.get(this).length; }, enumerable: true, configurable: true });
        Object.defineProperty(URLSearchParams.prototype, Symbol.toStringTag, { value: 'URLSearchParams', configurable: true });
        Object.defineProperty(globalThis, 'URLSearchParams', { value: URLSearchParams, writable: true, configurable: true, enumerable: false });
        _maskAsNative(globalThis.URLSearchParams);

        globalThis.URL = class URL {
            constructor(input, base) {
                const data = ops.op_url_parse(usv(input), base === undefined ? undefined : usv(base));
                const params = new URLSearchParams(data.search);
                _urlMap.set(this, { data, params });
                _uspURLs.set(params, this);
            }
            get searchParams() { return _urlMap.get(this).params; }
            get origin() { return _urlMap.get(this).data.origin; }
            toString() { return this.href; }
            toJSON() { return this.href; }
            static createObjectURL(obj) {
                const u = 'blob:' + (globalThis.location && globalThis.location.origin || 'null') + '/' + _randomUUID();
                let data, contentType = '';
                if (obj && _idl.own(obj)._data instanceof Uint8Array) { data = _idl.own(obj)._data; contentType = String(obj.type || ''); }
                else if (obj instanceof Uint8Array) data = obj;
                else if (typeof obj === 'string') data = new TextEncoder().encode(obj);
                else data = new Uint8Array();
                try { ops.op_blob_register(u, data, contentType); } catch (e) {}
                return u;
            }
            static revokeObjectURL(url) { try { ops.op_blob_revoke(url); } catch (e) {} }
        };
        for (const key of ['href', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']) {
            Object.defineProperty(globalThis.URL.prototype, key, {
                get() { return _urlMap.get(this).data[key]; },
                set(value) {
                    const state = _urlMap.get(this);
                    state.data = ops.op_url_set(state.data.href, key, usv(value));
                    if (key === 'href' || key === 'search') {
                        _uspMap.set(state.params, ops.op_url_search_params_parse(state.data.search.replace(/^\?/, '')));
                    }
                },
                enumerable: true, configurable: true,
            });
        }
        Object.defineProperty(globalThis.URL.prototype, Symbol.toStringTag, { value: 'URL', configurable: true });
        _maskAsNative(globalThis.URL);
    }
    function _randomUUID() {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') { try { return globalThis.crypto.randomUUID(); } catch (e) {} }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    // ================================================================
    // Blob / File.
    // ================================================================
    if (!globalThis.Blob) {
        const _encoder = new TextEncoder();
        const _decoder = new TextDecoder();
        globalThis.Blob = class Blob {
            constructor(parts = [], options = {}) {
                const _st = _idl.own(this);
                _st.type = options.type || "";
                const arrays = parts.map(p => {
                    if (typeof p === "string") return _encoder.encode(p);
                    if (p instanceof ArrayBuffer) return new Uint8Array(p);
                    if (ArrayBuffer.isView(p)) return new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
                    if (p instanceof Blob) return _idl.own(p)._data;
                    return _encoder.encode(String(p));
                });
                const totalLen = arrays.reduce((s, a) => s + a.byteLength, 0);
                const merged = new Uint8Array(totalLen);
                let offset = 0;
                for (const a of arrays) { merged.set(a, offset); offset += a.byteLength; }
                _idl.own(this)._data = merged; _st.size = totalLen;
            }
            text() { return Promise.resolve(_decoder.decode(_idl.own(this)._data)); }
            arrayBuffer() { return Promise.resolve(_idl.own(this)._data.buffer.slice(_idl.own(this)._data.byteOffset, _idl.own(this)._data.byteOffset + _idl.own(this)._data.byteLength)); }
            slice(start = 0, end = this.size, type = "") {
                const sliced = _idl.own(this)._data.slice(start, end);
                const b = new Blob([], { type }); _idl.own(b)._data = sliced; b.size = sliced.byteLength; return b;
            }
            // P2b — Blob.prototype.stream(). Was missing; SPA state persisters
            // (e.g. duolingo: `new Blob([...]).stream().pipeThrough(new
            // CompressionStream('gzip'))`) threw `.stream is not a function`,
            // aborting the event-loop drain before React's commit → empty #root.
            stream() {
                const data = _idl.own(this)._data;
                if (typeof globalThis.ReadableStream === 'function') {
                    return new globalThis.ReadableStream({
                        start(controller) {
                            if (data && data.byteLength) controller.enqueue(data);
                            controller.close();
                        }
                    });
                }
                // Minimal fallback if ReadableStream is unavailable.
                let done = false;
                return { getReader() { return { read() { if (done) return Promise.resolve({ done: true, value: undefined }); done = true; return Promise.resolve({ done: false, value: data }); }, releaseLock() {}, cancel() { return Promise.resolve(); } }; } };
            }
        };
    _idl.fields(Blob.prototype, ["size", "type"]);
        _maskAsNative(globalThis.Blob);
    }
    if (!globalThis.File) {
        globalThis.File = class File extends Blob {
            constructor(parts, name, options = {}) {
                super(parts, options); const _st = _idl.own(this); _st.name = name; _st.lastModified = options.lastModified || Date.now(); }
        };
    _idl.fields(File.prototype, ["lastModified", "name"]);
        _maskAsNative(globalThis.File);
    }

    // ================================================================
    // FormData.
    // ================================================================
    if (!globalThis.FormData) {
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
        _maskAsNative(globalThis.FormData);
    }

    // ================================================================
    // AbortController / AbortSignal.
    // ================================================================
    if (!globalThis.AbortController) {
        const _abortState = new WeakMap();
        const _ctrlSignal = new WeakMap();
        const _abortSelf = (sig) => {
            const st = _abortState.get(sig);
            if (!st) throw new TypeError("Illegal invocation");
            return st;
        };
        const _abortReason = (reason) => (reason !== undefined ? reason
            : new DOMException("signal is aborted without reason", "AbortError"));
        const _abortNow = (sig, reason) => {
            const st = _abortState.get(sig);
            if (!st || st.aborted) return;
            st.aborted = true;
            st.reason = reason;
            const E = globalThis.Event;
            const ev = typeof E === "function" ? new E("abort") : { type: "abort" };
            let dispatched = false;
            try { sig.dispatchEvent(ev); dispatched = true; } catch (_e) {}
            if (!dispatched && typeof st.onabort === "function") { try { st.onabort.call(sig, ev); } catch (_e) {} }
        };
        class AbortSignal {
            get aborted() { return _abortSelf(this).aborted; }
            get reason() { return _abortSelf(this).reason; }
            get onabort() { return _abortSelf(this).onabort; }
            set onabort(v) { _abortSelf(this).onabort = typeof v === "function" ? v : null; }
            throwIfAborted() { const st = _abortSelf(this); if (st.aborted) throw st.reason; }
            static abort(reason) {
                const sig = _newAbortSignal();
                const st = _abortState.get(sig);
                st.aborted = true;
                st.reason = _abortReason(reason);
                return sig;
            }
            static any(signals) {
                const sig = _newAbortSignal();
                const list = [...signals];
                for (const src of list) {
                    if (src && src.aborted) { _abortNow(sig, src.reason); return sig; }
                }
                for (const src of list) {
                    try { src.addEventListener("abort", () => _abortNow(sig, src.reason)); } catch (_e) {}
                }
                return sig;
            }
            static timeout(ms) {
                const sig = _newAbortSignal();
                setTimeout(() => _abortNow(sig, new DOMException("signal timed out", "TimeoutError")), ms);
                return sig;
            }
        }
        const _newAbortSignal = () => {
            const sig = Object.create(AbortSignal.prototype);
            _abortState.set(sig, { aborted: false, reason: undefined, onabort: null });
            return sig;
        };
        class AbortController {
            constructor() { _ctrlSignal.set(this, _newAbortSignal()); }
            get signal() {
                const sig = _ctrlSignal.get(this);
                if (!sig) throw new TypeError("Illegal invocation");
                return sig;
            }
            abort(reason) { _abortNow(this.signal, _abortReason(reason)); }
        }
        globalThis.AbortController = AbortController;
        globalThis.AbortSignal = AbortSignal;
        _maskAsNative(AbortController, AbortSignal);
    }

    // ================================================================
    // OffscreenCanvas.
    // ================================================================
    if (!globalThis.OffscreenCanvas) {
        class OffscreenCanvas {
            constructor(width, height) { this.width = width | 0; this.height = height | 0; }
            getContext(_type, _opts) { return null; }
            transferToImageBitmap() { return { width: this.width, height: this.height, close() {} }; }
            convertToBlob(options) { return Promise.resolve(new Blob([], { type: (options && options.type) || "image/png" })); }
        }
        Object.defineProperty(OffscreenCanvas.prototype, Symbol.toStringTag, { value: "OffscreenCanvas", configurable: true, });
        globalThis.OffscreenCanvas = OffscreenCanvas;
        _maskAsNative(OffscreenCanvas);
    }

    // ================================================================
    // IndexedDB — In-memory stub.
    // ================================================================
    if (!globalThis.indexedDB || !(_boNs && _boNs.realIDB === globalThis.indexedDB)) {
        const _dbRegistry = new Map();
        function _clone(v) {
            if (typeof globalThis.structuredClone === "function") { try { return globalThis.structuredClone(v); } catch (_e) {} }
            try { return JSON.parse(JSON.stringify(v)); } catch (_e) { return v; }
        }
        function _keyCmp(a, b) {
            if (typeof a === typeof b) { if (a < b) return -1; if (a > b) return 1; return 0; }
            if (typeof a === "number") return -1; if (typeof b === "number") return 1; return 0;
        }
        function _extractKey(value, keyPath) {
            if (!keyPath) return undefined;
            if (Array.isArray(keyPath)) return keyPath.map((p) => value?.[p]);
            const parts = String(keyPath).split("."); let cur = value;
            for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
            return cur;
        }
        const _idbEvent = (target, type, extra) => {
            const E = globalThis.Event;
            const ev = typeof E === "function" ? new E(type) : { type };
            if (extra) Object.assign(ev, extra);
            let dispatched = false;
            try { target.dispatchEvent(ev); dispatched = true; } catch (_e) {}
            if (dispatched) return;
            const handler = target["on" + type];
            if (typeof handler === "function") { try { handler.call(target, ev); } catch (_e) {} }
        };
        const _idbSuccess = (req) => {
            _idl.own(req).readyState = "done";
            queueMicrotask(() => _idbEvent(req, "success"));
        };
        const _idbFail = (req, err) => {
            _idl.own(req).readyState = "done"; _idl.own(req).error = err;
            queueMicrotask(() => _idbEvent(req, "error"));
        };
        const _idbKeys = (store) => [..._idl.own(store)._data.keys()].sort(_keyCmp);
        class IDBRequest {
            constructor(source) {
                const _st = _idl.own(this); _st.result = undefined; _st.error = null; _st.source = source || null; _st.transaction = null; _st.readyState = "pending"; this.onsuccess = null; this.onerror = null; }
        }
    _idl.fields(IDBRequest.prototype, ["error", "readyState", "result", "source", "transaction"]);
        class IDBOpenDBRequest extends IDBRequest { constructor() { super(); this.onupgradeneeded = null; this.onblocked = null; } }
        class IDBKeyRange {
            constructor(lower, upper, lowerOpen, upperOpen) {
                const _st = _idl.own(this); _st.lower = lower; _st.upper = upper; _st.lowerOpen = !!lowerOpen; _st.upperOpen = !!upperOpen; }
            includes(key) {
                if (this.lower !== undefined) { const c = _keyCmp(key, this.lower); if (c < 0) return false; if (c === 0 && this.lowerOpen) return false; }
                if (this.upper !== undefined) { const c = _keyCmp(key, this.upper); if (c > 0) return false; if (c === 0 && this.upperOpen) return false; }
                return true;
            }
            static bound(lower, upper, lowerOpen = false, upperOpen = false) { return new IDBKeyRange(lower, upper, lowerOpen, upperOpen); }
            static only(value) { return new IDBKeyRange(value, value, false, false); }
            static lowerBound(lower, open = false) { return new IDBKeyRange(lower, undefined, open, false); }
            static upperBound(upper, open = false) { return new IDBKeyRange(undefined, upper, false, open); }
        }
    _idl.fields(IDBKeyRange.prototype, ["lower", "lowerOpen", "upper", "upperOpen"]);
        let _IDBCursor_set_request, _IDBCursor_call_step;
        class IDBCursor {
            static {
                _IDBCursor_set_request = (o, v) => (o.#request = v);
                _IDBCursor_call_step = (o, ...a) => o.#step(...a);
            }
            #idx;
            #keys;
            #range;
            #request;
            #store;
            constructor(store, range, direction) {
                const _st = _idl.own(this);
                _st.source = store; _st.direction = direction || "next"; this.#store = store; this.#range = range;
                this.#keys = _idbKeys(store).filter((k) => !range || range.includes(k));
                if (this.direction === "prev" || this.direction === "prevunique") this.#keys.reverse();
                this.#idx = -1; _st.key = undefined; _st.primaryKey = undefined; this.value = undefined;
            }
            #advanceTo(idx) {
                const _st = _idl.own(this);
                this.#idx = idx;
                if (idx < this.#keys.length) { _st.key = this.#keys[idx]; _st.primaryKey = this.key; this.value = _clone(_idl.own(this.#store)._data.get(this.key)); }
                else { _st.key = undefined; _st.primaryKey = undefined; this.value = undefined; }
            }
            ['continue'](_targetKey) { this.#step(); }
            advance(count) { for (let i = 0; i < count; i++) this.#step(); }
            #step() { this.#advanceTo(this.#idx + 1); if (this.#request) { const done = this.#idx >= this.#keys.length; _idl.own(this.#request).result = done ? null : this; _idbSuccess(this.#request); } }
        }
    _idl.fields(IDBCursor.prototype, ["direction", "key", "primaryKey", "source"]);
        class IDBObjectStore {
            constructor(name, options, transaction) {
                const _st = _idl.own(this); this.name = name; _st.keyPath = (options && options.keyPath) || null; _st.indexNames = []; _st.autoIncrement = !!(options && options.autoIncrement); _st.transaction = transaction || null; _idl.own(this)._data = new Map(); this._nextKey = 1; }
            #resolveKey(value, explicitKey) {
                if (this.keyPath) { const extracted = _extractKey(value, this.keyPath); if (extracted !== undefined) return extracted; if (this.autoIncrement) return this._nextKey++; return undefined; }
                if (explicitKey !== undefined) return explicitKey;
                if (this.autoIncrement) return this._nextKey++; return undefined;
            }
            put(value, key) { const r = new IDBRequest(this); const resolvedKey = this.#resolveKey(value, key); if (resolvedKey === undefined) { _idbFail(r, new Error("DataError: no key")); return r; } _idl.own(this)._data.set(resolvedKey, _clone(value)); if (this.autoIncrement && typeof resolvedKey === "number" && resolvedKey >= this._nextKey) { this._nextKey = resolvedKey + 1; } _idl.own(r).result = resolvedKey; _idbSuccess(r); return r; }
            add(value, key) { const r = new IDBRequest(this); const resolvedKey = this.#resolveKey(value, key); if (resolvedKey === undefined) { _idbFail(r, new Error("DataError: no key")); return r; } if (_idl.own(this)._data.has(resolvedKey)) { _idbFail(r, new Error("ConstraintError: key exists")); return r; } _idl.own(this)._data.set(resolvedKey, _clone(value)); _idl.own(r).result = resolvedKey; _idbSuccess(r); return r; }
            get(key) { const r = new IDBRequest(this); if (key instanceof IDBKeyRange) { for (const k of _idbKeys(this)) { if (key.includes(k)) { _idl.own(r).result = _clone(_idl.own(this)._data.get(k)); _idbSuccess(r); return r; } } _idl.own(r).result = undefined; } else { const v = _idl.own(this)._data.get(key); _idl.own(r).result = v === undefined ? undefined : _clone(v); } _idbSuccess(r); return r; }
            getAll(queryOrRange, count) { const r = new IDBRequest(this); const out = []; const limit = count ?? Infinity; for (const k of _idbKeys(this)) { if (out.length >= limit) break; if (queryOrRange == null) { out.push(_clone(_idl.own(this)._data.get(k))); } else if (queryOrRange instanceof IDBKeyRange) { if (queryOrRange.includes(k)) out.push(_clone(_idl.own(this)._data.get(k))); } else if (_keyCmp(k, queryOrRange) === 0) { out.push(_clone(_idl.own(this)._data.get(k))); } } _idl.own(r).result = out; _idbSuccess(r); return r; }
            getAllKeys(queryOrRange, count) { const r = new IDBRequest(this); const out = []; const limit = count ?? Infinity; for (const k of _idbKeys(this)) { if (out.length >= limit) break; if (queryOrRange == null) { out.push(k); } else if (queryOrRange instanceof IDBKeyRange) { if (queryOrRange.includes(k)) out.push(k); } else if (_keyCmp(k, queryOrRange) === 0) { out.push(k); } } _idl.own(r).result = out; _idbSuccess(r); return r; }
            delete(key) { const r = new IDBRequest(this); if (key instanceof IDBKeyRange) { for (const k of _idbKeys(this)) { if (key.includes(k)) _idl.own(this)._data.delete(k); } } else { _idl.own(this)._data.delete(key); } _idbSuccess(r); return r; }
            clear() { const r = new IDBRequest(this); _idl.own(this)._data.clear(); _idbSuccess(r); return r; }
            count(query) { const r = new IDBRequest(this); if (query == null) { _idl.own(r).result = _idl.own(this)._data.size; } else if (query instanceof IDBKeyRange) { let n = 0; for (const k of _idl.own(this)._data.keys()) { if (query.includes(k)) n++; } _idl.own(r).result = n; } else { _idl.own(r).result = _idl.own(this)._data.has(query) ? 1 : 0; } _idbSuccess(r); return r; }
            openCursor(range, direction) { const r = new IDBRequest(this); let rangeObj = null; if (range instanceof IDBKeyRange) rangeObj = range; else if (range != null) rangeObj = IDBKeyRange.only(range); const cursor = new IDBCursor(this, rangeObj, direction); _IDBCursor_set_request(cursor, r); queueMicrotask(() => _IDBCursor_call_step(cursor)); return r; }
            createIndex(name) { if (!this.indexNames.includes(name)) this.indexNames.push(name); return { name, get: (k) => this.get(k), getAll: (q, c) => this.getAll(q, c), }; }
            index(name) { return { name, get: (k) => this.get(k), getAll: (q, c) => this.getAll(q, c), }; }
        }
    _idl.fields(IDBObjectStore.prototype, ["autoIncrement", "indexNames", "keyPath", "transaction"]);
        let _IDBTransaction_call_complete;
        class IDBTransaction {
            static {
                _IDBTransaction_call_complete = (o, ...a) => o.#complete(...a);
            }
            #active;
            #db;
            #storeNames;
            constructor(db, storeNames, mode) {
                const _st = _idl.own(this); this.#db = db; this.#storeNames = storeNames; _st.mode = mode || "readonly"; _st.db = db; _st.error = null; this.oncomplete = null; this.onerror = null; this.onabort = null;  this.#active = true; queueMicrotask(() => this.#complete()); }
            objectStore(name) { if (!_IDBDatabase_get_stores(this.#db).has(name)) throw new Error("NotFoundError: store " + name); const store = _IDBDatabase_get_stores(this.#db).get(name); _idl.own(store).transaction = this; return store; }
            commit() { this.#complete(); }
            abort() { this.#active = false; queueMicrotask(() => _idbEvent(this, "abort")); }
            #complete() { if (!this.#active) return; this.#active = false; _idbEvent(this, "complete"); }
        }
    _idl.fields(IDBTransaction.prototype, ["db", "error", "mode"]);
        let _IDBDatabase_get_stores;
        class IDBDatabase {
            static {
                _IDBDatabase_get_stores = (o) => o.#stores;
            }
            #stores;
            constructor(name, version) {
                const _st = _idl.own(this); _st.name = name; _st.version = version; this.#stores = new Map(); _st.objectStoreNames = []; this.onclose = null; this.onversionchange = null; this.onabort = null; this.onerror = null; }
            createObjectStore(name, options) { if (this.#stores.has(name)) throw new Error("ConstraintError: store already exists"); const store = new IDBObjectStore(name, options, null); this.#stores.set(name, store); this.objectStoreNames.push(name); return store; }
            deleteObjectStore(name) {
                const _st = _idl.own(this); this.#stores.delete(name); _st.objectStoreNames = this.objectStoreNames.filter((n) => n !== name); }
            transaction(storeNames, mode) { const names = Array.isArray(storeNames) ? storeNames : [storeNames]; return new IDBTransaction(this, names, mode); }
            close() {}
        }
    _idl.fields(IDBDatabase.prototype, ["name", "objectStoreNames", "version"]);
        class IDBFactory {
            open(name, version) {
                const req = new IDBOpenDBRequest(); const targetVersion = version || 1; let db = _dbRegistry.get(name); const oldVersion = db ? db.version : 0;
                if (!db) { db = new IDBDatabase(name, targetVersion); _dbRegistry.set(name, db); } else if (db.version < targetVersion) _idl.own(db).version = targetVersion;
                _idl.own(req).result = db;
                queueMicrotask(() => {
                    if (oldVersion < targetVersion) {
                        const tx = new IDBTransaction(db, [], "versionchange"); _idl.own(req).transaction = tx;
                        const ev = { target: req, oldVersion, newVersion: targetVersion, type: "upgradeneeded", };
                        if (typeof req.onupgradeneeded === "function") try { req.onupgradeneeded(ev); } catch (_e) {}
                        _IDBTransaction_call_complete(tx); _idl.own(req).transaction = null;
                    }
                    _idbSuccess(req);
                });
                return req;
            }
            deleteDatabase(name) { const r = new IDBOpenDBRequest(); _dbRegistry.delete(name); _idbSuccess(r); return r; }
            databases() { return Promise.resolve([..._dbRegistry.entries()].map(([name, db]) => ({ name, version: db.version, }))); }
            cmp(a, b) { return _keyCmp(a, b); }
        }
        globalThis.indexedDB = new IDBFactory();
        if (_boNs) _boNs.realIDB = globalThis.indexedDB;
        globalThis.IDBFactory = IDBFactory;
        globalThis.IDBDatabase = IDBDatabase;
        globalThis.IDBTransaction = IDBTransaction;
        globalThis.IDBObjectStore = IDBObjectStore;
        globalThis.IDBRequest = IDBRequest;
        globalThis.IDBOpenDBRequest = IDBOpenDBRequest;
        globalThis.IDBKeyRange = IDBKeyRange;
        globalThis.IDBCursor = IDBCursor;
        _maskAsNative(IDBFactory, IDBDatabase, IDBTransaction, IDBObjectStore, IDBRequest, IDBOpenDBRequest, IDBKeyRange, IDBCursor);
    }

    // ================================================================
    // Shared Web APIs Part 3.
    // ================================================================
    if (!globalThis.FileReader) {
        // Real FileReader. Previously a no-op stub that returned empty
        // strings/buffers — some challenge scripts call readAsDataURL(blob)
        // to base64-encode a payload before POSTing it; an empty result
        // caused the script to bail with "challenge data URL was
        // malformed", and the server then served a small stub page.
        const _readerEncode = (bytes) => {
            // Manual base64 over Uint8Array via btoa(binary-string). btoa
            // is fine on UTF-8-clean ranges (0-255); we feed it raw bytes
            // mapped through String.fromCharCode.
            let bin = '';
            // Chunk to avoid blowing the call stack on large blobs.
            const CHUNK = 0x8000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
            }
            return btoa(bin);
        };
        const _readerDispatch = (self, name) => {
            const ev = { target: self, type: name };
            if (self['on' + name]) setTimeout(() => self['on' + name](ev), 0);
        };
        globalThis.FileReader = class FileReader extends EventTarget {
            static EMPTY = 0; static LOADING = 1; static DONE = 2;
            constructor() {
                super();
                const _st = _idl.own(this);
                _st.readyState = 0; _st.result = null; _st.error = null;
                this.onload = null; this.onloadstart = null; this.onloadend = null;
                this.onprogress = null; this.onerror = null; this.onabort = null;
            }
            readAsText(blob, encoding) {
                const _st = _idl.own(this);
                try {
                    const bytes = (blob && _idl.own(blob)._data) ? _idl.own(blob)._data : new Uint8Array(0);
                    const dec = new TextDecoder(encoding || 'utf-8');
                    _st.result = dec.decode(bytes);
                } catch (e) { _st.error = e; _st.result = null; }
                _st.readyState = 2;
                _readerDispatch(this, 'load'); _readerDispatch(this, 'loadend');
            }
            readAsDataURL(blob) {
                const _st = _idl.own(this);
                try {
                    const bytes = (blob && _idl.own(blob)._data) ? _idl.own(blob)._data : new Uint8Array(0);
                    const b64 = _readerEncode(bytes);
                    const mime = (blob && blob.type) || 'application/octet-stream';
                    _st.result = `data:${mime};base64,${b64}`;
                } catch (e) { _st.error = e; _st.result = null; }
                _st.readyState = 2;
                _readerDispatch(this, 'load'); _readerDispatch(this, 'loadend');
            }
            readAsArrayBuffer(blob) {
                const _st = _idl.own(this);
                try {
                    const bytes = (blob && _idl.own(blob)._data) ? _idl.own(blob)._data : new Uint8Array(0);
                    // Copy into a fresh ArrayBuffer matching the blob exactly
                    const buf = new ArrayBuffer(bytes.byteLength);
                    new Uint8Array(buf).set(bytes);
                    _st.result = buf;
                } catch (e) { _st.error = e; _st.result = null; }
                _st.readyState = 2;
                _readerDispatch(this, 'load'); _readerDispatch(this, 'loadend');
            }
            readAsBinaryString(blob) {
                const _st = _idl.own(this);
                try {
                    const bytes = (blob && _idl.own(blob)._data) ? _idl.own(blob)._data : new Uint8Array(0);
                    let bin = '';
                    const CHUNK = 0x8000;
                    for (let i = 0; i < bytes.length; i += CHUNK) {
                        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
                    }
                    _st.result = bin;
                } catch (e) { _st.error = e; _st.result = null; }
                _st.readyState = 2;
                _readerDispatch(this, 'load'); _readerDispatch(this, 'loadend');
            }
            abort() {
                const _st = _idl.own(this); _st.readyState = 2; _readerDispatch(this, 'abort'); _readerDispatch(this, 'loadend'); }
        };
    _idl.fields(FileReader.prototype, ["error", "readyState", "result"]);
        _maskAsNative(globalThis.FileReader);
    }
    if (!globalThis.ImageBitmap) {
        globalThis.ImageBitmap = class ImageBitmap {
            constructor() {
                const _st = _idl.own(this);
                _st.width = 0;
                _st.height = 0;
            }
            close() {}
        };
        _idl.fields(globalThis.ImageBitmap.prototype, ["width", "height"]);
        _maskAsNative(globalThis.ImageBitmap);
    }
    if (!globalThis.createImageBitmap) {
        globalThis.createImageBitmap = function() { return Promise.resolve(new globalThis.ImageBitmap()); };
        _maskAsNative(globalThis.createImageBitmap);
    }
    {
        const _mask = typeof globalThis._maskFunction === "function" ? globalThis._maskFunction : (f) => f;
        const _reorder = (target, isProto) => {
            const fixed = isProto ? [] : ["length", "name", "prototype"];
            const accessors = [], constants = [], methods = [];
            let ctor = null, stringifier = null;
            for (const k of Object.getOwnPropertyNames(target)) {
                if (fixed.includes(k)) continue;
                const d = Object.getOwnPropertyDescriptor(target, k);
                if (k === "constructor") ctor = d;
                else if (isProto && k === "toString") stringifier = d;
                else if (d.get || d.set) accessors.push([k, d]);
                else if (typeof d.value === "function") methods.push([k, d]);
                else constants.push([k, d]);
            }
            methods.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
            const order = [...accessors, ...constants, ...methods];
            if (ctor) order.push(["constructor", ctor]);
            if (stringifier) order.push(["toString", stringifier]);
            for (const [k] of order) delete target[k];
            for (const [k, d] of order) Object.defineProperty(target, k, d);
        };
        const _nativeClass = (C, name) => {
            _mask(C, name);
            for (const target of [C, C.prototype]) {
                for (const k of Object.getOwnPropertyNames(target)) {
                    if (k === "constructor" || k === "prototype" || k === "length" || k === "name") continue;
                    const d = Object.getOwnPropertyDescriptor(target, k);
                    if (typeof d.value === "function") _mask(d.value, k);
                    if (d.get) _mask(d.get, "get " + k);
                    if (d.set) _mask(d.set, "set " + k);
                    d.enumerable = true;
                    Object.defineProperty(target, k, d);
                }
                _reorder(target, target === C.prototype);
            }
            Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
        };

        const _isWindow = typeof ops.op_dom_document_node === "function";
        const _cc = Function.prototype.call.bind(String.prototype.charCodeAt);
        const _fromCP = String.fromCodePoint;
        const _parseInt = parseInt;
        const _isFinite = Number.isFinite;
        const _fr = Math.fround, _trunc = Math.trunc, _sqrt = Math.sqrt, _abs = Math.abs, _PI = Math.PI;
        const _F64 = Float64Array, _F32 = Float32Array;
        const _SymIter = Symbol.iterator;
        const _taTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
        const _taBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "buffer").get;
        const _taLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "length").get;
        const _sabLength = typeof SharedArrayBuffer === "function"
            ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength").get : null;
        const _call = Function.prototype.call.bind(Function.prototype.call);
        let _DOMException = null;
        const _domError = (message, name) => {
            if (_DOMException === null && typeof globalThis.DOMException === "function") _DOMException = globalThis.DOMException;
            return _DOMException ? new _DOMException(message, name) : new Error(message);
        };
        const _FLT_MAX = 3.4028234663852886e38;
        const _DBL_MAX = 1.7976931348623157e308;

        class _Box {
            #box = true;
            constructor(v) { this.v = v; }
            static is(o) { return o !== null && typeof o === "object" && #box in o; }
        }

        const _n = (v, where) => {
            const ty = typeof v;
            if (ty === "number") return v;
            if (ty === "bigint") throw new TypeError(`${where}: Cannot convert a BigInt value to a number`);
            if (ty === "symbol") throw new TypeError(`${where}: Cannot convert a Symbol value to a number`);
            return +v;
        };
        const _opt = (v, def, where) => (v === undefined ? def : _n(v, where));
        const _dict = (v, type, where) => {
            if (v === undefined || v === null) return null;
            if (typeof v !== "object" && typeof v !== "function") throw new TypeError(`${where}: The provided value is not of type '${type}'.`);
            return v;
        };
        const _field = (d, key, type, where) => {
            if (d === null) return undefined;
            const v = d[key];
            return v === undefined ? undefined : _n(v, `${where}: Failed to read the '${key}' property from '${type}'`);
        };
        const _pointInit = (v, where) => {
            const d = _dict(v, "DOMPointInit", where);
            const w = _field(d, "w", "DOMPointInit", where);
            const x = _field(d, "x", "DOMPointInit", where);
            const y = _field(d, "y", "DOMPointInit", where);
            const z = _field(d, "z", "DOMPointInit", where);
            return { x: x === undefined ? 0 : x, y: y === undefined ? 0 : y, z: z === undefined ? 0 : z, w: w === undefined ? 1 : w };
        };
        const _rectInit = (v, where) => {
            const d = _dict(v, "DOMRectInit", where);
            const height = _field(d, "height", "DOMRectInit", where);
            const width = _field(d, "width", "DOMRectInit", where);
            const x = _field(d, "x", "DOMRectInit", where);
            const y = _field(d, "y", "DOMRectInit", where);
            return { x: x === undefined ? 0 : x, y: y === undefined ? 0 : y, width: width === undefined ? 0 : width, height: height === undefined ? 0 : height };
        };
        const _quadInit = (v, where) => {
            const d = _dict(v, "DOMQuadInit", where);
            const keys = ["p1", "p2", "p3", "p4"];
            const out = [];
            for (let k = 0; k < 4; k++) {
                const pv = d === null ? undefined : d[keys[k]];
                out[k] = pv === undefined ? { x: 0, y: 0, z: 0, w: 1 }
                    : _pointInit(pv, `${where}: Failed to read the '${keys[k]}' property from 'DOMQuadInit'`);
            }
            return out;
        };
        const _need = (args, count, where) => {
            if (args.length < count) {
                throw new TypeError(`${where}: ${count} argument${count === 1 ? "" : "s"} required, but only ${args.length} present.`);
            }
        };
        const _arg = (args, i) => (i < args.length ? args[i] : undefined);
        const _trimmed = (args) => {
            let n = args.length;
            while (n > 0 && args[n - 1] === undefined) n--;
            return n;
        };

        const _f64 = (...v) => {
            const m = new _F64(16);
            for (let i = 0; i < 16; i++) m[i] = v[i];
            return m;
        };
        const _ident = () => {
            const m = new _F64(16);
            m[0] = m[5] = m[10] = m[15] = 1;
            return { f: false, m };
        };
        const _copyT = (t) => {
            const m = new _F64(16);
            for (let i = 0; i < 16; i++) m[i] = t.m[i];
            return { f: t.f, m };
        };
        const _isNormalF = (v) => v === v && v !== 0 && _abs(v) >= 1.1754943508222875e-38 && _abs(v) !== Infinity;
        const _is2dM = (m) => m[8] === 0 && m[9] === 0 && m[10] === 1 && m[11] === 0 && m[2] === 0 && m[6] === 0
            && m[14] === 0 && m[3] === 0 && m[7] === 0 && m[15] === 1;
        const _hasPersp = (m) => !(m[3] === 0 && m[7] === 0 && m[11] === 0 && m[15] === 1);
        const _concat = (x, y) => {
            const r = new _F64(16);
            if (_is2dM(x) && _is2dM(y)) {
                const a = x[0], b = x[1], c = x[4], d = x[5], e = x[12], f = x[13];
                const ya = y[0], yb = y[1], yc = y[4], yd = y[5], ye = y[12], yf = y[13];
                r[0] = a * ya + c * yb;
                r[1] = b * ya + d * yb;
                r[4] = a * yc + c * yd;
                r[5] = b * yc + d * yd;
                r[10] = 1;
                r[12] = a * ye + c * yf + e;
                r[13] = b * ye + d * yf + f;
                r[15] = 1;
                return r;
            }
            for (let j = 0; j < 4; j++) {
                const y0 = y[j * 4], y1 = y[j * 4 + 1], y2 = y[j * 4 + 2], y3 = y[j * 4 + 3];
                for (let k = 0; k < 4; k++) r[j * 4 + k] = x[k] * y0 + x[4 + k] * y1 + x[8 + k] * y2 + x[12 + k] * y3;
            }
            return r;
        };
        const _vm = (p, q) => [p[0] * q[0], p[1] * q[1], p[2] * q[2], p[3] * q[3]];
        const _va = (p, q) => [p[0] + q[0], p[1] + q[1], p[2] + q[2], p[3] + q[3]];
        const _vs = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2], p[3] - q[3]];
        const _hl = (p) => [p[2], p[3], p[0], p[1]];
        const _pr = (p) => [p[1], p[0], p[3], p[2]];
        const _inverse = (m) => {
            if (_is2dM(m)) {
                const det = m[0] * m[5] - m[1] * m[4];
                if (!_isNormalF(_fr(det))) return null;
                const inv = 1.0 / det;
                const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
                return _f64(d * inv, -b * inv, 0, 0, -c * inv, a * inv, 0, 0, 0, 0, 1, 0,
                    (c * f - d * e) * inv, (b * e - a * f) * inv, 0, 1);
            }
            const r0 = [m[0], m[4], m[8], m[12]];
            const r1 = [m[9], m[13], m[1], m[5]];
            let r2 = [m[2], m[6], m[10], m[14]];
            const r3 = [m[11], m[15], m[3], m[7]];
            let t = _pr(_vm(r2, r3));
            let c0 = _vm(r1, t);
            let c1 = _vm(r0, t);
            t = _hl(t);
            c0 = _vs(_vm(r1, t), c0);
            c1 = _hl(_vs(_vm(r0, t), c1));
            t = _pr(_vm(r1, r2));
            c0 = _va(c0, _vm(r3, t));
            let c3 = _vm(r0, t);
            t = _hl(t);
            c0 = _vs(c0, _vm(r3, t));
            c3 = _hl(_vs(_vm(r0, t), c3));
            t = _pr(_vm(_hl(r1), r3));
            r2 = _hl(r2);
            c0 = _va(c0, _vm(r2, t));
            let c2 = _vm(r0, t);
            t = _hl(t);
            c0 = _vs(c0, _vm(r2, t));
            const dv = _vm(r0, c0);
            let det = dv[0] + dv[1] + dv[2] + dv[3];
            if (!_isNormalF(_fr(det))) return null;
            c2 = _hl(_vs(_vm(r0, t), c2));
            t = _pr(_vm(r0, r1));
            c2 = _va(_vm(r3, t), c2);
            c3 = _vs(_vm(r2, t), c3);
            t = _hl(t);
            c2 = _vs(_vm(r3, t), c2);
            c3 = _vs(c3, _vm(r2, t));
            t = _pr(_vm(r0, r3));
            c1 = _vs(c1, _vm(r2, t));
            c2 = _va(_vm(r1, t), c2);
            t = _hl(t);
            c1 = _va(_vm(r2, t), c1);
            c2 = _vs(c2, _vm(r1, t));
            t = _pr(_vm(r0, r2));
            c1 = _va(_vm(r3, t), c1);
            c3 = _vs(c3, _vm(r1, t));
            t = _hl(t);
            c1 = _vs(c1, _vm(r3, t));
            c3 = _va(_vm(r1, t), c3);
            det = 1.0 / det;
            const out = new _F64(16);
            const cols = [c0, c1, c2, c3];
            for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) out[j * 4 + k] = cols[j][k] * det;
            return out;
        };

        const _trig = ops && ops.op_libm_trig;
        const _sin = _trig ? (x) => _trig(0, x) : Math.sin;
        const _cos = _trig ? (x) => _trig(1, x) : Math.cos;
        const _tan = _trig ? (x) => _trig(2, x) : Math.tan;
        const _atan2 = (ops && ops.op_libm_atan2) || Math.atan2;
        const _H = Math.SQRT2 / 2;
        const _N45 = [[0, 1], [_H, _H], [1, 0], [_H, -_H], [0, -1], [-_H, -_H], [-1, 0], [-_H, _H]];
        const _sinCos = (degrees) => {
            if (degrees > -90000000.0 && degrees < 90000000.0) {
                const n45 = degrees / 45.0;
                let octant = _trunc(n45) | 0;
                if (octant === n45) return _N45[octant & 7];
                if (degrees < 0) --octant;
                degrees -= octant * 45.0;
                if (octant & 1) degrees = 45.0 - degrees;
                const rad = degrees * _PI / 180;
                let s = _sin(rad), c = _cos(rad);
                if ((octant + 1) & 2) { const x = s; s = c; c = x; }
                if (octant & 4) s = -s;
                if ((octant + 2) & 4) c = -c;
                return [s, c];
            }
            const rad = (degrees % 360.0) * _PI / 180;
            return [_sin(rad), _cos(rad)];
        };

        const _tScale = (t, x, y) => {
            x = _fr(x); y = _fr(y);
            const m = t.m;
            if (!t.f) {
                m[0] = _fr(m[0] * x);
                m[5] = _fr(m[5] * y);
                return;
            }
            for (let r = 0; r < 4; r++) { m[r] *= x; m[4 + r] *= y; }
        };
        const _tScale3d = (t, x, y, z) => {
            x = _fr(x); y = _fr(y); z = _fr(z);
            if (z === 1) return _tScale(t, x, y);
            t.f = true;
            const m = t.m;
            for (let r = 0; r < 4; r++) { m[r] *= x; m[4 + r] *= y; m[8 + r] *= z; }
        };
        const _tTranslate = (t, x, y) => {
            x = _fr(x); y = _fr(y);
            const m = t.m;
            if (!t.f) {
                m[12] = _fr(m[12] + _fr(x * m[0]));
                m[13] = _fr(m[13] + _fr(y * m[5]));
                return;
            }
            for (let r = 0; r < 4; r++) m[12 + r] = m[r] * x + m[4 + r] * y + m[12 + r];
        };
        const _tTranslate3d = (t, x, y, z) => {
            x = _fr(x); y = _fr(y); z = _fr(z);
            if (z === 0) return _tTranslate(t, x, y);
            t.f = true;
            const m = t.m;
            for (let r = 0; r < 4; r++) m[12 + r] = m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r];
        };
        const _tPostScale = (t, x, y) => {
            const m = t.m;
            if (!t.f) {
                m[0] = _fr(m[0] * x); m[5] = _fr(m[5] * y);
                m[12] = _fr(m[12] * x); m[13] = _fr(m[13] * y);
                return;
            }
            if (x !== 1) { m[0] *= x; m[4] *= x; m[8] *= x; m[12] *= x; }
            if (y !== 1) { m[1] *= y; m[5] *= y; m[9] *= y; m[13] *= y; }
        };
        const _tPostTranslate = (t, x, y) => {
            const m = t.m;
            if (!t.f) {
                m[12] = _fr(m[12] + x); m[13] = _fr(m[13] + y);
                return;
            }
            if (!_hasPersp(m)) { m[12] += x; m[13] += y; return; }
            if (x !== 0) { m[0] += m[3] * x; m[4] += m[7] * x; m[8] += m[11] * x; m[12] += m[15] * x; }
            if (y !== 0) { m[1] += m[3] * y; m[5] += m[7] * y; m[9] += m[11] * y; m[13] += m[15] * y; }
        };
        const _rotCols = (m, i, j, s, c, sign) => {
            for (let r = 0; r < 4; r++) {
                const a = m[i + r], b = m[j + r];
                m[i + r] = sign ? a * c - b * s : a * c + b * s;
                m[j + r] = sign ? b * c + a * s : b * c - a * s;
            }
        };
        const _rotAxis = (m, axis, s, c) => {
            if (axis === 0) _rotCols(m, 4, 8, s, c, false);
            else if (axis === 1) _rotCols(m, 0, 8, s, c, true);
            else _rotCols(m, 0, 4, s, c, false);
        };
        const _tRotAxis = (t, axis, deg) => {
            const sc = _sinCos(deg);
            if (sc[0] === 0 && sc[1] === 1) return;
            t.f = true;
            _rotAxis(t.m, axis, sc[0], sc[1]);
        };
        const _tRotAbout = (t, x, y, z, deg) => {
            const sc = _sinCos(deg);
            const s = sc[0], c = sc[1];
            if (s === 0 && c === 1) return;
            const sq = x * x + y * y + z * z;
            if (sq === 0) return;
            if (sq !== 1) {
                const k = 1.0 / _sqrt(sq);
                x *= k; y *= k; z *= k;
            }
            t.f = true;
            if (z === 1.0) return _rotAxis(t.m, 2, s, c);
            if (y === 1.0) return _rotAxis(t.m, 1, s, c);
            if (x === 1.0) return _rotAxis(t.m, 0, s, c);
            const C = 1 - c;
            const xs = x * s, ys = y * s, zs = z * s;
            const xC = x * C, yC = y * C, zC = z * C;
            const xyC = x * yC, yzC = y * zC, zxC = z * xC;
            t.m = _concat(t.m, _f64(x * xC + c, xyC + zs, zxC - ys, 0,
                xyC - zs, y * yC + c, yzC + xs, 0,
                zxC + ys, yzC - xs, z * zC + c, 0,
                0, 0, 0, 1));
        };
        const _tSkew = (t, dx, dy) => {
            if (dx === 0 && dy === 0) return;
            const tx = _tan(dx * _PI / 180), ty = _tan(dy * _PI / 180);
            t.f = true;
            const m = t.m;
            for (let r = 0; r < 4; r++) {
                const a = m[r], b = m[4 + r];
                m[r] = a + b * ty;
                m[4 + r] = b + a * tx;
            }
        };
        const _tPersp = (t, depth) => {
            if (depth === 0) return;
            t.f = true;
            const m = t.m, k = -1.0 / depth;
            for (let r = 0; r < 4; r++) m[8 + r] = m[8 + r] + m[12 + r] * k;
        };
        const _tPreConcat = (t, o) => {
            if (!o.f) {
                _tTranslate(t, o.m[12], o.m[13]);
                _tScale(t, o.m[0], o.m[5]);
                return;
            }
            if (!t.f) {
                const sx = t.m[0], sy = t.m[5], tx = t.m[12], ty = t.m[13];
                const c = _copyT(o);
                t.f = true;
                t.m = c.m;
                _tPostScale(t, sx, sy);
                _tPostTranslate(t, tx, ty);
                return;
            }
            t.m = _concat(t.m, o.m);
        };
        const _tMul = (a, b) => {
            if (!b.f) {
                const r = _copyT(a);
                _tTranslate(r, b.m[12], b.m[13]);
                _tScale(r, b.m[0], b.m[5]);
                return r;
            }
            if (!a.f) {
                const r = _copyT(b);
                _tPostScale(r, a.m[0], a.m[5]);
                _tPostTranslate(r, a.m[12], a.m[13]);
                return r;
            }
            return { f: true, m: _concat(a.m, b.m) };
        };
        const _tInvert = (t) => {
            const m = t.m;
            if (!t.f) {
                const sx = m[0], sy = m[5];
                if (_isNormalF(_fr(sx * sy))) {
                    const nx = _fr(1 / sx), ny = _fr(1 / sy);
                    m[0] = nx; m[5] = ny;
                    m[12] = _fr(m[12] * -nx);
                    m[13] = _fr(m[13] * -ny);
                    return true;
                }
                t.m = _ident().m;
                return false;
            }
            const inv = _inverse(m);
            if (inv !== null) { t.m = inv; return true; }
            const id = _ident();
            t.f = false;
            t.m = id.m;
            return false;
        };

        const _LEN_ABS = { __proto__: null, px: 1, cm: 96 / 2.54, mm: 96 / 2.54 / 10, q: 96 / 2.54 / 40, in: 96, pt: 96 / 72, pc: 96 / 6 };
        const _LEN_REL = { __proto__: null };
        for (const u of ["em", "rem", "ex", "rex", "ch", "rch", "ic", "ric", "cap", "rcap", "lh", "rlh",
            "vw", "vh", "vi", "vb", "vmin", "vmax", "svw", "svh", "svi", "svb", "svmin", "svmax",
            "lvw", "lvh", "lvi", "lvb", "lvmin", "lvmax", "dvw", "dvh", "dvi", "dvb", "dvmin", "dvmax",
            "cqw", "cqh", "cqi", "cqb", "cqmin", "cqmax"]) _LEN_REL[u] = true;
        const _ANGLES = { __proto__: null, deg: true, rad: true, grad: true, turn: true };
        const _FNS = { __proto__: null };
        for (const f of ["rotate", "rotatex", "rotatey", "rotatez", "rotate3d", "skew", "skewx", "skewy", "scale", "scalex",
            "scaley", "scalez", "scale3d", "perspective", "translate", "translatex", "translatey", "translatez",
            "translate3d", "matrix", "matrix3d"]) _FNS[f] = true;
        const _clampF = (v) => (v >= _FLT_MAX ? _FLT_MAX : v <= -_FLT_MAX ? -_FLT_MAX : v);
        const _lower = (s) => {
            let out = "";
            for (let i = 0; i < s.length; i++) {
                const c = _cc(s, i);
                out += c >= 65 && c <= 90 ? _fromCP(c + 32) : s[i];
            }
            return out;
        };
        const _isDigit = (c) => c >= 48 && c <= 57;
        const _isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
        const _find = (s, ch, from) => {
            for (let i = from; i < s.length; i++) if (s[i] === ch) return i;
            return -1;
        };
        const _starts = (s, lit, at) => {
            if (at + lit.length > s.length) return false;
            for (let i = 0; i < lit.length; i++) if (s[at + i] !== lit[i]) return false;
            return true;
        };

        const _validDoubleLen = (s, from, end) => {
            const size = end - from;
            if (size < 1) return 0;
            let seen = false, len = 0;
            if (size >= 16) {
                let firstMark = -1, all = true;
                const dec = [];
                for (let k = 0; k < 16; k++) {
                    const c = _cc(s, from + k);
                    dec[k] = _isDigit(c);
                    if (c === 46 && firstMark < 0) firstMark = k;
                    if (!dec[k] && k !== firstMark) all = false;
                }
                if (all) {
                    seen = firstMark >= 0;
                    len = 16;
                } else {
                    for (let k = 0; k < 16; k++) {
                        if (dec[k]) continue;
                        if (k === firstMark && k + 1 < 16 && dec[k + 1]) continue;
                        return k;
                    }
                    return 16;
                }
            }
            for (; len < size; len++) {
                const c = _cc(s, from + len);
                if (_isDigit(c)) continue;
                if (!seen && c === 46) { seen = true; continue; }
                break;
            }
            if (len > 0 && s[from + len - 1] === ".") return 0;
            return len;
        };
        const _POW10 = [1000000, 100000, 10000, 1000, 100, 10, 1];
        const _posDouble = (s, from, end) => {
            const length = _validDoubleLen(s, from, end);
            if (length === 0) return null;
            let pos = 0, local = 0;
            for (; pos < length; pos++) {
                const c = _cc(s, from + pos);
                if (c === 46) break;
                local = local * 10 + (c - 48);
            }
            if (++pos >= length) return [length, local];
            const left = length - pos;
            const nd = left > 7 ? 7 : left;
            if (end - (from + pos) >= 7) {
                let fraction = 0;
                for (let i = 0; i < nd; i++) fraction += (_cc(s, from + pos + i) - 48) * _POW10[i];
                return [length, local + fraction * 1.00000000000000009e-7];
            }
            let fraction = 0, scale = 1;
            for (let i = 0; i < nd; i++) {
                fraction = fraction * 10 + (_cc(s, from + pos + i) - 48);
                scale *= 10;
            }
            return [length, local + fraction / scale];
        };
        const _doubleWithPrefix = (s, from, end) => {
            while (from < end && _isSpace(_cc(s, from))) from++;
            if (from >= end) return null;
            if (s[from] === "-") {
                if (end - from === 1) return null;
                const r = _posDouble(s, from + 1, end);
                if (r === null || r[0] !== end - from - 1) return null;
                return -r[1];
            }
            const r = _posDouble(s, from, end);
            if (r === null || r[0] !== end - from) return null;
            return r[1];
        };
        const _simpleAngle = (s, from, end) => {
            let r, len, v;
            if (end > from && s[from] === "-") {
                r = _posDouble(s, from + 1, end);
                if (r === null) return null;
                len = r[0] + 1;
                v = -(r[1] < _FLT_MAX ? r[1] : _FLT_MAX);
            } else {
                r = _posDouble(s, from, end);
                if (r === null) return null;
                len = r[0];
                v = r[1] < _FLT_MAX ? r[1] : _FLT_MAX;
            }
            const q = from + len, rest = end - q;
            const lc = (k) => _cc(s, q + k) | 0x20;
            if (rest >= 3 && lc(0) === 0x64 && lc(1) === 0x65 && lc(2) === 0x67) return { len: len + 3, v, u: "deg" };
            if (rest >= 4 && lc(0) === 0x67 && lc(1) === 0x72 && lc(2) === 0x61 && lc(3) === 0x64) return { len: len + 4, v, u: "grad" };
            if (rest >= 3 && lc(0) === 0x72 && lc(1) === 0x61 && lc(2) === 0x64) return { len: len + 3, v, u: "rad" };
            if (rest >= 4 && lc(0) === 0x74 && lc(1) === 0x75 && lc(2) === 0x72 && lc(3) === 0x6e) return { len: len + 4, v, u: "turn" };
            return { len, v, u: "" };
        };
        const _canFast = (s) => {
            const len = s.length;
            let i = 0;
            while (i < len) {
                const c = s[i];
                if (c === " ") { i++; continue; }
                if (len - i < 12) return false;
                if (c === "t") { if (s[i + 8] !== "e") return false; i += 9; }
                else if (c === "m") { if (s[i + 7] !== "d") return false; i += 8; }
                else if (c === "s") { if (s[i + 6] !== "d") return false; i += 7; }
                else if (c === "r") { if (s[i + 5] !== "e") return false; i += 6; }
                else return false;
                const close = _find(s, ")", i);
                if (close < 0) return false;
                i = close + 1;
            }
            return i === len;
        };
        const _fastValue = (s, pos) => {
            if (s.length - pos < 12) return null;
            if (_starts(s, "translate", pos)) {
                const c9 = s[pos + 9], c10 = s[pos + 10], c11 = s[pos + 11];
                let name, count = 1, start = 11;
                if ((c9 === "x" || c9 === "X") && c10 === "(") name = "translatex";
                else if ((c9 === "y" || c9 === "Y") && c10 === "(") name = "translatey";
                else if ((c9 === "z" || c9 === "Z") && c10 === "(") name = "translatez";
                else if (c9 === "(") { name = "translate"; count = 2; start = 10; }
                else if (c9 === "3" && c10 === "d" && c11 === "(") { name = "translate3d"; count = 3; start = 12; }
                else return null;
                let p = pos + start;
                const args = [];
                for (; count > 0; count--) {
                    const delim = _find(s, count === 1 ? ")" : ",", p);
                    if (delim < 0) return null;
                    let e = delim, unit = "";
                    const size = delim - p;
                    if (size > 2 && (_cc(s, delim - 2) | 0x20) === 0x70 && (_cc(s, delim - 1) | 0x20) === 0x78) { e -= 2; unit = "px"; }
                    else if (size > 1 && s[delim - 1] === "%") { e -= 1; unit = "%"; }
                    const v = _doubleWithPrefix(s, p, e);
                    if (v === null) return null;
                    if (unit !== "px" && (v !== 0 || unit !== "")) return null;
                    args[args.length] = { v: _clampF(v), u: "px" };
                    p = delim + 1;
                }
                return { fn: { name, args }, next: p };
            }
            let name = null, p = 0, count = 0;
            if (_starts(s, "matrix3d(", pos)) { name = "matrix3d"; p = pos + 9; count = 16; }
            else if (_starts(s, "scale3d(", pos)) { name = "scale3d"; p = pos + 8; count = 3; }
            if (name !== null) {
                const args = [];
                for (; count > 0; count--) {
                    const delim = _find(s, count === 1 ? ")" : ",", p);
                    if (delim < 0) return null;
                    const v = _doubleWithPrefix(s, p, delim);
                    if (v === null) return null;
                    args[args.length] = { v, u: "" };
                    p = delim + 1;
                }
                return { fn: { name, args }, next: p };
            }
            if (_starts(s, "rotate", pos)) {
                const c6 = s[pos + 6];
                if (c6 === "(") { name = "rotate"; p = pos + 7; }
                else if ((c6 === "z" || c6 === "Z") && s[pos + 7] === "(") { name = "rotatez"; p = pos + 8; }
                else return null;
                const delim = _find(s, ")", p);
                if (delim < 0) return null;
                let a = delim === p ? { len: 0, v: 0, u: "" } : _simpleAngle(s, p, delim);
                if (a === null || a.len !== delim - p) return null;
                if (a.u === "") {
                    if (a.v !== 0) return null;
                    a = { len: a.len, v: a.v, u: "deg" };
                }
                return { fn: { name, args: [{ v: a.v, u: a.u }] }, next: delim + 1 };
            }
            return null;
        };
        const _fastTransform = (s) => {
            for (let i = 0; i < s.length; i++) if (_cc(s, i) > 0xff) return null;
            if (!_canFast(s)) return null;
            const list = [];
            let pos = 0;
            while (pos < s.length) {
                while (pos < s.length && s[pos] === " ") pos++;
                if (pos >= s.length) break;
                const r = _fastValue(s, pos);
                if (r === null) return null;
                list[list.length] = r.fn;
                pos = r.next;
            }
            return list.length ? list : null;
        };

        const _isNameStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 0x80;
        const _isHex = (c) => _isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
        const _tokenize = (s) => {
            const toks = [];
            const n = s.length;
            let i = 0;
            const at = (k) => (k < n ? _cc(s, k) : -1);
            const validEscape = (k) => at(k) === 92 && at(k + 1) !== 10 && at(k + 1) !== 12 && at(k + 1) !== 13;
            const startsIdent = (k) => {
                const c = at(k);
                if (c === 45) {
                    const d = at(k + 1);
                    return (d !== -1 && _isNameStart(d)) || d === 45 || validEscape(k + 1);
                }
                if (c !== -1 && _isNameStart(c)) return true;
                return validEscape(k);
            };
            const startsNumber = (k) => {
                const c = at(k);
                if (c === 43 || c === 45) {
                    const d = at(k + 1);
                    return _isDigit(d) || (d === 46 && _isDigit(at(k + 2)));
                }
                if (c === 46) return _isDigit(at(k + 1));
                return _isDigit(c);
            };
            const consumeName = () => {
                let out = "";
                for (;;) {
                    const c = at(i);
                    if (c !== -1 && (_isNameStart(c) || _isDigit(c) || c === 45)) { out += s[i++]; continue; }
                    if (!validEscape(i)) return out;
                    i++;
                    const e = at(i);
                    if (e === -1) { out += "�"; continue; }
                    if (_isHex(e)) {
                        let hex = "";
                        while (hex.length < 6 && _isHex(at(i))) hex += s[i++];
                        if (at(i) === 13 && at(i + 1) === 10) i += 2;
                        else if (_isSpace(at(i))) i++;
                        const cp = _parseInt(hex, 16);
                        out += cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff ? "�" : _fromCP(cp);
                        continue;
                    }
                    out += s[i++];
                }
            };
            while (i < n) {
                const c = at(i);
                if (_isSpace(c)) {
                    while (i < n && _isSpace(at(i))) i++;
                    toks[toks.length] = { t: "ws" };
                    continue;
                }
                if (c === 47 && at(i + 1) === 42) {
                    i += 2;
                    while (i < n && !(at(i) === 42 && at(i + 1) === 47)) i++;
                    i = i < n ? i + 2 : n;
                    continue;
                }
                if (startsNumber(i)) {
                    const start = i;
                    if (at(i) === 43 || at(i) === 45) i++;
                    while (_isDigit(at(i))) i++;
                    if (at(i) === 46 && _isDigit(at(i + 1))) { i += 2; while (_isDigit(at(i))) i++; }
                    const e = at(i);
                    if (e === 69 || e === 101) {
                        const d = at(i + 1);
                        if (_isDigit(d)) { i += 2; while (_isDigit(at(i))) i++; }
                        else if ((d === 43 || d === 45) && _isDigit(at(i + 2))) { i += 3; while (_isDigit(at(i))) i++; }
                    }
                    let text = "";
                    for (let k = start; k < i; k++) text += s[k];
                    const v = _clampF(+text);
                    if (startsIdent(i)) toks[toks.length] = { t: "dim", v, u: consumeName() };
                    else if (at(i) === 37) { i++; toks[toks.length] = { t: "pct", v }; }
                    else toks[toks.length] = { t: "num", v };
                    continue;
                }
                if (startsIdent(i)) {
                    const name = consumeName();
                    if (at(i) === 40) { i++; toks[toks.length] = { t: "fn", s: name }; }
                    else toks[toks.length] = { t: "ident", s: name };
                    continue;
                }
                i++;
                toks[toks.length] = { t: c === 44 ? "," : c === 41 ? ")" : "other" };
            }
            return toks;
        };
        const _fullTransform = (s) => {
            const toks = _tokenize(s);
            const n = toks.length;
            let i = 0;
            const tok = () => (i < n ? toks[i] : null);
            const ws = () => { while (i < n && toks[i].t === "ws") i++; };
            const take = (a) => { i++; ws(); return a; };
            const angle = () => {
                const t = tok();
                if (t === null) return null;
                if (t.t === "dim") {
                    const u = _lower(t.u);
                    return _ANGLES[u] ? take({ v: t.v, u }) : null;
                }
                if (t.t === "num" && t.v === 0) return take({ v: 0, u: "deg" });
                return null;
            };
            const number = () => {
                const t = tok();
                return t !== null && t.t === "num" ? take({ v: t.v, u: "" }) : null;
            };
            const numOrPct = () => {
                const t = tok();
                if (t === null) return null;
                if (t.t === "num") return take({ v: t.v, u: "" });
                if (t.t === "pct") return take({ v: t.v / 100.0, u: "" });
                return null;
            };
            const length = (nonNeg) => {
                const t = tok();
                if (t === null) return null;
                if (t.t === "dim") {
                    const u = _lower(t.u);
                    const rel = _LEN_REL[u] === true;
                    if (_LEN_ABS[u] === undefined && !rel) return null;
                    if (nonNeg && t.v < 0) return null;
                    return take({ v: t.v, u, rel });
                }
                if (t.t === "num" && t.v === 0) return take({ v: t.v, u: "px" });
                return null;
            };
            const lengthOrPct = () => {
                const t = tok();
                if (t !== null && t.t === "pct") return take({ v: t.v, u: "%", rel: true });
                return length(false);
            };
            const comma = () => {
                const t = tok();
                if (t === null || t.t !== ",") return false;
                take(null);
                return true;
            };
            const args = (name) => {
                ws();
                if (i >= n || toks[i].t === ")") return null;
                const out = [];
                const push = (a) => { if (a === null) return false; out[out.length] = a; return true; };
                const list = (count, one, sep) => {
                    for (let k = 0; k < count; k++) {
                        if (!push(one())) return false;
                        if ((sep || k < count - 1) && !comma()) return false;
                    }
                    return true;
                };
                switch (name) {
                    case "rotate": case "rotatex": case "rotatey": case "rotatez": case "skewx": case "skewy": case "skew":
                        if (!push(angle())) return null;
                        if (name === "skew" && comma() && !push(angle())) return null;
                        break;
                    case "scale": case "scalex": case "scaley": case "scalez":
                        if (!push(numOrPct())) return null;
                        if (name === "scale" && comma() && !push(numOrPct())) return null;
                        break;
                    case "perspective": {
                        if (push(length(true))) break;
                        const t = tok();
                        if (t !== null && t.t === "ident" && _lower(t.s) === "none") { push(take({ v: 0, u: "none" })); break; }
                        return null;
                    }
                    case "translate": case "translatex": case "translatey":
                        if (!push(lengthOrPct())) return null;
                        if (name === "translate" && comma() && !push(lengthOrPct())) return null;
                        break;
                    case "translatez":
                        if (!push(length(false))) return null;
                        break;
                    case "matrix":
                        if (!list(6, number, false)) return null;
                        break;
                    case "matrix3d":
                        if (!list(16, number, false)) return null;
                        break;
                    case "scale3d":
                        if (!list(3, numOrPct, false)) return null;
                        break;
                    case "rotate3d":
                        if (!list(3, number, true) || !push(angle())) return null;
                        break;
                    case "translate3d":
                        if (!list(2, lengthOrPct, true) || !push(length(false))) return null;
                        break;
                    default:
                        return null;
                }
                return out;
            };
            ws();
            const first = tok();
            if (first !== null && first.t === "ident" && _lower(first.s) === "none") {
                take(null);
                return i === n ? "none" : null;
            }
            const out = [];
            while (i < n) {
                const t = tok();
                if (t.t !== "fn") return null;
                const name = _lower(t.s);
                if (_FNS[name] !== true) return null;
                i++;
                const a = args(name);
                if (a === null) return null;
                if (i < n) {
                    if (toks[i].t !== ")") return null;
                    i++;
                }
                ws();
                out[out.length] = { name, args: a };
            }
            return out.length ? out : null;
        };

        const _clampLenF = (v) => {
            if (v !== v) v = 0;
            if (v >= 33554428) return 33554428;
            if (v <= -33554430) return -33554430;
            return _fr(v);
        };
        const _clampLenD = (v) => (v !== v ? 0 : v === Infinity ? _DBL_MAX : v === -Infinity ? -_DBL_MAX : v);
        const _px = (a) => (a.u === "px" ? a.v * 1 : a.v * _LEN_ABS[a.u] * 1);
        const _deg = (a) => {
            let d = a.v;
            if (a.u === "rad") d = d * (180 / _PI);
            else if (a.u === "grad") d = d * (360 / 400);
            else if (a.u === "turn") d = d * 360;
            if (d !== d) d = 0;
            return d >= 2867080569122160 ? 2867080569122160 : d <= -2867080569122160 ? -2867080569122160 : d;
        };
        const _applyList = (t, list) => {
            let is2d = true;
            for (let k = 0; k < list.length; k++) {
                const a = list[k].args;
                switch (list[k].name) {
                    case "scale": _tScale3d(t, a[0].v, a.length > 1 ? a[1].v : a[0].v, 1); break;
                    case "scalex": _tScale3d(t, a[0].v, 1, 1); break;
                    case "scaley": _tScale3d(t, 1, a[0].v, 1); break;
                    case "scalez": _tScale3d(t, 1, 1, a[0].v); is2d = false; break;
                    case "scale3d": _tScale3d(t, a[0].v, a[1].v, a[2].v); is2d = false; break;
                    case "translate": _tTranslate3d(t, _clampLenF(_px(a[0])), a.length > 1 ? _clampLenF(_px(a[1])) : 0, 0); break;
                    case "translatex": _tTranslate3d(t, _clampLenF(_px(a[0])), 0, 0); break;
                    case "translatey": _tTranslate3d(t, 0, _clampLenF(_px(a[0])), 0); break;
                    case "translatez": _tTranslate3d(t, 0, 0, _clampLenD(_px(a[0]))); is2d = false; break;
                    case "translate3d":
                        _tTranslate3d(t, _clampLenF(_px(a[0])), _clampLenF(_px(a[1])), _clampLenD(_px(a[2])));
                        is2d = false;
                        break;
                    case "rotate": _tRotAxis(t, 2, _deg(a[0])); break;
                    case "rotatez": _tRotAbout(t, 0, 0, 1, _deg(a[0])); break;
                    case "rotatex": _tRotAbout(t, 1, 0, 0, _deg(a[0])); is2d = false; break;
                    case "rotatey": _tRotAbout(t, 0, 1, 0, _deg(a[0])); is2d = false; break;
                    case "rotate3d": _tRotAbout(t, _fr(a[0].v), _fr(a[1].v), _fr(a[2].v), _deg(a[3])); is2d = false; break;
                    case "skew": _tSkew(t, _deg(a[0]), a.length > 1 ? _deg(a[1]) : 0); break;
                    case "skewx": _tSkew(t, _deg(a[0]), 0); break;
                    case "skewy": _tSkew(t, 0, _deg(a[0])); break;
                    case "matrix":
                        _tPreConcat(t, { f: true, m: _f64(a[0].v, a[1].v, 0, 0, a[2].v, a[3].v, 0, 0, 0, 0, 1, 0, a[4].v, a[5].v, 0, 1) });
                        break;
                    case "matrix3d": {
                        const m = new _F64(16);
                        for (let q = 0; q < 16; q++) m[q] = a[q].v;
                        _tPreConcat(t, { f: true, m });
                        is2d = false;
                        break;
                    }
                    case "perspective":
                        if (a[0].u !== "none") {
                            const p = _clampLenD(_px(a[0]));
                            _tPersp(t, 1.0 < p ? p : 1.0);
                        }
                        is2d = false;
                        break;
                }
            }
            return is2d;
        };
        const _parseMatrix = (text, where) => {
            const src = text === "" ? "matrix(1, 0, 0, 1, 0, 0)" : text;
            let list = _fastTransform(src);
            if (list === null) list = _fullTransform(src);
            if (list === null) throw _domError(`${where}: Failed to parse '${text}'.`, "SyntaxError");
            if (list === "none") return { t: _ident(), is2d: true };
            for (let k = 0; k < list.length; k++) {
                const a = list[k].args;
                for (let q = 0; q < a.length; q++) {
                    if (a[q].rel === true) throw _domError(`${where}: Values must be resolvable at parse time`, "SyntaxError");
                }
            }
            const t = _ident();
            const is2d = _applyList(t, list);
            return { t, is2d };
        };

        const _matrixInit = (v, where) => {
            const type = "DOMMatrixInit";
            const d = _dict(v, type, where);
            const g = { __proto__: null };
            const keys2d = ["a", "b", "c", "d", "e", "f", "m11", "m12", "m21", "m22", "m41", "m42"];
            for (let k = 0; k < keys2d.length; k++) g[keys2d[k]] = _field(d, keys2d[k], type, where);
            const is2DRaw = d === null ? undefined : d.is2D;
            const keys3d = ["m13", "m14", "m23", "m24", "m31", "m32", "m33", "m34", "m43", "m44"];
            for (let k = 0; k < keys3d.length; k++) g[keys3d[k]] = _field(d, keys3d[k], type, where);
            const bad = (p, q) => p !== undefined && q !== undefined && p !== q && !(p !== p && q !== q);
            if (bad(g.a, g.m11) || bad(g.b, g.m12) || bad(g.c, g.m21) || bad(g.d, g.m22) || bad(g.e, g.m41) || bad(g.f, g.m42)) {
                throw new TypeError(`${where}: Property mismatch on matrix initialization.`);
            }
            const pick = (mk, ak, def) => (g[mk] !== undefined ? g[mk] : g[ak] !== undefined ? g[ak] : def);
            const or = (k, def) => (g[k] === undefined ? def : g[k]);
            const m11 = pick("m11", "a", 1), m12 = pick("m12", "b", 0), m21 = pick("m21", "c", 0);
            const m22 = pick("m22", "d", 1), m41 = pick("m41", "e", 0), m42 = pick("m42", "f", 0);
            const m13 = or("m13", 0), m14 = or("m14", 0), m23 = or("m23", 0), m24 = or("m24", 0), m31 = or("m31", 0);
            const m32 = or("m32", 0), m33 = or("m33", 1), m34 = or("m34", 0), m43 = or("m43", 0), m44 = or("m44", 1);
            const threeD = m31 !== 0 || m32 !== 0 || m13 !== 0 || m23 !== 0 || m43 !== 0 || m14 !== 0 || m24 !== 0
                || m34 !== 0 || m33 !== 1 || m44 !== 1;
            if (is2DRaw !== undefined && is2DRaw && threeD) {
                throw new TypeError(`${where}: The is2D member is set to true but the input matrix is a 3d matrix.`);
            }
            const is2d = is2DRaw !== undefined ? !!is2DRaw : !threeD;
            const m = is2d
                ? _f64(m11, m12, 0, 0, m21, m22, 0, 0, 0, 0, 1, 0, m41, m42, 0, 1)
                : _f64(m11, m12, m13, m14, m21, m22, m23, m24, m31, m32, m33, m34, m41, m42, m43, m44);
            return { t: { f: true, m }, is2d };
        };
        const _fromValues = (v) => {
            const m = v.length === 6
                ? _f64(v[0], v[1], 0, 0, v[2], v[3], 0, 0, 0, 0, 1, 0, v[4], v[5], 0, 1)
                : _f64(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10], v[11], v[12], v[13], v[14], v[15]);
            return { t: { f: true, m }, is2d: v.length === 6 };
        };
        const _SEQ_MSG = "The sequence must contain 6 elements for a 2D matrix or 16 elements for a 3D matrix.";
        const _matrixCtor = (name, rw, init) => {
            const where = `Failed to construct '${name}'`;
            let st;
            if (init === undefined) {
                st = { t: _ident(), is2d: true };
            } else {
                let method;
                if ((typeof init === "object" && init !== null) || typeof init === "function") {
                    method = init[_SymIter];
                    if (method !== undefined && method !== null && typeof method !== "function") {
                        throw new TypeError(`${where}: @@iterator must be a callable.`);
                    }
                }
                if (typeof method === "function") {
                    const iter = _call(method, init);
                    if ((typeof iter !== "object" || iter === null) && typeof iter !== "function") {
                        throw new TypeError(`${where}: The object's @@iterator method must return an object.`);
                    }
                    const next = iter.next;
                    const vals = [];
                    for (;;) {
                        const r = _call(next, iter);
                        if ((typeof r !== "object" || r === null) && typeof r !== "function") {
                            throw new TypeError(`${where}: The iterator's next method must return an object.`);
                        }
                        if (r.done) break;
                        vals[vals.length] = _n(r.value, where);
                    }
                    if (vals.length !== 6 && vals.length !== 16) throw new TypeError(`${where}: ${_SEQ_MSG}`);
                    st = _fromValues(vals);
                } else {
                    if (typeof init === "symbol") throw new TypeError(`${where}: Cannot convert a Symbol value to a string`);
                    const text = `${init}`;
                    if (!_isWindow) throw new TypeError(`${where}: DOMMatrix can't be constructed with strings on workers.`);
                    st = _parseMatrix(text, where);
                }
            }
            return { t: st.t, is2d: st.is2d, rw };
        };
        const _typedArg = (v, type, where) => {
            let tag;
            try { tag = _call(_taTag, v); } catch (_) { tag = undefined; }
            if (tag !== type) throw new TypeError(`${where}: parameter 1 is not of type '${type}'.`);
            if (_sabLength !== null) {
                let shared = true;
                try { _call(_sabLength, _call(_taBuffer, v)); } catch (_) { shared = false; }
                if (shared) throw new TypeError(`${where}: The provided ${type} value must not be shared.`);
            }
            const vals = [];
            const len = _call(_taLength, v);
            for (let i = 0; i < len; i++) vals[i] = v[i];
            return vals;
        };

        const _opTranslate = (s, tx, ty, tz) => {
            if (tx === 0 && ty === 0 && tz === 0) return;
            if (tz !== 0) s.is2d = false;
            if (s.is2d) _tTranslate(s.t, tx, ty);
            else _tTranslate3d(s.t, tx, ty, tz);
        };
        const _opScale = (s, sx, sy, sz, ox, oy, oz) => {
            if (sz !== 1 || oz !== 0) s.is2d = false;
            if (sx === 1 && sy === 1 && sz === 1) return;
            const shifted = ox !== 0 || oy !== 0 || oz !== 0;
            if (shifted) _opTranslate(s, ox, oy, oz);
            if (s.is2d) _tScale(s.t, sx, sy);
            else _tScale3d(s.t, sx, sy, sz);
            if (shifted) _opTranslate(s, -ox, -oy, -oz);
        };
        const _opRotate = (s, rx, ry, rz) => {
            if (rz !== 0) _tRotAxis(s.t, 2, rz);
            if (ry !== 0) { _tRotAxis(s.t, 1, ry); s.is2d = false; }
            if (rx !== 0) { _tRotAxis(s.t, 0, rx); s.is2d = false; }
        };
        const _opRotateAxis = (s, x, y, z, angle) => {
            _tRotAbout(s.t, x, y, z, angle);
            if (x !== 0 || y !== 0) s.is2d = false;
        };
        const _opFromVector = (s, x, y) => _tRotAxis(s.t, 2, _atan2(y, x) * (180 / _PI));
        const _opMultiply = (s, o) => {
            if (!o.is2d) s.is2d = false;
            _tPreConcat(s.t, o.t);
        };
        const _opPreMultiply = (s, o) => {
            if (!o.is2d) s.is2d = false;
            s.t = _tMul(o.t, s.t);
        };
        const _opInvert = (s) => {
            if (_tInvert(s.t)) return;
            const m = new _F64(16);
            for (let i = 0; i < 16; i++) m[i] = NaN;
            s.t = { f: true, m };
            s.is2d = false;
        };
        const _setSlot = (s, idx, v) => {
            s.t.f = true;
            s.t.m[idx] = v;
            if (!s.is2d) return;
            if (idx === 10 || idx === 15) s.is2d = v === 1;
            else if (idx === 2 || idx === 3 || idx === 6 || idx === 7 || idx === 8 || idx === 9 || idx === 11 || idx === 14) s.is2d = v === 0;
        };
        const _scaleArgs = (args, where) => {
            const n = _trimmed(args);
            const sx = _opt(_arg(args, 0), 1, where);
            if (n <= 1) return [sx, sx, 1, 0, 0, 0];
            const sy = _n(_arg(args, 1), where);
            return [sx, sy, _opt(_arg(args, 2), 1, where), _opt(_arg(args, 3), 0, where),
                _opt(_arg(args, 4), 0, where), _opt(_arg(args, 5), 0, where)];
        };
        const _rotateArgs = (args, where) => {
            const n = _trimmed(args);
            const a0 = _opt(_arg(args, 0), 0, where);
            if (n <= 1) return [0, 0, a0];
            const a1 = _n(_arg(args, 1), where);
            if (n === 2) return [a0, a1, 0];
            return [a0, a1, _n(_arg(args, 2), where)];
        };

        let _pointState = null, _rectState = null, _quadState = null, _matrixState = null;
        const _IDX2D = [0, 1, 4, 5, 12, 13];
        const _IDX3D = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
        const _SLOTS = ["m11", "m12", "m13", "m14", "m21", "m22", "m23", "m24", "m31", "m32", "m33", "m34", "m41", "m42", "m43", "m44"];

        class DOMPointReadOnly {
            #p;
            constructor(x = 0, y = 0, z = 0, w = 1) {
                if (_Box.is(x)) { this.#p = x.v; return; }
                const where = "Failed to construct 'DOMPointReadOnly'";
                this.#p = { x: _n(x, where), y: _n(y, where), z: _n(z, where), w: _n(w, where), rw: false };
            }
            static {
                _pointState = (o, rw) => {
                    if (o !== null && typeof o === "object" && #p in o && (!rw || o.#p.rw)) return o.#p;
                    throw new TypeError("Illegal invocation");
                };
            }
            static fromPoint(other = undefined) {
                const p = _pointInit(other, "Failed to execute 'fromPoint' on 'DOMPointReadOnly'");
                return new DOMPointReadOnly(new _Box({ x: p.x, y: p.y, z: p.z, w: p.w, rw: false }));
            }
            get x() { return _pointState(this, false).x; }
            get y() { return _pointState(this, false).y; }
            get z() { return _pointState(this, false).z; }
            get w() { return _pointState(this, false).w; }
            matrixTransform(matrix = undefined) {
                const p = _pointState(this, false);
                const mt = _matrixInit(matrix, "Failed to execute 'matrixTransform' on 'DOMPointReadOnly'");
                const m = mt.t.m;
                if (mt.is2d && p.z === 0 && p.w === 1) {
                    return _newPoint(p.x * m[0] + p.y * m[4] + m[12], p.x * m[1] + p.y * m[5] + m[13], 0, 1);
                }
                return _newPoint(
                    p.x * m[0] + p.y * m[4] + p.z * m[8] + p.w * m[12],
                    p.x * m[1] + p.y * m[5] + p.z * m[9] + p.w * m[13],
                    p.x * m[2] + p.y * m[6] + p.z * m[10] + p.w * m[14],
                    p.x * m[3] + p.y * m[7] + p.z * m[11] + p.w * m[15]);
            }
            toJSON() {
                const p = _pointState(this, false);
                return { x: p.x, y: p.y, z: p.z, w: p.w };
            }
        }
        class DOMPoint extends DOMPointReadOnly {
            constructor(x = 0, y = 0, z = 0, w = 1) {
                if (_Box.is(x)) { super(x); return; }
                const where = "Failed to construct 'DOMPoint'";
                super(new _Box({ x: _n(x, where), y: _n(y, where), z: _n(z, where), w: _n(w, where), rw: true }));
            }
            static fromPoint(other = undefined) {
                const p = _pointInit(other, "Failed to execute 'fromPoint' on 'DOMPoint'");
                return _newPoint(p.x, p.y, p.z, p.w);
            }
        }
        const _newPoint = (x, y, z, w) => new DOMPoint(new _Box({ x, y, z, w, rw: true }));
        for (const k of ["x", "y", "z", "w"]) {
            const get = { [k]() { return _pointState(this, true)[k]; } }[k];
            const set = { [k](v) {
                const p = _pointState(this, true);
                const where = `Failed to set the '${k}' property on 'DOMPoint'`;
                if (arguments.length < 1) throw new TypeError(`${where}: 1 argument required, but only 0 present.`);
                p[k] = _n(v, where);
            } }[k];
            Object.defineProperty(DOMPoint.prototype, k, { get, set, enumerable: true, configurable: true });
        }

        const _nsMin = (a, b) => (a !== a || b !== b ? NaN : b < a ? b : a);
        const _nsMax = (a, b) => (a !== a || b !== b ? NaN : a < b ? b : a);
        class DOMRectReadOnly {
            #r;
            constructor(x = 0, y = 0, width = 0, height = 0) {
                if (_Box.is(x)) { this.#r = x.v; return; }
                const where = "Failed to construct 'DOMRectReadOnly'";
                this.#r = { x: _n(x, where), y: _n(y, where), width: _n(width, where), height: _n(height, where), rw: false };
            }
            static {
                _rectState = (o, rw) => {
                    if (o !== null && typeof o === "object" && #r in o && (!rw || o.#r.rw)) return o.#r;
                    throw new TypeError("Illegal invocation");
                };
            }
            static fromRect(other = undefined) {
                const r = _rectInit(other, "Failed to execute 'fromRect' on 'DOMRectReadOnly'");
                return new DOMRectReadOnly(new _Box({ x: r.x, y: r.y, width: r.width, height: r.height, rw: false }));
            }
            get x() { return _rectState(this, false).x; }
            get y() { return _rectState(this, false).y; }
            get width() { return _rectState(this, false).width; }
            get height() { return _rectState(this, false).height; }
            get top() { const r = _rectState(this, false); return _nsMin(r.y, r.y + r.height); }
            get right() { const r = _rectState(this, false); return _nsMax(r.x, r.x + r.width); }
            get bottom() { const r = _rectState(this, false); return _nsMax(r.y, r.y + r.height); }
            get left() { const r = _rectState(this, false); return _nsMin(r.x, r.x + r.width); }
            toJSON() {
                const r = _rectState(this, false);
                return {
                    x: r.x, y: r.y, width: r.width, height: r.height,
                    top: _nsMin(r.y, r.y + r.height), right: _nsMax(r.x, r.x + r.width),
                    bottom: _nsMax(r.y, r.y + r.height), left: _nsMin(r.x, r.x + r.width),
                };
            }
        }
        class DOMRect extends DOMRectReadOnly {
            constructor(x = 0, y = 0, width = 0, height = 0) {
                if (_Box.is(x)) { super(x); return; }
                const where = "Failed to construct 'DOMRect'";
                super(new _Box({ x: _n(x, where), y: _n(y, where), width: _n(width, where), height: _n(height, where), rw: true }));
            }
            static fromRect(other = undefined) {
                const r = _rectInit(other, "Failed to execute 'fromRect' on 'DOMRect'");
                return _newRect(r.x, r.y, r.width, r.height);
            }
        }
        const _newRect = (x, y, width, height) => new DOMRect(new _Box({ x, y, width, height, rw: true }));
        for (const k of ["x", "y", "width", "height"]) {
            const get = { [k]() { return _rectState(this, true)[k]; } }[k];
            const set = { [k](v) {
                const r = _rectState(this, true);
                const where = `Failed to set the '${k}' property on 'DOMRect'`;
                if (arguments.length < 1) throw new TypeError(`${where}: 1 argument required, but only 0 present.`);
                r[k] = _n(v, where);
            } }[k];
            Object.defineProperty(DOMRect.prototype, k, { get, set, enumerable: true, configurable: true });
        }

        class DOMQuad {
            #q;
            constructor(p1 = undefined, p2 = undefined, p3 = undefined, p4 = undefined) {
                if (_Box.is(p1)) { this.#q = p1.v; return; }
                const where = "Failed to construct 'DOMQuad'";
                const a = _pointInit(p1, where), b = _pointInit(p2, where), c = _pointInit(p3, where), d = _pointInit(p4, where);
                this.#q = [_newPoint(a.x, a.y, a.z, a.w), _newPoint(b.x, b.y, b.z, b.w),
                    _newPoint(c.x, c.y, c.z, c.w), _newPoint(d.x, d.y, d.z, d.w)];
            }
            static {
                _quadState = (o) => {
                    if (o !== null && typeof o === "object" && #q in o) return o.#q;
                    throw new TypeError("Illegal invocation");
                };
            }
            static fromRect(other = undefined) {
                const r = _rectInit(other, "Failed to execute 'fromRect' on 'DOMQuad'");
                return new DOMQuad(new _Box([_newPoint(r.x, r.y, 0, 1), _newPoint(r.x + r.width, r.y, 0, 1),
                    _newPoint(r.x + r.width, r.y + r.height, 0, 1), _newPoint(r.x, r.y + r.height, 0, 1)]));
            }
            static fromQuad(other = undefined) {
                const q = _quadInit(other, "Failed to execute 'fromQuad' on 'DOMQuad'");
                const pts = [];
                for (let k = 0; k < 4; k++) pts[k] = _newPoint(q[k].x, q[k].y, q[k].z, q[k].w);
                return new DOMQuad(new _Box(pts));
            }
            get p1() { return _quadState(this)[0]; }
            get p2() { return _quadState(this)[1]; }
            get p3() { return _quadState(this)[2]; }
            get p4() { return _quadState(this)[3]; }
            getBounds() {
                const q = _quadState(this);
                const a = _pointState(q[0], false), b = _pointState(q[1], false);
                const c = _pointState(q[2], false), d = _pointState(q[3], false);
                const x = _nsMin(_nsMin(a.x, b.x), _nsMin(c.x, d.x));
                const y = _nsMin(_nsMin(a.y, b.y), _nsMin(c.y, d.y));
                const w = _nsMax(_nsMax(a.x, b.x), _nsMax(c.x, d.x)) - x;
                const h = _nsMax(_nsMax(a.y, b.y), _nsMax(c.y, d.y)) - y;
                return _newRect(x, y, w, h);
            }
            toJSON() {
                const q = _quadState(this);
                return { p1: q[0], p2: q[1], p3: q[2], p4: q[3] };
            }
        }

        const _RO = "DOMMatrixReadOnly";
        const _exec = (method, cls) => `Failed to execute '${method}' on '${cls}'`;
        const _dup = (s) => new DOMMatrix(new _Box({ t: _copyT(s.t), is2d: s.is2d, rw: true }));
        class DOMMatrixReadOnly {
            #s;
            constructor(init = undefined) {
                this.#s = _Box.is(init) ? init.v : _matrixCtor(_RO, false, init);
            }
            static {
                _matrixState = (o, rw) => {
                    if (o !== null && typeof o === "object" && #s in o && (!rw || o.#s.rw)) return o.#s;
                    throw new TypeError("Illegal invocation");
                };
            }
            static fromMatrix(other = undefined) {
                const st = _matrixInit(other, _exec("fromMatrix", _RO));
                return new DOMMatrixReadOnly(new _Box({ t: st.t, is2d: st.is2d, rw: false }));
            }
            static fromFloat32Array(array32) {
                const where = _exec("fromFloat32Array", _RO);
                _need(arguments, 1, where);
                const v = _typedArg(array32, "Float32Array", where);
                if (v.length !== 6 && v.length !== 16) {
                    throw new TypeError(`${where}: The sequence must contain 6 elements for a 2D matrix or 16 elements a for 3D matrix.`);
                }
                const st = _fromValues(v);
                return new DOMMatrixReadOnly(new _Box({ t: st.t, is2d: st.is2d, rw: false }));
            }
            static fromFloat64Array(array64) {
                const where = _exec("fromFloat64Array", _RO);
                _need(arguments, 1, where);
                const v = _typedArg(array64, "Float64Array", where);
                if (v.length !== 6 && v.length !== 16) throw new TypeError(`${where}: ${_SEQ_MSG}`);
                const st = _fromValues(v);
                return new DOMMatrixReadOnly(new _Box({ t: st.t, is2d: st.is2d, rw: false }));
            }
            get a() { return _matrixState(this, false).t.m[0]; }
            get b() { return _matrixState(this, false).t.m[1]; }
            get c() { return _matrixState(this, false).t.m[4]; }
            get d() { return _matrixState(this, false).t.m[5]; }
            get e() { return _matrixState(this, false).t.m[12]; }
            get f() { return _matrixState(this, false).t.m[13]; }
            get m11() { return _matrixState(this, false).t.m[0]; }
            get m12() { return _matrixState(this, false).t.m[1]; }
            get m13() { return _matrixState(this, false).t.m[2]; }
            get m14() { return _matrixState(this, false).t.m[3]; }
            get m21() { return _matrixState(this, false).t.m[4]; }
            get m22() { return _matrixState(this, false).t.m[5]; }
            get m23() { return _matrixState(this, false).t.m[6]; }
            get m24() { return _matrixState(this, false).t.m[7]; }
            get m31() { return _matrixState(this, false).t.m[8]; }
            get m32() { return _matrixState(this, false).t.m[9]; }
            get m33() { return _matrixState(this, false).t.m[10]; }
            get m34() { return _matrixState(this, false).t.m[11]; }
            get m41() { return _matrixState(this, false).t.m[12]; }
            get m42() { return _matrixState(this, false).t.m[13]; }
            get m43() { return _matrixState(this, false).t.m[14]; }
            get m44() { return _matrixState(this, false).t.m[15]; }
            get is2D() { return _matrixState(this, false).is2d; }
            get isIdentity() {
                const m = _matrixState(this, false).t.m;
                for (let i = 0; i < 16; i++) if (m[i] !== (i % 5 === 0 ? 1 : 0)) return false;
                return true;
            }
            translate(tx = 0, ty = 0, tz = 0) {
                const s = _matrixState(this, false), where = _exec("translate", _RO);
                tx = _n(tx, where); ty = _n(ty, where); tz = _n(tz, where);
                const r = _dup(s);
                _opTranslate(_matrixState(r, true), tx, ty, tz);
                return r;
            }
            scale(...args) {
                const s = _matrixState(this, false);
                const v = _scaleArgs(args, _exec("scale", _RO));
                const r = _dup(s);
                _opScale(_matrixState(r, true), v[0], v[1], v[2], v[3], v[4], v[5]);
                return r;
            }
            scaleNonUniform(scaleX = 1, scaleY = 1) {
                const s = _matrixState(this, false), where = _exec("scaleNonUniform", _RO);
                scaleX = _n(scaleX, where); scaleY = _n(scaleY, where);
                const r = _dup(s);
                _opScale(_matrixState(r, true), scaleX, scaleY, 1, 0, 0, 0);
                return r;
            }
            scale3d(scale = 1, originX = 0, originY = 0, originZ = 0) {
                const s = _matrixState(this, false), where = _exec("scale3d", _RO);
                scale = _n(scale, where); originX = _n(originX, where); originY = _n(originY, where); originZ = _n(originZ, where);
                const r = _dup(s);
                _opScale(_matrixState(r, true), scale, scale, scale, originX, originY, originZ);
                return r;
            }
            rotate(...args) {
                const s = _matrixState(this, false);
                const v = _rotateArgs(args, _exec("rotate", _RO));
                const r = _dup(s);
                _opRotate(_matrixState(r, true), v[0], v[1], v[2]);
                return r;
            }
            rotateFromVector(x = 0, y = 0) {
                const s = _matrixState(this, false), where = _exec("rotateFromVector", _RO);
                x = _n(x, where); y = _n(y, where);
                const r = _dup(s);
                _opFromVector(_matrixState(r, true), x, y);
                return r;
            }
            rotateAxisAngle(x = 0, y = 0, z = 0, angle = 0) {
                const s = _matrixState(this, false), where = _exec("rotateAxisAngle", _RO);
                x = _n(x, where); y = _n(y, where); z = _n(z, where); angle = _n(angle, where);
                const r = _dup(s);
                _opRotateAxis(_matrixState(r, true), x, y, z, angle);
                return r;
            }
            skewX(sx = 0) {
                const s = _matrixState(this, false);
                sx = _n(sx, _exec("skewX", _RO));
                const r = _dup(s);
                _tSkew(_matrixState(r, true).t, sx, 0);
                return r;
            }
            skewY(sy = 0) {
                const s = _matrixState(this, false);
                sy = _n(sy, _exec("skewY", _RO));
                const r = _dup(s);
                _tSkew(_matrixState(r, true).t, 0, sy);
                return r;
            }
            multiply(other = undefined) {
                const s = _matrixState(this, false);
                const o = _matrixInit(other, _exec("multiply", _RO));
                const r = _dup(s);
                _opMultiply(_matrixState(r, true), o);
                return r;
            }
            flipX() {
                const s = _matrixState(this, false);
                const r = _dup(s), rs = _matrixState(r, true);
                const m = s.t.m;
                const v0 = -m[0], v1 = -m[1], v2 = -m[2], v3 = -m[3];
                _setSlot(rs, 0, v0); _setSlot(rs, 1, v1); _setSlot(rs, 2, v2); _setSlot(rs, 3, v3);
                return r;
            }
            flipY() {
                const s = _matrixState(this, false);
                const r = _dup(s), rs = _matrixState(r, true);
                const m = s.t.m;
                const v4 = -m[4], v5 = -m[5], v6 = -m[6], v7 = -m[7];
                _setSlot(rs, 4, v4); _setSlot(rs, 5, v5); _setSlot(rs, 6, v6); _setSlot(rs, 7, v7);
                return r;
            }
            inverse() {
                const r = _dup(_matrixState(this, false));
                _opInvert(_matrixState(r, true));
                return r;
            }
            transformPoint(point = undefined) {
                const s = _matrixState(this, false);
                const p = _pointInit(point, _exec("transformPoint", _RO));
                const m = s.t.m;
                if (s.is2d && p.z === 0 && p.w === 1) {
                    return _newPoint(p.x * m[0] + p.y * m[4] + m[12], p.x * m[1] + p.y * m[5] + m[13], 0, 1);
                }
                return _newPoint(
                    p.x * m[0] + p.y * m[4] + p.z * m[8] + p.w * m[12],
                    p.x * m[1] + p.y * m[5] + p.z * m[9] + p.w * m[13],
                    p.x * m[2] + p.y * m[6] + p.z * m[10] + p.w * m[14],
                    p.x * m[3] + p.y * m[7] + p.z * m[11] + p.w * m[15]);
            }
            toFloat32Array() { return new _F32(_matrixState(this, false).t.m); }
            toFloat64Array() { return new _F64(_matrixState(this, false).t.m); }
            toJSON() {
                const s = _matrixState(this, false);
                const m = s.t.m;
                const out = { a: m[0], b: m[1], c: m[4], d: m[5], e: m[12], f: m[13] };
                for (let i = 0; i < 16; i++) out[_SLOTS[i]] = m[i];
                out.is2D = s.is2d;
                let identity = true;
                for (let i = 0; i < 16; i++) if (m[i] !== (i % 5 === 0 ? 1 : 0)) identity = false;
                out.isIdentity = identity;
                return out;
            }
        }
        class DOMMatrix extends DOMMatrixReadOnly {
            constructor(init = undefined) {
                super(_Box.is(init) ? init : new _Box(_matrixCtor("DOMMatrix", true, init)));
            }
            static fromMatrix(other = undefined) {
                const st = _matrixInit(other, _exec("fromMatrix", "DOMMatrix"));
                return new DOMMatrix(new _Box({ t: st.t, is2d: st.is2d, rw: true }));
            }
            static fromFloat32Array(array32) {
                const where = _exec("fromFloat32Array", "DOMMatrix");
                _need(arguments, 1, where);
                const v = _typedArg(array32, "Float32Array", where);
                if (v.length !== 6 && v.length !== 16) throw new TypeError(`${where}: ${_SEQ_MSG}`);
                const st = _fromValues(v);
                return new DOMMatrix(new _Box({ t: st.t, is2d: st.is2d, rw: true }));
            }
            static fromFloat64Array(array64) {
                const where = _exec("fromFloat64Array", "DOMMatrix");
                _need(arguments, 1, where);
                const v = _typedArg(array64, "Float64Array", where);
                if (v.length !== 6 && v.length !== 16) throw new TypeError(`${where}: ${_SEQ_MSG}`);
                const st = _fromValues(v);
                return new DOMMatrix(new _Box({ t: st.t, is2d: st.is2d, rw: true }));
            }
            multiplySelf(other = undefined) {
                const s = _matrixState(this, true);
                _opMultiply(s, _matrixInit(other, _exec("multiplySelf", "DOMMatrix")));
                return this;
            }
            preMultiplySelf(other = undefined) {
                const s = _matrixState(this, true);
                _opPreMultiply(s, _matrixInit(other, _exec("preMultiplySelf", "DOMMatrix")));
                return this;
            }
            translateSelf(tx = 0, ty = 0, tz = 0) {
                const s = _matrixState(this, true), where = _exec("translateSelf", "DOMMatrix");
                tx = _n(tx, where); ty = _n(ty, where); tz = _n(tz, where);
                _opTranslate(s, tx, ty, tz);
                return this;
            }
            scaleSelf(...args) {
                const s = _matrixState(this, true);
                const v = _scaleArgs(args, _exec("scaleSelf", "DOMMatrix"));
                _opScale(s, v[0], v[1], v[2], v[3], v[4], v[5]);
                return this;
            }
            scale3dSelf(scale = 1, originX = 0, originY = 0, originZ = 0) {
                const s = _matrixState(this, true), where = _exec("scale3dSelf", "DOMMatrix");
                scale = _n(scale, where); originX = _n(originX, where); originY = _n(originY, where); originZ = _n(originZ, where);
                _opScale(s, scale, scale, scale, originX, originY, originZ);
                return this;
            }
            rotateSelf(...args) {
                const s = _matrixState(this, true);
                const v = _rotateArgs(args, _exec("rotateSelf", "DOMMatrix"));
                _opRotate(s, v[0], v[1], v[2]);
                return this;
            }
            rotateFromVectorSelf(x = 0, y = 0) {
                const s = _matrixState(this, true), where = _exec("rotateFromVectorSelf", "DOMMatrix");
                x = _n(x, where); y = _n(y, where);
                _opFromVector(s, x, y);
                return this;
            }
            rotateAxisAngleSelf(x = 0, y = 0, z = 0, angle = 0) {
                const s = _matrixState(this, true), where = _exec("rotateAxisAngleSelf", "DOMMatrix");
                x = _n(x, where); y = _n(y, where); z = _n(z, where); angle = _n(angle, where);
                _opRotateAxis(s, x, y, z, angle);
                return this;
            }
            skewXSelf(sx = 0) {
                const s = _matrixState(this, true);
                _tSkew(s.t, _n(sx, _exec("skewXSelf", "DOMMatrix")), 0);
                return this;
            }
            skewYSelf(sy = 0) {
                const s = _matrixState(this, true);
                _tSkew(s.t, 0, _n(sy, _exec("skewYSelf", "DOMMatrix")));
                return this;
            }
            invertSelf() {
                _opInvert(_matrixState(this, true));
                return this;
            }
        }
        const _ALIAS = { a: 0, b: 1, c: 4, d: 5, e: 12, f: 13 };
        const _accessorOrder = ["a", "b", "c", "d", "e", "f"];
        for (let i = 0; i < 16; i++) _accessorOrder[_accessorOrder.length] = _SLOTS[i];
        for (let i = 0; i < _accessorOrder.length; i++) {
            const k = _accessorOrder[i];
            const idx = k in _ALIAS ? _ALIAS[k] : _SLOTS.indexOf(k);
            const get = { [k]() { return _matrixState(this, true).t.m[idx]; } }[k];
            const set = { [k](v) {
                const s = _matrixState(this, true);
                const where = `Failed to set the '${k}' property on 'DOMMatrix'`;
                if (arguments.length < 1) throw new TypeError(`${where}: 1 argument required, but only 0 present.`);
                _setSlot(s, idx, _n(v, where));
            } }[k];
            Object.defineProperty(DOMMatrix.prototype, k, { get, set, enumerable: true, configurable: true });
        }
        if (_isWindow) {
            Object.defineProperty(DOMMatrixReadOnly.prototype, "toString", {
                value: {
                    toString() {
                        const s = _matrixState(this, false);
                        const m = s.t.m;
                        const idx = s.is2d ? _IDX2D : _IDX3D;
                        let out = "";
                        for (let i = 0; i < idx.length; i++) {
                            const v = m[idx[i]];
                            if (!_isFinite(v)) {
                                throw _domError("Failed to execute 'toString' on 'DOMMatrixReadOnly': DOMMatrix cannot be serialized with NaN or Infinity values.", "InvalidStateError");
                            }
                            out += (i ? ", " : "") + v;
                        }
                        return (s.is2d ? "matrix(" : "matrix3d(") + out + ")";
                    },
                }.toString,
                writable: true, enumerable: true, configurable: true,
            });
            Object.defineProperty(DOMMatrix.prototype, "setMatrixValue", {
                value: {
                    setMatrixValue(transformList) {
                        const s = _matrixState(this, true);
                        const where = _exec("setMatrixValue", "DOMMatrix");
                        _need(arguments, 1, where);
                        if (typeof transformList === "symbol") throw new TypeError(`${where}: Cannot convert a Symbol value to a string`);
                        const st = _parseMatrix(`${transformList}`, where);
                        s.t = st.t;
                        s.is2d = st.is2d;
                        return this;
                    },
                }.setMatrixValue,
                writable: true, enumerable: true, configurable: true,
            });
        }

        for (const [C, name] of [[DOMPointReadOnly, "DOMPointReadOnly"], [DOMPoint, "DOMPoint"],
            [DOMRectReadOnly, "DOMRectReadOnly"], [DOMRect, "DOMRect"], [DOMQuad, "DOMQuad"],
            [DOMMatrixReadOnly, "DOMMatrixReadOnly"], [DOMMatrix, "DOMMatrix"]]) {
            _nativeClass(C, name);
            Object.defineProperty(globalThis, name, { value: C, writable: true, enumerable: false, configurable: true });
        }
        if (_isWindow) {
            Object.defineProperty(globalThis, "WebKitCSSMatrix", { value: DOMMatrix, writable: true, enumerable: false, configurable: true });
        }
    }

})(globalThis);
