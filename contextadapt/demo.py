"""Built-in, zero-configuration product demo."""

from __future__ import annotations

from typing import Any

from .diagnose import diagnose_trace
from .schema import TraceEvent


DEMO_TRACE_ID = "stale-deploy-action"


def demo_events() -> list[TraceEvent]:
    """Return a minimal stale-action trace that also ships inside the wheel."""

    return [
        TraceEvent(
            event_id="policy-staging-config",
            source="policy",
            kind="policy",
            entity="resource:staging/config.json",
            sequence=5,
            facts={"resource": "staging/config.json", "protected": True},
            text="Host policy classifies staging/config.json as protected.",
        ),
        TraceEvent(
            event_id="ticket-old",
            source="user",
            kind="state",
            entity="ticket:deploy",
            sequence=10,
            facts={
                "environment": "staging",
                "timeout": 30,
                "edit_protected": True,
                "target_file": "staging/config.json",
                "authority": "user",
                "protected_scope": ["staging/config.json"],
            },
            text="Deploy staging/config.json in staging with timeout 30; protected edits are allowed for staging/config.json.",
        ),
        TraceEvent(
            event_id="read-prod-ok",
            source="read_file",
            kind="observation",
            entity="file:production/config.json",
            sequence=20,
            success=True,
            facts={"timeout": 45, "retries": 3},
            text="Successful production read.",
        ),
        TraceEvent(
            event_id="ticket-current",
            source="user",
            kind="state",
            entity="ticket:deploy",
            sequence=30,
            facts={
                "environment": "production",
                "timeout": 60,
                "edit_protected": False,
                "target_file": "production/config.json",
                "authority": "user",
                "protected_scope": [],
            },
            links={"replaces": "ticket-old"},
            text="Replace that plan: deploy production/config.json in production with timeout 60; protected edits are forbidden.",
        ),
        TraceEvent(
            event_id="read-prod-failed",
            source="read_file",
            kind="observation",
            entity="file:production/config.json",
            sequence=40,
            success=False,
            facts={"preview_retries": 1},
            text="Refresh failed; preview is unverified.",
        ),
        TraceEvent(
            event_id="old-action-replay",
            source="planner-replay",
            kind="action",
            entity="action:deploy",
            sequence=50,
            facts={
                "target_file": "staging/config.json",
                "operation": "write",
                "context_entity": "ticket:deploy",
                "environment": "staging",
                "timeout": 30,
                "retries": 8,
                "edit_protected": True,
                "context_fields_used": ["environment", "timeout", "edit_protected", "target_file"],
            },
            links={"based_on_event": "ticket-old", "permission_event": "ticket-old"},
            text="Delayed replay of a complete but stale action.",
        ),
        TraceEvent(
            event_id="user-current",
            source="user",
            kind="instruction",
            entity="request:active",
            sequence=60,
            facts={"request": "execute current production change and verify"},
            text="Continue with the current request.",
        ),
    ]


def demo_snapshot() -> dict[str, Any]:
    return diagnose_trace(demo_events(), DEMO_TRACE_ID)


def render_demo(snapshot: dict[str, Any]) -> str:
    """Explain the built-in scenario in product language, not schema language."""

    critical = snapshot["risk_summary"]["critical"]
    high = snapshot["risk_summary"]["high"]
    return "\n".join(
        [
            "ContextAdapt · stale Agent action caught before execution",
            "========================================================",
            "",
            "SCENARIO",
            "  An old staging task allowed a protected edit and timeout=30.",
            "  The user replaced it with production, timeout=60, no protected edits.",
            "  A delayed planner is now trying to replay the complete old action.",
            "",
            "CONTEXT TIMELINE",
            "  10  OLD      staging / timeout=30 / protected edit allowed",
            "  30  CURRENT  production / timeout=60 / protected edit forbidden",
            "  50  ACTION   staging/config.json / timeout=30 / protected edit",
            "",
            "VERDICT  BLOCK",
            f"  ! CRITICAL x{critical}  Protected edit has no current permission.",
            f"  ! HIGH     x{high}  Action was built from superseded context.",
            "",
            "RESULT",
            "  ContextAdapt recommends rebuilding the action from the current request",
            "  instead of executing a valid-looking but stale plan.",
            "",
            "This seven-event scenario is synthetic and deterministic.",
            "Use `python3 -m contextadapt demo --trace-out demo.jsonl` to inspect the evidence.",
            "Use `python3 -m contextadapt check TRACE.jsonl` to gate a structured Agent trace.",
            "",
        ]
    )
