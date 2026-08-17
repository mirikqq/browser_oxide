((globalThis) => {
    const ops = Deno.core.ops;
    const print = (msg) => {
        try { Deno.core.print(msg + "\n"); } catch {}
    };

    // --- Function.prototype.toString bypass patch ---
    // Some scripts call Function.prototype.toString.call(fn)
    // directly, which bypasses any instance-level fn.toString override and
    // returns the raw JS source of polyfilled functions. We patch
    // Function.prototype.toString itself to consult a private Symbol tag
    // we set on masked functions.
    // The engine's internal namespace: one anonymous symbol on the global, shared
    // by every bootstrap. Get-or-create, because the bootstraps run in a fixed
    // order and more than one of them needs it before `dom_bootstrap` does.
    //
    // Everything the engine keeps here used to be its own `Symbol.for(...)` slot
    // on `globalThis`. Chrome's window has no own symbols at all, so each one was
    // a visible difference — and three of them spelled the engine's name.
    const _boNsFind = () => {
        try {
            const syms = Object.getOwnPropertySymbols(globalThis);
            for (let i = 0; i < syms.length; i++) {
                const v = globalThis[syms[i]];
                if (v && v.__bo) return v;
            }
        } catch (_e) { /* ignore */ }
        return null;
    };
    const _boNsMake = () => {
        const found = _boNsFind();
        if (found) return found;
        const ns = { __bo: true };
        try {
            Object.defineProperty(globalThis, Symbol(""), {
                value: ns, writable: false, configurable: true, enumerable: false,
            });
        } catch (_e) { /* ignore */ }
        return ns;
    };

    const _boNs = _boNsMake();
    const _nativeTag = Symbol.for('__browser_oxide_native__');
    // Masked function → the name its `toString` should report.
    const _nativeNames = new WeakMap();
    const _origFnToStr = Function.prototype.toString;

    // Re-entrant guard: prevents infinite recursion when this[_nativeTag] access
    // triggers a Proxy get trap that itself calls Function.prototype.toString.
    let _inPatchedToStr = false;
    // Method-shorthand → NO [[Construct]] / no own `.prototype`, exactly
    // like the real native Function.prototype.toString. A plain
    // `function toString(){}` IS constructable, so
    // `class X extends Function.prototype.toString {}` did NOT throw in
    // our engine while real Chrome 147 throws `TypeError`; we match
    // Chrome here.
    const _patchedFnToStr = ({ toString() {
        if (_inPatchedToStr) return _origFnToStr.call(this);
        _inPatchedToStr = true;
        try {
            // Callable receiver, own tag. Both guards matter:
            //
            //  · `Object.create(maskedFn)` is a plain object that *inherits* the
            //    tag through its prototype chain. Answering it produced a native
            //    string where Chrome throws "Function.prototype.toString requires
            //    that 'this' be a Function" — which is exactly the probe
            //    fingerprinters use to find a patched `toString`, and it marked
            //    every masked accessor as a lie.
            //  · an *inherited* tag would likewise claim page code is native
            //    merely because its prototype is one of ours.
            if (typeof this === "function") {
                try {
                    const tag = _nativeNames.get(this);
                    if (tag) return `function ${tag}() { [native code] }`;
                } catch (_) {}
            }
            return _origFnToStr.call(this);
        } finally {
            _inPatchedToStr = false;
        }
    } }).toString;
    // Tag the patched toString itself so recursive calls also appear native
    _nativeNames.set(_patchedFnToStr, 'toString');
    try { ops.op_stealth_mark_native(_patchedFnToStr, 'toString'); } catch (_) {}
    Object.defineProperty(_patchedFnToStr, 'name', { value: 'toString', configurable: true });

    Object.defineProperty(Function.prototype, 'toString', {
        value: _patchedFnToStr,
        writable: true,
        configurable: true,
    });

    // --- Native code masking ---
    const _maskFunction = (fn, name) => {
        if (!fn) return fn;
        try {
            // Native fns have an own configurable `name` (Chrome-correct).
            Object.defineProperty(fn, 'name', { value: name, configurable: true });
            // The tag lives OFF the function: in a WeakMap for the JS
            // fallback below, and in a v8 private symbol for the genuine
            // `Function.prototype.toString` in `native_fns.rs`.
            //
            // It used to be an own symbol property, which meant
            // `Object.getOwnPropertySymbols(fetch)` returned
            // `Symbol(__browser_oxide_native__)` — this engine's name, on every
            // masked function, readable by any script. It also broke the shape
            // fingerprinters check against natives:
            // `Reflect.ownKeys(fn).sort().toString()` must be exactly
            // "length,name", and an extra symbol makes that call throw.
            _nativeNames.set(fn, name);
            try { ops.op_stealth_mark_native(fn, name); } catch (_) {}
            // NO own `toString`: it was a self-inflicted leak — an
            // earlier version gave every masked fn an own `toString`, so
            // `getOwnPropertyNames(fn)` included "toString" (Chrome:
            // ['length','name'(,'prototype')] only) and
            // `fn.toString !== Function.prototype.toString` (Chrome: ===,
            // inherited). The own toString was REDUNDANT: the patched
            // Function.prototype.toString already yields
            // `function <tag>() { [native code] }` via the tag, and
            // `fn.toString()` / `Function.prototype.toString.call(fn)`
            // both resolve up-chain to it. Removing it is cross-realm-
            // safe (tag mechanism unchanged) and restores Chrome parity
            // for getOwnPropertyNames / hasOwnProperty('toString') /
            // toString-identity on EVERY masked fn in the engine.
        } catch (e) {}
        // Return fn so callers can use `{ get: _maskFunction(getter, name) }`
        // without the getter silently becoming undefined (property returns undefined).
        return fn;
    };

    const _maskAsNative = (obj, ...names) => {
        for (const name of names) {
            try {
                // Find where the property actually lives (own or prototype)
                let target = obj;
                let desc = Object.getOwnPropertyDescriptor(target, name);
                while (!desc && target && target !== Object.prototype) {
                    target = Object.getPrototypeOf(target);
                    if (target) desc = Object.getOwnPropertyDescriptor(target, name);
                }

                if (desc) {
                    if (desc.get) _maskFunction(desc.get, `get ${name}`);
                    if (desc.set) _maskFunction(desc.set, `set ${name}`);
                    if (typeof desc.value === 'function') _maskFunction(desc.value, name);
                } else {
                    // Fallback for direct prototype access
                    const val = obj[name];
                    if (typeof val === 'function') _maskFunction(val, name);
                }
            } catch (e) {}
        }
    };

    // Expose helpers globally for other bootstraps
    Object.defineProperty(globalThis, '_nativeTag', { value: _nativeTag, enumerable: false, configurable: true });
    Object.defineProperty(globalThis, '_maskFunction', { value: _maskFunction, enumerable: false, configurable: true });
    Object.defineProperty(globalThis, '_maskAsNative', { value: _maskAsNative, enumerable: false, configurable: true });

    // Expose seeded random under a Symbol-keyed
    // slot that survives cleanup_bootstrap's string-keyed `internals`
    // purge. humanize.js (injected per-navigation, AFTER cleanup) reads
    // this via `globalThis[Symbol.for('#r')]`
    // and uses it instead of Math.random(), so synthetic mouse/scroll/
    // key event streams are deterministic per page lifetime (two-level
    // seed pattern). Falls back to undefined if the op is unavailable —
    // humanize.js degrades to Math.random().
    try {
        const _randOp = Deno && Deno.core && Deno.core.ops
            && Deno.core.ops.op_behavior_random;
        if (typeof _randOp === 'function') {
            _boNs.rand = function () {
                try { return _randOp(); } catch (_e) { return Math.random(); }
            };
        }
    } catch (_e) {}

    // Expose CMU+Buffalo keystroke-schedule
    // generator under a Symbol-keyed slot. humanize.js calls it on
    // input focus to synthesize plausible per-char timings (LogNormal
    // dwell + bigram-modulated flight). The Rust generator existed at
    // crates/stealth/src/behavior.rs but had no JS consumer; this is
    // the wiring.
    try {
        const _ksOp = Deno && Deno.core && Deno.core.ops
            && Deno.core.ops.op_human_keystroke_schedule;
        if (typeof _ksOp === 'function') {
            _boNs.keystrokes = function (text, wpm) {
                try { return _ksOp(text || '', (wpm | 0) || 0); }
                catch (_e) { return []; }
            };
        }
    } catch (_e) {}

    // `eval.toString().length === 33` for Chromium is a known invariant.
    // V8 natively produces "function eval() { [native code] }" (33 chars), so this
    // is usually a no-op. We tag `eval` defensively so any V8 build drift is
    // self-corrected to Chrome's canonical shape.
    try { _maskFunction(eval, 'eval'); } catch (_) {}

    // Native-mask every console method. console_bootstrap.js is
    // concatenated BEFORE this file in the V8 snapshot (snapshot.rs),
    // so it could not call _maskAsNative itself (undefined then) —
    // `globalThis.console` already exists here, and _maskAsNative is
    // now defined, so this is the correct place. Some scripts dump
    // `console.<method>.toString()` for all ~19 methods; without masking,
    // ours would leak `log(...args) { core.ops.op_console_log(...) }`,
    // which differs from real Chrome. Real Chrome returns
    // `function log() { [native code] }` for every console method.
    try {
        if (globalThis.console) {
            _maskAsNative(
                globalThis.console,
                'log', 'warn', 'error', 'info', 'debug', 'dir', 'dirxml',
                'trace', 'group', 'groupCollapsed', 'groupEnd', 'clear',
                'count', 'countReset', 'assert', 'table', 'time',
                'timeLog', 'timeEnd',
            );
        }
    } catch (_) {}

})(globalThis);
