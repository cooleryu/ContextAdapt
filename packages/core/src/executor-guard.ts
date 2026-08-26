import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { canonicalDigest, canonicalStringify } from "./json.js";
import { validateRelationBundle } from "./relations.js";
import { isRecord, type TraceEvent } from "./types.js";

export const GUARD_SCHEMA_VERSION = "contextadapt.executor-guard.v1";
export const DECISION_SCHEMA_VERSION = "contextadapt.executor-decision.v1";

export type ExecutorHost = "codex" | "omp";

const mutatingTools: Record<ExecutorHost, Set<string>> = {
  codex: new Set(["apply_patch", "Bash"]),
  omp: new Set(["write", "edit", "bash", "python", "notebook"]),
};
const opaqueOmpMutators = new Set(["python", "notebook"]);
const shellMutationPattern =
  /(?:^|[;&|]\s*)(?:rm|mv|cp|install|truncate|tee|sed\s+-i|perl\s+-i|chmod|chown)\b|(?:>>?|2>)/i;
const simpleReadOnlyShellPattern =
  /^\s*(?:cat|head|tail|ls|pwd|rg|grep|find|stat|wc|git\s+(?:status|diff|log|show))(?:\s+[^;&|<>]*)?\s*$/i;

export interface GuardChange {
  field: unknown;
  old_value: unknown;
  current_value: unknown;
}

export interface ExecutorGuard extends Record<string, unknown> {
  schema_version: typeof GUARD_SCHEMA_VERSION;
  guard_id: string;
  relation_sha256: string;
  entity: unknown;
  older_event_id: string;
  current_event_id: string;
  changes: GuardChange[];
  protected_resources: string[];
}

export interface ToolView {
  in_scope: boolean;
  tool_name: string;
  targets: string[];
  content: string;
}

export interface ExecutorDecision extends Record<string, unknown> {
  schema_version: typeof DECISION_SCHEMA_VERSION;
  decision: "ALLOW" | "BLOCK";
  guard_id: unknown;
  reasons: string[];
  tool: ToolView;
  matched_changes?: string[];
}

export function compileExecutorGuard(
  events: TraceEvent[],
  proposal: Record<string, unknown>,
  review: Record<string, unknown>,
): ExecutorGuard {
  const verdict = validateRelationBundle(events, proposal, review);
  if (verdict.status !== "ACCEPTED")
    throw new Error("executor guard requires an ACCEPTED context relation");
  const byId = new Map(events.map((event) => [event.event_id, event]));
  const older =
    typeof verdict.older_event_id === "string"
      ? byId.get(verdict.older_event_id)
      : undefined;
  const current =
    typeof verdict.newer_event_id === "string"
      ? byId.get(verdict.newer_event_id)
      : undefined;
  if (!older || !current)
    throw new Error("accepted relation events are missing");
  if (
    !["user", "policy"].includes(older.source) ||
    !["user", "policy"].includes(current.source)
  ) {
    throw new Error(
      "executor guard requires host-trusted user/policy relation events",
    );
  }
  const changes = verdict.accepted_changes.map((change) => ({
    field: change.field,
    old_value: change.old_value,
    current_value: change.new_value,
  }));
  const protectedResources = [
    ...new Set(
      events
        .filter(
          (event) =>
            event.kind === "policy" &&
            event.source === "policy" &&
            event.facts.protected === true &&
            typeof event.facts.resource === "string",
        )
        .map((event) => String(event.facts.resource)),
    ),
  ].sort();
  const relationDigest = canonicalDigest(proposal);
  return {
    schema_version: GUARD_SCHEMA_VERSION,
    guard_id: `guard:${relationDigest.slice(0, 16)}`,
    relation_sha256: relationDigest,
    entity: verdict.entity,
    older_event_id: older.event_id,
    current_event_id: current.event_id,
    changes,
    protected_resources: protectedResources,
    scope: {
      codex_tools: [...mutatingTools.codex].sort(),
      omp_tools: [...mutatingTools.omp].sort(),
    },
    boundary:
      "Guards actual arguments for the listed file/shell tools. Other tool paths remain outside v0.2 scope.",
  };
}

const runtimeFields = [
  "environment",
  "timeout",
  "edit_protected",
  "target_file",
] as const;
const payloadBoundScalarFields = new Set(["timeout"]);

