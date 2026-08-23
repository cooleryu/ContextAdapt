import { canonicalDigest } from "./json.js";
import { validateActionContract } from "./action-gate.js";
import { isRecord, type Risk, type TraceEvent } from "./types.js";

export const PROPOSAL_SCHEMA_VERSION = "contextadapt.relation-proposal.v1";
export const REVIEW_SCHEMA_VERSION = "contextadapt.relation-review.v1";
export const AUTO_ACCEPT_CONFIDENCE = 0.85;

const allowedRelations = new Set([
  "supersedes",
  "partial_supersession",
  "narrows",
  "adds",
  "conflicts",
]);
const allowedOperations = new Set(["replace", "set", "deny", "allow", "unset"]);
const fieldRules: Record<
  string,
  { type: "string" | "integer" | "boolean"; operations: Set<string> }
> = {
  environment: { type: "string", operations: new Set(["replace", "set"]) },
  timeout: { type: "integer", operations: new Set(["replace", "set"]) },
  edit_protected: {
    type: "boolean",
    operations: new Set(["deny", "allow", "set"]),
  },
  target_file: { type: "string", operations: new Set(["replace", "set"]) },
};

function eventRank(event: TraceEvent): [number, string] {
  return [event.sequence ?? -1, event.observed_at ?? ""];
}

function ranksAfter(newer: TraceEvent, older: TraceEvent): boolean {
  const [newSequence, newObserved] = eventRank(newer);
  const [oldSequence, oldObserved] = eventRank(older);
  return (
    newSequence > oldSequence ||
    (newSequence === oldSequence && newObserved > oldObserved)
  );
}

function quoteIsGrounded(event: TraceEvent, quote: unknown): quote is string {
  return (
    typeof quote === "string" &&
    quote.trim().length > 0 &&
    event.text.includes(quote)
  );
}

