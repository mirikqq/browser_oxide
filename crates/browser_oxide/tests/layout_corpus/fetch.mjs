// Saves a web page and the stylesheets it links into real/_src/<name>/, ready for
// prepare.mjs. Scripts, images and fonts are not fetched: layout does not need them.
//
//   node tests/layout_corpus/fetch.mjs <url> <name> [--dry]
//
// --dry only reports what would be saved, and how big it is. `real/` is not in git.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [, , url, name, flag] = process.argv;
if (!url || !name) {
  console.error("usage: node fetch.mjs <url> <name> [--dry]");
  process.exit(1);
}
const dry = flag === "--dry";
const headers = {
  "user-agent": "browser_oxide-layout-corpus/0.1 (local layout testing; saves a page once)",
  accept: "text/html,text/css,*/*;q=0.8",
};
const get = async (u) => {
  const r = await fetch(u, { headers, redirect: "follow" });
  if (!r.ok) throw new Error(`${u}: ${r.status}`);
  return { text: await r.text(), url: r.url };
};

const page = await get(url);
const links = [];
let html = page.text.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, (tag) => {
  const href = /href=["']?([^"'\s>]+)/i.exec(tag)?.[1];
  if (!href) return "";
  const abs = new URL(href.replace(/&amp;/g, "&"), page.url).href;
  links.push(abs);
  return `<link rel="stylesheet" href="css/${links.length - 1}.css">`;
});

let total = Buffer.byteLength(page.text);
console.log(`${name}: page ${Buffer.byteLength(page.text)} bytes (${page.url})`);
const sheets = [];
for (const [i, href] of links.entries()) {
  let css = "";
  try {
    css = (await get(href)).text;
  } catch (e) {
    console.log(`  skipped ${e.message}`);
  }
  // Imports are not followed; they would need the same rewriting.
  css = css.replace(/@import\s+[^;]+;/g, "");
  sheets.push(css);
  total += Buffer.byteLength(css);
  console.log(`  stylesheet ${i}: ${Buffer.byteLength(css)} bytes (${href.slice(0, 90)})`);
}
console.log(`  total ${total} bytes`);

if (!dry) {
  const dir = join(here, "real", "_src", name);
  mkdirSync(join(dir, "css"), { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
  sheets.forEach((css, i) => writeFileSync(join(dir, "css", `${i}.css`), css));
  console.log(`  saved in ${dir}`);
}
