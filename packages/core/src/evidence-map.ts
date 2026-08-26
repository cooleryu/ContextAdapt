import { buildSnapshot } from "./diagnose.js";
import {
  CONTEXT_TIERS,
  RECOMMENDATION_INPUT_SCHEMA_VERSION,
  type ContextRecommendationInput,
  type ContextRecommendationResult,
  type ContextTier,
  type ContextTierInput,
  type EvidenceKind,
  type EvidenceRequirement,
  recommendContext,
} from "./recommend.js";
import { isRecord, type TraceEvent } from "./types.js";

export const EVIDENCE_MAP_SCHEMA_VERSION =
  "contextadapt.evidence-map.v1" as const;

export interface TraceEvidenceMap {
  schema_version: typeof EVIDENCE_MAP_SCHEMA_VERSION;
  trace_id: string;
  active_task_event_id: string;
  recommendation_input: ContextRecommendationInput;
}

interface ContextProfile {
  total_input_tokens: number;
  tier_input_tokens: Record<ContextTier, number>;
  tier_window_starts: Record<ContextTier, number>;
  tier_supported: Record<ContextTier, boolean>;
  trusted_observation_sources: Set<string>;
}

const DEFAULT_TIER_TOKENS: Record<ContextTier, number> = {
  "200K": 200000,
  "400K": 400000,
  "1M_WINDOW": 883300,
};

