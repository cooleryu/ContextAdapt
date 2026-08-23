import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from contextadapt.diagnose import build_snapshot
from contextadapt.schema import TraceEvent, load_jsonl, parse_jsonl


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples/stale-action.jsonl"


class ContextAdaptMVPTests(unittest.TestCase):
    def test_snapshot_selects_current_state_and_separates_failed_preview(self):
        snapshot = build_snapshot(load_jsonl(EXAMPLE), "example")
        ticket = next(event for event in snapshot["current_state"] if event["entity"] == "ticket:deploy")
        successful = next(event for event in snapshot["last_successful_observations"] if event["entity"] == "file:production/config.json")
        failure = next(event for event in snapshot["latest_failures"] if event["entity"] == "file:production/config.json")
        self.assertEqual(30, ticket["sequence"])
        self.assertEqual(3, successful["facts"]["retries"])
        self.assertEqual(1, failure["facts"]["preview_retries"])

    def test_snapshot_detects_stale_action_and_unbound_permission(self):
        snapshot = build_snapshot(load_jsonl(EXAMPLE), "example")
        self.assertEqual({"stale_action", "unbound_protected_permission"}, {risk["type"] for risk in snapshot["risks"]})
        self.assertEqual(1, snapshot["risk_summary"]["critical"])
        self.assertEqual(1, snapshot["risk_summary"]["high"])

    def test_newer_event_without_validated_relation_is_not_called_supersession(self):
        events = [
            TraceEvent(
                event_id="resource-policy",
                source="policy",
                kind="policy",
                entity="resource:app/config.json",
                sequence=0,
                facts={"resource": "app/config.json", "protected": False},
            ),
            TraceEvent(
                event_id="old",
                source="user",
                kind="instruction",
                entity="task:deploy",
                sequence=1,
                facts={"edit_protected": False},
            ),
            TraceEvent(
                event_id="new",
                source="user",
                kind="instruction",
                entity="task:deploy",
                sequence=2,
                facts={"edit_protected": False},
            ),
            TraceEvent(
                event_id="action",
                source="planner",
                kind="action",
                entity="action:deploy",
                sequence=3,
                facts={
                    "operation": "deploy",
                    "target_file": "app/config.json",
                    "context_entity": "task:deploy",
                    "edit_protected": False,
                    "context_fields_used": ["edit_protected"],
                },
                links={"based_on_event": "old"},
            ),
        ]
        snapshot = build_snapshot(events)
        self.assertEqual(["unresolved_context_relation"], [risk["type"] for risk in snapshot["risks"]])
        self.assertEqual(0, snapshot["risk_summary"]["critical"])
        self.assertEqual(1, snapshot["risk_summary"]["high"])

    def test_current_explicit_denial_cannot_authorize_protected_edit(self):
        events = [
            TraceEvent(
                event_id="resource-policy",
                source="policy",
                kind="policy",
                entity="resource:production/secrets.json",
                sequence=0,
                facts={"resource": "production/secrets.json", "protected": True},
            ),
            TraceEvent(
                event_id="current",
                source="user",
                kind="instruction",
                entity="task:deploy",
                sequence=1,
                facts={"edit_protected": False},
            ),
            TraceEvent(
                event_id="action",
                source="planner",
                kind="action",
                entity="action:deploy",
                sequence=2,
                facts={
                    "operation": "write",
                    "target_file": "production/secrets.json",
                    "context_entity": "task:deploy",
                    "edit_protected": True,
                    "context_fields_used": ["edit_protected"],
                },
                links={"based_on_event": "current", "permission_event": "current"},
            ),
        ]
        snapshot = build_snapshot(events)
        self.assertEqual(
            {"action_context_mismatch", "unbound_protected_permission"},
            {risk["type"] for risk in snapshot["risks"]},
        )

    def test_missing_action_basis_and_protection_assessment_fail_closed(self):
        events = [
            TraceEvent(
                event_id="action",
                source="planner",
                kind="action",
                entity="action:deploy",
                sequence=1,
                text="Edit the protected production file using an old plan.",
            )
        ]
        snapshot = build_snapshot(events)
        self.assertEqual(
            {"incomplete_action_contract", "missing_action_provenance"},
            {risk["type"] for risk in snapshot["risks"]},
        )

    def test_schema_rejects_duplicate_ids(self):
        line = json.dumps({"event_id": "same", "source": "tool", "kind": "note"})
        with self.assertRaisesRegex(ValueError, "duplicate event_id"):
            parse_jsonl([line, line])

    def test_cli_json_and_fail_on_risk(self):
        completed = subprocess.run(
            [sys.executable, "-m", "contextadapt", "diagnose", str(EXAMPLE), "--format", "json", "--fail-on-risk"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(2, completed.returncode)
        payload = json.loads(completed.stdout)
        self.assertEqual("contextadapt.snapshot.v1", payload["schema_version"])
        self.assertEqual(2, payload["risk_summary"]["total"])


if __name__ == "__main__":
    unittest.main()
