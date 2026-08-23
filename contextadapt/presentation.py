"""Human-facing output for action checks."""

from __future__ import annotations

from typing import Any


def _facts(value: dict[str, Any]) -> str:
    if not value:
        return "(no structured facts)"
    return ", ".join(f"{key}={value[key]!r}" for key in sorted(value))


def gate_status(snapshot: dict[str, Any]) -> str:
    evidence = snapshot.get("gate_evidence", {})
    candidate_count = evidence.get("candidate_action_count", 0)
    assessable_count = evidence.get("assessable_action_count", 0)
    if candidate_count == 0 or assessable_count < candidate_count:
        return "INSUFFICIENT_EVIDENCE"
    if snapshot["risk_summary"]["total"]:
        return "BLOCK"
    return "PASS"


def render_check(snapshot: dict[str, Any]) -> str:
    """Render an execution-gate verdict with a compact evidence trail."""

    status = gate_status(snapshot)
    blocked = status != "PASS"
    lines = [
        f"ContextAdapt check · {status}",
        "=" * 29,
        f"Trace: {snapshot['trace_id']}  Events: {snapshot['event_count']}",
        "",
    ]
    if status == "INSUFFICIENT_EVIDENCE":
        evidence = snapshot.get("gate_evidence", {})
        lines.extend(
            [
                "This trace cannot support a safety verdict.",
                f"Candidate actions: {evidence.get('candidate_action_count', 0)}  "
                f"Assessable actions: {evidence.get('assessable_action_count', 0)}",
            ]
        )
        for risk in snapshot["risks"]:
            lines.append(f"  ! {risk['type']}: {risk['evidence']['reason']}")
        lines.extend(["", "Decision: do not execute; obtain complete action provenance and scope."])
    elif blocked:
        lines.append(f"Found {snapshot['risk_summary']['total']} action risk(s) before execution:")
        priority = {"critical": 0, "high": 1}
        for risk in sorted(snapshot["risks"], key=lambda item: priority.get(item["severity"], 9)):
            explanation = {
                "stale_action": "Action was built from context that has been superseded.",
                "unresolved_context_relation": "A newer context exists, but its relation to the action basis is unresolved.",
                "missing_action_provenance": "Action does not declare a valid context basis.",
                "missing_protection_assessment": "Action does not declare whether it touches protected state.",
                "incomplete_action_contract": "Action is missing the structured fields required for gating.",
                "unbound_protected_permission": "Protected edit is not authorized by the current request.",
            }.get(risk["type"], risk["evidence"]["reason"])
            lines.append(f"  ! {risk['severity'].upper():8} {explanation}")
            lines.append(f"             action={risk['event_id']}")
        lines.extend(["", "Decision: do not execute these candidate actions; rebuild from current state."])
    else:
        lines.extend(
            [
                "No stale-action or protected-permission risk was detected.",
                "Decision: this check does not block the candidate actions.",
            ]
        )

    if snapshot["current_state"]:
        lines.extend(["", "Current context used by the check:"])
        for event in snapshot["current_state"]:
            lines.append(f"  - {event['entity']} (seq={event['sequence']}): {_facts(event['facts'])}")
    lines.extend(
        [
            "",
            "Boundary: PASS means no supported risk was found, not that an action is universally safe.",
            "",
        ]
    )
    return "\n".join(lines)
