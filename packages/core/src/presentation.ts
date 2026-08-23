import type { ContextSnapshot, TraceEvent } from "./types.js";

function facts(value: Record<string, unknown>): string {
  if (Object.keys(value).length === 0) return "(no structured facts)";
  return Object.keys(value)
    .sort()
    .map((key) => `${key}=${JSON.stringify(value[key])}`)
    .join(", ");
}

export function gateStatus(
  snapshot: ContextSnapshot,
): "PASS" | "BLOCK" | "INSUFFICIENT_EVIDENCE" {
  const {
    candidate_action_count: candidates,
    assessable_action_count: assessable,
  } = snapshot.gate_evidence;
  if (candidates === 0 || assessable < candidates)
    return "INSUFFICIENT_EVIDENCE";
  return snapshot.risk_summary.total > 0 ? "BLOCK" : "PASS";
}

export function renderCheck(snapshot: ContextSnapshot): string {
  const status = gateStatus(snapshot);
  const lines = [
    `ContextAdapt check · ${status}`,
    "=".repeat(29),
    `Trace: ${snapshot.trace_id}  Events: ${snapshot.event_count}`,
    "",
  ];
  if (status === "INSUFFICIENT_EVIDENCE") {
    lines.push(
      "This trace cannot support a safety verdict.",
      `Candidate actions: ${snapshot.gate_evidence.candidate_action_count}  Assessable actions: ${snapshot.gate_evidence.assessable_action_count}`,
    );
    for (const risk of snapshot.risks)
      lines.push(`  ! ${risk.type}: ${risk.evidence.reason}`);
    lines.push(
      "",
      "Decision: do not execute; obtain complete action provenance and scope.",
    );
  } else if (status === "BLOCK") {
    const explanations: Record<string, string> = {
      stale_action: "Action was built from context that has been superseded.",
      unresolved_context_relation:
        "A newer context exists, but its relation to the action basis is unresolved.",
      missing_action_provenance:
        "Action does not declare a valid context basis.",
      missing_protection_assessment:
        "Action does not declare whether it touches protected state.",
      incomplete_action_contract:
        "Action is missing the structured fields required for gating.",
      unbound_protected_permission:
        "Protected edit is not authorized by the current request.",
    };
    lines.push(
      `Found ${snapshot.risk_summary.total} action risk(s) before execution:`,
    );
    for (const risk of [...snapshot.risks].sort(
      (a, b) =>
        (a.severity === "critical" ? 0 : 1) -
        (b.severity === "critical" ? 0 : 1),
    )) {
      lines.push(
        `  ! ${risk.severity.toUpperCase().padEnd(8)} ${explanations[risk.type] ?? risk.evidence.reason}`,
        `             action=${risk.event_id}`,
      );
    }
    lines.push(
      "",
      "Decision: do not execute these candidate actions; rebuild from current state.",
    );
  } else {
    lines.push(
      "No stale-action or protected-permission risk was detected.",
      "Decision: this check does not block the candidate actions.",
    );
  }
  if (snapshot.current_state.length > 0) {
    lines.push("", "Current context used by the check:");
    for (const event of snapshot.current_state)
      lines.push(
        `  - ${event.entity} (seq=${event.sequence}): ${facts(event.facts)}`,
      );
  }
  lines.push(
    "",
    "Boundary: PASS means no supported risk was found, not that an action is universally safe.",
    "",
  );
  return lines.join("\n");
}

function eventLine(event: TraceEvent): string {
  return `- ${event.entity} seq=${event.sequence} source=${event.source} facts=${JSON.stringify(event.facts)}`;
}

export function renderDiagnosis(snapshot: ContextSnapshot): string {
  const lines = [
    `ContextAdapt diagnosis: ${snapshot.trace_id}`,
    `Events: ${snapshot.event_count}  Risks: ${snapshot.risk_summary.total}`,
    "",
    "CURRENT STATE",
    ...snapshot.current_state.map(eventLine),
    "",
    "LAST SUCCESSFUL OBSERVATIONS",
    ...snapshot.last_successful_observations.map(eventLine),
    "",
    "LATEST FAILURES",
    ...snapshot.latest_failures.map(eventLine),
    "",
    "RISKS",
  ];
  if (snapshot.risks.length === 0) lines.push("- none detected");
  for (const risk of snapshot.risks)
    lines.push(
      `- [${risk.severity.toUpperCase()}] ${risk.type} event=${risk.event_id}: ${risk.evidence.reason}`,
    );
  return `${lines.join("\n")}\n`;
}