/**
 * Compile the live guard after two independent semantic recorder runs have
 * agreed on the current user task. Unlike compileExecutorGuard, this path does
 * not require the caller to materialize proposal/review files: the recorder
 * attestation is already bound to the host-authored current event.
 */
export function compileRuntimeExecutorGuard(
  events: TraceEvent[],
): ExecutorGuard {
  const tasks = events
    .filter(
      (event) =>
        event.source === "user" &&
        (event.kind === "state" || event.kind === "instruction") &&
        typeof event.facts.target_file === "string" &&
        event.facts.target_file.trim() !== "",
    )
    .sort(
      (left, right) =>
        (left.sequence ?? -1) - (right.sequence ?? -1) ||
        left.event_id.localeCompare(right.event_id),
    );
  const current = tasks.at(-1);
  if (!current) throw new Error("runtime guard requires a current user task");
  if (current.facts.semantic_reviewed !== true) {
    throw new Error(
      "runtime guard requires a semantically reviewed current task",
    );
  }
  const runIds = current.facts.semantic_run_ids;
  if (
    !Array.isArray(runIds) ||
    runIds.length !== 2 ||
    !runIds.every((item) => typeof item === "string" && item.trim() !== "") ||
    new Set(runIds).size !== 2
  ) {
    throw new Error(
      "runtime guard requires two independent semantic run identities",
    );
  }
  const byId = new Map(events.map((event) => [event.event_id, event]));
  const previousId = current.links.replaces;
  const previous = previousId ? byId.get(previousId) : current;
  if (!previous)
    throw new Error(`runtime predecessor ${previousId} is missing`);
  if (previous.entity !== current.entity) {
    throw new Error("runtime predecessor must belong to the same task entity");
  }
  if (
    previous !== current &&
    (previous.sequence === null ||
      current.sequence === null ||
      previous.sequence >= current.sequence)
  ) {
    throw new Error("runtime predecessor chronology is invalid");
  }

  const target = String(current.facts.target_file);
  const currentObservation = events
    .filter(
      (event) =>
        event.kind === "observation" &&
        event.success === true &&
        event.facts.target_file === target,
    )
    .sort(
      (left, right) =>
        (left.sequence ?? -1) - (right.sequence ?? -1) ||
        left.event_id.localeCompare(right.event_id),
    )
    .at(-1);

  const changes: GuardChange[] = runtimeFields
    .filter(
      (field) =>
        Object.hasOwn(current.facts, field) ||
        Object.hasOwn(previous.facts, field),
    )
    .map((field) => ({
      field,
      old_value:
        previous === current &&
        field !== "target_file" &&
        field !== "edit_protected" &&
        currentObservation &&
        Object.hasOwn(currentObservation.facts, field)
          ? currentObservation.facts[field]
          : Object.hasOwn(previous.facts, field)
            ? previous.facts[field]
            : current.facts[field],
      current_value: current.facts[field],
    }));
  const protectedResources = [
    ...new Set(
      events
        .filter(
          (event) =>
            event.source === "policy" &&
            event.kind === "policy" &&
            event.facts.protected === true &&
            typeof event.facts.resource === "string",
        )
        .map((event) => String(event.facts.resource)),
    ),
  ].sort();
  if (
    protectedResources.includes(target) &&
    current.facts.edit_protected !== true &&
    !changes.some((change) => change.field === "edit_protected")
  ) {
    changes.push({
      field: "edit_protected",
      old_value: true,
      current_value: false,
    });
  }
  if (changes.length === 0) {
    throw new Error("runtime guard has no assessable current fields");
  }
  const digest = canonicalDigest({
    current_event_id: current.event_id,
    semantic_run_ids: runIds,
    changes,
    protected_resources: protectedResources,
  });
  return {
    schema_version: GUARD_SCHEMA_VERSION,
    guard_id: `guard:${digest.slice(0, 16)}`,
    relation_sha256: digest,
    entity: current.entity,
    older_event_id: previous.event_id,
    current_event_id: current.event_id,
    changes,
    protected_resources: protectedResources,
    scope: {
      codex_tools: [...mutatingTools.codex].sort(),
      omp_tools: [...mutatingTools.omp].sort(),
    },
    boundary:
      "Live guard compiled from two independently reviewed semantic task captures and host policy.",
  };
}

