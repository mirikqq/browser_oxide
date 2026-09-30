// Per-document op routing (F4: frames as realms of one isolate).
//
// Every op that touches document state reads "the" `DomState` out of the
// runtime's `OpState`. A frame that is a realm of this isolate has a document
// of its own, so which `DomState` an op sees has to follow the realm that
// called it. Each realm therefore gets its own `Deno.core.ops`: the same op
// functions, each behind a wrapper that makes the realm's document the active
// one first (`op_realm_switch`, which swaps the `DomState`s on the Rust side).
// The switch is skipped while the realm is already the active one, so a run of
// calls from one document pays one comparison per call.
//
// This runs first, before every other bootstrap, so they all capture the
// wrapped ops. The raw ops, the switch and the shared "active realm" record are
// handed to the engine through a temporary global it lifts into Rust (and
// deletes) before any page script exists; nothing page-reachable keeps them.
((globalThis) => {
    const core = globalThis.Deno && globalThis.Deno.core;
    if (!core || !core.ops || typeof core.ops.op_realm_switch !== "function") return;
    const raw = core.ops;
    const sw = raw.op_realm_switch;
    const state = { active: 0 };

    // The same source builds every realm's ops; for a frame realm the engine
    // compiles it in that realm, so the wrappers belong to it.
    const makeRealmOps = function (raw, sw, state, id) {
        const out = {};
        const keys = Object.keys(raw);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const f = raw[k];
            if (k === "op_realm_switch") continue;
            if (typeof f !== "function") { out[k] = f; continue; }
            out[k] = function (...a) {
                if (state.active !== id) { sw(id); state.active = id; }
                return f(...a);
            };
        }
        return out;
    };

    const ops = makeRealmOps(raw, sw, state, 0);
    const shimCore = Object.create(core);
    Object.defineProperty(shimCore, "ops", { value: ops, enumerable: true });
    const shimDeno = Object.create(globalThis.Deno);
    Object.defineProperty(shimDeno, "core", { value: shimCore, enumerable: true });
    Object.defineProperty(globalThis, "Deno", {
        value: shimDeno, writable: true, configurable: true, enumerable: false,
    });
    Object.defineProperty(globalThis, "__boRealmSeed", {
        value: { raw, sw, state, core, makeRealmOps: String(makeRealmOps) },
        writable: true, configurable: true, enumerable: false,
    });
})(globalThis);
