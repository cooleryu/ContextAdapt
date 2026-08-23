"""Optional two-run Codex/Luna semantic analyzer for ContextAdapt.

This module is deliberately separate from the deterministic core.  Calling it
sends the selected raw events to a remote model through the user's existing
Codex login.  Run identities and output digests are attached by the host code,
not accepted from model-authored JSON.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import uuid
from typing import Any, Callable

from .relations import (
    PROPOSAL_SCHEMA_VERSION,
    REVIEW_SCHEMA_VERSION,
    canonical_digest,
)
from .schema import TraceEvent


DEFAULT_MODEL = "gpt-5.6-luna"
Runner = Callable[..., subprocess.CompletedProcess[str]]


SYSTEM_PROMPT = """You are one independent semantic context analyst.
Compare exactly two raw Agent-context events supplied on stdin.
Return exactly one JSON object and no Markdown.

Required keys:
- entity: normalized task/resource identity string
- relation: supersedes | partial_supersession | narrows | adds | conflicts
- confidence: number from 0 to 1
- changes: array of objects with field, operation, old_value, new_value, old_quote, new_quote
- unresolved_fields: array of field names

Allowed fields and types:
- environment: string; replace or set
- timeout: integer; replace or set
- edit_protected: boolean; deny, allow, or set
- target_file: string; replace or set

Every quote must be a non-empty verbatim substring of the corresponding event text.
Do not create a field or value that is not supported by the raw text or structured facts.
Do not silently carry ambiguous values forward; list them in unresolved_fields.
Treat a permission increase as unresolved unless the newer event is an explicit user/policy authorization.
"""


def _codex_command(model: str, isolated_workspace: str) -> list[str]:
    return [
        "codex",
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--strict-config",
        "--model",
        model,
        "-c",
        'model_reasoning_effort="medium"',
        "--sandbox",
        "read-only",
        "--cd",
        isolated_workspace,
        "--json",
        SYSTEM_PROMPT,
    ]


def _parse_json_object(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        stripped = "\n".join(lines).strip()
    value = json.loads(stripped)
    if not isinstance(value, dict):
        raise ValueError("semantic model output must be one JSON object")
    return value


def _parse_codex_stream(stdout: str) -> tuple[dict[str, Any], dict[str, Any]]:
    answer = ""
    thread_id = ""
    turn_completed = False
    usage: dict[str, int] = {}
    for raw in stdout.splitlines():
        raw = raw.strip()
        if not raw.startswith("{"):
            continue
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "thread.started":
            thread_id = str(event.get("thread_id", ""))
        item = event.get("item")
        if event.get("type") == "item.completed" and isinstance(item, dict) and item.get("type") == "agent_message":
            answer = str(item.get("text", ""))
        if event.get("type") == "turn.completed" and isinstance(event.get("usage"), dict):
            turn_completed = True
            usage = {
                str(key): int(value)
                for key, value in event["usage"].items()
                if isinstance(value, int) and not isinstance(value, bool)
            }
    if not answer:
        raise ValueError("Codex stream did not contain an Agent JSON answer")
    if not turn_completed:
        raise ValueError("Codex stream did not contain a completed turn")
    parsed = _parse_json_object(answer)
    if not thread_id:
        raise ValueError("Codex stream did not contain a provider thread identity")
    attestation = {
        "provider": "codex-cli",
        "thread_id_sha256": hashlib.sha256(thread_id.encode("utf-8")).hexdigest(),
        "output_sha256": hashlib.sha256(answer.encode("utf-8")).hexdigest(),
        "usage": usage,
    }
    return parsed, attestation


def _event_payload(older: TraceEvent, newer: TraceEvent) -> str:
    def visible(event: TraceEvent) -> dict[str, Any]:
        return {
            "event_id": event.event_id,
            "source": event.source,
            "kind": event.kind,
            "entity": event.entity,
            "sequence": event.sequence,
            "facts": event.facts,
            "text": event.text,
        }

    return json.dumps({"older_event": visible(older), "newer_event": visible(newer)}, ensure_ascii=False)


def _run_once(
    payload: str,
    model: str,
    runner: Runner,
    timeout_seconds: int,
    isolated_workspace: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    completed = runner(
        _codex_command(model, isolated_workspace),
        input=payload,
        text=True,
        capture_output=True,
        timeout=timeout_seconds,
        check=False,
    )
    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip().replace(os.path.expanduser("~"), "~")
        stderr_tail = stderr[-1200:] if stderr else "no stderr was returned"
        raise RuntimeError(
            f"Codex semantic run failed with exit {completed.returncode}: {stderr_tail}. "
            "Check `codex --version`, Codex login/model access, network access, and whether "
            "the local Codex state directory is writable."
        )
    parsed, attestation = _parse_codex_stream(completed.stdout)
    attestation["model"] = model
    return parsed, attestation


def _changes(raw: dict[str, Any], older_id: str, newer_id: str) -> list[dict[str, Any]]:
    value = raw.get("changes")
    if not isinstance(value, list):
        raise ValueError("semantic output changes must be an array")
    converted = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("each semantic change must be an object")
        converted.append(
            {
                "field": item.get("field"),
                "operation": item.get("operation"),
                "old_value": item.get("old_value"),
                "new_value": item.get("new_value"),
                "old_evidence": {"event_id": older_id, "quote": item.get("old_quote")},
                "new_evidence": {"event_id": newer_id, "quote": item.get("new_quote")},
            }
        )
    return converted


def _field_reviews(changes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "field": item.get("field"),
            "operation": item.get("operation"),
            "old_value": item.get("old_value"),
            "new_value": item.get("new_value"),
            "old_evidence": item.get("old_evidence"),
            "new_evidence": item.get("new_evidence"),
        }
        for item in changes
    ]


def _semantic_changes(changes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Compare semantic findings while allowing independently chosen quotes."""

    return [
        {
            "field": item.get("field"),
            "operation": item.get("operation"),
            "old_value": item.get("old_value"),
            "new_value": item.get("new_value"),
        }
        for item in changes
    ]


