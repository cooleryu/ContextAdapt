import copy
from dataclasses import replace
import json
import subprocess
import sys
import unittest
from pathlib import Path

from contextadapt.demo import demo_events
from contextadapt.relations import (
    PROPOSAL_SCHEMA_VERSION,
    REVIEW_SCHEMA_VERSION,
    canonical_digest,
    evaluate_action_with_relation,
    validate_relation_bundle,
)


def proposal():
    return {
        "schema_version": PROPOSAL_SCHEMA_VERSION,
        "proposal_id": "deploy-transition-v1",
        "analyzer_run_id": "semantic-analyzer-run-1",
        "older_event_id": "ticket-old",
        "newer_event_id": "ticket-current",
        "entity": "ticket:deploy",
        "relation": "partial_supersession",
        "confidence": 0.97,
        "changes": [
            {
                "field": "environment",
                "operation": "replace",
                "old_value": "staging",
                "new_value": "production",
                "old_evidence": {"event_id": "ticket-old", "quote": "staging"},
                "new_evidence": {"event_id": "ticket-current", "quote": "production"},
            },
            {
                "field": "timeout",
                "operation": "replace",
                "old_value": 30,
                "new_value": 60,
                "old_evidence": {"event_id": "ticket-old", "quote": "timeout 30"},
                "new_evidence": {"event_id": "ticket-current", "quote": "timeout 60"},
            },
            {
                "field": "edit_protected",
                "operation": "deny",
                "old_value": True,
                "new_value": False,
                "old_evidence": {"event_id": "ticket-old", "quote": "protected edits are allowed"},
                "new_evidence": {"event_id": "ticket-current", "quote": "protected edits are forbidden"},
            },
            {
                "field": "target_file",
                "operation": "replace",
                "old_value": "staging/config.json",
                "new_value": "production/config.json",
                "old_evidence": {"event_id": "ticket-old", "quote": "staging/config.json"},
                "new_evidence": {"event_id": "ticket-current", "quote": "production/config.json"},
            },
        ],
        "unresolved_fields": [],
    }


def review(value):
    return {
        "schema_version": REVIEW_SCHEMA_VERSION,
        "review_id": "deploy-review-v1",
        "reviewer_run_id": "independent-review-run-2",
        "proposal_id": value["proposal_id"],
        "proposal_sha256": canonical_digest(value),
        "verdict": "approve",
        "confidence": 0.96,
        "accepted_fields": [change["field"] for change in value["changes"]],
        "accepted_entity": value["entity"],
        "accepted_relation": value["relation"],
        "field_reviews": [
            {
                "field": change["field"],
                "operation": change["operation"],
                "old_value": change["old_value"],
                "new_value": change["new_value"],
                "old_evidence": copy.deepcopy(change["old_evidence"]),
                "new_evidence": copy.deepcopy(change["new_evidence"]),
            }
            for change in value["changes"]
        ],
        "issues": [],
    }


