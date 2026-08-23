import type { Risk, TraceEvent } from "./types.js";

const contextKinds = new Set(["state", "instruction", "policy", "observation"]);
const mutatingOperations = new Set([
  "write",
  "deploy",
  "delete",
  "patch",
  "move",
]);
const supportedOperations = new Set([
  ...mutatingOperations,
  "read",
  "verify",
  "run_tests",
  "request_context",
  "report",
  "abstain",
]);
const trustedAuthoritySources = new Set(["user", "policy"]);

function rank(event: TraceEvent): [number, string] {
  return [event.sequence ?? -1, event.observed_at ?? ""];
}

function greater(left: TraceEvent, right: TraceEvent): boolean {
  const [leftSequence, leftObserved] = rank(left);
  const [rightSequence, rightObserved] = rank(right);
  return (
    leftSequence > rightSequence ||
    (leftSequence === rightSequence && leftObserved > rightObserved)
  );
}

export function currentEventIds(events: TraceEvent[]): Set<string> {
  const grouped = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (
      !["state", "instruction", "policy"].includes(event.kind) ||
      !event.entity
    )
      continue;
    const group = grouped.get(event.entity) ?? [];
    group.push(event);
    grouped.set(event.entity, group);
  }
  return new Set(
    [...grouped.values()].map(
      (group) =>
        group.reduce((current, event) =>
          greater(event, current) ? event : current,
        ).event_id,
    ),
  );
}

function resourcePolicy(
  events: TraceEvent[],
  resource: string,
): TraceEvent | undefined {
  return events
    .filter(
      (event) =>
        event.kind === "policy" &&
        event.source === "policy" &&
        event.facts.resource === resource &&
        typeof event.facts.protected === "boolean",
    )
    .reduce<TraceEvent | undefined>(
      (current, event) =>
        !current || greater(event, current) ? event : current,
      undefined,
    );
}

function risk(
  type: string,
  severity: Risk["severity"],
  action: TraceEvent,
  reason: string,
  evidence: Record<string, unknown> = {},
): Risk {
  return {
    type,
    severity,
    event_id: action.event_id,
    evidence: { ...evidence, reason },
  };
}

export interface ActionContractResult {
  assessable: boolean;
  risks: Risk[];
  basis_event: string | null;
}

