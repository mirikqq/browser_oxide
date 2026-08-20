// Opt-in user-input humanizer (default-on under `Page::navigate`).
//
// Dispatches a plausible pattern of `mousemove` / `scroll` / `click` /
// `keydown` events into the page during the first ~3 s of execution.
// Anti-bot sensors that gate on "zero user input in 2 s" (the various
// vendors' behavioural-analytics models) flip on
// the absence of these events; a from-scratch headless browser with no
// real input device must synthesize them.
//
// **Mouse motion model — sigma-lognormal**. Real human cursor motion
// follows an asymmetric velocity profile: fast acceleration, slow
// decay, with a long tail. The closed-form approximation we use here
// is the lognormal velocity curve from Plamondon's Kinematic Theory of
// Rapid Human Movements:
//
//   v(t) = (1 / (σ √(2π))) · (1/(t-t₀)) · exp(-(ln(t-t₀) - μ)² / (2σ²))
//
// We sample positions along the path at non-uniform intervals so the
// time-derivative of position approximates this curve. σ ∈ [0.20, 0.35]
// matches the inter-subject distribution observed in HCI literature
// (Plamondon 1995; Caramiaux et al. 2018). Compared to the previous
// uniform-time Bezier, this places more samples near peak velocity
// and fewer at the start/end — what real cursor traces show.
//
// **Multi-stroke decomposition**. A 1000 px arc isn't traversed in a
// single ballistic motion; humans break long paths into 2-3 strokes
// with brief micro-pauses between them (Fitts' Law iterations). We
// sample 1-3 intermediate "anchor" points and synthesize a separate
// sigma-lognormal segment to each.
//
// Sources for the timing model:
// - Plamondon (1995). "A kinematic theory of rapid human movements."
// - Caramiaux et al. (2018). "Beyond Recognition: Using Lower
//   Quantization to Reduce Tactile Sense Load."
//
// All events are dispatched on `document` and `body`, marked trusted via
// the privileged `_markTrusted` minter so handlers that gate
// on `isTrusted` see a trusted event — matching what real Chrome dispatches
// (a JS-constructed MouseEvent ordinarily reports `isTrusted=false`). Trust
// lives in a module-private WeakSet in event_bootstrap.js, NOT a per-event
// own property, so it is both correctly-shaped and unforgeable by page JS.
(function humanize() {
    const body = document.body || document.documentElement;
    if (!body) return;

    // Capture the privileged trusted-event minter published by
    // event_bootstrap.js and revoke the global handle immediately, so page
    // scripts (which run after this init script) can never reach it. We mark
    // our synthesized input events trusted via this closure-held function
    // instead of the old `Object.defineProperty(ev,'isTrusted',{value:true})`
    // — which created a detectable OWN data property AND was overridable.
    const _markTrusted = (typeof globalThis.__bo_mark_trusted === 'function')
        ? globalThis.__bo_mark_trusted
        : null;
    try { delete globalThis.__bo_mark_trusted; } catch (_) {}

    // Same discipline for the behaviour-generator bridge: capture, then revoke.
    // Without it `Deno.core.ops` is already gone by the time this script runs and
    // every path degenerates to linear interpolation.
    const _bo = globalThis.__bo_input_api || null;
    try { delete globalThis.__bo_input_api; } catch (_) {}

    // v0.1.0-parity Fix 6 — seeded random for two-level per-session
    // determinism. Symbol-keyed slot is installed by stealth_bootstrap.js
    // and survives cleanup_bootstrap's `internals` string purge. Without
    // a backing op (e.g. test paths that don't run a full runtime) we
    // fall back to the V8 default so the page still renders.
    const _rand = ((function(){try{var s=Object.getOwnPropertySymbols(globalThis);for(var i=0;i<s.length;i++){var v=globalThis[s[i]];if(v&&v.__bo)return v;}}catch(e){}return {};})().rand)
        || Math.random;

    // Use the engine-internal background-timer helper so our synthetic
    // mouse/scroll/key timers don't pin `run_until_idle` open. They fire
    // eventually when the event loop is alive (anti-bot pages keep it
    // alive with their challenge VMs so all events still fire); for
    // benign pages where they would otherwise be ~2 s of idle waiting,
    // the engine can return to the caller as soon as the page's own
    // work settles. Falls back to plain `setTimeout` if the helper isn't
    // installed (test-only paths that bypass timer_bootstrap.js).
    // Resolved off the engine namespace: the cleanup pass moves the helper
    // there and deletes the global, so reading `globalThis.__bgSetTimeout`
    // always missed and every schedule fell back to plain `setTimeout` — which
    // pins `run_until_idle` open, exactly what the background timer exists to
    // avoid.
    const _sched = (function () {
        try {
            const syms = Object.getOwnPropertySymbols(globalThis);
            for (let i = 0; i < syms.length; i++) {
                const v = globalThis[syms[i]];
                if (v && v.__bo && v.host && typeof v.host.__bgSetTimeout === 'function') {
                    return v.host.__bgSetTimeout;
                }
            }
        } catch (_e) { /* ignore */ }
        return globalThis.__bgSetTimeout || globalThis.setTimeout;
    })();

    // ---- Behavioural tap for the sensor payload ---------
    // Each event we synthesise also gets recorded into a per-page
    // buffer that an embedder's sensor-payload assembler can consume.
    // The buffer lives on globalThis so the Rust HTTP client can drain it via
    // `page.evaluate("_boNs.input")` before scheduling
    // the sensor-payload POST.
    // Internal namespace, keyed by a symbol so it stays out of
    // `Object.getOwnPropertyNames(window)` — see dom_bootstrap.js.
    const _boNs = (function(){try{var s=Object.getOwnPropertySymbols(globalThis);for(var i=0;i<s.length;i++){var v=globalThis[s[i]];if(v&&v.__bo)return v;}}catch(e){}return null;})() || {};
    if (!_boNs.input) {
        try {
            Object.defineProperty(_boNs, 'input', {
                value: { mouse: [], key: [], touch: [], scroll: [], _lastPos: null, counters: { key: 0, mouse: 0, touch: 0, scroll: 0, accel: 0 } },
                writable: true, configurable: true, enumerable: false,
            });
        } catch (_) { _boNs.input = { mouse: [], key: [], touch: [], scroll: [], _lastPos: null, counters: { key: 0, mouse: 0, touch: 0, scroll: 0, accel: 0 } }; }
    }
    const _akEvents = _boNs.input;
    const _akT0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    function _akT() {
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        return Math.round(now - _akT0);
    }
    function _akRecMouse(x, y, kind, button) {
        if (_akEvents.mouse.length < 200) {
            _akEvents.mouse.push({ x: x|0, y: y|0, t: _akT(), kind: kind|0, button: button|0 });
        }
        _akEvents.counters.mouse++;
    }
    function _akRecKey(code, kind) {
        if (_akEvents.key.length < 200) {
            _akEvents.key.push({ code: String(code), t: _akT(), kind: kind|0 });
        }
        _akEvents.counters.key++;
    }
    function _akRecScroll(dy) {
        if (_akEvents.scroll.length < 100) {
            _akEvents.scroll.push({ dy: dy|0, t: _akT() });
        }
        _akEvents.counters.scroll++;
    }

    // ---- Helpers --------------------------------------------------

    function _dispatch(target, event) {
        if (_markTrusted) _markTrusted(event);
        target.dispatchEvent(event);
    }

    // A phantom typing burst used to fire on the first focus of any input:
    // two synthesized keystrokes, dispatched at the field itself. The page saw
    // `keydown`/`keyup` for characters nobody pressed, on the very field the
    // user was about to fill in — a form validating per keystroke acted on
    // input that did not exist. Humanize now types only when asked to.

    // Box-Muller pair → standard normal sample. Used to draw lognormal
    // velocity-curve quantiles.
    function _gauss() {
        let u = 0, v = 0;
        while (u === 0) u = _rand();
        while (v === 0) v = _rand();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    // Linear interpolate between two 2D points.
    function _lerp(a, b, t) {
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }

    // Sigma-lognormal sample-time generator. Returns N normalized
    // sample times in [0, 1] whose density follows the lognormal
    // velocity peak — denser near the modal time (~0.35), sparser at
    // the tails. Parameters match Plamondon's μ ≈ -0.4, σ ≈ 0.25
    // baseline for casual cursor motion.
    function _sigmaLognormalTimes(n, sigma) {
        sigma = sigma || (0.22 + _rand() * 0.10);
        const mu = -0.4;
        const out = [];
        for (let i = 0; i < n; i++) {
            // Quantile: q ∈ (0,1), map to lognormal sample time τ.
            const q = (i + 0.5) / n;
            const z = _normalQuantile(q);
            const tau = Math.exp(mu + sigma * z);
            out.push(tau);
        }
        // Normalize to [0,1] — divide by max so the longest sample
        // sits exactly at the end of the stroke.
        const maxTau = Math.max(...out);
        return out.map(x => x / maxTau);
    }

    // Beasley-Springer-Moro inverse-normal-CDF approximation, accurate
    // to ~10⁻⁷ — used to map uniform quantiles to lognormal sample
    // times without needing erfinv. Adequate for our cursor-timing
    // domain.
    function _normalQuantile(p) {
        if (p <= 0) return -8;
        if (p >= 1) return 8;
        const a = [-3.969683028665376e+01,  2.209460984245205e+02,
                   -2.759285104469687e+02,  1.383577518672690e+02,
                   -3.066479806614716e+01,  2.506628277459239e+00];
        const b = [-5.447609879822406e+01,  1.615858368580409e+02,
                   -1.556989798598866e+02,  6.680131188771972e+01,
                   -1.328068155288572e+01];
        const c = [-7.784894002430293e-03, -3.223964580411365e-01,
                   -2.400758277161838e+00, -2.549732539343734e+00,
                    4.374664141464968e+00,  2.938163982698783e+00];
        const d = [ 7.784695709041462e-03,  3.224671290700398e-01,
                    2.445134137142996e+00,  3.754408661907416e+00];
        const plow = 0.02425, phigh = 1 - plow;
        let q, r;
        if (p < plow) {
            q = Math.sqrt(-2 * Math.log(p));
            return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
                   ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
        } else if (p <= phigh) {
            q = p - 0.5;
            r = q*q;
            return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
                   (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
        } else {
            q = Math.sqrt(-2 * Math.log(1 - p));
            return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
                    ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
        }
    }

    // Fire a `mousemove` + `pointermove` pair at a given client coordinate.
    // Dispatched on window + document + body — some vendor sensors listen at
    // `window` and harvest events from both event types into their coord
    // list. Real Chrome
    // dispatches mousemove and pointermove together for the same physical
    // motion. Firing only `mousemove` left half of the vendor's coord buffer
    // empty, contributing to the silent-path penalty.
    // The element under the pointer, which is where a real move is delivered.
    //
    // Each move used to be dispatched three times — once at `window`, once at
    // `document`, once at `body` — reusing the same event object. A listener on
    // any of the three saw the same move arrive repeatedly, `event.target` was
    // whatever had been dispatched at rather than what the pointer was over, and
    // re-dispatching an event that has already been dispatched is something no
    // browser does. One dispatch at the hit-tested target, then ordinary
    // bubbling, is what actually happens.
    const _hitTarget = (cx, cy) => {
        try {
            const el = document.elementFromPoint(cx, cy);
            if (el) return el;
        } catch (_e) { /* ignore */ }
        return document.body || document.documentElement || document;
    };

    // Screen coordinates come from the profile's own window geometry.
    //
    // These were `clientY + 90`: a hardcoded browser-chrome height that held
    // for exactly one window shape. Every other profile — a different OS, a
    // maximised window, a mobile preset with no chrome at all — reported a
    // screenY that disagreed with its own `outerHeight - innerHeight`, and the
    // pair is trivial for a sensor to cross-check.
    const _chromeH = () => {
        const outer = window.outerHeight || window.innerHeight || 0;
        const inner = window.innerHeight || 0;
        const d = outer - inner;
        return d > 0 ? d : 0;
    };
    // Where this realm's viewport sits inside the top-level one. The embedder
    // measures the frame and writes it here; the top realm has no frame and
    // sits at the origin.
    const _frameOrigin = () => {
        try {
            const f = _boNs && _boNs.frame;
            if (f) return [f.x || 0, f.y || 0];
        } catch (_e) { /* ignore */ }
        return [0, 0];
    };
    const _screenXOf = (cx) => Math.round((window.screenX || 0) + _frameOrigin()[0] + cx);
    const _screenYOf = (cy) =>
        Math.round((window.screenY || 0) + _chromeH() + _frameOrigin()[1] + cy);

    // ---- Click geometry -------------------------------------------------
    //
    // The point a click lands on used to be picked from the raw
    // `getBoundingClientRect`, with no check that the spot was on screen or
    // that the element was the thing actually on top there — and if the call
    // threw, the click went to (0, 0) anyway. A press on a scrolled-away, fully
    // covered or zero-sized element therefore produced a plausible-looking
    // event sequence aimed at nothing.

    const _viewport = () => [window.innerWidth || 0, window.innerHeight || 0];

    /// The on-screen part of an element's box, or null when there is none.
    const _visibleRect = (el) => {
        let r;
        try { r = el.getBoundingClientRect(); } catch (_e) { return null; }
        if (!r || !isFinite(r.left) || !isFinite(r.top)) return null;
        if (r.width <= 0 || r.height <= 0) return null;
        const [vw, vh] = _viewport();
        const left = Math.max(0, r.left);
        const top = Math.max(0, r.top);
        const right = Math.min(vw, r.right);
        const bottom = Math.min(vh, r.bottom);
        if (right - left <= 0 || bottom - top <= 0) return null;
        return { left, top, width: right - left, height: bottom - top };
    };

    const _isHidden = (el) => {
        try {
            const st = getComputedStyle(el);
            if (!st) return false;
            if (st.display === 'none') return true;
            if (st.visibility === 'hidden' || st.visibility === 'collapse') return true;
            const op = parseFloat(st.opacity);
            if (isFinite(op) && op === 0) return true;
        } catch (_e) { /* ignore */ }
        return false;
    };

    /// Whether the point actually lands on the element — itself or a descendant,
    /// which is what a real press on a button's inner label does.
    const _hitOk = (el, x, y) => {
        let t;
        try { t = document.elementFromPoint(x, y); } catch (_e) { return true; }
        if (!t) return false;
        return t === el || (typeof el.contains === 'function' && el.contains(t));
    };

    /// A point inside the visible box that the element actually receives.
    const _pickPoint = (el) => {
        const r = _visibleRect(el);
        if (!r) return null;
        const [vw, vh] = _viewport();
        const cands = [
            // Off-centre first: people do not land on the exact centroid.
            [r.left + r.width * (0.35 + _rand() * 0.3), r.top + r.height * (0.35 + _rand() * 0.3)],
            [r.left + r.width * 0.5, r.top + r.height * 0.5],
            [r.left + r.width * 0.25, r.top + r.height * 0.5],
            [r.left + r.width * 0.75, r.top + r.height * 0.5],
            [r.left + r.width * 0.5, r.top + r.height * 0.25],
            [r.left + r.width * 0.5, r.top + r.height * 0.75],
        ];
        for (const c of cands) {
            const x = Math.round(c[0]);
            const y = Math.round(c[1]);
            if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
            if (_hitOk(el, x, y)) return [x, y, Math.max(4, r.width)];
        }
        return null;
    };

    /// Scroll the element into view the way a person does — in steps, through
    /// the same wheel/scroll pair the page would see from a real wheel.
    const _bringIntoView = async (el) => {
        let r;
        try { r = el.getBoundingClientRect(); } catch (_e) { return; }
        const [, vh] = _viewport();
        if (!vh || (r.bottom > 0 && r.top < vh)) return;
        let remaining = Math.round(r.top - vh * 0.4);
        const dir = remaining > 0 ? 1 : -1;
        let guard = 0;
        while (Math.abs(remaining) > 4 && guard++ < 60) {
            const step = dir * Math.min(Math.abs(remaining), 90 + Math.round(_rand() * 70));
            try { _fireScrollStep(step); } catch (_e) { break; }
            remaining -= step;
            await _sleep(16 + _rand() * 40);
        }
    };

    function _fireMove(x, y, prev) {
        const cx = Math.round(x), cy = Math.round(y);
        const mx = prev ? Math.round(x - prev[0]) : 0;
        const my = prev ? Math.round(y - prev[1]) : 0;
        const mouseEv = new MouseEvent('mousemove', {
            bubbles: true, cancelable: true, view: window,
            clientX: cx, clientY: cy,
            screenX: _screenXOf(cx), screenY: _screenYOf(cy),
            movementX: mx, movementY: my,
            button: 0, buttons: 0,
        });
        _dispatch(_hitTarget(cx, cy), mouseEv);
        // PointerEvent paired emission. Pointer events were added in Chrome
        // 55 and are the modern primary pointer input event; modern sensors
        // and newer fingerprinters listen here in addition to legacy mousemove.
        try {
            const PE = (typeof PointerEvent === 'function') ? PointerEvent : null;
            if (PE) {
                const pEv = new PE('pointermove', {
                    bubbles: true, cancelable: true, view: window,
                    clientX: cx, clientY: cy,
                    screenX: _screenXOf(cx), screenY: _screenYOf(cy),
                    movementX: mx, movementY: my,
                    button: -1, buttons: 0,
                    pointerType: 'mouse', pointerId: 1,
                    isPrimary: true, pressure: 0,
                    width: 1, height: 1,
                });
                _dispatch(_hitTarget(cx, cy), pEv);
            }
        } catch (_) {}
        _akRecMouse(x, y, 0, 0); // 0 = move, button 0 = left
    }

    // Fire a `wheel` + `scroll` pair simulating a scroll-down step.
    function _fireScrollStep(deltaY) {
        try {
            const wheel = new WheelEvent('wheel', {
                bubbles: true, cancelable: true, view: window,
                deltaY, deltaMode: 0,
            });
            _dispatch(document, wheel);
            // Drive a real scroll on the documentElement so subsequent
            // pageYOffset reads reflect the motion.
            window.scrollBy({ top: deltaY, behavior: 'instant' });
            _dispatch(document, new Event('scroll', { bubbles: true }));
            _dispatch(window, new Event('scroll', { bubbles: false }));
            _akRecScroll(deltaY);
        } catch (e) {}
    }

    // ---- Execution -----------------------------------------------

    function runCycle() {
        // 1) Focus + visibility
        try { _dispatch(window, new Event('focus', { bubbles: false })); } catch (e) {}
        try { _dispatch(document, new Event('visibilitychange', { bubbles: true })); } catch (e) {}

        // 2) Mouse motion — route through the Rust Σ-Λ generator.
        //    The previous linear `_lerp` interpolation produced
        //    path-efficiency ≈ 1.0 + white tremor + an impulse-velocity
        //    discontinuity at each anchor — the #1 mouse tell that
        //    behavioural classifiers catch (~98%). `op_behavior_
        //    mouse_trajectory` (crates/stealth/src/behavior.rs, Plamondon
        //    Kinematic Theory: curved 2-7 strokes, pink tremor, smoothstep
        //    terminal decel, ~8 ms cadence) is the SAME generator the
        //    historical-seed path already uses — the live cycle just wasn't
        //    calling it. Sampling at 8 ms over multi-second motion also pushes
        //    the per-cycle mousemove count from ~30 to ~100-250.
        const _vw = (window.innerWidth || 1920);
        const _vh = (window.innerHeight || 1080);
        const _ops = (typeof Deno !== 'undefined' && Deno.core && Deno.core.ops) || null;
        // Persistent cursor position across cycles (seeded by the historical
        // path at __bo_input_events._lastPos; falls back to viewport centre).
        let _from = (_boNs.input
            && Array.isArray(_boNs.input._lastPos)
            && _boNs.input._lastPos.length === 2)
            ? _boNs.input._lastPos.slice()
            : [_vw * 0.5, _vh * 0.45];
        // Ambient motion aims at real interactive elements, not random coordinates.
        // Wandering to arbitrary viewport points is not what a person does — they move
        // between things worth pointing at — and it also dragged the cursor away from
        // wherever a targeted action had just left it.
        const _ambientTargets = (function () {
            var out = [];
            try {
                var els = document.querySelectorAll(
                    'a[href],button,input,select,textarea,[role=button],[role=link]');
                for (var i = 0; i < els.length; i++) {
                    var r = els[i].getBoundingClientRect();
                    if (r.width < 8 || r.height < 8) continue;
                    if (r.bottom < 0 || r.top > _vh || r.right < 0 || r.left > _vw) continue;
                    out.push([r.left + r.width * (0.3 + _rand() * 0.4),
                              r.top + r.height * (0.3 + _rand() * 0.4)]);
                }
            } catch (_) {}
            return out;
        })();
        // Nothing worth pointing at: stay put rather than invent motion.
        if (!_ambientTargets.length) return;
        const _nAnchors = 1;
        let mouseT = 40 + _rand() * 40;
        let prev = null;
        for (let s = 0; s < _nAnchors; s++) {
            const _pick = _ambientTargets[(_rand() * _ambientTargets.length) | 0];
            const toX = _pick[0];
            const toY = _pick[1];
            const targetW = 28 + _rand() * 48;
            let traj = [];
            try {
                if (_bo) {
                    traj = _bo.trajectory(_from[0], _from[1], toX, toY, targetW);
                }
            } catch (_) {}
            if (!Array.isArray(traj) || traj.length === 0) {
                // Degenerate fallback so live motion is never empty.
                traj = [];
                const n = 10;
                for (let i = 0; i < n; i++) {
                    const u = i / (n - 1);
                    traj.push({ t_ms: u * 700, x: _from[0] + (toX - _from[0]) * u, y: _from[1] + (toY - _from[1]) * u });
                }
            }
            const base = mouseT;
            for (let i = 0; i < traj.length; i++) {
                const p = traj[i];
                const px = p.x, py = p.y;
                const at = base + Math.round(p.t_ms || 0);
                const prevSnapshot = prev ? prev.slice() : null;
                _sched(() => _fireMove(px, py, prevSnapshot), at);
                prev = [px, py];
            }
            const total = traj.length > 0 ? (traj[traj.length - 1].t_ms || 700) : 700;
            mouseT = base + Math.round(total) + (50 + _rand() * 120); // inter-target pause
            _from = [toX, toY];
        }
        // Persist final cursor position for the next cycle's starting point.
        if (_boNs.input) _boNs.input._lastPos = _from.slice();

        // 3) Scroll-down
        const scStartT = mouseT + 100;
        const steps = [80 + _rand() * 40, 60 + _rand() * 30];
        let curScT = scStartT;
        for (const step of steps) {
            _sched(() => _fireScrollStep(step), curScT);
            curScT += 100 + _rand() * 100;
        }
    }

    // ---- Synchronous pre-population --------------------------
    //
    // Some vendor scripts score a multi-feature mouse-path vector at
    // POST time. If __bo_input_events.mouse is empty (or has only 1-2
    // points from setTimeouts that fired before POST), the vendor's
    // empty-coord-list heuristic flags us. Solution: synthesize a
    // small history of "user moved mouse just before navigating here"
    // events SYNCHRONOUSLY, so the buffer is non-empty from the very
    // first instant any antibot script can read it.
    //
    // We add ~10 historical points spanning the 200ms-2000ms window
    // BEFORE current time (negative t values, modeling a real user
    // who was moving cursor before the page loaded).
    // `crates/stealth/src/behavior.rs` already produces
    // sigma-lognormal trajectories; we mirror its statistics here.
    //
    // These also get dispatched as actual mousemove events on
    // window+document+body so live event listeners (the vendor's
    // sensor script) see them when they attach.
    (function _seedHistoricalCoords() {
        const vw = (window.innerWidth || 1920);
        const vh = (window.innerHeight || 1080);
        const fromX = vw * 0.5 + (_rand() - 0.5) * 80;
        const fromY = vh * 0.4 + (_rand() - 0.5) * 80;
        const toX = vw * 0.45 + (_rand() - 0.5) * 200;
        const toY = vh * 0.55 + (_rand() - 0.5) * 200;
        const targetW = 40 + _rand() * 40;
        let traj = [];
        try {
            const ops = Deno && Deno.core && Deno.core.ops;
            if (ops && typeof ops.op_behavior_mouse_trajectory === 'function') {
                const raw = ops.op_behavior_mouse_trajectory(fromX, fromY, toX, toY, targetW);
                traj = JSON.parse(raw || '[]');
            }
        } catch (_) {}
        if (!Array.isArray(traj) || traj.length === 0) {
            traj = [];
            const n = 12;
            for (let i = 0; i < n; i++) {
                const u = i / (n - 1);
                traj.push({
                    t_ms: u * 1000,
                    x: fromX + (toX - fromX) * u,
                    y: fromY + (toY - fromY) * u,
                });
            }
        }
        const maxT = traj.length > 0 ? traj[traj.length - 1].t_ms : 1;
        const stride = Math.max(1, Math.ceil(traj.length / 14));
        let lastX = fromX | 0, lastY = fromY | 0;
        for (let i = 0; i < traj.length; i += stride) {
            const p = traj[i];
            const u = p.t_ms / Math.max(1, maxT);
            const dt = -1800 + u * 1700;
            const x = Math.max(0, Math.min(vw, p.x)) | 0;
            const y = Math.max(0, Math.min(vh, p.y)) | 0;
            if (_akEvents.mouse.length < 200) {
                _akEvents.mouse.push({ x, y, t: Math.round(dt), kind: 0, button: 0 });
            }
            _akEvents.counters.mouse++;
            lastX = x; lastY = y;
        }
        try {
            const evOpts = {
                bubbles: true, cancelable: true, view: window,
                clientX: lastX, clientY: lastY,
                screenX: lastX, screenY: lastY + 90,
                movementX: 1, movementY: 0,
                button: 0, buttons: 0,
            };
            const mev = new MouseEvent('mousemove', evOpts);
            if (_markTrusted) _markTrusted(mev);
            try { window.dispatchEvent(mev); } catch (_) {}
            try { document.dispatchEvent(mev); } catch (_) {}
            try { body.dispatchEvent(mev); } catch (_) {}
            const PE = (typeof PointerEvent === 'function') ? PointerEvent : null;
            if (PE) {
                const pev = new PE('pointermove', {
                    ...evOpts,
                    button: -1,
                    pointerType: 'mouse', pointerId: 1,
                    isPrimary: true, pressure: 0, width: 1, height: 1,
                });
                if (_markTrusted) _markTrusted(pev);
                try { window.dispatchEvent(pev); } catch (_) {}
                try { document.dispatchEvent(pev); } catch (_) {}
                try { body.dispatchEvent(pev); } catch (_) {}
            }
        } catch (_) {}
        try { _boNs.input._lastPos = [lastX, lastY]; } catch (_) {}
    })();

    // ---- Human-shaped targeted input -------------------------------------
    // `element.click()` and a burst of hand-built MouseEvents both announce
    // automation, for different reasons: the first reports `isTrusted === false`,
    // the second arrives with zero travel and zero dwell — mousedown and mouseup in
    // the same millisecond, no motion leading to the element. Behavioural sensors
    // (Epic's Talon posts `/v1/phaser/batch` continuously) score exactly that.
    //
    // So a targeted click reuses the same Σ-Λ trajectory generator `runCycle` uses:
    // travel to the element along a curved multi-stroke path sampled at ~8 ms, hover,
    // press, hold for a human dwell, release. Everything is minted trusted and
    // recorded into the telemetry buffer, and the cursor position persists so the
    // next action starts where this one ended.
    const _sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.round(ms))));
    // `runCycle` grabs its own handle inside the function body; targeted input needs
    // one at module scope for the same generator.
    const _ops = (typeof Deno !== 'undefined' && Deno.core && Deno.core.ops) || null;

    function _trajectory(fromX, fromY, toX, toY, targetW) {
        try {
            if (_bo) {
                const t = _bo.trajectory(fromX, fromY, toX, toY, targetW || 30);
                if (Array.isArray(t) && t.length) return t;
            }
        } catch (_) {}
        // Never fall back to a straight line: path efficiency of exactly 1.0 is
        // itself a classifier signal. Bow the segment and jitter the samples.
        const out = [];
        const n = 24;
        const bow = (_rand() - 0.5) * Math.hypot(toX - fromX, toY - fromY) * 0.15;
        for (let i = 0; i < n; i++) {
            const u = i / (n - 1);
            const arc = Math.sin(u * Math.PI) * bow;
            out.push({
                t_ms: u * (260 + _rand() * 220),
                x: fromX + (toX - fromX) * u - (toY - fromY) * 0.001 * arc,
                y: fromY + (toY - fromY) * u + (toX - fromX) * 0.001 * arc,
            });
        }
        return out;
    }

    /// Travel the cursor to (x, y), dispatching moves on the real clock.
    async function _travelTo(x, y, targetW) {
        let from = (_boNs.input
            && Array.isArray(_boNs.input._lastPos))
            ? _boNs.input._lastPos.slice()
            : [(window.innerWidth || 1280) * 0.5, (window.innerHeight || 800) * 0.45];
        const traj = _trajectory(from[0], from[1], x, y, targetW);
        let prev = from.slice();
        let prevT = 0;
        for (const p of traj) {
            await _sleep((p.t_ms || 0) - prevT);
            prevT = p.t_ms || 0;
            try { _fireMove(p.x, p.y, prev); } catch (_) {}
            try { _akRecMouse(Math.round(p.x), Math.round(p.y), 'move', 0); } catch (_) {}
            prev = [p.x, p.y];
        }
        try { _boNs.input._lastPos = [x, y]; } catch (_) {}
    }

    /// Returns false when a listener cancelled the event, mirroring
    /// `dispatchEvent` — the caller needs that to decide whether the default
    /// action still runs.
    function _fireAt(el, Ctor, type, opts) {
        try {
            const ev = new Ctor(type, opts);
            if (_markTrusted) _markTrusted(ev);
            return el.dispatchEvent(ev);
        } catch (_) {
            return true;
        }
    }

    async function _humanClick(el) {
        if (!el) return 'нет элемента';
        if (_isHidden(el)) return 'элемент скрыт — клика не будет';

        let pick = _pickPoint(el);
        if (!pick) {
            // Out of view is not the same as unclickable: bring it in and retry
            // once, against the box the fresh layout produced.
            await _bringIntoView(el);
            pick = _pickPoint(el);
        }
        if (!pick) return 'нет видимой точки: элемент обрезан, нулевого размера или перекрыт';
        const [cx, cy, w] = pick;

        await _travelTo(cx, cy, w);
        // The press goes to whatever is on top at that point — which for a
        // button with an inner label is the label, exactly as in a browser.
        let target = el;
        try {
            const t = document.elementFromPoint(cx, cy);
            if (t && (t === el || (typeof el.contains === 'function' && el.contains(t)))) {
                target = t;
            }
        } catch (_e) { /* ignore */ }

        const base = {
            bubbles: true, cancelable: true, view: globalThis,
            clientX: cx, clientY: cy, screenX: _screenXOf(cx), screenY: _screenYOf(cy),
            button: 0, buttons: 1, detail: 1,
        };
        const PE = (typeof PointerEvent === 'function') ? PointerEvent : null;
        const pointer = { pointerType: 'mouse', pointerId: 1, isPrimary: true };

        if (PE) _fireAt(target, PE, 'pointerover', { ...base, buttons: 0, ...pointer, pressure: 0 });
        _fireAt(target, MouseEvent, 'mouseover', { ...base, buttons: 0 });
        _fireAt(target, MouseEvent, 'mousemove', { ...base, buttons: 0 });

        // Settle before pressing — real pointers rest briefly on the target.
        await _sleep(40 + _rand() * 90);

        if (PE) _fireAt(target, PE, 'pointerdown', { ...base, ...pointer, pressure: 0.5 });
        _fireAt(target, MouseEvent, 'mousedown', base);
        // Moving focus must take it away from wherever it was. Real browsers fire
        // blur/focusout on the outgoing element, and form libraries (react-hook-form
        // among them) commit the field value on that event — without it the form
        // validates an empty field right after you watched the text get typed in.
        try {
            var prev = document.activeElement;
            if (prev && prev !== el && prev !== document.body) {
                _fireAt(prev, FocusEvent, 'focusout', { bubbles: true, relatedTarget: el });
                _fireAt(prev, FocusEvent, 'blur', { bubbles: false, relatedTarget: el });
                if (typeof prev.blur === 'function') prev.blur();
            }
        } catch (_) {}
        try { if (typeof el.focus === 'function') el.focus(); } catch (_) {}
        try {
            _fireAt(el, FocusEvent, 'focus', { bubbles: false });
            _fireAt(el, FocusEvent, 'focusin', { bubbles: true });
        } catch (_) {}
        try { _akRecMouse(cx, cy, 'down', 0); } catch (_) {}

        // Press duration. Human mouse clicks cluster around 60-140 ms.
        await _sleep(60 + _rand() * 80);

        if (PE) _fireAt(target, PE, 'pointerup', { ...base, buttons: 0, ...pointer, pressure: 0 });
        _fireAt(target, MouseEvent, 'mouseup', { ...base, buttons: 0 });
        const notCancelled = _fireAt(target, MouseEvent, 'click', { ...base, cancelable: true, buttons: 0 });
        try { _akRecMouse(cx, cy, 'click', 0); } catch (_) {}
        // The click event alone is not a click: a real browser then runs the
        // target's activation behaviour, which is what submits a form. This path
        // never reaches `HTMLElement.prototype.click()`, so it has to ask.
        if (notCancelled && typeof _boNs.activate === 'function') {
            try { _boNs.activate(el); } catch (_) { /* ignore */ }
        }
        return 'клик ок (isTrusted, с траекторией)';
    }

    /// Type into a field key by key, on the clock, with per-character timings from
    /// the bigram-aware model. Setting `.value` in one shot leaves no keystroke
    /// telemetry at all, which is as loud as a bad mouse path.
    async function _humanType(el, text) {
        if (!el) return 'нет элемента';
        const str = String(text == null ? '' : text);
        await _humanClick(el);

        let delays = [];
        try {
            if (_bo) delays = _bo.typingDelays(str, 0) || [];
        } catch (_) {}

        const setValue = (v) => {
            // React attaches a `_valueTracker` to controlled inputs and compares against
            // it in onChange. Writing through the native setter updates the tracker too,
            // so React concludes nothing changed, drops the event and re-renders the
            // field from its own state — the text visibly disappears. Clearing the
            // tracker first is what makes React accept the value.
            try {
                if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
                    el._valueTracker.setValue('');
                }
            } catch (_) {}
            const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
            if (d && d.set) d.set.call(el, v); else el.value = v;
        };
        setValue('');
        for (let i = 0; i < str.length; i++) {
            const ch = str[i];
            await _sleep(delays[i] != null ? delays[i] : 60 + _rand() * 90);
            const opts = { bubbles: true, cancelable: true, key: ch, code: 'Key' + ch.toUpperCase() };
            _fireAt(el, KeyboardEvent, 'keydown', opts);
            setValue(str.slice(0, i + 1));
            _fireAt(el, InputEvent || Event, 'input', { bubbles: true, data: ch, inputType: 'insertText' });
            // Key dwell: the hold time of the key itself, inside the inter-key gap.
            await _sleep(25 + _rand() * 45);
            _fireAt(el, KeyboardEvent, 'keyup', opts);
            try { _akEvents.counters.key++; } catch (_) {}
        }
        _fireAt(el, Event, 'change', { bubbles: true });
        return 'введено ' + str.length + ' символов';
    }

    try {
        _akEvents.clickElement = _humanClick;
        _akEvents.clickSelector = (sel) => _humanClick(document.querySelector(sel));
        _akEvents.typeElement = _humanType;
        _akEvents.typeSelector = (sel, text) => _humanType(document.querySelector(sel), text);
        _akEvents.moveTo = (x, y) => _travelTo(x, y, 30);
        // The trusted-event minter, for drivers that build their own event
        // sequences. A drag cannot be expressed through `clickElement`, and an
        // untrusted `pointerdown` is worth little to a widget that checks
        // `isTrusted`. Safe to expose: the namespace is symbol-keyed and the
        // page cannot reach it, which is the same reason the global was revoked.
        if (_markTrusted) _akEvents.mark = (ev) => { try { _markTrusted(ev); } catch (_) {} };
    } catch (_) {}

    // Ambient motion is opt-in, and off by default.
    //
    // It used to start itself on load and repeat every ~7 s. Those timers ran
    // underneath whatever the driver was doing, so a targeted click could have
    // an ambient `mousemove` land between its own `mousedown` and `mouseup` —
    // and that stray move carries `buttons: 0` while a button is held, a state
    // no real pointer ever reports. Nothing moves now unless asked; a driver
    // that wants idle motion turns it on explicitly.
    let _ambientOn = false;
    let _ambientTimer = null;
    const _scheduleAmbient = () => {
        _ambientTimer = setTimeout(function () {
            _ambientTimer = null;
            if (!_ambientOn) return;
            runCycle();
            _scheduleAmbient();
        }, 5000 + _rand() * 4000);
    };
    try {
        _akEvents.setAmbient = function (on) {
            const next = !!on;
            if (next === _ambientOn) return;
            _ambientOn = next;
            if (next) {
                runCycle();
                _scheduleAmbient();
            } else if (_ambientTimer !== null) {
                clearTimeout(_ambientTimer);
                _ambientTimer = null;
            }
        };
    } catch (_) {}
})();
