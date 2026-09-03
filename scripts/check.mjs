import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const htmlFiles = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    if (entry.isFile() && entry.name.endsWith(".html")) htmlFiles.push(absolute);
  }
}

function resolveLocal(file, link) {
  const clean = link.split("#")[0].split("?")[0];
  if (!clean) return null;
  if (/^(https?:|mailto:|data:)/.test(clean)) return null;
  let target;
  if (clean.startsWith("/ContextAdapt/")) {
    target = path.join(root, clean.slice("/ContextAdapt/".length));
  } else {
    target = path.resolve(path.dirname(file), clean);
  }
  if (clean.endsWith("/")) target = path.join(target, "index.html");
  return target;
}

walk(root);
const broken = [];
for (const file of htmlFiles) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = resolveLocal(file, match[1]);
    if (target && !fs.existsSync(target)) {
      broken.push(`${path.relative(root, file)} -> ${match[1]}`);
    }
  }
}

const article = fs.readFileSync(path.join(root, "articles/how-much-code-context-does-an-ai-agent-need/index.html"), "utf8");
const required = [
  "2,160 held-out evaluation cells",
  "22.4 percentage points",
  "[+2.4, +40.6]",
  "[-2.3, +17.9]",
  "REAL_CODE_RETENTION_HOLDOUT",
  "Not yet a task-success or cost-reduction claim.",
  'rel="canonical"',
  'type="application/ld+json"'
];
const missing = required.filter((item) => !article.includes(item));
JSON.parse(fs.readFileSync(path.join(root, "evidence/protocol-v3.json"), "utf8"));

console.log(`HTML_FILES=${htmlFiles.length}`);
console.log(`BROKEN_LOCAL_LINKS=${broken.length}`);
console.log(`MISSING_REQUIRED_CLAIMS=${missing.length}`);
console.log("PROTOCOL_JSON=valid");
if (broken.length) console.log(broken.join("\n"));
if (missing.length) console.log(missing.join("\n"));
if (broken.length || missing.length) process.exitCode = 1;
