((globalThis) => {
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
            "arial","arial black","courier new","georgia","helvetica",
            "helvetica neue","lucida grande","menlo","monaco","sf pro",
            "times new roman","trebuchet ms","verdana",
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
    // 0.0 .. ~3.5 px deterministic delta. Sub-character-width so layout
    // stays stable, large enough to clear 1e-3 fingerprint comparisons.
    const _fontFamilyWidthDelta = (family) => {
        if (!family) return 0;
        if (_GENERIC_FAMILIES.has(family)) return 0; // generics are baselines
        if (!_resolveInstalledFonts().has(family)) return 0; // not installed on this OS
        const h = _fontProbeFnvHash(family);
        return (h % 7000) / 2000; // 0.0 .. 3.5 px
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
            if (arguments.length === 2) {
                // constructor(width, height)
                height = width;
                width = data;
                data = new Uint8ClampedArray(width * height * 4);
            }
            this.data = data;
            this.width = width;
            this.height = height;
        }
    }
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
            if (v && typeof v === "object" && v._type) {
                // Gradient object
                const stops = (v._stops || []).map(s => {
                    const c = _parseColor(s.color);
                    return [s.offset, c[0], c[1], c[2], c[3]];
                });
                let coords;
                if (v._type === "linear") {
                    coords = [v._x0, v._y0, v._x1, v._y1];
                } else {
                    coords = [v._x0, v._y0, v._r0, v._x1, v._y1, v._r1];
                }
                ops.op_canvas_set_fill_gradient(this.#id, v._type, JSON.stringify({ coords, stops }));
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
            this._font = this.#s.font;
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
            const m = ops.op_canvas_measure_text_full(this.#id, text);
            // Per-family micro-delta so canvas-based font detection works.
            // See `_fontFamilyWidthDelta` for rationale.
            const fam = _primaryFontFamily(this._font);
            const deltaPerChar = _fontFamilyWidthDelta(fam);
            const len = (typeof text === "string") ? text.length : 0;
            const widthDelta = deltaPerChar * Math.max(1, len) * 0.25;
            return {
                width: m.width + widthDelta,
                actualBoundingBoxLeft: m.actual_bounding_box_left,
                actualBoundingBoxRight: m.actual_bounding_box_right + widthDelta,
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
            if (source._decodedImageId !== undefined && source._decodedImageId >= 0) {
                kind = 0; srcId = source._decodedImageId;
                natW = source.naturalWidth || 0; natH = source.naturalHeight || 0;
            } else if (source._canvasId !== undefined) {
                kind = 1; srcId = source._canvasId;
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

    // WebGL — routes through Canvas2D backend for real pixel output.
    // Some scripts call readPixels() after clearColor()+clear() and expect real data.
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
            this._canvasId = canvasId;
            this._width = width || 300;
            this._height = height || 150;
            this._clearColor = [0, 0, 0, 0];
            this.canvas = null;
            this.drawingBufferWidth = this._width;
            this.drawingBufferHeight = this._height;
            // Copy constants to instance
            for (const k of Object.getOwnPropertyNames(WebGLRenderingContext)) {
                if (typeof WebGLRenderingContext[k] === 'number') this[k] = WebGLRenderingContext[k];
            }
        }

        // --- Real operations via Canvas2D backend ---
        clearColor(r, g, b, a) {
            this._clearColor = [Math.round(r*255), Math.round(g*255), Math.round(b*255), a];
        }
        clear(mask) {
            if (mask & 0x4000 && this._canvasId !== undefined) { // COLOR_BUFFER_BIT
                const [r, g, b, a] = this._clearColor;
                const color = `rgba(${r},${g},${b},${a})`;
                ops.op_canvas_set_fill_style(this._canvasId, color);
                ops.op_canvas_fill_rect(this._canvasId, 0, 0, this._width, this._height);
            }
        }
        readPixels(x, y, w, h, format, type, pixels) {
            if (this._canvasId === undefined || !pixels) return;
            // Canvas2D stores pixels top-down, WebGL is bottom-up — flip Y
            const flippedY = this._height - y - h;
            const data = ops.op_canvas_get_image_data(this._canvasId, x, Math.max(0, flippedY), w, h);
            for (let i = 0; i < data.length && i < pixels.length; i++) {
                pixels[i] = data[i];
            }
        }
        viewport(x, y, w, h) {
            this._width = w || this._width;
            this._height = h || this._height;
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
        static _g() {
            if (WebGLRenderingContext._gpuCache) return WebGLRenderingContext._gpuCache;
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
            try {
                if (ops.op_has_stealth_profile()) {
                    const s = (k) => ops.op_get_profile_value(k);
                    unmaskedVendor = s("webgl_unmasked_vendor") || unmaskedVendor;
                    unmaskedRenderer = s("webgl_unmasked_renderer") || unmaskedRenderer;
                    version = s("webgl_version") || version;
                    shadingLang = s("webgl_shading_language_version") || shadingLang;
                    const extsJson = s("webgl_extensions");
                    if (extsJson) {
                        try { extensions = JSON.parse(extsJson); } catch {}
                    }
                    const paramsJson = s("webgl_params");
                    if (paramsJson) {
                        try {
                            const arr = JSON.parse(paramsJson);
                            // Array of [glenum, value] pairs → keyed object
                            for (const [k, v] of arr) params[k] = v;
                        } catch {}
                    }
                    const spJson = s("webgl_shader_precision");
                    if (spJson) {
                        try {
                            // Array of [shader_type, precision_type, [min, max, precision]]
                            const arr = JSON.parse(spJson);
                            for (const [st, pt, v] of arr) {
                                shaderPrec[`${st}:${pt}`] = { rangeMin: v[0], rangeMax: v[1], precision: v[2] };
                            }
                        } catch {}
                    }
                }
            } catch {}
            // Firefox WebGL coherence: Gecko reports "Mozilla" for VENDOR /
            // RENDERER and the UNMASKED_*_WEBGL strings, and a VERSION without
            // the "(OpenGL ES … Chromium)" suffix. Chrome's GL identity
            // ("WebKit" / "Google Inc." / "ANGLE (…)") under a Firefox UA is a
            // 100% tell, so override the whole GL identity for the FF profile.
            try {
                if (ops.op_has_stealth_profile() &&
                    /Firefox\//.test(ops.op_get_profile_value("user_agent") || "")) {
                    vendor = "Mozilla";
                    renderer = "Mozilla";
                    unmaskedVendor = "Mozilla";
                    unmaskedRenderer = "Mozilla";
                    version = "WebGL 2.0";
                    shadingLang = "WebGL GLSL ES 3.00";
                }
            } catch {}
            WebGLRenderingContext._gpuCache = {
                vendor, renderer, version, shadingLang,
                unmaskedVendor, unmaskedRenderer,
                extensions, params, shaderPrec,
            };
            return WebGLRenderingContext._gpuCache;
        }
        // FIX-D2: the WebGL **1.0** surface. `_g()` above is the WebGL **2.0**
        // surface; a `getContext("webgl")` context must NOT report the WebGL 2
        // version string or expose WebGL-2-only extensions (e.g.
        // `EXT_color_buffer_float`) — that cross-API mismatch differs from
        // real Chrome. Derived from the active
        // profile's `webgl1_*` values; falls back to `_g()` when the profile has
        // no distinct WebGL 1 surface (legacy profiles) → no behaviour change.
        static _g1() {
            if (WebGLRenderingContext._gpuCache1) return WebGLRenderingContext._gpuCache1;
            const base = WebGLRenderingContext._g();
            // Start from the base surface, then downgrade the version strings to
            // WebGL 1 whenever base describes a WebGL 2 surface (the apple_m3
            // default + the no-profile fallback). Legacy profiles whose shared
            // field already holds WebGL 1 data (e.g. nvidia) or masked Firefox
            // keep their base strings. Extensions: an empty list defers to
            // getSupportedExtensions()'s own WebGL-1 fallback.
            let version = base.version;
            let shadingLang = base.shadingLang;
            let extensions = base.extensions;
            const _ffWebGL = (function () {
                try { return ops.op_has_stealth_profile() && /Firefox\//.test(ops.op_get_profile_value("user_agent") || ""); }
                catch { return false; }
            })();
            if (/^WebGL 2/.test(version)) {
                // Firefox WebGL 1 reports "WebGL 1.0" with no "(OpenGL ES … Chromium)" suffix.
                version = _ffWebGL ? "WebGL 1.0" : "WebGL 1.0 (OpenGL ES 2.0 Chromium)";
                shadingLang = _ffWebGL ? "WebGL GLSL ES 1.0" : "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)";
            }
            try {
                if (ops.op_has_stealth_profile()) {
                    const v = ops.op_get_profile_value("webgl1_version");
                    const sl = ops.op_get_profile_value("webgl1_shading_language_version");
                    const extJson = ops.op_get_profile_value("webgl1_extensions");
                    if (v) version = v;
                    if (sl) shadingLang = sl;
                    if (extJson) {
                        try { const e = JSON.parse(extJson); if (e && e.length) extensions = e; } catch {}
                    }
                }
            } catch {}
            WebGLRenderingContext._gpuCache1 = { ...base, version, shadingLang, extensions };
            return WebGLRenderingContext._gpuCache1;
        }
        // Per-instance surface selector. `_isWebGL2 === false` only for a
        // context handed back by `getContext("webgl"/"experimental-webgl")`.
        // Anything else (incl. `getParameter.call(notACtx)`) → WebGL 2 surface,
        // preserving the pre-FIX-D2 default.
        static _surfaceFor(ctx) {
            return (ctx && ctx._isWebGL2 === false)
                ? WebGLRenderingContext._g1()
                : WebGLRenderingContext._g();
        }
        getParameter(pname) {
            const gpu = WebGLRenderingContext._surfaceFor(this);
            // String-valued parameters
            if (pname === 0x1F00) return gpu.vendor;                // VENDOR
            if (pname === 0x1F01) return gpu.renderer;              // RENDERER
            if (pname === 0x1F02) return gpu.version;               // VERSION
            if (pname === 0x8B8C) return gpu.shadingLang;           // SHADING_LANGUAGE_VERSION
            if (pname === 0x9245) return gpu.unmaskedVendor;        // UNMASKED_VENDOR_WEBGL
            if (pname === 0x9246) return gpu.unmaskedRenderer;      // UNMASKED_RENDERER_WEBGL
            // Runtime-dependent values (not from the catalog)
            if (pname === 0x0BA2) return [0, 0, this._width, this._height]; // VIEWPORT
            // Catalog-sourced numeric/array parameters
            if (gpu.params[pname] !== undefined) return gpu.params[pname];
            return null;
        }
        getSupportedExtensions() {
            const gpu = WebGLRenderingContext._surfaceFor(this);
            // Fallback if the catalog is empty (no profile active).
            // Captured from real Chrome 147 on macOS arm64. WebGL 1 contexts get
            // the WebGL-1 list (extensions promoted to core in WebGL 2 reappear;
            // WebGL-2-only ones absent); WebGL 2 contexts get the 36-ext list.
            if (!gpu.extensions.length) {
                if (this && this._isWebGL2 === false) {
                    return [
                        "ANGLE_instanced_arrays","EXT_blend_minmax","EXT_clip_control",
                        "EXT_color_buffer_half_float","EXT_depth_clamp","EXT_disjoint_timer_query",
                        "EXT_float_blend","EXT_frag_depth","EXT_polygon_offset_clamp","EXT_sRGB",
                        "EXT_shader_texture_lod","EXT_texture_compression_bptc",
                        "EXT_texture_compression_rgtc","EXT_texture_filter_anisotropic",
                        "EXT_texture_mirror_clamp_to_edge","KHR_parallel_shader_compile",
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
            const gpu = WebGLRenderingContext._g();
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
    class WebGL2RenderingContext extends WebGLRenderingContext {}

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
            this._context = context || null;
            this._numberOfInputs = o.inputs === undefined ? 1 : o.inputs;
            this._numberOfOutputs = o.outputs === undefined ? 1 : o.outputs;
            this._channelCount = o.channelCount === undefined ? 2 : o.channelCount;
            this._channelCountMode = o.channelCountMode || "max";
            this._channelInterpretation = "speakers";
        }
        get context() { return this._context; }
        get numberOfInputs() { return this._numberOfInputs; }
        get numberOfOutputs() { return this._numberOfOutputs; }
        get channelCount() { return this._channelCount; }
        set channelCount(v) { this._channelCount = v | 0; }
        get channelCountMode() { return this._channelCountMode; }
        set channelCountMode(v) { this._channelCountMode = String(v); }
        get channelInterpretation() { return this._channelInterpretation; }
        set channelInterpretation(v) { this._channelInterpretation = String(v); }
        connect(dest) { return dest; }
        disconnect() {}
    }

    class AudioScheduledSourceNode extends AudioNode {
        constructor(context, opts) { super(context, opts); }
        start() {}
        stop() {}
    }

    class OscillatorNode extends AudioScheduledSourceNode {
        _type = "sine";
        constructor(context) {
            super(context, { inputs: 0, outputs: 1 });
            this.frequency = {
                _value: 440,
                get value() { return this._value; },
                set value(v) { this._value = v; if (context._setOscFreq) context._setOscFreq(v); }
            };
            this.detune = { value: 0 };
        }
        get type() { return this._type; }
        set type(v) { this._type = v; if (this._context._setOscType) this._context._setOscType(v); }
    }

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
        constructor(val, context, setter) {
            this._value = val;
            this._context = context;
            this._setter = setter;
        }
        get value() { return this._value; }
        set value(v) { this._value = v; if (this._setter) this._setter(v); }
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
            this.gain = new AudioParam(1, context);
        }
    }

    class DynamicsCompressorNode extends AudioNode {
        constructor(context) {
            super(context, { channelCount: 2, channelCountMode: "clamped-max" });
            this.threshold = new AudioParam(-24, context, v => { if (context._setCompThreshold) context._setCompThreshold(v); });
            this.knee = new AudioParam(30, context, v => { if (context._setCompKnee) context._setCompKnee(v); });
            this.ratio = new AudioParam(12, context, v => { if (context._setCompRatio) context._setCompRatio(v); });
            this.attack = new AudioParam(0.003, context, v => { if (context._setCompAttack) context._setCompAttack(v); });
            this.release = new AudioParam(0.25, context, v => { if (context._setCompRelease) context._setCompRelease(v); });
        }
        // Readonly float in dB, 0 until a render has happened — Chrome's shape.
        // It used to be missing entirely, and hCaptcha's audio probe reads
        // `node.reduction.value || node.reduction` (the legacy-AudioParam
        // compat form) from its `complete` handler, so the whole handler threw
        // `Cannot read properties of undefined (reading 'value')`.
        get reduction() {
            const c = this._context;
            return (c && typeof c._compReduction === "number") ? c._compReduction : 0;
        }
    }

    class BiquadFilterNode extends AudioNode {
        constructor(context) {
            super(context);
            this.type = "lowpass";
            this.frequency = new AudioParam(350, context);
            this.detune = new AudioParam(0, context);
            this.Q = new AudioParam(1, context);
            this.gain = new AudioParam(0);
        }
        getFrequencyResponse(freqArr, magOut, phaseOut) {
            if (!(freqArr instanceof Float32Array)) return;
            const _typeIds = {
                lowpass: 0, highpass: 1, bandpass: 2, lowshelf: 3,
                highshelf: 4, peaking: 5, notch: 6, allpass: 7,
            };
            const tid = _typeIds[this.type] ?? 0;
            const sr = (this._sampleRate || 44100);
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

    class AnalyserNode extends AudioNode {
        constructor(context) {
            super(context);
            this.fftSize = 2048;
            this.smoothingTimeConstant = 0.8;
            this.minDecibels = -100;
            this.maxDecibels = -30;
            this._timeDomain = null;
            this._prevFreq = null;
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
            if (!this._timeDomain || this._timeDomain.length < this.fftSize) {
                for (let i = 0; i < arr.length; i++) arr[i] = this.minDecibels;
                return;
            }
            const tdBytes = new Uint8Array(this._timeDomain.buffer, 0, this.fftSize * 4);
            const prevBytes = this._prevFreq
                ? new Uint8Array(this._prevFreq.buffer)
                : new Uint8Array(0);
            const out = ops.op_audio_analyser_freq_data(
                tdBytes, this.fftSize,
                Math.round(this.smoothingTimeConstant * 100),
                prevBytes
            );
            const result = new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);
            const len = Math.min(arr.length, result.length);
            for (let i = 0; i < len; i++) arr[i] = result[i];
            this._prevFreq = result.slice();
        }
        getByteTimeDomainData(arr) {
            if (!this._timeDomain) {
                for (let i = 0; i < arr.length; i++) arr[i] = 128;
                return;
            }
            const len = Math.min(arr.length, this._timeDomain.length);
            for (let i = 0; i < len; i++) {
                arr[i] = Math.max(0, Math.min(255, Math.round((this._timeDomain[i] + 1) * 127.5)));
            }
        }
        getFloatTimeDomainData(arr) {
            if (!this._timeDomain) {
                for (let i = 0; i < arr.length; i++) arr[i] = 0;
                return;
            }
            const len = Math.min(arr.length, this._timeDomain.length);
            for (let i = 0; i < len; i++) arr[i] = this._timeDomain[i];
        }
    }

    class AudioDestinationNode extends AudioNode {
        constructor() { super(); this.maxChannelCount = 2; }
    }

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
            this.sampleRate = _audioSampleRate;
            this.baseLatency = _audioBaseLatency;
            this.outputLatency = _audioOutputLatency;
            this.state = "running";
            this.currentTime = 0;
            this.destination = new AudioDestinationNode();
            this.listener = {}; // AudioListener stub
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
    globalThis.BaseAudioContext = BaseAudioContext;

    class AudioContext extends BaseAudioContext {
        constructor() {
            super();
        }
        close() { return Promise.resolve(); }
        suspend() { return Promise.resolve(); }
    }

    class OfflineAudioContext extends BaseAudioContext {
        constructor(channels, length, sampleRate) {
            super();
            this._channels = channels || 1;
            this._length = length || _audioSampleRate;
            this.sampleRate = sampleRate || _audioSampleRate;
            this._oscType = "triangle";
            this._oscFreq = 10000;
            this._compThreshold = -24;
            this._compKnee = 30;
            this._compRatio = 12;
            this._compAttack = 0.003;
            this._compRelease = 0.25;
        }
        _setOscType(v) { this._oscType = v; }
        _setOscFreq(v) { this._oscFreq = v; }
        _setCompThreshold(v) { this._compThreshold = v; }
        _setCompKnee(v) { this._compKnee = v; }
        _setCompRatio(v) { this._compRatio = v; }
        _setCompAttack(v) { this._compAttack = v; }
        _setCompRelease(v) { this._compRelease = v; }

        startRendering() {
            const self = this;
            return new Promise((resolve) => {
                const sr = self.sampleRate;
                const len = self._length;
                const freq = self._oscFreq;
                const type = self._oscType;
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
                        self._compThreshold, self._compKnee, self._compRatio,
                        self._compAttack, self._compRelease,
                    );
                    data = new Float32Array(bytes.buffer, bytes.byteOffset, len);
                    // One trailing f32: the compressor's metering gain in dB.
                    self._compReduction = new Float32Array(
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
                        length: len, sampleRate: sr, numberOfChannels: self._channels,
                    });
                    buf.copyToChannel(data, 0, 0);
                } catch (_) {
                    buf = {
                        numberOfChannels: self._channels,
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
                gl._isWebGL2 = isV2;
                gl.canvas = this;
                gl.drawingBufferWidth = this.width;
                gl.drawingBufferHeight = this.height;
                return gl;
            }
            return null;
        }
        toDataURL(type) { return ops.op_canvas_to_data_url(this.#canvasId); }
        toBlob(cb, type) { cb(new Blob([this.toDataURL()])); }
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
            if (!self._canvasId) {
                const w = parseInt(self.getAttribute && self.getAttribute("width")) || 300;
                const h = parseInt(self.getAttribute && self.getAttribute("height")) || 150;
                self._canvasId = ops.op_canvas_create(w, h, _getOsName(), _getCanvasSeed());
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
                        if (this._canvasId) {
                            const w = prop === "width" ? n : this.width;
                            const h = prop === "height" ? n : this.height;
                            ops.op_canvas_resize(this._canvasId, w | 0, h | 0);
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
            value: function getContext(type) {
                _requireCanvas(this, "getContext");
                _lazyInitCanvas(this);
                if (type === "2d") return _context2dFor(this, this._canvasId);
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
                        ? new WebGL2RenderingContext(this._canvasId, w, h)
                        : new WebGLRenderingContext(this._canvasId, w, h);
                    gl._isWebGL2 = isV2;
                    gl.canvas = this;
                    return gl;
                }
                return null;
            },
            writable: true,
            configurable: true,
            enumerable: false,
        });

        Object.defineProperty(_HTMLCanvasProto, "toDataURL", {
            value: function toDataURL(_type) {
                _requireCanvas(this, "toDataURL");
                // Auto-allocate a canvas if none yet — real Chrome
                // serializes any HTMLCanvasElement, even one whose 2D
                // context was never requested. The result is a fully
                // transparent PNG of the element's width × height.
                if (!this._canvasId) {
                    try { this.getContext("2d"); } catch (_e) {}
                }
                if (!this._canvasId) return "data:,";
                return ops.op_canvas_to_data_url(this._canvasId);
            },
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
                const url = this._canvasId ? ops.op_canvas_to_data_url(this._canvasId) : "data:,";
                queueMicrotask(() => {
                    try {
                        cb(new Blob([url], { type: type || "image/png" }));
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
            this._canvasId = 0;
            this._context = null;
        }
        getContext(type, _opts) {
            if (type === "2d") {
                if (!this._canvasId) {
                    this._canvasId = ops.op_canvas_create(this.width, this.height, _getOsName(), _getCanvasSeed());
                }
                if (!this._context) {
                    // The back-reference rides in the constructor: `canvas` is a
                    // getter on the prototype, so assigning it throws.
                    this._context = new CanvasRenderingContext2D(this._canvasId, this);
                }
                return this._context;
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
                if (!this._canvasId) {
                    this._canvasId = ops.op_canvas_create(this.width, this.height, _getOsName(), _getCanvasSeed());
                }
                const _k = (type === "webgl2") ? "_glctx2" : "_glctx1";
                if (!this[_k]) {
                    const isV2 = (type === "webgl2");
                    const gl = isV2
                        ? new WebGL2RenderingContext(this._canvasId, this.width, this.height)
                        : new WebGLRenderingContext(this._canvasId, this.width, this.height);
                    gl._isWebGL2 = isV2;
                    gl.canvas = this;
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
                _canvasId: self._canvasId,
                close() {},
            };
        }
        async convertToBlob(options) {
            const type = (options && options.type) || "image/png";
            if (!this._canvasId) {
                return new Blob([], { type });
            }
            // toDataURL returns `data:<type>;base64,<data>` — strip
            // the prefix and decode to bytes for a real Blob body.
            const url = ops.op_canvas_to_data_url(this._canvasId);
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
        // The standalone methods read `this._canvasId` (initialised lazily
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