def run_two_pass_codex_analysis(
    events: list[TraceEvent],
    older_event_id: str,
    newer_event_id: str,
    *,
    model: str = DEFAULT_MODEL,
    runner: Runner = subprocess.run,
    timeout_seconds: int = 180,
) -> tuple[dict[str, Any], dict[str, Any]]:
    by_id = {event.event_id: event for event in events}
    older = by_id.get(older_event_id)
    newer = by_id.get(newer_event_id)
    if older is None or newer is None:
        raise ValueError("older and newer event IDs must exist in the trace")
    payload = _event_payload(older, newer)

    with tempfile.TemporaryDirectory(prefix="contextadapt-semantic-") as isolated_workspace:
        analyzer, analyzer_attestation = _run_once(
            payload, model, runner, timeout_seconds, isolated_workspace
        )
        reviewer, reviewer_attestation = _run_once(
            payload, model, runner, timeout_seconds, isolated_workspace
        )
    analyzer_run_id = "codex:" + analyzer_attestation["thread_id_sha256"]
    reviewer_run_id = "codex:" + reviewer_attestation["thread_id_sha256"]
    if analyzer_run_id == reviewer_run_id:
        raise RuntimeError("Codex returned the same run identity for analyzer and reviewer")

    analyzer_changes = _changes(analyzer, older_event_id, newer_event_id)
    reviewer_changes = _changes(reviewer, older_event_id, newer_event_id)
    proposal = {
        "schema_version": PROPOSAL_SCHEMA_VERSION,
        "proposal_id": "proposal:" + uuid.uuid4().hex,
        "analyzer_run_id": analyzer_run_id,
        "older_event_id": older_event_id,
        "newer_event_id": newer_event_id,
        "entity": analyzer.get("entity"),
        "relation": analyzer.get("relation"),
        "confidence": analyzer.get("confidence"),
        "changes": analyzer_changes,
        "unresolved_fields": analyzer.get("unresolved_fields", []),
        "run_attestation": analyzer_attestation,
    }

    comparable_analyzer = {
        "entity": analyzer.get("entity"),
        "relation": analyzer.get("relation"),
        "changes": _semantic_changes(analyzer_changes),
        "unresolved_fields": analyzer.get("unresolved_fields", []),
    }
    comparable_reviewer = {
        "entity": reviewer.get("entity"),
        "relation": reviewer.get("relation"),
        "changes": _semantic_changes(reviewer_changes),
        "unresolved_fields": reviewer.get("unresolved_fields", []),
    }
    agreement = comparable_analyzer == comparable_reviewer
    issues = [] if agreement else ["independent semantic runs did not produce the same field-level relation"]
    review = {
        "schema_version": REVIEW_SCHEMA_VERSION,
        "review_id": "review:" + uuid.uuid4().hex,
        "reviewer_run_id": reviewer_run_id,
        "proposal_id": proposal["proposal_id"],
        "proposal_sha256": canonical_digest(proposal),
        "verdict": "approve" if agreement else "revise",
        "confidence": reviewer.get("confidence"),
        "accepted_fields": [item["field"] for item in analyzer_changes] if agreement else [],
        "accepted_entity": analyzer.get("entity") if agreement else None,
        "accepted_relation": analyzer.get("relation") if agreement else None,
        "field_reviews": _field_reviews(reviewer_changes),
        "issues": issues,
        "run_attestation": reviewer_attestation,
    }
    return proposal, review