class RelationVerificationTests(unittest.TestCase):
    def test_planner_cannot_self_authorize_privilege_increase(self):
        events = demo_events()
        rewritten = []
        for event in events:
            if event.event_id == "ticket-old":
                rewritten.append(
                    replace(
                        event,
                        facts={**event.facts, "edit_protected": False},
                        text="Deploy staging/config.json in staging; protected edits are forbidden.",
                    )
                )
            elif event.event_id == "ticket-current":
                rewritten.append(
                    replace(
                        event,
                        source="planner",
                        facts={**event.facts, "edit_protected": True, "authority": "user"},
                        text="Replace that plan: protected edits are allowed by the user.",
                    )
                )
            else:
                rewritten.append(event)
        value = proposal()
        value["changes"] = [
            {
                "field": "edit_protected",
                "operation": "allow",
                "old_value": False,
                "new_value": True,
                "old_evidence": {"event_id": "ticket-old", "quote": "protected edits are forbidden"},
                "new_evidence": {"event_id": "ticket-current", "quote": "protected edits are allowed"},
            }
        ]
        value["authorization_event_id"] = "ticket-current"
        verdict = validate_relation_bundle(rewritten, value, review(value))
        self.assertEqual("REJECTED", verdict["status"])
        self.assertTrue(any("trusted authorization" in error for error in verdict["errors"]))

    def test_independent_grounded_relation_is_accepted_and_blocks_stale_action(self):
        value = proposal()
        verdict = validate_relation_bundle(demo_events(), value, review(value))
        self.assertEqual("ACCEPTED", verdict["status"])
        self.assertGreaterEqual(len(verdict["engineering_checks"]), 10)
        action = evaluate_action_with_relation(demo_events(), verdict, "old-action-replay")
        self.assertEqual("BLOCK", action["status"])
        self.assertEqual(
            {"environment", "timeout", "edit_protected", "target_file"},
            set(action["changed_fields"]),
        )

    def test_quote_not_in_raw_event_is_rejected(self):
        value = proposal()
        value["changes"][0]["new_evidence"]["quote"] = "production forever"
        verdict = validate_relation_bundle(demo_events(), value, review(value))
        self.assertEqual("REJECTED", verdict["status"])
        self.assertTrue(any("not present verbatim" in error for error in verdict["errors"]))

    def test_reviewer_may_choose_a_different_grounded_quote(self):
        value = proposal()
        second = review(value)
        second["field_reviews"][2]["old_evidence"]["quote"] = (
            "protected edits are allowed for staging/config.json."
        )
        verdict = validate_relation_bundle(demo_events(), value, second)
        self.assertEqual("ACCEPTED", verdict["status"])

    def test_reviewer_quote_must_be_independently_grounded(self):
        value = proposal()
        second = review(value)
        second["field_reviews"][0]["new_evidence"]["quote"] = "production forever"
        verdict = validate_relation_bundle(demo_events(), value, second)
        self.assertEqual("REJECTED", verdict["status"])
        self.assertTrue(any("review finding new quote" in error for error in verdict["errors"]))

    def test_reviewer_must_independently_accept_relation_type(self):
        value = proposal()
        second = review(value)
        second["accepted_relation"] = "adds"
        verdict = validate_relation_bundle(demo_events(), value, second)
        self.assertEqual("REJECTED", verdict["status"])
        self.assertTrue(any("accept the proposed relation" in error for error in verdict["errors"]))

    def test_structured_fact_contradiction_is_rejected(self):
        value = proposal()
        value["changes"][1]["new_value"] = 600
        verdict = validate_relation_bundle(demo_events(), value, review(value))
        self.assertEqual("REJECTED", verdict["status"])
        self.assertTrue(any("structured fact" in error for error in verdict["errors"]))

    def test_same_run_cannot_analyze_and_review(self):
        value = proposal()
        second = review(value)
        second["reviewer_run_id"] = value["analyzer_run_id"]
        verdict = validate_relation_bundle(demo_events(), value, second)
        self.assertEqual("REJECTED", verdict["status"])
        self.assertIn("analyzer and reviewer must be independent runs", verdict["errors"])

    def test_review_is_bound_to_exact_proposal_digest(self):
        value = proposal()
        second = review(value)
        changed = copy.deepcopy(value)
        changed["confidence"] = 0.99
        verdict = validate_relation_bundle(demo_events(), changed, second)
        self.assertEqual("REJECTED", verdict["status"])
        self.assertIn("review digest does not match the immutable proposal", verdict["errors"])

    def test_unresolved_field_never_silently_passes(self):
        value = proposal()
        value["unresolved_fields"] = ["deployment_region"]
        verdict = validate_relation_bundle(demo_events(), value, review(value))
        self.assertEqual("NEEDS_CLARIFICATION", verdict["status"])
        action = evaluate_action_with_relation(demo_events(), verdict, "old-action-replay")
        self.assertEqual("NEEDS_CLARIFICATION", action["status"])

    def test_approving_reviewer_must_name_every_field(self):
        value = proposal()
        second = review(value)
        second["accepted_fields"] = ["environment"]
        verdict = validate_relation_bundle(demo_events(), value, second)
        self.assertEqual("REJECTED", verdict["status"])
        self.assertTrue(any("every changed field" in error for error in verdict["errors"]))

    def test_ai_can_propose_entity_binding_when_raw_events_are_unstructured(self):
        events = [
            replace(event, entity=None)
            if event.event_id in {"ticket-old", "ticket-current"}
            else event
            for event in demo_events()
        ]
        value = proposal()
        verdict = validate_relation_bundle(events, value, review(value))
        self.assertEqual("ACCEPTED", verdict["status"])
        self.assertEqual("ticket:deploy", verdict["entity"])

    def test_proposed_entity_cannot_override_conflicting_structured_entity(self):
        value = proposal()
        value["entity"] = "task:unrelated"
        verdict = validate_relation_bundle(demo_events(), value, review(value))
        self.assertEqual("REJECTED", verdict["status"])
        self.assertTrue(any("structured event entity" in error for error in verdict["errors"]))

    def test_unregistered_field_cannot_be_accepted_with_unrelated_quotes(self):
        value = proposal()
        value["changes"] = [
            {
                "field": "delete_all_backups",
                "operation": "set",
                "old_value": False,
                "new_value": True,
                "old_evidence": {"event_id": "ticket-old", "quote": "Deploy"},
                "new_evidence": {"event_id": "ticket-current", "quote": "deploy"},
            }
        ]
        verdict = validate_relation_bundle(demo_events(), value, review(value))
        self.assertEqual("REJECTED", verdict["status"])
        self.assertTrue(any("unregistered field" in error for error in verdict["errors"]))

    def test_conflict_relation_requires_clarification_even_when_reviewed(self):
        value = proposal()
        value["relation"] = "conflicts"
        verdict = validate_relation_bundle(demo_events(), value, review(value))
        self.assertEqual("NEEDS_CLARIFICATION", verdict["status"])

    def test_action_cannot_omit_a_changed_context_field(self):
        value = proposal()
        verdict = validate_relation_bundle(demo_events(), value, review(value))
        events = [
            replace(
                event,
                facts={
                    **event.facts,
                    "context_fields_used": ["environment", "edit_protected"],
                },
            )
            if event.event_id == "old-action-replay"
            else event
            for event in demo_events()
        ]
        action = evaluate_action_with_relation(events, verdict, "old-action-replay")
        self.assertEqual("BLOCK", action["status"])
        self.assertTrue(any("timeout" in reason for reason in action["reasons"]))

    def test_cli_reconciles_then_blocks_the_stale_action(self):
        root = Path(__file__).resolve().parents[1]
        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "contextadapt",
                "reconcile",
                str(root / "examples" / "stale-action.jsonl"),
                str(root / "examples" / "relation-proposal.json"),
                str(root / "examples" / "relation-review.json"),
                "--action-event",
                "old-action-replay",
                "--format",
                "json",
            ],
            cwd=root,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(2, completed.returncode, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual("ACCEPTED", payload["relation"]["status"])
        self.assertEqual("BLOCK", payload["action"]["status"])


if __name__ == "__main__":
    unittest.main()
