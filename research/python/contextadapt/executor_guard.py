"""Bind reviewed context changes to actual pre-execution tool arguments."""

from __future__ import annotations

import json
import re
from pathlib import Path, PurePosixPath
from typing import Any

from .relations import canonical_digest, validate_relation_bundle
from .schema import TraceEvent


GUARD_SCHEMA_VERSION = "contextadapt.executor-guard.v1"
DECISION_SCHEMA_VERSION = "contextadapt.executor-decision.v1"
MUTATING_TOOLS = {
    "codex": {"apply_patch", "Bash"},
    "omp": {"write", "edit", "bash", "python", "notebook"},
}
OPAQUE_OMP_MUTATORS = {"python", "notebook"}
SHELL_MUTATION_RE = re.compile(
    r"(?:^|[;&|]\s*)(?:rm|mv|cp|install|truncate|tee|sed\s+-i|perl\s+-i|chmod|chown)\b|(?:>>?|2>)",
    re.IGNORECASE,
)
SIMPLE_READ_ONLY_SHELL_RE = re.compile(
    r"^\s*(?:cat|head|tail|ls|pwd|rg|grep|find|stat|wc|"
    r"git\s+(?:status|diff|log|show))(?:\s+[^;&|<>]*)?\s*$",
    re.IGNORECASE,
)


def compile_executor_guard(
    events: list[TraceEvent],
    proposal: dict[str, Any],
    review: dict[str, Any],
) -> dict[str, Any]:
    """Compile an accepted semantic relation into a deterministic tool guard."""

    verdict = validate_relation_bundle(events, proposal, review)
    if verdict["status"] != "ACCEPTED":
        raise ValueError("executor guard requires an ACCEPTED context relation")
    by_id = {event.event_id: event for event in events}
    older = by_id.get(verdict["older_event_id"])
    current = by_id.get(verdict["newer_event_id"])
    if older is None or current is None:
        raise ValueError("accepted relation events are missing")
    if older.source not in {"user", "policy"} or current.source not in {"user", "policy"}:
        raise ValueError("executor guard requires host-trusted user/policy relation events")

    changes = [
        {
            "field": change["field"],
            "old_value": change["old_value"],
            "current_value": change["new_value"],
        }
        for change in verdict["accepted_changes"]
    ]
    protected_resources = sorted(
        {
            str(event.facts["resource"])
            for event in events
            if event.kind == "policy"
            and event.source == "policy"
            and event.facts.get("protected") is True
            and isinstance(event.facts.get("resource"), str)
        }
    )
    relation_digest = canonical_digest(proposal)
    return {
        "schema_version": GUARD_SCHEMA_VERSION,
        "guard_id": f"guard:{relation_digest[:16]}",
        "relation_sha256": relation_digest,
        "entity": verdict["entity"],
        "older_event_id": older.event_id,
        "current_event_id": current.event_id,
        "changes": changes,
        "protected_resources": protected_resources,
        "scope": {
            "codex_tools": sorted(MUTATING_TOOLS["codex"]),
            "omp_tools": sorted(MUTATING_TOOLS["omp"]),
        },
        "boundary": (
            "Guards actual arguments for the listed file/shell tools. Other tool paths remain outside v0.1 scope."
        ),
    }


def load_executor_guard(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schema_version") != GUARD_SCHEMA_VERSION:
        raise ValueError("unsupported executor guard schema")
    changes = value.get("changes")
    if not isinstance(changes, list) or not changes:
        raise ValueError("executor guard must contain changes")
    return value


def _canonical_target(raw: str, cwd: str | None) -> str:
    normalized = raw.replace("\\", "/").strip()
    if cwd:
        cwd_normalized = cwd.replace("\\", "/").rstrip("/")
        if normalized.startswith(cwd_normalized + "/"):
            normalized = normalized[len(cwd_normalized) + 1 :]
    return str(PurePosixPath(normalized)).removeprefix("./")


def _patch_targets(command: str, cwd: str | None) -> list[str]:
    targets = []
    for match in re.finditer(r"^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$", command, re.MULTILINE):
        targets.append(_canonical_target(match.group(1), cwd))
    return targets


def _tool_view(host: str, payload: dict[str, Any], guard: dict[str, Any]) -> dict[str, Any]:
    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input")
    cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) else None
    if not isinstance(tool_name, str) or not isinstance(tool_input, dict):
        raise ValueError("hook payload requires tool_name and object tool_input")
    if tool_name not in MUTATING_TOOLS.get(host, set()):
        return {"in_scope": False, "tool_name": tool_name, "targets": [], "content": ""}

    if host == "omp" and tool_name in OPAQUE_OMP_MUTATORS:
        return {
            "in_scope": True,
            "tool_name": tool_name,
            "targets": [],
            "content": json.dumps(tool_input, ensure_ascii=False, sort_keys=True),
        }

    targets: list[str] = []
    content_parts: list[str] = []
    if host == "codex" and tool_name == "apply_patch":
        command = tool_input.get("command")
        if isinstance(command, str):
            targets = _patch_targets(command, cwd)
            content_parts.append(command)
    elif tool_name in {"write", "edit"}:
        raw_path = tool_input.get("path")
        if isinstance(raw_path, str):
            targets = [_canonical_target(raw_path, cwd)]
        for key in ("content", "patch", "newText", "new_string", "oldText", "old_string"):
            value = tool_input.get(key)
            if isinstance(value, str):
                content_parts.append(value)
    else:
        command = tool_input.get("command")
        if isinstance(command, str):
            content_parts.append(command)
            if SIMPLE_READ_ONLY_SHELL_RE.fullmatch(command):
                return {"in_scope": False, "tool_name": tool_name, "targets": [], "content": command}
            candidates = {
                str(change["old_value"])
                for change in guard["changes"]
                if change.get("field") == "target_file"
            } | {
                str(change["current_value"])
                for change in guard["changes"]
                if change.get("field") == "target_file"
            } | set(guard.get("protected_resources", []))
            targets = [_canonical_target(path, cwd) for path in candidates if path and path in command]
            has_changed_value = any(
                _value_pattern(str(change["field"]), change.get(value_key)).search(command)
                for change in guard["changes"]
                if isinstance(change.get("field"), str)
                for value_key in ("old_value", "current_value")
            )
            if not SHELL_MUTATION_RE.search(command) and not targets and not has_changed_value:
                return {"in_scope": False, "tool_name": tool_name, "targets": [], "content": command}
    return {
        "in_scope": True,
        "tool_name": tool_name,
        "targets": sorted(set(targets)),
        "content": "\n".join(content_parts),
    }


