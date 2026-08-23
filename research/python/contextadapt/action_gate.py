"""One fail-closed action contract shared by check and relation gates."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from .schema import TraceEvent


CONTEXT_KINDS = {"state", "instruction", "policy", "observation"}
MUTATING_OPERATIONS = {"write", "deploy", "delete", "patch", "move"}
SUPPORTED_OPERATIONS = MUTATING_OPERATIONS | {
    "read",
    "verify",
    "run_tests",
    "request_context",
    "report",
    "abstain",
}
TRUSTED_AUTHORITY_SOURCES = {"user", "policy"}


def _rank(event: TraceEvent) -> tuple[int, str]:
    return event.sequence if event.sequence is not None else -1, event.observed_at or ""


def current_event_ids(events: list[TraceEvent]) -> set[str]:
    grouped: dict[str, list[TraceEvent]] = defaultdict(list)
    for event in events:
        if event.kind in {"state", "instruction", "policy"} and event.entity:
            grouped[event.entity].append(event)
    return {max(group, key=_rank).event_id for group in grouped.values()}


def _resource_policy(events: list[TraceEvent], resource: str) -> TraceEvent | None:
    candidates = [
        event
        for event in events
        if event.kind == "policy"
        and event.source == "policy"
        and event.facts.get("resource") == resource
        and isinstance(event.facts.get("protected"), bool)
    ]
    return max(candidates, key=_rank) if candidates else None


def _risk(kind: str, severity: str, action: TraceEvent, reason: str, **evidence: Any) -> dict[str, Any]:
    return {
        "type": kind,
        "severity": severity,
        "event_id": action.event_id,
        "evidence": {**evidence, "reason": reason},
    }


def validate_action_contract(
    events: list[TraceEvent],
    action: TraceEvent,
    *,
    allowed_basis_ids: set[str] | None = None,
    expected_entity: str | None = None,
) -> dict[str, Any]:
    """Validate provenance, current values, resource policy, and permission."""

    by_id = {event.event_id: event for event in events}
    current_ids = current_event_ids(events)
    risks: list[dict[str, Any]] = []
    operation = action.facts.get("operation")
    used_fields = action.facts.get("context_fields_used")
    context_entity = action.facts.get("context_entity")
    protection_assessment = action.facts.get("edit_protected")
    target_file = action.facts.get("target_file")
    based_on_id = action.links.get("based_on_event")
    basis = by_id.get(based_on_id) if based_on_id else None

    missing = []
    if operation not in SUPPORTED_OPERATIONS:
        missing.append("operation")
    if not isinstance(context_entity, str) or not context_entity:
        missing.append("context_entity")
    if not isinstance(used_fields, list) or not used_fields or any(
        not isinstance(field, str) or field not in action.facts for field in used_fields
    ):
        missing.append("context_fields_used")
    if not isinstance(protection_assessment, bool):
        missing.append("edit_protected")
    if operation in MUTATING_OPERATIONS and (not isinstance(target_file, str) or not target_file):
        missing.append("target_file")
    if missing:
        risks.append(
            _risk(
                "incomplete_action_contract",
                "high",
                action,
                "candidate action is missing the structured contract required for gating",
                missing_or_invalid=missing,
            )
        )

    if basis is None or basis.kind not in CONTEXT_KINDS:
        risks.append(
            _risk(
                "missing_action_provenance",
                "high",
                action,
                "candidate action does not name a valid context event as its basis",
                based_on_event=based_on_id,
            )
        )
    else:
        if allowed_basis_ids is not None and basis.event_id not in allowed_basis_ids:
            risks.append(
                _risk(
                    "unrelated_action_basis",
                    "high",
                    action,
                    "action basis is not one of the events covered by the accepted relation",
                    based_on_event=basis.event_id,
                )
            )
        required_entity = expected_entity or basis.entity
        if not basis.entity or context_entity != basis.entity or (required_entity and context_entity != required_entity):
            risks.append(
                _risk(
                    "action_entity_mismatch",
                    "high",
                    action,
                    "action context_entity does not match its basis and expected relation entity",
                    action_entity=context_entity,
                    basis_entity=basis.entity,
                    expected_entity=required_entity,
                )
            )
        if isinstance(used_fields, list):
            missing_basis_fields = [field for field in used_fields if field not in basis.facts]
            mismatched_fields = [
                field
                for field in used_fields
                if field in basis.facts and field in action.facts and action.facts[field] != basis.facts[field]
            ]
            if missing_basis_fields or mismatched_fields:
                risks.append(
                    _risk(
                        "action_context_mismatch",
                        "high",
                        action,
                        "action fields are not a faithful structured projection of the claimed basis",
                        missing_basis_fields=missing_basis_fields,
                        mismatched_fields=mismatched_fields,
                    )
                )

    policy = _resource_policy(events, target_file) if isinstance(target_file, str) else None
    if operation in MUTATING_OPERATIONS:
        if policy is None:
            risks.append(
                _risk(
                    "missing_resource_policy",
                    "high",
                    action,
                    "mutating action target has no trusted resource-protection policy",
                    target_file=target_file,
                )
            )
        elif isinstance(protection_assessment, bool) and protection_assessment != policy.facts["protected"]:
            risks.append(
                _risk(
                    "protection_misclassification",
                    "critical",
                    action,
                    "Agent protection declaration disagrees with the trusted resource policy",
                    target_file=target_file,
                    declared_protected=protection_assessment,
                    policy_protected=policy.facts["protected"],
                    policy_event=policy.event_id,
                )
            )

    if policy is not None and policy.facts["protected"] is True:
        permission_id = action.links.get("permission_event")
        permission = by_id.get(permission_id) if permission_id else None
        permission_valid = bool(
            permission
            and permission.kind in {"instruction", "policy", "state"}
            and permission.source in TRUSTED_AUTHORITY_SOURCES
            and permission.event_id in current_ids
            and permission.facts.get("edit_protected") is True
            and isinstance(permission.facts.get("protected_scope"), list)
            and target_file in permission.facts["protected_scope"]
            and basis
            and permission.entity == basis.entity
        )
        if not permission_valid:
            risks.append(
                _risk(
                    "unbound_protected_permission",
                    "critical",
                    action,
                    "protected edit lacks a current trusted permission for the exact target and context entity",
                    permission_event=permission_id,
                    target_file=target_file,
                )
            )

    evidence_gap_types = {
        "incomplete_action_contract",
        "missing_action_provenance",
        "unrelated_action_basis",
        "action_entity_mismatch",
        "missing_resource_policy",
    }
    assessable = not any(risk["type"] in evidence_gap_types for risk in risks)
    return {"assessable": assessable, "risks": risks, "basis_event": basis.event_id if basis else None}
