import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from contextadapt.adapters.codex_exec import CODEX_ADAPTER_VERSION, convert_codex_exec
from contextadapt.schema import dump_jsonl, load_jsonl, parse_jsonl


ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "examples/codex-exec.raw.jsonl"
GOLDEN = ROOT / "examples/codex-exec.trace.jsonl"
PRIVATE_VALUES = (
    "example-secret",
    "/workspace/private-project",
    "private-user@example.test",
    "demo-thread-123",
)


class CodexAdapterTests(unittest.TestCase):
    def test_default_conversion_redacts_all_raw_content_and_identifiers(self):
        events = convert_codex_exec(RAW.read_text(encoding="utf-8").splitlines())
        rendered = dump_jsonl(events)
        self.assertEqual(6, len(events))
        for private_value in PRIVATE_VALUES:
            self.assertNotIn(private_value, rendered)
        self.assertTrue(all(event.facts["content_redacted"] for event in events))

        command = next(event for event in events if event.source == "codex.command")
        self.assertEqual("action", command.kind)
        self.assertTrue(command.success)
        self.assertEqual(0, command.facts["exit_code"])
        self.assertEqual("codex-000003", command.links["started_event"])
        self.assertEqual("", command.text)

    def test_include_content_is_explicit_and_preserves_evidence(self):
        events = convert_codex_exec(
            RAW.read_text(encoding="utf-8").splitlines(),
            include_content=True,
            instruction="Inspect the private workspace",
        )
        rendered = dump_jsonl(events)
        self.assertIn("example-secret", rendered)
        self.assertIn("Inspect the private workspace", rendered)
        self.assertEqual("instruction", events[0].kind)
        self.assertFalse(events[0].facts["content_redacted"])

    def test_golden_trace_matches_adapter_output_and_schema(self):
        converted = convert_codex_exec(RAW.read_text(encoding="utf-8").splitlines())
        self.assertEqual(GOLDEN.read_text(encoding="utf-8"), dump_jsonl(converted))
        self.assertEqual(6, len(load_jsonl(GOLDEN)))
        self.assertTrue(all(event.facts["adapter"] == CODEX_ADAPTER_VERSION for event in converted))

    def test_cli_import_then_diagnose(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "trace.jsonl"
            imported = subprocess.run(
                [sys.executable, "-m", "contextadapt", "import-codex", str(RAW), "--output", str(output)],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(0, imported.returncode, imported.stderr)
            diagnosed = subprocess.run(
                [sys.executable, "-m", "contextadapt", "diagnose", str(output), "--format", "json"],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(0, diagnosed.returncode, diagnosed.stderr)
            self.assertEqual(6, json.loads(diagnosed.stdout)["event_count"])

    def test_imported_trace_without_action_provenance_never_reports_pass(self):
        completed = subprocess.run(
            [sys.executable, "-m", "contextadapt", "check", str(GOLDEN)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(2, completed.returncode)
        self.assertIn("INSUFFICIENT_EVIDENCE", completed.stdout)
        self.assertIn("do not execute", completed.stdout)

    def test_rejects_mixed_stderr_and_json(self):
        with self.assertRaisesRegex(ValueError, "not mixed stdout/stderr"):
            convert_codex_exec(["warning from stderr", '{"type":"turn.started"}'])

    def test_unknown_event_is_forward_compatible_and_redacted(self):
        events = convert_codex_exec(['{"type":"future.event","secret":"do-not-leak"}'])
        self.assertEqual("note", events[0].kind)
        self.assertNotIn("do-not-leak", dump_jsonl(events))
        self.assertEqual(1, len(parse_jsonl(dump_jsonl(events).splitlines())))


if __name__ == "__main__":
    unittest.main()
