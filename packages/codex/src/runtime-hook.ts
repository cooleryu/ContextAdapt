import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  classifyExecutorRecovery,
  codexHookOutput,
  evaluateExecutorCall,
  isRecord,
  loadExecutorGuard,
} from "../../core/src/index.js";

export const CODEX_RECORDING_SCHEMA_VERSION =
  "contextadapt.codex-recording.v1" as const;

const sha = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function eventName(payload: Record<string, unknown>): string {
  const value = payload.hook_event_name ?? payload.event_name;
  return typeof value === "string" ? value : "";
}

export function codexRuntimeStem(sessionId: string): string {
  return sha(sessionId).slice(0, 20);
}

const HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse"] as const;

export const CODEX_PRIVATE_SESSION_REFERENCE_VERSION =
  "contextadapt.codex-private-session-reference.v1" as const;

export interface CodexPrivateSessionReference {
  schema_version: typeof CODEX_PRIVATE_SESSION_REFERENCE_VERSION;
  thread_id: string;
  thread_id_sha256: string;
  last_turn_id: string | null;
  last_observed_at: string;
}

export const CODEX_PASSIVE_SNAPSHOT_VERSION =
  "contextadapt.codex-passive-snapshot.v1" as const;

export interface CodexPassiveSnapshotEntry {
  target: string;
  existed: boolean;
  content_sha256: string | null;
  content: string | null;
}

interface StoredPassiveSnapshot {
  schema_version: typeof CODEX_PASSIVE_SNAPSHOT_VERSION;
  session_id_sha256: string;
  turn_id_sha256: string;
  captured_at: string;
  entries: Array<{
    target: string;
    existed: boolean;
    content_sha256: string | null;
    blob: string | null;
  }>;
}

function passivePrivateDirectory(cwd: string): string {
  return resolve(cwd, ".contextadapt/private");
}

function passiveSettingsPath(cwd: string): string {
  return resolve(passivePrivateDirectory(cwd), "passive-cohort.json");
}

