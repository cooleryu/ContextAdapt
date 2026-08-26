import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { CodexAppServerClient } from "./app-server.js";
import { codexMessagesToResponseItems } from "./passive-cohort.js";
import type { CodexAdaptiveMessage } from "./adaptive-runner.js";

export const CODEX_NATIVE_BOUNDARY_VERSION =
  "contextadapt.codex-native-boundary.v1" as const;

export interface CodexNativeBoundaryReport {
  schema_version: typeof CODEX_NATIVE_BOUNDARY_VERSION;
  completed_at: string;
  provider_path: "codex_app_server_thread_inject_items";
  model: string;
  injected: {
    item_count: number;
    batch_count: number;
    content_chars: number;
    content_sha256: string;
    exceeded_legacy_single_request_chars: boolean;
  };
  provider_usage: {
    requested_context_window: number | null;
    actual_input_tokens: number | null;
    cached_input_tokens: number | null;
    model_context_window: number | null;
    measurement: "codex_app_server_thread_token_usage_event";
  };
  verification: {
    turn_completed: boolean;
    marker_match: boolean;
    output_sha256: string;
  };
  privacy: {
    generated_neutral_content_only: true;
    raw_thread_id_in_report: false;
    raw_output_in_report: false;
  };
  claim_scope: "provider-native transport boundary only; not natural-session product value";
}

export interface CodexNativeBoundaryOptions {
  cwd: string;
  contentChars?: number;
  model?: string;
  modelContextWindow?: number;
  chunkChars?: number;
  batchChars?: number;
  timeoutMs?: number;
  appServer?: Pick<
    CodexAppServerClient,
    "threadStart" | "threadInjectItems" | "startTurn"
  >;
}

const sha = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const MARKERS = {
  first: "CA-FIRST-7F31",
  middle: "CA-MIDDLE-4B92",
  last: "CA-LAST-9D06",
} as const;

