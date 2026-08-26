import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  compileRuntimeExecutorGuard,
  isRecord,
  prepareAdaptiveContext,
  type ContextRecommendationResult,
  type ContextTier,
  type ExecutorGuard,
  type HostContextItem,
  type TraceEvent,
} from "../../core/src/index.js";
import {
  currentCodexTask,
  type CodexAdaptiveSession,
  type CodexAdaptiveMessage,
} from "./adaptive-runner.js";
import {
  CodexAppServerClient,
  type CodexAppServerThread,
} from "./app-server.js";
import {
  codexRuntimeStem,
  loadCodexPassiveSnapshot,
  loadLatestCodexPrivateSessionReference,
  type CodexPassiveSnapshotEntry,
} from "./runtime-hook.js";
import {
  runTwoPassCodexTaskCapture,
  type CapturedTask,
} from "./task-capture.js";

export const CODEX_PASSIVE_OBSERVATION_VERSION =
  "contextadapt.codex-passive-observation.v1" as const;

export type PassiveCohortBucket = "200K" | "400K" | "LARGE" | "BLOCK" | "NULL";

export interface CodexPassiveObservation {
  schema_version: typeof CODEX_PASSIVE_OBSERVATION_VERSION;
  captured_at: string;
  capture_mode: "post_run_read_only";
  cohort_bucket: PassiveCohortBucket;
  source: {
    adapter: "codex_app_server_thread_read";
    thread_id_sha256: string;
    session_id_sha256: string | null;
    cwd_sha256: string;
    model_provider: string | null;
    turn_count: number;
    item_count: number;
    decision_message_count: number;
    post_task_messages_excluded: number;
    item_type_counts: Record<string, number>;
    native_tool_outcomes: {
      completed: number;
      failed: number;
      unknown: number;
    };
    history_content_sha256: string;
    history_chars: number;
    history_tokens_estimated: number;
    token_measurement: "utf8_bytes_div_4_host_estimate";
  };
  task_capture: {
    user_prompts_reviewed: number;
    actionable_updates: number;
    semantic_calls: number;
    semantic_preflight_input_tokens: number;
    current_target_sha256: string | null;
    run_attestations: Array<Record<string, unknown>>;
  };
  decision: {
    recommendation: ContextRecommendationResult["recommendation"] | "NULL";
    null_reason:
      "full_history_fits_200k_without_selection" | "no_actionable_task" | null;
    selected_tier: ContextTier | null;
    expected_total_input_tokens: number | null;
    always_largest_input_tokens: number | null;
    estimated_savings_tokens: number | null;
    estimated_savings_percent: number | null;
    tier_safe: Record<ContextTier, boolean> | null;
    unresolved_counts: Record<ContextTier, number> | null;
  };
  execution_gate: {
    status: "READY" | "BLOCKED" | "NOT_APPLICABLE";
    session_guard_written: boolean;
    guard_id_sha256: string | null;
    current_observation_success: boolean | null;
  };
  hook_attestation: {
    recording_observed: boolean;
    user_prompt_events: number;
    observed_pre_tool_calls: number;
    post_tool_result_events: number;
    execution_result_events: number;
    unknown_tool_outcomes: number;
    pre_tool_gate_events: 0;
    primary_hook_mode: "observe_only";
    snapshot_target_count: number;
    replayable_snapshot: boolean;
  };
  provider_usage: {
    actual_input_tokens: null;
    note: "thread/read is local/read-only; actual provider usage is recorded only by an optional native probe or replay";
  };
  privacy: {
    raw_thread_id_in_report: false;
    raw_prompts_in_report: false;
    raw_paths_in_report: false;
    private_reference_local_only: true;
  };
}

export interface ObserveCodexPassiveOptions {
  cwd: string;
  model?: string;
  model_context_window?: number;
  fixed_input_tokens?: number;
  privateDirectory?: string;
  runtimeDirectory?: string;
  appServer?: Pick<CodexAppServerClient, "threadRead">;
  captureTask?: (
    prompt: string,
    previous: TraceEvent | null,
    options: { sequence: number; session_id: string },
  ) => CapturedTask | Promise<CapturedTask>;
  countTokens?: (text: string) => number;
  /** Research-only: run semantic capture even when the full history fits 200K. */
  forceAnalysis?: boolean;
  allowRemoteContent?: boolean;
}

