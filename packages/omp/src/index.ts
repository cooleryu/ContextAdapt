import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  classifyExecutorRecovery,
  compileRuntimeExecutorGuard,
  evaluateExecutorCall,
  loadExecutorGuard,
  prepareAdaptiveContext,
  renderCompactRecommendation,
  type ExecutorGuard,
  type HostContextItem,
  type RecoveryClassification,
  type ToolTraceRecord,
  type TraceEvent,
} from "../../core/src/index.js";
import {
  DEFAULT_MODEL,
  runTwoPassCodexTaskCapture,
  type CapturedTask,
} from "../../codex/src/index.js";

export * from "./install.js";

export interface OmpToolCall {
  toolName: string;
  input: Record<string, unknown>;
  toolCallId?: string;
}

export interface OmpToolResult extends OmpToolCall {
  content?: unknown;
  isError: boolean;
}

export interface OmpBeforeAgentStart {
  prompt: string;
  systemPrompt?: string[];
}

export interface OmpContextEvent {
  messages: unknown[];
}

export interface OmpContext {
  cwd?: string;
  model?: { contextWindow?: number };
  getContextUsage?: () =>
    { tokens: number; contextWindow: number; percent: number } | undefined;
  abort?: () => void;
  sessionManager?: { getSessionId?(): string | undefined };
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
    setStatus?: (key: string, text: string | undefined) => void;
  };
}

type OmpHandler = (
  event: unknown,
  context: OmpContext,
) => unknown | Promise<unknown>;
export interface OmpApi {
  on(event: string, handler: OmpHandler): void;
}

export interface OmpAdaptiveDecision {
  recommendation: string;
  recommended_tier: string | null;
  decision_mode:
    | "FULL_HISTORY_FITS_200K"
    | "EVIDENCE_SELECTED"
    | "FULL_HISTORY_NO_ACTIONABLE_TASK";
  selected_message_count: number;
  total_input_tokens: number;
  semantic_preflight_input_tokens: number;
  estimated_savings_percent: number | null;
  active_context_window: number;
  context_window_source:
    | "OPTION_OVERRIDE"
    | "OMP_ACTIVE_MODEL"
    | "OMP_CONTEXT_USAGE"
    | "FAIL_CLOSED_200K_FALLBACK";
  guard_id: string | null;
  gate_status: "READY" | "DEFERRED_UNTIL_MUTATION" | "NOT_APPLICABLE";
  summary: string;
}

export const OMP_SHADOW_SNAPSHOT_VERSION =
  "contextadapt.omp-shadow-snapshot.v1" as const;

export interface OmpShadowSnapshot {
  schema_version: typeof OMP_SHADOW_SNAPSHOT_VERSION;
  source: "omp_native_context";
  session_id_sha256: string;
  captured_at: string;
  context_window: number;
  fixed_input_tokens: number;
  full_message_count: number;
  adaptive_message_count: number;
  largest_message_count: number;
  full_input_tokens: number;
  adaptive_input_tokens: number;
  largest_input_tokens: number;
  full_context_sha256: string;
  recommendation: OmpAdaptiveDecision;
  messages: unknown[];
  adaptive_messages: unknown[];
  largest_messages: unknown[];
}

export interface OmpRecoveryEvent {
  classification: RecoveryClassification;
  recovery_count: number;
  observation_event_id: string | null;
  observation_success: boolean;
}

