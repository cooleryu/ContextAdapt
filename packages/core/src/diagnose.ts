import {
  TRACE_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  type ContextSnapshot,
  type TraceEvent,
} from "./types.js";
import { validateActionContract } from "./action-gate.js";

const stateKinds = new Set(["state", "instruction", "policy"]);

function rank(event: TraceEvent, inputIndex: number): [number, string, number] {
  return [event.sequence ?? -1, event.observed_at ?? "", inputIndex];
}

function compareRank(
  left: [number, string, number],
  right: [number, string, number],
): number {
  return (
    left[0] - right[0] || left[1].localeCompare(right[1]) || left[2] - right[2]
  );
}

function selectLatest(
  events: Array<[number, TraceEvent]>,
): [TraceEvent, TraceEvent[]] {
  const ranked = [...events].sort((left, right) =>
    compareRank(rank(left[1], left[0]), rank(right[1], right[0])),
  );
  const current = ranked.at(-1)?.[1];
  if (!current) throw new Error("cannot select from an empty event group");
  return [current, ranked.slice(0, -1).map(([, event]) => event)];
}

function addGroup(
  map: Map<string, Array<[number, TraceEvent]>>,
  entity: string,
  item: [number, TraceEvent],
): void {
  const group = map.get(entity) ?? [];
  group.push(item);
  map.set(entity, group);
}

export function buildSnapshot(
  events: TraceEvent[],
  traceId = "trace",
): ContextSnapshot {
  const byId = new Map(events.map((event) => [event.event_id, event]));
  const stateGroups = new Map<string, Array<[number, TraceEvent]>>();
  const successGroups = new Map<string, Array<[number, TraceEvent]>>();
  const failureGroups = new Map<string, Array<[number, TraceEvent]>>();
  const actions: TraceEvent[] = [];
  const notes: TraceEvent[] = [];

  events.forEach((event, index) => {
    if (stateKinds.has(event.kind) && event.entity)
      addGroup(stateGroups, event.entity, [index, event]);
    else if (event.kind === "observation" && event.entity) {
      addGroup(
        event.success === true ? successGroups : failureGroups,
        event.entity,
        [index, event],
      );
    } else if (event.kind === "action") actions.push(event);
    else notes.push(event);
  });

  const currentState: TraceEvent[] = [];
  const superseded: TraceEvent[] = [];
  const currentEventIds = new Set<string>();
  const explicitlyReplacedIds = new Set(
    events
      .map((event) => event.links.replaces)
      .filter((eventId): eventId is string =>
        Boolean(eventId && byId.has(eventId)),
      ),
  );
  for (const entity of [...stateGroups.keys()].sort()) {
    const [current, older] = selectLatest(stateGroups.get(entity) ?? []);
    currentEventIds.add(current.event_id);
    currentState.push(current);
    superseded.push(...older);
  }

  const successful: TraceEvent[] = [];
  for (const entity of [...successGroups.keys()].sort()) {
    const [current, older] = selectLatest(successGroups.get(entity) ?? []);
    successful.push(current);
    superseded.push(...older);
  }

  const failures: TraceEvent[] = [];
  for (const entity of [...failureGroups.keys()].sort()) {
    const [current] = selectLatest(failureGroups.get(entity) ?? []);
    failures.push(current);
  }

  const risks = actions.flatMap((action) => {
    const actionRisks = [...validateActionContract(events, action).risks];
    const basedOn = action.links.based_on_event;
    const basis = basedOn ? byId.get(basedOn) : undefined;
    if (basis && basedOn && explicitlyReplacedIds.has(basedOn)) {
      actionRisks.push({
        type: "stale_action",
        severity: "high",
        event_id: action.event_id,
        evidence: {
          based_on_event: basedOn,
          based_on_entity: basis.entity,
          based_on_sequence: basis.sequence,
          reason:
            "action is based on an event that is no longer current for its entity",
        },
      });
    } else if (basis && basedOn && !currentEventIds.has(basedOn)) {
      actionRisks.push({
        type: "unresolved_context_relation",
        severity: "high",
        event_id: action.event_id,
        evidence: {
          based_on_event: basedOn,
          based_on_entity: basis.entity,
          based_on_sequence: basis.sequence,
          reason:
            "a newer event exists for this entity, but no validated relation says whether it replaces, narrows, or adds to the action basis",
        },
      });
    }
    return actionRisks;
  });

  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    input_schema_version: TRACE_SCHEMA_VERSION,
    trace_id: traceId,
    event_count: events.length,
    current_state: currentState,
    last_successful_observations: successful,
    latest_failures: failures,
    candidate_actions: actions,
    superseded_events: superseded,
    notes,
    risks,
    risk_summary: {
      total: risks.length,
      critical: risks.filter((item) => item.severity === "critical").length,
      high: risks.filter((item) => item.severity === "high").length,
    },
    gate_evidence: {
      candidate_action_count: actions.length,
      assessable_action_count: actions.filter(
        (action) => validateActionContract(events, action).assessable,
      ).length,
    },
  };
}

export const diagnoseTrace = buildSnapshot;