export interface ObserveCodexPassiveResult {
  report: CodexPassiveObservation;
  recommendation: ContextRecommendationResult | null;
  guard: ExecutorGuard | null;
  selected_messages: CodexAdaptiveMessage[];
  replay: PassiveReplayBlueprint | null;
}

export interface PassiveReplayBlueprint {
  session: CodexAdaptiveSession;
  prompt: string;
  captured: CapturedTask;
  initial_files: CodexPassiveSnapshotEntry[];
}

interface NativeHistory {
  messages: CodexAdaptiveMessage[];
  items: HostContextItem<CodexAdaptiveMessage>[];
  userPrompts: string[];
  userPromptEntries: Array<{ prompt: string; messageIndex: number }>;
  itemTypeCounts: Record<string, number>;
  itemCount: number;
  contentHash: string;
  chars: number;
  estimatedTokens: number;
  toolOutcomes: { completed: number; failed: number; unknown: number };
}

interface PassiveHookAttestation {
  recording_observed: boolean;
  user_prompt_events: number;
  observed_pre_tool_calls: number;
  post_tool_result_events: number;
  execution_result_events: number;
  unknown_tool_outcomes: number;
  pre_tool_gate_events: number;
}

const sha = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function defaultCount(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

function nextSequence(events: TraceEvent[]): number {
  return Math.max(0, ...events.map((event) => event.sequence ?? 0)) + 1;
}

function itemText(item: Record<string, unknown>): {
  role: CodexAdaptiveMessage["role"];
  text: string;
} | null {
  const type = String(item.type ?? "unknown");
  if (type === "userMessage" && Array.isArray(item.content)) {
    const text = item.content
      .filter(
        (part): part is Record<string, unknown> =>
          isRecord(part) &&
          part.type === "text" &&
          typeof part.text === "string",
      )
      .map((part) => String(part.text))
      .join("\n");
    return text ? { role: "user", text } : null;
  }
  if (type === "agentMessage" && typeof item.text === "string") {
    return item.text ? { role: "assistant", text: item.text } : null;
  }
  if (type === "reasoning" || type === "contextCompaction") return null;
  const publicItem = { ...item };
  delete publicItem.id;
  return {
    role: type === "hookPrompt" ? "host" : "tool",
    text: JSON.stringify({ codex_native_item: publicItem }),
  };
}

export function codexThreadHistory(
  thread: CodexAppServerThread,
  countTokens: (text: string) => number = defaultCount,
): NativeHistory {
  const messages: CodexAdaptiveMessage[] = [];
  const userPrompts: string[] = [];
  const userPromptEntries: Array<{ prompt: string; messageIndex: number }> = [];
  const itemTypeCounts: Record<string, number> = {};
  const toolOutcomes = { completed: 0, failed: 0, unknown: 0 };
  let itemCount = 0;
  for (const turn of thread.turns) {
    if (!isRecord(turn) || !Array.isArray(turn.items)) continue;
    for (const item of turn.items) {
      if (!isRecord(item)) continue;
      itemCount += 1;
      const type = String(item.type ?? "unknown");
      itemTypeCounts[type] = (itemTypeCounts[type] ?? 0) + 1;
      if (
        [
          "commandExecution",
          "fileChange",
          "mcpToolCall",
          "dynamicToolCall",
        ].includes(type)
      ) {
        const status = String(item.status ?? "").toLowerCase();
        if (
          status === "completed" ||
          status === "success" ||
          item.success === true
        ) {
          toolOutcomes.completed += 1;
        } else if (
          ["failed", "error", "declined", "cancelled"].includes(status) ||
          item.success === false
        ) {
          toolOutcomes.failed += 1;
        } else {
          toolOutcomes.unknown += 1;
        }
      }
      const converted = itemText(item);
      if (!converted) continue;
      const messageIndex = messages.length;
      messages.push(converted);
      if (converted.role === "user") {
        userPrompts.push(converted.text);
        userPromptEntries.push({ prompt: converted.text, messageIndex });
      }
    }
  }
  const items = messages.map((message, index) => ({
    id: `codex-native-message-${index}`,
    role:
      message.role === "host"
        ? ("custom" as const)
        : message.role === "tool"
          ? ("tool" as const)
          : message.role,
    text: message.text,
    token_count: Math.max(1, countTokens(message.text)),
    value: message,
  }));
  const canonical = JSON.stringify(messages);
  return {
    messages,
    items,
    userPrompts,
    userPromptEntries,
    itemTypeCounts,
    itemCount,
    contentHash: sha(canonical),
    chars: messages.reduce((total, message) => total + message.text.length, 0),
    estimatedTokens: items.reduce((total, item) => total + item.token_count, 0),
    toolOutcomes,
  };
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

async function currentObservation(
  cwd: string,
  task: TraceEvent,
  sequence: number,
): Promise<TraceEvent> {
  const target = String(task.facts.target_file);
  const absolute = resolve(cwd, target);
  const back = relative(cwd, absolute);
  let text = "";
  let error: string | null = null;
  try {
    if (isAbsolute(back) || back.startsWith("..")) {
      throw new Error("task target is outside the workspace");
    }
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error("task target is a symbolic link");
    }
    const realWorkspace = await realpath(cwd);
    const realTarget = await realpath(absolute);
    const realBack = relative(realWorkspace, realTarget);
    if (isAbsolute(realBack) || realBack.startsWith("..")) {
      throw new Error("task target resolves outside the workspace");
    }
    text = await readFile(realTarget, "utf8");
    if (Buffer.byteLength(text, "utf8") > 1_000_000) {
      throw new Error("task target exceeds the 1 MB observation limit");
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const visible = error
    ? `ContextAdapt could not verify ${target}: ${error}`
    : `Verified current ${target}:\n${text}`;
  return {
    event_id: `observation:${sha(`${target}:${text}:${error ?? "ok"}`).slice(0, 20)}`,
    source: "read_file",
    kind: "observation",
    entity: `file:${target}`,
    sequence,
    observed_at: new Date().toISOString(),
    success: error === null,
    facts: {
      target_file: target,
      bytes: Buffer.byteLength(text, "utf8"),
      sha256: sha(text),
      error,
    },
    links: {},
    text: visible,
  };
}

function publicAttestation(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    ["provider", "model", "thread_id_sha256", "output_sha256", "usage"]
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]]),
  );
}

