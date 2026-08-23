# Changelog

## 0.2.0

- Migrated the product runtime, CLI, Codex adapter, semantic analyzer, action gate, relation verifier, and executor guard to strict TypeScript.
- Added a native in-process Oh My Pi / OMP extension.
- Added npm package exports for the core, Codex, and OMP integrations.
- Added runtime JSON Schema, Node.js 22/24 CI, fresh-tarball installation checks, and formatting enforcement.
- Preserved Python v0.1 under `research/python` and added byte/structure-level cross-language golden tests.
- Added a reproducible live Luna long-context experiment with 200K, 400K, and 1M-window tiers, deterministic causal-context cases, sanitized raw results, separate exact/safety scoring, and documented host boundary probes.

## 0.1.0

- First public Python release with the stale-action demo, provenance-aware trace gate, Codex adapter, hybrid semantic relation protocol, and executor hooks.
