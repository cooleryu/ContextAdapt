import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  canonicalDigest,
  PROPOSAL_SCHEMA_VERSION,
  REVIEW_SCHEMA_VERSION,
  type TraceEvent,
} from "../../core/src/index.js";

export const DEFAULT_MODEL = "gpt-5.6-luna";
export const SYSTEM_PROMPT = `You are one independent semantic context analyst.
Compare exactly two raw Agent-context events supplied on stdin.
Return exactly one JSON object and no Markdown.

Required keys:
- entity: normalized task/resource identity string
- relation: supersedes | partial_supersession | narrows | adds | conflicts
- confidence: number from 0 to 1
- changes: array of objects with field, operation, old_value, new_value, old_quote, new_quote
- unresolved_fields: array of field names

Allowed fields and types:
- environment: string; replace or set
- timeout: integer; replace or set
- edit_protected: boolean; deny, allow, or set
- target_file: string; replace or set

Every quote must be a non-empty verbatim substring of the corresponding event text.
Do not create a field or value that is not supported by the raw text or structured facts.
Do not silently carry ambiguous values forward; list them in unresolved_fields.
Treat a permission increase as unresolved unless the newer event is an explicit user/policy authorization.
`;

export type CodexRunner = (
  command: string,
  args: string[],
  options: { input: string; timeout: number; cwd: string },
) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr">;
const defaultRunner: CodexRunner = (command, args, options) =>
  spawnSync(command, args, {
    input: options.input,
    timeout: options.timeout,
    cwd: options.cwd,
    encoding: "utf8",
  });
const sha = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function parseObject(text: string): Record<string, unknown> {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const value: unknown = JSON.parse(stripped);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("semantic model output must be one JSON object");
  return value as Record<string, unknown>;
}

export function parseCodexSemanticStream(stdout: string): {
  answer: Record<string, unknown>;
  attestation: Record<string, unknown>;
} {
  let rawAnswer = "",
    threadId = "",
    completed = false;
  let usage: Record<string, number> = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "thread.started")
      threadId = String(event.thread_id ?? "");
    if (event.type === "turn.completed") {
      completed = true;
      if (
        typeof event.usage === "object" &&
        event.usage !== null &&
        !Array.isArray(event.usage)
      )
        usage = Object.fromEntries(
          Object.entries(event.usage).filter(
            ([, value]) => typeof value === "number" && Number.isInteger(value),
          ),
        ) as Record<string, number>;
    }
    const item = event.item;
    if (
      event.type === "item.completed" &&
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === "agent_message"
    )
      rawAnswer = String((item as Record<string, unknown>).text ?? "");
  }
  if (!rawAnswer)
    throw new Error("Codex stream did not contain an Agent JSON answer");
  if (!completed)
    throw new Error("Codex stream did not contain a completed turn");
  if (!threadId)
    throw new Error("Codex stream did not contain a provider thread identity");
  return {
    answer: parseObject(rawAnswer),
    attestation: {
      provider: "codex-cli",
      thread_id_sha256: sha(threadId),
      output_sha256: sha(rawAnswer),
      usage,
    },
  };
}

function eventPayload(older: TraceEvent, newer: TraceEvent): string {
  const visible = (event: TraceEvent) => ({
    event_id: event.event_id,
    source: event.source,
    kind: event.kind,
    entity: event.entity,
    sequence: event.sequence,
    facts: event.facts,
    text: event.text,
  });
  return JSON.stringify({
    older_event: visible(older),
    newer_event: visible(newer),
  });
}

function changes(
  raw: Record<string, unknown>,
  olderId: string,
  newerId: string,
): Array<Record<string, unknown>> {
  if (!Array.isArray(raw.changes))
    throw new Error("semantic output changes must be an array");
  return raw.changes.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new Error("each semantic change must be an object");
    const c = item as Record<string, unknown>;
    return {
      field: c.field,
      operation: c.operation,
      old_value: c.old_value,
      new_value: c.new_value,
      old_evidence: { event_id: olderId, quote: c.old_quote },
      new_evidence: { event_id: newerId, quote: c.new_quote },
    };
  });
}

function semanticShape(items: Array<Record<string, unknown>>): unknown {
  return items.map(({ field, operation, old_value, new_value }) => ({
    field,
    operation,
    old_value,
    new_value,
  }));
}
function fieldReviews(items: Array<Record<string, unknown>>): unknown {
  return items.map(
    ({
      field,
      operation,
      old_value,
      new_value,
      old_evidence,
      new_evidence,
    }) => ({
      field,
      operation,
      old_value,
      new_value,
      old_evidence,
      new_evidence,
    }),
  );
}

