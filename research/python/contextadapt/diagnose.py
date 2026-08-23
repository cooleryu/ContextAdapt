"""Deterministic, provenance-aware diagnosis and ContextSnapshot building."""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Iterable

from .schema import SCHEMA_VERSION, TraceEvent
from .action_gate import validate_action_contract


SNAPSHOT_VERSION = "contextadapt.snapshot.v1"
STATE_KINDS = {"state", "instruction", "policy"}


def _rank(event: TraceEvent, input_index: int) -> tuple[int, str, int]:
    # Explicit sequence is authoritative. Missing sequence sorts below an
    # explicit value; observed_at and input order provide deterministic ties.
    sequence = event.sequence if event.sequence is not None else -1
    return sequence, event.observed_at or "", input_index


def _select_latest(events: Iterable[tuple[int, TraceEvent]]) -> tuple[TraceEvent, list[TraceEvent]]:
    ranked = sorted(events, key=lambda pair: _rank(pair[1], pair[0]))
    return ranked[-1][1], [event for _, event in ranked[:-1]]


def build_snapshot(events: list[TraceEvent], trace_id: str = "trace") -> dict[str, Any]:
    indexed = list(enumerate(events))
    by_id = {event.event_id: event for event in events}
    state_groups: dict[str, list[tuple[int, TraceEvent]]] = defaultdict(list)
    success_groups: dict[str, list[tuple[int, TraceEvent]]] = defaultdict(list)
    failure_groups: dict[str, list[tuple[int, TraceEvent]]] = defaultdict(list)
    actions = []
    notes = []

    for index, event in indexed:
        if event.kind in STATE_KINDS and event.entity:
            state_groups[event.entity].append((index, event))
        elif event.kind == "observation" and event.entity:
            (success_groups if event.success is True else failure_groups)[event.entity].append((index, event))
        elif event.kind == "action":
            actions.append(event)
        else:
            notes.append(event)

    current_state = []
    superseded = []
    current_event_ids = set()
    explicitly_replaced_ids = {
        event.links["replaces"]
        for event in events
        if event.links.get("replaces") in by_id
    }
    for entity in sorted(state_groups):
        current, older = _select_latest(state_groups[entity])
        current_event_ids.add(current.event_id)
        current_state.append(current.to_dict())
        superseded.extend(event.to_dict() for event in older)

    successful = []
    for entity in sorted(success_groups):
        current, older = _select_latest(success_groups[entity])
        successful.append(current.to_dict())
        superseded.extend(event.to_dict() for event in older)

    failures = []
    for entity in sorted(failure_groups):
        current, _ = _select_latest(failure_groups[entity])
        failures.append(current.to_dict())

    risks = []
    for action in actions:
        contract = validate_action_contract(events, action)
        risks.extend(contract["risks"])
        based_on = action.links.get("based_on_event")
        if based_on in explicitly_replaced_ids:
            basis = by_id[based_on]
            risks.append({
                "type": "stale_action",
                "severity": "high",
                "event_id": action.event_id,
                "evidence": {
                    "based_on_event": based_on,
                    "based_on_entity": basis.entity,
                    "based_on_sequence": basis.sequence,
                    "reason": "action is based on an event that is no longer current for its entity",
                },
            })
        elif based_on and based_on in by_id and based_on not in current_event_ids:
            basis = by_id[based_on]
            risks.append({
                "type": "unresolved_context_relation",
                "severity": "high",
                "event_id": action.event_id,
                "evidence": {
                    "based_on_event": based_on,
                    "based_on_entity": basis.entity,
                    "based_on_sequence": basis.sequence,
                    "reason": (
                        "a newer event exists for this entity, but no validated relation says "
                        "whether it replaces, narrows, or adds to the action basis"
                    ),
                },
            })

    return {
        "schema_version": SNAPSHOT_VERSION,
        "input_schema_version": SCHEMA_VERSION,
        "trace_id": trace_id,
        "event_count": len(events),
        "current_state": current_state,
        "last_successful_observations": successful,
        "latest_failures": failures,
        "candidate_actions": [event.to_dict() for event in actions],
        "superseded_events": superseded,
        "notes": [event.to_dict() for event in notes],
        "risks": risks,
        "risk_summary": {
            "total": len(risks),
            "critical": sum(risk["severity"] == "critical" for risk in risks),
            "high": sum(risk["severity"] == "high" for risk in risks),
        },
        "gate_evidence": {
            "candidate_action_count": len(actions),
            "assessable_action_count": sum(
                validate_action_contract(events, action)["assessable"] for action in actions
            ),
        },
    }


def diagnose_trace(events: list[TraceEvent], trace_id: str = "trace") -> dict[str, Any]:
    return build_snapshot(events, trace_id)


def render_text(snapshot: dict[str, Any]) -> str:
    lines = [
        f"ContextAdapt diagnosis: {snapshot['trace_id']}",
        f"Events: {snapshot['event_count']}  Risks: {snapshot['risk_summary']['total']}",
        "",
        "CURRENT STATE",
    ]
    for event in snapshot["current_state"]:
        lines.append(f"- {event['entity']} seq={event['sequence']} source={event['source']} facts={event['facts']}")
    lines.extend(["", "LAST SUCCESSFUL OBSERVATIONS"])
    for event in snapshot["last_successful_observations"]:
        lines.append(f"- {event['entity']} seq={event['sequence']} source={event['source']} facts={event['facts']}")
    lines.extend(["", "LATEST FAILURES"])
    for event in snapshot["latest_failures"]:
        lines.append(f"- {event['entity']} seq={event['sequence']} source={event['source']} facts={event['facts']}")
    lines.extend(["", "RISKS"])
    if not snapshot["risks"]:
        lines.append("- none detected")
    for risk in snapshot["risks"]:
        lines.append(f"- [{risk['severity'].upper()}] {risk['type']} event={risk['event_id']}: {risk['evidence']['reason']}")
    return "\n".join(lines) + "\n"
