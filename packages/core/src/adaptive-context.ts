import { createHash } from "node:crypto";
import {
  CONTEXT_TIERS,
  type ContextRecommendationResult,
  type ContextTier,
} from "./recommend.js";
import { recommendFromTrace } from "./evidence-map.js";
import type { TraceEvent } from "./types.js";

export type HostContextRole =
  "system" | "user" | "assistant" | "tool" | "custom";

export interface HostContextItem<T = unknown> {
  /** Stable only for this assembly; it is never sent to the model. */
  id: string;
  role: HostContextRole;
  /** Exact model-visible text used to bind trace evidence to this item. */
  text: string;
  /** Host or host-tokenizer estimate for this complete item. */
  token_count: number;
  /** Original host message returned after selection. */
  value: T;
}

export interface AdaptiveContextOptions {
  trace_id?: string;
  /** System prompt, tool schemas, and other input that remains outside message slicing. */
  fixed_input_tokens?: number;
  /** Real maximum input supported by the active model after output reserve. */
  available_context_tokens: number;
  /** Advertised/raw model window before the output reserve is removed. */
  active_context_window_tokens?: number;
  /** Override only when a provider's marketed tier has a measured lower usable limit. */
  tier_limits?: Partial<Record<ContextTier, number>>;
}

export interface ContextWindow<T = unknown> {
  tier: ContextTier;
  supported: boolean;
  input_tokens: number;
  start_token: number;
  items: HostContextItem<T>[];
}

export interface PreparedAdaptiveContext<T = unknown> {
  trace_id: string;
  events: TraceEvent[];
  recommendation: ContextRecommendationResult;
  windows: Record<ContextTier, ContextWindow<T>>;
  selected_items: HostContextItem<T>[];
}

const DEFAULT_LIMITS: Record<ContextTier, number> = {
  "200K": 200_000,
  "400K": 400_000,
  // Luna's measured 1M-window input ceiling is lower than the marketing label.
  "1M_WINDOW": 883_300,
};

function nonNegativeInteger(value: unknown, where: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${where} must be a non-negative integer`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, where: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${where} must be a positive integer`);
  }
  return Number(value);
}

function limitsFor(
  overrides: AdaptiveContextOptions["tier_limits"],
): Record<ContextTier, number> {
  const limits = Object.fromEntries(
    CONTEXT_TIERS.map((tier) => [
      tier,
      positiveInteger(
        overrides?.[tier] ?? DEFAULT_LIMITS[tier],
        `tier_limits.${tier}`,
      ),
    ]),
  ) as Record<ContextTier, number>;
  if (
    limits["200K"] >= limits["400K"] ||
    limits["400K"] >= limits["1M_WINDOW"]
  ) {
    throw new Error("tier limits must increase from 200K to 400K to 1M_WINDOW");
  }
  return limits;
}

function suffixWindow<T>(
  items: HostContextItem<T>[],
  fixedTokens: number,
  limit: number,
  supported: boolean,
): ContextWindow<T> {
  const messageBudget = Math.max(0, limit - fixedTokens);
  let used = 0;
  let start = items.length;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const tokens = items[index]!.token_count;
    if (used + tokens > messageBudget) break;
    used += tokens;
    start = index;
  }

  // Each HostContextItem is an atomic host unit. OMP groups assistant tool-use
  // and tool-result messages before calling this function, so a boundary never
  // splits the provider's required pair.
  const selected = items.slice(start);
  const selectedTokens = selected.reduce(
    (sum, item) => sum + item.token_count,
    0,
  );
  const removedTokens = items
    .slice(0, start)
    .reduce((sum, item) => sum + item.token_count, 0);
  return {
    tier: "200K",
    supported,
    input_tokens: fixedTokens + selectedTokens,
    start_token: fixedTokens + removedTokens,
    items: selected,
  };
}

