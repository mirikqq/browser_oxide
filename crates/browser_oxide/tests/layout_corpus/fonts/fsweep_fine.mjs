import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fonts = JSON.parse(readFileSync(process.argv[2], "utf8"));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "fs-"));
const page = join(profile, "p.html"); writeFileSync(page, `<!doctype html><html><body style="margin:0"><div id=host></div></body></html>`);
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
  await send("Page.enable", {}, sessionId);
  const loaded = new Promise(r => listeners.push(m => m.sessionId === sessionId && m.method === "Page.loadEventFired" && r()));
  await send("Page.navigate", { url: "file://" + page }, sessionId); await loaded;
  const expr = `(()=>{const fonts=${JSON.stringify(fonts)};const h=document.getElementById('host');const out={};
    for(const [name,[text,primary,lang]] of Object.entries(fonts)){
      const own=!name.startsWith('.')&&!name.startsWith('@');
      const fam=own?"'"+name+"'":primary;
      const rows=[];
      for(let i=0;i<=1680;i++){const s=2+i/24;
        h.innerHTML='<div style="font:'+s+'px '+fam+';line-height:normal" lang="'+lang+'"><span id=a>'+text+'</span><span id=m style="display:inline-block;width:1px;height:0"></span></div>';
        const a=document.getElementById('a').getBoundingClientRect();const m=document.getElementById('m').getBoundingClientRect();const d=h.firstChild.getBoundingClientRect();
        rows.push([s,Math.round((m.y-a.y)*2),Math.round(a.height*2),Math.round(d.height*2),Math.round((m.y-d.y)*2)]);}
      out[name]=rows;}
    return JSON.stringify(out)})()`;
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
  console.log(r.result.value);
} finally { ws?.close(); chrome.kill(); await new Promise(r => setTimeout(r, 300)); try { rmSync(profile, { recursive: true, force: true }); } catch {} }
