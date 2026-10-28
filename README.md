# ContextAdapt GitHub Pages

This branch contains the static research site and bilingual practical guides published at:

<https://cooleryu.github.io/ContextAdapt/>

## Contents

- `source/how-much-code-context.md`: the authoritative English article source.
- `evidence/p0-results.md`: byte-identical snapshot of the executed result ledger.
- `evidence/protocol-v3.json`: byte-identical snapshot of the frozen holdout protocol.
- `scripts/build.mjs`: dependency-free static site builder.
- `scripts/check.mjs`: local-link and required-claim validation.

Rebuild and validate with Node.js 22 or later:

```bash
node scripts/build.mjs
node scripts/check.mjs
```

`OAI-SearchBot` is allowed for ChatGPT search discovery. `GPTBot` is disallowed
on this publishing branch so search visibility does not silently decide the
separate model-training preference.

The current public evidence label is `REAL_CODE_RETENTION_HOLDOUT`. It is not a
claim of end-to-end task success, a discovered shortest-safe provider tier, or
realized provider savings.

## Practical guides

The approved English and Chinese guides are published under `guides/choosing-context-length-for-coding-agents/`. Their Markdown sources are in `source/guides/`. The guide HTML files are checked-in static pages; the existing builder preserves them and rebuilds their homepage entrances and sitemap entries. Their prose must stay aligned with their Markdown sources when edited. The original research article and evidence files were preserved byte-for-byte during guide publication.

## Analytics events

`scripts/tracker.mjs` installs Umami and `assets/site-events.js`, including on future builder output. `article_view` records opening a canonical page under `/ContextAdapt/articles/`; it does not mean the article was read. Language variants share `article_id` and retain their own `content_language`. The practical guides are not included in this first article cohort.

`github_click` records primary, keyboard, modified, and middle-click activations of `https://github.com/cooleryu/ContextAdapt` and its repository subpaths, without changing navigation. Its `destination` excludes query strings and fragments. Other GitHub repositories are excluded. Tracker blocking or network failure can leave visits or clicks unobserved.

Both events include `entry_page` (canonical path, falling back to the current path), `entry_source`, `entry_scope`, and `entry_context` (the JSON array `[entry_source, entry_page, entry_scope]` for a combined funnel breakdown). A recognized `utm_source` takes priority as `entry_source="utm:<label>"` and is also kept as `entry_utm_source`; otherwise the source is the external referrer's hostname or `unknown`. Missing referrer is not classified as direct traffic. The pilot accepts only these UTM labels: `github`, `google`, `bing`, `chatgpt`, `perplexity`, `claude`, `gemini`, `doubao`, `deepseek`, `kimi`, `qwen`, `hunyuan`, `baidu`, `x`, `twitter`, `reddit`, `wechat`, `zhihu`, and `newsletter`. Other UTM values are omitted, so this is not complete campaign recognition. Full queries, fragments, referrer paths, and arbitrary campaign text are not stored in the entry context.

The entry is kept in `sessionStorage` only for `https://cooleryu.github.io/ContextAdapt/`. An observed internal referral continues it; a new external or missing referrer, recognized UTM, or 30 minutes without a page opening or tracked repository click resets it. `entry_scope="tab-30m"` means this tab-local rule, not Umami's visit definition. If storage is unavailable, the current page supplies the context with `entry_scope="page"`; cross-page attribution is then unavailable. The stored object contains only the entry fields and `lastAt`, with no cookie, visitor ID, or session ID. Umami's native page URL, referrer, and campaign data remain available separately.

Run `node scripts/check-events.mjs` for isolated event checks with a mocked tracker and no network requests. The existing `node scripts/check.mjs` checks local links and required article claims.
