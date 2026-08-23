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
- [x] One unified action gate shared by deterministic and hybrid relation paths.
- [x] Deterministic executor guard compiled from an accepted semantic relation.
- [x] Native pre-tool integrations for Codex and OMP with paired BLOCK/ALLOW
      file-state verification.

## P1: after the first useful release

- [ ] Additional Agent adapters behind the same trace contract.
- [ ] Paired replay command with pluggable model adapters.
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
