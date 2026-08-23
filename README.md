# ContextAdapt

[![CI](https://github.com/cooleryu/ContextAdapt/actions/workflows/ci.yml/badge.svg)](https://github.com/cooleryu/ContextAdapt/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](package.json)

**Help every Agent use the smallest context that can still act safely.**

Too little context can drop the current target, a corrected value, or a revoked permission. Too much context adds cost and latency without guaranteeing that the Agent will act from the right evidence. ContextAdapt's north star is to recommend the smallest safe context tier, then verify the resulting action before the real tool call.

Version 0.2 provides the evidence trace, relation engine, execution gate, Codex adapter, and OMP integration needed for that safety check. Dynamic `USE_200K` / `USE_400K` / `USE_1M_WINDOW` recommendation is the current P0 product work; it is not presented as finished. See the [product roadmap](docs/product-roadmap.md).

## First adaptive decision

The first P0 slice is runnable now:

```bash
npm run demo:recommend
```

```text
RECOMMENDATION       USE_400K
Smallest safe tier: 400K
Expected total input: 393,700 tokens
Always-largest baseline: 883,300 tokens
Estimated saving: 489,600 tokens (55.43%)

! 200K       missing policy-461, user-482
✓ 400K       safe
✓ 1M_WINDOW  safe

Execution gate: REQUIRED
```

The command fails closed with exit `2` when no tier has complete, current, authorized, contradiction-free evidence. It also includes previous failed attempts in total cost, so an expensive escalation can correctly report negative savings.

This slice consumes a host-authored evidence-coverage manifest such as [`examples/context-recommendation.json`](examples/context-recommendation.json). Automatic trace-to-evidence extraction and live adaptive execution remain P0 work; the CLI does not pretend they are already solved.

![ContextAdapt catches a stale Agent action before execution](docs/assets/contextadapt-stale-action.svg)

## The 10-second aha moment

```bash
git clone https://github.com/cooleryu/ContextAdapt.git
cd ContextAdapt
npm install
npm run demo
```

No API key or model call is needed. The demo shows:

```text
10  OLD      staging / timeout=30 / protected edit allowed
30  CURRENT  production / timeout=60 / protected edit forbidden
50  ACTION   staging/config.json / timeout=30 / protected edit

VERDICT  BLOCK
! CRITICAL  Protected edit has no current permission.
! HIGH      Action was built from superseded context.
```

That is ContextAdapt's first job: catch an action that still looks internally coherent but belongs to a context the user already replaced.

## Use it as an execution gate

```bash
npm run contextadapt -- check examples/stale-action.jsonl
```

The command returns:

- `PASS` and exit `0` when every candidate action is assessable and no supported risk is found;
- `BLOCK` and exit `2` for a detected stale/mis-bound action;
- `INSUFFICIENT_EVIDENCE` and exit `2` when provenance is missing.

It fails closed: no action, missing basis, unknown operation, missing target policy, or incomplete permission evidence can never silently become `PASS`.

## AI understands; engineering verifies

Natural-language changes cannot be reduced safely to string matching. ContextAdapt uses a hybrid protocol:

1. one AI run proposes a field-level relation between two context events;
2. a separate AI run reviews the same raw events;
3. deterministic TypeScript verifies chronology, entity binding, verbatim evidence, structured values, confidence, review digest, field agreement, permission authority, and unresolved fields;
4. an executor guard checks the actual patch/path/command immediately before a tool runs.

Run the transparent bundled fixture:

```bash
npm run contextadapt -- reconcile \
  examples/stale-action.jsonl \
  examples/relation-proposal.json \
  examples/relation-review.json \
  --action-event old-action-replay
```

Or explicitly ask two Luna runs through your existing Codex login:

```bash
npm run contextadapt -- analyze-codex \
  examples/stale-action.jsonl ticket-old ticket-current \
  --action-event old-action-replay \
  --allow-remote-content \
  --output-dir relation-run
```

The live path is opt-in because it sends the selected two events to Codex. A disagreement, missing provider identity, or incomplete turn is never accepted.

## Block the actual tool call

Compile an accepted relation into a small deterministic policy:

```bash
npm run contextadapt -- compile-guard \
  examples/stale-action.jsonl \
  examples/relation-proposal.json \
  examples/relation-review.json \
  --output .contextadapt/executor-guard.json
```

- **Codex:** the `PreToolUse` hook can deny a stale `apply_patch` or mutating shell command before execution.
- **Oh My Pi / OMP:** the native TypeScript extension can block stale `write`, `edit`, `bash`, `python`, or `notebook` calls in process.

See the [executor integration guide](docs/executor-integrations.md).

## Import a real Codex run

```bash
codex exec --json "Your task" > run.codex.jsonl
npm run contextadapt -- import-codex run.codex.jsonl --output run.contextadapt.jsonl
npm run contextadapt -- diagnose run.contextadapt.jsonl
```

Prompts, IDs, commands, outputs, errors, and Agent messages are fingerprinted and redacted by default. Use `--include-content` only for local evidence you have reviewed. A normal Codex stream does not expose an action's causal basis, so importing one alone correctly produces insufficient evidence rather than inventing provenance.

## TypeScript API

```ts
import { buildSnapshot, gateStatus, parseJsonl } from "contextadapt";

const events = parseJsonl(traceJsonl);
const snapshot = buildSnapshot(events, "my-run");
if (gateStatus(snapshot) !== "PASS") throw new Error("Do not execute");
```

Exports:

- `contextadapt` — schemas, snapshots, relation gate, action gate, executor guard;
- `contextadapt/codex` — privacy-safe event adapter and optional two-run semantic analysis;
- `contextadapt/omp` — native OMP pre-tool extension.

## Architecture and trust boundary

```text
Agent host trace -> relation proposal + independent review -> deterministic gate
                                                        -> executor guard -> real tool call
```

The host—not the planner—must assign event sources, preserve raw user/policy events, classify protected resources, and bind actual tool arguments to the guard. ContextAdapt detects contradictions within that trusted record; it cannot authenticate a forged host trace by itself. `PASS` means no currently supported risk was found, not universal safety.

## Long-context experiment infrastructure

The reproducible Luna experiment under [`experiments/long-context`](https://github.com/cooleryu/ContextAdapt/tree/main/experiments/long-context) asks whether the same model still chooses the current, authorized action as actual input grows toward 200K, 400K, and the 1M-window boundary. It includes target switches, revoked permissions, and failed tool previews rather than a visible needle-in-a-haystack password.

The first live public matrix (2026-08-23) exercised measured final-turn inputs near 198K, 394K, and 883K. It established a reproducible test channel and exposed a 1,048,576-character single-turn host limit plus an underspecified oracle. It did **not** compare an adaptive ContextAdapt decision against always-small and always-largest baselines, so it is infrastructure evidence rather than product-value proof. [Read the full results and limitations.](https://github.com/cooleryu/ContextAdapt/blob/main/experiments/long-context/RESULTS.md)

The runner records Codex token counters and per-turn deltas, prompt hashes, sanitized decisions, exact-action scores, and safety scores. Generated multi-megabyte prompts are reproducible from source and are not committed. This is a one-thread-per-cell public pilot, not a statistical benchmark.

The npm package is TypeScript-first and has no runtime dependencies. The frozen Python v0.1 implementation and its 56 tests remain under [`research/python`](research/python) as an executable migration oracle; cross-language golden tests prevent semantic drift.

## Develop

```bash
npm install
npm run check
```

The GitHub source release is usable now. The npm tarball has passed fresh-install testing, but the registry package has not been published yet; after that separate release step, `npx contextadapt ...` will be the shorter equivalent.

`npm run check` performs strict type checking, TypeScript/security tests, byte-level Python-oracle comparisons, a production build, and package inspection.

- [Trace contract](docs/trace-format.md)
- [Recommendation input schema](schema/contextadapt.recommendation-input.v1.schema.json)
- [Recommendation result schema](schema/contextadapt.recommendation.v1.schema.json)
- [Hybrid relation protocol](docs/hybrid-relations.md)
- [Codex adapter privacy boundary](docs/codex-adapter.md)
- [Product north-star roadmap](docs/product-roadmap.md)
- [Security guidance](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Apache-2.0 license](LICENSE)