function matchesRegisteredType(
  value: unknown,
  type: "string" | "integer" | "boolean",
): boolean {
  if (type === "integer")
    return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function stringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export interface RelationVerdict extends Record<string, unknown> {
  schema_version: "contextadapt.relation-verdict.v1";
  status: "ACCEPTED" | "REJECTED" | "NEEDS_CLARIFICATION";
  proposal_id: unknown;
  proposal_sha256: string;
  relation: unknown;
  older_event_id: unknown;
  newer_event_id: unknown;
  entity: unknown;
  accepted_changes: Array<Record<string, unknown>>;
  unresolved_fields: string[];
  engineering_checks: string[];
  errors: string[];
  semantic_boundary: string;
}

export function validateRelationBundle(
  events: TraceEvent[],
  proposal: Record<string, unknown>,
  review: Record<string, unknown>,
): RelationVerdict {
  const errors: string[] = [];
  const checks: string[] = [];
  const byId = new Map(events.map((event) => [event.event_id, event]));

  if (proposal.schema_version !== PROPOSAL_SCHEMA_VERSION)
    errors.push("unsupported proposal schema");
  else checks.push("proposal_schema");
  if (review.schema_version !== REVIEW_SCHEMA_VERSION)
    errors.push("unsupported review schema");
  else checks.push("review_schema");

  const proposalId = proposal.proposal_id;
  const analyzerRunId = proposal.analyzer_run_id;
  const reviewerRunId = review.reviewer_run_id;
  if (
    ![proposalId, analyzerRunId, reviewerRunId].every(
      (value) => typeof value === "string" && value.length > 0,
    )
  ) {
    errors.push("proposal, analyzer, and reviewer identifiers are required");
  } else if (analyzerRunId === reviewerRunId)
    errors.push("analyzer and reviewer must be independent runs");
  else checks.push("independent_runs");

  const older =
    typeof proposal.older_event_id === "string"
      ? byId.get(proposal.older_event_id)
      : undefined;
  const newer =
    typeof proposal.newer_event_id === "string"
      ? byId.get(proposal.newer_event_id)
      : undefined;
  if (!older || !newer)
    errors.push("proposal references an unknown older or newer event");
  else {
    checks.push("events_exist");
    if (!ranksAfter(newer, older))
      errors.push("newer event must rank after older event");
    else checks.push("chronology");
    const proposedEntity = proposal.entity;
    if (typeof proposedEntity !== "string" || !proposedEntity) {
      errors.push("proposal must bind both events to a non-empty entity");
    } else if (
      (older.entity && older.entity !== proposedEntity) ||
      (newer.entity && newer.entity !== proposedEntity)
    ) {
      errors.push(
        "proposed entity contradicts an existing structured event entity",
      );
    } else checks.push("entity_binding");
  }

  const relation = proposal.relation;
  if (typeof relation !== "string" || !allowedRelations.has(relation))
    errors.push("unsupported relation type");
  else checks.push("relation_type");

  const confidence = proposal.confidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    errors.push("proposal confidence must be between 0 and 1");
  } else if (confidence < AUTO_ACCEPT_CONFIDENCE)
    errors.push("proposal confidence is below the automatic-accept threshold");
  else checks.push("proposal_confidence");

  let changes: Array<Record<string, unknown>> = [];
  if (!Array.isArray(proposal.changes) || proposal.changes.length === 0) {
    errors.push("proposal must contain at least one field-level change");
  } else {
    changes = proposal.changes.filter(isRecord);
    if (changes.length !== proposal.changes.length)
      errors.push("change must be an object");
  }
  const fields: string[] = [];
  changes.forEach((change, index) => {
    const label = `change[${index}]`;
    const field = change.field;
    if (typeof field !== "string" || !field) {
      errors.push(`${label} requires a field`);
      return;
    }
    if (fields.includes(field))
      errors.push(`duplicate changed field: ${field}`);
    fields.push(field);
    const operation = change.operation;
    if (typeof operation !== "string" || !allowedOperations.has(operation)) {
      errors.push(`${label} uses an unsupported operation`);
    }
    const rule = fieldRules[field];
    if (!rule) errors.push(`${label} uses an unregistered field`);
    else {
      if (typeof operation !== "string" || !rule.operations.has(operation)) {
        errors.push(`${label} operation is not allowed for ${field}`);
      }
      if (
        !matchesRegisteredType(change.old_value, rule.type) ||
        !matchesRegisteredType(change.new_value, rule.type)
      ) {
        errors.push(
          `${label} values do not match the registered type for ${field}`,
        );
      }
    }

    const oldEvidence = change.old_evidence;
    const newEvidence = change.new_evidence;
    if (older) {
      if (!isRecord(oldEvidence) || oldEvidence.event_id !== older.event_id) {
        errors.push(`${label} old evidence must point to the older event`);
      } else if (!quoteIsGrounded(older, oldEvidence.quote)) {
        errors.push(
          `${label} old evidence quote is not present verbatim in the older event`,
        );
      }
    }
    if (newer) {
      if (!isRecord(newEvidence) || newEvidence.event_id !== newer.event_id) {
        errors.push(`${label} new evidence must point to the newer event`);
      } else if (!quoteIsGrounded(newer, newEvidence.quote)) {
        errors.push(
          `${label} new evidence quote is not present verbatim in the newer event`,
        );
      }
    }
    if (
      older &&
      field in older.facts &&
      change.old_value !== older.facts[field]
    ) {
      errors.push(
        `${label} old value contradicts the older event's structured fact`,
      );
    }
    if (
      newer &&
      field in newer.facts &&
      change.new_value !== newer.facts[field]
    ) {
      errors.push(
        `${label} new value contradicts the newer event's structured fact`,
      );
    }
  });

  if (
    changes.length > 0 &&
    !errors.some(
      (error) => error.startsWith("change[") || error.startsWith("duplicate"),
    )
  ) {
    checks.push(
      "field_scoped_changes",
      "verbatim_evidence",
      "structured_fact_consistency",
    );
  }

  const privilegeIncrease = changes.some(
    (change) => change.field === "edit_protected" && change.new_value === true,
  );
  if (privilegeIncrease) {
    const authorizationEvent =
      typeof proposal.authorization_event_id === "string"
        ? byId.get(proposal.authorization_event_id)
        : undefined;
    const targetChange = changes.find(
      (change) => change.field === "target_file",
    );
    const authorizedTarget =
      targetChange?.new_value ?? newer?.facts.target_file;
    const scope = authorizationEvent?.facts.protected_scope;
    if (
      !authorizationEvent ||
      authorizationEvent.event_id !== proposal.newer_event_id ||
      !["instruction", "policy", "state"].includes(authorizationEvent.kind) ||
      !["user", "policy"].includes(authorizationEvent.source) ||
      !["user", "policy"].includes(
        String(authorizationEvent.facts.authority),
      ) ||
      authorizationEvent.facts.edit_protected !== true ||
      typeof authorizedTarget !== "string" ||
      !authorizedTarget ||
      !Array.isArray(scope) ||
      !scope.includes(authorizedTarget)
    ) {
      errors.push(
        "protected permission increase requires an explicit trusted authorization event for the exact target",
      );
    } else checks.push("trusted_privilege_authorization");
  }

  let unresolved: string[] = [];
  if (
    !stringList(proposal.unresolved_fields ?? []) ||
    (proposal.unresolved_fields as string[]).some((field) => !field)
  ) {
    errors.push("unresolved_fields must be a list of non-empty field names");
  } else {
    unresolved = proposal.unresolved_fields as string[];
    if (new Set(unresolved).size !== unresolved.length)
      errors.push("unresolved_fields must not contain duplicates");
    else if (unresolved.some((field) => fields.includes(field)))
      errors.push("a field cannot be both changed and unresolved");
    else checks.push("unresolved_fields_declared");
  }

  const digest = canonicalDigest(proposal);
  if (review.proposal_id !== proposalId)
    errors.push("review does not name this proposal");
  if (review.proposal_sha256 !== digest)
    errors.push("review digest does not match the immutable proposal");
  else checks.push("review_digest");

  const reviewConfidence = review.confidence;
  if (
    typeof reviewConfidence !== "number" ||
    !Number.isFinite(reviewConfidence) ||
    reviewConfidence < 0 ||
    reviewConfidence > 1
  ) {
    errors.push("review confidence must be between 0 and 1");
  } else if (reviewConfidence < AUTO_ACCEPT_CONFIDENCE)
    errors.push("review confidence is below the automatic-accept threshold");
  else checks.push("review_confidence");

  const verdict = review.verdict;
  if (!["approve", "revise", "reject"].includes(String(verdict))) {
    errors.push("review verdict must be approve, revise, or reject");
  }
  let acceptedFields: string[] = [];
  if (!stringList(review.accepted_fields ?? []))
    errors.push("accepted_fields must be a list of field names");
  else acceptedFields = review.accepted_fields as string[];
  if (verdict === "approve" && !sameStringSet(acceptedFields, fields)) {
    errors.push(
      "an approving review must explicitly accept every changed field",
    );
  } else if (verdict === "approve") checks.push("review_field_agreement");
  if (verdict === "approve" && review.accepted_entity !== proposal.entity) {
    errors.push(
      "an approving review must explicitly accept the proposed entity binding",
    );
  } else if (verdict === "approve") checks.push("review_entity_agreement");
  if (verdict === "approve" && review.accepted_relation !== relation) {
    errors.push(
      "an approving review must explicitly accept the proposed relation",
    );
  } else if (verdict === "approve") checks.push("review_relation_agreement");

  let fieldReviews: Array<Record<string, unknown>> = [];
  if (
    !Array.isArray(review.field_reviews) ||
    !review.field_reviews.every(isRecord)
  ) {
    errors.push("field_reviews must contain independent field-level findings");
  } else fieldReviews = review.field_reviews;
  const reviewByField = new Map<string, Record<string, unknown>>();
  for (const item of fieldReviews)
    if (typeof item.field === "string") reviewByField.set(item.field, item);
  if (reviewByField.size !== fieldReviews.length)
    errors.push("field_reviews must name each field exactly once");
  for (const change of changes) {
    const field = change.field;
    const finding =
      typeof field === "string" ? reviewByField.get(field) : undefined;
    if (!finding) {
      errors.push(
        `review is missing an independent finding for ${String(field)}`,
      );
      continue;
    }
    for (const key of ["operation", "old_value", "new_value"] as const) {
      if (finding[key] !== change[key])
        errors.push(
          `review finding disagrees with proposal for ${String(field)}:${key}`,
        );
    }
    const oldReviewEvidence = finding.old_evidence;
    const newReviewEvidence = finding.new_evidence;
    if (older) {
      if (
        !isRecord(oldReviewEvidence) ||
        oldReviewEvidence.event_id !== older.event_id
      ) {
        errors.push(
          `review finding old evidence must point to the older event for ${String(field)}`,
        );
      } else if (!quoteIsGrounded(older, oldReviewEvidence.quote)) {
        errors.push(
          `review finding old quote is not present verbatim for ${String(field)}`,
        );
      }
    }
    if (newer) {
      if (
        !isRecord(newReviewEvidence) ||
        newReviewEvidence.event_id !== newer.event_id
      ) {
        errors.push(
          `review finding new evidence must point to the newer event for ${String(field)}`,
        );
      } else if (!quoteIsGrounded(newer, newReviewEvidence.quote)) {
        errors.push(
          `review finding new quote is not present verbatim for ${String(field)}`,
        );
      }
    }
  }
  if (
    changes.length > 0 &&
    reviewByField.size === changes.length &&
    !errors.some(
      (error) =>
        error.startsWith("review is missing") ||
        error.startsWith("review finding"),
    )
  ) {
    checks.push("independent_field_findings");
  }

  let reviewIssues: string[] = [];
  if (!stringList(review.issues ?? []))
    errors.push("review issues must be a list of strings");
  else reviewIssues = review.issues as string[];
  if (verdict === "approve" && reviewIssues.length > 0)
    errors.push("an approving review cannot retain unresolved issues");

  let status: RelationVerdict["status"];
  if (errors.length > 0 || verdict === "reject") status = "REJECTED";
  else if (
    relation === "adds" ||
    relation === "conflicts" ||
    verdict === "revise" ||
    unresolved.length > 0 ||
    reviewIssues.length > 0
  ) {
    status = "NEEDS_CLARIFICATION";
  } else status = "ACCEPTED";

  return {
    schema_version: "contextadapt.relation-verdict.v1",
    status,
    proposal_id: proposalId,
    proposal_sha256: digest,
    relation,
    older_event_id: proposal.older_event_id,
    newer_event_id: proposal.newer_event_id,
    entity: proposal.entity,
    accepted_changes: status === "ACCEPTED" ? changes : [],
    unresolved_fields: unresolved,
    engineering_checks: checks,
    errors,
    semantic_boundary:
      "Engineering verified provenance and agreement; semantic meaning remains attributable to the named analyzer and independent reviewer runs.",
  };
}

function sameStringSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === new Set(right).size &&
    left.every((item) => right.includes(item))
  );
}

export interface ActionRelationResult extends Record<string, unknown> {
  status: "REJECTED" | "NEEDS_CLARIFICATION" | "BLOCK" | "PASS";
  reasons: string[];
  changed_fields?: string[];
  risks?: Risk[];
}

export function evaluateActionWithRelation(
  events: TraceEvent[],
  relationVerdict: RelationVerdict,
  actionEventId: string,
): ActionRelationResult {
  const byId = new Map(events.map((event) => [event.event_id, event]));
  const action = byId.get(actionEventId);
  if (!action || action.kind !== "action") {
    return {
      status: "REJECTED",
      reasons: ["action event does not exist or is not an action"],
    };
  }
  if (relationVerdict.status !== "ACCEPTED") {
    return {
      status: "NEEDS_CLARIFICATION",
      reasons: [
        "context relation has not passed both semantic and engineering review",
      ],
    };
  }
  const expectedEntity =
    typeof relationVerdict.entity === "string" ? relationVerdict.entity : null;
  const contract = validateActionContract(events, action, {
    allowedBasisIds: new Set([
      typeof relationVerdict.older_event_id === "string"
        ? relationVerdict.older_event_id
        : undefined,
      typeof relationVerdict.newer_event_id === "string"
        ? relationVerdict.newer_event_id
        : undefined,
    ]),
    expectedEntity,
  });
  const basedOn = action.links.based_on_event;
  const usedFields = action.facts.context_fields_used;
  const reasons = contract.risks.map((item) => item.evidence.reason);
  const changedFields: string[] = [];
  if (basedOn === relationVerdict.older_event_id && Array.isArray(usedFields)) {
    const changed = relationVerdict.accepted_changes.map((change) =>
      String(change.field),
    );
    const omitted = changed.filter((field) => !usedFields.includes(field));
    if (omitted.length > 0)
      reasons.push(
        `action does not account for changed context fields: ${omitted.join(", ")}`,
      );
    for (const change of relationVerdict.accepted_changes) {
      const field = String(change.field);
      if (field in action.facts && action.facts[field] !== change.new_value) {
        changedFields.push(field);
        reasons.push(
          `action uses stale ${field}=${JSON.stringify(action.facts[field])}; current reviewed value is ${JSON.stringify(change.new_value)}`,
        );
      }
    }
  }
  if (reasons.length > 0) {
    return {
      status: "BLOCK",
      changed_fields: changedFields,
      reasons,
      risks: contract.risks,
    };
  }
  return { status: "PASS", changed_fields: [], reasons: [] };
}
