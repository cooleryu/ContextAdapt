import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = process.cwd();
const pythonRoot = resolve(root, "research/python");
function ts(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "packages/cli/src/bin.ts", ...args],
    { cwd: root, encoding: "utf8" },
  );
}
function py(args: string[]) {
  return spawnSync("python3", ["-m", "contextadapt", ...args], {
    cwd: pythonRoot,
    encoding: "utf8",
  });
}

test("TypeScript demo snapshot exactly matches frozen Python oracle", () => {
  const left = py(["demo", "--format", "json"]),
    right = ts(["demo", "--format", "json"]);
  assert.equal(right.status, left.status, right.stderr);
  assert.deepEqual(JSON.parse(right.stdout), JSON.parse(left.stdout));
});

test("TypeScript stale-action check matches Python verdict, risks, and exit code", () => {
  const trace = resolve(root, "examples/stale-action.jsonl");
  const left = py(["check", trace, "--format", "json"]),
    right = ts(["check", trace, "--format", "json"]);
  assert.equal(left.status, 2);
  assert.equal(right.status, left.status, right.stderr);
  assert.deepEqual(JSON.parse(right.stdout), JSON.parse(left.stdout));
});

test("privacy-safe Codex conversion is byte-identical to Python oracle", () => {
  const temporary = mkdtempSync(join(tmpdir(), "contextadapt-oracle-"));
  try {
    const raw = resolve(root, "examples/codex-exec.raw.jsonl"),
      pyOut = join(temporary, "py.jsonl"),
      tsOut = join(temporary, "ts.jsonl");
    const left = py(["import-codex", raw, "--output", pyOut]),
      right = ts(["import-codex", raw, "--output", tsOut]);
    assert.equal(left.status, 0, left.stderr);
    assert.equal(right.status, left.status, right.stderr);
    assert.equal(readFileSync(tsOut, "utf8"), readFileSync(pyOut, "utf8"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("CLI exposes immediate help and version", () => {
  const help = ts(["--help"]),
    version = ts(["--version"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: contextadapt/);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), "0.2.0");
});