function passiveSnapshotPath(
  cwd: string,
  sessionId: string,
  turnId: string,
  privateDirectory = passivePrivateDirectory(cwd),
): string {
  return resolve(
    privateDirectory,
    "snapshots",
    codexRuntimeStem(sessionId),
    `${sha(turnId).slice(0, 20)}.snapshot.json`,
  );
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function enableCodexPassiveCohort(cwd: string): Promise<string> {
  const directory = passivePrivateDirectory(cwd);
  const path = passiveSettingsPath(cwd);
  await ensurePrivateDirectory(directory);
  await writeFile(
    path,
    `${JSON.stringify(
      {
        schema_version: "contextadapt.codex-passive-settings.v1",
        enabled: true,
        disclosure:
          "Stores the raw Codex thread ID locally with mode 0600. Public reports contain only its SHA-256 hash.",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  return path;
}

async function passiveCohortEnabled(cwd: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(
      await readFile(passiveSettingsPath(cwd), "utf8"),
    );
    return isRecord(value) && value.enabled === true;
  } catch {
    return false;
  }
}

async function savePrivateSessionReference(
  cwd: string,
  sessionId: string,
  turnId: string | null,
  observedAt: string,
  privateDirectory?: string,
): Promise<string> {
  const directory = privateDirectory ?? passivePrivateDirectory(cwd);
  await ensurePrivateDirectory(directory);
  const path = resolve(
    directory,
    `${codexRuntimeStem(sessionId)}.codex-session.json`,
  );
  const reference: CodexPrivateSessionReference = {
    schema_version: CODEX_PRIVATE_SESSION_REFERENCE_VERSION,
    thread_id: sessionId,
    thread_id_sha256: sha(sessionId),
    last_turn_id: turnId,
    last_observed_at: observedAt,
  };
  await writeFile(path, `${JSON.stringify(reference, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
  return path;
}

function parsePrivateSessionReference(
  value: unknown,
  where: string,
): CodexPrivateSessionReference {
  if (!isRecord(value)) throw new Error(`${where} must contain one object`);
  if (value.schema_version !== CODEX_PRIVATE_SESSION_REFERENCE_VERSION) {
    throw new Error(`${where} has an unsupported schema version`);
  }
  if (typeof value.thread_id !== "string" || !value.thread_id.trim()) {
    throw new Error(`${where}.thread_id must be a non-empty string`);
  }
  if (
    typeof value.thread_id_sha256 !== "string" ||
    value.thread_id_sha256 !== sha(value.thread_id)
  ) {
    throw new Error(`${where}.thread_id_sha256 does not match the private ID`);
  }
  if (value.last_turn_id !== null && typeof value.last_turn_id !== "string") {
    throw new Error(`${where}.last_turn_id must be a string or null`);
  }
  if (
    typeof value.last_observed_at !== "string" ||
    !Number.isFinite(Date.parse(value.last_observed_at))
  ) {
    throw new Error(`${where}.last_observed_at must be an ISO timestamp`);
  }
  return value as unknown as CodexPrivateSessionReference;
}

export async function loadLatestCodexPrivateSessionReference(
  cwd: string,
  privateDirectory = passivePrivateDirectory(cwd),
): Promise<CodexPrivateSessionReference> {
  let names: string[];
  try {
    names = (await readdir(privateDirectory)).filter((name) =>
      name.endsWith(".codex-session.json"),
    );
  } catch {
    throw new Error(
      "no private Codex session reference found; reinstall with install-host codex --passive-cohort and complete one normal prompt",
    );
  }
  const references: CodexPrivateSessionReference[] = [];
  for (const name of names) {
    const path = resolve(privateDirectory, name);
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    references.push(parsePrivateSessionReference(value, path));
  }
  const latest = references.sort(
    (left, right) =>
      Date.parse(right.last_observed_at) - Date.parse(left.last_observed_at),
  )[0];
  if (!latest) {
    throw new Error(
      "no private Codex session reference found; complete one normal Codex prompt first",
    );
  }
  return latest;
}

function shadowMutationTargets(
  toolName: unknown,
  toolInput: Record<string, unknown>,
  cwd: string,
): string[] {
  if (toolName !== "apply_patch") return [];
  const command =
    typeof toolInput.command === "string" ? toolInput.command : "";
  const paths = [
    ...command.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm),
  ].map((match) => String(match[1] ?? "").trim());
  if (typeof toolInput.path === "string") paths.push(toolInput.path);
  return [...new Set(paths)]
    .filter(Boolean)
    .map((target) => {
      const absolute = resolve(cwd, target);
      const back = relative(cwd, absolute).replaceAll("\\", "/");
      if (isAbsolute(back) || back.startsWith("..")) {
        throw new Error("passive snapshot target is outside the workspace");
      }
      return back;
    })
    .sort();
}

async function capturePassiveSnapshot(
  cwd: string,
  sessionId: string,
  turnId: string,
  targets: string[],
  privateDirectory?: string,
): Promise<{ status: "captured" | "not_applicable"; targets: string[] }> {
  if (targets.length === 0) return { status: "not_applicable", targets: [] };
  const path = passiveSnapshotPath(cwd, sessionId, turnId, privateDirectory);
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  let stored: StoredPassiveSnapshot = {
    schema_version: CODEX_PASSIVE_SNAPSHOT_VERSION,
    session_id_sha256: sha(sessionId),
    turn_id_sha256: sha(turnId),
    captured_at: new Date().toISOString(),
    entries: [],
  };
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      isRecord(value) &&
      value.schema_version === CODEX_PASSIVE_SNAPSHOT_VERSION &&
      Array.isArray(value.entries)
    ) {
      stored = value as unknown as StoredPassiveSnapshot;
    }
  } catch {
    // The first mutation in this turn creates the private snapshot manifest.
  }
  const existing = new Set(stored.entries.map((entry) => entry.target));
  for (const target of targets) {
    if (existing.has(target)) continue;
    const absolute = resolve(cwd, target);
    let content: string | null = null;
    let existed = false;
    try {
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error("passive snapshot refuses symbolic-link targets");
      }
      const realWorkspace = await realpath(cwd);
      const realTarget = await realpath(absolute);
      const back = relative(realWorkspace, realTarget);
      if (isAbsolute(back) || back.startsWith("..")) {
        throw new Error("passive snapshot target resolves outside workspace");
      }
      if (!metadata.isFile()) {
        throw new Error("passive snapshot target is not a regular file");
      }
      content = await readFile(realTarget, "utf8");
      if (Buffer.byteLength(content, "utf8") > 5_000_000) {
        throw new Error("passive snapshot target exceeds 5 MB");
      }
      existed = true;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
    }
    const blob = existed ? `${sha(target)}.blob` : null;
    if (blob && content !== null) {
      await writeFile(resolve(directory, blob), content, { mode: 0o600 });
      await chmod(resolve(directory, blob), 0o600);
    }
    stored.entries.push({
      target,
      existed,
      content_sha256: content === null ? null : sha(content),
      blob,
    });
  }
  await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
  return { status: "captured", targets };
}

