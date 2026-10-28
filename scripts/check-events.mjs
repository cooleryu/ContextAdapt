import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { trackerScript, eventsScript, withTracker } from "./tracker.mjs";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "assets/site-events.js"), "utf8");
const repo = "https://github.com/cooleryu/ContextAdapt";
const articleUrl = "https://cooleryu.github.io/ContextAdapt/articles/example/zh-CN/";
const htmlFiles = fs.readdirSync(root, { recursive: true })
  .filter(file => file.endsWith(".html") && !file.startsWith(".git/"));

function tabStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

function page({ canonical = articleUrl, language = "zh-CN", tracker,
  url = articleUrl, referrer = "", storage = tabStorage(), now = () => 1_000_000 } = {}) {
  const calls = [];
  const listeners = new Map();
  const window = { location: { href: url }, sessionStorage: storage,
    umami: tracker ?? { track: (name, data) => calls.push({ name, data }) } };
  const document = {
    referrer,
    documentElement: { lang: language },
    querySelector: () => canonical ? { href: canonical } : null,
    addEventListener: (type, listener, options) => {
      assert.equal(options.passive, true);
      assert.equal(listeners.has(type), false, `duplicate ${type} listener`);
      listeners.set(type, listener);
    },
  };
  const context = vm.createContext({ window, document, URL, Date: { now } });
  const run = () => vm.runInContext(source, context);
  const activate = (href = repo, options = {}) => {
    const event = {
      type: "click", button: 0, defaultPrevented: false,
      target: { closest: () => ({ href }) },
      preventDefault: () => assert.fail("navigation was prevented"),
      stopPropagation: () => assert.fail("propagation was stopped"),
      ...options,
    };
    listeners.get(event.type)(event);
    return event;
  };
  run();
  return { calls, window, run, activate, listeners };
}

let articlePages = 0;
for (const file of htmlFiles) {
  const html = fs.readFileSync(path.join(root, file), "utf8");
  assert.equal(html.split(trackerScript).length - 1, 1, file);
  assert.equal(html.split(eventsScript).length - 1, 1, file);
  assert.ok(html.indexOf(trackerScript) < html.indexOf(eventsScript), file);
  assert.equal(withTracker(html), html, `non-idempotent installation: ${file}`);
  const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
  const language = html.match(/<html lang="([^"]+)"/)?.[1];
  const result = page({ canonical, language, url: canonical });
  const isArticle = file.startsWith("articles/");
  assert.equal(result.calls.length, Number(isArticle), file);
  result.activate();
  assert.equal(result.calls.at(-1).name, "github_click", file);
  if (isArticle) articlePages += 1;
}
assert.equal(htmlFiles.length, 13);
assert.equal(articlePages, 7);
assert.equal(withTracker(withTracker("<html><head></head><body></body></html>")),
  withTracker("<html><head></head><body></body></html>"));

const article = page();
assert.equal(article.calls[0].name, "article_view");
assert.equal(article.calls[0].data.article_id, "example");
assert.equal(article.calls[0].data.content_language, "zh-CN");
article.run();
assert.equal(article.calls.length, 1, "duplicate initialization recorded an article twice");
for (const options of [{}, { detail: 0 }, { ctrlKey: true }, { metaKey: true },
  { shiftKey: true }, { altKey: true }, { type: "auxclick", button: 1 }]) {
  const before = article.calls.length;
  article.activate(`${repo}/tree/main?source=ignored#readme`, options);
  assert.equal(article.calls.length, before + 1);
  assert.equal(article.calls.at(-1).data.destination, `${repo}/tree/main`);
}
const beforeIgnored = article.calls.length;
for (const href of ["https://github.com/openai/codex", "https://github.com/cooleryu",
  `${repo}-fork`, `${repo}.git`, "https://github.com.evil.test/cooleryu/ContextAdapt",
  "https://github.com:444/cooleryu/ContextAdapt", "http://github.com/cooleryu/ContextAdapt",
  "mailto:hello@example.com", "invalid"]) article.activate(href);
for (const options of [{ type: "click", button: 1 }, { type: "auxclick", button: 0 },
  { type: "auxclick", button: 2 }, { defaultPrevented: true }, { target: {} }]) article.activate(repo, options);
