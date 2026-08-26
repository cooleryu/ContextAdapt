#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildSnapshot,
  codexHookOutput,
  compileExecutorGuard,
  demoEvents,
  demoSnapshot,
  dumpJsonl,
  evaluateActionWithRelation,
  evaluateExecutorCall,
  gateStatus,
  loadExecutorGuard,
  loadJsonl,
  isRecord,
  parseJsonl,
  parseRecommendationInput,
  parseTraceEvent,
  recommendContext,
  recommendFromTrace,
  renderCheck,
  renderCompactRecommendation,
  renderDemo,
  renderDiagnosis,
  renderRecommendation,
  validateRelationBundle,
  type ContextSnapshot,
  type ExecutorDecision,
} from "../../core/src/index.js";
import {
  convertCodexExec,
  DEFAULT_MODEL,
  emptyCodexAdaptiveSession,
  handleCodexRuntimeHook,
  installCodexRuntimeHooks,
  loadCodexAdaptiveSession,
  observeCodexPassiveSession,
  runCodexNativeBoundary,
  runCodexAdaptiveTurn,
  runCodexShadowPair,
  runTwoPassCodexAnalysis,
  saveCodexAdaptiveSession,
} from "../../codex/src/index.js";
import {
  findContextAdaptPackageRoot,
  installOmpHost,
} from "../../omp/src/index.js";

type Flags = Record<string, string | boolean>;
function parse(args: string[]): {
  command: string;
  positional: string[];
  flags: Flags;
} {
  const command = args.shift() ?? "";
  const positional: string[] = [],
    flags: Flags = {};
  while (args.length > 0) {
    const item = args.shift()!;
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const key = item.slice(2);
    if (
      [
        "help",
        "version",
        "fail-on-risk",
        "include-content",
        "allow-remote-content",
        "details",
        "keep-workspaces",
        "passive-cohort",
        "replay",
        "shadow-only",
        "force-analysis",
        "project",
      ].includes(key)
    )
      flags[key] = true;
    else {
      const value = args.shift();
      if (!value || value.startsWith("--"))
        throw new Error(`--${key} requires a value`);
      flags[key] = value;
    }
  }
  return { command, positional, flags };
}
const flag = (flags: Flags, name: string): string | undefined =>
  typeof flags[name] === "string" ? flags[name] : undefined;