export async function loadCodexPassiveSnapshot(
  cwd: string,
  sessionId: string,
  turnId: string,
  privateDirectory?: string,
): Promise<CodexPassiveSnapshotEntry[]> {
  const path = passiveSnapshotPath(cwd, sessionId, turnId, privateDirectory);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return [];
  }
  if (
    !isRecord(value) ||
    value.schema_version !== CODEX_PASSIVE_SNAPSHOT_VERSION ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("private passive snapshot is malformed");
  }
  const directory = dirname(path);
  const result: CodexPassiveSnapshotEntry[] = [];
  for (const raw of value.entries) {
    if (
      !isRecord(raw) ||
      typeof raw.target !== "string" ||
      typeof raw.existed !== "boolean"
    ) {
      throw new Error("private passive snapshot entry is malformed");
    }
    let content: string | null = null;
    if (raw.existed) {
      if (typeof raw.blob !== "string") {
        throw new Error("private passive snapshot blob is missing");
      }
      content = await readFile(resolve(directory, raw.blob), "utf8");
      if (sha(content) !== raw.content_sha256) {
        throw new Error("private passive snapshot blob hash mismatch");
      }
    }
    result.push({
      target: raw.target,
      existed: raw.existed,
      content_sha256:
        typeof raw.content_sha256 === "string" ? raw.content_sha256 : null,
      content,
    });
  }
  return result;
}