export interface OmpExtensionOptions {
  captureTask?: (
    prompt: string,
    previous: TraceEvent | null,
    options: { sequence: number; session_id: string },
  ) => CapturedTask | Promise<CapturedTask>;
  countTokens?: (text: string) => number;
  initialEvents?: TraceEvent[];
  persist?: boolean;
  onDecision?: (decision: OmpAdaptiveDecision) => void;
  /** Observe the signed task capture without changing the host decision. */
  onTaskCapture?: (captured: CapturedTask) => void;
  onShadowSnapshot?: (snapshot: OmpShadowSnapshot) => void;
  onToolTrace?: (record: ToolTraceRecord) => void;
  onRecovery?: (event: OmpRecoveryEvent) => void;
  maximumRecoveries?: 0 | 1;
  /** Test/custom-host override when ExtensionContext does not expose the model. */
  modelContextWindow?: number;
  /** Initial system/tool overhead estimate; defaults to a 90K safety budget. */
  fixedInputTokens?: number;
  /** Keep only the native pre-tool guard for legacy/manual guard workflows. */
  guardOnly?: boolean;
  /** Skip semantic task capture while the complete native history fits 200K. */
  deferSemanticCaptureWhenFullHistoryFits200K?: boolean;
  /** Show the four-line decision in interactive OMP. */
  notify?: boolean;
  /** Low-cost model for two independent task reviews; defaults to Luna. */
  reviewModel?: string;
}

export function resolveOmpReviewModel(
  explicit?: string,
  environment = process.env.CONTEXTADAPT_REVIEW_MODEL,
): string {
  const model = (explicit ?? environment ?? DEFAULT_MODEL).trim();
  if (!model) throw new Error("OMP review model must not be empty");
  return model;
}

function sessionId(context: OmpContext, cwd: string): string {
  return (
    context.sessionManager?.getSessionId?.() ??
    `cwd:${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}`
  );
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(contentText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const item = value as Record<string, unknown>;
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string" || Array.isArray(item.content)) {
    return contentText(item.content);
  }
  return "";
}

function messageRole(value: unknown): HostContextItem["role"] {
  if (!value || typeof value !== "object") return "custom";
  const role = String((value as Record<string, unknown>).role ?? "custom");
  if (role === "user" || role === "assistant" || role === "system") return role;
  if (role === "toolResult" || role === "tool") return "tool";
  return "custom";
}

