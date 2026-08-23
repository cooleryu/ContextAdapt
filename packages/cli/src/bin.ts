#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import process from "node:process";
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
  parseRecommendationInput,
  recommendContext,
  renderCheck,
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
  runTwoPassCodexAnalysis,
} from "../../codex/src/index.js";

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
  return `ContextAdapt — use the smallest context that can still act safely\n\nUsage: contextadapt <command> [options]\n\nCommands:\n  recommend INPUT   Select 200K, 400K, 1M-window, or block\n  demo              Run the zero-configuration safety demo\n  check TRACE       Gate candidate actions (exit 2 unless PASS)\n  diagnose TRACE    Build a provenance-aware snapshot\n  import-codex SRC  Convert codex exec --json output\n  reconcile         Validate a semantic relation and optional action\n  analyze-codex     Run two independent Codex semantic analyses\n  compile-guard     Compile an accepted relation into an executor guard\n  executor-hook     Evaluate one native Codex or OMP pre-tool call\n`;
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
      if (!path) throw new Error("recommend requires INPUT");
      let value: unknown;
      if (path === "-") {
        value = JSON.parse(await readStdin());
      } else {
        value = await jsonObject(path);
      }
      const result = recommendContext(parseRecommendationInput(value));
      process.stdout.write(
        flag(flags, "format") === "json"
          ? `${JSON.stringify(result, null, 2)}\n`
          : renderRecommendation(result),
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
    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    console.error(
      `contextadapt: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

process.exitCode = await main();
