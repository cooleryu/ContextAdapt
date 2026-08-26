import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  compileRuntimeExecutorGuard,
  type ContextTier,
  isRecord,
  prepareAdaptiveContext,
  summarizeInteractionCosts,
  type ContextRecommendationResult,
  type ExecutorGuard,
  type HostContextItem,
  type InteractionCostSummary,
  type ToolTraceRecord,
  type TraceEvent,
} from "../../core/src/index.js";
import { DEFAULT_MODEL, type CodexRunner } from "./semantic.js";
import {
  runTwoPassCodexTaskCapture,
  type CapturedTask,
} from "./task-capture.js";
import { codexRuntimeStem } from "./runtime-hook.js";

export const CODEX_ADAPTIVE_SESSION_VERSION =
  "contextadapt.codex-adaptive-session.v1" as const;

export interface CodexAdaptiveMessage {
  role: "user" | "assistant" | "tool" | "host";
  text: string;
}

export interface CodexAdaptiveSession {
  schema_version: typeof CODEX_ADAPTIVE_SESSION_VERSION;
  session_id: string;
  messages: CodexAdaptiveMessage[];
  events: TraceEvent[];
  total_model_input_tokens: number;
  total_preflight_input_tokens: number;
  observed_fixed_input_tokens: number | null;
}

export interface CodexAdaptiveRunResult {
  session: CodexAdaptiveSession;
  task_model: string;
  review_model: string;
  context_policy: CodexContextPolicy;
  selected_tier: ContextTier | null;
  recommendation: ContextRecommendationResult;
  guard: ExecutorGuard | null;
  agent_called: boolean;
  agent_message: string | null;
  actual_agent_input_tokens: number;
  actual_total_input_tokens: number;
  latency_ms: number;
  interaction_cost: InteractionCostSummary;
  hook_attestation: CodexHookAttestation;
  provider_thread_hash: string;
}

export interface CodexHookAttestation {
  hooks_observed: boolean;
  user_prompt_events: number;
  pre_tool_gate_events: number;
  post_tool_result_events: number;
  allowed_mutation_gates: number;
  execution_result_events: number;
}

export type CodexContextPolicy = "contextadapt" | "always-largest";

export interface CodexAdaptiveRunOptions {
  cwd: string;
  /** Model that performs the user task after ContextAdapt selects a tier. */
  model?: string;
  /** Separate low-cost model used for the two independent task reviews. */
  review_model?: string;
  model_context_window?: number;
  reasoning_effort?: "low" | "medium" | "high";
  timeoutMs?: number;
  /** Test or host override for semantic review subprocesses only. */
  review_runner?: CodexRunner;
  runner?: CodexRunner;
  captureTask?: (
    prompt: string,
    previous: TraceEvent | null,
    options: { sequence: number; session_id: string },
  ) => CapturedTask | Promise<CapturedTask>;
  countTokens?: (text: string) => number;
  runtimeDirectory?: string;
  fixed_input_tokens?: number;
  /** Shadow/replay baselines can force the measured largest host window. */
  context_policy?: CodexContextPolicy;
  /** Tests and external orchestrators with an equivalent gate may opt out. */
  requireInstalledHook?: boolean;
  /** Only for a fresh isolated workspace whose hook file was just reviewed. */
  bypassHookTrustForIsolatedTest?: boolean;
}

const sha = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export function emptyCodexAdaptiveSession(
  sessionId: string,
): CodexAdaptiveSession {
  if (!sessionId.trim()) throw new Error("session ID must not be empty");
  return {
    schema_version: CODEX_ADAPTIVE_SESSION_VERSION,
    session_id: sessionId,
    messages: [],
    events: [],
    total_model_input_tokens: 0,
    total_preflight_input_tokens: 0,
    observed_fixed_input_tokens: null,
  };
}

