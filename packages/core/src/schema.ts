import { readFile } from "node:fs/promises";
import {
  EVENT_KINDS,
  type EventKind,
  type TraceEvent,
  isRecord,
} from "./types.js";
import { canonicalStringify } from "./json.js";

const allowedKinds = new Set<string>(EVENT_KINDS);

export function parseTraceEvent(
  value: unknown,
  lineNumber?: number,
): TraceEvent {
  const where = lineNumber === undefined ? "" : ` on line ${lineNumber}`;
  if (!isRecord(value)) throw new Error(`event${where} must be a JSON object`);
  const missing = ["event_id", "source", "kind"].filter(
    (key) => typeof value[key] !== "string" || value[key] === "",
  );
  if (missing.length > 0) {
    throw new Error(`missing required field(s)${where}: ${missing.join(", ")}`);
  }
  if (!allowedKinds.has(value.kind as string)) {
    throw new Error(
      `unsupported kind${where}: ${JSON.stringify(value.kind)}; expected one of ${[...allowedKinds].sort().join(", ")}`,
    );
  }
  if (
    value.sequence !== undefined &&
    value.sequence !== null &&
    !Number.isInteger(value.sequence)
  ) {
    throw new Error(`sequence must be an integer${where}`);
  }
  const facts = value.facts ?? {};
  const links = value.links ?? {};
  if (!isRecord(facts) || !isRecord(links)) {
    throw new Error(`facts and links must be objects${where}`);
  }
  if (
    value.success !== undefined &&
    value.success !== null &&
    typeof value.success !== "boolean"
  ) {
    throw new Error(`success must be a boolean${where}`);
  }
  const contextSpan = value.context_span;
  if (contextSpan !== undefined) {
    if (!isRecord(contextSpan)) {
      throw new Error(`context_span must be an object${where}`);
    }
    const unknown = Object.keys(contextSpan).filter(
      (key) => key !== "start_token" && key !== "end_token",
    );
    if (unknown.length > 0) {
      throw new Error(
        `context_span contains unsupported field(s)${where}: ${unknown.join(", ")}`,
      );
    }
    for (const key of ["start_token", "end_token"] as const) {
      if (!Number.isInteger(contextSpan[key]) || Number(contextSpan[key]) < 0) {
        throw new Error(
          `context_span.${key} must be a non-negative integer${where}`,
        );
      }
    }
    if (Number(contextSpan.start_token) > Number(contextSpan.end_token)) {
      throw new Error(
        `context_span.start_token must not exceed end_token${where}`,
      );
    }
  }
  return {
    event_id: String(value.event_id),
    source: String(value.source),
    kind: value.kind as EventKind,
    entity:
      value.entity === undefined || value.entity === null
        ? null
        : String(value.entity),
    sequence:
      value.sequence === undefined || value.sequence === null
        ? null
        : Number(value.sequence),
    observed_at:
      value.observed_at === undefined || value.observed_at === null
        ? null
        : String(value.observed_at),
    success:
      value.success === undefined || value.success === null
        ? null
        : value.success,
    facts: { ...facts },
    links: Object.fromEntries(
      Object.entries(links).map(([key, item]) => [String(key), String(item)]),
    ),
    text: String(value.text ?? ""),
    ...(contextSpan === undefined
      ? {}
      : {
          context_span: {
            start_token: Number(contextSpan.start_token),
            end_token: Number(contextSpan.end_token),
          },
        }),
  };
}

export function parseJsonl(input: string | Iterable<string>): TraceEvent[] {
  const lines = typeof input === "string" ? input.split(/\r?\n/) : [...input];
  const events: TraceEvent[] = [];
  const eventIds = new Set<string>();
  lines.forEach((raw, index) => {
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) return;
    let value: unknown;
    try {
      value = JSON.parse(stripped);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid JSON on line ${index + 1}: ${message}`);
    }
    const event = parseTraceEvent(value, index + 1);
    if (eventIds.has(event.event_id)) {
      throw new Error(
        `duplicate event_id on line ${index + 1}: ${event.event_id}`,
      );
    }
    eventIds.add(event.event_id);
    events.push(event);
  });
  if (events.length === 0) throw new Error("trace contains no events");
  return events;
}

export async function loadJsonl(path: string): Promise<TraceEvent[]> {
  return parseJsonl(await readFile(path, "utf8"));
}

export function dumpJsonl(events: Iterable<TraceEvent>): string {
  return [...events].map((event) => `${canonicalStringify(event)}\n`).join("");
}
