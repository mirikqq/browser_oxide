(function () {
  const d = (o, k) => {
    const x = Object.getOwnPropertyDescriptor(o, k);
    if (!x) return null;
    const r = { e: x.enumerable ? 1 : 0, c: x.configurable ? 1 : 0 };
    if ('value' in x) {
      r.w = x.writable ? 1 : 0;
      const v = x.value, t = typeof v;
      if (t === 'function') { r.k = 'fn'; r.l = v.length; r.n = v.name; }
      else if (v === null || t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined') { r.k = 'val'; r.v = (t === 'number' && !isFinite(v)) ? String(v) : v; }
      else { r.k = t; }
    } else {
      r.k = 'acc'; r.g = x.get ? 1 : 0; r.s = x.set ? 1 : 0;
    }
    return r;
  };
  const members = (o) => {
    const out = {};
    for (const k of Object.getOwnPropertyNames(o)) out[k] = d(o, k);
    for (const s of Object.getOwnPropertySymbols(o)) {
      const key = '@@' + (s.description || '');
      const x = Object.getOwnPropertyDescriptor(o, s);
      out[key] = x && 'value' in x ? { k: typeof x.value, v: typeof x.value === 'string' ? x.value : undefined } : { k: 'acc' };
    }
    return out;
  };
  const nameOf = (f) => (f && typeof f === 'function') ? f.name : (f === null ? null : typeof f);
  const result = { interfaces: {}, namespaces: {}, window: {} };
  for (const k of Object.getOwnPropertyNames(globalThis)) {
    result.window[k] = d(globalThis, k);
    let v;
    try { v = globalThis[k]; } catch (e) { continue; }
    if (typeof v === 'function' && /^[A-Z]/.test(k) && v.prototype && typeof v.prototype === 'object') {
      const pp = Object.getPrototypeOf(v.prototype);
      result.interfaces[k] = {
        length: v.length,
        parent: pp && pp.constructor ? pp.constructor.name : null,
        staticParent: nameOf(Object.getPrototypeOf(v)),
        static: members(v),
        proto: members(v.prototype),
      };
    }
  }
  for (const ns of ['CSS', 'console', 'Math', 'JSON', 'Intl', 'Reflect', 'Atomics', 'WebAssembly']) {
    if (globalThis[ns] && typeof globalThis[ns] === 'object') {
      result.namespaces[ns] = { tag: Object.prototype.toString.call(globalThis[ns]), members: members(globalThis[ns]) };
    } else if (globalThis[ns] !== undefined) {
      result.namespaces[ns] = { tag: typeof globalThis[ns], members: {} };
    }
  }
  return JSON.stringify(result);
})()