function bucketFor(
  tier: ContextTier | null,
  hasTask: boolean,
): PassiveCohortBucket {
  if (!hasTask) return "NULL";
  if (tier === "200K") return "200K";
  if (tier === "400K") return "400K";
  if (tier === "1M_WINDOW") return "LARGE";
  return "BLOCK";
}

async function saveSessionGuard(
  runtimeDirectory: string,
  threadId: string,
  guard: ExecutorGuard,
): Promise<void> {
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(
    resolve(runtimeDirectory, `${codexRuntimeStem(threadId)}.guard.json`),
    `${JSON.stringify(guard, null, 2)}\n`,
  );
}

async function passiveHookAttestation(
  runtimeDirectory: string,
  threadId: string,
): Promise<PassiveHookAttestation> {
  const empty: PassiveHookAttestation = {
    recording_observed: false,
    user_prompt_events: 0,
    observed_pre_tool_calls: 0,
    post_tool_result_events: 0,
    execution_result_events: 0,
    unknown_tool_outcomes: 0,
    pre_tool_gate_events: 0,
  };
  let text: string;
  try {
    text = await readFile(
      resolve(
        runtimeDirectory,
        `${codexRuntimeStem(threadId)}.recording.jsonl`,
      ),
      "utf8",
    );
  } catch {
    return empty;
  }
  const result = { ...empty, recording_observed: true };
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
    if (record.event === "user_prompt") result.user_prompt_events += 1;
    if (record.event === "pre_tool_shadow") {
      result.observed_pre_tool_calls += 1;
    }
    if (record.event === "pre_tool_gate") result.pre_tool_gate_events += 1;
    if (record.event === "tool_result") {
      result.post_tool_result_events += 1;
      if (record.success !== true && record.success !== false) {
        result.unknown_tool_outcomes += 1;
      }
      if (record.phase === "execution") result.execution_result_events += 1;
    }
  }
  return result;
}

/**
 * Observe a completed ordinary Codex task. The primary thread is only read;
 * semantic task capture and recommendation happen after it has completed.
 */