export function currentCodexTask(events: TraceEvent[]): TraceEvent | null {
  return (
    events
      .filter(
        (event) =>
          event.source === "user" &&
          event.kind === "state" &&
          typeof event.facts.target_file === "string",
      )
      .sort(
        (left, right) =>
          (left.sequence ?? -1) - (right.sequence ?? -1) ||
          left.event_id.localeCompare(right.event_id),
      )
      .at(-1) ?? null
  );
}

function nextSequence(events: TraceEvent[]): number {
  return Math.max(0, ...events.map((event) => event.sequence ?? 0)) + 1;
}

function protectedPath(path: string): boolean {
  return /(^|\/)(?:\.env(?:\.|$)|secrets?(?:\.|\/|$)|credentials?(?:\.|\/|$))/i.test(
    path,
  );
}

function policyFor(task: TraceEvent, sequence: number): TraceEvent {
  const target = String(task.facts.target_file);
  return {
    event_id: `policy:${sha(target).slice(0, 20)}`,
    source: "policy",
    kind: "policy",
    entity: `resource:${target}`,
    sequence,
    observed_at: new Date().toISOString(),
    success: true,
    facts: {
      resource: target,
      protected: protectedPath(target),
      always_visible: true,
      classification_rule: "contextadapt_sensitive_path_v1",
    },
    links: {},
    text: `Host policy for ${target}.`,
  };
}

async function readTarget(
  cwd: string,
  task: TraceEvent,
  sequence: number,
): Promise<TraceEvent> {
  const target = String(task.facts.target_file);
  const absolute = resolve(cwd, target);
  const back = relative(cwd, absolute);
  try {
    if (isAbsolute(back) || back.startsWith("..")) {
      throw new Error("task target is outside the Codex workspace");
    }
    const text = await readFile(absolute, "utf8");
    if (Buffer.byteLength(text, "utf8") > 1_000_000) {
      throw new Error("target exceeds the 1 MB preflight read limit");
    }
    let facts: Record<string, unknown> = {
      target_file: target,
      bytes: Buffer.byteLength(text, "utf8"),
      sha256: sha(text),
    };
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        facts = { ...facts, ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // Byte/hash evidence is still valid for a non-JSON file.
    }
    return {
      event_id: `preflight-read:${sha(`${target}:${facts.sha256}`).slice(0, 20)}`,
      source: "read_file",
      kind: "observation",
      entity: `file:${target}`,
      sequence,
      observed_at: new Date().toISOString(),
      success: true,
      facts,
      links: {},
      text: `ContextAdapt verified ${target} before the Agent call.\n${text}`,
    };
  } catch (error) {
    return {
      event_id: `preflight-read-failed:${sha(`${target}:${sequence}`).slice(0, 20)}`,
      source: "read_file",
      kind: "observation",
      entity: `file:${target}`,
      sequence,
      observed_at: new Date().toISOString(),
      success: false,
      facts: {
        target_file: target,
        error: error instanceof Error ? error.message : String(error),
      },
      links: {},
      text: `ContextAdapt could not verify ${target} before the Agent call.`,
    };
  }
}