export async function loadExecutorGuard(path: string): Promise<ExecutorGuard> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value) || value.schema_version !== GUARD_SCHEMA_VERSION) {
    throw new Error("unsupported executor guard schema");
  }
  if (
    !Array.isArray(value.changes) ||
    value.changes.length === 0 ||
    !value.changes.every(isRecord)
  ) {
    throw new Error("executor guard must contain changes");
  }
  return value as ExecutorGuard;
}

function canonicalTarget(raw: string, cwd?: string | null): string {
  let normalized = raw.replaceAll("\\", "/").trim();
  if (cwd) {
    const cwdNormalized = cwd.replaceAll("\\", "/").replace(/\/$/, "");
    if (normalized.startsWith(`${cwdNormalized}/`))
      normalized = normalized.slice(cwdNormalized.length + 1);
  }
  normalized = posix.normalize(normalized);
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function patchTargets(command: string, cwd?: string | null): string[] {
  return [
    ...command.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm),
  ].map((match) => canonicalTarget(match[1] ?? "", cwd));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function valuePattern(field: string, value: unknown): RegExp {
  const rendered = JSON.stringify(value);
  const alternatives = new Set<string>([rendered ?? String(value)]);
  if (typeof value === "string") {
    alternatives.add(value);
    alternatives.add(JSON.stringify(value).slice(1, -1));
  } else if (typeof value === "boolean") {
    alternatives.add(String(value).toLowerCase());
    alternatives.add(value ? "True" : "False");
  } else alternatives.add(String(value));
  const valueExpression = `(?:${[...alternatives]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|")})`;
  return new RegExp(
    `["']?${escapeRegExp(field)}["']?\\s*[:=]\\s*["']?${valueExpression}["']?`,
    "i",
  );
}

function toolView(
  host: ExecutorHost,
  payload: Record<string, unknown>,
  guard: ExecutorGuard,
): ToolView {
  const toolName = payload.tool_name;
  const toolInput = payload.tool_input;
  const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
  if (typeof toolName !== "string" || !isRecord(toolInput)) {
    throw new Error("hook payload requires tool_name and object tool_input");
  }
  if (!mutatingTools[host].has(toolName))
    return { in_scope: false, tool_name: toolName, targets: [], content: "" };
  if (host === "omp" && opaqueOmpMutators.has(toolName)) {
    return {
      in_scope: true,
      tool_name: toolName,
      targets: [],
      content: canonicalStringify(toolInput),
    };
  }

  let targets: string[] = [];
  const contentParts: string[] = [];
  if (host === "codex" && toolName === "apply_patch") {
    if (typeof toolInput.command === "string") {
      targets = patchTargets(toolInput.command, cwd);
      contentParts.push(toolInput.command);
    }
  } else if (["write", "edit"].includes(toolName)) {
    if (typeof toolInput.path === "string")
      targets = [canonicalTarget(toolInput.path, cwd)];
    for (const key of [
      "content",
      "patch",
      "newText",
      "new_string",
      "oldText",
      "old_string",
    ]) {
      if (typeof toolInput[key] === "string") contentParts.push(toolInput[key]);
    }
  } else if (typeof toolInput.command === "string") {
    const command = toolInput.command;
    contentParts.push(command);
    if (simpleReadOnlyShellPattern.test(command)) {
      return {
        in_scope: false,
        tool_name: toolName,
        targets: [],
        content: command,
      };
    }
    const candidates = new Set<string>(guard.protected_resources);
    for (const change of guard.changes) {
      if (change.field === "target_file") {
        candidates.add(String(change.old_value));
        candidates.add(String(change.current_value));
      }
    }
    targets = [...candidates]
      .filter((path) => path && command.includes(path))
      .map((path) => canonicalTarget(path, cwd));
    const hasChangedValue = guard.changes.some(
      (change) =>
        typeof change.field === "string" &&
        (valuePattern(change.field, change.old_value).test(command) ||
          valuePattern(change.field, change.current_value).test(command)),
    );
    if (
      !shellMutationPattern.test(command) &&
      targets.length === 0 &&
      !hasChangedValue
    ) {
      return {
        in_scope: false,
        tool_name: toolName,
        targets: [],
        content: command,
      };
    }
  }
  return {
    in_scope: true,
    tool_name: toolName,
    targets: [...new Set(targets)].sort(),
    content: contentParts.join("\n"),
  };
}

export function evaluateExecutorCall(
  host: ExecutorHost,
  payload: Record<string, unknown>,
  guard: ExecutorGuard,
): ExecutorDecision {
  if (!(host in mutatingTools)) throw new Error("host must be codex or omp");
  if (guard.schema_version !== GUARD_SCHEMA_VERSION)
    throw new Error("unsupported executor guard schema");
  const view = toolView(host, payload, guard);
  if (!view.in_scope) {
    return {
      schema_version: DECISION_SCHEMA_VERSION,
      decision: "ALLOW",
      guard_id: guard.guard_id,
      reasons: ["tool is outside this guard's declared v0.2 scope"],
      tool: view,
    };
  }
  if (view.targets.length === 0) {
    return {
      schema_version: DECISION_SCHEMA_VERSION,
      decision: "BLOCK",
      guard_id: guard.guard_id,
      reasons: [
        "mutating tool call does not expose a guarded target; refusing to guess",
      ],
      tool: view,
    };
  }

  const reasons: string[] = [];
  const matchedChanges: string[] = [];
  const targetChange = guard.changes.find(
    (change) => change.field === "target_file",
  );
  if (targetChange) {
    const oldTarget = canonicalTarget(String(targetChange.old_value));
    const currentTarget = canonicalTarget(String(targetChange.current_value));
    if (oldTarget !== currentTarget && view.targets.includes(oldTarget)) {
      reasons.push(
        `tool targets stale path ${JSON.stringify(oldTarget)}; current reviewed path is ${JSON.stringify(currentTarget)}`,
      );
      matchedChanges.push("target_file");
    }
    for (const target of view.targets) {
      if (target !== currentTarget) {
        reasons.push(
          `tool targets unreviewed path ${JSON.stringify(target)}; current reviewed path is ${JSON.stringify(currentTarget)}`,
        );
        matchedChanges.push("target_file");
      }
    }
  }
  const protectedResources = new Set(
    guard.protected_resources.map((path) => canonicalTarget(path)),
  );
  const currentProtection = guard.changes.find(
    (change) => change.field === "edit_protected",
  )?.current_value;
  for (const target of view.targets) {
    if (protectedResources.has(target) && currentProtection === false) {
      reasons.push(
        `current reviewed context forbids editing protected target ${JSON.stringify(target)}`,
      );
      matchedChanges.push("edit_protected");
    }
  }
  for (const change of guard.changes) {
    const field = change.field;
    if (
      field === "target_file" ||
      field === "edit_protected" ||
      typeof field !== "string"
    )
      continue;
    if (change.old_value === change.current_value) continue;
    const usesCurrent = valuePattern(field, change.current_value).test(
      view.content,
    );
    if (
      valuePattern(field, change.old_value).test(view.content) &&
      !usesCurrent
    ) {
      reasons.push(
        `tool arguments use stale ${field}=${JSON.stringify(change.old_value)}; current reviewed value is ${JSON.stringify(change.current_value)}`,
      );
      matchedChanges.push(field);
    } else if (
      payloadBoundScalarFields.has(field) &&
      ["write", "edit"].includes(view.tool_name) &&
      !usesCurrent
    ) {
      reasons.push(
        `tool arguments do not bind reviewed current ${field}=${JSON.stringify(change.current_value)}`,
      );
      matchedChanges.push(field);
    }
  }
  return {
    schema_version: DECISION_SCHEMA_VERSION,
    decision: reasons.length > 0 ? "BLOCK" : "ALLOW",
    guard_id: guard.guard_id,
    reasons:
      reasons.length > 0
        ? reasons
        : [
            "actual tool arguments do not conflict with the reviewed current context",
          ],
    matched_changes: [...new Set(matchedChanges)].sort(),
    tool: view,
  };
}

export function codexHookOutput(
  decision: ExecutorDecision,
): Record<string, unknown> | null {
  if (decision.decision !== "BLOCK") return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `ContextAdapt blocked this tool call: ${decision.reasons.join("; ")}`,
    },
  };
}
