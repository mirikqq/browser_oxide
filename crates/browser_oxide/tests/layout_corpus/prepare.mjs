// Makes a saved page fit for comparing two layout engines: self-contained (local
// stylesheets inlined, scripts and images dropped) and set in the same fonts
// everywhere (web fonts removed, every font-family reduced to Arial, Times New
// Roman or Courier New, which the bundled faces match metrically). What is left to
// differ is layout.
//
//   node tests/layout_corpus/prepare.mjs <page.html> [name]
//
// writes tests/layout_corpus/real/<name>.html. `real/` is not in git: the pages
// are other people's work.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [, , input, nameArg] = process.argv;
if (!input) {
  console.error("usage: node prepare.mjs <page.html> [name]");
  process.exit(1);
}
const name = nameArg || basename(input, ".html");
const base = dirname(resolve(input));
let html = readFileSync(input, "utf8");

const families = (value) => {
  const v = value.toLowerCase();
  if (/\bmonospace\b|courier|consolas|menlo|monaco|source code/.test(v)) return '"Courier New"';
  if (/\bsans-serif\b|system-ui|helvetica|arial|fira sans|-apple-system/.test(v)) return "Arial";
  return '"Times New Roman"';
};
const normalizeFonts = (css) =>
  css
    .replace(/@font-face\s*\{[^}]*\}/g, "")
    .replace(/font-family\s*:\s*([^;}]+)/gi, (_, v) => `font-family:${families(v)}`);

html = html
  .replace(/<script\b[\s\S]*?<\/script>/gi, "")
  .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
  .replace(/<link\b[^>]*rel=["']?(?:preload|modulepreload|prefetch|alternate|icon)[^>]*>/gi, "")
  .replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, (tag) => {
    const href = /href=["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!href || /^[a-z]+:/i.test(href)) return "";
    const file = join(base, href.split("?")[0]);
    return existsSync(file) ? `<style>${normalizeFonts(readFileSync(file, "utf8"))}</style>` : "";
  })
  .replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_, a, css) => `<style${a}>${normalizeFonts(css)}</style>`)
  .replace(/\sstyle="([^"]*)"/gi, (_, css) => ` style="${normalizeFonts(css).replace(/"/g, "&quot;")}"`)
  .replace(/\s(?:src|srcset)=["'][^"']*["']/gi, (m, off, whole) =>
    /<img\b[^>]*$/i.test(whole.slice(Math.max(0, off - 400), off)) ? "" : m,
  )
  .replace(/<base\b[^>]*>/gi, "");

mkdirSync(join(here, "real"), { recursive: true });
const out = join(here, "real", `${name}.html`);
writeFileSync(out, html);
console.log(`${out}: ${html.length} bytes`);