function defaultCount(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

function hostItems(
  messages: CodexAdaptiveMessage[],
  count: (text: string) => number,
): HostContextItem<CodexAdaptiveMessage>[] {
  return messages.map((message, index) => ({
    id: `codex-message-${index}`,
    role:
      message.role === "host"
        ? "custom"
        : message.role === "tool"
          ? "tool"
          : message.role,
    text: message.text,
    token_count: Math.max(1, count(message.text)),
    value: message,
  }));
}

export function renderCodexAgentInput(
  messages: CodexAdaptiveMessage[],
): string {
  return `The host selected the following model-visible conversation history. Act on the latest user task. Do not infer facts that are absent.\n\n${JSON.stringify(
    messages,
  )}`;
}

export function appendCodexPublicTurn(
  session: CodexAdaptiveSession,
  prompt: string,
  stdout: string,
): {
  session: CodexAdaptiveSession;
  actual_input_tokens: number;
  provider_thread_hash: string;
} {
  if (!prompt.trim())
    throw new Error("observed Codex prompt must not be empty");
  const parsed = parseCodexAdaptiveAgentStream(stdout);
  const actualTokens = actualInputTokens({ usage: parsed.usage });
  return {
    session: {
      ...session,
      messages: [
        ...session.messages,
        { role: "user", text: prompt },
        ...parsed.history_messages,
      ],
      total_model_input_tokens: session.total_model_input_tokens + actualTokens,
    },
    actual_input_tokens: actualTokens,
    provider_thread_hash: parsed.provider_thread_hash,
  };
}

function defaultRunner(
  command: string,
  args: string[],
  options: { input: string; timeout: number; cwd: string },
) {
  return spawnSync(command, args, {
    input: options.input,
    timeout: options.timeout,
    cwd: options.cwd,
    encoding: "utf8",
  });
}

function actualInputTokens(attestation: Record<string, unknown>): number {
  const usage = attestation.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return 0;
  const raw = (usage as Record<string, unknown>).input_tokens;
  return Number.isInteger(raw) && Number(raw) >= 0 ? Number(raw) : 0;
}

function publicItemMessage(
  item: Record<string, unknown>,
): CodexAdaptiveMessage | null {
  const type = String(item.type ?? "");
  if (type === "agent_message") {
    const text = typeof item.text === "string" ? item.text : "";
    return text ? { role: "assistant", text } : null;
  }
  if (!type || type === "reasoning") return null;
  const copy = { ...item };
  delete copy.id;
  return {
    role: "tool",
    text: JSON.stringify({ public_codex_item: copy }),
  };
}

export function parseCodexAdaptiveAgentStream(stdout: string): {
  text: string;
  usage: Record<string, unknown>;
  provider_thread_hash: string;
  history_messages: CodexAdaptiveMessage[];
} {
  let text = "";
  let completed = false;
  let threadId = "";
  let usage: Record<string, unknown> = {};
  const historyMessages: CodexAdaptiveMessage[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "thread.started")
      threadId = String(event.thread_id ?? "");
    if (event.type === "turn.completed") {
      completed = true;
      if (
        event.usage &&
        typeof event.usage === "object" &&
        !Array.isArray(event.usage)
      ) {
        usage = event.usage as Record<string, unknown>;
      }
    }
    const item = event.item;
    if (
      event.type === "item.completed" &&
      item &&
      typeof item === "object" &&
      !Array.isArray(item)
    ) {
      const message = publicItemMessage(item as Record<string, unknown>);
      if (message) historyMessages.push(message);
    }
    if (
      event.type === "item.completed" &&
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === "agent_message"
    ) {
      text = String((item as Record<string, unknown>).text ?? "");
    }
  }
  if (!threadId)
    throw new Error("Codex adaptive stream lacked provider thread identity");
  if (!completed)
    throw new Error("Codex adaptive stream lacked a completed turn");
  if (!text)
    throw new Error("Codex adaptive stream lacked a final Agent message");
  return {
    text,
    usage,
    provider_thread_hash: sha(threadId).slice(0, 20),
    history_messages: historyMessages,
  };
}

function emptyHookAttestation(): CodexHookAttestation {
  return {
    hooks_observed: false,
    user_prompt_events: 0,
    pre_tool_gate_events: 0,
    post_tool_result_events: 0,
    allowed_mutation_gates: 0,
    execution_result_events: 0,
  };
}

