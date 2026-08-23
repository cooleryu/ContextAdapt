# Frozen Python reference implementation

This directory preserves ContextAdapt v0.1 and its original 56-test suite as an executable migration oracle.

The public product and npm package are implemented in TypeScript under `packages/`. Do not add new product features here. A change to this reference is appropriate only when correcting the historical oracle itself, and must include an explicit cross-language compatibility decision.

Run the reference suite:

```bash
cd research/python
python3 -m unittest discover -s tests
```

The root TypeScript suite launches this implementation for golden comparisons of snapshots, gate verdicts, exit codes, and privacy-safe Codex conversion.
