"""Privacy-first adapter for the public ``codex exec --json`` event stream."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Iterable

from ..schema import TraceEvent


CODEX_ADAPTER_VERSION = "contextadapt.codex-exec.v1"


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _content_facts(prefix: str, value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return {
        f"{prefix}_chars": len(value),
        f"{prefix}_sha256": _digest(value),
    }


def _content_text(fields: dict[str, Any], include_content: bool) -> str:
    if not include_content:
        return ""
    present = {key: value for key, value in fields.items() if value is not None}
    return json.dumps(present, ensure_ascii=False, sort_keys=True)


def _safe_identifier_facts(name: str, value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    return {f"{name}_sha256": _digest(str(value))}


def _parse_source(lines: Iterable[str]) -> list[tuple[int, dict[str, Any]]]:
    parsed = []
    for line_number, raw in enumerate(lines, 1):
        stripped = raw.strip()
        if not stripped:
            continue
        try:
            value = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"invalid Codex JSON on line {line_number}: {exc.msg}; "
                "pass stdout from `codex exec --json`, not mixed stdout/stderr"
            ) from exc
        if not isinstance(value, dict) or not isinstance(value.get("type"), str):
            raise ValueError(f"Codex event on line {line_number} must be an object with a string type")
        parsed.append((line_number, value))
    if not parsed:
        raise ValueError("Codex event stream contains no events")
    return parsed


def convert_codex_exec(
    lines: Iterable[str],
    *,
    include_content: bool = False,
    instruction: str | None = None,
) -> list[TraceEvent]:
    """Convert public Codex CLI JSONL events into ``contextadapt.trace.v1``.

    Raw commands, outputs, messages, errors, thread IDs, and optional instruction
    text are replaced by length + SHA-256 fingerprints unless
    ``include_content`` is explicitly enabled. Fingerprints support local
    correlation but are not a guarantee of anonymity for guessable content.
    """

    source_events = _parse_source(lines)
    converted: list[TraceEvent] = []
    item_starts: dict[str, str] = {}
    turn_number = 0

    if instruction is not None:
        facts = {
            "adapter": CODEX_ADAPTER_VERSION,
            "content_redacted": not include_content,
            **_content_facts("instruction", instruction),
        }
        converted.append(
            TraceEvent(
                event_id="codex-000000-instruction",
                source="codex.user",
                kind="instruction",
                entity="codex:instruction",
                sequence=0,
                facts=facts,
                text=instruction if include_content else "",
            )
        )

    for ordinal, (line_number, raw_event) in enumerate(source_events, 1):
        upstream_type = raw_event["type"]
        event_id = f"codex-{ordinal:06d}"
        base_facts: dict[str, Any] = {
            "adapter": CODEX_ADAPTER_VERSION,
            "upstream_type": upstream_type,
            "upstream_line": line_number,
            "content_redacted": not include_content,
        }
        source = "codex.runtime"
        kind = "note"
        entity: str | None = None
        success: bool | None = None
        facts = dict(base_facts)
        links: dict[str, str] = {}
        text = ""

        if upstream_type == "thread.started":
            kind = "state"
            entity = "codex:thread"
            facts.update({"status": "started", **_safe_identifier_facts("thread_id", raw_event.get("thread_id"))})
        elif upstream_type == "turn.started":
            turn_number += 1
            kind = "state"
            entity = "codex:turn"
            facts.update({"status": "started", "turn_number": turn_number})
        elif upstream_type in {"turn.completed", "turn.failed"}:
            kind = "observation"
            entity = "codex:turn"
            success = upstream_type == "turn.completed"
            facts.update({"status": "completed" if success else "failed", "turn_number": turn_number})
            usage = raw_event.get("usage")
            if isinstance(usage, dict):
                facts["usage"] = {
                    str(key): value
                    for key, value in usage.items()
                    if isinstance(value, int) and not isinstance(value, bool)
                }
            error = raw_event.get("error")
            if error is not None:
                facts.update(_content_facts("error", error))
                text = _content_text({"error": error}, include_content)
        elif upstream_type.startswith("item."):
            item = raw_event.get("item")
            if not isinstance(item, dict):
                facts["malformed_item"] = True
            else:
                phase = upstream_type.split(".", 1)[1]
                item_type = str(item.get("type", "unknown"))
                item_id = str(item.get("id", ""))
                facts.update({"upstream_item_type": item_type, "phase": phase})
                facts.update(_safe_identifier_facts("item_id", item_id or None))
                if phase == "started" and item_id:
                    item_starts[item_id] = event_id
                elif item_id and item_id in item_starts:
                    links["started_event"] = item_starts[item_id]

                if item_type == "command_execution" and phase == "completed":
                    source = "codex.command"
                    kind = "action"
                    entity = "codex:command"
                    command = item.get("command")
                    output = item.get("aggregated_output")
                    facts.update(_content_facts("command", command))
                    facts.update(_content_facts("output", output))
                    facts["status"] = item.get("status")
                    facts["exit_code"] = item.get("exit_code")
                    if isinstance(item.get("exit_code"), int):
                        success = item["exit_code"] == 0
                    text = _content_text({"command": command, "output": output}, include_content)
                elif item_type in {"file_change", "mcp_tool_call", "web_search"} and phase == "completed":
                    source = f"codex.{item_type}"
                    kind = "action"
                    entity = f"codex:{item_type}"
                    sanitized = {key: value for key, value in item.items() if key not in {"id", "type"}}
                    facts.update(_content_facts("item_payload", sanitized))
                    text = _content_text({"item": sanitized}, include_content)
                elif item_type == "agent_message":
                    source = "codex.agent"
                    message = item.get("text")
                    facts.update(_content_facts("message", message))
                    text = _content_text({"message": message}, include_content)
                elif item_type == "error":
                    kind = "observation"
                    entity = "codex:error"
                    success = False
                    message = item.get("message")
                    facts.update(_content_facts("message", message))
                    text = _content_text({"message": message}, include_content)
                else:
                    sanitized = {key: value for key, value in item.items() if key not in {"id", "type"}}
                    facts.update(_content_facts("item_payload", sanitized))
                    text = _content_text({"item": sanitized}, include_content)
        else:
            payload = {key: value for key, value in raw_event.items() if key != "type"}
            facts.update(_content_facts("event_payload", payload))
            text = _content_text({"payload": payload}, include_content)

        converted.append(
            TraceEvent(
                event_id=event_id,
                source=source,
                kind=kind,
                entity=entity,
                sequence=ordinal,
                success=success,
                facts=facts,
                links=links,
                text=text,
            )
        )

    return converted
