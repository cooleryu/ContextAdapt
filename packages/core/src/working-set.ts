import { createHash } from "node:crypto";

export const ACTIVE_WORKING_SET_SCHEMA_VERSION =
  "contextadapt.active-working-set.v1" as const;

export interface OperativeUserTask {
  task_id: string;
  target_resource: string;
  desired_changes: Record<string, unknown>;
  authorization: Record<string, boolean>;
  preserve_fields: string[];
}

export interface VerifiedEnvironmentObservation {
  observation_id: string;
  target_resource: string;
  observed_values: Record<string, unknown>;
  observed_at: string;
}

export interface SupersededTask {
  task_id: string;
  target_resource: string;
  desired_changes: Record<string, unknown>;
}

export interface ReadOnlyRecoveryHandle {
  evidence_id: string;
  target_resource: string;
  content_sha256: string;
  read_only: true;
}

export interface ActiveWorkingSet {
  schema_version: typeof ACTIVE_WORKING_SET_SCHEMA_VERSION;
  operative_user_task: OperativeUserTask;
  latest_verified_environment_before_action: VerifiedEnvironmentObservation;
  superseded_tasks_do_not_execute: SupersededTask[];
  recovery_handles: ReadOnlyRecoveryHandle[];
}

function required(value: string, where: string): string {
  if (!value.trim()) throw new Error(`${where} must not be empty`);
  return value;
}

function assertRecord(
  value: Record<string, unknown>,
  where: string,
): Record<string, unknown> {
  if (Object.keys(value).length === 0) {
    throw new Error(`${where} must not be empty`);
  }
  return value;
}

/**
 * Build the model-visible active working set without collapsing an intended
 * change into the latest observed pre-action value.
 *
 * The separation is deliberate: `desired_changes.timeout = 60` and
 * `observed_values.timeout = 45` describe a valid pending change, not a
 * contradiction to resolve by choosing either value heuristically.
 */
export function buildActiveWorkingSet(input: {
  operative_user_task: OperativeUserTask;
  latest_verified_environment_before_action: VerifiedEnvironmentObservation;
  superseded_tasks_do_not_execute?: SupersededTask[];
  recovery_handles?: ReadOnlyRecoveryHandle[];
}): ActiveWorkingSet {
  const task = input.operative_user_task;
  const observation = input.latest_verified_environment_before_action;
  required(task.task_id, "operative_user_task.task_id");
  required(task.target_resource, "operative_user_task.target_resource");
  assertRecord(task.desired_changes, "operative_user_task.desired_changes");
  required(
    observation.observation_id,
    "latest_verified_environment_before_action.observation_id",
  );
  required(
    observation.target_resource,
    "latest_verified_environment_before_action.target_resource",
  );
  assertRecord(
    observation.observed_values,
    "latest_verified_environment_before_action.observed_values",
  );
  if (task.target_resource !== observation.target_resource) {
    throw new Error(
      "operative task and verified environment observation must bind to the same target resource",
    );
  }
  const recoveryHandles = input.recovery_handles ?? [];
  for (const [index, handle] of recoveryHandles.entries()) {
    required(handle.evidence_id, `recovery_handles[${index}].evidence_id`);
    required(
      handle.target_resource,
      `recovery_handles[${index}].target_resource`,
    );
    if (handle.read_only !== true) {
      throw new Error(`recovery_handles[${index}] must be read-only`);
    }
    if (!/^[a-f0-9]{64}$/i.test(handle.content_sha256)) {
      throw new Error(
        `recovery_handles[${index}].content_sha256 must be a SHA-256 digest`,
      );
    }
  }
  return {
    schema_version: ACTIVE_WORKING_SET_SCHEMA_VERSION,
    operative_user_task: structuredClone(task),
    latest_verified_environment_before_action: structuredClone(observation),
    superseded_tasks_do_not_execute: structuredClone(
      input.superseded_tasks_do_not_execute ?? [],
    ),
    recovery_handles: structuredClone(recoveryHandles),
  };
}

export function createReadOnlyRecoveryHandle(input: {
  evidence_id: string;
  target_resource: string;
  content: string;
}): ReadOnlyRecoveryHandle {
  return {
    evidence_id: required(input.evidence_id, "evidence_id"),
    target_resource: required(input.target_resource, "target_resource"),
    content_sha256: createHash("sha256").update(input.content).digest("hex"),
    read_only: true,
  };
}
