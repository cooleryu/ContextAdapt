"""Public JSONL trace schema used by the ContextAdapt MVP."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = "contextadapt.trace.v1"
ALLOWED_KINDS = {"state", "observation", "action", "instruction", "policy", "note"}


@dataclass(frozen=True)
class TraceEvent:
    event_id: str
    source: str
    kind: str
    entity: str | None = None
    sequence: int | None = None
    observed_at: str | None = None
    success: bool | None = None
    facts: dict[str, Any] = field(default_factory=dict)
    links: dict[str, str] = field(default_factory=dict)
    text: str = ""

    @classmethod
    def from_dict(cls, value: dict[str, Any], line_number: int | None = None) -> "TraceEvent":
        where = f" on line {line_number}" if line_number is not None else ""
        missing = [key for key in ("event_id", "source", "kind") if not value.get(key)]
        if missing:
            raise ValueError(f"missing required field(s){where}: {', '.join(missing)}")
        kind = value["kind"]
        if kind not in ALLOWED_KINDS:
            raise ValueError(f"unsupported kind{where}: {kind!r}; expected one of {sorted(ALLOWED_KINDS)}")
        sequence = value.get("sequence")
        if sequence is not None and (isinstance(sequence, bool) or not isinstance(sequence, int)):
            raise ValueError(f"sequence must be an integer{where}")
        facts = value.get("facts", {})
        links = value.get("links", {})
        if not isinstance(facts, dict) or not isinstance(links, dict):
            raise ValueError(f"facts and links must be objects{where}")
        return cls(
            event_id=str(value["event_id"]),
            source=str(value["source"]),
            kind=kind,
            entity=str(value["entity"]) if value.get("entity") is not None else None,
            sequence=sequence,
            observed_at=str(value["observed_at"]) if value.get("observed_at") is not None else None,
            success=value.get("success"),
            facts=facts,
            links={str(key): str(item) for key, item in links.items()},
            text=str(value.get("text", "")),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "source": self.source,
            "kind": self.kind,
            "entity": self.entity,
            "sequence": self.sequence,
            "observed_at": self.observed_at,
            "success": self.success,
            "facts": self.facts,
            "links": self.links,
            "text": self.text,
        }


def parse_jsonl(lines: Iterable[str]) -> list[TraceEvent]:
    events = []
    event_ids = set()
    for line_number, raw in enumerate(lines, 1):
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        try:
            value = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid JSON on line {line_number}: {exc.msg}") from exc
        if not isinstance(value, dict):
            raise ValueError(f"event on line {line_number} must be a JSON object")
        event = TraceEvent.from_dict(value, line_number)
        if event.event_id in event_ids:
            raise ValueError(f"duplicate event_id on line {line_number}: {event.event_id}")
        event_ids.add(event.event_id)
        events.append(event)
    if not events:
        raise ValueError("trace contains no events")
    return events


def load_jsonl(path: Path) -> list[TraceEvent]:
    with path.open(encoding="utf-8") as handle:
        return parse_jsonl(handle)


def dump_jsonl(events: Iterable[TraceEvent]) -> str:
    """Serialize events as canonical, UTF-8 friendly JSONL."""

    return "".join(
        json.dumps(event.to_dict(), ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
        for event in events
    )