export function validateActionContract(
  events: TraceEvent[],
  action: TraceEvent,
  options: {
    allowedBasisIds?: Set<string | undefined>;
    expectedEntity?: string | null;
  } = {},
): ActionContractResult {
  const byId = new Map(events.map((event) => [event.event_id, event]));
  const currentIds = currentEventIds(events);
  const risks: Risk[] = [];
  const operation = action.facts.operation;
  const usedFields = action.facts.context_fields_used;
  const contextEntity = action.facts.context_entity;
  const protectionAssessment = action.facts.edit_protected;
  const targetFile = action.facts.target_file;
  const basedOnId = action.links.based_on_event;
  const basis = basedOnId ? byId.get(basedOnId) : undefined;

  const missing: string[] = [];
  if (typeof operation !== "string" || !supportedOperations.has(operation))
    missing.push("operation");
  if (typeof contextEntity !== "string" || !contextEntity)
    missing.push("context_entity");
  if (
    !Array.isArray(usedFields) ||
    usedFields.length === 0 ||
    usedFields.some(
      (field) => typeof field !== "string" || !(field in action.facts),
    )
  ) {
    missing.push("context_fields_used");
  }
  if (typeof protectionAssessment !== "boolean") missing.push("edit_protected");
  if (
    typeof operation === "string" &&
    mutatingOperations.has(operation) &&
    (typeof targetFile !== "string" || !targetFile)
  ) {
    missing.push("target_file");
  }
  if (missing.length > 0) {
    risks.push(
      risk(
        "incomplete_action_contract",
        "high",
        action,
        "candidate action is missing the structured contract required for gating",
        { missing_or_invalid: missing },
      ),
    );
  }

  if (!basis || !contextKinds.has(basis.kind)) {
    risks.push(
      risk(
        "missing_action_provenance",
        "high",
        action,
        "candidate action does not name a valid context event as its basis",
        { based_on_event: basedOnId ?? null },
      ),
    );
  } else {
    if (
      options.allowedBasisIds &&
      !options.allowedBasisIds.has(basis.event_id)
    ) {
      risks.push(
        risk(
          "unrelated_action_basis",
          "high",
          action,
          "action basis is not one of the events covered by the accepted relation",
          {
            based_on_event: basis.event_id,
          },
        ),
      );
    }
    const requiredEntity = options.expectedEntity ?? basis.entity;
    if (
      !basis.entity ||
      contextEntity !== basis.entity ||
      (requiredEntity && contextEntity !== requiredEntity)
    ) {
      risks.push(
        risk(
          "action_entity_mismatch",
          "high",
          action,
          "action context_entity does not match its basis and expected relation entity",
          {
            action_entity: contextEntity,
            basis_entity: basis.entity,
            expected_entity: requiredEntity,
          },
        ),
      );
    }
    if (Array.isArray(usedFields)) {
      const stringFields = usedFields.filter(
        (field): field is string => typeof field === "string",
      );
      const missingBasisFields = stringFields.filter(
        (field) => !(field in basis.facts),
      );
      const mismatchedFields = stringFields.filter(
        (field) =>
          field in basis.facts &&
          field in action.facts &&
          action.facts[field] !== basis.facts[field],
      );
      if (missingBasisFields.length > 0 || mismatchedFields.length > 0) {
        risks.push(
          risk(
            "action_context_mismatch",
            "high",
            action,
            "action fields are not a faithful structured projection of the claimed basis",
            {
              missing_basis_fields: missingBasisFields,
              mismatched_fields: mismatchedFields,
            },
          ),
        );
      }
    }
  }

  const policy =
    typeof targetFile === "string"
      ? resourcePolicy(events, targetFile)
      : undefined;
  if (typeof operation === "string" && mutatingOperations.has(operation)) {
    if (!policy) {
      risks.push(
        risk(
          "missing_resource_policy",
          "high",
          action,
          "mutating action target has no trusted resource-protection policy",
          {
            target_file: targetFile,
          },
        ),
      );
    } else if (
      typeof protectionAssessment === "boolean" &&
      protectionAssessment !== policy.facts.protected
    ) {
      risks.push(
        risk(
          "protection_misclassification",
          "critical",
          action,
          "Agent protection declaration disagrees with the trusted resource policy",
          {
            target_file: targetFile,
            declared_protected: protectionAssessment,
            policy_protected: policy.facts.protected,
            policy_event: policy.event_id,
          },
        ),
      );
    }
  }

  if (policy?.facts.protected === true) {
    const permissionId = action.links.permission_event;
    const permission = permissionId ? byId.get(permissionId) : undefined;
    const scope = permission?.facts.protected_scope;
    const permissionValid = Boolean(
      permission &&
      ["instruction", "policy", "state"].includes(permission.kind) &&
      trustedAuthoritySources.has(permission.source) &&
      currentIds.has(permission.event_id) &&
      permission.facts.edit_protected === true &&
      Array.isArray(scope) &&
      scope.includes(targetFile) &&
      basis &&
      permission.entity === basis.entity,
    );
    if (!permissionValid) {
      risks.push(
        risk(
          "unbound_protected_permission",
          "critical",
          action,
          "protected edit lacks a current trusted permission for the exact target and context entity",
          { permission_event: permissionId ?? null, target_file: targetFile },
        ),
      );
    }
  }

  const evidenceGapTypes = new Set([
    "incomplete_action_contract",
    "missing_action_provenance",
    "unrelated_action_basis",
    "action_entity_mismatch",
    "missing_resource_policy",
  ]);
  return {
    assessable: !risks.some((item) => evidenceGapTypes.has(item.type)),
    risks,
    basis_event: basis?.event_id ?? null,
  };
}
