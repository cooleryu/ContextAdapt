# Contributing

ContextAdapt is an early research-to-product project. The near-term goal is a
small, auditable tool that helps developers diagnose context-related Agent
failures without overstating causality.

## Local development

```bash
npm install
npm run check
npx contextadapt demo
npx contextadapt check examples/stale-action.jsonl
npx contextadapt diagnose examples/stale-action.jsonl
python3 -m unittest discover -s tests -v
```

The `check` command intentionally exits with status 2 for the stale-action
example. That non-zero result means the safety gate worked.

The core package has no runtime dependencies.

## Useful contributions

- adapters that convert real Agent traces into `contextadapt.trace.v1` JSONL;
- redaction and privacy tests;
- new failure families with clear, objective outcomes;
- paired replay environments that preserve the same state across policies;
- documentation that makes the tool understandable without reading research
  scripts.

## Evidence standards

- Do not label a missing constraint as “ignored” if it was absent from the
  model-visible context.
- Do not call a local rule fixture a model result.
- Separate runtime failures from model-decision failures.
- Preserve model-visible context, provenance, environment state hash, model
  identifier, and verifier output for causal replay claims.
- Do not claim internal attention behavior from output-only experiments.
- Prefer repeated paired runs; one stochastic rollout is exploratory evidence.

## Data safety

Never commit raw secrets, credentials, private repositories, personal data, or
unredacted user conversations. Synthetic minimal traces are preferred for bug
reports. If real evidence is necessary, remove unrelated content and document
the redaction method.

## Before opening a pull request

Run the complete test suite and explain:

1. the failure or user need;
2. the model-visible evidence;
3. what changed;
4. how the result was verified;
5. what the result does not prove.