function defaultTokenCount(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

function tokenLabel(value: number): string {
  return value.toLocaleString("en-US");
}

export function renderOmpFullHistoryDecision(
  totalInputTokens: number,
  gateStatus: OmpAdaptiveDecision["gate_status"],
): string {
  const safety =
    gateStatus === "READY"
      ? "the real write is protected by the current execution gate."
      : gateStatus === "DEFERRED_UNTIL_MUTATION"
        ? "no task AI was added; the execution gate will be built before the first mutation."
        : "no mutation contract is active.";
  return [
    "ContextAdapt: use 200K.",
    "Why: the complete native history already fits; dropping context cannot improve this turn.",
    `Cost: about ${tokenLabel(totalInputTokens)} input tokens; no fabricated savings.`,
    `Safety: ${safety}`,
  ].join("\n");
}

/** Group a user turn and all of its assistant/tool messages as one atomic unit. */
export function ompContextItems(
  messages: unknown[],
  countTokens: (text: string) => number = defaultTokenCount,
): HostContextItem<unknown[]>[] {
  const groups: unknown[][] = [];
  for (const message of messages) {
    if (messageRole(message) === "user" || groups.length === 0) groups.push([]);
    groups.at(-1)!.push(message);
  }
  return groups.map((group, index) => {
    const text = group.map(contentText).filter(Boolean).join("\n");
    const serialized = JSON.stringify(group);
    return {
      id: `omp-turn-${index}`,
      role: messageRole(group[0]),
      text,
      token_count: Math.max(1, countTokens(serialized)),
      value: group,
    };
  });
}

function currentTask(events: TraceEvent[]): TraceEvent | null {
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

function isProtectedPath(path: string): boolean {
  return /(^|\/)(?:\.env(?:\.|$)|secrets?(?:\.|\/|$)|credentials?(?:\.|\/|$))/i.test(
    path,
  );
}

function policyFor(task: TraceEvent, sequence: number): TraceEvent {
  const target = String(task.facts.target_file);
  return {
    event_id: `policy:${createHash("sha256").update(target).digest("hex").slice(0, 20)}`,
    source: "policy",
    kind: "policy",
    entity: `resource:${target}`,
    sequence,
    observed_at: new Date().toISOString(),
    success: true,
    facts: {
      resource: target,
      protected: isProtectedPath(target),
      always_visible: true,
      classification_rule: "contextadapt_sensitive_path_v1",
    },
    links: {},
    text: `Host policy for ${target}.`,
  };
}

function safeTarget(cwd: string, target: string): string {
  const absolute = resolve(cwd, target);
  const back = relative(cwd, absolute);
  if (isAbsolute(back) || back.startsWith("..")) {
    throw new Error("task target is outside the OMP workspace");
  }
  return absolute;
}

async function preflightRead(
  cwd: string,
  task: TraceEvent,
  sequence: number,
): Promise<TraceEvent> {
  const target = String(task.facts.target_file);
  try {
    const content = await readFile(safeTarget(cwd, target), "utf8");
    if (Buffer.byteLength(content, "utf8") > 1_000_000) {
      throw new Error("target exceeds the 1 MB preflight read limit");
    }
    let facts: Record<string, unknown> = {
      target_file: target,
      bytes: Buffer.byteLength(content, "utf8"),
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        facts = { ...facts, ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // Non-JSON files still receive a verified byte/hash observation.
    }
    return {
      event_id: `preflight-read:${createHash("sha256")
        .update(`${target}:${facts.sha256}`)
        .digest("hex")
        .slice(0, 20)}`,
      source: "read_file",
      kind: "observation",
      entity: `file:${target}`,
      sequence,
      observed_at: new Date().toISOString(),
      success: true,
      facts,
      links: {},
      text: `ContextAdapt verified ${target} before the Agent call.\n${content}`,
    };
  } catch (error) {
    return {
      event_id: `preflight-read-failed:${createHash("sha256")
        .update(`${target}:${sequence}`)
        .digest("hex")
        .slice(0, 20)}`,
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

function nextSequence(events: TraceEvent[]): number {
  return Math.max(0, ...events.map((event) => event.sequence ?? 0)) + 1;
}

async function persistRuntime(
  cwd: string,
  id: string,
  events: TraceEvent[],
  decision?: unknown,
  guard?: ExecutorGuard,
  shadow?: OmpShadowSnapshot,
): Promise<void> {
  const directory = resolve(cwd, ".contextadapt/runtime");
  await mkdir(directory, { recursive: true });
  const stem = createHash("sha256").update(id).digest("hex").slice(0, 20);
  await writeFile(
    resolve(directory, `${stem}.trace.jsonl`),
    events.map((event) => `${JSON.stringify(event)}\n`).join(""),
  );
  if (decision !== undefined) {
    await writeFile(
      resolve(directory, `${stem}.decision.json`),
      `${JSON.stringify(decision, null, 2)}\n`,
    );
    await appendFile(
      resolve(directory, `${stem}.decisions.jsonl`),
      `${JSON.stringify(decision)}\n`,
    );
  }
  if (guard) {
    await writeFile(
      resolve(directory, `${stem}.guard.json`),
      `${JSON.stringify(guard, null, 2)}\n`,
    );
  }
  if (shadow) {
    await writeFile(
      resolve(directory, `${stem}.shadow.json`),
      `${JSON.stringify(shadow, null, 2)}\n`,
    );
  }
}

function actualToolObservation(
  event: OmpToolResult,
  sequence: number,
): TraceEvent | null {
  const path = event.input.path;
  if (
    typeof path !== "string" ||
    !["read", "write", "edit"].includes(event.toolName)
  ) {
    return null;
  }
  const text = contentText(event.content);
  return {
    event_id: `tool:${event.toolCallId ?? sequence}:${event.toolName}`,
    source: event.toolName === "read" ? "read_file" : "write_file",
    kind: "observation",
    entity: `file:${path}`,
    sequence,
    observed_at: new Date().toISOString(),
    success: !event.isError,
    facts: {
      target_file: path,
      tool_name: event.toolName,
      tool_call_id: event.toolCallId ?? null,
    },
    links: {},
    text:
      text ||
      `${event.toolName} ${event.isError ? "failed" : "succeeded"} for ${path}.`,
  };
}

export function createOmpExtension(options: OmpExtensionOptions = {}) {
  return function contextAdaptOmp(omp: OmpApi): void {
    let events = structuredClone(options.initialEvents ?? []);
    let guard: ExecutorGuard | null = null;
    let lastCwd = process.cwd();
    let lastSession = "omp";
    let recoveryCount = 0;
    let semanticPreflightInputTokens = 0;
    let lastDecisionSummary = "";
    const pendingPrompts: string[] = [];
    const blockedCallIds = new Set<string>();
    const reviewModel = resolveOmpReviewModel(options.reviewModel);
    const shouldPersist = options.persist ?? true;
    const maximumRecoveries = options.guardOnly
      ? 0
      : (options.maximumRecoveries ?? 1);
    const capture =
      options.captureTask ??
      ((
        prompt: string,
        previous: TraceEvent | null,
        captureOptions: { sequence: number; session_id: string },
      ) =>
        runTwoPassCodexTaskCapture(prompt, previous, {
          ...captureOptions,
          model: reviewModel,
        }));

    const notifyDecision = (
      decision: OmpAdaptiveDecision,
      context: OmpContext,
    ): void => {
      if ((options.notify ?? true) && context.hasUI !== false) {
        if (decision.summary !== lastDecisionSummary) {
          context.ui?.notify?.(
            decision.summary,
            decision.recommendation === "BLOCK_AND_REFRESH"
              ? "warning"
              : "info",
          );
          lastDecisionSummary = decision.summary;
        }
        context.ui?.setStatus?.(
          "contextadapt",
          `${decision.recommended_tier ?? "BLOCK"} · ${decision.gate_status}`,
        );
      }
    };

    const capturePendingTask = async (
      cwd: string,
      id: string,
    ): Promise<TraceEvent | null> => {
      if (pendingPrompts.length === 0) return null;
      const prompts = pendingPrompts.splice(0);
      for (const prompt of prompts) {
        const captured = await capture(prompt, currentTask(events), {
          sequence: nextSequence(events),
          session_id: id,
        });
        semanticPreflightInputTokens += captured.preflight_input_tokens;
        options.onTaskCapture?.(structuredClone(captured));
        if (captured.event) events.push(captured.event);
      }
      const task = currentTask(events);
      if (!task) {
        guard = null;
        return null;
      }
      const existingPolicy = events.find(
        (item) =>
          item.source === "policy" &&
          item.facts.resource === task.facts.target_file,
      );
      if (!existingPolicy) events.push(policyFor(task, nextSequence(events)));
      const observation = await preflightRead(cwd, task, nextSequence(events));
      events.push(observation);
      options.onToolTrace?.({
        call_id: `preflight:${observation.event_id}`,
        attempt: 0,
        phase: "retrieval",
        trigger: "preflight",
        tool_name: "read",
        resource: String(task.facts.target_file),
        call_fingerprint: createHash("sha256")
          .update(`read:${String(task.facts.target_file)}`)
          .digest("hex"),
        status: observation.success ? "completed" : "failed",
        input_tokens: defaultTokenCount(observation.text),
        latency_ms: 0,
      });
      guard = compileRuntimeExecutorGuard(events);
      if (shouldPersist) {
        await persistRuntime(cwd, id, events, undefined, guard);
      }
      return observation;
    };

    const registerToolGuard = (): void => {
      omp.on("tool_call", async (raw, context) => {
        const event = raw as OmpToolCall;
        if (
          !["write", "edit", "bash", "python", "notebook"].includes(
            event.toolName,
          )
        )
          return undefined;
        const cwd = context.cwd ?? process.cwd();
        try {
          if (!options.guardOnly && pendingPrompts.length > 0) {
            await capturePendingTask(cwd, lastSession);
            if (!guard) {
              return {
                block: true,
                reason:
                  "ContextAdapt blocked this mutation because two task reviewers could not establish a current actionable target.",
              };
            }
          }
          const activeGuard =
            guard ??
            (await loadExecutorGuard(
              process.env.CONTEXTADAPT_GUARD ??
                resolve(cwd, ".contextadapt/executor-guard.json"),
            ));
          const decision = evaluateExecutorCall(
            "omp",
            {
              tool_name: event.toolName,
              tool_input: event.input,
              cwd,
              session_id: context.sessionManager?.getSessionId?.(),
              tool_call_id: event.toolCallId,
            },
            activeGuard,
          );
          if (decision.decision !== "BLOCK") return undefined;
          const callId = event.toolCallId ?? `blocked:${Date.now()}`;
          blockedCallIds.add(callId);
          options.onToolTrace?.({
            call_id: callId,
            attempt: recoveryCount,
            phase: "execution",
            trigger: "agent",
            tool_name: event.toolName,
            resource:
              typeof event.input.path === "string" ? event.input.path : null,
            call_fingerprint: createHash("sha256")
              .update(JSON.stringify([event.toolName, event.input]))
              .digest("hex"),
            status: "blocked",
            input_tokens: 0,
            latency_ms: 0,
          });
          const classification = classifyExecutorRecovery(
            decision,
            activeGuard,
          );
          if (
            classification.disposition === "RECOVER_CURRENT_TARGET" &&
            recoveryCount < maximumRecoveries
          ) {
            const task = currentTask(events);
            if (!task) {
              return {
                block: true,
                reason:
                  "ContextAdapt blocked this tool call and could not bind recovery to a current task.",
              };
            }
            const started = Date.now();
            const observation = await preflightRead(
              cwd,
              task,
              nextSequence(events),
            );
            observation.facts.recovery_trigger = "stale_action_basis";
            observation.facts.recovery_fields = classification.refresh_fields;
            recoveryCount += 1;
            observation.facts.recovery_count = recoveryCount;
            events.push(observation);
            options.onToolTrace?.({
              call_id: `recovery:${observation.event_id}:${recoveryCount}`,
              attempt: recoveryCount,
              phase: "retrieval",
              trigger: "contextadapt_recovery",
              tool_name: "read",
              resource: classification.target,
              call_fingerprint: createHash("sha256")
                .update(`read:${classification.target}`)
                .digest("hex"),
              status: observation.success ? "completed" : "failed",
              input_tokens: defaultTokenCount(observation.text),
              latency_ms: Date.now() - started,
            });
            options.onRecovery?.({
              classification,
              recovery_count: recoveryCount,
              observation_event_id: observation.event_id,
              observation_success: observation.success === true,
            });
            if (shouldPersist) {
              await persistRuntime(
                cwd,
                lastSession,
                events,
                undefined,
                activeGuard,
              );
            }
            const refreshed = observation.success
              ? ` ContextAdapt performed its one read-only recovery. Re-anchor on this verified current state and retry once:\n${observation.text.slice(0, 16_000)}`
              : " ContextAdapt's one read-only recovery failed; do not retry the mutation.";
            return {
              block: true,
              reason: `ContextAdapt blocked this tool call: ${decision.reasons.join("; ")}.${refreshed}`,
            };
          }
          const suffix =
            classification.disposition === "RECOVER_CURRENT_TARGET" &&
            recoveryCount >= maximumRecoveries
              ? " Recovery budget exhausted; stop without mutation."
              : " This block is terminal and cannot expand target or authority.";
          return {
            block: true,
            reason: `ContextAdapt blocked this tool call: ${decision.reasons.join("; ")}.${suffix}`,
          };
        } catch (error) {
          return {
            block: true,
            reason: `ContextAdapt guard failed closed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      });
    };

    registerToolGuard();
    if (options.guardOnly) return;

    omp.on("before_agent_start", async (raw, context) => {
      const event = raw as OmpBeforeAgentStart;
      const cwd = context.cwd ?? process.cwd();
      const id = sessionId(context, cwd);
      lastCwd = cwd;
      lastSession = id;
      recoveryCount = 0;
      lastDecisionSummary = "";
      blockedCallIds.clear();
      guard = null;
      pendingPrompts.push(event.prompt);
      // OMP does not expose context usage on every first turn. The `context`
      // event is still guaranteed to run immediately before the provider call
      // and carries the complete native message list, so it is the authoritative
      // place to decide whether the full history fits or task capture is needed.
      // Capturing here when usage is undefined would charge two semantic model
      // calls for the common short-task path before we have measured anything.
      if (options.deferSemanticCaptureWhenFullHistoryFits200K ?? true) {
        return undefined;
      }
      const observation = await capturePendingTask(cwd, id);
      if (!observation) return undefined;
      return {
        message: {
          customType: "contextadapt-preflight",
          content: observation.text,
          display: false,
          attribution: "agent",
          details: {
            success: observation.success,
            event_id: observation.event_id,
          },
        },
      };
    });

    omp.on("context", async (raw, context) => {
      const event = raw as OmpContextEvent;
      const usage = context.getContextUsage?.();
      let contextMessages = event.messages;
      let items = ompContextItems(contextMessages, options.countTokens);
      let estimatedMessages = items.reduce(
        (sum, item) => sum + item.token_count,
        0,
      );
      const fixedTokens =
        options.fixedInputTokens ??
        Math.max(
          90_000,
          Math.ceil(
            ((usage?.tokens ?? estimatedMessages) - estimatedMessages) * 1.1,
          ),
        );
      const reportedWindow =
        options.modelContextWindow ??
        context.model?.contextWindow ??
        usage?.contextWindow;
      const contextWindow =
        Number.isInteger(reportedWindow) && Number(reportedWindow) > 0
          ? Number(reportedWindow)
          : 200_000;
      const contextWindowSource: OmpAdaptiveDecision["context_window_source"] =
        options.modelContextWindow !== undefined
          ? "OPTION_OVERRIDE"
          : context.model?.contextWindow !== undefined
            ? "OMP_ACTIVE_MODEL"
            : usage?.contextWindow !== undefined
              ? "OMP_CONTEXT_USAGE"
              : "FAIL_CLOSED_200K_FALLBACK";
      const reserve = Math.max(8_192, Math.floor(contextWindow * 0.05));
      const availableContextTokens = Math.max(1, contextWindow - reserve);
      const fullInputTokens = fixedTokens + estimatedMessages;
      if (
        pendingPrompts.length > 0 &&
        fullInputTokens <= 200_000 &&
        fullInputTokens <= availableContextTokens
      ) {
        const decision: OmpAdaptiveDecision = {
          recommendation: "USE_200K",
          recommended_tier: "200K",
          decision_mode: "FULL_HISTORY_FITS_200K",
          selected_message_count: event.messages.length,
          total_input_tokens: fullInputTokens,
          semantic_preflight_input_tokens: semanticPreflightInputTokens,
          estimated_savings_percent: 0,
          active_context_window: contextWindow,
          context_window_source: contextWindowSource,
          guard_id: null,
          gate_status: "DEFERRED_UNTIL_MUTATION",
          summary: renderOmpFullHistoryDecision(
            fullInputTokens,
            "DEFERRED_UNTIL_MUTATION",
          ),
        };
        const shadow: OmpShadowSnapshot = {
          schema_version: OMP_SHADOW_SNAPSHOT_VERSION,
          source: "omp_native_context",
          session_id_sha256: createHash("sha256")
            .update(lastSession)
            .digest("hex"),
          captured_at: new Date().toISOString(),
          context_window: contextWindow,
          fixed_input_tokens: fixedTokens,
          full_message_count: event.messages.length,
          adaptive_message_count: event.messages.length,
          largest_message_count: event.messages.length,
          full_input_tokens: fullInputTokens,
          adaptive_input_tokens: fullInputTokens,
          largest_input_tokens: fullInputTokens,
          full_context_sha256: createHash("sha256")
            .update(JSON.stringify(event.messages))
            .digest("hex"),
          recommendation: decision,
          messages: structuredClone(event.messages),
          adaptive_messages: structuredClone(event.messages),
          largest_messages: structuredClone(event.messages),
        };
        options.onDecision?.(decision);
        options.onShadowSnapshot?.(shadow);
        notifyDecision(decision, context);
        if (shouldPersist) {
          await persistRuntime(
            lastCwd,
            lastSession,
            events,
            decision,
            undefined,
            shadow,
          );
        }
        return { messages: event.messages };
      }
      if (pendingPrompts.length > 0) {
        const observation = await capturePendingTask(lastCwd, lastSession);
        if (observation) {
          contextMessages = [
            ...contextMessages,
            {
              role: "custom",
              customType: "contextadapt-preflight",
              content: observation.text,
              display: false,
              attribution: "agent",
              details: {
                success: observation.success,
                event_id: observation.event_id,
              },
            },
          ];
          items = ompContextItems(contextMessages, options.countTokens);
          estimatedMessages = items.reduce(
            (sum, item) => sum + item.token_count,
            0,
          );
        }
      }
      if (!currentTask(events)) {
        const recommendedTier =
          fullInputTokens <= 200_000
            ? "200K"
            : fullInputTokens <= 400_000
              ? "400K"
              : "1M_WINDOW";
        const supported = fullInputTokens <= availableContextTokens;
        const decision: OmpAdaptiveDecision = {
          recommendation: supported
            ? `USE_${recommendedTier}`
            : "BLOCK_AND_REFRESH",
          recommended_tier: supported ? recommendedTier : null,
          decision_mode: "FULL_HISTORY_NO_ACTIONABLE_TASK",
          selected_message_count: supported ? event.messages.length : 0,
          total_input_tokens: fullInputTokens + semanticPreflightInputTokens,
          semantic_preflight_input_tokens: semanticPreflightInputTokens,
          estimated_savings_percent: 0,
          active_context_window: contextWindow,
          context_window_source: contextWindowSource,
          guard_id: null,
          gate_status: "NOT_APPLICABLE",
          summary: supported
            ? [
                `ContextAdapt: keep the complete history at ${recommendedTier}.`,
                "Why: two task reviewers found no supported mutation contract, so no evidence may be dropped.",
                `Cost: about ${tokenLabel(fullInputTokens + semanticPreflightInputTokens)} total input tokens; no fabricated savings.`,
                "Safety: any later mutation remains fail-closed until a current target is established.",
              ].join("\n")
            : [
                "ContextAdapt: stop and refresh context.",
                "Why: the complete history exceeds the active model and no safe mutation-specific working set was established.",
                `Cost: about ${tokenLabel(fullInputTokens + semanticPreflightInputTokens)} attempted input tokens.`,
                "Safety: no model or mutation call should continue from incomplete evidence.",
              ].join("\n"),
        };
        options.onDecision?.(decision);
        notifyDecision(decision, context);
        if (shouldPersist) {
          await persistRuntime(lastCwd, lastSession, events, decision);
        }
        if (!supported) {
          context.abort?.();
          return { messages: [] };
        }
        return { messages: contextMessages };
      }
      const prepared = prepareAdaptiveContext(
        events.filter((item) => item.entity !== "context:profile"),
        items,
        {
          trace_id: lastSession,
          fixed_input_tokens: fixedTokens,
          available_context_tokens: availableContextTokens,
          active_context_window_tokens: contextWindow,
        },
      );
      events = prepared.events;
      const decision: OmpAdaptiveDecision = {
        recommendation: prepared.recommendation.recommendation,
        recommended_tier: prepared.recommendation.recommended_tier,
        decision_mode: "EVIDENCE_SELECTED",
        selected_message_count: prepared.selected_items.reduce(
          (sum, item) => sum + item.value.length,
          0,
        ),
        total_input_tokens: prepared.recommendation.expected_total_input_tokens,
        semantic_preflight_input_tokens: semanticPreflightInputTokens,
        estimated_savings_percent:
          prepared.recommendation.estimated_savings_percent,
        active_context_window: contextWindow,
        context_window_source: contextWindowSource,
        guard_id: guard?.guard_id ?? null,
        gate_status: guard ? "READY" : "NOT_APPLICABLE",
        summary: renderCompactRecommendation(prepared.recommendation).trim(),
      };
      const adaptiveMessages = prepared.selected_items.flatMap(
        (item) => item.value,
      );
      const largestMessages = prepared.windows["1M_WINDOW"].items.flatMap(
        (item) => item.value,
      );
      const adaptiveInputTokens = prepared.recommendation.recommended_tier
        ? prepared.windows[prepared.recommendation.recommended_tier]
            .input_tokens
        : 0;
      const shadow: OmpShadowSnapshot = {
        schema_version: OMP_SHADOW_SNAPSHOT_VERSION,
        source: "omp_native_context",
        session_id_sha256: createHash("sha256")
          .update(lastSession)
          .digest("hex"),
        captured_at: new Date().toISOString(),
        context_window: contextWindow,
        fixed_input_tokens: fixedTokens,
        full_message_count: contextMessages.length,
        adaptive_message_count: adaptiveMessages.length,
        largest_message_count: largestMessages.length,
        full_input_tokens: fixedTokens + estimatedMessages,
        adaptive_input_tokens: adaptiveInputTokens,
        largest_input_tokens: prepared.windows["1M_WINDOW"].input_tokens,
        full_context_sha256: createHash("sha256")
          .update(JSON.stringify(contextMessages))
          .digest("hex"),
        recommendation: decision,
        // OMP can reuse and mutate the same message array for the follow-up
        // provider call after a tool result. A shadow artifact must freeze the
        // exact pre-call state, not retain a live reference to host memory.
        messages: structuredClone(contextMessages),
        adaptive_messages: structuredClone(adaptiveMessages),
        largest_messages: structuredClone(largestMessages),
      };
      options.onDecision?.(decision);
      options.onShadowSnapshot?.(shadow);
      notifyDecision(decision, context);
      if (shouldPersist)
        await persistRuntime(
          lastCwd,
          lastSession,
          events,
          decision,
          guard ?? undefined,
          shadow,
        );
      if (!prepared.recommendation.recommended_tier) {
        context.abort?.();
        return { messages: [] };
      }
      return {
        messages: adaptiveMessages,
      };
    });

    omp.on("tool_result", async (raw) => {
      const toolResult = raw as OmpToolResult;
      const observation = actualToolObservation(
        toolResult,
        nextSequence(events),
      );
      if (observation) events.push(observation);
      const callId = toolResult.toolCallId ?? `tool:${nextSequence(events)}`;
      const wasBlocked = blockedCallIds.delete(callId);
      const path =
        typeof toolResult.input.path === "string"
          ? toolResult.input.path
          : null;
      if (
        !wasBlocked &&
        ["read", "write", "edit"].includes(toolResult.toolName)
      ) {
        options.onToolTrace?.({
          call_id: callId,
          attempt: recoveryCount,
          phase: toolResult.toolName === "read" ? "retrieval" : "execution",
          trigger: "agent",
          tool_name: toolResult.toolName,
          resource: path,
          call_fingerprint: createHash("sha256")
            .update(JSON.stringify([toolResult.toolName, toolResult.input]))
            .digest("hex"),
          status: wasBlocked
            ? "blocked"
            : toolResult.isError
              ? "failed"
              : "completed",
          input_tokens:
            toolResult.toolName === "read"
              ? defaultTokenCount(contentText(toolResult.content))
              : 0,
          latency_ms: 0,
        });
      }
      if (shouldPersist)
        await persistRuntime(
          lastCwd,
          lastSession,
          events,
          undefined,
          guard ?? undefined,
        );
      return undefined;
    });
  };
}

/** OMP 17.x native recorder, context selector, and pre-tool guard. */
export default createOmpExtension();
