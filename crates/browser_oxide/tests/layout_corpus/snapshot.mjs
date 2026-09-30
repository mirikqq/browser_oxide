// Records what a real Chrome lays out for every case in `cases/`, as the JSON the
// `layout_corpus` test compares the engine against.
//
//   node tests/layout_corpus/snapshot.mjs [case-name ...]
//
// Needs Google Chrome and Node >= 22. No network: the cases are local files.
import { spawn } from "node:child_process";
import { readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const casesDir = join(here, "cases");
const outDir = join(here, "chrome");
const CHROME =
  process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const VIEWPORT = { width: 1512, height: 871 };
const PORT = 9300 + Math.floor(Math.random() * 500);

const profile = mkdtempSync(join(tmpdir(), "layout-corpus-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--hide-scrollbars", `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`, "about:blank",
  ],
  { stdio: "ignore" },
);

async function endpoint() {
  for (let i = 0; i < 50; i++) {
    try {
      return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("Chrome did not start");
}

const ws = new WebSocket(await endpoint());
await new Promise((r) => (ws.onopen = r));
let nextId = 1;
const pending = new Map();
const listeners = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else listeners.forEach((l) => l(msg));
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const COLLECT = `(() => {
  const round = (n) => Math.round(n * 1000) / 1000;
  const box = (r) => [round(r.x), round(r.y), round(r.width), round(r.height)];
  const rects = {}, client = {};
  for (const e of document.querySelectorAll("[id]")) {
    rects[e.id] = box(e.getBoundingClientRect());
    client[e.id] = [...e.getClientRects()].map(box);
  }
  return JSON.stringify({ viewport: [innerWidth, innerHeight], rects, client });
})()`;

const wanted = process.argv.slice(2);
const cases = readdirSync(casesDir)
  .filter((f) => f.endsWith(".html"))
  .filter((f) => !wanted.length || wanted.includes(basename(f, ".html")));

try {
  for (const file of cases) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Emulation.setDeviceMetricsOverride",
      { ...VIEWPORT, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send("Emulation.setScrollbarsHidden", { hidden: true }, sessionId);
    const loaded = new Promise((r) => {
      const l = (m) => { if (m.sessionId === sessionId && m.method === "Page.loadEventFired") r(); };
      listeners.push(l);
    });
    await send("Page.navigate", { url: "file://" + join(casesDir, file) }, sessionId);
    await loaded;
    const { result } = await send("Runtime.evaluate", { expression: COLLECT, returnByValue: true }, sessionId);
    const data = JSON.parse(result.value);
    if (data.viewport[0] !== VIEWPORT.width || data.viewport[1] !== VIEWPORT.height)
      throw new Error(`${file}: viewport ${data.viewport} is not ${VIEWPORT.width}x${VIEWPORT.height}`);
    writeFileSync(join(outDir, basename(file, ".html") + ".json"), JSON.stringify(data, null, 1) + "\n");
    console.log("recorded", file, Object.keys(data.rects).length, "elements");
    await send("Target.closeTarget", { targetId });
  }
} finally {
  ws.close();
  chrome.kill();
  await new Promise((r) => setTimeout(r, 500));
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still be flushing its profile; the temp dir is harmless.
  }
}
