# Changelog

## 0.2.0

- Separated the task Agent from the two task-state reviewers. Codex now exposes
  `--review-model`, OMP supports `CONTEXTADAPT_REVIEW_MODEL`, and both keep Luna
  as the tested low-cost default while recording the reviewer model in task
  provenance.
- Added `install-host omp`, an OMP package manifest, native plugin-registry
  read-back, and the ordinary one-install-then-run-`omp` product path.
- Added a zero-preflight short-history path: OMP keeps complete histories that
  already fit 200K and delays two-Luna task capture until the first mutation.
- Added a fail-closed 200K fallback when OMP omits active-model metadata,
  separate raw-window/output-reserve accounting, and append-only runtime
  decision history.
- Tightened the first-task scalar executor contract so an Agent cannot replace
  the observed value with an arbitrary third value instead of the reviewed
  desired value.
- Added public OMP integration tests for native discovery, lazy two-reviewer
  task capture, wrong-value blocking, correct-value allowance, and protected
  file preservation.
- Added the live P0 pipeline for Codex and OMP: two independent Luna task captures, field-level provenance, automatic target preflight, model-visible token positions, 200K/400K/1M selection before the task Agent, semantic-preflight cost accounting, and real pre-tool write gates.
- Added `install-host codex`, `run-codex`, the Codex lifecycle recorder, and an OMP extension that owns `before_agent_start`, `context`, `tool_result`, and `tool_call`.
- Added the first P0 `contextadapt recommend` slice: automatic evidence mapping from host-instrumented traces, a fail-closed selector for 200K, 400K, 1M-window, or block, four-line default output, and full prior-attempt cost accounting.
- Migrated the product runtime, CLI, Codex adapter, semantic analyzer, action gate, relation verifier, and executor guard to strict TypeScript.
- Added a native in-process Oh My Pi / OMP extension.
- Added npm package exports for the core, Codex, and OMP integrations.
- Added runtime JSON Schema, Node.js 22/24 CI, fresh-tarball installation checks, and formatting enforcement.
- Preserved Python v0.1 under `research/python` and added byte/structure-level cross-language golden tests.
- Added a reproducible live Luna long-context experiment with 200K, 400K, and 1M-window tiers, deterministic causal-context cases, sanitized raw results, separate exact/safety scoring, and documented host boundary probes.
- Added bounded one-step read-only recovery and re-gating to Codex and OMP,
  paper-informed interaction-cost accounting, and fail-closed recovery tests.
- Added `shadow-codex`, isolated same-state replay, exact native-context OMP
  snapshots, and deterministic no-manifest JSON task verification.
- Added opt-in passive Codex cohort capture, mode-0600 private session
  references and pre-write snapshots, post-run App Server thread reading,
  outcome-leakage exclusion, and causal isolated replay. Small complete
  histories now return `NULL` with zero semantic calls.
- Added a provider-native App Server boundary probe that records requested and
  effective context windows separately from actual provider input.
- Added the frozen 25% paired-savings product bar to replay artifacts so a safe
  but immaterial token difference is labelled `VALIDATED_NO_SAVINGS` rather
  than `IMPROVED`.

## 0.1.0

- First public Python release with the stale-action demo, provenance-aware trace gate, Codex adapter, hybrid semantic relation protocol, and executor hooks.
