import { isRecord } from "./types.js";

export const RECOMMENDATION_INPUT_SCHEMA_VERSION =
  "contextadapt.recommendation-input.v1" as const;
export const RECOMMENDATION_SCHEMA_VERSION =
  "contextadapt.recommendation.v1" as const;

export const CONTEXT_TIERS = ["200K", "400K", "1M_WINDOW"] as const;
export type ContextTier = (typeof CONTEXT_TIERS)[number];

export const EVIDENCE_KINDS = [
  "target",
  "value",
  "permission",
  "correction",
  "observation",
  "dependency",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export type ContextRecommendation =
  "USE_200K" | "USE_400K" | "USE_1M_WINDOW" | "BLOCK_AND_REFRESH";

export interface EvidenceRequirement {
  evidence_id: string;
  kind: EvidenceKind;
  description: string;
}

export interface ContextTierInput {
  tier: ContextTier;
  estimated_input_tokens: number;
  available_evidence: string[];
  stale_evidence: string[];
  unauthorized_evidence: string[];
  unresolved_contradictions: string[];
}

export interface ContextRecommendationInput {
  schema_version: typeof RECOMMENDATION_INPUT_SCHEMA_VERSION;
  task_id: string;
  required_evidence: EvidenceRequirement[];
  tiers: ContextTierInput[];
  prior_attempt_input_tokens: number[];
  maximum_escalations: 0 | 1;
}

export interface ContextTierAssessment extends ContextTierInput {
  safe: boolean;
  missing_evidence: string[];
}

export interface ContextRecommendationResult {
  schema_version: typeof RECOMMENDATION_SCHEMA_VERSION;
  input_schema_version: typeof RECOMMENDATION_INPUT_SCHEMA_VERSION;
  task_id: string;
  recommendation: ContextRecommendation;
  recommended_tier: ContextTier | null;
  required_evidence: EvidenceRequirement[];
  tier_assessments: ContextTierAssessment[];
  attempted_input_tokens: number;
  expected_total_input_tokens: number;
  always_largest_input_tokens: number;
  estimated_savings_tokens: number | null;
  estimated_savings_percent: number | null;
  maximum_escalations: 0 | 1;
  gate_required: true;
  reasons: string[];
}

const tierSet = new Set<string>(CONTEXT_TIERS);
const evidenceKindSet = new Set<string>(EVIDENCE_KINDS);

function onlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
  where: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value)
    .filter((key) => !allowedSet.has(key))
    .sort();
  if (unknown.length > 0) {
    throw new Error(
      `${where} contains unsupported field(s): ${unknown.join(", ")}`,
    );
  }
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const item = value[key];
  if (typeof item !== "string" || item.trim() === "") {
    throw new Error(`${where}.${key} must be a non-empty string`);
  }
  return item;
}

function stringArray(
  value: unknown,
  where: string,
  allowed?: Set<string>,
): string[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  const result = value.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`${where}[${index}] must be a non-empty string`);
    }
    if (allowed && !allowed.has(item)) {
      throw new Error(`${where} contains unknown evidence_id: ${item}`);
    }
    return item;
  });
  if (new Set(result).size !== result.length) {
    throw new Error(`${where} contains duplicate values`);
  }
  return result;
}

