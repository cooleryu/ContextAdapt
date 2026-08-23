import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from contextadapt.demo import demo_events, demo_snapshot
from contextadapt.schema import TraceEvent, dump_jsonl, load_jsonl


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples/stale-action.jsonl"


class ProductDemoTests(unittest.TestCase):
    def test_builtin_demo_matches_public_trace_and_has_two_real_risks(self):
        self.assertEqual(load_jsonl(EXAMPLE), demo_events())
        snapshot = demo_snapshot()
        self.assertEqual(2, snapshot["risk_summary"]["total"])
        self.assertEqual(1, snapshot["risk_summary"]["critical"])
        self.assertEqual(1, snapshot["risk_summary"]["high"])

    def test_demo_is_zero_configuration_and_explains_the_block(self):
        completed = subprocess.run(
            [sys.executable, "-m", "contextadapt", "demo"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertIn("VERDICT  BLOCK", completed.stdout)
        self.assertIn("OLD      staging", completed.stdout)
        self.assertIn("CURRENT  production", completed.stdout)
        self.assertIn("Protected edit has no current permission", completed.stdout)
        self.assertIn("synthetic and deterministic", completed.stdout)

    def test_demo_can_export_the_exact_trace(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "demo.jsonl"
            completed = subprocess.run(
                [sys.executable, "-m", "contextadapt", "demo", "--trace-out", str(output), "--format", "json"],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(0, completed.returncode, completed.stderr)
            self.assertEqual(2, json.loads(completed.stdout)["risk_summary"]["total"])
            self.assertEqual(demo_events(), load_jsonl(output))

    def test_check_blocks_the_stale_action_with_exit_two(self):
        completed = subprocess.run(
            [sys.executable, "-m", "contextadapt", "check", str(EXAMPLE)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(2, completed.returncode)
        self.assertIn("ContextAdapt check · BLOCK", completed.stdout)
        self.assertIn("Action was built from context that has been superseded", completed.stdout)

    def test_check_passes_a_current_non_protected_action(self):
        events = [
            TraceEvent(
                event_id="resource-policy",
                source="policy",
                kind="policy",
                entity="resource:app/config.json",
                sequence=5,
                facts={"resource": "app/config.json", "protected": False},
            ),
            TraceEvent(
                event_id="current-request",
                source="user",
                kind="instruction",
                entity="request:active",
                sequence=10,
                facts={"timeout": 60, "edit_protected": False},
            ),
            TraceEvent(
                event_id="current-action",
                source="planner",
                kind="action",
                entity="action:update-config",
                sequence=20,
                facts={
                    "operation": "write",
                    "target_file": "app/config.json",
                    "context_entity": "request:active",
                    "timeout": 60,
                    "edit_protected": False,
                    "context_fields_used": ["timeout", "edit_protected"],
                },
                links={"based_on_event": "current-request"},
            ),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            trace = Path(temporary) / "safe.jsonl"
            trace.write_text(dump_jsonl(events), encoding="utf-8")
            completed = subprocess.run(
                [sys.executable, "-m", "contextadapt", "check", str(trace)],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertIn("ContextAdapt check · PASS", completed.stdout)
        self.assertIn("does not block", completed.stdout)
        self.assertIn("not that an action is universally safe", completed.stdout)


if __name__ == "__main__":
    unittest.main()
