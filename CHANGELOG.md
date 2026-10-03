# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`paint` feature: `Page::screenshot`.** Rasterises the page from the engine's
  own layout — backgrounds, borders, text, `overflow` clipping — onto the Skia
  surface canvas already uses. Off by default; adds no dependencies. It draws
  what layout believes, so it shows where layout is still approximate
  (`docs/GUI_PLAN.md`, milestone M1). `EngineHandle::load_html` and
  `EngineHandle::screenshot` expose it across the thread boundary, and
  `examples/screenshot.rs` renders a URL or file to PNG.
- **`browser_oxide_shell`: a desktop window** (address bar + the painted page).
  A separate, unpublished workspace member and not a default one, so the
  engine's dependency tree stays free of any window toolkit.
- **One style engine (`style` module).** A `Stylist` holds every rule of the
  document, indexed by the rightmost id/class/tag, and decides the cascade once:
  origins (user agent / author), `!important`, the `style` attribute, `@layer`,
  `@media`, `@supports` and CSS nesting. A `StyleTree` walks the document top
  down and computes each element's style against its parent's. Layout and
  `getComputedStyle` both read it, so what is drawn and what a script reads can no
  longer come from two different cascades. The user-agent sheet is now a real
  stylesheet (`style/ua.css`), with presentational attributes cascaded like
  author hints.
- **Custom properties and `var()`.** `--name` declarations inherit and resolve
  (including references between them, fallbacks and cycles), and `var()` is
  substituted before the value is parsed, in layout and in `getComputedStyle`
  (`getPropertyValue('--name')` included).
- **More shorthands:** `gap`, `flex`, `flex-flow`, `background` (colour only),
  `border-color`/`-width`/`-style`, `font`, the logical `margin-inline` family
  (horizontal LTR), `place-*`, and the CSS-wide keywords on any shorthand.
  `border-{top,right,bottom,left}-color` are properties of their own, and
  `hsl()` colours resolve.
- **`text` module and per-character font fallback in `paint`.** The font stack
  that lived under `canvas/text` (font database, `font` shorthand parser, metrics
  tables, shaper, glyph rasteriser, and the bundled font files) is now a module of
  its own, shared by canvas and painting; canvas output is unchanged. Painted
  text takes each character the requested font lacks from the first fallback
  face that has it: Arabic, Hebrew, Armenian, Georgian and more symbols from the
  bundled faces, plus bundled Noto Sans Thai and Noto Sans Devanagari (OFL-1.1;
  provenance in `text/fonts/SOURCES.txt`). An application can add faces with
  `text::fallback::register_fallback_face` (the engine still never reads font
  files itself); `browser_oxide_shell --host-fonts` and the `screenshot` example's
  `--font` use it to draw CJK and colour emoji. The fallback faces are not in the
  font database: canvas text, `document.fonts`, `FontFace.load` and `measureText`
  see no difference. Painted text now follows the CSS `font-family` instead of
  always being sans-serif.

