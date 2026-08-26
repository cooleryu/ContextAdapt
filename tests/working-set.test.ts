import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildActiveWorkingSet,
  createReadOnlyRecoveryHandle,
} from "../packages/core/src/index.js";

test("active working set keeps desired changes separate from observed pre-action state", () => {
  const result = buildActiveWorkingSet({
    operative_user_task: {
      task_id: "task-current",
      target_resource: "production/config.json",
      desired_changes: { timeout: 60 },
      authorization: { edit_protected: false },
      preserve_fields: ["retries"],
    },
    latest_verified_environment_before_action: {
      observation_id: "observation-current",
      target_resource: "production/config.json",
      observed_values: { timeout: 45, retries: 3 },
      observed_at: "2026-08-24T00:00:00Z",
    },
    superseded_tasks_do_not_execute: [
      {
        task_id: "task-old",
        target_resource: "staging/config.json",
        desired_changes: { timeout: 30 },
      },
    ],
    recovery_handles: [
      createReadOnlyRecoveryHandle({
        evidence_id: "observation-current",
        target_resource: "production/config.json",
        content: '{"timeout":45,"retries":3}',
      }),
    ],
  });

  assert.equal(result.operative_user_task.desired_changes.timeout, 60);
  assert.equal(
    result.latest_verified_environment_before_action.observed_values.timeout,
    45,
  );
  assert.equal(
    result.superseded_tasks_do_not_execute[0]?.desired_changes.timeout,
    30,
  );
  assert.equal(result.recovery_handles[0]?.read_only, true);
  assert.match(result.recovery_handles[0]!.content_sha256, /^[a-f0-9]{64}$/);
});

test("active working set rejects a mismatched target and mutating recovery handle", () => {
  const base = {
    operative_user_task: {
      task_id: "task-current",
      target_resource: "production/config.json",
      desired_changes: { timeout: 60 },
      authorization: { edit_protected: false },
      preserve_fields: ["retries"],
    },
    latest_verified_environment_before_action: {
      observation_id: "observation-current",
      target_resource: "staging/config.json",
      observed_values: { timeout: 45 },
      observed_at: "2026-08-24T00:00:00Z",
    },
  };
  assert.throws(() => buildActiveWorkingSet(base), /same target resource/i);
  assert.throws(
    () =>
      buildActiveWorkingSet({
        ...base,
        latest_verified_environment_before_action: {
          ...base.latest_verified_environment_before_action,
          target_resource: "production/config.json",
        },
        recovery_handles: [
          {
            evidence_id: "observation-current",
            target_resource: "production/config.json",
            content_sha256: "a".repeat(64),
            read_only: false as true,
          },
        ],
      }),
    /read-only/i,
  );
});
