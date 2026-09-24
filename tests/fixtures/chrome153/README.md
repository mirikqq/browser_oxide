# Chrome 153 surface capture

The JS-surface tables this engine ships are generated from a real Chrome 153
(`153.0.8010.48` on macOS at the time of writing). Everything needed to redo the
capture for a newer Chrome lives here.

## 1. Capture Chrome

`surface_probe.js` is the expression the tables are generated from: run it in the
realm you want (window or dedicated worker) and it returns a JSON dump of every
interface object, prototype and global own property with its descriptor shape.

```bash
# window realm — probe.html writes surface_probe.js's result into a <pre>
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --disable-gpu --no-sandbox --user-data-dir=/tmp/cap --virtual-time-budget=3000 \
  --dump-dom "file://$PWD/probe.html" > chrome.html
```

For the worker realm wrap the same expression in `postMessage(...)` inside a blob
worker. Save the results as `chrome153_full.json` and `chrome153_worker_full.json`.

`values_probe.html` is the second capture: it instantiates ~240 interfaces
(every element tag, events, streams, audio nodes, …), walks each prototype chain
and records what a freshly created object reports for every attribute. That file
(`chrome153_values.json`) is what gives the generated members real Chrome default
values instead of typed zeros.

`loc_probe.html`-style descriptor captures cover the `[LegacyUnforgeable]`
members that live on instances rather than prototypes (`window.location`,
`document.location`, `Event.isTrusted`) and `Symbol.unscopables` /
`Symbol.iterator` shapes.

## 2. Capture this engine

Evaluate `surface_probe.js` in a `Page` (window realm) or inside a blob worker
(worker realm) and save as `oxide_baseline.json` / `oxide_worker_baseline.json`.
Both captures must be taken with `parity_bootstrap.js` disabled, otherwise the
generator sees its own output and produces an empty table.

## 3. Regenerate

```bash
python3 scan_conflicts.py   # writes parity_exclusions.json
python3 gen_parity.py       # writes js_runtime/js/parity_bootstrap.js
python3 surface_diff.py <dir> window chrome153_full.json oxide_full.json
```

- `scan_conflicts.py` finds every `this.field = …` in our bootstraps whose
  interface (or one of its IDL ancestors) exposes that field as a read-only
  prototype accessor in Chrome. Those members cannot be generated — a getter-only
  accessor would make our own constructor throw — so they are excluded and the
  class should be converted to the shared IDL state map
  (`_boNs.idl.own(this).field = …` plus `_boNs.idl.fields(proto, [...])`) instead.
- `gen_parity.py` writes the generated filler for everything Chrome exposes and
  this engine does not implement: accessors with captured defaults, methods with
  Chrome's lengths, `Symbol.toStringTag` / `iterator` / `asyncIterator` /
  `unscopables`, and per-realm flags so worker-only members stay out of the
  window realm.

Hand-written tables generated from the same capture live in
`js_runtime/js/cleanup_bootstrap.js` (constructor lengths, member lengths, IDL
constants, event handlers, ARIA reflection, misplaced members, worker global
order and parents) and `js_runtime/js/canvas_bootstrap.js` (WebGL 1/2
prototypes).

## Known deviation

`Error.prepareStackTrace` is an own property of `Error` here and `undefined` in
Chrome. It is what filters `ext:`/`deno:`/bootstrap frames out of `Error.stack`;
dropping it would leak engine-internal frame names into every stack a page reads,
which is the louder tell of the two.

## Network capture (TLS ClientHello + HTTP/2 preface)

`network_capture.json` is Chrome for Testing 153.0.8010.48 (linux64) talking to
a loopback server, recorded by `network_capture.py`: a TCP front records the
ClientHello and forwards to a TLS/h2 back end that decodes the preface. Chrome
was pointed at it with

```bash
python3 network_capture.py 40 > out.json &   # cert.pem/key.pem: any self-signed pair for test.example
chrome --no-proxy-server --ignore-certificate-errors --user-data-dir=/tmp/cap \
  --host-resolver-rules="MAP test.example:443 127.0.0.1:8443" https://test.example/
```

(headless and headful under Xvfb gave the same result). GREASE values are
dropped and extension types are a sorted set, since Chrome permutes them per
connection. `net::tls` and `net::h2_client` tests compare the engine against it.

Observed and not acted on:

- **Extension 0x12E0 (4832), body `00 00`.** Sent by 153, not by Chromium 141,
  unknown to our BoringSSL. It is the one pinned divergence in the TLS test and
  moves JA4's extension count from 17 to 18. Chrome for Testing runs without
  field trials, so whether stable Chrome enables it for everyone is not known
  from this capture alone.
- **`accept-language` right after `sec-ch-ua-platform`** in the navigation
  headers, in both 153 and Chromium 141. The engine keeps it before `priority`,
  per earlier captures of stable Chrome; a fresh-profile capture without field
  trials is not enough to overturn those.
- Trust Anchor IDs and ECH GREASE differ in length from ours; neither length
  enters JA4 (the anchor list tracks the root store, ECH GREASE is padded).