function positiveInteger(value: unknown, where: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${where} must be a positive integer`);
  }
  return Number(value);
}

export function parseRecommendationInput(
  value: unknown,
): ContextRecommendationInput {
  if (!isRecord(value))
    throw new Error("recommendation input must be an object");
  onlyKeys(
    value,
    [
      "schema_version",
      "task_id",
      "required_evidence",
      "tiers",
      "prior_attempt_input_tokens",
      "maximum_escalations",
    ],
    "input",
  );
  if (value.schema_version !== RECOMMENDATION_INPUT_SCHEMA_VERSION) {
    throw new Error(
      `schema_version must be ${RECOMMENDATION_INPUT_SCHEMA_VERSION}`,
    );
  }
  const taskId = requiredString(value, "task_id", "input");

  if (
    !Array.isArray(value.required_evidence) ||
    value.required_evidence.length === 0
  ) {
    throw new Error("required_evidence must be a non-empty array");
  }
  const requiredEvidence = value.required_evidence.map((item, index) => {
    const where = `required_evidence[${index}]`;
    if (!isRecord(item)) throw new Error(`${where} must be an object`);
    onlyKeys(item, ["evidence_id", "kind", "description"], where);
    const evidenceId = requiredString(item, "evidence_id", where);
    const kind = requiredString(item, "kind", where);
    if (!evidenceKindSet.has(kind)) {
      throw new Error(
        `${where}.kind must be one of ${EVIDENCE_KINDS.join(", ")}`,
      );
    }
    return {
      evidence_id: evidenceId,
      kind: kind as EvidenceKind,
      description: requiredString(item, "description", where),
    };
  });
  const evidenceIds = requiredEvidence.map((item) => item.evidence_id);
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new Error("required_evidence contains duplicate evidence_id values");
  }
  const allowedEvidence = new Set(evidenceIds);

  if (!Array.isArray(value.tiers)) throw new Error("tiers must be an array");
  const tiers = value.tiers.map((item, index) => {
    const where = `tiers[${index}]`;
    if (!isRecord(item)) throw new Error(`${where} must be an object`);
    onlyKeys(
      item,
      [
        "tier",
        "estimated_input_tokens",
        "available_evidence",
        "stale_evidence",
        "unauthorized_evidence",
        "unresolved_contradictions",
      ],
      where,
    );
    const tier = requiredString(item, "tier", where);
    if (!tierSet.has(tier)) {
      throw new Error(
        `${where}.tier must be one of ${CONTEXT_TIERS.join(", ")}`,
      );
    }
    return {
      tier: tier as ContextTier,
      estimated_input_tokens: positiveInteger(
        item.estimated_input_tokens,
        `${where}.estimated_input_tokens`,
      ),
      available_evidence: stringArray(
        item.available_evidence,
        `${where}.available_evidence`,
        allowedEvidence,
      ),
      stale_evidence: stringArray(
        item.stale_evidence,
        `${where}.stale_evidence`,
        allowedEvidence,
      ),
      unauthorized_evidence: stringArray(
        item.unauthorized_evidence,
        `${where}.unauthorized_evidence`,
        allowedEvidence,
      ),
      unresolved_contradictions: stringArray(
        item.unresolved_contradictions,
        `${where}.unresolved_contradictions`,
      ),
    };
  });
  const receivedTiers = tiers.map((item) => item.tier);
  if (
    receivedTiers.length !== CONTEXT_TIERS.length ||
    new Set(receivedTiers).size !== CONTEXT_TIERS.length ||
    CONTEXT_TIERS.some((tier) => !receivedTiers.includes(tier))
  ) {
    throw new Error(
      `tiers must contain exactly one of each: ${CONTEXT_TIERS.join(", ")}`,
    );
  }
  const orderedTiers = CONTEXT_TIERS.map((tier) =>
    tiers.find((item) => item.tier === tier)!,
  );
  for (let index = 1; index < orderedTiers.length; index += 1) {
    if (
      orderedTiers[index]!.estimated_input_tokens <=
      orderedTiers[index - 1]!.estimated_input_tokens
    ) {
      throw new Error("estimated_input_tokens must increase with context tier");
    }
  }

  const priorAttempts =
    value.prior_attempt_input_tokens === undefined
      ? []
      : Array.isArray(value.prior_attempt_input_tokens)
        ? value.prior_attempt_input_tokens.map((item, index) =>
            positiveInteger(item, `prior_attempt_input_tokens[${index}]`),
          )
        : (() => {
            throw new Error("prior_attempt_input_tokens must be an array");
          })();
  const maximumEscalations = value.maximum_escalations ?? 1;
  if (maximumEscalations !== 0 && maximumEscalations !== 1) {
    throw new Error("maximum_escalations must be 0 or 1");
  }
  if (priorAttempts.length > maximumEscalations) {
    throw new Error("prior_attempt_input_tokens exceeds maximum_escalations");
  }

  return {
    schema_version: RECOMMENDATION_INPUT_SCHEMA_VERSION,
    task_id: taskId,
    required_evidence: requiredEvidence,
    tiers: orderedTiers,
    prior_attempt_input_tokens: priorAttempts,
    maximum_escalations: maximumEscalations,
  };
}

function recommendationFor(tier: ContextTier): ContextRecommendation {
  if (tier === "200K") return "USE_200K";
  if (tier === "400K") return "USE_400K";
  return "USE_1M_WINDOW";
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function tierFailureSummary(assessment: ContextTierAssessment): string {
  const parts: string[] = [];
  if (assessment.missing_evidence.length) {
    parts.push(`missing ${assessment.missing_evidence.join(", ")}`);
  }
  if (assessment.stale_evidence.length) {
    parts.push(`stale ${assessment.stale_evidence.join(", ")}`);
  }
  if (assessment.unauthorized_evidence.length) {
    parts.push(`unauthorized ${assessment.unauthorized_evidence.join(", ")}`);
  }
  if (assessment.unresolved_contradictions.length) {
    parts.push(
      `contradictions ${assessment.unresolved_contradictions.join("; ")}`,
    );
  }
  return parts.join("; ");
}

export function recommendContext(
  input: ContextRecommendationInput,
): ContextRecommendationResult {
  const requiredIds = input.required_evidence.map((item) => item.evidence_id);
  const tierAssessments = input.tiers.map((tier) => {
    const available = new Set(tier.available_evidence);
    const missingEvidence = requiredIds.filter((id) => !available.has(id));
    const safe =
      missingEvidence.length === 0 &&
      tier.stale_evidence.length === 0 &&
      tier.unauthorized_evidence.length === 0 &&
      tier.unresolved_contradictions.length === 0;
    return { ...tier, safe, missing_evidence: missingEvidence };
  });
  const selected = tierAssessments.find((tier) => tier.safe) ?? null;
  const attemptedInputTokens = input.prior_attempt_input_tokens.reduce(
    (total, item) => total + item,
    0,
  );
  const largest = tierAssessments.at(-1)!;
  const expectedTotal = selected
    ? attemptedInputTokens + selected.estimated_input_tokens
    : attemptedInputTokens;
  const savings = selected
    ? largest.estimated_input_tokens - expectedTotal
    : null;
  const reasons = selected
    ? [
        `${selected.tier} is the smallest tier with complete, current, authorized evidence.`,
        ...tierAssessments
          .filter(
            (tier) =>
              CONTEXT_TIERS.indexOf(tier.tier) <
              CONTEXT_TIERS.indexOf(selected.tier),
          )
          .map(
            (tier) => `${tier.tier} is unsafe: ${tierFailureSummary(tier)}.`,
          ),
      ]
    : [
        "No candidate tier has complete, current, authorized, contradiction-free evidence.",
        ...tierAssessments.map(
          (tier) => `${tier.tier} is unsafe: ${tierFailureSummary(tier)}.`,
        ),
      ];

  return {
    schema_version: RECOMMENDATION_SCHEMA_VERSION,
    input_schema_version: RECOMMENDATION_INPUT_SCHEMA_VERSION,
    task_id: input.task_id,
    recommendation: selected
      ? recommendationFor(selected.tier)
      : "BLOCK_AND_REFRESH",
    recommended_tier: selected?.tier ?? null,
    required_evidence: input.required_evidence,
    tier_assessments: tierAssessments,
    attempted_input_tokens: attemptedInputTokens,
    expected_total_input_tokens: expectedTotal,
    always_largest_input_tokens: largest.estimated_input_tokens,
    estimated_savings_tokens: savings,
    estimated_savings_percent:
      savings === null
        ? null
        : roundPercent((savings / largest.estimated_input_tokens) * 100),
    maximum_escalations: input.maximum_escalations,
    gate_required: true,
    reasons,
  };
}

function tokens(value: number): string {
  return value.toLocaleString("en-US");
}

export function renderRecommendation(
  result: ContextRecommendationResult,
): string {
  const lines = [
    `ContextAdapt recommend · ${result.recommendation}`,
    "=".repeat(42),
    `Task: ${result.task_id}`,
    "",
    `RECOMMENDATION       ${result.recommendation}`,
    `Smallest safe tier: ${result.recommended_tier ?? "none"}`,
    `Expected total input: ${tokens(result.expected_total_input_tokens)} tokens`,
    `Always-largest baseline: ${tokens(result.always_largest_input_tokens)} tokens`,
  ];
  if (result.estimated_savings_tokens !== null) {
    lines.push(
      `Estimated saving: ${tokens(result.estimated_savings_tokens)} tokens (${result.estimated_savings_percent}%)`,
    );
  } else {
    lines.push("Estimated saving: unavailable while action is blocked");
  }
  if (result.attempted_input_tokens > 0) {
    lines.push(
      `Prior attempts included: ${tokens(result.attempted_input_tokens)} tokens`,
    );
  }
  lines.push("", "TIER EVIDENCE");
  for (const tier of result.tier_assessments) {
    lines.push(
      `${tier.safe ? "✓" : "!"} ${tier.tier.padEnd(11)} ${tier.safe ? "safe" : tierFailureSummary(tier)}`,
    );
  }
  lines.push(
    "",
    "WHY",
    ...result.reasons.map((reason) => `- ${reason}`),
    "",
    "Execution gate: REQUIRED",
    "Boundary: recommendation requires host-authored evidence coverage; the action gate still validates the real mutation.",
    "",
  );
  return lines.join("\n");
}