async function hookToolRecordsSince(
  runtimeDirectory: string,
  startedAt: number,
): Promise<{
  records: ToolTraceRecord[];
  attestation: CodexHookAttestation;
}> {
  let names: string[] = [];
  try {
    names = (await readdir(runtimeDirectory)).filter((name) =>
      name.endsWith(".recording.jsonl"),
    );
  } catch {
    return { records: [], attestation: emptyHookAttestation() };
  }
  const result: ToolTraceRecord[] = [];
  const attestation = emptyHookAttestation();
  for (const name of names) {
    let text = "";
    try {
      text = await readFile(resolve(runtimeDirectory, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(line);
        if (!isRecord(value)) continue;
        record = value;
      } catch {
        continue;
      }
      const observed = Date.parse(String(record.observed_at ?? ""));
      if (!Number.isFinite(observed) || observed < startedAt) continue;
      if (record.event === "user_prompt") {
        attestation.user_prompt_events += 1;
      }
      if (record.event === "pre_tool_gate") {
        attestation.pre_tool_gate_events += 1;
        if (record.in_scope === true && record.decision === "ALLOW") {
          attestation.allowed_mutation_gates += 1;
        }
      }
      if (record.event === "tool_result") {
        attestation.post_tool_result_events += 1;
        if (record.phase === "execution") {
          attestation.execution_result_events += 1;
        }
      }
      if (record.event === "recovery_read") {
        result.push({
          call_id: `recovery:${String(record.target ?? "unknown")}:${String(record.recovery_count ?? 1)}`,
          attempt: Number(record.recovery_count ?? 1),
          phase: "retrieval",
          trigger: "contextadapt_recovery",
          tool_name: "read",
          resource: typeof record.target === "string" ? record.target : null,
          call_fingerprint: sha(`read:${String(record.target ?? "unknown")}`),
          status:
            record.success === true
              ? "completed"
              : record.success === false
                ? "failed"
                : "unknown",
          input_tokens: Number.isInteger(record.input_tokens)
            ? Number(record.input_tokens)
            : 0,
          latency_ms: Number.isInteger(record.latency_ms)
            ? Number(record.latency_ms)
            : 0,
        });
      } else if (
        record.event === "pre_tool_gate" &&
        record.decision === "BLOCK"
      ) {
        result.push({
          call_id: String(record.tool_use_id ?? `blocked:${result.length}`),
          attempt: Number.isInteger(record.attempt)
            ? Number(record.attempt)
            : 0,
          phase: "execution",
          trigger: "agent",
          tool_name: String(record.tool_name ?? "unknown"),
          resource: typeof record.target === "string" ? record.target : null,
          call_fingerprint: String(
            record.call_fingerprint ?? sha(JSON.stringify(record)),
          ),
          status: "blocked",
          input_tokens: 0,
          latency_ms: 0,
        });
      } else if (
        record.event === "tool_result" &&
        (record.phase === "retrieval" || record.phase === "execution")
      ) {
        result.push({
          call_id: String(record.tool_use_id ?? `tool:${result.length}`),
          attempt: Number.isInteger(record.attempt)
            ? Number(record.attempt)
            : 0,
          phase: record.phase,
          trigger: "agent",
          tool_name: String(record.tool_name ?? "unknown"),
          resource: typeof record.target === "string" ? record.target : null,
          call_fingerprint: String(
            record.call_fingerprint ?? sha(JSON.stringify(record)),
          ),
          status:
            record.success === true
              ? "completed"
              : record.success === false
                ? "failed"
                : "unknown",
          input_tokens: 0,
          latency_ms: 0,
        });
      }
    }
  }
  attestation.hooks_observed =
    attestation.user_prompt_events > 0 ||
    attestation.pre_tool_gate_events > 0 ||
    attestation.post_tool_result_events > 0;
  return { records: result, attestation };
}

export async function runCodexAdaptiveTurn(
  session: CodexAdaptiveSession,
  prompt: string,
  options: CodexAdaptiveRunOptions,
): Promise<CodexAdaptiveRunResult> {
  if (session.schema_version !== CODEX_ADAPTIVE_SESSION_VERSION) {
    throw new Error("unsupported Codex adaptive session schema");
  }
  if (!prompt.trim())
    throw new Error("Codex adaptive prompt must not be empty");
  const cwd = resolve(options.cwd);
  const taskModel = (options.model ?? DEFAULT_MODEL).trim();
  const reviewModel = (options.review_model ?? DEFAULT_MODEL).trim();
  if (!taskModel) throw new Error("Codex task model must not be empty");
  if (!reviewModel) throw new Error("Codex review model must not be empty");
  const capture =
    options.captureTask ??
    ((
      text: string,
      previous: TraceEvent | null,
      captureOptions: { sequence: number; session_id: string },
    ) =>
      runTwoPassCodexTaskCapture(text, previous, {
        ...captureOptions,
        model: reviewModel,
        runner: options.review_runner,
      }));
  const captured = await capture(prompt, currentCodexTask(session.events), {
    sequence: nextSequence(session.events),
    session_id: session.session_id,
  });
  const events = session.events.filter(
    (event) => event.entity !== "context:profile",
  );
  if (captured.event) events.push(captured.event);
  const messages = [
    ...session.messages,
    { role: "user" as const, text: prompt },
  ];
  const toolRecords: ToolTraceRecord[] = [];
  let guard: ExecutorGuard | null = null;
  if (captured.event) {
    if (
      !events.some(
        (event) =>
          event.source === "policy" &&
          event.facts.resource === captured.event!.facts.target_file,
      )
    ) {
      events.push(policyFor(captured.event, nextSequence(events)));
    }
    const observation = await readTarget(
      cwd,
      captured.event,
      nextSequence(events),
    );
    events.push(observation);
    messages.push({ role: "host", text: observation.text });
    toolRecords.push({
      call_id: `preflight:${observation.event_id}`,
      attempt: 0,
      phase: "retrieval",
      trigger: "preflight",
      tool_name: "read",
      resource: String(captured.event.facts.target_file),
      call_fingerprint: sha(`read:${String(captured.event.facts.target_file)}`),
      status: observation.success ? "completed" : "failed",
      input_tokens: (options.countTokens ?? defaultCount)(observation.text),
      latency_ms: 0,
    });
    guard = compileRuntimeExecutorGuard(events);
  }
  const prepared = prepareAdaptiveContext(
    events,
    hostItems(messages, options.countTokens ?? defaultCount),
    {
      trace_id: session.session_id,
      fixed_input_tokens:
        options.fixed_input_tokens ??
        (session.observed_fixed_input_tokens === null
          ? 90_000
          : Math.ceil(session.observed_fixed_input_tokens * 1.1)),
      available_context_tokens: options.model_context_window ?? 950_000,
    },
  );
  const nextSession: CodexAdaptiveSession = {
    ...session,
    messages,
    events: prepared.events,
    total_preflight_input_tokens:
      session.total_preflight_input_tokens + captured.preflight_input_tokens,
  };
  const contextPolicy = options.context_policy ?? "contextadapt";
  const selectedTier: ContextTier | null =
    contextPolicy === "always-largest"
      ? prepared.windows["1M_WINDOW"].supported
        ? "1M_WINDOW"
        : null
      : prepared.recommendation.recommended_tier;
  const selectedItems = selectedTier
    ? prepared.windows[selectedTier].items
    : [];
  if (!selectedTier || !guard) {
    return {
      session: nextSession,
      task_model: taskModel,
      review_model: reviewModel,
      context_policy: contextPolicy,
      selected_tier: selectedTier,
      recommendation: prepared.recommendation,
      guard,
      agent_called: false,
      agent_message: null,
      actual_agent_input_tokens: 0,
      actual_total_input_tokens: captured.preflight_input_tokens,
      latency_ms: 0,
      interaction_cost: summarizeInteractionCosts(toolRecords),
      hook_attestation: emptyHookAttestation(),
      provider_thread_hash: "",
    };
  }
  if (options.requireInstalledHook ?? true) {
    let hookConfig = "";
    try {
      hookConfig = await readFile(resolve(cwd, ".codex/hooks.json"), "utf8");
    } catch {
      // The error below deliberately avoids calling the Agent without a gate.
    }
    if (
      !hookConfig.includes("PreToolUse") ||
      !hookConfig.includes("host-hook codex")
    ) {
      throw new Error(
        "Codex adaptive run requires the reviewed ContextAdapt PreToolUse hook at .codex/hooks.json",
      );
    }
  }
  const runtimeDirectory =
    options.runtimeDirectory ?? resolve(cwd, ".contextadapt/runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(
    resolve(
      runtimeDirectory,
      `${codexRuntimeStem(session.session_id)}.guard.json`,
    ),
    `${JSON.stringify(guard, null, 2)}\n`,
  );
  await mkdir(resolve(cwd, ".contextadapt"), { recursive: true });
  await writeFile(
    resolve(cwd, ".contextadapt/executor-guard.json"),
    `${JSON.stringify(guard, null, 2)}\n`,
  );

  const runner = options.runner ?? defaultRunner;
  const modelContextWindow = options.model_context_window ?? 950_000;
  const started = Date.now();
  const args = [
    "exec",
    "--ignore-rules",
    "--strict-config",
    "--skip-git-repo-check",
    "--disable",
    "plugins",
    "--disable",
    "recommended_plugins",
    "--disable",
    "remote_plugin",
    "--disable",
    "apps",
    "--enable",
    "hooks",
    "--model",
    taskModel,
    "-c",
    `model_context_window=${modelContextWindow}`,
    "-c",
    `model_auto_compact_token_limit=${Math.max(1, modelContextWindow - 10_000)}`,
    "-c",
    `model_reasoning_effort=\"${options.reasoning_effort ?? "low"}\"`,
    "--sandbox",
    "workspace-write",
    "--cd",
    cwd,
    "--json",
    "-",
  ];
  if (options.bypassHookTrustForIsolatedTest) {
    args.splice(2, 0, "--dangerously-bypass-hook-trust");
  }
  const result = runner("codex", args, {
    input: renderCodexAgentInput(selectedItems.map((item) => item.value)),
    timeout: options.timeoutMs ?? 600_000,
    cwd,
  });
  const latency = Date.now() - started;
  if (result.status !== 0) {
    throw new Error(
      `Codex adaptive Agent failed with exit ${result.status}: ${(result.stderr || "no stderr").trim().slice(-1200)}`,
    );
  }
  const parsed = parseCodexAdaptiveAgentStream(result.stdout);
  const agentMessage = parsed.text;
  const actualTokens = actualInputTokens({ usage: parsed.usage });
  const selectedHistoryEstimate = selectedItems.reduce(
    (sum, item) => sum + item.token_count,
    0,
  );
  nextSession.messages.push(...parsed.history_messages);
  nextSession.total_model_input_tokens += actualTokens;
  nextSession.observed_fixed_input_tokens = Math.max(
    0,
    actualTokens - selectedHistoryEstimate,
  );
  const hookActivity = await hookToolRecordsSince(runtimeDirectory, started);
  toolRecords.push(...hookActivity.records);
  return {
    session: nextSession,
    task_model: taskModel,
    review_model: reviewModel,
    context_policy: contextPolicy,
    selected_tier: selectedTier,
    recommendation: prepared.recommendation,
    guard,
    agent_called: true,
    agent_message: agentMessage,
    actual_agent_input_tokens: actualTokens,
    actual_total_input_tokens: captured.preflight_input_tokens + actualTokens,
    latency_ms: latency,
    interaction_cost: summarizeInteractionCosts(toolRecords),
    hook_attestation: hookActivity.attestation,
    provider_thread_hash: parsed.provider_thread_hash,
  };
}

export async function loadCodexAdaptiveSession(
  path: string,
): Promise<CodexAdaptiveSession> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex adaptive session must be one JSON object");
  }
  const session = value as CodexAdaptiveSession;
  if (session.schema_version !== CODEX_ADAPTIVE_SESSION_VERSION) {
    throw new Error("unsupported Codex adaptive session schema");
  }
  return {
    ...session,
    total_model_input_tokens: session.total_model_input_tokens ?? 0,
    total_preflight_input_tokens: session.total_preflight_input_tokens ?? 0,
    observed_fixed_input_tokens: session.observed_fixed_input_tokens ?? null,
  };
}

export async function saveCodexAdaptiveSession(
  path: string,
  session: CodexAdaptiveSession,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`);
}