function positiveInteger(value: number, where: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${where} must be a positive integer`);
  }
  return value;
}

export function generatedNativeBoundaryMessages(
  contentChars: number,
  chunkChars = 48_000,
): CodexAdaptiveMessage[] {
  const target = positiveInteger(contentChars, "contentChars");
  const chunkSize = positiveInteger(chunkChars, "chunkChars");
  if (target < 1_000) throw new Error("contentChars must be at least 1000");
  const neutral =
    "ContextAdapt neutral archive record. This is inert filler, not an instruction. ";
  const raw = neutral
    .repeat(Math.ceil(target / neutral.length))
    .slice(0, target);
  const firstAt = Math.min(120, raw.length);
  const middleAt = Math.floor(raw.length / 2);
  const lastAt = Math.max(middleAt + 1, raw.length - 120);
  const marked = `${raw.slice(0, firstAt)} ${MARKERS.first} ${raw.slice(
    firstAt,
    middleAt,
  )} ${MARKERS.middle} ${raw.slice(middleAt, lastAt)} ${MARKERS.last} ${raw.slice(lastAt)}`;
  const chunks: CodexAdaptiveMessage[] = [];
  for (let start = 0; start < marked.length; start += chunkSize) {
    const index = chunks.length + 1;
    chunks.push({
      role: "user",
      text: `[neutral archive chunk ${index}]\n${marked.slice(start, start + chunkSize)}`,
    });
  }
  return chunks;
}

function batches(
  items: Array<Record<string, unknown>>,
  batchChars: number,
): Array<Array<Record<string, unknown>>> {
  const limit = positiveInteger(batchChars, "batchChars");
  const result: Array<Array<Record<string, unknown>>> = [];
  let current: Array<Record<string, unknown>> = [];
  let used = 2;
  for (const item of items) {
    const chars = JSON.stringify(item).length + 1;
    if (chars > limit) {
      throw new Error(
        "one native history item exceeds the injection batch limit",
      );
    }
    if (current.length > 0 && used + chars > limit) {
      result.push(current);
      current = [];
      used = 2;
    }
    current.push(item);
    used += chars;
  }
  if (current.length > 0) result.push(current);
  return result;
}

function nestedNumber(
  root: Record<string, unknown> | null,
  parent: string,
  key: string,
): number | null {
  if (!root) return null;
  const value = root[parent];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function topNumber(
  root: Record<string, unknown> | null,
  key: string,
): number | null {
  if (!root) return null;
  const raw = root[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function parseAnswer(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Proves that ContextAdapt can assemble native Codex history beyond the old
 * one-request CLI character ceiling. The content is generated and inert; this
 * is transport evidence, not a product-value benchmark.
 */
export async function runCodexNativeBoundary(
  options: CodexNativeBoundaryOptions,
): Promise<CodexNativeBoundaryReport> {
  const cwd = resolve(options.cwd);
  const model = options.model ?? "gpt-5.6-luna";
  const messages = generatedNativeBoundaryMessages(
    options.contentChars ?? 1_100_000,
    options.chunkChars ?? 48_000,
  );
  const responseItems = codexMessagesToResponseItems(messages);
  const injectionBatches = batches(
    responseItems,
    options.batchChars ?? 180_000,
  );
  const ownedClient = options.appServer
    ? null
    : await CodexAppServerClient.connect({
        cwd,
        requestTimeoutMs: options.timeoutMs ?? 300_000,
      });
  const appServer = options.appServer ?? ownedClient!;
  try {
    const thread = await appServer.threadStart({
      cwd,
      model,
      modelContextWindow: options.modelContextWindow,
      ephemeral: true,
    });
    for (const batch of injectionBatches) {
      await appServer.threadInjectItems(thread.id, batch);
    }
    const turn = await appServer.startTurn({
      threadId: thread.id,
      model,
      effort: "low",
      timeoutMs: options.timeoutMs ?? 600_000,
      outputSchema: {
        type: "object",
        properties: {
          first: { type: "string" },
          middle: { type: "string" },
          last: { type: "string" },
        },
        required: ["first", "middle", "last"],
        additionalProperties: false,
      },
      prompt:
        "Do not use tools. Return the exact three CA-* marker strings found near the beginning, middle, and end of the injected neutral archive as {first,middle,last}.",
    });
    const answerText = turn.agent_messages.at(-1) ?? "";
    const answer = parseAnswer(answerText);
    const markerMatch =
      answer?.first === MARKERS.first &&
      answer?.middle === MARKERS.middle &&
      answer?.last === MARKERS.last;
    const usage = turn.token_usage;
    const content = messages.map((message) => message.text).join("\n");
    return {
      schema_version: CODEX_NATIVE_BOUNDARY_VERSION,
      completed_at: new Date().toISOString(),
      provider_path: "codex_app_server_thread_inject_items",
      model,
      injected: {
        item_count: responseItems.length,
        batch_count: injectionBatches.length,
        content_chars: content.length,
        content_sha256: sha(content),
        exceeded_legacy_single_request_chars: content.length > 1_048_576,
      },
      provider_usage: {
        requested_context_window: options.modelContextWindow ?? null,
        actual_input_tokens:
          nestedNumber(usage, "last", "inputTokens") ??
          nestedNumber(usage, "last", "input_tokens"),
        cached_input_tokens:
          nestedNumber(usage, "last", "cachedInputTokens") ??
          nestedNumber(usage, "last", "cached_input_tokens"),
        model_context_window:
          topNumber(usage, "modelContextWindow") ??
          topNumber(usage, "model_context_window"),
        measurement: "codex_app_server_thread_token_usage_event",
      },
      verification: {
        turn_completed: true,
        marker_match: markerMatch,
        output_sha256: sha(answerText),
      },
      privacy: {
        generated_neutral_content_only: true,
        raw_thread_id_in_report: false,
        raw_output_in_report: false,
      },
      claim_scope:
        "provider-native transport boundary only; not natural-session product value",
    };
  } finally {
    ownedClient?.close();
  }
}