const has = (flags: Flags, name: string): boolean => flags[name] === true;
const reasoningEffort = (flags: Flags): "low" | "medium" | "high" => {
  const value = flag(flags, "reasoning-effort") ?? "low";
  if (!(["low", "medium", "high"] as string[]).includes(value)) {
    throw new Error("--reasoning-effort must be low, medium, or high");
  }
  return value as "low" | "medium" | "high";
};
const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};
const jsonObject = async (path: string): Promise<Record<string, unknown>> => {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${path} must contain one JSON object`);
  return value as Record<string, unknown>;
};
const writeEnsured = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};
const traceStem = (path: string): string => basename(path, extname(path));

function help(): string {
  return `ContextAdapt — use the smallest context that can still act safely\n\nUsage: contextadapt <command> [options]\n\nCommands:\n  recommend TRACE   Select 200K, 400K, 1M-window, or block\n  install-host      Install into OMP or install Codex recorder/write-gate hooks\n  observe-codex     Analyze the latest opt-in natural Codex task after it ends\n  native-boundary   Verify App Server history injection beyond the CLI ceiling\n  run-codex         Select context, call Codex, and gate real writes\n  shadow-codex      Pair fixed-largest and ContextAdapt in isolated copies\n  demo              Run the zero-configuration safety demo\n  check TRACE       Gate candidate actions (exit 2 unless PASS)\n  diagnose TRACE    Build a provenance-aware snapshot\n  import-codex SRC  Convert codex exec --json output\n  reconcile         Validate a semantic relation and optional action\n  analyze-codex     Run two independent Codex semantic analyses\n  compile-guard     Compile an accepted relation into an executor guard\n  executor-hook     Evaluate one native Codex or OMP pre-tool call\n  host-hook         Record Codex prompt/tool lifecycle and gate writes\n`;
}

function relationText(
  relation: Record<string, unknown>,
  action: Record<string, unknown> | null,
): string {
  const lines = [
    `ContextAdapt relation · ${String(relation.status)}`,
    "=".repeat(31),
    `Relation: ${String(relation.relation)}  Entity: ${String(relation.entity)}`,
  ];
  if (Array.isArray(relation.errors) && relation.errors.length)
    lines.push(
      "",
      "Engineering errors:",
      ...relation.errors.map((item) => `  ! ${String(item)}`),
    );
  if (action)
    lines.push(
      "",
      `Action: ${String(action.status)}`,
      ...(Array.isArray(action.reasons)
        ? action.reasons.map((item) => `  ! ${String(item)}`)
        : []),
    );
  return `${lines.join("\n")}\n`;
}

function jsonSnapshot(
  snapshot: ContextSnapshot,
  includeVerdict: boolean,
): string {
  return `${JSON.stringify(includeVerdict ? { ...snapshot, gate_verdict: gateStatus(snapshot) } : snapshot, null, 2)}\n`;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parse([...argv]);
  } catch (error) {
    console.error(
      `contextadapt: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  const { command, positional, flags } = parsed;
  if (
    command === "--version" ||
    command === "version" ||
    has(flags, "version")
  ) {
    process.stdout.write("0.2.0\n");
    return 0;
  }
  if (
    !command ||
    command === "--help" ||
    command === "-h" ||
    command === "help" ||
    has(flags, "help")
  ) {
    process.stdout.write(help());
    return command ? 0 : 1;
  }
  try {
    if (command === "recommend") {
      const path = positional[0];
      if (!path) throw new Error("recommend requires TRACE");
      const raw =
        path === "-" ? await readStdin() : await readFile(path, "utf8");
      const inputTraceId = path === "-" ? "stdin" : traceStem(path);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        parsedJson = undefined;
      }
      const result =
        isRecord(parsedJson) &&
        typeof parsedJson.event_id === "string" &&
        typeof parsedJson.source === "string" &&
        typeof parsedJson.kind === "string"
          ? recommendFromTrace([parseTraceEvent(parsedJson)], inputTraceId)
          : parsedJson === undefined
            ? recommendFromTrace(parseJsonl(raw), inputTraceId)
            : recommendContext(parseRecommendationInput(parsedJson));
      process.stdout.write(
        flag(flags, "format") === "json"
          ? `${JSON.stringify(result, null, 2)}\n`
          : has(flags, "details")
            ? renderRecommendation(result)
            : renderCompactRecommendation(result),
      );
      return result.recommendation === "BLOCK_AND_REFRESH" ? 2 : 0;
    }
    if (command === "demo") {
      const snapshot = demoSnapshot();
      const out = flag(flags, "trace-out");
      if (out) await writeEnsured(out, dumpJsonl(demoEvents()));
      process.stdout.write(
        flag(flags, "format") === "json"
          ? jsonSnapshot(snapshot, false)
          : renderDemo(snapshot),
      );
      return 0;
    }
    if (command === "run-codex") {
      if (!has(flags, "allow-remote-content"))
        throw new Error(
          "refusing remote semantic and Agent calls without --allow-remote-content",
        );
      const sessionPath =
        flag(flags, "session") ?? ".contextadapt/codex-session.json";
      const promptPath = flag(flags, "prompt-file");
      const prompt = promptPath
        ? promptPath === "-"
          ? await readStdin()
          : await readFile(promptPath, "utf8")
        : positional.join(" ");
      if (!prompt.trim())
        throw new Error("run-codex requires a prompt or --prompt-file PATH");
      let session;
      try {
        session = await loadCodexAdaptiveSession(sessionPath);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        )
          throw error;
        session = emptyCodexAdaptiveSession(
          flag(flags, "session-id") ?? `codex:${traceStem(sessionPath)}`,
        );
      }
      const result = await runCodexAdaptiveTurn(session, prompt, {
        cwd: flag(flags, "cwd") ?? process.cwd(),
        model: flag(flags, "model") ?? DEFAULT_MODEL,
        review_model: flag(flags, "review-model") ?? DEFAULT_MODEL,
        model_context_window: flag(flags, "context-window")
          ? Number(flag(flags, "context-window"))
          : undefined,
        reasoning_effort: reasoningEffort(flags),
      });
      await saveCodexAdaptiveSession(sessionPath, result.session);
      process.stdout.write(renderCompactRecommendation(result.recommendation));
      if (result.agent_called) {
        process.stdout.write(
          `Agent: completed; ${result.actual_total_input_tokens.toLocaleString("en-US")} total input tokens including semantic preflight; ${result.latency_ms.toLocaleString("en-US")} ms.\n`,
        );
        process.stdout.write(
          `Interaction: ${result.interaction_cost.retrieval_calls} retrieval, ${result.interaction_cost.execution_calls} execution, ${result.interaction_cost.recovery_retrieval_calls} recovery read, ${result.interaction_cost.repeated_tool_calls} repeated tool call, ${result.interaction_cost.blocked_action_proposals} blocked proposal, ${result.interaction_cost.unknown_tool_outcomes} host-reported outcome unknown.\n`,
        );
      }
      return result.agent_called ? 0 : 2;
    }
    if (command === "shadow-codex") {
      if (!has(flags, "allow-remote-content"))
        throw new Error(
          "refusing remote semantic and Agent calls without --allow-remote-content",
        );
      const sessionPath =
        flag(flags, "session") ?? ".contextadapt/codex-session.json";
      const promptPath = flag(flags, "prompt-file");
      const prompt = promptPath
        ? promptPath === "-"
          ? await readStdin()
          : await readFile(promptPath, "utf8")
        : positional.join(" ");
      if (!prompt.trim())
        throw new Error("shadow-codex requires a prompt or --prompt-file PATH");
      const session = await loadCodexAdaptiveSession(sessionPath);
      const bin = resolve(process.argv[1] ?? "dist/packages/cli/src/bin.js");
      const quotedBin = `'${bin.replaceAll("'", `'"'"'`)}'`;
      const result = await runCodexShadowPair(session, prompt, {
        cwd: flag(flags, "cwd") ?? process.cwd(),
        model: flag(flags, "model") ?? DEFAULT_MODEL,
        review_model: flag(flags, "review-model") ?? DEFAULT_MODEL,
        model_context_window: flag(flags, "context-window")
          ? Number(flag(flags, "context-window"))
          : undefined,
        reasoning_effort: reasoningEffort(flags),
        hookCommand:
          flag(flags, "hook-command") ?? `node ${quotedBin} host-hook codex`,
        keepWorkspaces: has(flags, "keep-workspaces"),
      });
      const output =
        flag(flags, "output") ?? ".contextadapt/shadow/latest-codex-pair.json";
      await writeEnsured(output, `${JSON.stringify(result, null, 2)}\n`);
      const adaptive = result.policies.contextadapt;
      const largest = result.policies["always-largest"];
      process.stdout.write(
        `ContextAdapt shadow · ${result.verdict}\n` +
          `Adaptive: ${adaptive.selected_tier ?? "BLOCK"}; ${adaptive.verification.task_success ? "task PASS" : "task FAIL"}; ${adaptive.actual_total_input_tokens.toLocaleString("en-US")} input tokens.\n` +
          `Largest: ${largest.selected_tier ?? "BLOCK"}; ${largest.verification.task_success ? "task PASS" : "task FAIL"}; ${largest.actual_total_input_tokens.toLocaleString("en-US")} input tokens.\n` +
          `Safety: adaptive ${adaptive.verification.execution_safety ? "PASS" : "FAIL"}; largest ${largest.verification.execution_safety ? "PASS" : "FAIL"}.\n` +
          `Audit: ${output}\n`,
      );
      return result.verdict === "NOT_IMPROVED" ? 2 : 0;
    }
    if (command === "install-host") {
      const host = positional[0];
      if (host === "omp") {
        const packageRoot = findContextAdaptPackageRoot(
          dirname(fileURLToPath(import.meta.url)),
        );
        const result = installOmpHost({
          packageRoot,
          installCwd: flag(flags, "cwd") ?? process.cwd(),
          ompCommand: flag(flags, "omp-command"),
          scope: has(flags, "project") ? "project" : "user",
        });
        process.stdout.write(
          `ContextAdapt OMP integration: installed and verified.\n` +
            `OMP: ${result.omp_version}; scope ${result.scope}.\n` +
            `Use: start OMP normally; ContextAdapt now selects context before the Agent and gates real mutations.\n` +
            `Extension: ${result.extension_entry}\n`,
        );
        return 0;
      }
      if (host !== "codex") {
        throw new Error("install-host supports omp or codex");
      }
      const result = await installCodexRuntimeHooks(
        flag(flags, "cwd") ?? process.cwd(),
        flag(flags, "command") ??
          (has(flags, "passive-cohort")
            ? "contextadapt host-hook codex --shadow-only"
            : "contextadapt host-hook codex"),
        { passiveCohort: has(flags, "passive-cohort") },
      );
      process.stdout.write(
        `ContextAdapt Codex hooks: ${result.added.length ? `installed ${result.added.join(", ")}` : "already installed"}.\nFile: ${result.path}\nPassive cohort: ${result.passive_cohort ? `enabled; raw thread reference stays local at ${result.private_settings_path}` : "disabled"}.\nReview and trust these hooks in Codex before the first adaptive run.\n`,
      );
      return 0;
    }
    if (command === "observe-codex") {
      if (
        (has(flags, "force-analysis") || has(flags, "replay")) &&
        !has(flags, "allow-remote-content")
      ) {
        throw new Error(
          "refusing forced Luna task capture or replay without --allow-remote-content",
        );
      }
      const cwd = flag(flags, "cwd") ?? process.cwd();
      const result = await observeCodexPassiveSession({
        cwd,
        model: flag(flags, "model") ?? DEFAULT_MODEL,
        model_context_window: flag(flags, "context-window")
          ? Number(flag(flags, "context-window"))
          : undefined,
        fixed_input_tokens: flag(flags, "fixed-input-tokens")
          ? Number(flag(flags, "fixed-input-tokens"))
          : undefined,
        privateDirectory: flag(flags, "private-dir"),
        runtimeDirectory: flag(flags, "runtime-dir"),
        forceAnalysis: has(flags, "force-analysis"),
        allowRemoteContent: has(flags, "allow-remote-content"),
      });
      const output =
        flag(flags, "output") ??
        resolve(cwd, ".contextadapt/cohort/latest-codex-observation.json");
      await writeEnsured(output, `${JSON.stringify(result.report, null, 2)}\n`);
      let replaySummary =
        "Replay: not requested; primary task remained untouched.";
      let replayFailed = false;
      if (has(flags, "replay")) {
        if (!result.replay) {
          replaySummary =
            "Replay: not applicable; no actionable task was captured.";
        } else {
          const bin = resolve(
            process.argv[1] ?? "dist/packages/cli/src/bin.js",
          );
          const quotedBin = `'${bin.replaceAll("'", `'"'"'`)}'`;
          const replay = await runCodexShadowPair(
            result.replay.session,
            result.replay.prompt,
            {
              cwd,
              model: flag(flags, "model") ?? DEFAULT_MODEL,
              model_context_window: flag(flags, "context-window")
                ? Number(flag(flags, "context-window"))
                : undefined,
              reasoning_effort: reasoningEffort(flags),
              fixed_input_tokens: flag(flags, "fixed-input-tokens")
                ? Number(flag(flags, "fixed-input-tokens"))
                : undefined,
              hookCommand:
                flag(flags, "hook-command") ??
                `node ${quotedBin} host-hook codex`,
              captureTask: () => structuredClone(result.replay!.captured),
              initialStateOverlay: result.replay.initial_files,
              keepWorkspaces: has(flags, "keep-workspaces"),
            },
          );
          const replayOutput =
            flag(flags, "replay-output") ??
            resolve(cwd, ".contextadapt/cohort/latest-codex-pair.json");
          await writeEnsured(
            replayOutput,
            `${JSON.stringify(replay, null, 2)}\n`,
          );
          replayFailed = replay.verdict === "NOT_IMPROVED";
          replaySummary =
            `Replay: ${replay.verdict}; ${replay.paired_savings.percent.toFixed(2)}% total-input savings ` +
            `(${replay.paired_savings.meets_product_bar ? "meets" : "below"} the frozen ${replay.paired_savings.product_bar_percent}% product bar); isolated paired audit ${replayOutput}.`;
        }
      }
      process.stdout.write(
        `ContextAdapt passive observation · ${result.report.cohort_bucket}\n` +
          `Decision: ${result.report.decision.recommendation}; ${result.report.decision.selected_tier ?? "no executable tier"}.\n` +
          `History: about ${result.report.source.history_tokens_estimated.toLocaleString("en-US")} host-estimated tokens; ${result.report.task_capture.semantic_preflight_input_tokens.toLocaleString("en-US")} actual semantic-preflight input tokens.\n` +
          `Gate: ${result.report.execution_gate.status}. Primary task was only read after completion.\n` +
          `${replaySummary}\n` +
          `Sanitized audit: ${output}\n`,
      );
      return result.report.cohort_bucket === "BLOCK" || replayFailed ? 2 : 0;
    }
    if (command === "native-boundary") {
      if (!has(flags, "allow-remote-content")) {
        throw new Error(
          "refusing a real Luna boundary call without --allow-remote-content",
        );
      }
      const cwd = flag(flags, "cwd") ?? process.cwd();
      const result = await runCodexNativeBoundary({
        cwd,
        model: flag(flags, "model") ?? DEFAULT_MODEL,
        modelContextWindow: flag(flags, "context-window")
          ? Number(flag(flags, "context-window"))
          : undefined,
        contentChars: flag(flags, "chars")
          ? Number(flag(flags, "chars"))
          : undefined,
        timeoutMs: flag(flags, "timeout-ms")
          ? Number(flag(flags, "timeout-ms"))
          : undefined,
      });
      const output =
        flag(flags, "output") ??
        resolve(cwd, ".contextadapt/cohort/latest-native-boundary.json");
      await writeEnsured(output, `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(
        `ContextAdapt native boundary · ${result.verification.marker_match ? "PASS" : "FAIL"}\n` +
          `Injected: ${result.injected.content_chars.toLocaleString("en-US")} chars in ${result.injected.batch_count} native batches.\n` +
          `Provider input: ${result.provider_usage.actual_input_tokens === null ? "not reported" : result.provider_usage.actual_input_tokens.toLocaleString("en-US")} tokens; model window ${result.provider_usage.model_context_window === null ? "not reported" : result.provider_usage.model_context_window.toLocaleString("en-US")}.\n` +
          `Scope: transport boundary only, not product-value evidence.\n` +
          `Sanitized audit: ${output}\n`,
      );
      return result.verification.marker_match &&
        result.injected.exceeded_legacy_single_request_chars
        ? 0
        : 2;
    }
    if (command === "import-codex") {
      const source = positional[0],
        output = flag(flags, "output");
      if (!source || !output)
        throw new Error("import-codex requires SOURCE and --output PATH");
      if (source !== "-" && resolve(source) === resolve(output))
        throw new Error("source and output must be different files");
      const input =
        source === "-" ? await readStdin() : await readFile(source, "utf8");
      const instructionPath = flag(flags, "instruction-file");
      const instruction = instructionPath
        ? await readFile(instructionPath, "utf8")
        : undefined;
      await writeEnsured(
        output,
        dumpJsonl(
          convertCodexExec(input.split(/\r?\n/), {
            includeContent: has(flags, "include-content"),
            instruction,
          }),
        ),
      );
      return 0;
    }
    if (["check", "diagnose"].includes(command)) {
      const path = positional[0];
      if (!path) throw new Error(`${command} requires TRACE`);
      const snapshot = buildSnapshot(
        await loadJsonl(path),
        flag(flags, "trace-id") ?? traceStem(path),
      );
      const rendered =
        flag(flags, "format") === "json"
          ? jsonSnapshot(snapshot, command === "check")
          : command === "check"
            ? renderCheck(snapshot)
            : renderDiagnosis(snapshot);
      const output = flag(flags, "output");
      if (output) await writeEnsured(output, rendered);
      else process.stdout.write(rendered);
      if (command === "check" && gateStatus(snapshot) !== "PASS") return 2;
      if (
        command === "diagnose" &&
        has(flags, "fail-on-risk") &&
        snapshot.risk_summary.total > 0
      )
        return 2;
      return 0;
    }
    if (command === "reconcile") {
      const [trace, proposalPath, reviewPath] = positional;
      if (!trace || !proposalPath || !reviewPath)
        throw new Error("reconcile requires TRACE PROPOSAL REVIEW");
      const events = await loadJsonl(trace),
        proposal = await jsonObject(proposalPath),
        review = await jsonObject(reviewPath),
        relation = validateRelationBundle(events, proposal, review);
      const actionId = flag(flags, "action-event");
      const action = actionId
        ? evaluateActionWithRelation(events, relation, actionId)
        : null;
      process.stdout.write(
        flag(flags, "format") === "json"
          ? `${JSON.stringify({ relation, action }, null, 2)}\n`
          : relationText(relation, action),
      );
      return relation.status === "REJECTED"
        ? 1
        : relation.status !== "ACCEPTED" || (action && action.status !== "PASS")
          ? 2
          : 0;
    }
    if (command === "analyze-codex") {
      const [trace, older, newer] = positional;
      if (!trace || !older || !newer)
        throw new Error("analyze-codex requires TRACE OLDER_EVENT NEWER_EVENT");
      if (!has(flags, "allow-remote-content"))
        throw new Error(
          "refusing remote semantic calls without --allow-remote-content",
        );
      const events = await loadJsonl(trace),
        { proposal, review } = runTwoPassCodexAnalysis(events, older, newer, {
          model: flag(flags, "model") ?? DEFAULT_MODEL,
        }),
        relation = validateRelationBundle(events, proposal, review);
      const actionId = flag(flags, "action-event"),
        action = actionId
          ? evaluateActionWithRelation(events, relation, actionId)
          : null;
      const outputDir = flag(flags, "output-dir");
      if (outputDir) {
        await writeEnsured(
          resolve(outputDir, "relation-proposal.json"),
          `${JSON.stringify(proposal, null, 2)}\n`,
        );
        await writeEnsured(
          resolve(outputDir, "relation-review.json"),
          `${JSON.stringify(review, null, 2)}\n`,
        );
      }
      process.stdout.write(
        flag(flags, "format") === "json"
          ? `${JSON.stringify({ relation, action, proposal, review }, null, 2)}\n`
          : relationText(relation, action),
      );
      return relation.status !== "ACCEPTED" ||
        (action && action.status !== "PASS")
        ? 2
        : 0;
    }
    if (command === "compile-guard") {
      const [trace, proposalPath, reviewPath] = positional,
        output = flag(flags, "output");
      if (!trace || !proposalPath || !reviewPath || !output)
        throw new Error(
          "compile-guard requires TRACE PROPOSAL REVIEW --output PATH",
        );
      const guard = compileExecutorGuard(
        await loadJsonl(trace),
        await jsonObject(proposalPath),
        await jsonObject(reviewPath),
      );
      await writeEnsured(output, `${JSON.stringify(guard, null, 2)}\n`);
      return 0;
    }
    if (command === "executor-hook") {
      const host = positional[0];
      if (host !== "codex" && host !== "omp")
        throw new Error("executor-hook host must be codex or omp");
      const policy = flag(flags, "policy");
      if (!policy) throw new Error("executor-hook requires --policy PATH");
      let decision: ExecutorDecision;
      try {
        const payload: unknown = JSON.parse(await readStdin());
        if (
          typeof payload !== "object" ||
          payload === null ||
          Array.isArray(payload)
        )
          throw new Error("hook stdin must be one JSON object");
        decision = evaluateExecutorCall(
          host,
          payload as Record<string, unknown>,
          await loadExecutorGuard(policy),
        );
      } catch (error) {
        decision = {
          schema_version: "contextadapt.executor-decision.v1",
          decision: "BLOCK",
          guard_id: null,
          reasons: [
            `ContextAdapt could not assess the tool call: ${error instanceof Error ? error.message : String(error)}`,
          ],
          tool: {
            in_scope: true,
            tool_name: "unknown",
            targets: [],
            content: "",
          },
        };
      }
      if (flag(flags, "format") === "json" || host === "omp")
        process.stdout.write(`${JSON.stringify(decision)}\n`);
      else {
        const native = codexHookOutput(decision);
        if (native) process.stdout.write(`${JSON.stringify(native)}\n`);
      }
      return 0;
    }
    if (command === "host-hook") {
      const host = positional[0];
      if (host !== "codex")
        throw new Error("host-hook currently supports codex");
      let output: Record<string, unknown> | null;
      try {
        const payload: unknown = JSON.parse(await readStdin());
        if (!isRecord(payload))
          throw new Error("hook stdin must be one JSON object");
        output = await handleCodexRuntimeHook(payload, {
          runtimeDirectory: flag(flags, "runtime-dir"),
          shadowOnly: has(flags, "shadow-only"),
        });
      } catch (error) {
        output = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `ContextAdapt host hook failed closed: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
      return 0;
    }
    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    console.error(
      `contextadapt: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

process.exitCode = await main();