assert.equal(article.calls.length, beforeIgnored);

for (const canonical of ["https://cooleryu.github.io/ContextAdapt/", undefined, "invalid"]) {
  const result = page({ canonical: canonical ?? "" });
  assert.equal(result.calls.length, 0);
}
for (const tracker of [{}, { track: () => { throw new Error("unavailable"); } },
  { track: () => Promise.reject(new Error("unavailable")) }]) {
  const result = page({ tracker });
  result.activate();
  result.window.umami = undefined;
  result.activate();
}

// Home -> article retains the observed entry across this tab's internal navigation.
const homeUrl = "https://cooleryu.github.io/ContextAdapt/";
const storage = tabStorage();
let now = 2_000_000;
page({ canonical: homeUrl, url: `${homeUrl}?utm_source=chatgpt&email=private@example.com#ignored`,
  referrer: "https://chatgpt.com/c/private-query", storage, now: () => now });
const fromHome = page({ referrer: homeUrl, storage, now: () => now });
for (const item of [fromHome.calls[0], (fromHome.activate(), fromHome.calls.at(-1))]) {
  assert.equal(item.data.entry_page, "/ContextAdapt/");
  assert.equal(item.data.entry_source, "utm:chatgpt");
  assert.equal(item.data.entry_utm_source, "chatgpt");
  assert.equal(item.data.entry_scope, "tab-30m");
  assert.equal(item.data.entry_context, JSON.stringify(["utm:chatgpt", "/ContextAdapt/", "tab-30m"]));
  assert.ok(!JSON.stringify(item.data).includes("private"));
}
const external = page({ referrer: "https://www.google.com/search?q=private", storage, now: () => now });
assert.equal(external.calls[0].data.entry_page, new URL(articleUrl).pathname);
assert.equal(external.calls[0].data.entry_source, "www.google.com");
assert.equal(external.calls[0].data.entry_utm_source, undefined);
const campaign = page({ url: `${articleUrl}?utm_source=github`, referrer: homeUrl, storage, now: () => now });
assert.equal(campaign.calls[0].data.entry_source, "utm:github");
now += 30 * 60 * 1000;
campaign.activate();
assert.equal(JSON.parse(storage.getItem("contextadapt.entry.v1")).lastAt, now);
const expiredStorage = tabStorage();
page({ canonical: homeUrl, url: homeUrl, referrer: "https://bing.com/", storage: expiredStorage, now: () => now });
now += 30 * 60 * 1000;
const expired = page({ referrer: homeUrl, storage: expiredStorage, now: () => now });
assert.equal(expired.calls[0].data.entry_page, new URL(articleUrl).pathname);
assert.equal(expired.calls[0].data.entry_source, "unknown");
for (const storageFailure of [
  { getItem: () => { throw new Error("blocked"); } },
  { getItem: () => null, setItem: () => { throw new Error("quota"); } },
]) {
  const fallback = page({ storage: storageFailure, referrer: homeUrl });
  fallback.activate();
  for (const item of fallback.calls) {
    assert.equal(item.data.entry_scope, "page");
    assert.equal(item.data.entry_source, "unknown");
    assert.equal(item.data.entry_context, JSON.stringify(["unknown", new URL(articleUrl).pathname, "page"]));
  }
}
const unsafeUtm = page({ url: `${articleUrl}?utm_source=private%40example.com#fragment` });
assert.equal(unsafeUtm.calls[0].data.entry_source, "unknown");
assert.equal(unsafeUtm.calls[0].data.entry_utm_source, undefined);
for (const url of ["https://other.example/ContextAdapt/", "https://cooleryu.github.io/Other/"]) {
  const excluded = page({ url, storage: { getItem: () => assert.fail("storage read outside project") } });
  assert.equal(excluded.calls.length, 0);
  assert.equal(excluded.listeners.size, 0);
}
await new Promise(resolve => setImmediate(resolve));
console.log(`EVENT_CHECKS=passed HTML_FILES=${htmlFiles.length} ARTICLE_PAGES=${articlePages} NETWORK_REQUESTS=0`);
