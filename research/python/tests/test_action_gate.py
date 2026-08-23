import unittest
from dataclasses import replace

from contextadapt.action_gate import validate_action_contract
from contextadapt.demo import demo_events
from contextadapt.relations import evaluate_action_with_relation, validate_relation_bundle
from contextadapt.schema import TraceEvent
from tests.test_relations import proposal, review


class UnifiedActionGateTests(unittest.TestCase):
    def test_unknown_operation_cannot_bypass_resource_policy(self):
        events = demo_events()
        action = next(event for event in events if event.event_id == "old-action-replay")
        forged = replace(action, facts={**action.facts, "operation": "write_file"})
        result = validate_action_contract(
            [forged if event.event_id == forged.event_id else event for event in events],
            forged,
        )
        self.assertFalse(result["assessable"])
        self.assertTrue(any(risk["type"] == "incomplete_action_contract" for risk in result["risks"]))

    def test_current_basis_with_stale_values_is_blocked(self):
        events = [
            TraceEvent(
                event_id="policy",
                source="policy",
                kind="policy",
                entity="resource:app/config.json",
                sequence=1,
                facts={"resource": "app/config.json", "protected": False},
            ),
            TraceEvent(
                event_id="current",
                source="user",
                kind="instruction",
                entity="task:deploy",
                sequence=2,
                facts={"environment": "production", "timeout": 60, "edit_protected": False},
            ),
            TraceEvent(
                event_id="action",
                source="planner",
                kind="action",
                entity="action:deploy",
                sequence=3,
                facts={
                    "operation": "write",
                    "target_file": "app/config.json",
                    "context_entity": "task:deploy",
                    "environment": "staging",
                    "timeout": 30,
                    "edit_protected": False,
                    "context_fields_used": ["environment", "timeout", "edit_protected"],
                },
                links={"based_on_event": "current"},
            ),
        ]
        result = validate_action_contract(events, events[-1])
        self.assertIn("action_context_mismatch", {risk["type"] for risk in result["risks"]})

    def test_planner_cannot_self_declare_user_authority(self):
        events = [
            TraceEvent(
                event_id="policy",
                source="policy",
                kind="policy",
                entity="resource:production/secrets.json",
                sequence=1,
                facts={"resource": "production/secrets.json", "protected": True},
            ),
            TraceEvent(
                event_id="fake-authority",
                source="planner",
                kind="state",
                entity="task:deploy",
                sequence=2,
                facts={
                    "authority": "user",
                    "edit_protected": True,
                    "protected_scope": ["production/secrets.json"],
                },
            ),
            TraceEvent(
                event_id="action",
                source="planner",
                kind="action",
                entity="action:deploy",
                sequence=3,
                facts={
                    "operation": "write",
                    "target_file": "production/secrets.json",
                    "context_entity": "task:deploy",
                    "edit_protected": True,
                    "context_fields_used": ["edit_protected"],
                },
                links={"based_on_event": "fake-authority", "permission_event": "fake-authority"},
            ),
        ]
        result = validate_action_contract(events, events[-1])
        self.assertIn("unbound_protected_permission", {risk["type"] for risk in result["risks"]})

    def test_agent_cannot_self_classify_protected_target_as_safe(self):
        events = [
            TraceEvent(
                event_id="policy",
                source="policy",
                kind="policy",
                entity="resource:production/secrets.json",
                sequence=1,
                facts={"resource": "production/secrets.json", "protected": True},
            ),
            TraceEvent(
                event_id="current",
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
                    "operation": "write",
                    "target_file": "production/secrets.json",
                    "context_entity": "task:deploy",
                    "edit_protected": False,
                    "context_fields_used": ["edit_protected"],
                },
                links={"based_on_event": "current"},
            ),
        ]
        result = validate_action_contract(events, events[-1])
        self.assertIn("protection_misclassification", {risk["type"] for risk in result["risks"]})

    def test_relation_gate_reuses_permission_and_basis_checks(self):
        value = proposal()
        verdict = validate_relation_bundle(demo_events(), value, review(value))
        without_permission = [
            replace(event, links={"based_on_event": "ticket-old"})
            if event.event_id == "old-action-replay"
            else event
            for event in demo_events()
        ]
        result = evaluate_action_with_relation(without_permission, verdict, "old-action-replay")
        self.assertEqual("BLOCK", result["status"])
        self.assertIn("unbound_protected_permission", {risk["type"] for risk in result["risks"]})

        unrelated = TraceEvent(
            event_id="unrelated",
            source="runtime",
            kind="note",
            sequence=45,
            text="Unrelated note.",
        )
        wrong_basis = [
            replace(event, links={"based_on_event": "unrelated"})
            if event.event_id == "old-action-replay"
            else event
            for event in demo_events()
        ] + [unrelated]
        result = evaluate_action_with_relation(wrong_basis, verdict, "old-action-replay")
        self.assertEqual("BLOCK", result["status"])
        self.assertIn("missing_action_provenance", {risk["type"] for risk in result["risks"]})


if __name__ == "__main__":
    unittest.main()