export async function installCodexRuntimeHooks(
  cwd: string,
  command = "contextadapt host-hook codex",
  options: {
    passiveCohort?: boolean;
    replaceContextAdaptMode?: boolean;
  } = {},
): Promise<{
  path: string;
  added: string[];
  passive_cohort: boolean;
  private_settings_path: string | null;
}> {
  if (!command.trim()) throw new Error("Codex hook command must not be empty");
  const hookCommand =
    options.passiveCohort === true &&
    !/(?:^|\s)--shadow-only(?:\s|$)/.test(command)
      ? `${command} --shadow-only`
      : command;
  const path = resolve(cwd, ".codex/hooks.json");
  let root: Record<string, unknown> = {};
  try {
    const existing: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(existing))
      throw new Error("existing hooks file is not an object");
    root = existing;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const hooks = isRecord(root.hooks) ? { ...root.hooks } : {};
  const added: string[] = [];
  for (const event of HOOK_EVENTS) {
    const configured = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    const existing = options.replaceContextAdaptMode
      ? configured.filter(
          (entry) => !JSON.stringify(entry).includes("host-hook codex"),
        )
      : configured;
    const serializedExisting = JSON.stringify(existing);
    if (serializedExisting.includes(hookCommand)) continue;
    if (serializedExisting.includes("host-hook codex")) {
      throw new Error(
        `existing ContextAdapt ${event} hook uses a different mode; remove or review it before switching passive/enforcing modes`,
      );
    }
    existing.push({
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: hookCommand,
          timeout: 30,
          statusMessage:
            event === "PreToolUse"
              ? "ContextAdapt is checking the actual tool call"
              : event === "PostToolUse"
                ? "ContextAdapt is recording tool success"
                : "ContextAdapt is recording the task update",
        },
      ],
    });
    hooks[event] = existing;
    added.push(event);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        ...root,
        description:
          typeof root.description === "string"
            ? root.description
            : "ContextAdapt task/tool recorder and pre-execution guard",
        hooks,
      },
      null,
      2,
    )}\n`,
  );
  const privateSettingsPath = options.passiveCohort
    ? await enableCodexPassiveCohort(cwd)
    : null;
  return {
    path,
    added,
    passive_cohort: options.passiveCohort === true,
    private_settings_path: privateSettingsPath,
  };
}

function successFromResponse(value: unknown): boolean | null {
  if (!isRecord(value)) return null;
  if (typeof value.is_error === "boolean") return !value.is_error;
  if (typeof value.success === "boolean") return value.success;
  const exit = value.exit_code ?? value.exitCode;
  if (Number.isInteger(exit)) return Number(exit) === 0;
  return null;
}

function recordedToolPhase(
  toolName: unknown,
  toolInput: Record<string, unknown>,
): "retrieval" | "execution" | null {
  const name = typeof toolName === "string" ? toolName : "";
  if (/^(?:Read|Glob|Grep|read_file|list_files|search)$/i.test(name)) {
    return "retrieval";
  }
  if (/^(?:apply_patch|write|edit)$/i.test(name)) return "execution";
  if (/^(?:Bash|bash)$/i.test(name)) {
    const command =
      typeof toolInput.command === "string" ? toolInput.command.trim() : "";
    return /^(?:cat|head|tail|ls|pwd|rg|grep|find|stat|wc|git\s+(?:status|diff|log|show))\b/i.test(
      command,
    )
      ? "retrieval"
      : "execution";
  }
  return null;
}

async function appendRecording(
  runtimeDirectory: string,
  sessionId: string,
  record: Record<string, unknown>,
): Promise<void> {
  await mkdir(runtimeDirectory, { recursive: true });
  await appendFile(
    resolve(runtimeDirectory, `${codexRuntimeStem(sessionId)}.recording.jsonl`),
    `${JSON.stringify(record)}\n`,
  );
}

interface RecoveryState {
  turn_id: string | null;
  recovery_count: number;
}

function recoveryStatePath(
  runtimeDirectory: string,
  sessionId: string,
): string {
  return resolve(
    runtimeDirectory,
    `${codexRuntimeStem(sessionId)}.recovery-state.json`,
  );
}

async function loadRecoveryState(
  runtimeDirectory: string,
  sessionId: string,
): Promise<RecoveryState> {
  try {
    const value: unknown = JSON.parse(
      await readFile(recoveryStatePath(runtimeDirectory, sessionId), "utf8"),
    );
    if (
      isRecord(value) &&
      Number.isInteger(value.recovery_count) &&
      Number(value.recovery_count) >= 0
    ) {
      return {
        turn_id: typeof value.turn_id === "string" ? value.turn_id : null,
        recovery_count: Number(value.recovery_count),
      };
    }
  } catch {
    // A missing or corrupt state starts fail-closed at zero for this turn.
  }
  return { turn_id: null, recovery_count: 0 };
}

async function saveRecoveryState(
  runtimeDirectory: string,
  sessionId: string,
  state: RecoveryState,
): Promise<void> {
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(
    recoveryStatePath(runtimeDirectory, sessionId),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

function safeWorkspaceTarget(cwd: string, target: string): string {
  const absolute = resolve(cwd, target);
  const back = relative(cwd, absolute);
  if (isAbsolute(back) || back.startsWith("..")) {
    throw new Error("recovery target is outside the Codex workspace");
  }
  return absolute;
}

function withRecoveryReason(
  output: Record<string, unknown> | null,
  suffix: string,
): Record<string, unknown> | null {
  if (!output || !isRecord(output.hookSpecificOutput)) return output;
  const hook = output.hookSpecificOutput;
  hook.permissionDecisionReason = `${String(
    hook.permissionDecisionReason ?? "ContextAdapt blocked this tool call.",
  )} ${suffix}`;
  return output;
}

/** Native Codex hook recorder plus the real PreToolUse mutation gate. */
export async function handleCodexRuntimeHook(
  payload: Record<string, unknown>,
  options: {
    runtimeDirectory?: string;
    privateDirectory?: string;
    retainSessionReference?: boolean;
    shadowOnly?: boolean;
  } = {},
): Promise<Record<string, unknown> | null> {
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.trim()
      ? payload.session_id
      : `cwd:${sha(cwd).slice(0, 16)}`;
  const directory =
    options.runtimeDirectory ?? resolve(cwd, ".contextadapt/runtime");
  const hook = eventName(payload);
  if (hook === "UserPromptSubmit") {
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const observedAt = new Date().toISOString();
    await appendRecording(directory, sessionId, {
      schema_version: CODEX_RECORDING_SCHEMA_VERSION,
      event: "user_prompt",
      session_id_sha256: sha(sessionId),
      turn_id: typeof payload.turn_id === "string" ? payload.turn_id : null,
      observed_at: observedAt,
      prompt,
      prompt_sha256: sha(prompt),
      model: typeof payload.model === "string" ? payload.model : null,
    });
    await saveRecoveryState(directory, sessionId, {
      turn_id: typeof payload.turn_id === "string" ? payload.turn_id : null,
      recovery_count: 0,
    });
    if (
      options.retainSessionReference === true ||
      (options.retainSessionReference !== false &&
        (await passiveCohortEnabled(cwd)))
    ) {
      await savePrivateSessionReference(
        cwd,
        sessionId,
        typeof payload.turn_id === "string" ? payload.turn_id : null,
        observedAt,
        options.privateDirectory,
      );
    }
    return null;
  }
  if (hook === "PostToolUse") {
    const toolInput = isRecord(payload.tool_input) ? payload.tool_input : {};
    const response = payload.tool_response;
    const phase = recordedToolPhase(payload.tool_name, toolInput);
    const state = await loadRecoveryState(directory, sessionId);
    await appendRecording(directory, sessionId, {
      schema_version: CODEX_RECORDING_SCHEMA_VERSION,
      event: "tool_result",
      session_id_sha256: sha(sessionId),
      turn_id: typeof payload.turn_id === "string" ? payload.turn_id : null,
      tool_use_id:
        typeof payload.tool_use_id === "string" ? payload.tool_use_id : null,
      tool_name:
        typeof payload.tool_name === "string" ? payload.tool_name : null,
      target:
        typeof toolInput.path === "string"
          ? toolInput.path
          : typeof toolInput.file_path === "string"
            ? toolInput.file_path
            : null,
      success: successFromResponse(response),
      attempt: state.recovery_count,
      phase,
      call_fingerprint: sha(
        JSON.stringify([payload.tool_name ?? null, toolInput]),
      ),
      response_sha256: sha(JSON.stringify(response ?? null)),
      observed_at: new Date().toISOString(),
    });
    return null;
  }
  if (hook === "PreToolUse") {
    const toolInput = isRecord(payload.tool_input) ? payload.tool_input : {};
    if (options.shadowOnly === true) {
      const turnId =
        typeof payload.turn_id === "string" && payload.turn_id.trim()
          ? payload.turn_id
          : "unknown-turn";
      const targets = shadowMutationTargets(payload.tool_name, toolInput, cwd);
      const snapshot = await capturePassiveSnapshot(
        cwd,
        sessionId,
        turnId,
        targets,
        options.privateDirectory,
      );
      await appendRecording(directory, sessionId, {
        schema_version: CODEX_RECORDING_SCHEMA_VERSION,
        event: "pre_tool_shadow",
        session_id_sha256: sha(sessionId),
        turn_id: typeof payload.turn_id === "string" ? payload.turn_id : null,
        tool_use_id:
          typeof payload.tool_use_id === "string" ? payload.tool_use_id : null,
        tool_name:
          typeof payload.tool_name === "string" ? payload.tool_name : null,
        target: targets[0] ?? null,
        target_count: targets.length,
        snapshot_status: snapshot.status,
        snapshot_target_sha256: targets.map(sha),
        phase: recordedToolPhase(payload.tool_name, toolInput),
        decision: "OBSERVE_ONLY",
        call_fingerprint: sha(
          JSON.stringify([payload.tool_name ?? null, toolInput]),
        ),
        observed_at: new Date().toISOString(),
      });
      return null;
    }
    const sessionGuard = resolve(
      directory,
      `${codexRuntimeStem(sessionId)}.guard.json`,
    );
    const fallback = resolve(cwd, ".contextadapt/executor-guard.json");
    let guard;
    try {
      guard = await loadExecutorGuard(sessionGuard);
    } catch {
      guard = await loadExecutorGuard(fallback);
    }
    const decision = evaluateExecutorCall("codex", payload, guard);
    const callFingerprint = sha(
      JSON.stringify([payload.tool_name ?? null, toolInput]),
    );
    await appendRecording(directory, sessionId, {
      schema_version: CODEX_RECORDING_SCHEMA_VERSION,
      event: "pre_tool_gate",
      session_id_sha256: sha(sessionId),
      turn_id: typeof payload.turn_id === "string" ? payload.turn_id : null,
      tool_use_id:
        typeof payload.tool_use_id === "string" ? payload.tool_use_id : null,
      tool_name:
        typeof payload.tool_name === "string" ? payload.tool_name : null,
      target: decision.tool.targets[0] ?? null,
      call_fingerprint: callFingerprint,
      decision: decision.decision,
      in_scope: decision.tool.in_scope,
      reasons: decision.reasons,
      matched_changes: decision.matched_changes ?? [],
      observed_at: new Date().toISOString(),
    });
    if (decision.decision !== "BLOCK") return null;
    const output = codexHookOutput(decision);
    const classification = classifyExecutorRecovery(decision, guard);
    if (classification.disposition !== "RECOVER_CURRENT_TARGET") {
      return withRecoveryReason(
        output,
        "This block is terminal and cannot expand target or authority.",
      );
    }
    const state = await loadRecoveryState(directory, sessionId);
    if (state.recovery_count >= 1) {
      await appendRecording(directory, sessionId, {
        schema_version: CODEX_RECORDING_SCHEMA_VERSION,
        event: "recovery_exhausted",
        session_id_sha256: sha(sessionId),
        turn_id: typeof payload.turn_id === "string" ? payload.turn_id : null,
        target: classification.target,
        refresh_fields: classification.refresh_fields,
        recovery_count: state.recovery_count,
        observed_at: new Date().toISOString(),
      });
      return withRecoveryReason(
        output,
        "The one-step recovery budget is exhausted; stop without mutation.",
      );
    }
    const started = Date.now();
    let content = "";
    let error: string | null = null;
    try {
      if (!classification.target) throw new Error("recovery target is missing");
      content = await readFile(
        safeWorkspaceTarget(cwd, classification.target),
        "utf8",
      );
      if (Buffer.byteLength(content, "utf8") > 1_000_000) {
        throw new Error("recovery target exceeds the 1 MB read limit");
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const nextState = { ...state, recovery_count: state.recovery_count + 1 };
    await saveRecoveryState(directory, sessionId, nextState);
    await appendRecording(directory, sessionId, {
      schema_version: CODEX_RECORDING_SCHEMA_VERSION,
      event: "recovery_read",
      session_id_sha256: sha(sessionId),
      turn_id: typeof payload.turn_id === "string" ? payload.turn_id : null,
      target: classification.target,
      refresh_fields: classification.refresh_fields,
      recovery_count: nextState.recovery_count,
      success: error === null,
      bytes: Buffer.byteLength(content, "utf8"),
      input_tokens: Math.ceil(Buffer.byteLength(content, "utf8") / 4),
      content_sha256: sha(content),
      latency_ms: Date.now() - started,
      error,
      observed_at: new Date().toISOString(),
    });
    return withRecoveryReason(
      output,
      error === null
        ? `ContextAdapt performed its one read-only recovery. Re-anchor on this verified current state and retry once:\n${content.slice(0, 16_000)}`
        : `ContextAdapt's one read-only recovery failed (${error}); stop without mutation.`,
    );
  }
  throw new Error(`unsupported Codex hook event: ${hook || "missing"}`);
}