- **`LayoutMode::Full` — a layout built toward Chrome's** (opt-in; headless
  keeps the legacy layout unless something selects `Full`:
  `layout::set_default_mode` for a process, `Page::set_layout_mode` for a
  page). It has its own layout tree over taffy's algorithms, resolves `calc()`
  in lengths, understands `grid-template-columns`/`-rows`, floats, and tables
  (automatic layout, `border-collapse`, `border-spacing`, `colspan`/`rowspan`),
  and lays inline content out as lines: greedy wrapping at UAX #14
  opportunities, whitespace collapsing for every `white-space` mode, inline
  boxes that keep their padding and borders across wraps, inline-block and
  replaced elements on the baseline, `text-align`, and Blink's rounding of font
  ascent/descent and half-leading. Text is measured with the bundled faces and
  the profile's metrics tables only, with fixed advances for scripts no bundled
  face covers, so geometry does not depend on the host's fonts.
  `getClientRects()` follows Blink: one rectangle per line for an element with
  padding or borders, one per text fragment otherwise. `browser_oxide_shell`
  and the `screenshot` example select it. `tests/layout_corpus` measures both
  layouts against what a real Chrome reports for 44 local pages (149 elements
  within 1px: legacy 53, full 147); `tests/layout_corpus/snapshot.mjs`
  re-records Chrome's numbers.
  Also in `Full`: placement in a grid (`grid-template-areas`, `grid-area`,
  `grid-row`/`-column` and their `-start`/`-end`, `grid-auto-flow`,
  `grid-auto-rows`/`-columns`), `<wbr>` as a place where a line may end, the
  contents of a closed `<details>` not being laid out, kerning kept when the
  profile's advances are used, and an initial containing block the size of the
  viewport for `fixed` and unanchored `absolute` boxes. Local saved pages can
  be compared with Chrome too (`tests/layout_corpus/prepare.mjs`,
  `snapshot.mjs --real`, `probe.mjs`, test `layout_corpus_real`); the pages
  are kept out of git. Five saved web pages (`fetch.mjs`) join the rustdoc
  ones. What they showed, in `Full` only: a strict `@media` evaluator
  (`evaluate_media_query_strict`), the presentational attributes of old table
  markup (`width`, `cellpadding`, `cellspacing`, `border`, `align`, `valign`,
  `bgcolor`, `<center>`), blocks inside inline elements (the inline context is
  split around them), the root and every box that starts a block formatting
  context keeping its children's margins, quirks-mode lines of images only, table
  columns following cell `width` (lengths and percentages) and cell `height` as
  a minimum.
  Also in `Full`: `::before`/`::after` boxes (`content` with strings, `attr()`,
  quotes and `url(data:…)`), the static position of out-of-flow boxes that move to
  their containing block, sizes and baselines of form controls after Blink, text
  wrapping around floats, and generated images with the natural size of an SVG,
  PNG or GIF given as a `data:` URL.
  Also: `vertical-align` on inline boxes and atomic inlines, `order` on flex and
  grid items, `list-style-type`, CSS counters (`counter-reset`, `counter-increment`,
  `counter-set`, `counter()`, `counters()`), flex baselines, and calc() lengths
  that do not depend on a percentage resolved before taffy sees them. Shared fix:
  nested functional pseudo-classes (`a:is(:not(.q)) .x`) in the selector parser.
  Also in `Full`: the `grid-template` shorthand, `transform` (2D, applied to the
  rectangles `getBoundingClientRect` and `getClientRects` report), `position:
  sticky` at its static position, percentage heights in auto-height flex
  containers counting as `auto`, and line breaks between ASCII symbols following
  a table measured in Chrome (`text/breaks.rs`).
  `<details>`: the contents are in a block formatting context after the summary;
  closed, they are laid out (they have rectangles, as in Chrome) in a box of no
  height and not drawn.
  Lengths follow Blink's `LayoutUnit`: margins, paddings, sizes and offsets in
  1/64 px (rounded down), line heights rounded to 1/64, border widths in whole
  device pixels; a `line-height` in em or % is computed to a length before it is
  inherited.
  `Full` lays out in device pixels, as Blink does at a device scale factor
  (a page at 2x is a page at zoom 2): font ascent, descent and line gap are
  rounded to whole device pixels (an Arial line at 16px is 18.5 CSS px), half-leading
  is floored to one, lengths are kept in 1/64 device px, and the sizes of text
  fields, buttons and the height of an `x` (`vertical-align: middle`) follow the
  profile's fonts (`text/metrics_table.rs`). The Chrome numbers in
  `tests/layout_corpus` are now recorded at a real `--force-device-scale-factor=2`
  rather than with device-metrics emulation, which rounds in CSS pixels.
  Also in `Full`: the vertical metrics of the fonts Chrome falls back to
  (`text/vfallback`, from measurements of Chrome on macOS: which font it takes per
  character, primary font and `lang`, and that font's ascent, descent and line gap),
  so that a line of `line-height: normal` with Japanese, Thai or Indic text is as
  tall as in Chrome; CSS tables built from `display` values (anonymous rows and cells
  around table parts and content, `table-caption` with `caption-side`), floated
  tables sized by their `width`, a float placed below the bottom margin of the block
  before it, spanning table cells sharing their minimum by slack, `width` on a cell
  setting its column, an image or video taking the ratio of its `width` and
  `height` attributes, and the baseline of a zero-height line that holds text.
  Also in `Full`: `justify-self` on block-level boxes and `width: fit-content` (and
  `max-`/`min-content`), zero-size rectangles for empty inline elements and `<br>`,
  kerning across element boundaries, the viewport taking the `overflow` of `body`,
  the quirks-mode rules of the user-agent sheet, and trailing spaces before a `<br>`
  not counting toward the line.
  Also in `Full`: `fieldset`/`legend`, single-colon `:before`/`:after`, logical
  `border-block`/`-inline` shorthands, `position: sticky` offsets, the rule that a
  line holding only collapsible spaces takes no room, and the baseline of
  checkboxes, radio buttons and text areas.
  New dependencies: `unicode-linebreak`
  (Apache-2.0), `unicode-width` (MIT OR Apache-2.0). New properties parsed:
  `grid-template-columns`/`-rows`, `border-collapse`, `border-spacing`,
  `vertical-align` (kept as text), and the `table-row-group`, `table-header-group`,
  `table-footer-group`, `table-column`, `table-column-group`, `table-caption`
  display values (the legacy layout still treats them as `inline`).

### Security
- **Page script could mint `isTrusted` events.** The engine namespace hides
  from `Object.getOwnPropertySymbols(window)` only when called with one
  argument, and it carried `input.mark` (the trusted-event minter) plus the
  humanized-input routines, all of which mint trust. The minter, the
  behaviour bridge and the input API now live in Rust-held handles
  (`js_runtime/privileged.rs`), lifted off the namespace before any init or
  page script runs and handed to engine code only as a call argument.

### Fixed
- **Values with parentheses lost them** when a declaration was turned back into
  text: `calc((16px - 0.57rem) / 2)` became `calc(16px - 0.57rem / 2)`, which
  changed its meaning, made a rule that also uses `var()` drop such a
  declaration, and made `getComputedStyle` report the wrong text.
- **Layout cascaded on its own, and got it wrong** — no inheritance (`color`,
  `font-*`, `line-height`, `visibility` stopped at each element), every `em`
  measured against 16px, `!important` and `@layer` ignored. It now takes
  computed styles from the style engine. Headless geometry changes with it:
  `getBoundingClientRect`, `offset*` and `client*` report the sizes the
  corrected styles give (headings and paragraphs from the user-agent sheet
  included).
- **`gap`, `align-items`/`-self`/`-content`, `justify-items`/`-self`/`-content`
  and `flex-basis` never reached layout** — the `gap` shorthand was never
  expanded into the `row-gap`/`column-gap` layout reads, and the rest were not
  read at all. Flex and grid containers that relied on them were laid out as if
  they were absent.
- **`getComputedStyle` let the `style` attribute beat an author `!important`
  declaration**, for the element and for the ancestors it inherits from. It also
  read a different cascade than layout did. Relative lengths (`em`, `rem`, `vw`)
  are reported in px, as Chrome does, and `font-size` and `display` come from
  the style pass.
- **Warm-reused pages lost trusted input from their second navigation on**
  (pool, `navigate_warm_with_init`, devview): the minter was a single-use
  handle the first `humanize.js` install consumed. The Rust-held capabilities
  last for the isolate's lifetime.
- **Delivered `MessageEvent`s were untrusted** — frame-to-frame `postMessage`
  in both directions, `window.postMessage`, `MessageChannel` ports and Worker
  messages. They are trusted, as in Chrome.
- **A `srcdoc` frame's origin was `"null"`** instead of its parent's, both as
  `location.origin` and as the `event.origin` of its messages, and a parent
  posting to it with its own origin as `targetOrigin` was dropped. Message
  origins and `targetOrigin` checks now use the engine's record of each
  frame's origin, not the value the sending realm wrote into its queue.
- **Same-origin frames are realms of the page's isolate (F4).** A
  same-origin frame — `srcdoc`, `about:blank`, or a `src` on the page's origin
  — is a full document in a `v8::Context` of the page's own isolate, running
  the same bootstraps against a `DomState` of its own (`js_runtime/realms.rs`;
  ops follow the calling realm through per-realm op wrappers). Its window is
  reached synchronously — `contentWindow.foo`, `contentDocument` — keeps its
  identity when the frame's document loads into it, shares the page's
  storage, and posts messages with the right `source` and `origin`. Frames
  nest; a frame navigating itself navigates the frame, not the page.
  Cross-origin frames stay isolates of their own (`ChildIframe`), nested ones
  included. This replaces the thin `contentWindow` realm the page used to
  build next to the frame's real document — which ran the frame's scripts a
  second time and answered messages in its place — and ~1,000 lines of its
  mirror-constructor machinery. A relative `src` is no longer treated as
  cross-origin; a cross-origin frame's window is one object for its life; a
  script a frame inserts runs in that frame.
- **`pointer-events` was not inherited** in computed style, so the text inside
  a floating `<label style="pointer-events:none">` still caught hit-tests and
  humanized input refused the field underneath as covered ("нет видимой
  точки").
- **Frames inserted after load were never built** by an ordinary navigation —
  cold ones only built them inside the challenge poll, warm (pooled) ones
  never did. Pages now settle their frame tree themselves
  (`Page::settle_frames`): after construction and navigation, in
  `evaluate_async` and during humanized input. A frame that fails to load is
  not refetched until its `src`/`srcdoc` changes.
- CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent`/`insertText` events are
  trusted, as Chrome's own input pipeline's are.
- devview: frames were not driven and messages not pumped while a humanized
  action ran; an action that did not finish in 10 s left "запущено" as its
  last status; `[trusted]` reported whether a minter was found rather than
  what the events were; the frame-click and unknown-action paths still
  spliced request values into JS source.
- **`getHours()` disagreed with `Intl` under any non-host timezone.** The
  profile's zone was a JS override of `Intl.DateTimeFormat`,
  `getTimezoneOffset` and the `toString` family, while the local getters, the
  `Date` constructor and `Temporal.Now` kept the host's zone — so
  `new Date().toString()` printed the profile's offset and `getHours()` on the
  same object the host's hour. The zone is now set as ICU's default before the
  first script (and again when a pooled page is reused), which every one of
  those surfaces reads; the ~150-line override is gone. ICU's default is
  process-wide: concurrently running pages with different zones are logged,
  and should run in separate processes.
- **A WebGL 2 context reported itself as WebGL 1** on every profile whose GPU
  entry holds a WebGL 1 capture — the default Windows/NVIDIA one included:
  `getContext("webgl2").getParameter(VERSION)` said "WebGL 1.0" and the
  extension list carried those WebGL 2 absorbed into core. The surface is now
  derived per API in Rust (`GpuProfile::webgl_surface`), including Gecko's GL
  identity for Firefox profiles.
- `chrome_148_jp` listed `language` outside `languages`; `validate()` rejected
  the Android and iOS presets over rules written for desktop Chrome (empty
  Android architecture, Apple GPU and ARM on iOS, Safari's absent
  `deviceMemory`).

- **The profile locale was a JS wrapper** around the `Intl` constructors
  (whose `prototype.constructor` no longer pointed back at them), forced
  `resolvedOptions().locale` to the profile's even for an explicit
  `new Intl.DateTimeFormat("de")`, and missed `toLocaleDateString`,
  `toLocaleTimeString`, `Number#toLocaleString` and `localeCompare`, which
  kept the host's locale. It is now ICU's default locale, set alongside the
  timezone (`uloc_setDefault` + V8's `LocaleConfigurationChangeNotification`),
  and the `Intl` natives are no longer wrapped.

### Added
- Frame realms: `Page::frame_realms`, `frame_realm_for`,
  `evaluate_in_frame_realm`; `BrowserJsRuntime::create_frame_realm(_for)`,
  `execute_in_realm(_named)`, `replace_realm_document`,
  `call_privileged_in_realm`, `destroy_frame_realm`.
- `Page::install_humanize`, `Page::evaluate_privileged` /
  `evaluate_privileged_async` and `ChildIframe::evaluate_privileged`: drivers
  that compose their own input get the capability object (`markTrusted`,
  `human`, `inputApi`) as a function argument. `humanize.js` is now a function
  expression taking that object; evaluating it as a plain script no longer
  installs anything (init-script lists that contain it keep working).
- `stealth::presets::{all, by_name, select, default_profile}` — the preset
  catalog, and profile selection from `BROWSER_OXIDE_STEALTH_*`. Catalog tests
  check every preset validates and declares a stack `net::tls` can build.
- `generator` feature: `stealth::generator` samples Chrome identities from a
  Bayesian network of observed fingerprints (`veilus-fingerprint`).
- `geoip` feature: `stealth::geo` resolves the exit address against a local
  GeoLite2 database before the HTTP providers; downloads only from
  `BROWSER_OXIDE_GEOIP_URL` (no default source).
- `stealth` feature, **on by default**: turns on `generator` and `geoip`, so
  identity sampling and the offline exit-address lookup need no feature flag.
  `default-features = false` builds without them (and without the bzip2 and xz
  C libraries `generator` pulls in). `geoip` stays inert until a database is on
  disk or `BROWSER_OXIDE_GEOIP_URL` names one.
- Humanized clicks land on a per-session, per-control spot in the middle half
  of the target (`BehaviorProfile::aim_point`) instead of fresh noise per click.

### Changed
- **Breaking:** `Page::human_click` and `Page::human_type` are now `async`.
  They evaluated synchronously against a `__browserOxide` global that no
  longer existed, so every call failed; they now run the humanized input
  routine (trusted events, Sigma-Lognormal path, keystroke timing) to
  completion and return its status.
- `net::tls::expected_impersonate` picks the stack by browser family, device
  class and major version from one table; the TLS connector and the HTTP/2
  preface branch on the same decision.

### Dependencies
- `maxminddb` 0.26 → **0.32** (`geoip` feature), for RUSTSEC-2025-0132 —
  with `geoip` on by default the advisory would otherwise reach every build.
- `rustls` 0.23.42 → **0.23.45** (and `rustls-webpki` 0.103.15), for
  RUSTSEC-2026-0285.

## [0.1.3]

> Lands the `deno_core` 0.408 bump deferred from 0.1.2 — a V8 isolate must now be
> constructed inside an entered tokio runtime or the process aborts — and makes
> the V8 heap ceiling environment-tunable.

### Fixed
- **A V8 isolate constructed outside a tokio runtime aborted the process**
  ([#37](https://github.com/yfedoseev/browser_oxide/issues/37)). `deno_core`
  0.408 captures `tokio::runtime::Handle::try_current()` when it registers an
  isolate and spawns V8's *delayed* foreground tasks — GC memory-reducer work —
  on that handle; with no handle it prints a diagnostic and calls
  `std::process::abort()`. The synchronous constructors
  (`BrowserJsRuntime::new` / `with_profile` / `with_options`) are public API
  callable from a plain `fn main` or a `#[test]`, so they now enter a
  process-lifetime fallback runtime when the caller has none. Applies to both
  the page and worker realms.

  Worth being precise, because it shaped the 0.1.2 release: the abort is
  **not** debug-gated and **not** platform-specific. Release builds passed only
  while V8 happened not to post a delayed task inside the window under test —
  i.e. a latent production abort, which is why the bump was held back from
  0.1.2 rather than shipped. Reproduced on Linux, macOS and Windows.

### Added
- **Environment-tunable V8 heap limits.** The right ceiling is a property of
  the deployment, not of the engine, and the previous hard-coded 4 GB silently
  over-committed small containers.
  - `BROWSER_OXIDE_HEAP_MAX_MB` — default `4096` (4 GB)
  - `BROWSER_OXIDE_HEAP_INITIAL_MB` — default `1024` (1 GB)

  Unparseable or zero values fall back to the defaults with a warning rather
  than failing; an initial above the ceiling is clamped, since V8 rejects that
  pairing. Both are per-**isolate**, so a `PagePool` of N pages can commit up
  to N × the ceiling — see [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

### Dependencies
- `deno_core` 0.404 → **0.408** (V8 149.2.0 → 149.4.0), the bump deferred from
  0.1.2.

### Changed
- CI runs `cargo test` with `--nocapture`. Not cosmetic: libtest captures each
  test's output and replays it only on failure, so when a test *aborts* the
  reason dies with it. That is why #37 first surfaced as a bare
  `signal: 6, SIGABRT` with no diagnosis. Any future abort-on-construction
  would otherwise be undiagnosable from CI logs alone.

### Verified
- Canvas fingerprint byte-identical across the V8 bump —
  `examples/canvas_fp_probe.rs` reports `len=17502 fnv1a=5b1d42ee9bdc9713`, the
  same value as 0.1.1 and 0.1.2.
- Real-site regression vs `main`, 15 open sites, both engine paths: zero
  regressions; the warm-reuse fix from 0.1.2 still holds (pool 11/15 → 12/15).
- Full CI matrix green on ubuntu (stable/beta/nightly), macOS and Windows —
  including the debug jobs that previously aborted.

## [0.1.2]

> Fixes an unbounded V8 heap leak in `PagePool` warm reuse that was also silently
> corrupting render output — two real sites returned 9-byte bodies on the second
> page through the pool. Adds `Page::reset_for_reuse()`, refreshes the dependency
> tree, and clears two RUSTSEC advisories.

### Fixed
- **`PagePool` / warm reuse leaked V8 heap without bound**
  ([#33](https://github.com/yfedoseev/browser_oxide/issues/33)). Reusing a
  `Page` across navigations grew V8's live (non-collectable) heap by ~10 MB
  per page, eventually OOMing long batches. Every one of the engine's reapers
  was wired only to `Page::drop`, which a pool by definition never reaches,
  and the bootstrap JS keeps several registries scoped to the `JsRuntime`
  rather than to the document. Now reaped on reuse:
  - all registered event listeners (`__cancelAllListeners()` in
    `event_bootstrap.js`) — `window`-bound listeners were keyed against the
    one object that outlives every navigation, so their closures pinned the
    previous page's entire object graph, and `_nodeListeners` was a strong
    `Map` that was never pruned at all;
  - the DOM node-wrapper cache, scroll state, `MutationObserver` registry,
    and iframe/frame registries (`__resetDomRegistries()`);
  - custom-element definitions (`__resetCustomElements()`);
  - globals the page hung off `window` (`__resetPageGlobals()`), diffed
    against a baseline the engine marks before any page script runs.
- **Warm reuse misfired the previous page's handlers on the new document.**
  `_nodeListeners` and the node-wrapper cache are keyed by `nodeId`, and node
  IDs restart at zero when `replace_dom` swaps the document — so the old
  page's listener for node 42 fired on the new page's node 42, and the new
  page's node could be handed the old page's wrapper (with its expandos).
  Fixed by the same reset.
- **Custom elements could not be re-defined across a warm navigation.**
  `customElements.define()` for a name the *previous* page had registered was
  a silent no-op, so the new page's class never upgraded.
- `Page::navigate_warm` left `__keepLongTimersRefed` set after a challenge
  page, pinning long timers on every subsequent navigation of that `Page`.
- **The CDP protocol server leaked the same way.** `Page.navigate` swaps the
  document with `reload_html` on a `Page` the session keeps alive for its
  whole lifetime, so it accumulated the previous document's state for as long
  as a client stayed connected. It now resets between documents.
- Page-assigned `on*` handlers (`window.onscroll = …`, `document.onclick = …`)
  survived reuse. These already exist as own properties at bootstrap, so a
  key-set diff cannot see the assignment; handler *values* are now snapshotted
  at baseline and restored, which clears page assignments while preserving the
  engine's own `window.onerror` instrumentation.

### Added
- `Page::reset_for_reuse()` — public, bundles every cross-navigation reaper
  (timers, listeners, DOM registries, custom elements, page globals, orphan
  Workers, child iframe isolates). Consumers that hand-roll page reuse — e.g.
  calling `Page::reload_html` on a `Page` they keep alive — should call this
  between documents; `PagePool`, `Page::navigate_warm` and the CDP server
  already do.
- `Page::v8_heap_used_bytes()` and `Page::collect_garbage()` (also on
  `BrowserJsRuntime`) — lets pool operators verify heap health directly.
  Sample after each navigation; a healthy pool stays flat.

### Removed
- Dead `_listeners` registry in `event_bootstrap.js` (declared, never read).

### Dependencies
Closes [#32](https://github.com/yfedoseev/browser_oxide/issues/32) and
supersedes the open Dependabot PRs
([#22](https://github.com/yfedoseev/browser_oxide/pull/22)–[#31](https://github.com/yfedoseev/browser_oxide/pull/31)),
whose commits are cherry-picked here with authorship preserved.

- `deno_core` 0.403 → **0.404**. 0.408 was tried and reverted: it builds and
  passes the full suite in release, but **aborts (SIGABRT) during V8 isolate
  construction in debug builds on Linux** — `basic_js_execution`, which only
  builds a runtime and evaluates `1 + 2`, dies before printing a result. The
  bump needs a debug repro before it can land.
- `taffy` 0.8 → **0.12** (adds safe-alignment keywords).
- `skia-safe` 0.97 → **0.99**, `tokio-tungstenite` 0.27 → **0.30**,
  `webpki-root-certs` 0.26 → **1.0**, `brotli` 7 → **8**, `base64` 0.22 →
  **0.23**, `glow` 0.17 → **0.18** (behind the `webgl-render` feature).
- **`png` deliberately held at 0.17.** 0.18 merges `FilterType` +
  `AdaptiveFilterType` into one `Filter` enum, and while `Compression::Balanced`
  does map back to the same flate2 level, `Filter::Adaptive` is *not*
  equivalent to the `Paeth` + adaptive pair the canvas encoder uses. Measured
  on the standard FingerprintJS canvas sequence, 0.18 emits a 9,646-byte data
  URL where 0.17 emits 17,502 — i.e. a different canvas fingerprint for every
  page. Added `examples/canvas_fp_probe.rs` so this is checkable in one command
  before any future bump.

On [#32](https://github.com/yfedoseev/browser_oxide/issues/32): the reported
`deno_error` conflict is an artifact of how `cargo-outdated` probes. It
synthesizes a manifest requiring the latest of *everything simultaneously*,
which pairs `deno_core` 0.409 (whose own manifest pins `deno_error` **=0.7.1**)
against `deno_error` 0.7.3 — a combination that cannot resolve upstream and
does not exist in this workspace. It will keep recurring in the monthly
`outdated` workflow until `deno_core` catches up with `deno_error`.
- `sha1` and `sha2` 0.10 → **0.11**. These must move together: `sha2` 0.11
  pulls `digest` 0.11, which makes the in-scope `Digest` trait incompatible
  with a `sha1` still on `digest` 0.10.
- `adblock` 0.12 → **0.13** (optional `blocker` feature). Required an API port
  — `Engine::from_filter_set` → `new_with_filter_set`, `Request::new` gained a
  fourth argument, `BlockerResult.matched` → `should_block()`. Ported by
  [@Ran-Mewo](https://github.com/Ran-Mewo) in the SilvR-AI fork; adopted here
  with thanks. The `deny.toml` MPL-2.0 exception is name-based and still
  applies.
- `chrono` 0.4.44 → 0.4.45, `http2` 0.5.17 → 0.5.19, plus `cargo update` across
  the tree for all remaining semver-compatible upgrades.

### Security
Two advisories in the dependency tree are resolved by the `cargo update` above.
Neither is reachable through a public `browser_oxide` API, but both are worth
noting for anyone auditing the tree:

- **`quinn-proto` 0.11.14 → 0.11.16** — [RUSTSEC-2026-0185], remote memory
  exhaustion via unbounded out-of-order stream reassembly. This one sits in the
  HTTP/3 path, so it is reachable from a hostile server on an h3 connection.
- **`crossbeam-epoch` 0.9.18 → 0.9.20** — [RUSTSEC-2026-0204], invalid pointer
  dereference in the `fmt::Pointer` impl for `Atomic`/`Shared`.
- `anyhow` 1.0.102 → 1.0.104 also clears [RUSTSEC-2026-0190] (unsoundness in
  `Error::downcast_mut()`).

`deny.toml`: added documented ignores for [RUSTSEC-2026-0206] (`rustybuzz`) and
[RUSTSEC-2026-0192] (`ttf-parser`) — both *unmaintained* notices rather than
vulnerabilities, on the direct text-shaping stack, with no maintained pure-Rust
replacement. Dropped the now-stale `adler` ignore, which the `deno_core` bump
resolved.

[RUSTSEC-2026-0185]: https://rustsec.org/advisories/RUSTSEC-2026-0185
[RUSTSEC-2026-0204]: https://rustsec.org/advisories/RUSTSEC-2026-0204
[RUSTSEC-2026-0190]: https://rustsec.org/advisories/RUSTSEC-2026-0190
[RUSTSEC-2026-0206]: https://rustsec.org/advisories/RUSTSEC-2026-0206
[RUSTSEC-2026-0192]: https://rustsec.org/advisories/RUSTSEC-2026-0192
- CI actions: `actions/checkout` 4 → 6, `actions/upload-artifact` 4 → 7,
  `codecov/codecov-action` 4 → 7, `taiki-e/install-action` 2.49.40 → 2.81.11,
  `github/codeql-action` 4.36.0 → 4.36.2 (all SHA-pinned).

## [0.1.0] — 2026-06-13

> First open-source release of BrowserOxide — a from-scratch stealth headless
> browser engine in Rust: own HTTP/1+2+3 + BoringSSL TLS stack, V8 via
> deno_core, from-scratch CSS/DOM/layout/canvas, configurable browser-identity
> profiles, and a CDP-compatible debugging surface. Dual-licensed MIT OR Apache-2.0.

### Added
- From-scratch browser engine: HTML parser, arena-allocated DOM + Shadow DOM +
  iframes, CSS parser/selectors/values/cascade, layout, and Canvas 2D / WebGL
  rendering — no Chromium, no fork.
- Stealth networking stack: HTTP/1, HTTP/2, and HTTP/3 with Chrome-identical
  TLS ClientHello + HTTP/2 fingerprint via boring2 (Cloudflare BoringSSL fork).
- Native (not injected) browser fingerprint via configurable stealth profiles
  (Chrome 148 / Firefox 135 / Safari 18 desktop + mobile presets), loadable
  from YAML/JSON.
- JavaScript runtime on V8 (deno_core 0.403) with Web-platform APIs, workers,
  and an event loop.
- `ChallengeSolver` trait + `Page::navigate_with_solvers` hook for embedders;
  no per-vendor bypass code ships in the public crate (see `SCOPE.md`).
- Python bindings (PyO3), published to PyPI as `browser-oxide`.
- MCP server (`browser_oxide_mcp`) for AI assistants.
- CDP-compatible debugging/automation surface (Puppeteer/Playwright drop-in).

### Performance
- Single-process architecture: ~60–135 MB peak RSS per page vs a headless-Chrome
  process tree's 1–2 GB — roughly 15× lighter (see [`docs/MEMORY.md`](docs/MEMORY.md)).
- Warm `PagePool` amortizes V8 isolate + snapshot setup across navigations.

### Notes
- Anti-bot corpus: routed 118/126 commercially-protected sites to a real render
  in a same-machine, same-IP cleanroom run, with zero per-vendor bypass code
  (see [`docs/BENCHMARK.md`](docs/BENCHMARK.md)).
- **Python wheels ship for macOS (Apple Silicon + Intel) and Windows.** The Linux
  wheel is deferred to 0.1.1: the prebuilt V8 uses a local-exec TLS model that
  can't link into a `-shared` CPython extension, and a from-source rebuild isn't
  possible from the crates.io `v8` tarball. The Linux package will land via a
  sidecar (engine binary + thin Python client). The Rust crate and the MCP server
  are unaffected and support Linux, macOS, and Windows.

[Unreleased]: https://github.com/yfedoseev/browser_oxide/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yfedoseev/browser_oxide/releases/tag/v0.1.0
