import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from contextadapt.demo import demo_events
from contextadapt.executor_guard import compile_executor_guard, evaluate_executor_call


ROOT = Path(__file__).resolve().parents[1]


def bundle():
    proposal = json.loads((ROOT / "examples" / "relation-proposal.json").read_text(encoding="utf-8"))
    review = json.loads((ROOT / "examples" / "relation-review.json").read_text(encoding="utf-8"))
    return proposal, review


class ExecutorGuardTests(unittest.TestCase):
    def setUp(self):
        proposal, review = bundle()
        self.guard = compile_executor_guard(demo_events(), proposal, review)

    def test_guard_is_compiled_from_accepted_relation(self):
        self.assertEqual("contextadapt.executor-guard.v1", self.guard["schema_version"])
        self.assertEqual("ticket-current", self.guard["current_event_id"])
        self.assertEqual(
            {"environment", "timeout", "edit_protected", "target_file"},
            {change["field"] for change in self.guard["changes"]},
        )

    def test_codex_apply_patch_to_stale_target_is_blocked(self):
        decision = evaluate_executor_call(
            "codex",
            {
                "tool_name": "apply_patch",
                "tool_input": {
                    "command": (
                        "*** Begin Patch\n*** Update File: staging/config.json\n@@\n"
                        "- {\"timeout\": 10}\n+ {\"timeout\": 30}\n*** End Patch"
                    )
                },
                "cwd": "/tmp/lab",
            },
            self.guard,
        )
        self.assertEqual("BLOCK", decision["decision"])
        self.assertIn("target_file", decision["matched_changes"])
        self.assertIn("edit_protected", decision["matched_changes"])

    def test_codex_current_patch_is_allowed(self):
        decision = evaluate_executor_call(
            "codex",
            {
                "tool_name": "apply_patch",
                "tool_input": {
                    "command": (
                        "*** Begin Patch\n*** Update File: production/config.json\n@@\n"
                        "- {\"environment\": \"staging\", \"timeout\": 10}\n"
                        "+ {\"environment\": \"production\", \"timeout\": 60}\n*** End Patch"
                    )
                },
                "cwd": "/tmp/lab",
            },
            self.guard,
        )
        self.assertEqual("ALLOW", decision["decision"])

    def test_omp_write_uses_the_same_guard(self):
        blocked = evaluate_executor_call(
            "omp",
            {
                "tool_name": "write",
                "tool_input": {
                    "path": "staging/config.json",
                    "content": '{"environment":"staging","timeout":30}',
                },
            },
            self.guard,
        )
        allowed = evaluate_executor_call(
            "omp",
            {
                "tool_name": "write",
                "tool_input": {
                    "path": "production/config.json",
                    "content": '{"environment":"production","timeout":60}',
                },
            },
            self.guard,
        )
        self.assertEqual("BLOCK", blocked["decision"])
        self.assertEqual("ALLOW", allowed["decision"])

    def test_mutating_call_without_target_fails_closed(self):
        decision = evaluate_executor_call(
            "codex",
            {"tool_name": "apply_patch", "tool_input": {"command": "not a patch"}},
            self.guard,
        )
        self.assertEqual("BLOCK", decision["decision"])

    def test_read_only_shell_call_is_out_of_scope_not_blocked(self):
        decision = evaluate_executor_call(
            "codex",
            {"tool_name": "Bash", "tool_input": {"command": "cat staging/config.json"}},
            self.guard,
        )
        self.assertEqual("ALLOW", decision["decision"])

    def test_shell_script_cannot_hide_a_guarded_stale_target(self):
        decision = evaluate_executor_call(
            "omp",
            {
                "tool_name": "bash",
                "tool_input": {
                    "command": (
                        "python3 -c 'open(\"staging/config.json\",\"w\").write("
                        "\"timeout=30\")'"
                    )
                },
            },
            self.guard,
        )
        self.assertEqual("BLOCK", decision["decision"])
        self.assertIn("target_file", decision["matched_changes"])

    def test_opaque_omp_mutators_fail_closed(self):
        for tool_name in ("python", "notebook"):
            with self.subTest(tool_name=tool_name):
                decision = evaluate_executor_call(
                    "omp",
                    {"tool_name": tool_name, "tool_input": {"code": "print('hello')"}},
                    self.guard,
                )
                self.assertEqual("BLOCK", decision["decision"])

    def test_cli_compiles_policy_and_emits_native_codex_deny(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            policy = Path(temp_dir) / "guard.json"
            compiled = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "contextadapt",
                    "compile-guard",
                    str(ROOT / "examples" / "stale-action.jsonl"),
                    str(ROOT / "examples" / "relation-proposal.json"),
                    str(ROOT / "examples" / "relation-review.json"),
                    "--output",
                    str(policy),
                ],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(0, compiled.returncode, compiled.stderr)
            payload = {
                "tool_name": "apply_patch",
                "tool_input": {"command": "*** Begin Patch\n*** Update File: staging/config.json\n*** End Patch"},
            }
            checked = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "contextadapt",
                    "executor-hook",
                    "codex",
                    "--policy",
                    str(policy),
                    "--format",
                    "native",
                ],
                cwd=ROOT,
                input=json.dumps(payload),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(0, checked.returncode, checked.stderr)
            native = json.loads(checked.stdout)
            self.assertEqual("deny", native["hookSpecificOutput"]["permissionDecision"])


if __name__ == "__main__":
    unittest.main()
