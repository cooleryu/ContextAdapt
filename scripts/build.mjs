import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const siteUrl = "https://cooleryu.github.io/ContextAdapt";
const repoUrl = "https://github.com/cooleryu/ContextAdapt";

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inline(value) {
  let out = escapeHtml(value);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) return { meta: {}, body: markdown };
  const end = markdown.indexOf("\n---\n", 4);
  const raw = markdown.slice(4, end);
  const meta = {};
  for (const line of raw.split("\n")) {
    const split = line.indexOf(":");
    if (split === -1) continue;
    meta[line.slice(0, split).trim()] = line.slice(split + 1).trim();
  }
  return { meta, body: markdown.slice(end + 5) };
}

function renderMarkdown(markdown, { removeLead = false } = {}) {
  let source = markdown.replaceAll("\r\n", "\n");
  if (removeLead) {
    source = source.replace(/^\s*# .+\n\n> .+\n\n/, "");
  }
  const lines = source.split("\n");
  const html = [];
  const toc = [];
  let index = 0;

  const isBoundary = (line, next = "") =>
    line.trim() === "" ||
    /^#{1,3} /.test(line) ||
    /^> /.test(line) ||
    /^[-*] /.test(line) ||
    /^\d+\. /.test(line) ||
    /^```/.test(line) ||
    /^---$/.test(line) ||
    (line.startsWith("|") && /^\|?\s*:?-+/.test(next));

  while (index < lines.length) {
    const line = lines[index];
    const next = lines[index + 1] ?? "";

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      html.push(`<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2];
      const id = slugify(title) || `section-${index}`;
      if (level === 2) toc.push({ id, title: title.replaceAll("**", "") });
      html.push(`<h${level} id="${id}">${inline(title)}</h${level}>`);
      index += 1;
      continue;
    }

    if (line.startsWith("> ")) {
      const quote = [];
      while (index < lines.length && lines[index].startsWith("> ")) {
        quote.push(lines[index].slice(2));
        index += 1;
      }
      html.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
      continue;
    }

    if (/^[-*] /.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*] /.test(lines[index])) {
        items.push(lines[index].replace(/^[-*] /, ""));
        index += 1;
      }
      html.push(`<ul>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\d+\. /.test(line)) {
      const items = [];
      while (index < lines.length && /^\d+\. /.test(lines[index])) {
        items.push(lines[index].replace(/^\d+\. /, ""));
        index += 1;
      }
      html.push(`<ol>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ol>`);
      continue;
    }

    if (line.startsWith("|") && /^\|?\s*:?-+/.test(next)) {
      const rows = [];
      rows.push(line);
      index += 2;
      while (index < lines.length && lines[index].startsWith("|")) {
        rows.push(lines[index]);
        index += 1;
      }
      const parseRow = (row) => row.slice(1, row.endsWith("|") ? -1 : undefined).split("|").map((cell) => cell.trim());
      const [head, ...body] = rows.map(parseRow);
      html.push(`<div class="table-wrap"><table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }

    if (line.trim() === "---") {
      html.push("<hr>");
      index += 1;
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && !isBoundary(lines[index], lines[index + 1] ?? "")) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }

  return { html: html.join("\n"), toc };
}

function header(prefix = "") {
  return `<a class="skip-link" href="#content">Skip to content</a>
  <header class="site-header">
    <a class="brand" href="${prefix || "./"}"><strong>cooleryu</strong><span>Field Notes</span></a>
    <nav class="site-nav" aria-label="Primary">
      <a href="${prefix || "./"}#writing">Writing</a>
      <a href="${prefix}evidence/">Evidence</a>
      <a href="${repoUrl}">GitHub ↗</a>
    </nav>
  </header>`;
}

function footer(prefix = "") {
  return `<footer class="site-footer"><div class="footer-inner">
    <div><p><strong>Evidence before claims.</strong></p><p class="footer-note">AI agent reliability · context management · execution-time verification</p></div>
    <p><a href="${repoUrl}">ContextAdapt</a> · <a href="${prefix}feed.xml">RSS</a></p>
  </div></footer>`;
}