def _value_pattern(field: str, value: Any) -> re.Pattern[str]:
    rendered = json.dumps(value, ensure_ascii=False)
    alternatives = {rendered}
    if isinstance(value, str):
        alternatives.add(value)
        alternatives.add(json.dumps(value, ensure_ascii=False)[1:-1])
    elif isinstance(value, bool):
        alternatives.add(str(value).lower())
        alternatives.add(str(value))
    else:
        alternatives.add(str(value))
    value_expr = "(?:" + "|".join(re.escape(item) for item in sorted(alternatives, key=len, reverse=True)) + ")"
    return re.compile(rf"[\"']?{re.escape(field)}[\"']?\s*[:=]\s*[\"']?{value_expr}[\"']?", re.IGNORECASE)


def evaluate_executor_call(host: str, payload: dict[str, Any], guard: dict[str, Any]) -> dict[str, Any]:
    """Evaluate native Codex/OMP hook input before the tool executes."""

    if host not in MUTATING_TOOLS:
        raise ValueError("host must be codex or omp")
    if guard.get("schema_version") != GUARD_SCHEMA_VERSION:
        raise ValueError("unsupported executor guard schema")
    view = _tool_view(host, payload, guard)
    reasons: list[str] = []
    matched_changes: list[str] = []
    if not view["in_scope"]:
        return {
            "schema_version": DECISION_SCHEMA_VERSION,
            "decision": "ALLOW",
            "guard_id": guard.get("guard_id"),
            "reasons": ["tool is outside this guard's declared v0.1 scope"],
            "tool": view,
        }
    if not view["targets"]:
        return {
            "schema_version": DECISION_SCHEMA_VERSION,
            "decision": "BLOCK",
            "guard_id": guard.get("guard_id"),
            "reasons": ["mutating tool call does not expose a guarded target; refusing to guess"],
            "tool": view,
        }

    target_change = next((change for change in guard["changes"] if change.get("field") == "target_file"), None)
    if target_change:
        old_target = _canonical_target(str(target_change["old_value"]), None)
        current_target = _canonical_target(str(target_change["current_value"]), None)
        if old_target != current_target and old_target in view["targets"]:
            reasons.append(f"tool targets stale path {old_target!r}; current reviewed path is {current_target!r}")
            matched_changes.append("target_file")

    protected = {_canonical_target(str(path), None) for path in guard.get("protected_resources", [])}
    current_protection = next(
        (change["current_value"] for change in guard["changes"] if change.get("field") == "edit_protected"),
        None,
    )
    for target in view["targets"]:
        if target in protected and current_protection is False:
            reasons.append(f"current reviewed context forbids editing protected target {target!r}")
            matched_changes.append("edit_protected")

    content = view["content"]
    for change in guard["changes"]:
        field = change.get("field")
        if field in {"target_file", "edit_protected"} or not isinstance(field, str):
            continue
        old_value = change.get("old_value")
        current_value = change.get("current_value")
        if old_value == current_value:
            continue
        if _value_pattern(field, old_value).search(content) and not _value_pattern(field, current_value).search(content):
            reasons.append(
                f"tool arguments use stale {field}={old_value!r}; current reviewed value is {current_value!r}"
            )
            matched_changes.append(field)

    return {
        "schema_version": DECISION_SCHEMA_VERSION,
        "decision": "BLOCK" if reasons else "ALLOW",
        "guard_id": guard.get("guard_id"),
        "reasons": reasons or ["actual tool arguments do not conflict with the reviewed current context"],
        "matched_changes": sorted(set(matched_changes)),
        "tool": view,
    }


def codex_hook_output(decision: dict[str, Any]) -> dict[str, Any] | None:
    if decision["decision"] != "BLOCK":
        return None
    reason = "ContextAdapt blocked this tool call: " + "; ".join(decision["reasons"])
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }
