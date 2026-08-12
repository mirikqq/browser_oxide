// Bridge from the humanized-input init script to the Rust behaviour generators.
//
// This file used to publish `globalThis.__browserOxide` — and was never loaded by
// runtime.rs, so it was dead code. The consequence was silent and expensive:
// `humanize.js` runs AFTER `cleanup_bootstrap.js` has removed `Deno`, so its
// `Deno.core.ops` handle was always null and every mouse path fell back to linear
// interpolation. Path efficiency of exactly 1.0 with white tremor is the single
// loudest mouse tell for behavioural classifiers — the very thing the humanize
// module exists to avoid.
//
// The handle is non-enumerable and `humanize.js` deletes it as soon as it has
// captured it in a closure, so page scripts never observe it (same discipline as
// `__bo_mark_trusted` in event_bootstrap.js).
((globalThis) => {
    const ops = (typeof Deno !== "undefined" && Deno.core && Deno.core.ops) || null;
    if (!ops) return;

    const api = {
        /// Σ-Λ (Plamondon) stroke synthesis: curved multi-stroke path, pink tremor,
        /// ~8 ms cadence, Fitts's Law duration. Returns [{t_ms, x, y}, …].
        trajectory(x1, y1, x2, y2, targetW) {
            try {
                return JSON.parse(
                    ops.op_behavior_mouse_trajectory(x1, y1, x2, y2, targetW || 30) || "[]"
                );
            } catch (_) {
                return [];
            }
        },
        /// [{x, y, delay_ms}, …] — the same generator behind CDP Input.dispatchMouseEvent.
        mousePath(x1, y1, x2, y2, steps) {
            try {
                return ops.op_human_mouse_path(x1, y1, x2, y2, steps || 20);
            } catch (_) {
                return [];
            }
        },
        /// Per-character inter-key delays from the bigram-aware LogNormal model.
        typingDelays(text, wpm) {
            try {
                return ops.op_human_typing_delays(text, wpm || 65);
            } catch (_) {
                return [];
            }
        },
        /// Seeded RNG shared with the rest of the behaviour layer.
        random() {
            try {
                return ops.op_behavior_random();
            } catch (_) {
                return Math.random();
            }
        },
    };

    try {
        Object.defineProperty(globalThis, "__bo_input_api", {
            value: api,
            configurable: true,
            enumerable: false,
            writable: false,
        });
    } catch (_) {
        /* ignore */
    }
})(globalThis);
