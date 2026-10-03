import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "pf-"));
const html = `<!doctype html><html><body style="margin:0">${spec.map((s, i) => `<div><span id=s${i} lang="${s.lang || ""}" style="font:${s.size || 28}px ${s.family};line-height:normal">${s.text}</span></div>`).join("")}</body></html>`;
const page = join(profile, "p.html"); writeFileSync(page, html);
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", "--force-device-scale-factor=2", "--window-size=1512,958", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "about:blank"], { stdio: "ignore" });
let ws;
try {
  let url;
  for (let i = 0; i < 50 && !url; i++) { try { url = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { await new Promise(r => setTimeout(r, 200)); } }
  ws = new WebSocket(url); await new Promise(r => (ws.onopen = r));
  let id = 1; const pending = new Map(); const listeners = [];
  ws.onmessage = m => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); } else listeners.forEach(l => l(msg)); };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const n = id++; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params, sessionId })); });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId); await send("DOM.enable", {}, sessionId); await send("CSS.enable", {}, sessionId);
  const loaded = new Promise(r => listeners.push(m => m.sessionId === sessionId && m.method === "Page.loadEventFired" && r()));
  await send("Page.navigate", { url: "file://" + page }, sessionId); await loaded;
  const { root } = await send("DOM.getDocument", { depth: -1 }, sessionId);
  const out = [];
  for (let i = 0; i < spec.length; i++) {
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "#s" + i }, sessionId);
    const { fonts } = await send("CSS.getPlatformFontsForNode", { nodeId }, sessionId);
    const h = (await send("Runtime.evaluate", { expression: `(()=>{const e=document.getElementById('s${i}');const r=e.getBoundingClientRect();return [r.width,r.height,e.parentElement.getBoundingClientRect().height]})()`, returnByValue: true }, sessionId)).result.value;
    out.push({ ...spec[i], fonts: fonts.map(f => `${f.familyName}|${f.postScriptName}|${f.glyphCount}`), box: h });
  }
  console.log(JSON.stringify(out));
} finally { ws?.close(); chrome.kill(); await new Promise(r => setTimeout(r, 300)); try { rmSync(profile, { recursive: true, force: true }); } catch {} }
