import { createHash } from "node:crypto";
import { canonicalStringify, type TraceEvent } from "../../core/src/index.js";

export const CODEX_ADAPTER_VERSION = "contextadapt.codex-exec.v1";
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function contentFacts(prefix: string, value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  const rendered =
    typeof value === "string" ? value : canonicalStringify(value);
  return {
    [`${prefix}_chars`]: rendered.length,
    [`${prefix}_sha256`]: digest(rendered),
  };
}

function contentText(
  fields: Record<string, unknown>,
  include: boolean,
): string {
  if (!include) return "";
  return canonicalStringify(
    Object.fromEntries(
      Object.entries(fields).filter(
        ([, value]) => value !== null && value !== undefined,
      ),
    ),
  );
}

function safeId(name: string, value: unknown): Record<string, unknown> {
  return value === null || value === undefined
    ? {}
    : { [`${name}_sha256`]: digest(String(value)) };
}

function parseSource(
  lines: Iterable<string>,
): Array<[number, Record<string, unknown>]> {
  const parsed: Array<[number, Record<string, unknown>]> = [];
  let lineNumber = 0;
  for (const raw of lines) {
    lineNumber += 1;
    if (!raw.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `invalid Codex JSON on line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}; pass stdout from codex exec --json, not mixed stdout/stderr`,
      );
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as Record<string, unknown>).type !== "string"
    )
      throw new Error(
        `Codex event on line ${lineNumber} must be an object with a string type`,
      );
    parsed.push([lineNumber, value as Record<string, unknown>]);
  }
  if (parsed.length === 0)
    throw new Error("Codex event stream contains no events");
  return parsed;
}

export function convertCodexExec(
  lines: Iterable<string>,
  options: { includeContent?: boolean; instruction?: string } = {},
): TraceEvent[] {
  const include = options.includeContent ?? false;
  const converted: TraceEvent[] = [];
  const starts = new Map<string, string>();
  let turn = 0;
  if (options.instruction !== undefined)
    converted.push({
      event_id: "codex-000000-instruction",
      source: "codex.user",
      kind: "instruction",
      entity: "codex:instruction",
      sequence: 0,
      observed_at: null,
      success: null,
      facts: {
        adapter: CODEX_ADAPTER_VERSION,
        content_redacted: !include,
        ...contentFacts("instruction", options.instruction),
      },
      links: {},
      text: include ? options.instruction : "",
    });
  for (const [index, [line, raw]] of parseSource(lines).entries()) {
    const ordinal = index + 1;
    const upstream = String(raw.type);
    const eventId = `codex-${String(ordinal).padStart(6, "0")}`;
    let source = "codex.runtime",
      kind: TraceEvent["kind"] = "note",
      entity: string | null = null,
      success: boolean | null = null,
      text = "";
    const facts: Record<string, unknown> = {
      adapter: CODEX_ADAPTER_VERSION,
      upstream_type: upstream,
      upstream_line: line,
      content_redacted: !include,
    };
    const links: Record<string, string> = {};
    if (upstream === "thread.started") {
      kind = "state";
      entity = "codex:thread";
      Object.assign(facts, {
        status: "started",
        ...safeId("thread_id", raw.thread_id),
      });
    } else if (upstream === "turn.started") {
      turn += 1;
      kind = "state";
      entity = "codex:turn";
      Object.assign(facts, { status: "started", turn_number: turn });
    } else if (["turn.completed", "turn.failed"].includes(upstream)) {
      kind = "observation";
      entity = "codex:turn";
      success = upstream === "turn.completed";
      Object.assign(facts, {
        status: success ? "completed" : "failed",
        turn_number: turn,
      });
      if (
        typeof raw.usage === "object" &&
        raw.usage !== null &&
        !Array.isArray(raw.usage)
      )
        facts.usage = Object.fromEntries(
          Object.entries(raw.usage).filter(
            ([, v]) => typeof v === "number" && Number.isInteger(v),
          ),
        );
      if (raw.error !== undefined) {
        Object.assign(facts, contentFacts("error", raw.error));
        text = contentText({ error: raw.error }, include);
      }
    } else if (upstream.startsWith("item.")) {
      const item = raw.item;
      if (typeof item !== "object" || item === null || Array.isArray(item))
        facts.malformed_item = true;
      else {
        const typed = item as Record<string, unknown>;
        const phase = upstream.split(".", 2)[1] ?? "";
        const itemType = String(typed.type ?? "unknown");
        const itemId = String(typed.id ?? "");
        Object.assign(facts, {
          upstream_item_type: itemType,
          phase,
          ...safeId("item_id", itemId || null),
        });
        if (phase === "started" && itemId) starts.set(itemId, eventId);
        else if (itemId && starts.has(itemId))
          links.started_event = starts.get(itemId)!;
        if (itemType === "command_execution" && phase === "completed") {
          source = "codex.command";
          kind = "action";
          entity = "codex:command";
          Object.assign(
            facts,
            contentFacts("command", typed.command),
            contentFacts("output", typed.aggregated_output),
            { status: typed.status, exit_code: typed.exit_code },
          );
          if (
            typeof typed.exit_code === "number" &&
            Number.isInteger(typed.exit_code)
          )
            success = typed.exit_code === 0;
          text = contentText(
            { command: typed.command, output: typed.aggregated_output },
            include,
          );
        } else if (
          ["file_change", "mcp_tool_call", "web_search"].includes(itemType) &&
          phase === "completed"
        ) {
          source = `codex.${itemType}`;
          kind = "action";
          entity = `codex:${itemType}`;
          const payload = Object.fromEntries(
            Object.entries(typed).filter(
              ([key]) => !["id", "type"].includes(key),
            ),
          );
          Object.assign(facts, contentFacts("item_payload", payload));
          text = contentText({ item: payload }, include);
        } else if (itemType === "agent_message") {
          source = "codex.agent";
          Object.assign(facts, contentFacts("message", typed.text));
          text = contentText({ message: typed.text }, include);
        } else if (itemType === "error") {
          kind = "observation";
          entity = "codex:error";
          success = false;
          Object.assign(facts, contentFacts("message", typed.message));
          text = contentText({ message: typed.message }, include);
        } else {
          const payload = Object.fromEntries(
            Object.entries(typed).filter(
              ([key]) => !["id", "type"].includes(key),
            ),
          );
          Object.assign(facts, contentFacts("item_payload", payload));
          text = contentText({ item: payload }, include);
        }
      }
    } else {
      const payload = Object.fromEntries(
        Object.entries(raw).filter(([key]) => key !== "type"),
      );
      Object.assign(facts, contentFacts("event_payload", payload));
      text = contentText({ payload }, include);
    }
    converted.push({
      event_id: eventId,
      source,
      kind,
      entity,
      sequence: ordinal,
      observed_at: null,
      success,
      facts,
      links,
      text,
    });
  }
  return converted;
}