function shell({ title, description, canonical, prefix = "", body, type = "website", jsonLd }) {
  const image = `${siteUrl}/assets/cooleryu-open-source.png`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="author" content="cooleryu">
  <meta name="theme-color" content="#f3ecd9">
  <link rel="canonical" href="${canonical}">
  <link rel="alternate" type="application/rss+xml" title="cooleryu Field Notes" href="${siteUrl}/feed.xml">
  <meta property="og:type" content="${type}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${image}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="420">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${image}">
  <link rel="stylesheet" href="${prefix}assets/site.css">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
  ${body}
</body>
</html>`;
}

const articleRaw = fs.readFileSync(path.join(root, "source/how-much-code-context.md"), "utf8");
const { meta: article, body: articleBody } = parseFrontmatter(articleRaw);
const renderedArticle = renderMarkdown(articleBody, { removeLead: true });
const articlePath = `/articles/${article.slug}/`;
const articleUrl = `${siteUrl}${articlePath}`;
const articlePrefix = "../../";
const tocHtml = renderedArticle.toc.map((item, i) => `<li><a href="#${item.id}">${String(i + 1).padStart(2, "0")} · ${escapeHtml(item.title)}</a></li>`).join("");

const articlePage = shell({
  title: `${article.title} — cooleryu`,
  description: article.description,
  canonical: articleUrl,
  prefix: articlePrefix,
  type: "article",
  jsonLd: {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: article.title,
    alternativeHeadline: article.subtitle,
    description: article.description,
    datePublished: article.date,
    dateModified: article.updated,
    inLanguage: "en",
    mainEntityOfPage: articleUrl,
    author: { "@type": "Person", name: article.author, url: "https://github.com/cooleryu" },
    publisher: { "@type": "Person", name: article.author, url: "https://github.com/cooleryu" },
    about: { "@type": "SoftwareSourceCode", name: "ContextAdapt", codeRepository: repoUrl, programmingLanguage: "TypeScript" }
  },
  body: `${header(articlePrefix)}
  <main id="content">
    <section class="article-hero"><div class="article-hero-inner">
      <div><p class="eyebrow">ContextAdapt Research Note · 001</p><h1>${escapeHtml(article.title)}</h1><p class="article-subtitle">${escapeHtml(article.subtitle)}</p><div class="article-meta"><span>${article.date}</span><span>By ${article.author}</span><span>English edition</span></div></div>
      <aside class="claim-card"><strong>Evidence level</strong><code>${escapeHtml(article.evidence)}</code><p>Evidence retention on held-out real code. Not yet a task-success or cost-reduction claim.</p></aside>
    </div></section>
    <div class="article-layout">
      <aside class="toc" aria-label="Table of contents"><strong>On this page</strong><ol>${tocHtml}</ol></aside>
      <article class="prose">${renderedArticle.html}</article>
    </div>
  </main>
  ${footer(articlePrefix)}`
});

const homePage = shell({
  title: "ContextAdapt — AI Agent Reliability Field Notes by cooleryu",
  description: "Open research notes on context management, reproducible agent failures, and execution-time verification. Building ContextAdapt.",
  canonical: `${siteUrl}/`,
  prefix: "",
  jsonLd: {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", name: "cooleryu Field Notes", url: `${siteUrl}/`, inLanguage: "en" },
      { "@type": "Person", name: "cooleryu", url: "https://github.com/cooleryu", knowsAbout: ["AI agent reliability", "context management", "tool calling", "observability"] },
      { "@type": "SoftwareSourceCode", name: "ContextAdapt", description: "Help every Agent use the smallest context that can still act safely.", codeRepository: repoUrl, programmingLanguage: "TypeScript", license: "https://www.apache.org/licenses/LICENSE-2.0" }
    ]
  },
  body: `${header("")}
  <main id="content">
    <section class="hero"><div class="hero-inner">
      <div><p class="eyebrow">Open source · AI agent reliability · MMXXVI</p><h1>Make the context <em>answerable.</em></h1><p class="hero-deck">I study the moment an AI agent turns context into action: what evidence survived, what it actually used, and whether that evidence is still current before a tool touches the world.</p><div class="hero-actions"><a class="button" href="articles/${article.slug}/">Read the first note</a><a class="button secondary" href="${repoUrl}">Explore ContextAdapt ↗</a></div></div>
      <aside class="edition-card"><span class="number">01</span><p>One claim. One frozen protocol. One evidence boundary the reader can inspect.</p></aside>
    </div></section>
    <section class="section"><p class="section-label">Position</p><div class="manifesto-grid"><div><h2>Long context is a capacity. Reliability is a chain of evidence.</h2></div><div class="manifesto-copy"><p>ContextAdapt is an open-source project for identifying smaller context candidates without silently discarding action-critical evidence—and for checking goal, permission, and provenance again before execution.</p><div class="principles"><div class="principle"><b>I</b><span>Preserve exact evidence before summarizing it.</span></div><div class="principle"><b>II</b><span>Separate what entered the context from what the agent verified.</span></div><div class="principle"><b>III</b><span>Let experiments shrink the claim, not decorate it.</span></div></div></div></div></section>
    <section class="section" id="guides"><p class="section-label">Practical guide · English / 中文</p><div class="article-copy"><h2>Choosing context length for AI coding agents</h2><p>Start with the evidence your task needs. Compare 200K and 1M, measure full cost, and verify the result. Eight practical questions, with examples and the limits of our published evidence.</p><div class="hero-actions"><a class="button" href="guides/choosing-context-length-for-coding-agents/">Read the English guide →</a><a class="button secondary" href="guides/choosing-context-length-for-coding-agents/zh-CN/" lang="zh-CN">阅读中文指南 →</a></div></div></section>
    <section class="section" id="context-help"><p class="section-label">Context troubleshooting · English / 中文</p><div class="article-copy"><h2>Why does Codex show 258K? Getting the 500K default to take effect</h2><p>Separate the 258K display, the 500K default and the compaction threshold; check overrides and configure the window with documented settings.</p><div class="hero-actions"><a class="button" href="articles/codex-258k-context/" lang="en">Read the English answer →</a><a class="button secondary" href="articles/codex-258k-context/zh-CN/" lang="zh-CN">258K / 500K：阅读中文解答 →</a></div></div></section>
    <section class="section" id="new-notes"><p class="section-label">New notes · English / 中文</p><div class="manifesto-grid"><div class="article-copy"><h2>Codex at 500K: more room, but check the state before writing</h2><p>Start with the default, restore missing evidence, and check the current target, file state, and permission before writing.</p><div class="hero-actions"><a class="button" href="articles/codex-500k-context/">Read in English →</a><a class="button secondary" href="articles/codex-500k-context/zh-CN/" lang="zh-CN">阅读中文快评 →</a></div></div><div class="article-copy"><h2>计划没有错，世界已经变了：为什么长时程 Agent 的上下文问题最终会变成执行问题</h2><p>一篇基于近期研究、受控实验与真实执行器集成的迷你综述：长上下文失败不只是遗忘，更可能是 Agent 在执行时仍依赖已经过期的事实与权限。</p><div class="hero-actions"><a class="button" href="articles/the-plan-was-valid/en/" lang="en">Read the English research note →</a><a class="button secondary" href="articles/the-plan-was-valid/" lang="zh-CN">阅读中文研究笔记 →</a></div></div></div></section>
    <section class="section" id="writing"><p class="section-label">Latest field note</p><div class="feature-article"><div class="result-panel"><small>Held-out result</small><p class="metric">+22.4</p><p>percentage points over head-and-tail truncation in strict code-evidence retention.</p><p><small>95% CI · +2.4 to +40.6</small></p></div><div class="article-copy"><h2>${escapeHtml(article.title)}</h2><div class="meta-row"><span class="tag">2,160 cells</span><span class="tag">30 holdout tasks</span><span class="tag">12 repositories</span></div><p>Can a coding agent use less context without losing the evidence needed to act? This note reports a controlled retention result, the baselines that remained competitive, and the eight tasks that still required full source.</p><a class="button" href="articles/${article.slug}/">Read the evidence →</a></div></div></section>
  </main>
  ${footer("")}`
});

const evidencePage = shell({
  title: "Evidence Package — ContextAdapt",
  description: "Frozen protocol, result ledger, evidence label, and reproduction links for ContextAdapt's first real-code retention holdout.",
  canonical: `${siteUrl}/evidence/`,
  prefix: "../",
  jsonLd: { "@context": "https://schema.org", "@type": "Dataset", name: "ContextAdapt real-code retention holdout evidence package", description: "Frozen protocol and result ledger for 2,160 held-out evaluation cells.", creator: { "@type": "Person", name: "cooleryu" }, datePublished: article.date, url: `${siteUrl}/evidence/`, license: "https://www.apache.org/licenses/LICENSE-2.0" },
  body: `${header("../")}<main id="content"><section class="article-hero"><div class="article-hero-inner"><div><p class="eyebrow">Frozen evidence package</p><h1>Claims you can inspect.</h1><p class="article-subtitle">The protocol and result ledger behind the first ContextAdapt real-code retention holdout.</p></div><aside class="claim-card"><strong>Current label</strong><code>${escapeHtml(article.evidence)}</code><p>Not task success. Not a provider-billing result.</p></aside></div></section><div class="article-layout"><aside class="toc"><strong>Package</strong><ol><li><a href="p0-results/">01 · Rendered result ledger</a></li><li><a href="p0-results.md">02 · Raw Markdown ledger</a></li><li><a href="protocol-v3.json">03 · Frozen JSON protocol</a></li></ol></aside><article class="prose"><p>The holdout contains 30 tasks from 12 repositories, nine context policies, eight source budgets, and 2,160 evaluation cells. Gold patches were evaluator-only.</p><div class="evidence-banner"><strong>Direct result:</strong> ContextAdapt exceeded head-and-tail truncation by 22.4 percentage points in strict evidence retention across the seven compressed budgets. Its 7.1-point difference over lexical intent retrieval was inconclusive.</div><h2>Evidence files</h2><ul><li><a href="p0-results/">Read the full result ledger as HTML</a></li><li><a href="p0-results.md">Download the executed Markdown ledger</a></li><li><a href="protocol-v3.json">Inspect the frozen protocol</a></li><li><a href="${repoUrl}/issues">Open a methodological question</a></li></ul><h2>Interpretation boundary</h2><p>This package evaluates evidence retention under source budgets. It does not demonstrate patch generation, passing tests, end-to-end task success, or realized provider savings.</p></article></div></main>${footer("../")}`
});

const ledgerRaw = fs.readFileSync(path.join(root, "evidence/p0-results.md"), "utf8");
const ledgerRendered = renderMarkdown(ledgerRaw);
const ledgerPage = shell({
  title: "P0 Result Ledger — ContextAdapt",
  description: "Full executed ledger for ContextAdapt's verification-allocation and exact-span real-code retention experiment.",
  canonical: `${siteUrl}/evidence/p0-results/`,
  prefix: "../../",
  jsonLd: { "@context": "https://schema.org", "@type": "Dataset", name: "ContextAdapt P0 result ledger", datePublished: article.date, creator: { "@type": "Person", name: "cooleryu" }, url: `${siteUrl}/evidence/p0-results/` },
  body: `${header("../../")}<main id="content"><section class="article-hero"><div class="article-hero-inner"><div><p class="eyebrow">Executed ledger · preserved verbatim</p><h1>P0 result ledger.</h1><p class="article-subtitle">The detailed results, ablations, checks, and evidence boundary behind the public research note.</p></div></div></section><div class="article-layout"><aside class="toc"><strong>Source</strong><ol><li><a href="../p0-results.md">Raw Markdown</a></li><li><a href="../protocol-v3.json">Frozen protocol</a></li><li><a href="../">Evidence index</a></li></ol></aside><article class="prose">${ledgerRendered.html}</article></div></main>${footer("../../")}`
});

function write(relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content.endsWith("\n") ? content : `${content}\n`);
}

// Keep Search Console ownership verification on the homepage after rebuilds.
write("index.html", homePage.replace("</head>", '  <meta name="google-site-verification" content="NBRywqYk3WSaD1XeLZFhCW5BSrJxVmH_-rRW4QGR8dU" />\n</head>'));
write(`articles/${article.slug}/index.html`, articlePage);
write("evidence/index.html", evidencePage);
write("evidence/p0-results/index.html", ledgerPage);
write("404.html", homePage.replace("<title>", "<title>Not found — "));
write(".nojekyll", "");
write("robots.txt", `User-agent: OAI-SearchBot\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`);
write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${siteUrl}/</loc><lastmod>2026-10-10</lastmod></url>\n  <url><loc>${articleUrl}</loc><lastmod>${article.updated}</lastmod></url>\n  <url><loc>${siteUrl}/evidence/</loc><lastmod>${article.updated}</lastmod></url>\n  <url><loc>${siteUrl}/evidence/p0-results/</loc><lastmod>${article.updated}</lastmod></url>\n  <url><loc>https://cooleryu.github.io/ContextAdapt/guides/choosing-context-length-for-coding-agents/</loc><lastmod>2026-10-10</lastmod></url>\n  <url><loc>https://cooleryu.github.io/ContextAdapt/guides/choosing-context-length-for-coding-agents/zh-CN/</loc><lastmod>2026-10-10</lastmod></url>\n  <url><loc>https://cooleryu.github.io/ContextAdapt/articles/codex-500k-context/</loc><lastmod>2026-10-14</lastmod></url>\n  <url><loc>https://cooleryu.github.io/ContextAdapt/articles/codex-500k-context/zh-CN/</loc><lastmod>2026-10-14</lastmod></url>\n  <url><loc>https://cooleryu.github.io/ContextAdapt/articles/the-plan-was-valid/</loc><lastmod>2026-10-14</lastmod></url>\n  <url><loc>https://cooleryu.github.io/ContextAdapt/articles/the-plan-was-valid/en/</loc><lastmod>2026-10-14</lastmod></url>\n  <url><loc>https://cooleryu.github.io/ContextAdapt/articles/codex-258k-context/</loc><lastmod>2026-10-15</lastmod></url>\n  <url><loc>https://cooleryu.github.io/ContextAdapt/articles/codex-258k-context/zh-CN/</loc><lastmod>2026-10-15</lastmod></url>\n</urlset>\n`);
write("feed.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>cooleryu Field Notes</title><link>${siteUrl}/</link><description>Research notes on AI agent reliability and ContextAdapt.</description><language>en</language><item><title>${escapeHtml(article.title)}</title><link>${articleUrl}</link><guid>${articleUrl}</guid><pubDate>Wed, 02 Sep 2026 00:00:00 GMT</pubDate><description>${escapeHtml(article.description)}</description></item><item><title>Codex at 500K: more room, but check the state before writing</title><link>https://cooleryu.github.io/ContextAdapt/articles/codex-500k-context/</link><guid>https://cooleryu.github.io/ContextAdapt/articles/codex-500k-context/</guid><pubDate>Tue, 13 Oct 2026 16:00:00 GMT</pubDate><description>Start with the default, restore missing evidence, and check the current target, file state, and permission before writing.</description></item><item><title>Codex 默认 500K 之后：少压缩，不等于少犯错</title><link>https://cooleryu.github.io/ContextAdapt/articles/codex-500k-context/zh-CN/</link><guid>https://cooleryu.github.io/ContextAdapt/articles/codex-500k-context/zh-CN/</guid><pubDate>Tue, 13 Oct 2026 16:00:00 GMT</pubDate><description>先用默认窗口，找准缺失的材料，并在写入前确认目标、文件状态和权限是否仍然有效。</description></item><item><title>计划没有错，世界已经变了：为什么长时程 Agent 的上下文问题最终会变成执行问题</title><link>https://cooleryu.github.io/ContextAdapt/articles/the-plan-was-valid/</link><guid>https://cooleryu.github.io/ContextAdapt/articles/the-plan-was-valid/</guid><pubDate>Tue, 13 Oct 2026 16:00:00 GMT</pubDate><description>一篇基于近期研究、受控实验与真实执行器集成的迷你综述：长上下文失败不只是遗忘，更可能是 Agent 在执行时仍依赖已经过期的事实与权限。</description></item><item><title>The Plan Was Valid. The World Had Changed: Why Context Problems in Long-Horizon Agents Become Execution Problems</title><link>https://cooleryu.github.io/ContextAdapt/articles/the-plan-was-valid/en/</link><guid>https://cooleryu.github.io/ContextAdapt/articles/the-plan-was-valid/en/</guid><pubDate>Tue, 13 Oct 2026 16:00:00 GMT</pubDate><description>A short review of recent research, controlled experiments, and executor integration: long-context failures are not only about forgetting. Agents may act on facts and permissions that have already expired.</description></item><item><title>Why does Codex show 258K? Getting the 500K default to take effect</title><link>https://cooleryu.github.io/ContextAdapt/articles/codex-258k-context/</link><guid>https://cooleryu.github.io/ContextAdapt/articles/codex-258k-context/</guid><pubDate>Wed, 14 Oct 2026 16:00:00 GMT</pubDate><description>Separate the 258K display, the 500K default and the compaction threshold; check overrides and configure the window with documented settings.</description></item><item><title>Codex 为什么显示 258K？默认 500K 怎么生效</title><link>https://cooleryu.github.io/ContextAdapt/articles/codex-258k-context/zh-CN/</link><guid>https://cooleryu.github.io/ContextAdapt/articles/codex-258k-context/zh-CN/</guid><pubDate>Wed, 14 Oct 2026 16:00:00 GMT</pubDate><description>分清 258K 显示值、500K 默认窗口和自动压缩阈值，检查模型与配置覆盖，并用官方配置项手动设置。</description></item></channel></rss>\n`);
write("llms.txt", `# cooleryu Field Notes\n\nResearch notes on AI agent reliability, context management, and execution-time verification.\n\n## Primary project\n- ContextAdapt: ${repoUrl}\n- Description: Help every Agent use the smallest context that can still act safely.\n\n## Published article\n- ${article.title}: ${articleUrl}\n- Evidence level: ${article.evidence}\n- Direct result: +22.4 percentage points over head-and-tail truncation in strict held-out code-evidence retention.\n- Boundary: this is not yet an end-to-end task-success, shortest-safe-tier, or provider-cost claim.\n\n## Evidence\n- Package: ${siteUrl}/evidence/\n- Result ledger: ${siteUrl}/evidence/p0-results/\n- Frozen protocol: ${siteUrl}/evidence/protocol-v3.json\n\n## Additional articles\n- Codex at 500K: more room, but check the state before writing (en): https://cooleryu.github.io/ContextAdapt/articles/codex-500k-context/\n- Codex 默认 500K 之后：少压缩，不等于少犯错 (zh-CN): https://cooleryu.github.io/ContextAdapt/articles/codex-500k-context/zh-CN/\n- 计划没有错，世界已经变了：为什么长时程 Agent 的上下文问题最终会变成执行问题 (zh-CN): https://cooleryu.github.io/ContextAdapt/articles/the-plan-was-valid/\n- The Plan Was Valid. The World Had Changed: Why Context Problems in Long-Horizon Agents Become Execution Problems (en): https://cooleryu.github.io/ContextAdapt/articles/the-plan-was-valid/en/\n- Boundaries: the 500K commentary does not evaluate Codex 500K; the execution note describes historical, scoped prototype evidence.\n\n## Codex context troubleshooting\n- Why does Codex show 258K? Getting the 500K default to take effect (en): https://cooleryu.github.io/ContextAdapt/articles/codex-258k-context/\n- Codex 为什么显示 258K？默认 500K 怎么生效 (zh-CN): https://cooleryu.github.io/ContextAdapt/articles/codex-258k-context/zh-CN/\n`);

console.log(`Built ${articleUrl}`);
