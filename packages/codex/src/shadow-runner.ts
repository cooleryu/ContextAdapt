import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  canonicalStringify,
  isRecord,
  type ContextTier,
} from "../../core/src/index.js";
import type { CodexRunner } from "./semantic.js";
import {
  currentCodexTask,
  runCodexAdaptiveTurn,
  type CodexAdaptiveRunOptions,
  type CodexAdaptiveRunResult,
  type CodexAdaptiveSession,
  type CodexContextPolicy,
} from "./adaptive-runner.js";
import { installCodexRuntimeHooks } from "./runtime-hook.js";
import {
  runTwoPassCodexTaskCapture,
  type CapturedTask,
} from "./task-capture.js";

export const CODEX_SHADOW_RESULT_VERSION =
  "contextadapt.codex-shadow-result.v1" as const;

const sha = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const ignoredDirectoryNames = new Set([
  ".git",
  ".contextadapt",
  ".contextadapt-research",
  ".npm-cache",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

function ignoredRelativePath(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  return parts.some((part) => ignoredDirectoryNames.has(part));
}

async function assertSafeWorkspaceSymlinks(
  root: string,
  cursor = "",
): Promise<void> {
  const directory = resolve(root, cursor);
  for (const entry of await readdir(directory)) {
    const rel = cursor ? `${cursor}/${entry}` : entry;
    if (ignoredRelativePath(rel)) continue;
    const absolute = resolve(root, rel);
    const stat = await lstat(absolute);
    if (stat.isDirectory()) {
      await assertSafeWorkspaceSymlinks(root, rel);
      continue;
    }
    if (!stat.isSymbolicLink()) continue;
    const target = await readlink(absolute);
    const resolvedTarget = resolve(dirname(absolute), target);
    const back = relative(root, resolvedTarget);
    if (isAbsolute(target) || isAbsolute(back) || back.startsWith("..")) {
      throw new Error(`unsafe workspace symlink escapes replay root: ${rel}`);
    }
  }
}

async function copyWorkspace(
  source: string,
  destination: string,
): Promise<void> {
  await assertSafeWorkspaceSymlinks(source);
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: (path) => {
      const rel = relative(source, path).replaceAll("\\", "/");
      return !rel || !ignoredRelativePath(rel);
    },
  });
  await assertSafeWorkspaceSymlinks(destination);
}

async function workspaceFiles(
  root: string,
  cursor = "",
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const directory = resolve(root, cursor);
  for (const entry of (await readdir(directory)).sort()) {
    const rel = cursor ? `${cursor}/${entry}` : entry;
    if (ignoredRelativePath(rel) || rel === ".codex/hooks.json") continue;
    const absolute = resolve(root, rel);
    const stat = await lstat(absolute);
    if (stat.isDirectory()) {
      for (const [path, digest] of await workspaceFiles(root, rel)) {
        result.set(path, digest);
      }
    } else if (stat.isSymbolicLink()) {
      result.set(rel, sha(`symlink:${await readlink(absolute)}`));
    } else if (stat.isFile()) {
      result.set(rel, sha(await readFile(absolute)));
    }
  }
  return result;
}

function stateHash(files: Map<string, string>): string {
  return sha(canonicalStringify(Object.fromEntries([...files].sort())));
}

function changedFiles(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}

function safeTarget(root: string, target: string): string {
  const absolute = resolve(root, target);
  const back = relative(root, absolute);
  if (isAbsolute(back) || back.startsWith("..")) {
    throw new Error("shadow target is outside the isolated workspace");
  }
  return absolute;
}

function jsonRecord(text: string, where: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error(`${where} must be one JSON object`);
  return value;
}

const desiredJsonFields = ["environment", "timeout"] as const;

export interface ShadowVerification {
  supported: boolean;
  task_success: boolean;
  execution_safety: boolean;
  changed_file_sha256: string[];
  target_file_sha256: string;
  desired_fields: Record<string, unknown>;
  initial_target_sha256: string | null;
  final_target_sha256: string | null;
  failures: string[];
}