export function runTwoPassCodexAnalysis(
  events: TraceEvent[],
  olderId: string,
  newerId: string,
  options: { model?: string; timeoutMs?: number; runner?: CodexRunner } = {},
): { proposal: Record<string, unknown>; review: Record<string, unknown> } {
  const byId = new Map(events.map((event) => [event.event_id, event]));
  const older = byId.get(olderId),
    newer = byId.get(newerId);
  if (!older || !newer)
    throw new Error("older and newer event IDs must exist in the trace");
  const model = options.model ?? DEFAULT_MODEL,
    runner = options.runner ?? defaultRunner,
    timeout = options.timeoutMs ?? 180_000,
    payload = eventPayload(older, newer);
  const workspace = mkdtempSync(join(tmpdir(), "contextadapt-semantic-"));
  const run = (): {
    answer: Record<string, unknown>;
    attestation: Record<string, unknown>;
  } => {
    const result = runner(
      "codex",
      [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--strict-config",
        "--model",
        model,
        "-c",
        'model_reasoning_effort="medium"',
        "--sandbox",
        "read-only",
        "--cd",
        workspace,
        "--json",
        SYSTEM_PROMPT,
      ],
      { input: payload, timeout, cwd: workspace },
    );
    if (result.status !== 0) {
      const diagnostic = (result.stderr || "no stderr was returned")
        .trim()
        .replaceAll(homedir(), "~")
        .slice(-1200);
      throw new Error(
        `Codex semantic run failed with exit ${result.status}: ${diagnostic}. Check Codex login, model access, network access, and local state permissions.`,
      );
    }
    const parsed = parseCodexSemanticStream(result.stdout);
    parsed.attestation.model = model;
    return parsed;
  };
  let analyzer, reviewer;
  try {
    analyzer = run();
    reviewer = run();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  const analyzerId = `codex:${String(analyzer.attestation.thread_id_sha256)}`,
    reviewerId = `codex:${String(reviewer.attestation.thread_id_sha256)}`;
  if (analyzerId === reviewerId)
    throw new Error(
      "Codex returned the same run identity for analyzer and reviewer",
    );
  const analyzerChanges = changes(analyzer.answer, olderId, newerId),
    reviewerChanges = changes(reviewer.answer, olderId, newerId);
  const proposal: Record<string, unknown> = {
    schema_version: PROPOSAL_SCHEMA_VERSION,
    proposal_id: `proposal:${randomUUID().replaceAll("-", "")}`,
    analyzer_run_id: analyzerId,
    older_event_id: olderId,
    newer_event_id: newerId,
    entity: analyzer.answer.entity,
    relation: analyzer.answer.relation,
    confidence: analyzer.answer.confidence,
    changes: analyzerChanges,
    unresolved_fields: analyzer.answer.unresolved_fields ?? [],
    run_attestation: analyzer.attestation,
  };
  const agreement =
    JSON.stringify({
      entity: analyzer.answer.entity,
      relation: analyzer.answer.relation,
      changes: semanticShape(analyzerChanges),
      unresolved_fields: analyzer.answer.unresolved_fields ?? [],
    }) ===
    JSON.stringify({
      entity: reviewer.answer.entity,
      relation: reviewer.answer.relation,
      changes: semanticShape(reviewerChanges),
      unresolved_fields: reviewer.answer.unresolved_fields ?? [],
    });
  const review: Record<string, unknown> = {
    schema_version: REVIEW_SCHEMA_VERSION,
    review_id: `review:${randomUUID().replaceAll("-", "")}`,
    reviewer_run_id: reviewerId,
    proposal_id: proposal.proposal_id,
    proposal_sha256: canonicalDigest(proposal),
    verdict: agreement ? "approve" : "revise",
    confidence: reviewer.answer.confidence,
    accepted_fields: agreement ? analyzerChanges.map((item) => item.field) : [],
    accepted_entity: agreement ? analyzer.answer.entity : null,
    accepted_relation: agreement ? analyzer.answer.relation : null,
    field_reviews: fieldReviews(reviewerChanges),
    issues: agreement
      ? []
      : [
          "independent semantic runs did not produce the same field-level relation",
        ],
    run_attestation: reviewer.attestation,
  };
  return { proposal, review };
}