function bindEventSpans<T>(
  events: TraceEvent[],
  items: HostContextItem<T>[],
  fixedTokens: number,
): TraceEvent[] {
  const spans = new Map<string, { start_token: number; end_token: number }>();
  let cursor = fixedTokens;
  for (const item of items) {
    spans.set(item.id, {
      start_token: cursor,
      end_token: cursor + item.token_count,
    });
    cursor += item.token_count;
  }
  return events.map((event) => {
    const copy = structuredClone(event);
    if (copy.facts.always_visible === true) {
      delete copy.context_span;
      return copy;
    }
    const exact = items.filter((item) => item.text === copy.text);
    const containing =
      exact.length > 0
        ? exact
        : items.filter((item) => item.text.includes(copy.text));
    const match = containing.at(-1);
    if (!match) {
      delete copy.context_span;
      return copy;
    }
    // Exact host-message spans are deliberately conservative. We never claim
    // that half of a tool result remains usable when its containing message was
    // removed at an atomic boundary.
    copy.context_span = spans.get(match.id);
    return copy;
  });
}

function profileId(traceId: string, total: number): string {
  return `context-profile:${createHash("sha256")
    .update(`${traceId}:${total}`)
    .digest("hex")
    .slice(0, 16)}`;
}

export function prepareAdaptiveContext<T>(
  inputEvents: TraceEvent[],
  inputItems: HostContextItem<T>[],
  options: AdaptiveContextOptions,
): PreparedAdaptiveContext<T> {
  const traceId = options.trace_id ?? "live";
  const fixedTokens = nonNegativeInteger(
    options.fixed_input_tokens ?? 0,
    "fixed_input_tokens",
  );
  const available = positiveInteger(
    options.available_context_tokens,
    "available_context_tokens",
  );
  const activeWindow = positiveInteger(
    options.active_context_window_tokens ?? available,
    "active_context_window_tokens",
  );
  if (available > activeWindow) {
    throw new Error(
      "available_context_tokens must not exceed active_context_window_tokens",
    );
  }
  const limits = limitsFor(options.tier_limits);
  const items = inputItems.map((item, index) => ({
    ...item,
    token_count: nonNegativeInteger(
      item.token_count,
      `items[${index}].token_count`,
    ),
  }));
  const total =
    fixedTokens + items.reduce((sum, item) => sum + item.token_count, 0);
  if (total <= 0)
    throw new Error("assembled context must contain at least one token");

  const windows = Object.fromEntries(
    CONTEXT_TIERS.map((tier) => {
      const supported = activeWindow >= limits[tier];
      const effectiveLimit = Math.min(total, limits[tier], available);
      const window = suffixWindow(
        items,
        fixedTokens,
        effectiveLimit,
        supported,
      );
      return [tier, { ...window, tier }];
    }),
  ) as Record<ContextTier, ContextWindow<T>>;

  const measured = bindEventSpans(inputEvents, items, fixedTokens);
  const profile: TraceEvent = {
    event_id: profileId(traceId, total),
    source: "host",
    kind: "note",
    entity: "context:profile",
    sequence: Math.max(0, ...measured.map((event) => event.sequence ?? 0)) + 1,
    observed_at: new Date().toISOString(),
    success: true,
    facts: {
      total_input_tokens: total,
      window_policy: "suffix_window_v1",
      token_measurement: "host_item_estimate",
      trusted_observation_sources: ["read_file", "write_file"],
      tier_limits: limits,
      tier_supported: Object.fromEntries(
        CONTEXT_TIERS.map((tier) => [tier, windows[tier].supported]),
      ),
      tier_input_tokens: Object.fromEntries(
        CONTEXT_TIERS.map((tier) => [tier, windows[tier].input_tokens]),
      ),
      tier_window_starts: Object.fromEntries(
        CONTEXT_TIERS.map((tier) => [tier, windows[tier].start_token]),
      ),
    },
    links: {},
    text: "Host-measured adaptive context profile.",
  };
  const events = [...measured, profile];
  const recommendation = recommendFromTrace(events, traceId);
  const selectedItems = recommendation.recommended_tier
    ? windows[recommendation.recommended_tier].items
    : [];
  return {
    trace_id: traceId,
    events,
    recommendation,
    windows,
    selected_items: selectedItems,
  };
}
