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