export async function observeCodexPassiveSession(
  options: ObserveCodexPassiveOptions,
): Promise<ObserveCodexPassiveResult> {
  const cwd = resolve(options.cwd);
  const reference = await loadLatestCodexPrivateSessionReference(
    cwd,
    options.privateDirectory,
  );
  const ownedClient = options.appServer
    ? null
    : await CodexAppServerClient.connect({ cwd });
  const appServer = options.appServer ?? ownedClient!;
  let thread: CodexAppServerThread;
  try {
    thread = await appServer.threadRead(reference.thread_id);
  } finally {
    ownedClient?.close();
  }
  if (sha(thread.id) !== reference.thread_id_sha256) {
    throw new Error("App Server returned a different thread identity");
  }
  const runtimeDirectory =
    options.runtimeDirectory ?? resolve(cwd, ".contextadapt/runtime");
  const hookAttestation = await passiveHookAttestation(
    runtimeDirectory,
    reference.thread_id,
  );
  if (hookAttestation.pre_tool_gate_events > 0) {
    throw new Error(
      "passive observation found enforcing pre-tool events in the primary run; reinstall with --passive-cohort before claiming an untouched primary",
    );
  }
  const snapshot = reference.last_turn_id
    ? await loadCodexPassiveSnapshot(
        cwd,
        reference.thread_id,
        reference.last_turn_id,
        options.privateDirectory,
      )
    : [];
  const countTokens = options.countTokens ?? defaultCount;
  const history = codexThreadHistory(thread, countTokens);
  const lastUserMessageIndex = history.userPromptEntries.at(-1)?.messageIndex;
  const fastDecisionMessages =
    lastUserMessageIndex === undefined
      ? history.messages
      : history.messages.slice(0, lastUserMessageIndex + 1);
  const fastDecisionTokens = fastDecisionMessages.reduce(
    (total, message) => total + countTokens(message.text),
    0,
  );
  const fullHistoryFitsSmallest =
    (options.fixed_input_tokens ?? 90_000) + fastDecisionTokens <= 200_000;
  const skipSemanticAnalysis =
    fullHistoryFitsSmallest && options.forceAnalysis !== true;
  if (
    !skipSemanticAnalysis &&
    !options.captureTask &&
    options.allowRemoteContent !== true
  ) {
    throw new Error(
      "history requires Luna semantic analysis; rerun with explicit remote-content consent",
    );
  }
  const capture =
    options.captureTask ??
    ((prompt: string, previous: TraceEvent | null, captureOptions) =>
      runTwoPassCodexTaskCapture(prompt, previous, {
        ...captureOptions,
        model: options.model ?? "gpt-5.6-luna",
      }));
  let taskEvents: TraceEvent[] = [];
  let previous: TraceEvent | null = null;
  let preflightTokens = 0;
  let actionableUpdates = 0;
  const attestations: Array<Record<string, unknown>> = [];
  let replay: PassiveReplayBlueprint | null = null;
  let activePromptMessageIndex: number | null = skipSemanticAnalysis
    ? (lastUserMessageIndex ?? null)
    : null;
  for (const { prompt, messageIndex } of skipSemanticAnalysis
    ? []
    : history.userPromptEntries) {
    const priorEvents = structuredClone(taskEvents);
    const priorCurrent = previous;
    const captured = await capture(prompt, previous, {
      sequence: nextSequence(taskEvents),
      session_id: reference.thread_id_sha256,
    });
    preflightTokens += captured.preflight_input_tokens;
    attestations.push(...captured.run_attestations.map(publicAttestation));
    if (!captured.event) continue;
    actionableUpdates += 1;
    if (previous && captured.event.entity !== previous.entity) {
      taskEvents = [captured.event];
      replay = {
        session: {
          schema_version: "contextadapt.codex-adaptive-session.v1",
          session_id: reference.thread_id_sha256,
          messages: history.messages.slice(0, messageIndex),
          events: [],
          total_model_input_tokens: 0,
          total_preflight_input_tokens: 0,
          observed_fixed_input_tokens: null,
        },
        prompt,
        captured,
        initial_files: [],
      };
    } else {
      taskEvents.push(captured.event);
      replay = {
        session: {
          schema_version: "contextadapt.codex-adaptive-session.v1",
          session_id: reference.thread_id_sha256,
          messages: history.messages.slice(0, messageIndex),
          events: priorCurrent ? priorEvents : [],
          total_model_input_tokens: 0,
          total_preflight_input_tokens: 0,
          observed_fixed_input_tokens: null,
        },
        prompt,
        captured,
        initial_files: [],
      };
    }
    previous = captured.event;
    activePromptMessageIndex = messageIndex;
  }
  const currentTask = currentCodexTask(taskEvents);
  const currentTarget = currentTask
    ? String(currentTask.facts.target_file)
    : null;
  const replayableSnapshot =
    currentTarget !== null &&
    snapshot.some((entry) => entry.target === currentTarget);
  if (replay) {
    if (replayableSnapshot) replay.initial_files = snapshot;
    else replay = null;
  }
  const decisionMessages =
    activePromptMessageIndex === null
      ? history.messages
      : history.messages.slice(0, activePromptMessageIndex + 1);
  const decisionItems = history.items.slice(0, decisionMessages.length);
  const decisionCanonical = JSON.stringify(decisionMessages);
  let recommendation: ContextRecommendationResult | null = null;
  let guard: ExecutorGuard | null = null;
  let observation: TraceEvent | null = null;
  let selectedMessages: CodexAdaptiveMessage[] = [];
  if (currentTask) {
    const events = [...taskEvents];
    events.push(policyFor(currentTask, nextSequence(events)));
    observation = await currentObservation(
      cwd,
      currentTask,
      nextSequence(events),
    );
    events.push(observation);
    const observationMessage: CodexAdaptiveMessage = {
      role: "host",
      text: observation.text,
    };
    const prepared = prepareAdaptiveContext(
      events,
      [
        ...decisionItems,
        {
          id: "contextadapt-current-observation",
          role: "custom",
          text: observation.text,
          token_count: countTokens(observation.text),
          value: observationMessage,
        },
      ],
      {
        trace_id: reference.thread_id_sha256,
        fixed_input_tokens: options.fixed_input_tokens ?? 90_000,
        available_context_tokens: options.model_context_window ?? 950_000,
      },
    );
    const selectedAssessment = prepared.recommendation.recommended_tier
      ? (prepared.recommendation.tier_assessments.find(
          (tier) => tier.tier === prepared.recommendation.recommended_tier,
        ) ?? null)
      : null;
    const expectedTotal = selectedAssessment
      ? preflightTokens +
        prepared.recommendation.attempted_input_tokens +
        selectedAssessment.estimated_input_tokens
      : preflightTokens + prepared.recommendation.attempted_input_tokens;
    const savings = selectedAssessment
      ? prepared.recommendation.always_largest_input_tokens - expectedTotal
      : null;
    recommendation = {
      ...prepared.recommendation,
      preflight_input_tokens: preflightTokens,
      expected_total_input_tokens: expectedTotal,
      estimated_savings_tokens: savings,
      estimated_savings_percent:
        savings === null ||
        prepared.recommendation.always_largest_input_tokens === 0
          ? null
          : Math.round(
              (savings / prepared.recommendation.always_largest_input_tokens) *
                10_000,
            ) / 100,
    };
    const selectedTier = recommendation.recommended_tier;
    selectedMessages = selectedTier
      ? prepared.windows[selectedTier].items.map((item) => item.value)
      : [];
    if (selectedTier && observation.success === true) {
      guard = compileRuntimeExecutorGuard(prepared.events);
      await saveSessionGuard(runtimeDirectory, reference.thread_id, guard);
    }
  }
  const selectedTier = recommendation?.recommended_tier ?? null;
  const report: CodexPassiveObservation = {
    schema_version: CODEX_PASSIVE_OBSERVATION_VERSION,
    captured_at: new Date().toISOString(),
    capture_mode: "post_run_read_only",
    cohort_bucket: skipSemanticAnalysis
      ? "NULL"
      : bucketFor(selectedTier, currentTask !== null),
    source: {
      adapter: "codex_app_server_thread_read",
      thread_id_sha256: reference.thread_id_sha256,
      session_id_sha256:
        typeof thread.sessionId === "string" ? sha(thread.sessionId) : null,
      cwd_sha256: sha(String(thread.cwd ?? cwd)),
      model_provider:
        typeof thread.modelProvider === "string" ? thread.modelProvider : null,
      turn_count: thread.turns.length,
      item_count: history.itemCount,
      decision_message_count: decisionMessages.length,
      post_task_messages_excluded:
        history.messages.length - decisionMessages.length,
      item_type_counts: history.itemTypeCounts,
      native_tool_outcomes: history.toolOutcomes,
      history_content_sha256: sha(decisionCanonical),
      history_chars: decisionMessages.reduce(
        (total, message) => total + message.text.length,
        0,
      ),
      history_tokens_estimated: decisionItems.reduce(
        (total, item) => total + item.token_count,
        0,
      ),
      token_measurement: "utf8_bytes_div_4_host_estimate",
    },
    task_capture: {
      user_prompts_reviewed: history.userPrompts.length,
      actionable_updates: actionableUpdates,
      semantic_calls: attestations.length,
      semantic_preflight_input_tokens: preflightTokens,
      current_target_sha256: currentTask
        ? sha(String(currentTask.facts.target_file))
        : null,
      run_attestations: attestations,
    },
    decision: {
      recommendation: recommendation?.recommendation ?? "NULL",
      null_reason: recommendation
        ? null
        : skipSemanticAnalysis
          ? "full_history_fits_200k_without_selection"
          : "no_actionable_task",
      selected_tier: selectedTier,
      expected_total_input_tokens:
        recommendation?.expected_total_input_tokens ?? null,
      always_largest_input_tokens:
        recommendation?.always_largest_input_tokens ?? null,
      estimated_savings_tokens:
        recommendation?.estimated_savings_tokens ?? null,
      estimated_savings_percent:
        recommendation?.estimated_savings_percent ?? null,
      tier_safe: recommendation
        ? (Object.fromEntries(
            recommendation.tier_assessments.map((tier) => [
              tier.tier,
              tier.safe,
            ]),
          ) as Record<ContextTier, boolean>)
        : null,
      unresolved_counts: recommendation
        ? (Object.fromEntries(
            recommendation.tier_assessments.map((tier) => [
              tier.tier,
              tier.unresolved_contradictions.length +
                tier.missing_evidence.length +
                tier.unauthorized_evidence.length,
            ]),
          ) as Record<ContextTier, number>)
        : null,
    },
    execution_gate: {
      status:
        currentTask === null ? "NOT_APPLICABLE" : guard ? "READY" : "BLOCKED",
      session_guard_written: guard !== null,
      guard_id_sha256: guard ? sha(guard.guard_id) : null,
      current_observation_success: observation?.success ?? null,
    },
    hook_attestation: {
      recording_observed: hookAttestation.recording_observed,
      user_prompt_events: hookAttestation.user_prompt_events,
      observed_pre_tool_calls: hookAttestation.observed_pre_tool_calls,
      post_tool_result_events: hookAttestation.post_tool_result_events,
      execution_result_events: hookAttestation.execution_result_events,
      unknown_tool_outcomes: hookAttestation.unknown_tool_outcomes,
      pre_tool_gate_events: 0,
      primary_hook_mode: "observe_only",
      snapshot_target_count: snapshot.length,
      replayable_snapshot: replayableSnapshot,
    },
    provider_usage: {
      actual_input_tokens: null,
      note: "thread/read is local/read-only; actual provider usage is recorded only by an optional native probe or replay",
    },
    privacy: {
      raw_thread_id_in_report: false,
      raw_prompts_in_report: false,
      raw_paths_in_report: false,
      private_reference_local_only: true,
    },
  };
  return {
    report,
    recommendation,
    guard,
    selected_messages: selectedMessages,
    replay,
  };
}

export function codexMessagesToResponseItems(
  messages: CodexAdaptiveMessage[],
): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    type: "message",
    role:
      message.role === "assistant"
        ? "assistant"
        : message.role === "user"
          ? "user"
          : "user",
    content: [
      {
        type: message.role === "assistant" ? "output_text" : "input_text",
        text:
          message.role === "tool" || message.role === "host"
            ? `[${message.role} observation]\n${message.text}`
            : message.text,
      },
    ],
  }));
}