async function verifyCapturedJsonTask(
  initialText: string,
  finalRoot: string,
  captured: CapturedTask,
  initialFiles: Map<string, string>,
): Promise<ShadowVerification> {
  if (!captured.event)
    throw new Error("shadow replay requires an actionable task");
  const target = String(captured.event.facts.target_file ?? "");
  if (!target) throw new Error("captured shadow task is missing target_file");
  const desired = Object.fromEntries(
    desiredJsonFields
      .filter((field) => Object.hasOwn(captured.event!.facts, field))
      .map((field) => [field, captured.event!.facts[field]]),
  );
  const failures: string[] = [];
  const finalPath = safeTarget(finalRoot, target);
  let finalText = "";
  if (!initialText) failures.push("initial_target_unreadable:missing snapshot");
  try {
    finalText = await readFile(finalPath, "utf8");
  } catch {
    failures.push("final_target_unreadable");
  }
  let initial: Record<string, unknown> = {};
  let final: Record<string, unknown> = {};
  try {
    if (initialText) initial = jsonRecord(initialText, "initial target");
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  try {
    if (finalText) final = jsonRecord(finalText, "final target");
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (Object.keys(desired).length === 0) {
    failures.push("unsupported_task_without_environment_or_timeout");
  }
  for (const [field, expected] of Object.entries(desired)) {
    if (canonicalStringify(final[field]) !== canonicalStringify(expected)) {
      failures.push(
        `wrong_${field}:${canonicalStringify(final[field])}!=${canonicalStringify(expected)}`,
      );
    }
  }
  for (const field of new Set([
    ...Object.keys(initial),
    ...Object.keys(final),
  ])) {
    if (Object.hasOwn(desired, field)) continue;
    if (
      canonicalStringify(initial[field]) !== canonicalStringify(final[field])
    ) {
      failures.push(`unrequested_json_change:${field}`);
    }
  }
  const finalFiles = await workspaceFiles(finalRoot);
  const changed = changedFiles(initialFiles, finalFiles);
  const unsafeChanges = changed.filter((path) => path !== target);
  if (unsafeChanges.length > 0) {
    failures.push(
      `unexpected_file_hashes_changed:${unsafeChanges.map(sha).join(",")}`,
    );
  }
  return {
    supported: !failures.includes(
      "unsupported_task_without_environment_or_timeout",
    ),
    task_success: failures.length === 0,
    execution_safety: unsafeChanges.length === 0,
    changed_file_sha256: changed.map(sha),
    target_file_sha256: sha(target),
    desired_fields: desired,
    initial_target_sha256: initialText ? sha(initialText) : null,
    final_target_sha256: finalText ? sha(finalText) : null,
    failures,
  };
}

export interface CodexShadowPolicyResult {
  context_policy: CodexContextPolicy;
  selected_tier: ContextTier | null;
  recommendation: string;
  provider_thread_hash: string;
  agent_called: boolean;
  actual_agent_input_tokens: number;
  actual_total_input_tokens: number;
  latency_ms: number;
  interaction_cost: CodexAdaptiveRunResult["interaction_cost"];
  hook_attestation: CodexAdaptiveRunResult["hook_attestation"];
  initial_state_sha256: string;
  final_state_sha256: string;
  verification: ShadowVerification;
}

export interface CodexShadowPairResult {
  schema_version: typeof CODEX_SHADOW_RESULT_VERSION;
  pair_id: string;
  source: "native_codex_public_stream";
  model: string;
  review_model: string;
  prompt_sha256: string;
  session_sha256: string;
  task_event_sha256: string;
  preflight_input_tokens: number;
  preflight_provider_thread_hashes: string[];
  shared_capture_for_causal_pair: true;
  paired_initial_state_match: boolean;
  policies: Record<CodexContextPolicy, CodexShadowPolicyResult>;
  verdict: "IMPROVED" | "VALIDATED_NO_SAVINGS" | "NOT_IMPROVED";
  paired_savings: {
    total_input_tokens: number;
    percent: number;
    product_bar_percent: 25;
    meets_product_bar: boolean;
  };
  reasons: string[];
}

export interface CodexShadowPairOptions {
  cwd: string;
  /** Model under evaluation in both replay arms. */
  model?: string;
  /** Separate model used only for the shared two-pass task review. */
  review_model?: string;
  model_context_window?: number;
  reasoning_effort?: "low" | "medium" | "high";
  timeoutMs?: number;
  fixed_input_tokens?: number;
  review_runner?: CodexRunner;
  runner?: CodexRunner;
  captureTask?: CodexAdaptiveRunOptions["captureTask"];
  countTokens?: (text: string) => number;
  hookCommand?: string;
  requireInstalledHook?: boolean;
  keepWorkspaces?: boolean;
  initialStateOverlay?: Array<{
    target: string;
    existed: boolean;
    content: string | null;
  }>;
}

export function classifyPairedSavings(
  largestTotalInputTokens: number,
  adaptiveTotalInputTokens: number,
  safeAndComplete: boolean,
): CodexShadowPairResult["paired_savings"] {
  const savedTokens = largestTotalInputTokens - adaptiveTotalInputTokens;
  const savedPercent =
    largestTotalInputTokens === 0
      ? 0
      : Math.round((savedTokens / largestTotalInputTokens) * 1_000_000) /
        10_000;
  return {
    total_input_tokens: savedTokens,
    percent: savedPercent,
    product_bar_percent: 25,
    meets_product_bar: safeAndComplete && savedPercent >= 25,
  };
}

async function applyInitialStateOverlay(
  root: string,
  entries: NonNullable<CodexShadowPairOptions["initialStateOverlay"]>,
): Promise<void> {
  for (const entry of entries) {
    const target = safeTarget(root, entry.target);
    if (entry.existed) {
      if (entry.content === null) {
        throw new Error("shadow initial-state overlay is missing file content");
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, entry.content);
    } else {
      await rm(target, { force: true });
    }
  }
}

function captureThreadHashes(captured: CapturedTask): string[] {
  return captured.run_attestations
    .map((item) => item.thread_id_sha256)
    .filter((item): item is string => typeof item === "string" && Boolean(item))
    .map((item) => item.slice(0, 20));
}

function policyResult(
  result: CodexAdaptiveRunResult,
  initialHash: string,
  finalHash: string,
  verification: ShadowVerification,
): CodexShadowPolicyResult {
  return {
    context_policy: result.context_policy,
    selected_tier: result.selected_tier,
    recommendation: result.recommendation.recommendation,
    provider_thread_hash: result.provider_thread_hash,
    agent_called: result.agent_called,
    actual_agent_input_tokens: result.actual_agent_input_tokens,
    actual_total_input_tokens: result.actual_total_input_tokens,
    latency_ms: result.latency_ms,
    interaction_cost: result.interaction_cost,
    hook_attestation: result.hook_attestation,
    initial_state_sha256: initialHash,
    final_state_sha256: finalHash,
    verification,
  };
}

/**
 * Freeze one native session/task capture, replay both policies from identical
 * isolated files, and verify the captured JSON scalar task without a manifest.
 */
export async function runCodexShadowPair(
  session: CodexAdaptiveSession,
  prompt: string,
  options: CodexShadowPairOptions,
): Promise<CodexShadowPairResult> {
  if (!prompt.trim()) throw new Error("shadow prompt must not be empty");
  const source = resolve(options.cwd);
  const capture =
    options.captureTask ??
    ((text: string, previous, captureOptions) =>
      runTwoPassCodexTaskCapture(text, previous, {
        ...captureOptions,
        model: options.review_model,
        runner: options.review_runner,
      }));
  const captured = await capture(prompt, currentCodexTask(session.events), {
    sequence:
      Math.max(0, ...session.events.map((item) => item.sequence ?? 0)) + 1,
    session_id: session.session_id,
  });
  if (!captured.event) {
    throw new Error("shadow replay currently requires an actionable JSON task");
  }
  const root = await mkdtemp(resolve(tmpdir(), "contextadapt-codex-shadow-"));
  const roots: Record<CodexContextPolicy, string> = {
    "always-largest": resolve(root, "always-largest"),
    contextadapt: resolve(root, "contextadapt"),
  };
  try {
    for (const path of Object.values(roots)) {
      await mkdir(dirname(path), { recursive: true });
      await copyWorkspace(source, path);
      if (options.initialStateOverlay) {
        await applyInitialStateOverlay(path, options.initialStateOverlay);
      }
      spawnSync("git", ["init", "-q"], { cwd: path });
      if (options.requireInstalledHook ?? true) {
        if (!options.hookCommand?.trim()) {
          throw new Error(
            "shadow replay requires a reviewed absolute hook command",
          );
        }
        await installCodexRuntimeHooks(path, options.hookCommand, {
          replaceContextAdaptMode: true,
        });
      }
    }
    const initialStates = await Promise.all(
      Object.values(roots).map(async (path) => workspaceFiles(path)),
    );
    const initialHashes = initialStates.map(stateHash);
    const replayTarget = String(captured.event.facts.target_file);
    const initialTargetTexts = await Promise.all(
      Object.values(roots).map(async (path) => {
        try {
          return await readFile(safeTarget(path, replayTarget), "utf8");
        } catch {
          return "";
        }
      }),
    );
    const pairedInitialStateMatch = new Set(initialHashes).size === 1;
    const results = {} as Record<CodexContextPolicy, CodexShadowPolicyResult>;
    for (const policy of ["always-largest", "contextadapt"] as const) {
      const run = await runCodexAdaptiveTurn(structuredClone(session), prompt, {
        cwd: roots[policy],
        model: options.model,
        review_model: options.review_model,
        review_runner: options.review_runner,
        model_context_window: options.model_context_window,
        reasoning_effort: options.reasoning_effort,
        timeoutMs: options.timeoutMs,
        fixed_input_tokens: options.fixed_input_tokens,
        runner: options.runner,
        captureTask: () => structuredClone(captured),
        countTokens: options.countTokens,
        context_policy: policy,
        requireInstalledHook: options.requireInstalledHook,
        bypassHookTrustForIsolatedTest: true,
      });
      const finalFiles = await workspaceFiles(roots[policy]);
      const verification = await verifyCapturedJsonTask(
        initialTargetTexts[policy === "always-largest" ? 0 : 1]!,
        roots[policy],
        captured,
        initialStates[policy === "always-largest" ? 0 : 1]!,
      );
      results[policy] = policyResult(
        run,
        initialHashes[policy === "always-largest" ? 0 : 1]!,
        stateHash(finalFiles),
        verification,
      );
    }
    const largest = results["always-largest"];
    const adaptive = results.contextadapt;
    const reasons: string[] = [];
    if (!pairedInitialStateMatch) reasons.push("paired_initial_state_mismatch");
    if (!adaptive.verification.execution_safety) {
      reasons.push("contextadapt_execution_safety_failed");
    }
    if (
      largest.verification.task_success &&
      !adaptive.verification.task_success
    ) {
      reasons.push("contextadapt_completion_below_always_largest");
    }
    const safeAndComplete =
      reasons.length === 0 && adaptive.verification.task_success;
    const pairedSavings = classifyPairedSavings(
      largest.actual_total_input_tokens,
      adaptive.actual_total_input_tokens,
      safeAndComplete,
    );
    const verdict = pairedSavings.meets_product_bar
      ? "IMPROVED"
      : safeAndComplete
        ? "VALIDATED_NO_SAVINGS"
        : "NOT_IMPROVED";
    return {
      schema_version: CODEX_SHADOW_RESULT_VERSION,
      pair_id: `shadow:${sha(`${session.session_id}:${prompt}`).slice(0, 20)}`,
      source: "native_codex_public_stream",
      model: options.model ?? "gpt-5.6-luna",
      review_model: options.review_model ?? "gpt-5.6-luna",
      prompt_sha256: sha(prompt),
      session_sha256: sha(canonicalStringify(session)),
      task_event_sha256: sha(canonicalStringify(captured.event)),
      preflight_input_tokens: captured.preflight_input_tokens,
      preflight_provider_thread_hashes: captureThreadHashes(captured),
      shared_capture_for_causal_pair: true,
      paired_initial_state_match: pairedInitialStateMatch,
      policies: results,
      verdict,
      paired_savings: pairedSavings,
      reasons,
    };
  } finally {
    if (!options.keepWorkspaces) {
      await rm(root, { recursive: true, force: true });
    }
  }
}
