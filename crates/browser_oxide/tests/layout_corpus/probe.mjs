// Evaluates a JavaScript expression in Chrome, on a page, at the corpus viewport.
// For finding out what Chrome does where the engine differs.
//
//   node tests/layout_corpus/probe.mjs <page.html> '<expression>'
//
//   node tests/layout_corpus/probe.mjs real/x.html \
//     "[...document.querySelector('h2 a').getClientRects()].map(r => [r.x, r.y, r.width, r.height])"
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [, , page, expression] = process.argv;
if (!page || !expression) {
  console.error("usage: node probe.mjs <page.html> '<expression>'");
  process.exit(1);
}
const CHROME =
  process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "layout-probe-"));
const chrome = spawn(
  CHROME,
  ["--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
    "--force-device-scale-factor=2", "--window-size=1512,958",
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "about:blank"],
  { stdio: "ignore" },
);
let ws;
try {
  let url;
  for (let i = 0; i < 50 && !url; i++) {
    try {
      url = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  ws = new WebSocket(url);
  await new Promise((r) => (ws.onopen = r));
  let id = 1;
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
      const n = id++;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params, sessionId }));
    });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setScrollbarsHidden", { hidden: true }, sessionId);
  const loaded = new Promise((r) =>
    listeners.push((m) => m.sessionId === sessionId && m.method === "Page.loadEventFired" && r()));
  await send("Page.navigate", { url: "file://" + resolve(page) }, sessionId);
  await loaded;
  const { result, exceptionDetails } = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true }, sessionId);
  console.log(exceptionDetails ? JSON.stringify(exceptionDetails) : JSON.stringify(result.value));
} finally {
  ws?.close();
  chrome.kill();
  await new Promise((r) => setTimeout(r, 300));
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}
