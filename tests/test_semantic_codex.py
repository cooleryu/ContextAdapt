import json
import subprocess
import sys
import unittest
from pathlib import Path

from contextadapt.demo import demo_events
from contextadapt.relations import validate_relation_bundle
from contextadapt.semantic_codex import run_two_pass_codex_analysis


def semantic_answer(timeout=60):
    return {
        "entity": "ticket:deploy",
        "relation": "partial_supersession",
        "confidence": 0.96,
        "changes": [
            {
                "field": "environment",
                "operation": "replace",
                "old_value": "staging",
                "new_value": "production",
                "old_quote": "staging",
                "new_quote": "production",
            },
            {
                "field": "timeout",
                "operation": "replace",
                "old_value": 30,
                "new_value": timeout,
                "old_quote": "timeout 30",
                "new_quote": "timeout 60",
            },
            {
                "field": "edit_protected",
                "operation": "deny",
                "old_value": True,
                "new_value": False,
                "old_quote": "protected edits are allowed",
                "new_quote": "protected edits are forbidden",
            },
        ],
        "unresolved_fields": [],
    }


def stream(thread_id, answer):
    return "\n".join(
        [
            json.dumps({"type": "thread.started", "thread_id": thread_id}),
            json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": json.dumps(answer)}}),
            json.dumps({"type": "turn.completed", "usage": {"input_tokens": 100, "output_tokens": 50}}),
        ]
    )


class SemanticCodexTests(unittest.TestCase):
    def test_missing_provider_thread_identity_fails_closed(self):
        answer = json.dumps(semantic_answer())
        output_stream = "\n".join(
            [
                json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": answer}}),
                json.dumps({"type": "turn.completed", "usage": {"input_tokens": 10}}),
            ]
        )

        def runner(*args, **kwargs):
            return subprocess.CompletedProcess(args[0], 0, stdout=output_stream, stderr="")

        with self.assertRaisesRegex(ValueError, "provider thread identity"):
            run_two_pass_codex_analysis(demo_events(), "ticket-old", "ticket-current", runner=runner)

    def test_incomplete_provider_turn_fails_closed(self):
        output_stream = "\n".join(
            [
                json.dumps({"type": "thread.started", "thread_id": "thread-a"}),
                json.dumps(
                    {
                        "type": "item.completed",
                        "item": {"type": "agent_message", "text": json.dumps(semantic_answer())},
                    }
                ),
            ]
        )

        def runner(*args, **kwargs):
            return subprocess.CompletedProcess(args[0], 0, stdout=output_stream, stderr="")

        with self.assertRaisesRegex(ValueError, "completed turn"):
            run_two_pass_codex_analysis(demo_events(), "ticket-old", "ticket-current", runner=runner)

    def test_host_launches_two_runs_and_attaches_provider_identities(self):
        outputs = [stream("thread-a", semantic_answer()), stream("thread-b", semantic_answer())]
        commands = []

        def runner(*args, **kwargs):
            commands.append(args[0])
            return subprocess.CompletedProcess(args[0], 0, outputs.pop(0), "")

        proposal, review = run_two_pass_codex_analysis(
            demo_events(), "ticket-old", "ticket-current", runner=runner
        )
        self.assertNotEqual(proposal["analyzer_run_id"], review["reviewer_run_id"])
        self.assertEqual("codex-cli", proposal["run_attestation"]["provider"])
        self.assertEqual("approve", review["verdict"])
        self.assertEqual("ACCEPTED", validate_relation_bundle(demo_events(), proposal, review)["status"])
        self.assertEqual(2, len(commands))
        self.assertTrue(all("--ignore-rules" in command for command in commands))
        self.assertTrue(all("--cd" in command for command in commands))
        self.assertEqual(commands[0][commands[0].index("--cd") + 1], commands[1][commands[1].index("--cd") + 1])

    def test_failed_codex_run_exposes_bounded_diagnostic(self):
        def runner(*args, **kwargs):
            return subprocess.CompletedProcess(args[0], 1, "", "state database is read only")

        with self.assertRaisesRegex(RuntimeError, "state database is read only"):
            run_two_pass_codex_analysis(demo_events(), "ticket-old", "ticket-current", runner=runner)

    def test_independent_disagreement_never_auto_accepts(self):
        outputs = [stream("thread-a", semantic_answer()), stream("thread-b", semantic_answer(timeout=61))]

        def runner(*args, **kwargs):
            return subprocess.CompletedProcess(args[0], 0, outputs.pop(0), "")

        proposal, review = run_two_pass_codex_analysis(
            demo_events(), "ticket-old", "ticket-current", runner=runner
        )
        self.assertEqual("revise", review["verdict"])
        self.assertNotEqual("ACCEPTED", validate_relation_bundle(demo_events(), proposal, review)["status"])

    def test_cli_requires_explicit_remote_content_consent(self):
        root = Path(__file__).resolve().parents[1]
        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "contextadapt",
                "analyze-codex",
                str(root / "examples" / "stale-action.jsonl"),
                "ticket-old",
                "ticket-current",
            ],
            cwd=root,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(1, completed.returncode)
        self.assertIn("--allow-remote-content", completed.stderr)


if __name__ == "__main__":
    unittest.main()
