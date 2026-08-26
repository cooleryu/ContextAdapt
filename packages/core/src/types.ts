export const TRACE_SCHEMA_VERSION = "contextadapt.trace.v1" as const;
export const SNAPSHOT_SCHEMA_VERSION = "contextadapt.snapshot.v1" as const;

export const EVENT_KINDS = [
  "state",
  "observation",
  "action",
  "instruction",
  "policy",
  "note",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type Facts = Record<string, unknown>;

export interface ContextSpan {
  start_token: number;
  end_token: number;
}

export interface TraceEvent {
  event_id: string;
  source: string;
  kind: EventKind;
  entity: string | null;
  sequence: number | null;
  observed_at: string | null;
  success: boolean | null;
  facts: Facts;
  links: Record<string, string>;
  text: string;
  context_span?: ContextSpan;
}

export type RiskSeverity = "critical" | "high";

export interface Risk {
  type: string;
  severity: RiskSeverity;
  event_id: string;
  evidence: Record<string, unknown> & { reason: string };
}

export interface ContextSnapshot {
  schema_version: typeof SNAPSHOT_SCHEMA_VERSION;
  input_schema_version: typeof TRACE_SCHEMA_VERSION;
  trace_id: string;
  event_count: number;
  current_state: TraceEvent[];
  last_successful_observations: TraceEvent[];
  latest_failures: TraceEvent[];
  candidate_actions: TraceEvent[];
  superseded_events: TraceEvent[];
  notes: TraceEvent[];
  risks: Risk[];
  risk_summary: { total: number; critical: number; high: number };
  gate_evidence: {
    candidate_action_count: number;
    assessable_action_count: number;
  };
  gate_verdict?: "PASS" | "BLOCK" | "INSUFFICIENT_EVIDENCE";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