function positiveInteger(value: unknown, where: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${where} must be a positive integer`);
  }
  return Number(value);
}

function readProfile(events: TraceEvent[]): ContextProfile {
  const candidates = events
    .filter(
      (event) =>
        event.source === "host" &&
        event.kind === "note" &&
        event.entity === "context:profile",
    )
    .sort((left, right) => (left.sequence ?? -1) - (right.sequence ?? -1));
  const event = candidates.at(-1);
  if (!event) {
    throw new Error(
      "trusted host context profile is missing; capture token spans before choosing a tier",
    );
  }
  const total = positiveInteger(
    event.facts.total_input_tokens,
    `${event.event_id}.facts.total_input_tokens`,
  );
  if (event.facts.window_policy !== "suffix_window_v1") {
    throw new Error(
      `${event.event_id}.facts.window_policy must be suffix_window_v1`,
    );
  }
  const trustedSources = event.facts.trusted_observation_sources;
  if (!Array.isArray(trustedSources) || trustedSources.length === 0) {
    throw new Error(
      `${event.event_id}.facts.trusted_observation_sources must be a non-empty array`,
    );
  }
  const trustedObservationSources = new Set<string>();
  for (const [index, source] of trustedSources.entries()) {
    if (typeof source !== "string" || source.trim() === "") {
      throw new Error(
        `${event.event_id}.facts.trusted_observation_sources[${index}] must be a non-empty string`,
      );
    }
    if (
      ["user", "policy", "host", "planner", "planner-replay"].includes(source)
    ) {
      throw new Error(
        `${event.event_id}.facts.trusted_observation_sources cannot trust ${source}`,
      );
    }
    trustedObservationSources.add(source);
  }
  if (trustedObservationSources.size !== trustedSources.length) {
    throw new Error(
      `${event.event_id}.facts.trusted_observation_sources contains duplicates`,
    );
  }
  const rawTiers = event.facts.tier_input_tokens;
  if (!isRecord(rawTiers)) {
    throw new Error(
      `${event.event_id}.facts.tier_input_tokens must be an object`,
    );
  }
  const unknownTiers = Object.keys(rawTiers).filter(
    (key) => !CONTEXT_TIERS.includes(key as ContextTier),
  );
  if (unknownTiers.length > 0) {
    throw new Error(
      `${event.event_id}.facts.tier_input_tokens contains unsupported tier(s): ${unknownTiers.join(", ")}`,
    );
  }
  const tierInputTokens = Object.fromEntries(
    CONTEXT_TIERS.map((tier) => [
      tier,
      positiveInteger(
        rawTiers[tier],
        `${event.event_id}.facts.tier_input_tokens.${tier}`,
      ),
    ]),
  ) as Record<ContextTier, number>;
  if (
    tierInputTokens["200K"] > tierInputTokens["400K"] ||
    tierInputTokens["400K"] > tierInputTokens["1M_WINDOW"]
  ) {
    throw new Error(
      "host tier input tokens must not decrease with context tier",
    );
  }
  if (tierInputTokens["1M_WINDOW"] > total) {
    throw new Error("largest host tier cannot exceed total input tokens");
  }
  const rawStarts = event.facts.tier_window_starts;
  const tierWindowStarts = Object.fromEntries(
    CONTEXT_TIERS.map((tier) => {
      const fallback = total - tierInputTokens[tier];
      if (rawStarts === undefined) return [tier, fallback];
      if (!isRecord(rawStarts)) {
        throw new Error(
          `${event.event_id}.facts.tier_window_starts must be an object`,
        );
      }
      const start = rawStarts[tier];
      if (
        !Number.isInteger(start) ||
        Number(start) < 0 ||
        Number(start) > total
      ) {
        throw new Error(
          `${event.event_id}.facts.tier_window_starts.${tier} must be an in-range integer`,
        );
      }
      return [tier, Number(start)];
    }),
  ) as Record<ContextTier, number>;
  if (
    tierWindowStarts["200K"] < tierWindowStarts["400K"] ||
    tierWindowStarts["400K"] < tierWindowStarts["1M_WINDOW"]
  ) {
    throw new Error(
      "host tier window starts must not increase with context tier",
    );
  }
  const rawSupported = event.facts.tier_supported;
  const tierSupported = Object.fromEntries(
    CONTEXT_TIERS.map((tier) => {
      if (rawSupported === undefined) return [tier, true];
      if (!isRecord(rawSupported) || typeof rawSupported[tier] !== "boolean") {
        throw new Error(
          `${event.event_id}.facts.tier_supported.${tier} must be a boolean`,
        );
      }
      return [tier, rawSupported[tier]];
    }),
  ) as Record<ContextTier, boolean>;
  return {
    total_input_tokens: total,
    tier_input_tokens: tierInputTokens,
    tier_window_starts: tierWindowStarts,
    tier_supported: tierSupported,
    trusted_observation_sources: trustedObservationSources,
  };
}

function targetFile(event: TraceEvent): string | null {
  const value = event.facts.target_file;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function resourceMatches(event: TraceEvent, target: string): boolean {
  if (
    event.entity === `file:${target}` ||
    event.entity === `resource:${target}`
  ) {
    return true;
  }
  return ["resource", "path", "target_file"].some(
    (key) => event.facts[key] === target,
  );
}

function description(event: TraceEvent, fallback: string): string {
  const text = event.text.trim().replace(/\s+/g, " ").replace(/[.]$/, "");
  return text || fallback;
}

function requirement(
  event: TraceEvent,
  kind: EvidenceKind,
  fallback: string,
): EvidenceRequirement {
  return {
    evidence_id: event.event_id,
    kind,
    description: description(event, fallback),
  };
}

function taskEvidence(
  task: TraceEvent,
  byId: Map<string, TraceEvent>,
): Array<{ event: TraceEvent; requirement: EvidenceRequirement }> {
  const base = {
    event: task,
    requirement: requirement(
      task,
      task.links.replaces ? "correction" : "target",
      "latest task update",
    ),
  };
  const rawSources = task.facts.field_sources;
  if (rawSources === undefined) return [base];
  if (!isRecord(rawSources)) {
    throw new Error(`${task.event_id}.facts.field_sources must be an object`);
  }
  const requiredFields = [
    "target_file",
    "environment",
    "timeout",
    "edit_protected",
  ].filter((field) => Object.hasOwn(task.facts, field));
  const unknown = Object.keys(rawSources).filter(
    (field) => !requiredFields.includes(field),
  );
  if (unknown.length > 0) {
    throw new Error(
      `${task.event_id}.facts.field_sources contains unsupported field(s): ${unknown.join(", ")}`,
    );
  }
  const grouped = new Map<string, string[]>();
  for (const field of requiredFields) {
    const sourceId = rawSources[field];
    if (typeof sourceId !== "string" || sourceId.trim() === "") {
      throw new Error(
        `${task.event_id}.facts.field_sources.${field} must be a non-empty event ID`,
      );
    }
    const fields = grouped.get(sourceId) ?? [];
    fields.push(field);
    grouped.set(sourceId, fields);
  }
  const result = [base];
  for (const [sourceId, fields] of grouped) {
    if (sourceId === task.event_id) continue;
    const source = byId.get(sourceId);
    if (!source) {
      throw new Error(`field provenance event ${sourceId} does not exist`);
    }
    if (source.source !== "user" || source.entity !== task.entity) {
      throw new Error(
        `field provenance event ${sourceId} is not a user event for the active task`,
      );
    }
    if (
      source.sequence === null ||
      task.sequence === null ||
      source.sequence > task.sequence
    ) {
      throw new Error(
        `field provenance event ${sourceId} has invalid chronology`,
      );
    }
    const kind: EvidenceKind = fields.includes("edit_protected")
      ? "permission"
      : fields.includes("target_file")
        ? "target"
        : "value";
    result.push({
      event: source,
      requirement: requirement(
        source,
        kind,
        `source for current ${fields.join(", ")}`,
      ),
    });
  }
  return result;
}

function fullyVisible(
  event: TraceEvent,
  profile: ContextProfile,
  tier: ContextTier,
): boolean {
  if (
    event.facts.always_visible === true &&
    ["host", "policy"].includes(event.source)
  ) {
    return true;
  }
  const span = event.context_span;
  if (!span || span.end_token > profile.total_input_tokens) return false;
  const windowStart = profile.tier_window_starts[tier];
  return span.start_token >= windowStart;
}

function trustedEvidence(
  event: TraceEvent,
  kind: EvidenceKind,
  profile: ContextProfile,
): boolean {
  if (kind === "permission") return event.source === "policy";
  if (kind === "correction" || kind === "target") {
    return event.source === "user" || event.source === "policy";
  }
  if (kind === "observation") {
    return (
      event.success === true &&
      profile.trusted_observation_sources.has(event.source)
    );
  }
  return event.source !== "planner" && event.source !== "planner-replay";
}

export function buildTraceEvidenceMap(
  events: TraceEvent[],
  traceId = "trace",
): TraceEvidenceMap {
  const profile = readProfile(events);
  const snapshot = buildSnapshot(events, traceId);
  const activeTasks = snapshot.current_state.filter(
    (event) =>
      event.source === "user" &&
      (event.kind === "state" || event.kind === "instruction") &&
      targetFile(event) !== null,
  );
  if (activeTasks.length === 0) {
    throw new Error(
      "current user task with a structured target_file is missing",
    );
  }
  if (activeTasks.length > 1) {
    throw new Error(
      `multiple active tasks are ambiguous: ${activeTasks.map((event) => event.event_id).join(", ")}`,
    );
  }
  const task = activeTasks[0]!;
  const target = targetFile(task)!;
  const byId = new Map(events.map((event) => [event.event_id, event]));
  const replaced = task.links.replaces
    ? byId.get(task.links.replaces)
    : undefined;
  if (task.links.replaces) {
    if (!replaced) {
      throw new Error(
        `replacement evidence ${task.links.replaces} does not exist`,
      );
    }
    if (replaced.entity !== task.entity) {
      throw new Error(
        "replacement evidence must belong to the active task entity",
      );
    }
    if (
      task.sequence === null ||
      replaced.sequence === null ||
      task.sequence <= replaced.sequence
    ) {
      throw new Error(
        "replacement evidence requires explicit increasing sequence",
      );
    }
  }
  const policies = snapshot.current_state.filter(
    (event) =>
      event.kind === "policy" &&
      event.source === "policy" &&
      event.facts.resource === target,
  );
  if (policies.length !== 1) {
    throw new Error(
      policies.length === 0
        ? `current host resource policy is missing for ${target}`
        : `multiple current host resource policies are ambiguous for ${target}`,
    );
  }
  const observations = snapshot.last_successful_observations.filter((event) =>
    resourceMatches(event, target),
  );
  if (observations.length !== 1) {
    throw new Error(
      observations.length === 0
        ? `verified successful observation is missing for ${target}`
        : `multiple successful observations are ambiguous for ${target}`,
    );
  }
  const policy = policies[0]!;
  const observation = observations[0]!;
  const evidenceEvents: Array<{
    event: TraceEvent;
    requirement: EvidenceRequirement;
  }> = [
    ...taskEvidence(task, byId),
    {
      event: policy,
      requirement: requirement(
        policy,
        "permission",
        `current resource policy for ${target}`,
      ),
    },
    {
      event: observation,
      requirement: requirement(
        observation,
        "observation",
        `verified state of ${target}`,
      ),
    },
  ];
  const tiers: ContextTierInput[] = CONTEXT_TIERS.map((tier) => {
    const availableEvidence = evidenceEvents
      .filter(({ event }) => fullyVisible(event, profile, tier))
      .map(({ requirement: item }) => item.evidence_id);
    const staleEvidence =
      replaced &&
      !fullyVisible(task, profile, tier) &&
      fullyVisible(replaced, profile, tier)
        ? [task.event_id]
        : [];
    const unauthorizedEvidence = evidenceEvents
      .filter(
        ({ event, requirement: item }) =>
          fullyVisible(event, profile, tier) &&
          !trustedEvidence(event, item.kind, profile),
      )
      .map(({ requirement: item }) => item.evidence_id);
    const unresolvedContradictions = evidenceEvents
      .filter(({ event }) => !event.context_span)
      .filter(({ event }) => event.facts.always_visible !== true)
      .map(
        ({ event }) =>
          `trusted host context span is missing for ${event.event_id}`,
      );
    if (!profile.tier_supported[tier]) {
      unresolvedContradictions.push(
        `active model does not support ${tier} input`,
      );
    }
    return {
      tier,
      estimated_input_tokens: profile.tier_input_tokens[tier],
      available_evidence: availableEvidence,
      stale_evidence: staleEvidence,
      unauthorized_evidence: unauthorizedEvidence,
      unresolved_contradictions: unresolvedContradictions,
    };
  });

  return {
    schema_version: EVIDENCE_MAP_SCHEMA_VERSION,
    trace_id: traceId,
    active_task_event_id: task.event_id,
    recommendation_input: {
      schema_version: RECOMMENDATION_INPUT_SCHEMA_VERSION,
      task_id: `${traceId}:${task.event_id}`,
      required_evidence: evidenceEvents.map((item) => item.requirement),
      tiers,
      prior_attempt_input_tokens: [],
      preflight_input_tokens:
        typeof task.facts.semantic_preflight_input_tokens === "number" &&
        Number.isInteger(task.facts.semantic_preflight_input_tokens) &&
        task.facts.semantic_preflight_input_tokens >= 0
          ? task.facts.semantic_preflight_input_tokens
          : 0,
      maximum_escalations: 1,
    },
  };
}

function bestEffortTierTokens(
  events: TraceEvent[],
): Record<ContextTier, number> {
  try {
    return readProfile(events).tier_input_tokens;
  } catch {
    return DEFAULT_TIER_TOKENS;
  }
}

function blockedResult(
  events: TraceEvent[],
  traceId: string,
  reason: string,
): ContextRecommendationResult {
  const tierTokens = bestEffortTierTokens(events);
  const input: ContextRecommendationInput = {
    schema_version: RECOMMENDATION_INPUT_SCHEMA_VERSION,
    task_id: traceId,
    required_evidence: [
      {
        evidence_id: "trace-preflight",
        kind: "dependency",
        description: "trusted trace preflight",
      },
    ],
    tiers: CONTEXT_TIERS.map((tier) => ({
      tier,
      estimated_input_tokens: tierTokens[tier],
      available_evidence: [],
      stale_evidence: [],
      unauthorized_evidence: [],
      unresolved_contradictions: [reason],
    })),
    prior_attempt_input_tokens: [],
    preflight_input_tokens: 0,
    maximum_escalations: 0,
  };
  return { ...recommendContext(input), reasons: [reason] };
}

export function recommendFromTrace(
  events: TraceEvent[],
  traceId = "trace",
): ContextRecommendationResult {
  try {
    return recommendContext(
      buildTraceEvidenceMap(events, traceId).recommendation_input,
    );
  } catch (error) {
    return blockedResult(
      events,
      traceId,
      error instanceof Error ? error.message : String(error),
    );
  }
}
