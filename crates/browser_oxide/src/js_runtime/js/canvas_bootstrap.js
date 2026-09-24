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
    // data: URL base64 payload → Uint8Array. `toBlob` used to wrap the whole
    // `"data:image/png;base64,...."` *string* in a `Blob`, which text-encodes
    // it — so the resulting Blob's bytes were the literal ASCII of the data
    // URL, not the PNG it names. Nothing that read the blob back (an
    // `<img>.src = URL.createObjectURL(blob)`, a canvas-to-blob upload, a
    // hash of the pixels) saw a real image.
    const _dataUrlToBytes = (dataUrl) => {
        const comma = dataUrl.indexOf(",");
        const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : "";
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
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

    const ops = Deno.core.ops;

    // -- Canvas-based font detection support -----------------------------
    // Some scripts detect installed fonts
    // by comparing measureText widths across candidate families: if
    // measureText("...", "Arial") differs from measureText("...", "sans-serif")
    // the family is reported as installed. Our font_database.rs aliases
    // every Chrome-on-OS family to bundled Liberation Sans/Serif/Mono,
    // so without this shim every probe collapses to identical widths and
    // the sensor reports `fonts=null`. Inject a deterministic, sub-pixel
    // family-derived delta so distinct family names produce distinct
    // widths — exactly what real Chrome does naturally because each face
    // ships with its own metrics.
    const _fontProbeFnvHash = (str) => {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return h;
    };
    // Mirror the fonts present on Chrome for each OS — keep in sync with
    // `window_bootstrap.js` `Font enumeration spoofing` block.
    const _FONT_LIST_BY_OS = {
        "Windows": new Set([
            "arial","arial black","calibri","cambria","comic sans ms","consolas",
            "courier new","georgia","impact","lucida console","segoe ui","tahoma",
            "times new roman","trebuchet ms","verdana",
        ]),
        "macOS": new Set([
            "arial","arial black","comic sans ms","courier new","georgia",
            "helvetica","helvetica neue","impact","lucida grande","menlo",
            "monaco","times new roman","trebuchet ms","verdana",
        ]),
        "Linux": new Set([
            "arial","courier new","dejavu sans","dejavu sans mono","dejavu serif",
            "liberation mono","liberation sans","liberation serif","noto sans",
            "times new roman","ubuntu","verdana",
        ]),
    };
    const _resolveInstalledFonts = () => {
        const os = _getOsName();
        return _FONT_LIST_BY_OS[os] || _FONT_LIST_BY_OS["Linux"];
    };
    const _getOsName = () => {
        try {
            const has = ops.op_has_stealth_profile && ops.op_has_stealth_profile();
            return has ? (ops.op_get_profile_value("os_name") || "Linux") : "Linux";
        } catch (_e) {
            return "Linux";
        }
    };
    let _canvasSeedCache = null;
    const _getCanvasSeed = () => {
        if (_canvasSeedCache !== null) return _canvasSeedCache;
        try {
            const has = ops.op_has_stealth_profile && ops.op_has_stealth_profile();
            const raw = has ? ops.op_get_profile_value("canvas_seed") : "0";
            _canvasSeedCache = BigInt(raw || "0");
        } catch (_e) {
            _canvasSeedCache = 0n;
        }
        return _canvasSeedCache;
    };
    const _GENERIC_FAMILIES = new Set(["sans-serif","serif","monospace","cursive","fantasy","system-ui","ui-sans-serif","ui-serif","ui-monospace"]);
    const _primaryFontFamily = (fontStr) => {
        if (!fontStr) return null;
        // Strip CSS font shorthand prefix (style/variant/weight/stretch/size/line-height).
        // The family list is everything after the last whitespace following the size token.
        const sizeMatch = fontStr.match(/(\d+(?:\.\d+)?)(px|pt|em|rem|%|vh|vw)\s+(.+)$/);
        const familyList = sizeMatch ? sizeMatch[3] : fontStr;
        const first = familyList.split(",")[0] || "";
        return first.replace(/["']/g, "").trim().toLowerCase();
    };

    // Parse CSS color to [r, g, b, a]
    function _parseColor(str) {
        const named = { red:[255,0,0,255], green:[0,128,0,255], blue:[0,0,255,255],
            black:[0,0,0,255], white:[255,255,255,255], yellow:[255,255,0,255],
            cyan:[0,255,255,255], magenta:[255,0,255,255], transparent:[0,0,0,0] };
        if (named[str]) return named[str];
        if (str.startsWith('#')) {
            const h = str.slice(1);
            if (h.length === 3) return [parseInt(h[0]+h[0],16), parseInt(h[1]+h[1],16), parseInt(h[2]+h[2],16), 255];
            if (h.length === 6) return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16), 255];
        }
        const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (m) return [+m[1], +m[2], +m[3], m[4] !== undefined ? Math.round(+m[4]*255) : 255];
        return [0, 0, 0, 255];
    }

    class ImageData {
        constructor(data, width, height) {
            const _st = _idl.own(this);
            if (arguments.length === 2) {
                // constructor(width, height)
                height = width;
                width = data;
                data = new Uint8ClampedArray(width * height * 4);
            }
            _st.data = data;
            _st.width = width;
            _st.height = height;
        }
    }
    _idl.fields(ImageData.prototype, ["data", "height", "width"]);
    globalThis.ImageData = ImageData;
    _maskFunction(ImageData, 'ImageData');

    // A context's `canvas` back-reference. Every browser has it, and library
    // code leans on it constantly — `ctx.canvas.width`, `ctx.canvas.toDataURL()`,
    // passing `ctx.canvas` on as a drawing source. Ours had none, so all of
    // those read `undefined` and either threw or silently produced `NaN`.
    //
    // Kept in a WeakMap behind a prototype accessor rather than as an own
    // property, which is where Chrome exposes it and what
    // `Object.getOwnPropertyNames(ctx)` must keep showing.
    const _ctxCanvas = new WeakMap();
    // One 2D context per canvas, as in a browser: `c.getContext('2d') ===
    // c.getContext('2d')` is true there and was false here. Beyond the tell,
    // handing out a fresh context each call gave every caller its own copy of
    // the readable state while the engine kept one — the two drifted apart.
    const _ctx2d = new WeakMap();
    const _context2dFor = (el, id) => {
        let ctx = _ctx2d.get(el);
        if (!ctx) {
            ctx = new CanvasRenderingContext2D(id, el);
            _ctx2d.set(el, ctx);
        }
        return ctx;
    };

    // The readable half of the context state.
    //
    // Every one of these used to read back `undefined`: some were setter-only,
    // and the rest did not exist at all, so assigning them quietly created a
    // plain property the engine never saw. Chrome returns a value for each, and
    // code that does `const prev = ctx.fillStyle; …; ctx.fillStyle = prev`
    // — a very common idiom — restored `undefined` instead.
    const _defaultState = () => ({
        fillStyle: "#000000",
        strokeStyle: "#000000",
        globalAlpha: 1,
        globalCompositeOperation: "source-over",
        lineWidth: 1,
        lineCap: "butt",
        lineJoin: "miter",
        miterLimit: 10,
        lineDashOffset: 0,
        font: "10px sans-serif",
        textAlign: "start",
        textBaseline: "alphabetic",
        direction: "inherit",
        letterSpacing: "0px",
        wordSpacing: "0px",
        fontKerning: "auto",
        fontStretch: "normal",
        fontVariantCaps: "normal",
        textRendering: "auto",
        shadowBlur: 0,
        shadowColor: "rgba(0, 0, 0, 0)",
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        filter: "none",
        imageSmoothingEnabled: true,
        imageSmoothingQuality: "low",
    });

    let _resetCtxState;
    class CanvasRenderingContext2D {
        #font;
        #id;
        #s = _defaultState();
        #stack = [];
        constructor(id, canvasEl) {
            this.#id = id;
            if (canvasEl) _ctxCanvas.set(this, canvasEl);
        }

        // Resizing a canvas resets the bitmap and the engine-side drawing
        // state, so the mirror resets with them. Reached through a module-local
        // function rather than a method: `Object.getOwnPropertyNames` on the
        // prototype has to keep matching Chrome's.
        static {
            _resetCtxState = (ctx) => {
                ctx.#s = _defaultState();
                ctx.#stack = [];
            };
        }

        // Style
        set fillStyle(v) {
            if (v && typeof v === "object" && _idl.own(v)._type) {
                // Gradient object
                const stops = (v._stops || []).map(s => {
                    const c = _parseColor(s.color);
                    return [s.offset, c[0], c[1], c[2], c[3]];
                });
                let coords;
                if (_idl.own(v)._type === "linear") {
                    coords = [v._x0, v._y0, v._x1, v._y1];
                } else {
                    coords = [v._x0, v._y0, v._r0, v._x1, v._y1, v._r1];
                }
                ops.op_canvas_set_fill_gradient(this.#id, _idl.own(v)._type, JSON.stringify({ coords, stops }));
                this.#s.fillStyle = v;
            } else {
                ops.op_canvas_set_fill_style(this.#id, String(v));
                this.#s.fillStyle = String(v);
            }
        }
        get fillStyle() { return this.#s.fillStyle; }
        set strokeStyle(v) {
            this.#s.strokeStyle = (v && typeof v === "object") ? v : String(v);
            if (!v || typeof v !== "object") ops.op_canvas_set_stroke_style(this.#id, String(v));
        }
        get strokeStyle() { return this.#s.strokeStyle; }
        set lineWidth(v) {
            const n = +v;
            if (!isFinite(n) || n <= 0) return;
            this.#s.lineWidth = n;
            ops.op_canvas_set_line_width(this.#id, n);
        }
        get lineWidth() { return this.#s.lineWidth; }
        set globalAlpha(v) {
            const n = +v;
            if (!isFinite(n) || n < 0 || n > 1) return;
            this.#s.globalAlpha = n;
            ops.op_canvas_set_global_alpha(this.#id, n);
        }
        get globalAlpha() { return this.#s.globalAlpha; }
        set globalCompositeOperation(v) {
            this.#s.globalCompositeOperation = String(v);
            ops.op_canvas_set_composite(this.#id, String(v));
        }
        get globalCompositeOperation() { return this.#s.globalCompositeOperation; }
        set font(v) {
            this.#s.font = String(v);
            this.#font = this.#s.font;
            ops.op_canvas_set_font(this.#id, this.#s.font);
        }
        get font() { return this.#s.font; }

        set shadowBlur(v) {
            const n = +v;
            if (!isFinite(n) || n < 0) return;
            this.#s.shadowBlur = n;
            ops.op_canvas_set_shadow_blur(this.#id, n);
        }
        get shadowBlur() { return this.#s.shadowBlur; }
        set shadowColor(v) {
            this.#s.shadowColor = String(v);
            ops.op_canvas_set_shadow_color(this.#id, String(v));
        }
        get shadowColor() { return this.#s.shadowColor; }
        set shadowOffsetX(v) {
            const n = +v;
            if (!isFinite(n)) return;
            this.#s.shadowOffsetX = n;
            ops.op_canvas_set_shadow_offset(this.#id, n, this.#s.shadowOffsetY);
        }
        get shadowOffsetX() { return this.#s.shadowOffsetX; }
        set shadowOffsetY(v) {
            const n = +v;
            if (!isFinite(n)) return;
            this.#s.shadowOffsetY = n;
            ops.op_canvas_set_shadow_offset(this.#id, this.#s.shadowOffsetX, n);
        }
        get shadowOffsetY() { return this.#s.shadowOffsetY; }
        set filter(v) {
            this.#s.filter = String(v);
            ops.op_canvas_set_filter(this.#id, String(v));
        }
        get filter() { return this.#s.filter; }

        // Mirrored only: the raster backend does not act on these yet, but
        // Chrome always reports a value and pages save/restore them.
        set miterLimit(v) { const n = +v; if (isFinite(n)) this.#s.miterLimit = n; }
        get miterLimit() { return this.#s.miterLimit; }
        set lineDashOffset(v) { const n = +v; if (isFinite(n)) this.#s.lineDashOffset = n; }
        get lineDashOffset() { return this.#s.lineDashOffset; }
        set lineCap(v) { this.#s.lineCap = String(v); }
        get lineCap() { return this.#s.lineCap; }
        set lineJoin(v) { this.#s.lineJoin = String(v); }
        get lineJoin() { return this.#s.lineJoin; }
        set textAlign(v) { this.#s.textAlign = String(v); }
        get textAlign() { return this.#s.textAlign; }
        set textBaseline(v) { this.#s.textBaseline = String(v); }
        get textBaseline() { return this.#s.textBaseline; }
        set direction(v) { this.#s.direction = String(v); }
        get direction() { return this.#s.direction; }
        set letterSpacing(v) { this.#s.letterSpacing = String(v); }
        get letterSpacing() { return this.#s.letterSpacing; }
        set wordSpacing(v) { this.#s.wordSpacing = String(v); }
        get wordSpacing() { return this.#s.wordSpacing; }
        set fontKerning(v) { this.#s.fontKerning = String(v); }
        get fontKerning() { return this.#s.fontKerning; }
        set fontStretch(v) { this.#s.fontStretch = String(v); }
        get fontStretch() { return this.#s.fontStretch; }
        set fontVariantCaps(v) { this.#s.fontVariantCaps = String(v); }
        get fontVariantCaps() { return this.#s.fontVariantCaps; }
        set textRendering(v) { this.#s.textRendering = String(v); }
        get textRendering() { return this.#s.textRendering; }
        set imageSmoothingQuality(v) { this.#s.imageSmoothingQuality = String(v); }
        get imageSmoothingQuality() { return this.#s.imageSmoothingQuality; }
        set imageSmoothingEnabled(v) { this.#s.imageSmoothingEnabled = !!v; }
        get imageSmoothingEnabled() { return this.#s.imageSmoothingEnabled; }

        // Rectangles
        fillRect(x, y, w, h) { ops.op_canvas_fill_rect(this.#id, x, y, w, h); }
        strokeRect(x, y, w, h) { ops.op_canvas_stroke_rect(this.#id, x, y, w, h); }
        clearRect(x, y, w, h) { ops.op_canvas_clear_rect(this.#id, x, y, w, h); }

        // Path
        beginPath() { ops.op_canvas_begin_path(this.#id); }
        moveTo(x, y) { ops.op_canvas_move_to(this.#id, x, y); }
        lineTo(x, y) { ops.op_canvas_line_to(this.#id, x, y); }
        fill() { ops.op_canvas_fill(this.#id); }
        stroke() { ops.op_canvas_stroke(this.#id); }
        closePath() { ops.op_canvas_close_path(this.#id); }
        arc(x, y, r, startAngle, endAngle, counterclockwise) {
            ops.op_canvas_arc(this.#id, x, y, r, startAngle, endAngle, !!counterclockwise);
        }
        arcTo(x1, y1, x2, y2, r) {
            ops.op_canvas_arc_to(this.#id, x1, y1, x2, y2, r);
        }
        bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
            ops.op_canvas_bezier_curve_to(this.#id, cp1x, cp1y, cp2x, cp2y, x, y);
        }
        quadraticCurveTo(cpx, cpy, x, y) {
            ops.op_canvas_quadratic_curve_to(this.#id, cpx, cpy, x, y);
        }
        ellipse(x, y, rx, ry, rotation, startAngle, endAngle, counterclockwise) {
            ops.op_canvas_ellipse(this.#id, x, y, rx, ry, rotation, startAngle, endAngle, !!counterclockwise);
        }
        rect(x, y, w, h) { this.moveTo(x,y); this.lineTo(x+w,y); this.lineTo(x+w,y+h); this.lineTo(x,y+h); this.closePath(); }

        // Text
        fillText(text, x, y) { ops.op_canvas_fill_text(this.#id, text, x, y); }
        strokeText(text, x, y) { ops.op_canvas_stroke_text(this.#id, text, x, y); }
        measureText(text) {
            // Full 13-field TextMetrics shaped in Rust (T1.2 font stack).
            // actualBoundingBox* come from the real glyph run, not a
            // derived ratio — this is what fingerprint sites probe.
            // Widths come from the engine's per-family metrics table, which
            // carries the real Chrome advances for the claimed profile. A
            // per-family delta used to be added here to keep font-detection
            // probes from seeing one collapsed width for every family; it did
            // not scale with font size, which no real font metric does, and it
            // broke the macOS equalities (Arial/Helvetica, Courier New/Monaco).
            const m = ops.op_canvas_measure_text_full(this.#id, text);
            return {
                width: m.width,
                actualBoundingBoxLeft: m.actual_bounding_box_left,
                actualBoundingBoxRight: m.actual_bounding_box_right,
                actualBoundingBoxAscent: m.actual_bounding_box_ascent,
                actualBoundingBoxDescent: m.actual_bounding_box_descent,
                fontBoundingBoxAscent: m.font_bounding_box_ascent,
                fontBoundingBoxDescent: m.font_bounding_box_descent,
                emHeightAscent: m.em_height_ascent,
                emHeightDescent: m.em_height_descent,
                alphabeticBaseline: m.alphabetic_baseline,
                hangingBaseline: m.hanging_baseline,
                ideographicBaseline: m.ideographic_baseline,
            };
        }

        // Transform
        save() {
            this.#stack.push(Object.assign({}, this.#s));
            ops.op_canvas_save(this.#id);
        }
        restore() {
            const prev = this.#stack.pop();
            if (prev) this.#s = prev;
            ops.op_canvas_restore(this.#id);
        }
        translate(x, y) { ops.op_canvas_translate(this.#id, x, y); }
        rotate(angle) { ops.op_canvas_rotate(this.#id, angle); }
        scale(x, y) { ops.op_canvas_scale(this.#id, x, y); }
        setTransform(a, b, c, d, e, f) {
            // Spec also accepts a single DOMMatrix-init dict; handle both shapes.
            if (typeof a === "object" && a !== null) {
                ops.op_canvas_set_transform(
                    this.#id, a.a ?? 1, a.b ?? 0, a.c ?? 0, a.d ?? 1, a.e ?? 0, a.f ?? 0
                );
            } else {
                ops.op_canvas_set_transform(this.#id, a, b, c, d, e, f);
            }
        }
        resetTransform() { ops.op_canvas_reset_transform(this.#id); }
        getTransform() {
            const t = ops.op_canvas_get_transform(this.#id);
            const M = globalThis.DOMMatrix;
            if (typeof M === "function") return new M([t[0], t[1], t[2], t[3], t[4], t[5]]);
            return { a: t[0], b: t[1], c: t[2], d: t[3], e: t[4], f: t[5] };
        }

        // Image data — real pixel ops
        getImageData(x, y, w, h) {
            const raw = ops.op_canvas_get_image_data(this.#id, x, y, w, h);
            return new ImageData(new Uint8ClampedArray(raw), w, h);
        }
        putImageData(imageData, dx, dy) {
            // `ImageData.data` is a `Uint8ClampedArray` in every browser, and the
            // op binding only accepts a `Uint8Array` — so this threw
            // "expected typed ArrayBufferView" on the one type it is always
            // given. The whole read-modify-write pixel path
            // (`getImageData` → edit → `putImageData`) was dead, including the
            // round trip through our own `getImageData`, which hands back
            // exactly that type.
            const d = imageData && imageData.data;
            if (!d) return;
            const bytes = (d instanceof Uint8Array)
                ? d
                : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
            ops.op_canvas_put_image_data(
                this.#id, bytes, dx, dy, imageData.width, imageData.height,
            );
        }
        createImageData(w, h) { return new ImageData(w, h); }
        /// All three argument forms, and an `<img>` as a source.
        ///
        /// This used to accept only a canvas and only `(source, dx, dy)`: an
        /// image source drew nothing at all, and the scaling forms silently
        /// dropped their rectangles. Anything that composes a picture out of
        /// sprites — a captcha's tiles, a sprite sheet, a chart's markers —
        /// produced a blank canvas with no error to show for it.
        drawImage(source, a, b, c, d, e, f, g, h) {
            if (!source) return;
            // Where the pixels live: a loaded <img> keeps a decoded-image id,
            // a canvas keeps its own surface id.
            let kind = -1, srcId = -1, natW = 0, natH = 0;
            const imgId = _boNs && _boNs.decodedImageId ? _boNs.decodedImageId(source) : -1;
            const bmpId = _boNs && _boNs.bitmapCanvasId ? _boNs.bitmapCanvasId(source) : undefined;
            if (imgId >= 0) {
                kind = 0; srcId = imgId;
                natW = source.naturalWidth || 0; natH = source.naturalHeight || 0;
            } else if (_idl.own(source)._canvasId !== undefined || bmpId !== undefined) {
                kind = 1; srcId = _idl.own(source)._canvasId !== undefined ? _idl.own(source)._canvasId : bmpId;
                natW = source.width || 0; natH = source.height || 0;
            } else {
                return;
            }
            if (!natW || !natH) return;

            let sx = 0, sy = 0, sw = natW, sh = natH, dx, dy, dw, dh;
            if (arguments.length >= 9) {
                sx = a; sy = b; sw = c; sh = d; dx = e; dy = f; dw = g; dh = h;
            } else if (arguments.length >= 5) {
                dx = a; dy = b; dw = c; dh = d;
            } else {
                dx = a || 0; dy = b || 0; dw = natW; dh = natH;
            }
            ops.op_canvas_draw_image_rect(
                this.#id, kind, srcId,
                sx || 0, sy || 0, sw || 0, sh || 0,
                dx || 0, dy || 0, dw || 0, dh || 0,
            );
        }

        // Gradient — JS-side objects that track color stops
        createLinearGradient(x0, y0, x1, y1) {
            const stops = [];
            return {
                addColorStop(offset, color) { stops.push({ offset, color }); },
                _stops: stops, _type: 'linear', _x0: x0, _y0: y0, _x1: x1, _y1: y1,
            };
        }
        createRadialGradient(x0, y0, r0, x1, y1, r1) {
            const stops = [];
            return {
                addColorStop(offset, color) { stops.push({ offset, color }); },
                _stops: stops, _type: 'radial', _x0: x0, _y0: y0, _r0: r0, _x1: x1, _y1: y1, _r1: r1,
            };
        }
        createPattern(image, repetition) { return { _image: image, _repetition: repetition || 'repeat' }; }

        // Clip
        clip() {}
        isPointInPath() { return false; }
        isPointInStroke() { return false; }
    }

    const _glState = new WeakMap();
    const _gl = (ctx) => {
        let st = _glState.get(ctx);
        if (!st) {
            st = { canvasId: undefined, width: 300, height: 150, clearColor: [0, 0, 0, 0], isWebGL2: true, canvas: null };
            _glState.set(ctx, st);
        }
        return st;
    };
    let _gpuCache = null, _gpuCache1 = null;
    const _g = () => {
        if (_gpuCache) return _gpuCache;
        // Defaults — used when no stealth profile is active. Must match
        // stealth::gpu::common_params_desktop() so probes that check for
        // non-zero MAX_TEXTURE_SIZE etc. don't see `null` in headless mode.
        // Defaults match captured Chrome 147 on macOS arm64
        // (tests/fixtures/chrome147/captured_macos_arm64.json).
        let vendor = "WebKit";
        let renderer = "WebKit WebGL";
        let version = "WebGL 2.0 (OpenGL ES 3.0 Chromium)";
        let shadingLang = "WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)";
        let unmaskedVendor = "Google Inc. (Apple)";
        let unmaskedRenderer = "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)";
        let extensions = [];
        let params = {
            0x0D33: 16384,         // MAX_TEXTURE_SIZE
            0x851C: 16384,         // MAX_CUBE_MAP_TEXTURE_SIZE
            0x84E8: 16384,         // MAX_RENDERBUFFER_SIZE
            0x8073: 2048,          // MAX_3D_TEXTURE_SIZE
            0x8869: 16,            // MAX_VERTEX_ATTRIBS
            0x8DFB: 1024,          // MAX_VERTEX_UNIFORM_VECTORS
            0x8DFD: 15,            // MAX_VARYING_VECTORS
            0x8DFC: 1024,          // MAX_FRAGMENT_UNIFORM_VECTORS
            0x8872: 16,            // MAX_TEXTURE_IMAGE_UNITS
            0x8B4D: 16,            // MAX_VERTEX_TEXTURE_IMAGE_UNITS
            0x8B4C: 32,            // MAX_COMBINED_TEXTURE_IMAGE_UNITS
            // ALIASED_POINT_SIZE_RANGE — captured Chrome 147 macOS: [1, 511] typical
            0x846D: [1.0, 511.0],
            0x846E: [1.0, 1.0],    // ALIASED_LINE_WIDTH_RANGE — Chrome ANGLE on every OS = [1,1]
            0x0D3A: [16384, 16384],// MAX_VIEWPORT_DIMS — captured Chrome 147 macOS
            0x0D56: 8,             // DEPTH_BITS
            0x0D57: 8,             // STENCIL_BITS
            0x80AA: 2,             // SAMPLE_BUFFERS
            0x80A9: 4,             // SAMPLES
        };
        let shaderPrec = {};
        let webgl1 = null;
        try {
            if (ops.op_has_stealth_profile()) {
                // One structure, derived in Rust (`GpuProfile::webgl_surface`):
                // this WebGL 2 surface, its WebGL 1 counterpart, and — under a
                // Firefox profile — the GL identity Gecko reports ("Mozilla",
                // no "(OpenGL ES … Chromium)" suffix) in place of Chrome's.
                const surface = JSON.parse(ops.op_get_profile_value("webgl_surface") || "null");
                if (surface) {
                    vendor = surface.vendor || vendor;
                    renderer = surface.renderer || renderer;
                    version = surface.version || version;
                    shadingLang = surface.shadingLang || shadingLang;
                    unmaskedVendor = surface.unmaskedVendor || unmaskedVendor;
                    unmaskedRenderer = surface.unmaskedRenderer || unmaskedRenderer;
                    if (Array.isArray(surface.extensions)) extensions = surface.extensions;
                    // Keyed by GLenum; merged over the defaults above.
                    Object.assign(params, surface.params || {});
                    shaderPrec = surface.shaderPrec || shaderPrec;
                    webgl1 = surface.webgl1 || null;
                }
            }
        } catch {}
        _gpuCache = {
            vendor, renderer, version, shadingLang,
            unmaskedVendor, unmaskedRenderer,
            extensions, params, shaderPrec, webgl1,
        };
        return _gpuCache;
    };
    const _g1 = () => {
        if (_gpuCache1) return _gpuCache1;
        const base = _g();
        let version = base.version;
        let shadingLang = base.shadingLang;
        let extensions = base.extensions;
        if (base.webgl1) {
            // The profile's own WebGL 1 surface. A WebGL 2 context does not
            // list the extensions WebGL 2 absorbed into core; this one does.
            version = base.webgl1.version || version;
            shadingLang = base.webgl1.shadingLang || shadingLang;
            if (Array.isArray(base.webgl1.extensions) && base.webgl1.extensions.length) {
                extensions = base.webgl1.extensions;
            }
        } else if (/^WebGL 2/.test(version)) {
            // No profile: downgrade the captured-Chrome defaults. The empty
            // extension list defers to getSupportedExtensions()'s own
            // WebGL-1 fallback.
            version = "WebGL 1.0 (OpenGL ES 2.0 Chromium)";
            shadingLang = "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)";
        }
        _gpuCache1 = { ...base, version, shadingLang, extensions };
        return _gpuCache1;
    };
    const _surfaceFor = (ctx) => {
        const st = ctx ? _glState.get(ctx) : null;
        return (st && st.isWebGL2 === false) ? _g1() : _g();
    };
    class WebGLRenderingContext {
        // WebGL constants
        static COLOR_BUFFER_BIT = 0x4000;
        static DEPTH_BUFFER_BIT = 0x0100;
        static STENCIL_BUFFER_BIT = 0x0400;
        static TRIANGLES = 4;
        static TRIANGLE_STRIP = 5;
        static TRIANGLE_FAN = 6;
        static LINES = 1;
        static LINE_STRIP = 3;
        static POINTS = 0;
        static RGBA = 0x1908;
        static UNSIGNED_BYTE = 0x1401;
        static FLOAT = 0x1406;
        static ARRAY_BUFFER = 0x8892;
        static ELEMENT_ARRAY_BUFFER = 0x8893;
        static FRAGMENT_SHADER = 0x8B30;
        static VERTEX_SHADER = 0x8B31;
        static COMPILE_STATUS = 0x8B81;
        static LINK_STATUS = 0x8B82;
        // Parameter pname constants — scripts call e.g. gl.getParameter(gl.MAX_TEXTURE_SIZE).
        static VENDOR = 0x1F00;
        static RENDERER = 0x1F01;
        static VERSION = 0x1F02;
        static SHADING_LANGUAGE_VERSION = 0x8B8C;
        static MAX_TEXTURE_SIZE = 0x0D33;
        static MAX_CUBE_MAP_TEXTURE_SIZE = 0x851C;
        static MAX_RENDERBUFFER_SIZE = 0x84E8;
        static MAX_3D_TEXTURE_SIZE = 0x8073;
        static MAX_VERTEX_ATTRIBS = 0x8869;
        static MAX_VERTEX_UNIFORM_VECTORS = 0x8DFB;
        static MAX_VARYING_VECTORS = 0x8DFD;
        static MAX_FRAGMENT_UNIFORM_VECTORS = 0x8DFC;
        static MAX_TEXTURE_IMAGE_UNITS = 0x8872;
        static MAX_VERTEX_TEXTURE_IMAGE_UNITS = 0x8B4D;
        static MAX_COMBINED_TEXTURE_IMAGE_UNITS = 0x8B4C;
        static ALIASED_POINT_SIZE_RANGE = 0x846D;
        static ALIASED_LINE_WIDTH_RANGE = 0x846E;
        static MAX_VIEWPORT_DIMS = 0x0D3A;
        static DEPTH_BITS = 0x0D56;
        static STENCIL_BITS = 0x0D57;
        static SAMPLE_BUFFERS = 0x80AA;
        static SAMPLES = 0x80A9;
        // Shader-precision-format types
        static LOW_FLOAT = 0x8DF0;
        static MEDIUM_FLOAT = 0x8DF1;
        static HIGH_FLOAT = 0x8DF2;
        static LOW_INT = 0x8DF3;
        static MEDIUM_INT = 0x8DF4;
        static HIGH_INT = 0x8DF5;

        constructor(canvasId, width, height) {
            _glState.set(this, {
                canvasId,
                width: width || 300,
                height: height || 150,
                clearColor: [0, 0, 0, 0],
                isWebGL2: true,
                canvas: null,
            });
        }

        // --- Real operations via Canvas2D backend ---
        clearColor(r, g, b, a) {
            _gl(this).clearColor = [Math.round(r*255), Math.round(g*255), Math.round(b*255), a];
        }
        clear(mask) {
            if (mask & 0x4000 && _gl(this).canvasId !== undefined) { // COLOR_BUFFER_BIT
                const [r, g, b, a] = _gl(this).clearColor;
                const color = `rgba(${r},${g},${b},${a})`;
                ops.op_canvas_set_fill_style(_gl(this).canvasId, color);
                ops.op_canvas_fill_rect(_gl(this).canvasId, 0, 0, _gl(this).width, _gl(this).height);
            }
        }
        readPixels(x, y, w, h, format, type, pixels) {
            if (_gl(this).canvasId === undefined || !pixels) return;
            // Canvas2D stores pixels top-down, WebGL is bottom-up — flip Y
            const flippedY = _gl(this).height - y - h;
            const data = ops.op_canvas_get_image_data(_gl(this).canvasId, x, Math.max(0, flippedY), w, h);
            for (let i = 0; i < data.length && i < pixels.length; i++) {
                pixels[i] = data[i];
            }
        }
        viewport(x, y, w, h) {
            _gl(this).width = w || _gl(this).width;
            _gl(this).height = h || _gl(this).height;
        }

        // --- Parameter queries (fingerprint-relevant values) ---
        //
        // All values come from the active StealthProfile's gpu_profile entry.
        // Loaded lazily the first time getParameter is called and cached on
        // the WebGLRenderingContext constructor itself (shared across
        // instances). Implementation note: this is now a STATIC accessor
        // wrapper around a closure-scoped cache loader so the methods
        // below don't reference `this._g` — that meant
        // `getParameter.call(somethingElse)` threw
        // `TypeError: this._g is not a function`, which some scripts
        // detect. Real Chrome's native methods don't have that dependency.
        // FIX-D2: the WebGL **1.0** surface. `_g()` above is the WebGL **2.0**
        // surface; a `getContext("webgl")` context must NOT report the WebGL 2
        // version string or expose WebGL-2-only extensions (e.g.
        // `EXT_color_buffer_float`) — that cross-API mismatch differs from
        // real Chrome. Derived from the active
        // profile's `webgl_surface().webgl1`; with no profile the defaults are
        // downgraded to their WebGL 1 strings.
        // Per-instance surface selector. `_isWebGL2 === false` only for a
        // context handed back by `getContext("webgl"/"experimental-webgl")`.
        // Anything else (incl. `getParameter.call(notACtx)`) → WebGL 2 surface,
        // preserving the pre-FIX-D2 default.
        getParameter(pname) {
            const gpu = _surfaceFor(this);
            // String-valued parameters
            if (pname === 0x1F00) return gpu.vendor;                // VENDOR
            if (pname === 0x1F01) return gpu.renderer;              // RENDERER
            if (pname === 0x1F02) return gpu.version;               // VERSION
            if (pname === 0x8B8C) return gpu.shadingLang;           // SHADING_LANGUAGE_VERSION
            if (pname === 0x9245) return gpu.unmaskedVendor;        // UNMASKED_VENDOR_WEBGL
            if (pname === 0x9246) return gpu.unmaskedRenderer;      // UNMASKED_RENDERER_WEBGL
            // Runtime-dependent values (not from the catalog)
            if (pname === 0x0BA2) return [0, 0, _gl(this).width, _gl(this).height]; // VIEWPORT
            // Catalog-sourced numeric/array parameters
            if (gpu.params[pname] !== undefined) return gpu.params[pname];
            return null;
        }
        getSupportedExtensions() {
            const gpu = _surfaceFor(this);
            // Fallback if the catalog is empty (no profile active).
            // Captured from real Chrome 147 on macOS arm64. WebGL 1 contexts get
            // the WebGL-1 list (extensions promoted to core in WebGL 2 reappear;
            // WebGL-2-only ones absent); WebGL 2 contexts get the 36-ext list.
            if (!gpu.extensions.length) {
                if (this && _glState.get(this) && _glState.get(this).isWebGL2 === false) {
                    return [
                        "ANGLE_instanced_arrays","EXT_blend_minmax","EXT_clip_control",
                        "EXT_color_buffer_half_float","EXT_depth_clamp","EXT_disjoint_timer_query",
                        "EXT_float_blend","EXT_frag_depth","EXT_polygon_offset_clamp",
                        "EXT_shader_texture_lod","EXT_texture_compression_bptc",
                        "EXT_texture_compression_rgtc","EXT_texture_filter_anisotropic",
                        "EXT_texture_mirror_clamp_to_edge","EXT_sRGB",
                        "KHR_parallel_shader_compile",
                        "OES_element_index_uint","OES_fbo_render_mipmap","OES_standard_derivatives",
                        "OES_texture_float","OES_texture_float_linear","OES_texture_half_float",
                        "OES_texture_half_float_linear","OES_vertex_array_object",
                        "WEBGL_blend_func_extended","WEBGL_color_buffer_float",
                        "WEBGL_compressed_texture_astc","WEBGL_compressed_texture_etc",
                        "WEBGL_compressed_texture_etc1","WEBGL_compressed_texture_pvrtc",
                        "WEBGL_compressed_texture_s3tc","WEBGL_compressed_texture_s3tc_srgb",
                        "WEBGL_debug_renderer_info","WEBGL_debug_shaders","WEBGL_depth_texture",
                        "WEBGL_draw_buffers","WEBGL_lose_context","WEBGL_multi_draw",
                        "WEBGL_polygon_mode",
                    ];
                }
                return [
                    "EXT_clip_control","EXT_color_buffer_float","EXT_color_buffer_half_float",
                    "EXT_conservative_depth","EXT_depth_clamp","EXT_disjoint_timer_query_webgl2",
                    "EXT_float_blend","EXT_polygon_offset_clamp","EXT_render_snorm",
                    "EXT_texture_compression_bptc","EXT_texture_compression_rgtc",
                    "EXT_texture_filter_anisotropic","EXT_texture_mirror_clamp_to_edge",
                    "EXT_texture_norm16","KHR_parallel_shader_compile",
                    "NV_shader_noperspective_interpolation","OES_draw_buffers_indexed",
                    "OES_sample_variables","OES_shader_multisample_interpolation",
                    "OES_texture_float_linear","WEBGL_blend_func_extended",
                    "WEBGL_clip_cull_distance","WEBGL_compressed_texture_astc",
                    "WEBGL_compressed_texture_etc","WEBGL_compressed_texture_etc1",
                    "WEBGL_compressed_texture_pvrtc","WEBGL_compressed_texture_s3tc",
                    "WEBGL_compressed_texture_s3tc_srgb","WEBGL_debug_renderer_info",
                    "WEBGL_debug_shaders","WEBGL_lose_context","WEBGL_multi_draw",
                    "WEBGL_polygon_mode","WEBGL_provoking_vertex",
                    "WEBGL_render_shared_exponent","WEBGL_stencil_texturing",
                ];
            }
            return gpu.extensions.slice();
        }
        getExtension(name) {
            if (name === "WEBGL_debug_renderer_info") return { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
            // Any supported extension gets a non-null stub. Fingerprinters
            // call getExtension(name) after getSupportedExtensions to verify.
            // Must agree with this context's getSupportedExtensions() surface —
            // a WebGL 1 ctx returning {} for a WebGL-2-only ext would contradict
            // its own extension list.
            const exts = this.getSupportedExtensions();
            if (exts && exts.includes(name)) return {};
            return null;
        }
        // getContextAttributes — returns the WebGLContextAttributes used at
        // creation. Real Chrome returns these specific defaults.
        getContextAttributes() {
            return {
                alpha: true,
                antialias: true,
                depth: true,
                failIfMajorPerformanceCaveat: false,
                powerPreference: "default",
                premultipliedAlpha: true,
                preserveDrawingBuffer: false,
                stencil: false,
                desynchronized: false,
                xrCompatible: false,
            };
        }
        isContextLost() { return false; }
        getShaderPrecisionFormat(shaderType, precisionType) {
            const gpu = _g();
            const key = `${shaderType}:${precisionType}`;
            if (gpu.shaderPrec[key]) return gpu.shaderPrec[key];
            // Fallback for unknown combinations — float-style values (our old behavior)
            return { rangeMin: 127, rangeMax: 127, precision: 23 };
        }

        // --- Shader/program stubs (needed for API surface) ---
        createShader() { return { _id: 1 }; }
        shaderSource() {}
        compileShader() {}
        getShaderInfoLog() { return ""; }
        getShaderParameter() { return true; }
        createProgram() { return { _id: 1 }; }
        attachShader() {}
        linkProgram() {}
        getProgramInfoLog() { return ""; }
        getProgramParameter() { return true; }
        useProgram() {}
        getUniformLocation() { return { _id: 0 }; }
        getAttribLocation() { return 0; }
        uniform1f() {}
        uniform1i() {}
        uniform2f() {}
        uniform3f() {}
        uniform4f() {}
        uniformMatrix4fv() {}
        createBuffer() { return { _id: 1 }; }
        bindBuffer() {}
        bufferData() {}
        enableVertexAttribArray() {}
        disableVertexAttribArray() {}
        vertexAttribPointer() {}
        drawArrays() {}
        drawElements() {}
        createTexture() { return { _id: 1 }; }
        bindTexture() {}
        texImage2D() {}
        texParameteri() {}
        activeTexture() {}
        generateMipmap() {}
        createFramebuffer() { return { _id: 1 }; }
        bindFramebuffer() {}
        framebufferTexture2D() {}
        createRenderbuffer() { return { _id: 1 }; }
        bindRenderbuffer() {}
        renderbufferStorage() {}
        framebufferRenderbuffer() {}
        checkFramebufferStatus() { return 0x8CD5; } // FRAMEBUFFER_COMPLETE
        enable() {}
        disable() {}
        blendFunc() {}
        blendEquation() {}
        depthFunc() {}
        depthMask() {}
        colorMask() {}
        scissor() {}
        pixelStorei() {}
        getError() { return 0; }
        flush() {}
        finish() {}
        deleteShader() {}
        deleteProgram() {}
        deleteBuffer() {}
        deleteTexture() {}
        deleteFramebuffer() {}
        deleteRenderbuffer() {}
        isContextLost() { return false; }
    }

    // FIX-D2: WebGL2RenderingContext is a SEPARATE constructor from
    // WebGLRenderingContext (real Chrome: `WebGLRenderingContext !==
    // WebGL2RenderingContext`, and a webgl2 ctx has its own constructor +
    // "[object WebGL2RenderingContext]" tag). Pre-FIX-D2 we aliased the two,
    // so `WebGLRenderingContext === WebGL2RenderingContext` was a one-line bot
    // tell. The class shares all method bodies via inheritance; instances
    // carry `_isWebGL2 = true` (set in getContext) so the surface selector
    // returns the WebGL 2 surface. Static `_g/_g1/_surfaceFor/_gpuCache*` are
    // inherited and resolve to the same shared caches.
    class WebGL2RenderingContext {
        constructor(canvasId, width, height) {
            _glState.set(this, {
                canvasId,
                width: width || 300,
                height: height || 150,
                clearColor: [0, 0, 0, 0],
                isWebGL2: true,
                canvas: null,
            });
        }
    }


    {
        const GL_TABLES = { __proto__: null, WebGLRenderingContext: 'canvas;drawingBufferWidth;drawingBufferHeight;drawingBufferColorSpace=;unpackColorSpace=;DEPTH_BUFFER_BIT:256;STENCIL_BUFFER_BIT:1024;COLOR_BUFFER_BIT:16384;POINTS:0;LINES:1;LINE_LOOP:2;LINE_STRIP:3;TRIANGLES:4;TRIANGLE_STRIP:5;TRIANGLE_FAN:6;ZERO:0;ONE:1;SRC_COLOR:768;ONE_MINUS_SRC_COLOR:769;SRC_ALPHA:770;ONE_MINUS_SRC_ALPHA:771;DST_ALPHA:772;ONE_MINUS_DST_ALPHA:773;DST_COLOR:774;ONE_MINUS_DST_COLOR:775;SRC_ALPHA_SATURATE:776;FUNC_ADD:32774;BLEND_EQUATION:32777;BLEND_EQUATION_RGB:32777;BLEND_EQUATION_ALPHA:34877;FUNC_SUBTRACT:32778;FUNC_REVERSE_SUBTRACT:32779;BLEND_DST_RGB:32968;BLEND_SRC_RGB:32969;BLEND_DST_ALPHA:32970;BLEND_SRC_ALPHA:32971;CONSTANT_COLOR:32769;ONE_MINUS_CONSTANT_COLOR:32770;CONSTANT_ALPHA:32771;ONE_MINUS_CONSTANT_ALPHA:32772;BLEND_COLOR:32773;ARRAY_BUFFER:34962;ELEMENT_ARRAY_BUFFER:34963;ARRAY_BUFFER_BINDING:34964;ELEMENT_ARRAY_BUFFER_BINDING:34965;STREAM_DRAW:35040;STATIC_DRAW:35044;DYNAMIC_DRAW:35048;BUFFER_SIZE:34660;BUFFER_USAGE:34661;CURRENT_VERTEX_ATTRIB:34342;FRONT:1028;BACK:1029;FRONT_AND_BACK:1032;TEXTURE_2D:3553;CULL_FACE:2884;BLEND:3042;DITHER:3024;STENCIL_TEST:2960;DEPTH_TEST:2929;SCISSOR_TEST:3089;POLYGON_OFFSET_FILL:32823;SAMPLE_ALPHA_TO_COVERAGE:32926;SAMPLE_COVERAGE:32928;NO_ERROR:0;INVALID_ENUM:1280;INVALID_VALUE:1281;INVALID_OPERATION:1282;OUT_OF_MEMORY:1285;CW:2304;CCW:2305;LINE_WIDTH:2849;ALIASED_POINT_SIZE_RANGE:33901;ALIASED_LINE_WIDTH_RANGE:33902;CULL_FACE_MODE:2885;FRONT_FACE:2886;DEPTH_RANGE:2928;DEPTH_WRITEMASK:2930;DEPTH_CLEAR_VALUE:2931;DEPTH_FUNC:2932;STENCIL_CLEAR_VALUE:2961;STENCIL_FUNC:2962;STENCIL_FAIL:2964;STENCIL_PASS_DEPTH_FAIL:2965;STENCIL_PASS_DEPTH_PASS:2966;STENCIL_REF:2967;STENCIL_VALUE_MASK:2963;STENCIL_WRITEMASK:2968;STENCIL_BACK_FUNC:34816;STENCIL_BACK_FAIL:34817;STENCIL_BACK_PASS_DEPTH_FAIL:34818;STENCIL_BACK_PASS_DEPTH_PASS:34819;STENCIL_BACK_REF:36003;STENCIL_BACK_VALUE_MASK:36004;STENCIL_BACK_WRITEMASK:36005;VIEWPORT:2978;SCISSOR_BOX:3088;COLOR_CLEAR_VALUE:3106;COLOR_WRITEMASK:3107;UNPACK_ALIGNMENT:3317;PACK_ALIGNMENT:3333;MAX_TEXTURE_SIZE:3379;MAX_VIEWPORT_DIMS:3386;SUBPIXEL_BITS:3408;RED_BITS:3410;GREEN_BITS:3411;BLUE_BITS:3412;ALPHA_BITS:3413;DEPTH_BITS:3414;STENCIL_BITS:3415;POLYGON_OFFSET_UNITS:10752;POLYGON_OFFSET_FACTOR:32824;TEXTURE_BINDING_2D:32873;SAMPLE_BUFFERS:32936;SAMPLES:32937;SAMPLE_COVERAGE_VALUE:32938;SAMPLE_COVERAGE_INVERT:32939;COMPRESSED_TEXTURE_FORMATS:34467;DONT_CARE:4352;FASTEST:4353;NICEST:4354;GENERATE_MIPMAP_HINT:33170;BYTE:5120;UNSIGNED_BYTE:5121;SHORT:5122;UNSIGNED_SHORT:5123;INT:5124;UNSIGNED_INT:5125;FLOAT:5126;DEPTH_COMPONENT:6402;ALPHA:6406;RGB:6407;RGBA:6408;LUMINANCE:6409;LUMINANCE_ALPHA:6410;UNSIGNED_SHORT_4_4_4_4:32819;UNSIGNED_SHORT_5_5_5_1:32820;UNSIGNED_SHORT_5_6_5:33635;FRAGMENT_SHADER:35632;VERTEX_SHADER:35633;MAX_VERTEX_ATTRIBS:34921;MAX_VERTEX_UNIFORM_VECTORS:36347;MAX_VARYING_VECTORS:36348;MAX_COMBINED_TEXTURE_IMAGE_UNITS:35661;MAX_VERTEX_TEXTURE_IMAGE_UNITS:35660;MAX_TEXTURE_IMAGE_UNITS:34930;MAX_FRAGMENT_UNIFORM_VECTORS:36349;SHADER_TYPE:35663;DELETE_STATUS:35712;LINK_STATUS:35714;VALIDATE_STATUS:35715;ATTACHED_SHADERS:35717;ACTIVE_UNIFORMS:35718;ACTIVE_ATTRIBUTES:35721;SHADING_LANGUAGE_VERSION:35724;CURRENT_PROGRAM:35725;NEVER:512;LESS:513;EQUAL:514;LEQUAL:515;GREATER:516;NOTEQUAL:517;GEQUAL:518;ALWAYS:519;KEEP:7680;REPLACE:7681;INCR:7682;DECR:7683;INVERT:5386;INCR_WRAP:34055;DECR_WRAP:34056;VENDOR:7936;RENDERER:7937;VERSION:7938;NEAREST:9728;LINEAR:9729;NEAREST_MIPMAP_NEAREST:9984;LINEAR_MIPMAP_NEAREST:9985;NEAREST_MIPMAP_LINEAR:9986;LINEAR_MIPMAP_LINEAR:9987;TEXTURE_MAG_FILTER:10240;TEXTURE_MIN_FILTER:10241;TEXTURE_WRAP_S:10242;TEXTURE_WRAP_T:10243;TEXTURE:5890;TEXTURE_CUBE_MAP:34067;TEXTURE_BINDING_CUBE_MAP:34068;TEXTURE_CUBE_MAP_POSITIVE_X:34069;TEXTURE_CUBE_MAP_NEGATIVE_X:34070;TEXTURE_CUBE_MAP_POSITIVE_Y:34071;TEXTURE_CUBE_MAP_NEGATIVE_Y:34072;TEXTURE_CUBE_MAP_POSITIVE_Z:34073;TEXTURE_CUBE_MAP_NEGATIVE_Z:34074;MAX_CUBE_MAP_TEXTURE_SIZE:34076;TEXTURE0:33984;TEXTURE1:33985;TEXTURE2:33986;TEXTURE3:33987;TEXTURE4:33988;TEXTURE5:33989;TEXTURE6:33990;TEXTURE7:33991;TEXTURE8:33992;TEXTURE9:33993;TEXTURE10:33994;TEXTURE11:33995;TEXTURE12:33996;TEXTURE13:33997;TEXTURE14:33998;TEXTURE15:33999;TEXTURE16:34000;TEXTURE17:34001;TEXTURE18:34002;TEXTURE19:34003;TEXTURE20:34004;TEXTURE21:34005;TEXTURE22:34006;TEXTURE23:34007;TEXTURE24:34008;TEXTURE25:34009;TEXTURE26:34010;TEXTURE27:34011;TEXTURE28:34012;TEXTURE29:34013;TEXTURE30:34014;TEXTURE31:34015;ACTIVE_TEXTURE:34016;REPEAT:10497;CLAMP_TO_EDGE:33071;MIRRORED_REPEAT:33648;FLOAT_VEC2:35664;FLOAT_VEC3:35665;FLOAT_VEC4:35666;INT_VEC2:35667;INT_VEC3:35668;INT_VEC4:35669;BOOL:35670;BOOL_VEC2:35671;BOOL_VEC3:35672;BOOL_VEC4:35673;FLOAT_MAT2:35674;FLOAT_MAT3:35675;FLOAT_MAT4:35676;SAMPLER_2D:35678;SAMPLER_CUBE:35680;VERTEX_ATTRIB_ARRAY_ENABLED:34338;VERTEX_ATTRIB_ARRAY_SIZE:34339;VERTEX_ATTRIB_ARRAY_STRIDE:34340;VERTEX_ATTRIB_ARRAY_TYPE:34341;VERTEX_ATTRIB_ARRAY_NORMALIZED:34922;VERTEX_ATTRIB_ARRAY_POINTER:34373;VERTEX_ATTRIB_ARRAY_BUFFER_BINDING:34975;IMPLEMENTATION_COLOR_READ_TYPE:35738;IMPLEMENTATION_COLOR_READ_FORMAT:35739;COMPILE_STATUS:35713;LOW_FLOAT:36336;MEDIUM_FLOAT:36337;HIGH_FLOAT:36338;LOW_INT:36339;MEDIUM_INT:36340;HIGH_INT:36341;FRAMEBUFFER:36160;RENDERBUFFER:36161;RGBA4:32854;RGB5_A1:32855;RGB565:36194;DEPTH_COMPONENT16:33189;STENCIL_INDEX8:36168;DEPTH_STENCIL:34041;RENDERBUFFER_WIDTH:36162;RENDERBUFFER_HEIGHT:36163;RENDERBUFFER_INTERNAL_FORMAT:36164;RENDERBUFFER_RED_SIZE:36176;RENDERBUFFER_GREEN_SIZE:36177;RENDERBUFFER_BLUE_SIZE:36178;RENDERBUFFER_ALPHA_SIZE:36179;RENDERBUFFER_DEPTH_SIZE:36180;RENDERBUFFER_STENCIL_SIZE:36181;FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE:36048;FRAMEBUFFER_ATTACHMENT_OBJECT_NAME:36049;FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL:36050;FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE:36051;COLOR_ATTACHMENT0:36064;DEPTH_ATTACHMENT:36096;STENCIL_ATTACHMENT:36128;DEPTH_STENCIL_ATTACHMENT:33306;NONE:0;FRAMEBUFFER_COMPLETE:36053;FRAMEBUFFER_INCOMPLETE_ATTACHMENT:36054;FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT:36055;FRAMEBUFFER_INCOMPLETE_DIMENSIONS:36057;FRAMEBUFFER_UNSUPPORTED:36061;FRAMEBUFFER_BINDING:36006;RENDERBUFFER_BINDING:36007;MAX_RENDERBUFFER_SIZE:34024;INVALID_FRAMEBUFFER_OPERATION:1286;UNPACK_FLIP_Y_WEBGL:37440;UNPACK_PREMULTIPLY_ALPHA_WEBGL:37441;CONTEXT_LOST_WEBGL:37442;UNPACK_COLORSPACE_CONVERSION_WEBGL:37443;BROWSER_DEFAULT_WEBGL:37444;activeTexture(1);attachShader(2);bindAttribLocation(3);bindRenderbuffer(2);blendColor(4);blendEquation(1);blendEquationSeparate(2);blendFunc(2);blendFuncSeparate(4);bufferData(3);bufferSubData(3);checkFramebufferStatus(1);compileShader(1);compressedTexImage2D(7);compressedTexSubImage2D(8);copyTexImage2D(8);copyTexSubImage2D(8);createBuffer(0);createFramebuffer(0);createProgram(0);createRenderbuffer(0);createShader(1);createTexture(0);cullFace(1);deleteBuffer(1);deleteFramebuffer(1);deleteProgram(1);deleteRenderbuffer(1);deleteShader(1);deleteTexture(1);depthFunc(1);depthMask(1);depthRange(2);detachShader(2);disable(1);enable(1);finish(0);flush(0);framebufferRenderbuffer(4);framebufferTexture2D(5);frontFace(1);generateMipmap(1);getActiveAttrib(2);getActiveUniform(2);getAttachedShaders(1);getAttribLocation(2);getBufferParameter(2);getContextAttributes(0);getError(0);getExtension(1);getFramebufferAttachmentParameter(3);getParameter(1);getProgramInfoLog(1);getProgramParameter(2);getRenderbufferParameter(2);getShaderInfoLog(1);getShaderParameter(2);getShaderPrecisionFormat(2);getShaderSource(1);getSupportedExtensions(0);getTexParameter(2);getUniform(2);getUniformLocation(2);getVertexAttrib(2);getVertexAttribOffset(2);hint(2);isBuffer(1);isContextLost(0);isEnabled(1);isFramebuffer(1);isProgram(1);isRenderbuffer(1);isShader(1);isTexture(1);lineWidth(1);linkProgram(1);pixelStorei(2);polygonOffset(2);readPixels(7);renderbufferStorage(4);sampleCoverage(2);shaderSource(2);stencilFunc(3);stencilFuncSeparate(4);stencilMask(1);stencilMaskSeparate(2);stencilOp(3);stencilOpSeparate(4);texImage2D(6);texParameterf(3);texParameteri(3);texSubImage2D(7);useProgram(1);validateProgram(1);bindBuffer(2);bindFramebuffer(2);bindTexture(2);clear(1);clearColor(4);clearDepth(1);clearStencil(1);colorMask(4);disableVertexAttribArray(1);drawArrays(3);drawElements(4);enableVertexAttribArray(1);scissor(4);uniform1f(2);uniform1fv(2);uniform1i(2);uniform1iv(2);uniform2f(3);uniform2fv(2);uniform2i(3);uniform2iv(2);uniform3f(4);uniform3fv(2);uniform3i(4);uniform3iv(2);uniform4f(5);uniform4fv(2);uniform4i(5);uniform4iv(2);uniformMatrix2fv(3);uniformMatrix3fv(3);uniformMatrix4fv(3);vertexAttrib1f(2);vertexAttrib1fv(2);vertexAttrib2f(3);vertexAttrib2fv(2);vertexAttrib3f(4);vertexAttrib3fv(2);vertexAttrib4f(5);vertexAttrib4fv(2);vertexAttribPointer(6);viewport(4);drawingBufferFormat;RGB8:32849;RGBA8:32856;drawingBufferStorage(3);constructor;makeXRCompatible(0)', WebGL2RenderingContext: 'canvas;drawingBufferWidth;drawingBufferHeight;drawingBufferColorSpace=;unpackColorSpace=;DEPTH_BUFFER_BIT:256;STENCIL_BUFFER_BIT:1024;COLOR_BUFFER_BIT:16384;POINTS:0;LINES:1;LINE_LOOP:2;LINE_STRIP:3;TRIANGLES:4;TRIANGLE_STRIP:5;TRIANGLE_FAN:6;ZERO:0;ONE:1;SRC_COLOR:768;ONE_MINUS_SRC_COLOR:769;SRC_ALPHA:770;ONE_MINUS_SRC_ALPHA:771;DST_ALPHA:772;ONE_MINUS_DST_ALPHA:773;DST_COLOR:774;ONE_MINUS_DST_COLOR:775;SRC_ALPHA_SATURATE:776;FUNC_ADD:32774;BLEND_EQUATION:32777;BLEND_EQUATION_RGB:32777;BLEND_EQUATION_ALPHA:34877;FUNC_SUBTRACT:32778;FUNC_REVERSE_SUBTRACT:32779;BLEND_DST_RGB:32968;BLEND_SRC_RGB:32969;BLEND_DST_ALPHA:32970;BLEND_SRC_ALPHA:32971;CONSTANT_COLOR:32769;ONE_MINUS_CONSTANT_COLOR:32770;CONSTANT_ALPHA:32771;ONE_MINUS_CONSTANT_ALPHA:32772;BLEND_COLOR:32773;ARRAY_BUFFER:34962;ELEMENT_ARRAY_BUFFER:34963;ARRAY_BUFFER_BINDING:34964;ELEMENT_ARRAY_BUFFER_BINDING:34965;STREAM_DRAW:35040;STATIC_DRAW:35044;DYNAMIC_DRAW:35048;BUFFER_SIZE:34660;BUFFER_USAGE:34661;CURRENT_VERTEX_ATTRIB:34342;FRONT:1028;BACK:1029;FRONT_AND_BACK:1032;TEXTURE_2D:3553;CULL_FACE:2884;BLEND:3042;DITHER:3024;STENCIL_TEST:2960;DEPTH_TEST:2929;SCISSOR_TEST:3089;POLYGON_OFFSET_FILL:32823;SAMPLE_ALPHA_TO_COVERAGE:32926;SAMPLE_COVERAGE:32928;NO_ERROR:0;INVALID_ENUM:1280;INVALID_VALUE:1281;INVALID_OPERATION:1282;OUT_OF_MEMORY:1285;CW:2304;CCW:2305;LINE_WIDTH:2849;ALIASED_POINT_SIZE_RANGE:33901;ALIASED_LINE_WIDTH_RANGE:33902;CULL_FACE_MODE:2885;FRONT_FACE:2886;DEPTH_RANGE:2928;DEPTH_WRITEMASK:2930;DEPTH_CLEAR_VALUE:2931;DEPTH_FUNC:2932;STENCIL_CLEAR_VALUE:2961;STENCIL_FUNC:2962;STENCIL_FAIL:2964;STENCIL_PASS_DEPTH_FAIL:2965;STENCIL_PASS_DEPTH_PASS:2966;STENCIL_REF:2967;STENCIL_VALUE_MASK:2963;STENCIL_WRITEMASK:2968;STENCIL_BACK_FUNC:34816;STENCIL_BACK_FAIL:34817;STENCIL_BACK_PASS_DEPTH_FAIL:34818;STENCIL_BACK_PASS_DEPTH_PASS:34819;STENCIL_BACK_REF:36003;STENCIL_BACK_VALUE_MASK:36004;STENCIL_BACK_WRITEMASK:36005;VIEWPORT:2978;SCISSOR_BOX:3088;COLOR_CLEAR_VALUE:3106;COLOR_WRITEMASK:3107;UNPACK_ALIGNMENT:3317;PACK_ALIGNMENT:3333;MAX_TEXTURE_SIZE:3379;MAX_VIEWPORT_DIMS:3386;SUBPIXEL_BITS:3408;RED_BITS:3410;GREEN_BITS:3411;BLUE_BITS:3412;ALPHA_BITS:3413;DEPTH_BITS:3414;STENCIL_BITS:3415;POLYGON_OFFSET_UNITS:10752;POLYGON_OFFSET_FACTOR:32824;TEXTURE_BINDING_2D:32873;SAMPLE_BUFFERS:32936;SAMPLES:32937;SAMPLE_COVERAGE_VALUE:32938;SAMPLE_COVERAGE_INVERT:32939;COMPRESSED_TEXTURE_FORMATS:34467;DONT_CARE:4352;FASTEST:4353;NICEST:4354;GENERATE_MIPMAP_HINT:33170;BYTE:5120;UNSIGNED_BYTE:5121;SHORT:5122;UNSIGNED_SHORT:5123;INT:5124;UNSIGNED_INT:5125;FLOAT:5126;DEPTH_COMPONENT:6402;ALPHA:6406;RGB:6407;RGBA:6408;LUMINANCE:6409;LUMINANCE_ALPHA:6410;UNSIGNED_SHORT_4_4_4_4:32819;UNSIGNED_SHORT_5_5_5_1:32820;UNSIGNED_SHORT_5_6_5:33635;FRAGMENT_SHADER:35632;VERTEX_SHADER:35633;MAX_VERTEX_ATTRIBS:34921;MAX_VERTEX_UNIFORM_VECTORS:36347;MAX_VARYING_VECTORS:36348;MAX_COMBINED_TEXTURE_IMAGE_UNITS:35661;MAX_VERTEX_TEXTURE_IMAGE_UNITS:35660;MAX_TEXTURE_IMAGE_UNITS:34930;MAX_FRAGMENT_UNIFORM_VECTORS:36349;SHADER_TYPE:35663;DELETE_STATUS:35712;LINK_STATUS:35714;VALIDATE_STATUS:35715;ATTACHED_SHADERS:35717;ACTIVE_UNIFORMS:35718;ACTIVE_ATTRIBUTES:35721;SHADING_LANGUAGE_VERSION:35724;CURRENT_PROGRAM:35725;NEVER:512;LESS:513;EQUAL:514;LEQUAL:515;GREATER:516;NOTEQUAL:517;GEQUAL:518;ALWAYS:519;KEEP:7680;REPLACE:7681;INCR:7682;DECR:7683;INVERT:5386;INCR_WRAP:34055;DECR_WRAP:34056;VENDOR:7936;RENDERER:7937;VERSION:7938;NEAREST:9728;LINEAR:9729;NEAREST_MIPMAP_NEAREST:9984;LINEAR_MIPMAP_NEAREST:9985;NEAREST_MIPMAP_LINEAR:9986;LINEAR_MIPMAP_LINEAR:9987;TEXTURE_MAG_FILTER:10240;TEXTURE_MIN_FILTER:10241;TEXTURE_WRAP_S:10242;TEXTURE_WRAP_T:10243;TEXTURE:5890;TEXTURE_CUBE_MAP:34067;TEXTURE_BINDING_CUBE_MAP:34068;TEXTURE_CUBE_MAP_POSITIVE_X:34069;TEXTURE_CUBE_MAP_NEGATIVE_X:34070;TEXTURE_CUBE_MAP_POSITIVE_Y:34071;TEXTURE_CUBE_MAP_NEGATIVE_Y:34072;TEXTURE_CUBE_MAP_POSITIVE_Z:34073;TEXTURE_CUBE_MAP_NEGATIVE_Z:34074;MAX_CUBE_MAP_TEXTURE_SIZE:34076;TEXTURE0:33984;TEXTURE1:33985;TEXTURE2:33986;TEXTURE3:33987;TEXTURE4:33988;TEXTURE5:33989;TEXTURE6:33990;TEXTURE7:33991;TEXTURE8:33992;TEXTURE9:33993;TEXTURE10:33994;TEXTURE11:33995;TEXTURE12:33996;TEXTURE13:33997;TEXTURE14:33998;TEXTURE15:33999;TEXTURE16:34000;TEXTURE17:34001;TEXTURE18:34002;TEXTURE19:34003;TEXTURE20:34004;TEXTURE21:34005;TEXTURE22:34006;TEXTURE23:34007;TEXTURE24:34008;TEXTURE25:34009;TEXTURE26:34010;TEXTURE27:34011;TEXTURE28:34012;TEXTURE29:34013;TEXTURE30:34014;TEXTURE31:34015;ACTIVE_TEXTURE:34016;REPEAT:10497;CLAMP_TO_EDGE:33071;MIRRORED_REPEAT:33648;FLOAT_VEC2:35664;FLOAT_VEC3:35665;FLOAT_VEC4:35666;INT_VEC2:35667;INT_VEC3:35668;INT_VEC4:35669;BOOL:35670;BOOL_VEC2:35671;BOOL_VEC3:35672;BOOL_VEC4:35673;FLOAT_MAT2:35674;FLOAT_MAT3:35675;FLOAT_MAT4:35676;SAMPLER_2D:35678;SAMPLER_CUBE:35680;VERTEX_ATTRIB_ARRAY_ENABLED:34338;VERTEX_ATTRIB_ARRAY_SIZE:34339;VERTEX_ATTRIB_ARRAY_STRIDE:34340;VERTEX_ATTRIB_ARRAY_TYPE:34341;VERTEX_ATTRIB_ARRAY_NORMALIZED:34922;VERTEX_ATTRIB_ARRAY_POINTER:34373;VERTEX_ATTRIB_ARRAY_BUFFER_BINDING:34975;IMPLEMENTATION_COLOR_READ_TYPE:35738;IMPLEMENTATION_COLOR_READ_FORMAT:35739;COMPILE_STATUS:35713;LOW_FLOAT:36336;MEDIUM_FLOAT:36337;HIGH_FLOAT:36338;LOW_INT:36339;MEDIUM_INT:36340;HIGH_INT:36341;FRAMEBUFFER:36160;RENDERBUFFER:36161;RGBA4:32854;RGB5_A1:32855;RGB565:36194;DEPTH_COMPONENT16:33189;STENCIL_INDEX8:36168;DEPTH_STENCIL:34041;RENDERBUFFER_WIDTH:36162;RENDERBUFFER_HEIGHT:36163;RENDERBUFFER_INTERNAL_FORMAT:36164;RENDERBUFFER_RED_SIZE:36176;RENDERBUFFER_GREEN_SIZE:36177;RENDERBUFFER_BLUE_SIZE:36178;RENDERBUFFER_ALPHA_SIZE:36179;RENDERBUFFER_DEPTH_SIZE:36180;RENDERBUFFER_STENCIL_SIZE:36181;FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE:36048;FRAMEBUFFER_ATTACHMENT_OBJECT_NAME:36049;FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL:36050;FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE:36051;COLOR_ATTACHMENT0:36064;DEPTH_ATTACHMENT:36096;STENCIL_ATTACHMENT:36128;DEPTH_STENCIL_ATTACHMENT:33306;NONE:0;FRAMEBUFFER_COMPLETE:36053;FRAMEBUFFER_INCOMPLETE_ATTACHMENT:36054;FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT:36055;FRAMEBUFFER_INCOMPLETE_DIMENSIONS:36057;FRAMEBUFFER_UNSUPPORTED:36061;FRAMEBUFFER_BINDING:36006;RENDERBUFFER_BINDING:36007;MAX_RENDERBUFFER_SIZE:34024;INVALID_FRAMEBUFFER_OPERATION:1286;UNPACK_FLIP_Y_WEBGL:37440;UNPACK_PREMULTIPLY_ALPHA_WEBGL:37441;CONTEXT_LOST_WEBGL:37442;UNPACK_COLORSPACE_CONVERSION_WEBGL:37443;BROWSER_DEFAULT_WEBGL:37444;READ_BUFFER:3074;UNPACK_ROW_LENGTH:3314;UNPACK_SKIP_ROWS:3315;UNPACK_SKIP_PIXELS:3316;PACK_ROW_LENGTH:3330;PACK_SKIP_ROWS:3331;PACK_SKIP_PIXELS:3332;COLOR:6144;DEPTH:6145;STENCIL:6146;RED:6403;RGB8:32849;RGBA8:32856;RGB10_A2:32857;TEXTURE_BINDING_3D:32874;UNPACK_SKIP_IMAGES:32877;UNPACK_IMAGE_HEIGHT:32878;TEXTURE_3D:32879;TEXTURE_WRAP_R:32882;MAX_3D_TEXTURE_SIZE:32883;UNSIGNED_INT_2_10_10_10_REV:33640;MAX_ELEMENTS_VERTICES:33000;MAX_ELEMENTS_INDICES:33001;TEXTURE_MIN_LOD:33082;TEXTURE_MAX_LOD:33083;TEXTURE_BASE_LEVEL:33084;TEXTURE_MAX_LEVEL:33085;MIN:32775;MAX:32776;DEPTH_COMPONENT24:33190;MAX_TEXTURE_LOD_BIAS:34045;TEXTURE_COMPARE_MODE:34892;TEXTURE_COMPARE_FUNC:34893;CURRENT_QUERY:34917;QUERY_RESULT:34918;QUERY_RESULT_AVAILABLE:34919;STREAM_READ:35041;STREAM_COPY:35042;STATIC_READ:35045;STATIC_COPY:35046;DYNAMIC_READ:35049;DYNAMIC_COPY:35050;MAX_DRAW_BUFFERS:34852;DRAW_BUFFER0:34853;DRAW_BUFFER1:34854;DRAW_BUFFER2:34855;DRAW_BUFFER3:34856;DRAW_BUFFER4:34857;DRAW_BUFFER5:34858;DRAW_BUFFER6:34859;DRAW_BUFFER7:34860;DRAW_BUFFER8:34861;DRAW_BUFFER9:34862;DRAW_BUFFER10:34863;DRAW_BUFFER11:34864;DRAW_BUFFER12:34865;DRAW_BUFFER13:34866;DRAW_BUFFER14:34867;DRAW_BUFFER15:34868;MAX_FRAGMENT_UNIFORM_COMPONENTS:35657;MAX_VERTEX_UNIFORM_COMPONENTS:35658;SAMPLER_3D:35679;SAMPLER_2D_SHADOW:35682;FRAGMENT_SHADER_DERIVATIVE_HINT:35723;PIXEL_PACK_BUFFER:35051;PIXEL_UNPACK_BUFFER:35052;PIXEL_PACK_BUFFER_BINDING:35053;PIXEL_UNPACK_BUFFER_BINDING:35055;FLOAT_MAT2x3:35685;FLOAT_MAT2x4:35686;FLOAT_MAT3x2:35687;FLOAT_MAT3x4:35688;FLOAT_MAT4x2:35689;FLOAT_MAT4x3:35690;SRGB:35904;SRGB8:35905;SRGB8_ALPHA8:35907;COMPARE_REF_TO_TEXTURE:34894;RGBA32F:34836;RGB32F:34837;RGBA16F:34842;RGB16F:34843;VERTEX_ATTRIB_ARRAY_INTEGER:35069;MAX_ARRAY_TEXTURE_LAYERS:35071;MIN_PROGRAM_TEXEL_OFFSET:35076;MAX_PROGRAM_TEXEL_OFFSET:35077;MAX_VARYING_COMPONENTS:35659;TEXTURE_2D_ARRAY:35866;TEXTURE_BINDING_2D_ARRAY:35869;R11F_G11F_B10F:35898;UNSIGNED_INT_10F_11F_11F_REV:35899;RGB9_E5:35901;UNSIGNED_INT_5_9_9_9_REV:35902;TRANSFORM_FEEDBACK_BUFFER_MODE:35967;MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS:35968;TRANSFORM_FEEDBACK_VARYINGS:35971;TRANSFORM_FEEDBACK_BUFFER_START:35972;TRANSFORM_FEEDBACK_BUFFER_SIZE:35973;TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN:35976;RASTERIZER_DISCARD:35977;MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS:35978;MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS:35979;INTERLEAVED_ATTRIBS:35980;SEPARATE_ATTRIBS:35981;TRANSFORM_FEEDBACK_BUFFER:35982;TRANSFORM_FEEDBACK_BUFFER_BINDING:35983;RGBA32UI:36208;RGB32UI:36209;RGBA16UI:36214;RGB16UI:36215;RGBA8UI:36220;RGB8UI:36221;RGBA32I:36226;RGB32I:36227;RGBA16I:36232;RGB16I:36233;RGBA8I:36238;RGB8I:36239;RED_INTEGER:36244;RGB_INTEGER:36248;RGBA_INTEGER:36249;SAMPLER_2D_ARRAY:36289;SAMPLER_2D_ARRAY_SHADOW:36292;SAMPLER_CUBE_SHADOW:36293;UNSIGNED_INT_VEC2:36294;UNSIGNED_INT_VEC3:36295;UNSIGNED_INT_VEC4:36296;INT_SAMPLER_2D:36298;INT_SAMPLER_3D:36299;INT_SAMPLER_CUBE:36300;INT_SAMPLER_2D_ARRAY:36303;UNSIGNED_INT_SAMPLER_2D:36306;UNSIGNED_INT_SAMPLER_3D:36307;UNSIGNED_INT_SAMPLER_CUBE:36308;UNSIGNED_INT_SAMPLER_2D_ARRAY:36311;DEPTH_COMPONENT32F:36012;DEPTH32F_STENCIL8:36013;FLOAT_32_UNSIGNED_INT_24_8_REV:36269;FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING:33296;FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE:33297;FRAMEBUFFER_ATTACHMENT_RED_SIZE:33298;FRAMEBUFFER_ATTACHMENT_GREEN_SIZE:33299;FRAMEBUFFER_ATTACHMENT_BLUE_SIZE:33300;FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE:33301;FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE:33302;FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE:33303;FRAMEBUFFER_DEFAULT:33304;UNSIGNED_INT_24_8:34042;DEPTH24_STENCIL8:35056;UNSIGNED_NORMALIZED:35863;DRAW_FRAMEBUFFER_BINDING:36006;READ_FRAMEBUFFER:36008;DRAW_FRAMEBUFFER:36009;READ_FRAMEBUFFER_BINDING:36010;RENDERBUFFER_SAMPLES:36011;FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER:36052;MAX_COLOR_ATTACHMENTS:36063;COLOR_ATTACHMENT1:36065;COLOR_ATTACHMENT2:36066;COLOR_ATTACHMENT3:36067;COLOR_ATTACHMENT4:36068;COLOR_ATTACHMENT5:36069;COLOR_ATTACHMENT6:36070;COLOR_ATTACHMENT7:36071;COLOR_ATTACHMENT8:36072;COLOR_ATTACHMENT9:36073;COLOR_ATTACHMENT10:36074;COLOR_ATTACHMENT11:36075;COLOR_ATTACHMENT12:36076;COLOR_ATTACHMENT13:36077;COLOR_ATTACHMENT14:36078;COLOR_ATTACHMENT15:36079;FRAMEBUFFER_INCOMPLETE_MULTISAMPLE:36182;MAX_SAMPLES:36183;HALF_FLOAT:5131;RG:33319;RG_INTEGER:33320;R8:33321;RG8:33323;R16F:33325;R32F:33326;RG16F:33327;RG32F:33328;R8I:33329;R8UI:33330;R16I:33331;R16UI:33332;R32I:33333;R32UI:33334;RG8I:33335;RG8UI:33336;RG16I:33337;RG16UI:33338;RG32I:33339;RG32UI:33340;VERTEX_ARRAY_BINDING:34229;R8_SNORM:36756;RG8_SNORM:36757;RGB8_SNORM:36758;RGBA8_SNORM:36759;SIGNED_NORMALIZED:36764;COPY_READ_BUFFER:36662;COPY_WRITE_BUFFER:36663;COPY_READ_BUFFER_BINDING:36662;COPY_WRITE_BUFFER_BINDING:36663;UNIFORM_BUFFER:35345;UNIFORM_BUFFER_BINDING:35368;UNIFORM_BUFFER_START:35369;UNIFORM_BUFFER_SIZE:35370;MAX_VERTEX_UNIFORM_BLOCKS:35371;MAX_FRAGMENT_UNIFORM_BLOCKS:35373;MAX_COMBINED_UNIFORM_BLOCKS:35374;MAX_UNIFORM_BUFFER_BINDINGS:35375;MAX_UNIFORM_BLOCK_SIZE:35376;MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS:35377;MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS:35379;UNIFORM_BUFFER_OFFSET_ALIGNMENT:35380;ACTIVE_UNIFORM_BLOCKS:35382;UNIFORM_TYPE:35383;UNIFORM_SIZE:35384;UNIFORM_BLOCK_INDEX:35386;UNIFORM_OFFSET:35387;UNIFORM_ARRAY_STRIDE:35388;UNIFORM_MATRIX_STRIDE:35389;UNIFORM_IS_ROW_MAJOR:35390;UNIFORM_BLOCK_BINDING:35391;UNIFORM_BLOCK_DATA_SIZE:35392;UNIFORM_BLOCK_ACTIVE_UNIFORMS:35394;UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES:35395;UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER:35396;UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER:35398;INVALID_INDEX:4294967295;MAX_VERTEX_OUTPUT_COMPONENTS:37154;MAX_FRAGMENT_INPUT_COMPONENTS:37157;MAX_SERVER_WAIT_TIMEOUT:37137;OBJECT_TYPE:37138;SYNC_CONDITION:37139;SYNC_STATUS:37140;SYNC_FLAGS:37141;SYNC_FENCE:37142;SYNC_GPU_COMMANDS_COMPLETE:37143;UNSIGNALED:37144;SIGNALED:37145;ALREADY_SIGNALED:37146;TIMEOUT_EXPIRED:37147;CONDITION_SATISFIED:37148;WAIT_FAILED:37149;SYNC_FLUSH_COMMANDS_BIT:1;VERTEX_ATTRIB_ARRAY_DIVISOR:35070;ANY_SAMPLES_PASSED:35887;ANY_SAMPLES_PASSED_CONSERVATIVE:36202;SAMPLER_BINDING:35097;RGB10_A2UI:36975;INT_2_10_10_10_REV:36255;TRANSFORM_FEEDBACK:36386;TRANSFORM_FEEDBACK_PAUSED:36387;TRANSFORM_FEEDBACK_ACTIVE:36388;TRANSFORM_FEEDBACK_BINDING:36389;TEXTURE_IMMUTABLE_FORMAT:37167;MAX_ELEMENT_INDEX:36203;TEXTURE_IMMUTABLE_LEVELS:33503;TIMEOUT_IGNORED:-1;MAX_CLIENT_WAIT_TIMEOUT_WEBGL:37447;activeTexture(1);attachShader(2);beginQuery(2);beginTransformFeedback(1);bindAttribLocation(3);bindBufferBase(3);bindBufferRange(5);bindRenderbuffer(2);bindSampler(2);bindTransformFeedback(2);bindVertexArray(1);blendColor(4);blendEquation(1);blendEquationSeparate(2);blendFunc(2);blendFuncSeparate(4);blitFramebuffer(10);bufferData(3);bufferSubData(3);checkFramebufferStatus(1);clientWaitSync(3);compileShader(1);compressedTexImage2D(7);compressedTexImage3D(8);compressedTexSubImage2D(8);compressedTexSubImage3D(10);copyBufferSubData(5);copyTexImage2D(8);copyTexSubImage2D(8);copyTexSubImage3D(9);createBuffer(0);createFramebuffer(0);createProgram(0);createQuery(0);createRenderbuffer(0);createSampler(0);createShader(1);createTexture(0);createTransformFeedback(0);createVertexArray(0);cullFace(1);deleteBuffer(1);deleteFramebuffer(1);deleteProgram(1);deleteQuery(1);deleteRenderbuffer(1);deleteSampler(1);deleteShader(1);deleteSync(1);deleteTexture(1);deleteTransformFeedback(1);deleteVertexArray(1);depthFunc(1);depthMask(1);depthRange(2);detachShader(2);disable(1);drawArraysInstanced(4);drawElementsInstanced(5);drawRangeElements(6);enable(1);endQuery(1);endTransformFeedback(0);fenceSync(2);finish(0);flush(0);framebufferRenderbuffer(4);framebufferTexture2D(5);framebufferTextureLayer(5);frontFace(1);generateMipmap(1);getActiveAttrib(2);getActiveUniform(2);getActiveUniformBlockName(2);getActiveUniformBlockParameter(3);getActiveUniforms(3);getAttachedShaders(1);getAttribLocation(2);getBufferParameter(2);getBufferSubData(3);getContextAttributes(0);getError(0);getExtension(1);getFragDataLocation(2);getFramebufferAttachmentParameter(3);getIndexedParameter(2);getInternalformatParameter(3);getParameter(1);getProgramInfoLog(1);getProgramParameter(2);getQuery(2);getQueryParameter(2);getRenderbufferParameter(2);getSamplerParameter(2);getShaderInfoLog(1);getShaderParameter(2);getShaderPrecisionFormat(2);getShaderSource(1);getSupportedExtensions(0);getSyncParameter(2);getTexParameter(2);getTransformFeedbackVarying(2);getUniform(2);getUniformBlockIndex(2);getUniformIndices(2);getUniformLocation(2);getVertexAttrib(2);getVertexAttribOffset(2);hint(2);invalidateFramebuffer(2);invalidateSubFramebuffer(6);isBuffer(1);isContextLost(0);isEnabled(1);isFramebuffer(1);isProgram(1);isQuery(1);isRenderbuffer(1);isSampler(1);isShader(1);isSync(1);isTexture(1);isTransformFeedback(1);isVertexArray(1);lineWidth(1);linkProgram(1);pauseTransformFeedback(0);pixelStorei(2);polygonOffset(2);readBuffer(1);readPixels(7);renderbufferStorage(4);renderbufferStorageMultisample(5);resumeTransformFeedback(0);sampleCoverage(2);samplerParameterf(3);samplerParameteri(3);shaderSource(2);stencilFunc(3);stencilFuncSeparate(4);stencilMask(1);stencilMaskSeparate(2);stencilOp(3);stencilOpSeparate(4);texImage2D(6);texImage3D(10);texParameterf(3);texParameteri(3);texStorage2D(5);texStorage3D(6);texSubImage2D(7);texSubImage3D(11);transformFeedbackVaryings(3);uniform1ui(2);uniform2ui(3);uniform3ui(4);uniform4ui(5);uniformBlockBinding(3);useProgram(1);validateProgram(1);vertexAttribDivisor(2);vertexAttribI4i(5);vertexAttribI4ui(5);vertexAttribIPointer(5);waitSync(3);bindBuffer(2);bindFramebuffer(2);bindTexture(2);clear(1);clearBufferfi(4);clearBufferfv(3);clearBufferiv(3);clearBufferuiv(3);clearColor(4);clearDepth(1);clearStencil(1);colorMask(4);disableVertexAttribArray(1);drawArrays(3);drawBuffers(1);drawElements(4);enableVertexAttribArray(1);scissor(4);uniform1f(2);uniform1fv(2);uniform1i(2);uniform1iv(2);uniform1uiv(2);uniform2f(3);uniform2fv(2);uniform2i(3);uniform2iv(2);uniform2uiv(2);uniform3f(4);uniform3fv(2);uniform3i(4);uniform3iv(2);uniform3uiv(2);uniform4f(5);uniform4fv(2);uniform4i(5);uniform4iv(2);uniform4uiv(2);uniformMatrix2fv(3);uniformMatrix2x3fv(3);uniformMatrix2x4fv(3);uniformMatrix3fv(3);uniformMatrix3x2fv(3);uniformMatrix3x4fv(3);uniformMatrix4fv(3);uniformMatrix4x2fv(3);uniformMatrix4x3fv(3);vertexAttrib1f(2);vertexAttrib1fv(2);vertexAttrib2f(3);vertexAttrib2fv(2);vertexAttrib3f(4);vertexAttrib3fv(2);vertexAttrib4f(5);vertexAttrib4fv(2);vertexAttribI4iv(2);vertexAttribI4uiv(2);vertexAttribPointer(6);viewport(4);drawingBufferFormat;drawingBufferStorage(3);constructor;makeXRCompatible(0)' };
        const _mask = typeof globalThis._maskFunction === "function" ? globalThis._maskFunction : (f) => f;
        const _glObjects = {
            __proto__: null,
            createBuffer: "WebGLBuffer", createFramebuffer: "WebGLFramebuffer", createProgram: "WebGLProgram",
            createRenderbuffer: "WebGLRenderbuffer", createShader: "WebGLShader", createTexture: "WebGLTexture",
            createVertexArray: "WebGLVertexArrayObject", createQuery: "WebGLQuery", createSampler: "WebGLSampler",
            createSync: "WebGLSync", createTransformFeedback: "WebGLTransformFeedback",
        };
        const _glMake = (name) => {
            const C = globalThis[name];
            return typeof C === "function" ? Object.create(C.prototype) : {};
        };
        const _glStub = (name, length) => {
            const body = _glObjects[name]
                ? () => _glMake(_glObjects[name])
                : (name.startsWith("is") ? () => false : (name.startsWith("get") ? () => null : () => undefined));
            const f = { [name](...args) { return body(args); } }[name];
            Object.defineProperty(f, "length", { value: length, configurable: true });
            _mask(f, name);
            return { value: f, writable: true, enumerable: true, configurable: true };
        };
        const _glAccessor = (name) => {
            const spaces = new WeakMap();
            const get = {
                canvas: () => function () { return _gl(this).canvas; },
                drawingBufferWidth: () => function () { return _gl(this).width; },
                drawingBufferHeight: () => function () { return _gl(this).height; },
                drawingBufferFormat: () => function () { return 32856; },
                drawingBufferColorSpace: () => function () { return spaces.get(this) || "srgb"; },
                unpackColorSpace: () => function () { return spaces.get(this) || "srgb"; },
            }[name];
            if (!get) return null;
            const g = Object.getOwnPropertyDescriptor({ get [name]() { return get().call(this); } }, name).get;
            _mask(g, "get " + name);
            const d = { get: g, set: undefined, enumerable: true, configurable: true };
            if (name === "drawingBufferColorSpace" || name === "unpackColorSpace") {
                const s = Object.getOwnPropertyDescriptor({
                    set [name](v) { spaces.set(this, `${v}`); },
                }, name).set;
                _mask(s, "set " + name);
                d.set = s;
            }
            return d;
        };
        const _buildGL = (C, fallback) => {
            const proto = C.prototype;
            const existing = { __proto__: null };
            for (const k of Object.getOwnPropertyNames(proto)) {
                if (k === "constructor") continue;
                existing[k] = Object.getOwnPropertyDescriptor(proto, k);
                delete proto[k];
            }
            for (const k of Object.getOwnPropertyNames(C)) {
                if (k === "length" || k === "name" || k === "prototype") continue;
                try { delete C[k]; } catch (_) {}
            }
            const ctor = Object.getOwnPropertyDescriptor(proto, "constructor");
            delete proto.constructor;
            const tag = Object.getOwnPropertyDescriptor(proto, Symbol.toStringTag);
            if (tag) delete proto[Symbol.toStringTag];
            for (const entry of GL_TABLES[C.name].split(";")) {
                const colon = entry.indexOf(":");
                const paren = entry.indexOf("(");
                if (colon > 0) {
                    const name = entry.slice(0, colon);
                    const value = Number(entry.slice(colon + 1));
                    const d = { value, writable: false, enumerable: true, configurable: false };
                    Object.defineProperty(proto, name, d);
                    Object.defineProperty(C, name, d);
                    continue;
                }
                if (paren > 0) {
                    const name = entry.slice(0, paren);
                    const length = Number(entry.slice(paren + 1, -1));
                    let d = existing[name] || (fallback ? fallback[name] : null);
                    if (d && typeof d.value === "function") {
                        Object.defineProperty(d.value, "length", { value: length, configurable: true });
                        _mask(d.value, name);
                        d = { value: d.value, writable: true, enumerable: true, configurable: true };
                    } else {
                        d = _glStub(name, length);
                    }
                    Object.defineProperty(proto, name, d);
                    continue;
                }
                const name = entry.endsWith("=") ? entry.slice(0, -1) : entry;
                if (name === "constructor") {
                    if (ctor) Object.defineProperty(proto, "constructor", ctor);
                    continue;
                }
                const d = _glAccessor(name);
                if (d) Object.defineProperty(proto, name, d);
            }
            Object.defineProperty(proto, Symbol.toStringTag, { value: C.name, configurable: true });
            return existing;
        };
        const _gl1Members = _buildGL(WebGLRenderingContext, null);
        _buildGL(WebGL2RenderingContext, _gl1Members);
    }

    // AudioContext + OfflineAudioContext
    // Simulates the pipeline commonly used for audio fingerprinting:
    //   OscillatorNode → DynamicsCompressorNode → destination
    
    // Every node knows the context that made it, and carries the channel
    // properties the spec gives it. Audio fingerprinting reads them one by one —
    // `AnalyserNode.context.sampleRate`, `.channelCount`, `.channelCountMode`
    // and so on — and a node without them answers `undefined` to each, which
    // both throws on the `context` hop and leaves a profile no browser produces.
    class AudioNode extends EventTarget {
        constructor(context, opts) {
            super();
            const o = opts || {};
            _idl.own(this)._context = context || null;
            _idl.own(this)._numberOfInputs = o.inputs === undefined ? 1 : o.inputs;
            _idl.own(this)._numberOfOutputs = o.outputs === undefined ? 1 : o.outputs;
            _idl.own(this)._channelCount = o.channelCount === undefined ? 2 : o.channelCount;
            _idl.own(this)._channelCountMode = o.channelCountMode || "max";
            _idl.own(this)._channelInterpretation = "speakers";
        }
        get context() { return _idl.own(this)._context; }
        get numberOfInputs() { return _idl.own(this)._numberOfInputs; }
        get numberOfOutputs() { return _idl.own(this)._numberOfOutputs; }
        get channelCount() { return _idl.own(this)._channelCount; }
        set channelCount(v) { _idl.own(this)._channelCount = v | 0; }
        get channelCountMode() { return _idl.own(this)._channelCountMode; }
        set channelCountMode(v) { _idl.own(this)._channelCountMode = String(v); }
        get channelInterpretation() { return _idl.own(this)._channelInterpretation; }
        set channelInterpretation(v) { _idl.own(this)._channelInterpretation = String(v); }
        connect(dest) { return dest; }
        disconnect() {}
    }

    class AudioScheduledSourceNode extends AudioNode {
        constructor(context, opts) { super(context, opts); }
        start() {}
        stop() {}
    }

    class OscillatorNode extends AudioScheduledSourceNode {
        constructor(context) {
            super(context, { inputs: 0, outputs: 1 });
            const _st = _idl.own(this);
            _st._type = "sine";
            _st.frequency = {
                _value: 440,
                get value() { return this._value; },
                set value(v) { this._value = v; _octxSet(context, "oscFreq", v); }
            };
            _st.detune = { value: 0 };
        }
        get type() { return _idl.own(this)._type; }
        set type(v) { _idl.own(this)._type = v; _octxSet(_idl.own(this)._context, "oscType", v); }
    }
    _idl.fields(OscillatorNode.prototype, ["detune", "frequency"]);

    // `new AudioBuffer({length, sampleRate})` is constructible in a browser and
    // was only a name here, so it threw "Illegal constructor". Fingerprinters
    // build one to compare `getChannelData` against `copyFromChannel`: the two
    // must return the same samples, and a browser where the constructor throws
    // cannot answer at all.
    class AudioBuffer {
        #channels;
        #length;
        #sampleRate;
        constructor(options) {
            if (!options || typeof options !== "object") {
                throw new TypeError(
                    "Failed to construct 'AudioBuffer': parameter 1 is not of type 'AudioBufferOptions'.");
            }
            const length = options.length | 0;
            const sampleRate = +options.sampleRate;
            if (!(length > 0)) {
                throw new TypeError(
                    "Failed to construct 'AudioBuffer': The number of frames provided (0) is less than or equal to the minimum bound (0).");
            }
            if (!(sampleRate > 0)) {
                throw new TypeError(
                    "Failed to construct 'AudioBuffer': required member sampleRate is undefined.");
            }
            const count = options.numberOfChannels === undefined
                ? 1 : Math.max(1, options.numberOfChannels | 0);
            this.#channels = [];
            for (let i = 0; i < count; i++) this.#channels.push(new Float32Array(length));
            this.#length = length;
            this.#sampleRate = sampleRate;
        }
        get numberOfChannels() { return this.#channels.length; }
        get length() { return this.#length; }
        get sampleRate() { return this.#sampleRate; }
        get duration() { return this.#length / this.#sampleRate; }
        getChannelData(channel) {
            const data = this.#channels[channel | 0];
            if (!data) {
                throw new DOMException(
                    "Failed to execute 'getChannelData' on 'AudioBuffer': channel index out of range",
                    "IndexSizeError");
            }
            return data;
        }
        copyFromChannel(destination, channel, bufferOffset) {
            const src = this.getChannelData(channel);
            const start = bufferOffset | 0;
            const n = Math.min(destination.length, Math.max(0, src.length - start));
            for (let i = 0; i < n; i++) destination[i] = src[start + i];
        }
        copyToChannel(source, channel, bufferOffset) {
            const dst = this.getChannelData(channel);
            const start = bufferOffset | 0;
            const n = Math.min(source.length, Math.max(0, dst.length - start));
            for (let i = 0; i < n; i++) dst[start + i] = source[i];
        }
    }

    class AudioParam {
        #context;
        #setter;
        #value;
        constructor(val, context, setter) {
            this.#value = val;
            this.#context = context;
            this.#setter = setter;
        }
        get value() { return this.#value; }
        set value(v) { this.#value = v; if (this.#setter) this.#setter(v); }
        setValueAtTime() { return this; }
        linearRampToValueAtTime() { return this; }
        exponentialRampToValueAtTime() { return this; }
        setTargetAtTime() { return this; }
        setValueCurveAtTime() { return this; }
        cancelScheduledValues() { return this; }
        cancelAndHoldAtTime() { return this; }
    }

    class GainNode extends AudioNode {
        constructor(context) {
            super(context);
            const _st = _idl.own(this);
            _st.gain = new AudioParam(1, context);
        }
    }
    _idl.fields(GainNode.prototype, ["gain"]);

    class DynamicsCompressorNode extends AudioNode {
        constructor(context) {
            super(context, { channelCount: 2, channelCountMode: "clamped-max" });
            const _st = _idl.own(this);
            _st.threshold = new AudioParam(-24, context, v => { _octxSet(context, "compThreshold", v); });
            _st.knee = new AudioParam(30, context, v => { _octxSet(context, "compKnee", v); });
            _st.ratio = new AudioParam(12, context, v => { _octxSet(context, "compRatio", v); });
            _st.attack = new AudioParam(0.003, context, v => { _octxSet(context, "compAttack", v); });
            _st.release = new AudioParam(0.25, context, v => { _octxSet(context, "compRelease", v); });
        }
        // Readonly float in dB, 0 until a render has happened — Chrome's shape.
        // It used to be missing entirely, and hCaptcha's audio probe reads
        // `node.reduction.value || node.reduction` (the legacy-AudioParam
        // compat form) from its `complete` handler, so the whole handler threw
        // `Cannot read properties of undefined (reading 'value')`.
        get reduction() {
            const c = this.context;
            const st = c && _octxState(c);
            return st && typeof st.compReduction === "number" ? st.compReduction : 0;
        }
    }
    _idl.fields(DynamicsCompressorNode.prototype, ["attack", "knee", "ratio", "release", "threshold"]);

    class BiquadFilterNode extends AudioNode {
        constructor(context) {
            super(context);
            const _st = _idl.own(this);
            this.type = "lowpass";
            _st.frequency = new AudioParam(350, context);
            _st.detune = new AudioParam(0, context);
            _st.Q = new AudioParam(1, context);
            _st.gain = new AudioParam(0);
        }
        getFrequencyResponse(freqArr, magOut, phaseOut) {
            if (!(freqArr instanceof Float32Array)) return;
            const _typeIds = {
                lowpass: 0, highpass: 1, bandpass: 2, lowshelf: 3,
                highshelf: 4, peaking: 5, notch: 6, allpass: 7,
            };
            const tid = _typeIds[this.type] ?? 0;
            const sr = (this.context && this.context.sampleRate) || 44100;
            const inBytes = new Uint8Array(freqArr.buffer, freqArr.byteOffset, freqArr.byteLength);
            const out = ops.op_audio_biquad_response(
                inBytes, tid,
                this.frequency.value, this.Q.value,
                this.gain.value, sr
            );
            const result = new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);
            const n = freqArr.length;
            const lenM = Math.min(magOut.length, n);
            const lenP = Math.min(phaseOut.length, n);
            for (let i = 0; i < lenM; i++) magOut[i] = result[i];
            for (let i = 0; i < lenP; i++) phaseOut[i] = result[n + i];
        }
    }
    _idl.fields(BiquadFilterNode.prototype, ["Q", "detune", "frequency", "gain"]);

    class AnalyserNode extends AudioNode {
        #prevFreq;
        #timeDomain;
        constructor(context) {
            super(context);
            this.fftSize = 2048;
            this.smoothingTimeConstant = 0.8;
            this.minDecibels = -100;
            this.maxDecibels = -30;
            this.#timeDomain = null;
            this.#prevFreq = null;
        }
        get frequencyBinCount() { return this.fftSize / 2; }
        getByteFrequencyData(arr) {
            const f = new Float32Array(this.frequencyBinCount);
            this.getFloatFrequencyData(f);
            const range = this.maxDecibels - this.minDecibels;
            const len = Math.min(arr.length, f.length);
            for (let i = 0; i < len; i++) {
                const norm = (f[i] - this.minDecibels) / range;
                arr[i] = Math.max(0, Math.min(255, Math.round(norm * 255)));
            }
        }
        getFloatFrequencyData(arr) {
            if (!this.#timeDomain || this.#timeDomain.length < this.fftSize) {
                for (let i = 0; i < arr.length; i++) arr[i] = this.minDecibels;
                return;
            }
            const tdBytes = new Uint8Array(this.#timeDomain.buffer, 0, this.fftSize * 4);
            const prevBytes = this.#prevFreq
                ? new Uint8Array(this.#prevFreq.buffer)
                : new Uint8Array(0);
            const out = ops.op_audio_analyser_freq_data(
                tdBytes, this.fftSize,
                Math.round(this.smoothingTimeConstant * 100),
                prevBytes
            );
            const result = new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);
            const len = Math.min(arr.length, result.length);
            for (let i = 0; i < len; i++) arr[i] = result[i];
            this.#prevFreq = result.slice();
        }
        getByteTimeDomainData(arr) {
            if (!this.#timeDomain) {
                for (let i = 0; i < arr.length; i++) arr[i] = 128;
                return;
            }
            const len = Math.min(arr.length, this.#timeDomain.length);
            for (let i = 0; i < len; i++) {
                arr[i] = Math.max(0, Math.min(255, Math.round((this.#timeDomain[i] + 1) * 127.5)));
            }
        }
        getFloatTimeDomainData(arr) {
            if (!this.#timeDomain) {
                for (let i = 0; i < arr.length; i++) arr[i] = 0;
                return;
            }
            const len = Math.min(arr.length, this.#timeDomain.length);
            for (let i = 0; i < len; i++) arr[i] = this.#timeDomain[i];
        }
    }

    class AudioDestinationNode extends AudioNode {
        constructor() {
            super(); const _st = _idl.own(this); _st.maxChannelCount = 2; }
    }
    _idl.fields(AudioDestinationNode.prototype, ["maxChannelCount"]);

    // AudioContext fingerprintable surface. Real Chrome reports a
    // stable per-device value across page loads. Previously this used
    // `Math.random()` per-IIFE which made sequential page loads in the
    // same SharedSession return DIFFERENT sampleRates — an inconsistency
    // a real browser would not exhibit.
    //
    // Now: sampleRate reads from profile.audio_sample_rate (48000 on
    // Apple Silicon, 44100 elsewhere). baseLatency + outputLatency are
    // derived deterministically from `audio_seed` so they look like real
    // hardware variation but stay stable across page loads.
    const _audioSampleRate = (() => {
        try {
            const has = ops.op_has_stealth_profile && ops.op_has_stealth_profile();
            if (has) {
                const raw = ops.op_get_profile_value("audio_sample_rate");
                const v = parseInt(raw, 10);
                // Stealth profile validate() restricts this to
                // {44100, 48000, 96000, 192000}; we trust it here.
                if (Number.isInteger(v) && v > 0) return v;
            }
        } catch (_) {}
        return 44100;
    })();
    const _audioBaseLatency = (() => {
        // Real Chrome reports baseLatency in [0.005, 0.030] sec range
        // depending on output device. Derive deterministically from
        // bits 0-9 of audio_seed so it's stable per profile.
        let bits = 512; // mid-range fallback
        try {
            const has = ops.op_has_stealth_profile && ops.op_has_stealth_profile();
            if (has) {
                const raw = ops.op_get_profile_value("audio_seed");
                if (raw) {
                    bits = Number(BigInt(raw) & 0x3ffn); // 0..1023
                }
            }
        } catch (_) {}
        const v = 0.005 + (bits / 1023) * 0.025;
        return Math.round(v * 1000) / 1000;
    })();
    const _audioOutputLatency = (() => {
        // outputLatency > baseLatency typically. Add 5-30ms on top,
        // derived from bits 10-19 of audio_seed.
        let bits = 512;
        try {
            const has = ops.op_has_stealth_profile && ops.op_has_stealth_profile();
            if (has) {
                const raw = ops.op_get_profile_value("audio_seed");
                if (raw) {
                    bits = Number((BigInt(raw) >> 10n) & 0x3ffn);
                }
            }
        } catch (_) {}
        const v = _audioBaseLatency + 0.005 + (bits / 1023) * 0.025;
        return Math.round(v * 1000) / 1000;
    })();

    class BaseAudioContext extends EventTarget {
        constructor() {
            super();
            const _st = _idl.own(this);
            _st.sampleRate = _audioSampleRate;
            _st.baseLatency = _audioBaseLatency;
            _st.outputLatency = _audioOutputLatency;
            _st.state = "running";
            _st.currentTime = 0;
            _st.destination = new AudioDestinationNode();
            _st.listener = {}; // AudioListener stub
        }
        createOscillator() { return new OscillatorNode(this); }
        createDynamicsCompressor() { return new DynamicsCompressorNode(this); }
        createAnalyser() { return new AnalyserNode(this); }
        createGain() { return new GainNode(this); }
        createBiquadFilter() { return new BiquadFilterNode(this); }
        createBufferSource() {
             return { connect() {}, start() {}, stop() {}, buffer: null, loop: false };
        }
        createBuffer(channels, length, sampleRate) {
            const bufs = [];
            for (let c = 0; c < channels; c++) bufs.push(new Float32Array(length));
            return {
                numberOfChannels: channels, length, sampleRate,
                duration: length / sampleRate,
                getChannelData(c) { return bufs[c]; }
            };
        }
        decodeAudioData() { return Promise.resolve(); }
        resume() { return Promise.resolve(); }
    }
    // baseLatency/outputLatency are AudioContext members in Chrome; the state
    // is written here and parity_bootstrap.js installs the accessors there.
    _idl.fields(BaseAudioContext.prototype, ["currentTime", "destination", "listener", "sampleRate", "state"]);
    globalThis.BaseAudioContext = BaseAudioContext;

    class AudioContext extends BaseAudioContext {
        constructor() {
            super();
        }
        close() { return Promise.resolve(); }
        suspend() { return Promise.resolve(); }
    }

    const _octx = new WeakMap();
    const _octxState = (ctx) => _octx.get(ctx);
    const _octxSet = (ctx, key, v) => { const st = _octx.get(ctx); if (st) st[key] = v; };
    class OfflineAudioContext extends BaseAudioContext {
        constructor(channels, length, sampleRate) {
            super();
            _idl.own(this).sampleRate = sampleRate || _audioSampleRate;
            _octx.set(this, {
                channels: channels || 1,
                length: length || _audioSampleRate,
                oscType: "triangle",
                oscFreq: 10000,
                compThreshold: -24,
                compKnee: 30,
                compRatio: 12,
                compAttack: 0.003,
                compRelease: 0.25,
                compReduction: 0,
            });
        }

        startRendering() {
            const self = this;
            return new Promise((resolve) => {
                const st = _octxState(self) || {};
                const sr = self.sampleRate;
                const len = st.length;
                const freq = st.oscFreq;
                const type = st.oscType;
                const waveTypeId = type === "sine" ? 0
                    : type === "square" ? 2
                    : type === "sawtooth" ? 3
                    : 1; // triangle

                let seed = 0;
                try {
                    // Use the local `ops` binding (same as canvas_seed path
                    // at line 59) — `Deno` may be removed by stealth cleanup,
                    // but `ops` was captured at IIFE entry.
                    if (ops.op_has_stealth_profile && ops.op_has_stealth_profile()) {
                        const raw = ops.op_get_profile_value("audio_seed");
                        if (raw) {
                            // op_get_profile_value returns u64 stringified.
                            // parseInt → Number lossy-coerces past 2^53, then
                            // `| 0` truncates a rounded float — distinct u64s
                            // can collapse to the same int32. BigInt.asIntN(32)
                            // does exact 32-bit truncation.
                            try {
                                seed = Number(BigInt.asIntN(32, BigInt(raw)));
                            } catch (_) {
                                const parsed = parseInt(raw, 10);
                                if (!Number.isNaN(parsed)) seed = parsed | 0;
                            }
                        }
                    }
                } catch (e) {}

                let data;
                try {
                    const bytes = ops.op_offline_audio_render(
                        seed, sr | 0, len | 0, freq, waveTypeId,
                        st.compThreshold, st.compKnee, st.compRatio,
                        st.compAttack, st.compRelease,
                    );
                    data = new Float32Array(bytes.buffer, bytes.byteOffset, len);
                    // One trailing f32: the compressor's metering gain in dB.
                    st.compReduction = new Float32Array(
                        bytes.buffer, bytes.byteOffset, len + 1,
                    )[len];
                } catch (e) {
                    data = new Float32Array(len);
                }

                // A real `AudioBuffer`, not a look-alike object: fingerprinters
                // compare `getChannelData` against `copyFromChannel` on the
                // rendered buffer and read `AudioBuffer.prototype` to see which
                // methods exist. A plain object answers neither.
                let buf;
                try {
                    buf = new AudioBuffer({
                        length: len, sampleRate: sr, numberOfChannels: st.channels,
                    });
                    buf.copyToChannel(data, 0, 0);
                } catch (_) {
                    buf = {
                        numberOfChannels: st.channels,
                        length: len,
                        sampleRate: sr,
                        duration: len / sr,
                        getChannelData() { return data; },
                    };
                }
                resolve(buf);

                // Completion is also an *event* — `complete`, carrying the
                // rendered buffer — and a script may wait on either. Resolving
                // only the promise leaves the listener-based half hanging: the
                // audio fingerprint is one entry in creepjs's `Promise.all` over
                // nineteen collectors, so the whole report stayed at
                // "Computing..." forever with nothing logged.
                //
                // Dispatched in a microtask so a listener attached right after
                // `startRendering()` returns — which is what the idiom looks
                // like — is already in place.
                queueMicrotask(() => {
                    let ev;
                    try {
                        ev = new Event("complete");
                    } catch (_) {
                        ev = null;
                    }
                    if (ev) {
                        try {
                            Object.defineProperty(ev, "renderedBuffer", {
                                value: buf, enumerable: true, configurable: true,
                            });
                        } catch (_) { /* ignore */ }
                        try { self.dispatchEvent(ev); } catch (_) { /* ignore */ }
                    }
                    // `dispatchEvent` here does not run `on…` handler attributes,
                    // so the attribute form is invoked explicitly.
                    try {
                        if (typeof self.oncomplete === "function") {
                            self.oncomplete(ev || { type: "complete", renderedBuffer: buf });
                        }
                    } catch (_) { /* ignore */ }
                });
            });
        }
    }

    // HTMLCanvasElement: getContext returns the right context
    class HTMLCanvasElement {
        #canvasId;
        #attrs;
        constructor(width = 300, height = 150) {
            this.#canvasId = ops.op_canvas_create(width, height, _getOsName(), _getCanvasSeed());
            this.#attrs = { width: String(width), height: String(height) };
            Object.defineProperty(this, 'width', { value: width, writable: true, enumerable: true, configurable: true });
            Object.defineProperty(this, 'height', { value: height, writable: true, enumerable: true, configurable: true });
            // Element base properties — fpCollect and bot.sannysoft expect these.
            // Use defineProperty because Element.prototype (which we chain into
            // at the bottom of this file) has tagName/nodeName/etc. as getters
            // with no setters — direct assignment would fail.
            Object.defineProperty(this, 'tagName', { value: 'CANVAS', configurable: true, writable: true });
            Object.defineProperty(this, 'nodeName', { value: 'CANVAS', configurable: true, writable: true });
            Object.defineProperty(this, 'nodeType', { value: 1, configurable: true, writable: true });
            Object.defineProperty(this, 'style', { value: { cssText: "" }, configurable: true, writable: true });
            Object.defineProperty(this, 'classList', {
                value: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
                configurable: true, writable: true,
            });
            Object.defineProperty(this, 'dataset', { value: {}, configurable: true, writable: true });
            Object.defineProperty(this, 'childNodes', { value: [], configurable: true, writable: true });
            Object.defineProperty(this, 'children', { value: [], configurable: true, writable: true });
        }
        // Attribute API — required by canvas fingerprinters that do
        // `canvas.setAttribute('width', 200)` before drawing.
        setAttribute(name, value) {
            this.#attrs[name] = String(value);
            if (name === "width") {
                Object.defineProperty(this, 'width', { value: parseInt(value, 10) || this.width, writable: true, enumerable: true, configurable: true });
            }
            if (name === "height") {
                Object.defineProperty(this, 'height', { value: parseInt(value, 10) || this.height, writable: true, enumerable: true, configurable: true });
            }
        }
        getAttribute(name) { return this.#attrs[name] !== undefined ? this.#attrs[name] : null; }
        removeAttribute(name) { delete this.#attrs[name]; }
        hasAttribute(name) { return name in this.#attrs; }
        getContext(type) {
            if (type === "2d") return _context2dFor(this, this.#canvasId);
            if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") {
                // FIX-D2: webgl2 → WebGL2RenderingContext (distinct class +
                // WebGL 2 surface); webgl/experimental-webgl → WebGLRenderingContext
                // with the WebGL 1 surface (_isWebGL2 = false).
                const isV2 = (type === "webgl2");
                const gl = isV2 ? new WebGL2RenderingContext() : new WebGLRenderingContext();
                const st = _gl(gl);
                st.isWebGL2 = isV2;
                st.canvas = this;
                st.width = this.width;
                st.height = this.height;
                return gl;
            }
            return null;
        }
        toDataURL(type) { return ops.op_canvas_to_data_url(this.#canvasId); }
        toBlob(cb, type) {
            const url = this.toDataURL();
            queueMicrotask(() => {
                try { cb(new Blob([_dataUrlToBytes(url)], { type: type || "image/png" })); }
                catch (_e) {}
            });
        }
        // Minimal Node API
        appendChild(child) { this.childNodes.push(child); return child; }
        removeChild(child) {
            const i = this.childNodes.indexOf(child);
            if (i >= 0) this.childNodes.splice(i, 1);
            return child;
        }
        addEventListener(type, listener, options) {
            // Inherit from Node -> EventTarget
            return super.addEventListener(type, listener, options);
        }
        removeEventListener(type, listener, options) {
            return super.removeEventListener(type, listener, options);
        }
        dispatchEvent(event) {
            return super.dispatchEvent(event);
        }
        // Clone / get bounding box — fingerprint probes may call these
        cloneNode() { return new HTMLCanvasElement(this.width, this.height); }
        getBoundingClientRect() {
            return { x: 0, y: 0, width: this.width, height: this.height, top: 0, left: 0, right: this.width, bottom: this.height };
        }
    }

    // Do NOT replace globalThis.HTMLCanvasElement — dom_bootstrap already
    // exposes it as a subclass of HTMLElement ← Element ← Node ← EventTarget.
    // Instead, chain our standalone canvas class's prototype to the dom
    // HTMLCanvasElement.prototype so `standalone instanceof HTMLCanvasElement`
    // returns true.
    //
    // Capture the DOM-side HTMLCanvasElement.prototype BEFORE the swap so we
    // can also install the lazy `_canvasId`-based methods (getContext,
    // toDataURL, ...) onto it. HTML-parsed <canvas> elements have THIS
    // prototype in their chain — not the standalone's — so without this
    // double install they would not see `getContext`. The lazy methods
    // installed further down work on both kinds of canvas (`_canvasId`
    // is initialised on demand via `_lazyInitCanvas`).
    let _domCanvasProto = null;
    if (globalThis.HTMLCanvasElement) {
        _domCanvasProto = globalThis.HTMLCanvasElement.prototype;
        Object.setPrototypeOf(HTMLCanvasElement.prototype, globalThis.HTMLCanvasElement.prototype);
        Object.setPrototypeOf(HTMLCanvasElement, globalThis.HTMLCanvasElement);
    }
    // NOT reassigned: the DOM-side class (an `HTMLElement` subclass) stays the
    // global, so `document.createElement('canvas') instanceof HTMLCanvasElement`
    // holds. Overwriting it with the standalone class broke exactly that — the
    // real element does not have the standalone prototype in its chain.
    Object.defineProperty(CanvasRenderingContext2D.prototype, 'canvas', {
        get() { return _ctxCanvas.get(this) || null; },
        enumerable: true, configurable: true,
    });

    globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
    globalThis.WebGLRenderingContext = WebGLRenderingContext;
    // Symbol.toStringTag — some scripts check
    // Object.prototype.toString.call(ctx) which must return
    // "[object CanvasRenderingContext2D]" / "[object WebGLRenderingContext]"
    // (not "[object Object]"). Without this tag we show as a bot.
    try {
        Object.defineProperty(CanvasRenderingContext2D.prototype, Symbol.toStringTag, {
            value: "CanvasRenderingContext2D",
            configurable: true,
        });
        Object.defineProperty(WebGLRenderingContext.prototype, Symbol.toStringTag, {
            value: "WebGLRenderingContext",
            configurable: true,
        });
        // FIX-D2: WebGL2RenderingContext is its own class now — give it its own
        // toStringTag so `Object.prototype.toString.call(gl2)` returns
        // "[object WebGL2RenderingContext]" (own prop shadows the inherited one).
        Object.defineProperty(WebGL2RenderingContext.prototype, Symbol.toStringTag, {
            value: "WebGL2RenderingContext",
            configurable: true,
        });
        Object.defineProperty(WebGLRenderingContext.prototype, 'constructor', {
            value: WebGLRenderingContext,
            configurable: true,
            writable: true,
        });
        Object.defineProperty(WebGL2RenderingContext.prototype, 'constructor', {
            value: WebGL2RenderingContext,
            configurable: true,
            writable: true,
        });
        Object.defineProperty(CanvasRenderingContext2D.prototype, 'constructor', {
            value: CanvasRenderingContext2D,
            configurable: true,
            writable: true,
        });
    } catch {}
    globalThis.WebGL2RenderingContext = WebGL2RenderingContext;
    globalThis.AudioContext = AudioContext;
    globalThis.OfflineAudioContext = OfflineAudioContext;
    globalThis.BaseAudioContext = BaseAudioContext;
    // No `webkitAudioContext`: Chrome dropped the prefixed alias, and a global
    // this engine has and the browser it claims to be does not is a
    // difference in the direction that matters — verified against Chrome,
    // where both it and `webkitOfflineAudioContext` are undefined.
    // These were names in the interface table only, so `instanceof` was false
    // for every node this engine hands out and `new AudioBuffer(...)` threw.
    globalThis.AudioNode = AudioNode;
    globalThis.AudioScheduledSourceNode = AudioScheduledSourceNode;
    globalThis.AudioParam = AudioParam;
    globalThis.AudioBuffer = AudioBuffer;
    globalThis.AnalyserNode = AnalyserNode;
    globalThis.OscillatorNode = OscillatorNode;
    globalThis.GainNode = GainNode;
    globalThis.BiquadFilterNode = BiquadFilterNode;
    globalThis.DynamicsCompressorNode = DynamicsCompressorNode;
    // Symbol.toStringTag for audio contexts — some scripts probe these.
    try {
        Object.defineProperty(AudioContext.prototype, Symbol.toStringTag, {
            value: "AudioContext", configurable: true,
        });
        Object.defineProperty(OfflineAudioContext.prototype, Symbol.toStringTag, {
            value: "OfflineAudioContext", configurable: true,
        });
        Object.defineProperty(BaseAudioContext.prototype, Symbol.toStringTag, {
            value: "BaseAudioContext", configurable: true,
        });
    } catch {}

    // `document.createElement('canvas')` deliberately NOT patched.
    //
    // It used to return `new HTMLCanvasElement()` — the standalone class above,
    // which owns a drawing surface but no node in the DOM arena. Such an object
    // has no node id, so `parent.appendChild(canvas)` resolved it to -1 and the
    // op silently did nothing: a canvas created from script could never be put
    // in the document. Everything that builds a picture and inserts it — a
    // chart, a game, a captcha's challenge scene — got a surface it could draw
    // on and a page that never showed it, with no error anywhere.
    //
    // The real element already carries every canvas method: they are installed
    // on `_HTMLCanvasProto` below, and `_lazyInitCanvas` gives it a surface on
    // the first `getContext`.

    // Install canvas-specific methods on `HTMLCanvasElement.prototype`
    // directly (NOT on Element.prototype). Real Chrome's DOM uses
    // WebIDL-generated bindings where `getContext` / `toDataURL` /
    // `toBlob` are own properties of HTMLCanvasElement.prototype with
    // brand-checking that throws `TypeError: Illegal invocation` when
    // called on a non-canvas `this`. Fingerprint probes check for
    // this via `Object.getOwnPropertyDescriptor(HTMLCanvasElement
    // .prototype, 'getContext')` and by calling methods with bogus
    // `this` to observe the error message.
    const _HTMLCanvasProto = globalThis.HTMLCanvasElement &&
        globalThis.HTMLCanvasElement.prototype;
    if (_HTMLCanvasProto) {
        // Brand-check helper: Chrome throws `TypeError: Illegal
        // invocation` with no stack-relevant info beyond the message.
        //
        // We accept either `tagName === "CANVAS"` (for HTML-parsed
        // canvases whose tag name is authoritative) or
        // `this instanceof HTMLCanvasElement` (for standalone
        // canvases from createElement whose constructor sets
        // tagName after assigning width/height). This matches the
        // shape probes fingerprinters actually run while allowing
        // partially-constructed canvases to pass the setter path.
        function _requireCanvas(self, methodName) {
            const ok =
                self &&
                (self.tagName === "CANVAS" ||
                    self instanceof globalThis.HTMLCanvasElement);
            if (!ok) {
                throw new TypeError(
                    "Failed to execute '" +
                        methodName +
                        "' on 'HTMLCanvasElement': Illegal invocation"
                );
            }
        }
        function _lazyInitCanvas(self) {
            if (!_idl.own(self)._canvasId) {
                const w = parseInt(self.getAttribute && self.getAttribute("width")) || 300;
                const h = parseInt(self.getAttribute && self.getAttribute("height")) || 150;
                _idl.own(self)._canvasId = ops.op_canvas_create(w, h, _getOsName(), _getCanvasSeed());
            }
        }

        // `width`/`height` reflect the content attributes, defaulting to
        // 300x150. Assigning either resets the bitmap, as in a browser — code
        // that sizes a canvas before drawing relies on both halves.
        for (const [prop, dflt] of [["width", 300], ["height", 150]]) {
            Object.defineProperty(_HTMLCanvasProto, prop, {
                get() {
                    const v = parseInt(this.getAttribute && this.getAttribute(prop), 10);
                    return Number.isNaN(v) ? dflt : v;
                },
                set(v) {
                    const n = Math.max(0, v | 0);
                    if (this.setAttribute) this.setAttribute(prop, String(n));
                    // Resize the existing surface rather than dropping its id.
                    // Handing out a new id here orphaned every context already
                    // taken from this canvas: the page went on drawing into the
                    // old surface while everything else read a fresh empty one.
                    try {
                        if (_idl.own(this)._canvasId) {
                            const w = prop === "width" ? n : this.width;
                            const h = prop === "height" ? n : this.height;
                            ops.op_canvas_resize(_idl.own(this)._canvasId, w | 0, h | 0);
                            // The engine drops its drawing state here, per spec;
                            // the context's readable mirror follows it.
                            const ctx = _ctx2d.get(this);
                            if (ctx) _resetCtxState(ctx);
                        }
                    } catch (_) {}
                },
                enumerable: true,
                configurable: true,
            });
        }

        Object.defineProperty(_HTMLCanvasProto, "getContext", {
            // Method-shorthand, not `function getContext(...) {}` — a plain
            // function expression has its own `.prototype` (constructible)
            // and isn't implicitly strict, both of which fail the
            // native-function shape checks fingerprint SDKs run against
            // every DOM method (`Object.getOwnPropertyDescriptor(...).value`
            // has `'prototype' in it`, `.caller`/`.arguments` don't throw).
            value: { getContext(type) {
                _requireCanvas(this, "getContext");
                _lazyInitCanvas(this);
                if (type === "2d") return _context2dFor(this, _idl.own(this)._canvasId);
                if (
                    type === "webgl" ||
                    type === "webgl2" ||
                    type === "experimental-webgl"
                ) {
                    const w = parseInt(this.getAttribute("width")) || 300;
                    const h = parseInt(this.getAttribute("height")) || 150;
                    // FIX-D2: distinct class + surface per requested version.
                    const isV2 = (type === "webgl2");
                    const gl = isV2
                        ? new WebGL2RenderingContext(_idl.own(this)._canvasId, w, h)
                        : new WebGLRenderingContext(_idl.own(this)._canvasId, w, h);
                    const st = _gl(gl);
                    st.isWebGL2 = isV2;
                    st.canvas = this;
                    return gl;
                }
                return null;
            } }.getContext,
            writable: true,
            configurable: true,
            enumerable: false,
        });

        Object.defineProperty(_HTMLCanvasProto, "toDataURL", {
            value: { toDataURL(_type) {
                _requireCanvas(this, "toDataURL");
                // Auto-allocate a canvas if none yet — real Chrome
                // serializes any HTMLCanvasElement, even one whose 2D
                // context was never requested. The result is a fully
                // transparent PNG of the element's width × height.
                if (!_idl.own(this)._canvasId) {
                    try { this.getContext("2d"); } catch (_e) {}
                }
                if (!_idl.own(this)._canvasId) return "data:,";
                return ops.op_canvas_to_data_url(_idl.own(this)._canvasId);
            } }.toDataURL,
            writable: true,
            configurable: true,
            enumerable: false,
        });

        Object.defineProperty(_HTMLCanvasProto, "toBlob", {
            value: function toBlob(cb, type) {
                _requireCanvas(this, "toBlob");
                if (typeof cb !== "function") {
                    throw new TypeError(
                        "Failed to execute 'toBlob' on 'HTMLCanvasElement': callback is not a function"
                    );
                }
                // Match Chrome: the callback fires asynchronously on
                // the next microtask, not synchronously.
                const url = _idl.own(this)._canvasId ? ops.op_canvas_to_data_url(_idl.own(this)._canvasId) : "data:,";
                queueMicrotask(() => {
                    try {
                        cb(new Blob([_dataUrlToBytes(url)], { type: type || "image/png" }));
                    } catch (_e) {}
                });
            },
            writable: true,
            configurable: true,
            enumerable: false,
        });

        // Note: `width` and `height` are deliberately NOT installed on
        // the prototype here. The standalone canvas class in this
        // bootstrap sets them as own instance properties in its
        // constructor before `tagName` is defined, so adding a
        // brand-checking prototype setter breaks construction. A
        // prototype-level width/height accessor would also collide
        // with HTML-parsed `<canvas>` elements whose `getAttribute`
        // path is already canonical. Leave them as instance props.
    }

    // OffscreenCanvas — real canvas-backed implementation.
    //
    // Replaces the minimal stub from window_bootstrap.js (which had
    // `getContext() → null`). With canvas_ext already wired in for
    // the main thread and an identical bootstrap loading in workers,
    // `new OffscreenCanvas(w, h).getContext('2d')` now returns a
    // functional CanvasRenderingContext2D backed by the same ops the
    // on-DOM `<canvas>` element uses — real fillRect, real text,
    // real toDataURL.
    //
    // Anti-fingerprint sites probe this path via
    // `const ctx = new OffscreenCanvas(w, h).getContext('2d'); ctx.fillText(...)`.
    class RealOffscreenCanvas extends EventTarget {
        constructor(width, height) {
            super();
            this.width = width | 0;
            this.height = height | 0;
            _idl.own(this)._canvasId = 0;
            _idl.own(this)._context = null;
        }
        getContext(type, _opts) {
            if (type === "2d") {
                if (!_idl.own(this)._canvasId) {
                    _idl.own(this)._canvasId = ops.op_canvas_create(this.width, this.height, _getOsName(), _getCanvasSeed());
                }
                if (!_idl.own(this)._context) {
                    // The back-reference rides in the constructor: `canvas` is a
                    // getter on the prototype, so assigning it throws.
                    _idl.own(this)._context = new CanvasRenderingContext2D(_idl.own(this)._canvasId, this);
                }
                return _idl.own(this)._context;
            }
            if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") {
                // FP parity: a real OffscreenCanvas exposes WebGL. Some
                // fingerprint workers read webGLVendor/webGLRenderer via
                // `new OffscreenCanvas(1,1).getContext('webgl')` →
                // gl.getParameter(UNMASKED_VENDOR_WEBGL); returning null here
                // differed from real Chrome (the on-DOM <canvas> already
                // supports WebGL).
                // Back it with the same profile-spoofed context that <canvas>
                // getContext uses (canvas_bootstrap.js:1232-1234).
                if (!_idl.own(this)._canvasId) {
                    _idl.own(this)._canvasId = ops.op_canvas_create(this.width, this.height, _getOsName(), _getCanvasSeed());
                }
                const _k = (type === "webgl2") ? "_glctx2" : "_glctx1";
                if (!this[_k]) {
                    const isV2 = (type === "webgl2");
                    const gl = isV2
                        ? new WebGL2RenderingContext(_idl.own(this)._canvasId, this.width, this.height)
                        : new WebGLRenderingContext(_idl.own(this)._canvasId, this.width, this.height);
                    const st = _gl(gl);
                    st.isWebGL2 = isV2;
                    st.canvas = this;
                    this[_k] = gl;
                }
                return this[_k];
            }
            return null;
        }
        transferToImageBitmap() {
            const self = this;
            return {
                width: self.width,
                height: self.height,
                _canvasId: _idl.own(self)._canvasId,
                close() {},
            };
        }
        async convertToBlob(options) {
            const type = (options && options.type) || "image/png";
            if (!_idl.own(this)._canvasId) {
                return new Blob([], { type });
            }
            // toDataURL returns `data:<type>;base64,<data>` — strip
            // the prefix and decode to bytes for a real Blob body.
            const url = ops.op_canvas_to_data_url(_idl.own(this)._canvasId);
            const comma = url.indexOf(",");
            if (comma < 0) return new Blob([], { type });
            const b64 = url.slice(comma + 1);
            const bin = typeof atob === "function" ? atob(b64) : "";
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new Blob([bytes], { type });
        }
    }
    Object.defineProperty(RealOffscreenCanvas.prototype, Symbol.toStringTag, {
        value: "OffscreenCanvas",
        configurable: true,
    });
    // Install as the canonical global — overwrites the window_bootstrap stub.
    globalThis.OffscreenCanvas = RealOffscreenCanvas;

    // Mask methods as native
    if (typeof _maskAsNative === 'function') {
        _maskAsNative(CanvasRenderingContext2D.prototype, 
            'fillRect', 'strokeRect', 'clearRect', 'beginPath', 'moveTo', 'lineTo',
            'fill', 'stroke', 'closePath', 'arc', 'arcTo', 'bezierCurveTo',
            'quadraticCurveTo', 'rect', 'fillText', 'strokeText', 'measureText',
            'save', 'restore', 'translate', 'rotate', 'scale', 'setTransform',
            'resetTransform', 'getTransform', 'createLinearGradient', 
            'createRadialGradient', 'createPattern', 'getImageData', 'putImageData',
            'drawImage', 'isPointInPath', 'isPointInStroke');
        
        _maskAsNative(RealOffscreenCanvas.prototype, 'getContext', 'transferToImageBitmap', 'convertToBlob');

        // HTMLCanvasElement.prototype.transferControlToOffscreen — Chrome
        // 69+ method that returns a new OffscreenCanvas bound to this
        // element. Commonly probed as a real-Chrome
        // signal. Spec: https://html.spec.whatwg.org/#dom-canvas-transfercontroltooffscreen
        if (_HTMLCanvasProto && typeof _HTMLCanvasProto.transferControlToOffscreen !== "function") {
            const _transferControlToOffscreen = function transferControlToOffscreen() {
                const ok = this && (this.tagName === "CANVAS" ||
                    this instanceof globalThis.HTMLCanvasElement);
                if (!ok) {
                    throw new TypeError(
                        "Failed to execute 'transferControlToOffscreen' on 'HTMLCanvasElement': Illegal invocation");
                }
                if (this._offscreenTransferred) {
                    throw new DOMException(
                        "Cannot transfer control from a canvas for more than one time.",
                        "InvalidStateError");
                }
                const w = this.width || 300;
                const h = this.height || 150;
                this._offscreenTransferred = true;
                return new RealOffscreenCanvas(w, h);
            };
            Object.defineProperty(_HTMLCanvasProto, "transferControlToOffscreen", {
                value: _transferControlToOffscreen, configurable: true, writable: true,
            });
            try { _maskAsNative(_HTMLCanvasProto, 'transferControlToOffscreen'); } catch (_) {}
        }

        if (_HTMLCanvasProto) {
            _maskAsNative(_HTMLCanvasProto, 'getContext', 'toDataURL', 'toBlob');
        }

        // Mirror the lazy-init canvas methods onto the DOM-side
        // HTMLCanvasElement.prototype too. HTML-parsed <canvas> elements
        // returned by `document.getElementById(...)` have that prototype
        // in their chain — not the standalone one — so without this
        // mirror, `elem.getContext` is `undefined` on every parsed canvas.
        // The standalone methods read `_idl.own(this)._canvasId` (initialised lazily
        // via `_lazyInitCanvas`), which works for both kinds of canvas.
        if (_domCanvasProto && _domCanvasProto !== _HTMLCanvasProto) {
            for (const name of ['getContext', 'toDataURL', 'toBlob', 'transferControlToOffscreen']) {
                const desc = Object.getOwnPropertyDescriptor(_HTMLCanvasProto, name);
                if (desc && !Object.getOwnPropertyDescriptor(_domCanvasProto, name)) {
                    Object.defineProperty(_domCanvasProto, name, desc);
                }
            }
        }

        if (globalThis.AudioContext) {
            _maskAsNative(AudioContext.prototype, 'createOscillator', 'createDynamicsCompressor', 'close', 'suspend', 'resume');
        }
        if (globalThis.OfflineAudioContext) {
            _maskAsNative(OfflineAudioContext.prototype, 'startRendering');
        }
        if (globalThis.BaseAudioContext) {
            _maskAsNative(BaseAudioContext.prototype, 'createOscillator', 'createDynamicsCompressor', 'createAnalyser', 'createGain', 'createBiquadFilter');
        }
        
        // Mask every own-function method on WebGL[2]RenderingContext.prototype.
        // Many scripts inspect Function.prototype.toString of
        // these methods, which must serialize as native code. Iterating
        // the prototype's own names is durable as the engine grows method
        // coverage — every new method gets masked automatically.
        const _maskAllProtoFns = (proto) => {
            if (!proto) return;
            const names = [];
            for (const n of Object.getOwnPropertyNames(proto)) {
                if (n === 'constructor') continue;
                const d = Object.getOwnPropertyDescriptor(proto, n);
                if (d && typeof d.value === 'function') names.push(n);
            }
            if (names.length) _maskAsNative(proto, ...names);
        };
        if (globalThis.WebGLRenderingContext) {
            _maskAllProtoFns(globalThis.WebGLRenderingContext.prototype);
        }
        if (globalThis.WebGL2RenderingContext) {
            _maskAllProtoFns(globalThis.WebGL2RenderingContext.prototype);
        }
    }
})(globalThis);
