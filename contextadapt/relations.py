"""Hybrid AI proposal + deterministic verification for context relations.

The model is allowed to propose semantic links.  The verifier never pretends
to understand natural language: it checks provenance, chronology, exact
evidence quotes, field scope, structured facts, independent review, and the
immutable digest of the proposal.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from .schema import TraceEvent
from .action_gate import validate_action_contract


PROPOSAL_SCHEMA_VERSION = "contextadapt.relation-proposal.v1"
REVIEW_SCHEMA_VERSION = "contextadapt.relation-review.v1"
ALLOWED_RELATIONS = {"supersedes", "partial_supersession", "narrows", "adds", "conflicts"}
ALLOWED_OPERATIONS = {"replace", "set", "deny", "allow", "unset"}
AUTO_ACCEPT_CONFIDENCE = 0.85
FIELD_RULES: dict[str, tuple[type, set[str]]] = {
    "environment": (str, {"replace", "set"}),
    "timeout": (int, {"replace", "set"}),
    "edit_protected": (bool, {"deny", "allow", "set"}),
    "target_file": (str, {"replace", "set"}),
}


def canonical_digest(value: dict[str, Any]) -> str:
    rendered = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(rendered.encode("utf-8")).hexdigest()


def _event_rank(event: TraceEvent) -> tuple[int, str]:
    return event.sequence if event.sequence is not None else -1, event.observed_at or ""


def _quote_is_grounded(event: TraceEvent, quote: Any) -> bool:
    return isinstance(quote, str) and bool(quote.strip()) and quote in event.text


def validate_relation_bundle(
    events: list[TraceEvent],
    proposal: dict[str, Any],
    review: dict[str, Any],
) -> dict[str, Any]:
    """Validate an AI-proposed field-level relation and independent review.

    A successful result means the proposal is mechanically well-grounded and
    independently approved.  It does not claim that software understood the
    quoted natural language; that semantic judgment remains attributable to
    the analyzer and reviewer runs.
    """

    errors: list[str] = []
    checks: list[str] = []
    by_id = {event.event_id: event for event in events}

    if proposal.get("schema_version") != PROPOSAL_SCHEMA_VERSION:
        errors.append("unsupported proposal schema")
    else:
        checks.append("proposal_schema")
    if review.get("schema_version") != REVIEW_SCHEMA_VERSION:
        errors.append("unsupported review schema")
    else:
        checks.append("review_schema")

    proposal_id = proposal.get("proposal_id")
    analyzer_run_id = proposal.get("analyzer_run_id")
    reviewer_run_id = review.get("reviewer_run_id")
    if not all(isinstance(value, str) and value for value in (proposal_id, analyzer_run_id, reviewer_run_id)):
        errors.append("proposal, analyzer, and reviewer identifiers are required")
    elif analyzer_run_id == reviewer_run_id:
        errors.append("analyzer and reviewer must be independent runs")
    else:
        checks.append("independent_runs")

    older = by_id.get(proposal.get("older_event_id"))
    newer = by_id.get(proposal.get("newer_event_id"))
    if older is None or newer is None:
        errors.append("proposal references an unknown older or newer event")
    else:
        checks.append("events_exist")
        if _event_rank(newer) <= _event_rank(older):
            errors.append("newer event must rank after older event")
        else:
            checks.append("chronology")
        proposed_entity = proposal.get("entity")
        if not isinstance(proposed_entity, str) or not proposed_entity:
            errors.append("proposal must bind both events to a non-empty entity")
        elif (older.entity and older.entity != proposed_entity) or (newer.entity and newer.entity != proposed_entity):
            errors.append("proposed entity contradicts an existing structured event entity")
        else:
            checks.append("entity_binding")

    relation = proposal.get("relation")
    if relation not in ALLOWED_RELATIONS:
        errors.append("unsupported relation type")
    else:
        checks.append("relation_type")

    confidence = proposal.get("confidence")
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        errors.append("proposal confidence must be between 0 and 1")
    elif confidence < AUTO_ACCEPT_CONFIDENCE:
        errors.append("proposal confidence is below the automatic-accept threshold")
    else:
        checks.append("proposal_confidence")

    changes = proposal.get("changes")
    fields: list[str] = []
    if not isinstance(changes, list) or not changes:
        errors.append("proposal must contain at least one field-level change")
        changes = []
    for index, change in enumerate(changes):
        label = f"change[{index}]"
        if not isinstance(change, dict):
            errors.append(f"{label} must be an object")
            continue
        field = change.get("field")
        if not isinstance(field, str) or not field:
            errors.append(f"{label} requires a field")
            continue
        if field in fields:
            errors.append(f"duplicate changed field: {field}")
        fields.append(field)
        operation = change.get("operation")
        if operation not in ALLOWED_OPERATIONS:
            errors.append(f"{label} uses an unsupported operation")
        if field not in FIELD_RULES:
            errors.append(f"{label} uses an unregistered field")
        else:
            expected_type, allowed_operations = FIELD_RULES[field]
            if operation not in allowed_operations:
                errors.append(f"{label} operation is not allowed for {field}")
            old_value = change.get("old_value")
            new_value = change.get("new_value")
            if type(old_value) is not expected_type or type(new_value) is not expected_type:
                errors.append(f"{label} values do not match the registered type for {field}")

        old_evidence = change.get("old_evidence")
        new_evidence = change.get("new_evidence")
        if older is not None:
            if not isinstance(old_evidence, dict) or old_evidence.get("event_id") != older.event_id:
                errors.append(f"{label} old evidence must point to the older event")
            elif not _quote_is_grounded(older, old_evidence.get("quote")):
                errors.append(f"{label} old evidence quote is not present verbatim in the older event")
        if newer is not None:
            if not isinstance(new_evidence, dict) or new_evidence.get("event_id") != newer.event_id:
                errors.append(f"{label} new evidence must point to the newer event")
            elif not _quote_is_grounded(newer, new_evidence.get("quote")):
                errors.append(f"{label} new evidence quote is not present verbatim in the newer event")

        if older is not None and field in older.facts and change.get("old_value") != older.facts[field]:
            errors.append(f"{label} old value contradicts the older event's structured fact")
        if newer is not None and field in newer.facts and change.get("new_value") != newer.facts[field]:
            errors.append(f"{label} new value contradicts the newer event's structured fact")

    if changes and not any(error.startswith("change[") or error.startswith("duplicate") for error in errors):
        checks.append("field_scoped_changes")
        checks.append("verbatim_evidence")
        checks.append("structured_fact_consistency")

    privilege_increase = any(
        change.get("field") == "edit_protected" and change.get("new_value") is True
        for change in changes
    )
    if privilege_increase:
        authorization_event = by_id.get(proposal.get("authorization_event_id"))
        target_change = next(
            (change for change in changes if change.get("field") == "target_file"),
            None,
        )
        authorized_target = (
            target_change.get("new_value")
            if target_change is not None
            else newer.facts.get("target_file") if newer is not None else None
        )
        if not (
            authorization_event
            and authorization_event.event_id == proposal.get("newer_event_id")
            and authorization_event.kind in {"instruction", "policy", "state"}
            and authorization_event.source in {"user", "policy"}
            and authorization_event.facts.get("authority") in {"user", "policy"}
            and authorization_event.facts.get("edit_protected") is True
            and isinstance(authorized_target, str)
            and bool(authorized_target)
            and isinstance(authorization_event.facts.get("protected_scope"), list)
            and authorized_target in authorization_event.facts["protected_scope"]
        ):
            errors.append(
                "protected permission increase requires an explicit trusted authorization event for the exact target"
            )
        else:
            checks.append("trusted_privilege_authorization")

    unresolved = proposal.get("unresolved_fields", [])
    if not isinstance(unresolved, list) or any(not isinstance(field, str) or not field for field in unresolved):
        errors.append("unresolved_fields must be a list of non-empty field names")
        unresolved = []
    elif len(unresolved) != len(set(unresolved)):
        errors.append("unresolved_fields must not contain duplicates")
    elif set(unresolved) & set(fields):
        errors.append("a field cannot be both changed and unresolved")
    else:
        checks.append("unresolved_fields_declared")

    digest = canonical_digest(proposal)
    if review.get("proposal_id") != proposal_id:
        errors.append("review does not name this proposal")
    if review.get("proposal_sha256") != digest:
        errors.append("review digest does not match the immutable proposal")
    else:
        checks.append("review_digest")

    review_confidence = review.get("confidence")
    if isinstance(review_confidence, bool) or not isinstance(review_confidence, (int, float)) or not 0 <= review_confidence <= 1:
        errors.append("review confidence must be between 0 and 1")
    elif review_confidence < AUTO_ACCEPT_CONFIDENCE:
        errors.append("review confidence is below the automatic-accept threshold")
    else:
        checks.append("review_confidence")

    verdict = review.get("verdict")
    if verdict not in {"approve", "revise", "reject"}:
        errors.append("review verdict must be approve, revise, or reject")
    accepted_fields = review.get("accepted_fields", [])
    if not isinstance(accepted_fields, list) or any(not isinstance(field, str) for field in accepted_fields):
        errors.append("accepted_fields must be a list of field names")
        accepted_fields = []
    if verdict == "approve" and set(accepted_fields) != set(fields):
        errors.append("an approving review must explicitly accept every changed field")
    elif verdict == "approve":
        checks.append("review_field_agreement")
    if verdict == "approve" and review.get("accepted_entity") != proposal.get("entity"):
        errors.append("an approving review must explicitly accept the proposed entity binding")
    elif verdict == "approve":
        checks.append("review_entity_agreement")
    if verdict == "approve" and review.get("accepted_relation") != relation:
        errors.append("an approving review must explicitly accept the proposed relation")
    elif verdict == "approve":
        checks.append("review_relation_agreement")

    field_reviews = review.get("field_reviews", [])
    if not isinstance(field_reviews, list) or any(not isinstance(item, dict) for item in field_reviews):
        errors.append("field_reviews must contain independent field-level findings")
        field_reviews = []
    review_by_field = {item.get("field"): item for item in field_reviews if isinstance(item.get("field"), str)}
    if len(review_by_field) != len(field_reviews):
        errors.append("field_reviews must name each field exactly once")
    for change in changes:
        finding = review_by_field.get(change.get("field"))
        if finding is None:
            errors.append(f"review is missing an independent finding for {change.get('field')}")
            continue
        for key in ("operation", "old_value", "new_value"):
            if finding.get(key) != change.get(key):
                errors.append(f"review finding disagrees with proposal for {change.get('field')}:{key}")
        old_review_evidence = finding.get("old_evidence")
        new_review_evidence = finding.get("new_evidence")
        if older is not None:
            if not isinstance(old_review_evidence, dict) or old_review_evidence.get("event_id") != older.event_id:
                errors.append(f"review finding old evidence must point to the older event for {change.get('field')}")
            elif not _quote_is_grounded(older, old_review_evidence.get("quote")):
                errors.append(f"review finding old quote is not present verbatim for {change.get('field')}")
        if newer is not None:
            if not isinstance(new_review_evidence, dict) or new_review_evidence.get("event_id") != newer.event_id:
                errors.append(f"review finding new evidence must point to the newer event for {change.get('field')}")
            elif not _quote_is_grounded(newer, new_review_evidence.get("quote")):
                errors.append(f"review finding new quote is not present verbatim for {change.get('field')}")
    if changes and len(review_by_field) == len(changes) and not any(
        error.startswith("review is missing") or error.startswith("review finding")
        for error in errors
    ):
        checks.append("independent_field_findings")

    review_issues = review.get("issues", [])
    if not isinstance(review_issues, list) or any(not isinstance(issue, str) for issue in review_issues):
        errors.append("review issues must be a list of strings")
        review_issues = []
    if verdict == "approve" and review_issues:
        errors.append("an approving review cannot retain unresolved issues")

    if errors or verdict == "reject":
        status = "REJECTED"
    elif relation in {"adds", "conflicts"} or verdict == "revise" or unresolved or review_issues:
        status = "NEEDS_CLARIFICATION"
    else:
        status = "ACCEPTED"

    return {
        "schema_version": "contextadapt.relation-verdict.v1",
        "status": status,
        "proposal_id": proposal_id,
        "proposal_sha256": digest,
        "relation": relation,
        "older_event_id": proposal.get("older_event_id"),
        "newer_event_id": proposal.get("newer_event_id"),
        "entity": proposal.get("entity"),
        "accepted_changes": changes if status == "ACCEPTED" else [],
        "unresolved_fields": unresolved,
        "engineering_checks": checks,
        "errors": errors,
        "semantic_boundary": (
            "Engineering verified provenance and agreement; semantic meaning remains attributable "
            "to the named analyzer and independent reviewer runs."
        ),
    }


def evaluate_action_with_relation(
    events: list[TraceEvent],
    relation_verdict: dict[str, Any],
    action_event_id: str,
) -> dict[str, Any]:
    """Check a candidate action against an accepted field-level relation."""

    by_id = {event.event_id: event for event in events}
    action = by_id.get(action_event_id)
    if action is None or action.kind != "action":
        return {"status": "REJECTED", "reasons": ["action event does not exist or is not an action"]}
    if relation_verdict.get("status") != "ACCEPTED":
        return {
            "status": "NEEDS_CLARIFICATION",
            "reasons": ["context relation has not passed both semantic and engineering review"],
        }

    contract = validate_action_contract(
        events,
        action,
        allowed_basis_ids={relation_verdict.get("older_event_id"), relation_verdict.get("newer_event_id")},
        expected_entity=relation_verdict.get("entity"),
    )
    based_on = action.links.get("based_on_event")
    used_fields = action.facts.get("context_fields_used", [])

    reasons = [risk["evidence"]["reason"] for risk in contract["risks"]]
    changed_fields = []
    if based_on == relation_verdict.get("older_event_id") and isinstance(used_fields, list):
        changed = [change["field"] for change in relation_verdict.get("accepted_changes", [])]
        omitted = [field for field in changed if field not in used_fields]
        if omitted:
            reasons.append("action does not account for changed context fields: " + ", ".join(omitted))
        for change in relation_verdict.get("accepted_changes", []):
            field = change["field"]
            if field in action.facts and action.facts[field] != change.get("new_value"):
                changed_fields.append(field)
                reasons.append(
                    f"action uses stale {field}={action.facts[field]!r}; current reviewed value is {change.get('new_value')!r}"
                )
    if reasons:
        return {
            "status": "BLOCK",
            "changed_fields": changed_fields,
            "reasons": reasons,
            "risks": contract["risks"],
        }
    return {"status": "PASS", "changed_fields": [], "reasons": []}


def render_relation_verdict(verdict: dict[str, Any], action: dict[str, Any] | None = None) -> str:
    lines = [f"ContextAdapt relation · {verdict['status']}", "=" * 34]
    lines.append(
        f"{verdict.get('older_event_id')} -> {verdict.get('newer_event_id')} "
        f"({verdict.get('relation')})"
    )
    lines.append(f"Engineering checks passed: {len(verdict.get('engineering_checks', []))}")
    if verdict.get("unresolved_fields"):
        lines.append("Unresolved: " + ", ".join(verdict["unresolved_fields"]))
    for error in verdict.get("errors", []):
        lines.append(f"  ! {error}")
    if action is not None:
        lines.extend(["", f"Action verdict · {action['status']}"])
        for reason in action.get("reasons", []):
            lines.append(f"  ! {reason}")
    lines.extend(["", "Boundary: AI proposes meaning; engineering verifies evidence, order, scope, and review.", ""])
    return "\n".join(lines)
