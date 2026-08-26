# First public release checklist

## P0: required before publishing

- [x] Choose the final public project and package name after checking GitHub,
      PyPI, npm, and adjacent Agent tooling.
- [x] Use Apache-2.0 and include the exact license file and package metadata.
- [x] Configure private vulnerability reporting and replace the placeholder in
      `SECURITY.md`.
- [x] Create a clean Git repository and verify that no secrets or private
      artifacts exist in its history.
- [x] Run CI on Node.js 22 and 24, plus the frozen Python oracle.
- [x] Confirm a fresh npm tarball install and the public seven-event example.

## P0: useful product, not only a research demo

- [x] Zero-dependency local diagnostic CLI.
- [x] Versioned public JSONL trace format.
- [x] Provenance-aware current-state and successful/failed observation lanes.
- [x] Stale-action and protected-permission diagnostics.
- [x] Machine-readable ContextSnapshot output.
- [x] Minimal example, contributor evidence rules, and regression tests.
- [x] Zero-configuration `contextadapt demo` with an explicit synthetic-evidence label.
- [x] `contextadapt check` PASS/BLOCK execution gate with CI-friendly exit status.
- [x] One real, privacy-safe adapter for a commonly used coding Agent trace.
- [x] Redaction rules and tests for that adapter.
- [x] Golden end-to-end fixture produced by the adapter rather than hand-written
      JSONL.
- [x] Field-level AI relation proposal with exact raw-event evidence.
- [x] Separate semantic review record bound to an immutable proposal digest;
      true run independence still requires a trusted host orchestrator.
- [x] Deterministic fail-closed checks for chronology, scope, evidence,
      structured facts, reviewer agreement, and unresolved fields.
- [x] Explicit two-Luna semantic orchestration through an existing Codex login,
      with host-derived run identities and no auto-accept on disagreement.
- [x] Separate task-Agent and review-model controls, with Luna as the tested
      low-cost reviewer default and fail-closed behavior for overrides.
- [x] One unified action gate shared by deterministic and hybrid relation paths.
- [x] Deterministic executor guard compiled from an accepted semantic relation.
- [x] Native pre-tool integrations for Codex and OMP with paired BLOCK/ALLOW
      file-state verification.
- [x] One-install OMP host path through the native plugin registry, with
      discovery read-back and a normal `omp` user flow.
- [x] OMP integration coverage for zero semantic preflight before a short first
      request, lazy two-Luna review before mutation, wrong-value BLOCK, and a
      verified correct write.
- [x] Automatic two-Luna task/update capture with deterministic disagreement,
      provenance, permission, and scope checks.
- [x] Host-recorded successful/failed tool state plus evidence token spans, with
      no user-authored evidence manifest.
- [x] Pre-Agent 200K/400K/1M-window selection in controlled Codex history and
      OMP's native context lifecycle.
- [x] Semantic preflight, estimated hidden overhead, actual provider input, and
      runtime latency recorded as separate cost lines.
- [x] Runtime target allow-list: even a non-protected file is blocked when it is
      outside the current reviewed task.
- [x] One target-bound read-only stale-scalar recovery in Codex and OMP, with a
      hard one-recovery budget and a mandatory second action-gate decision.
- [x] Paper-informed accounting for retrieval, execution, repeats, direct
      recovery cost, paired excess reacquisition, and current-state outcome.
- [x] Active-working-set contract keeps desired task state separate from the
      observed pre-action environment and rejects writable recovery handles.
- [x] OMP lifecycle recovery coverage with a deterministic provider.
- [x] Recovery-triggered Codex host-boundary coverage, explicitly separated
      from natural model failure-rate claims.
- [x] No-manifest same-state shadow replay for Codex plus an exact OMP native
      context snapshot, with deterministic task/safety verification and
      write-gate attestation.
- [x] Opt-in Codex passive mode with zero primary-run model calls or gates,
      private mode-0600 thread references, pre-write snapshots, post-run App
      Server reading, outcome-leakage exclusion, and causal isolated replay.
- [x] Provider-native App Server boundary instrumentation, with requested
      window, effective window, and actual input kept separate.
- [ ] Complete the frozen ordinary-task cohort with natural 200K, 400K,
      large-tier, safe-block, and null rows plus one OMP passive row. The Codex
      engineering slice is accepted; this empirical evidence item remains open.

## P1: after the first useful release

- [ ] Additional Agent adapters behind the same trace contract.
- [x] First paired Codex replay command; additional pluggable model adapters
      remain P1.
- [ ] HTML or terminal visualization of provenance and supersession links.
- [ ] Consent-aware collection of real failure traces.
- [ ] A held-out evaluation suite spanning multiple failure families.

## Evidence language

The release must distinguish:

- actual model input length from configured client context limits;
- missing context from still-visible but mis-bound context;
- deterministic fixture results from live model decisions;
- model-decision failures from runtime/infrastructure failures;
- behavioral evidence from claims about internal attention.
