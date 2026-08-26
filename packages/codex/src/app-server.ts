import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import { isRecord } from "../../core/src/index.js";

export const CODEX_APP_SERVER_ADAPTER_VERSION =
  "contextadapt.codex-app-server.v1" as const;

type JsonRpcId = number;

export interface CodexAppServerOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  requestTimeoutMs?: number;
}

export interface CodexAppServerThread {
  id: string;
  sessionId?: string;
  forkedFromId?: string | null;
  modelProvider?: string;
  cwd?: string;
  ephemeral?: boolean;
  turns: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface CodexAppServerTurnResult {
  thread_id_sha256: string;
  turn_id_sha256: string;
  turn: Record<string, unknown>;
  token_usage: Record<string, unknown> | null;
  agent_messages: string[];
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface TurnWaiter {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const sha = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function objectResult(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${where} must return one object`);
  return value;
}

function threadResult(value: unknown, where: string): CodexAppServerThread {
  const root = objectResult(value, where);
  const thread = objectResult(root.thread, `${where}.thread`);
  if (typeof thread.id !== "string" || !thread.id.trim()) {
    throw new Error(`${where}.thread.id must be a non-empty string`);
  }
  if (!Array.isArray(thread.turns)) {
    throw new Error(`${where}.thread.turns must be an array`);
  }
  return thread as CodexAppServerThread;
}

/**
 * Minimal newline-delimited JSON-RPC client for the official Codex App Server.
 * It deliberately rejects unknown server requests instead of granting tools or
 * approvals on behalf of the user.
 */
export class CodexAppServerClient {
  readonly adapter_version = CODEX_APP_SERVER_ADAPTER_VERSION;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: ReadlineInterface;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly completedTurns = new Map<string, Record<string, unknown>>();
  private readonly turnWaiters = new Map<string, TurnWaiter[]>();
  private readonly tokenUsage = new Map<string, Record<string, unknown>>();
  private readonly notificationHandlers = new Set<
    (method: string, params: Record<string, unknown>) => void
  >();
  private nextId = 1;
  private stderrTail = "";
  private closed = false;

  private constructor(options: CodexAppServerOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (
      !Number.isInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs <= 0
    ) {
      throw new Error("requestTimeoutMs must be a positive integer");
    }
    this.child = spawn(
      options.command ?? "codex",
      options.args ?? ["app-server", "--stdio"],
      {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.receiveLine(line));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_000);
    });
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code, signal) => {
      if (this.closed) return;
      this.failAll(
        new Error(
          `Codex App Server exited before completion (code=${String(code)}, signal=${String(signal)}): ${this.stderrTail.trim() || "no stderr"}`,
        ),
      );
    });
  }

  static async connect(
    options: CodexAppServerOptions = {},
  ): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(options);
    try {
      await client.request("initialize", {
        clientInfo: {
          name: "contextadapt",
          title: "ContextAdapt",
          version: "0.2.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      client.notify("initialized");
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  onNotification(
    handler: (method: string, params: Record<string, unknown>) => void,
  ): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async threadRead(threadId: string): Promise<CodexAppServerThread> {
    if (!threadId.trim()) throw new Error("threadId must not be empty");
    return threadResult(
      await this.request("thread/read", { threadId, includeTurns: true }),
      "thread/read",
    );
  }

  async threadStart(options: {
    cwd: string;
    model?: string;
    modelContextWindow?: number;
    ephemeral?: boolean;
  }): Promise<CodexAppServerThread> {
    if (!options.cwd.trim())
      throw new Error("thread/start cwd must not be empty");
    if (
      options.modelContextWindow !== undefined &&
      (!Number.isInteger(options.modelContextWindow) ||
        options.modelContextWindow <= 0)
    ) {
      throw new Error(
        "thread/start modelContextWindow must be a positive integer",
      );
    }
    return threadResult(
      await this.request("thread/start", {
        cwd: options.cwd,
        model: options.model ?? "gpt-5.6-luna",
        allowProviderModelFallback: false,
        approvalPolicy: "never",
        sandbox: "read-only",
        config:
          options.modelContextWindow === undefined
            ? null
            : {
                model_context_window: options.modelContextWindow,
                model_auto_compact_token_limit: Math.max(
                  1,
                  options.modelContextWindow - 10_000,
                ),
              },
        ephemeral: options.ephemeral ?? true,
        experimentalRawEvents: true,
      }),
      "thread/start",
    );
  }

  async threadFork(options: {
    threadId: string;
    cwd: string;
    model?: string;
    modelContextWindow?: number;
    ephemeral?: boolean;
  }): Promise<CodexAppServerThread> {
    if (!options.threadId.trim()) throw new Error("threadId must not be empty");
    if (!options.cwd.trim())
      throw new Error("thread/fork cwd must not be empty");
    return threadResult(
      await this.request("thread/fork", {
        threadId: options.threadId,
        cwd: options.cwd,
        model: options.model ?? "gpt-5.6-luna",
        approvalPolicy: "never",
        sandbox: "read-only",
        config:
          options.modelContextWindow === undefined
            ? null
            : {
                model_context_window: options.modelContextWindow,
                model_auto_compact_token_limit: Math.max(
                  1,
                  options.modelContextWindow - 10_000,
                ),
              },
        ephemeral: options.ephemeral ?? true,
        deferGoalContinuation: true,
      }),
      "thread/fork",
    );
  }

  async threadInjectItems(
    threadId: string,
    items: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (!threadId.trim()) throw new Error("threadId must not be empty");
    if (items.length === 0) throw new Error("thread injection requires items");
    await this.request("thread/inject_items", { threadId, items });
  }

  async startTurn(options: {
    threadId: string;
    prompt: string;
    model?: string;
    effort?: "low" | "medium" | "high";
    outputSchema?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<CodexAppServerTurnResult> {
    if (!options.threadId.trim()) throw new Error("threadId must not be empty");
    if (!options.prompt.trim())
      throw new Error("turn prompt must not be empty");
    const response = objectResult(
      await this.request(
        "turn/start",
        {
          threadId: options.threadId,
          input: [
            {
              type: "text",
              text: options.prompt,
              text_elements: [],
            },
          ],
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            networkAccess: false,
          },
          model: options.model ?? "gpt-5.6-luna",
          effort: options.effort ?? "low",
          outputSchema: options.outputSchema ?? null,
          responsesapiClientMetadata: {
            contextadapt_adapter: CODEX_APP_SERVER_ADAPTER_VERSION,
          },
        },
        options.timeoutMs,
      ),
      "turn/start",
    );
    const turn = objectResult(response.turn, "turn/start.turn");
    if (typeof turn.id !== "string" || !turn.id.trim()) {
      throw new Error("turn/start.turn.id must be a non-empty string");
    }
    const completed =
      turn.status === "completed"
        ? turn
        : await this.waitForTurn(
            options.threadId,
            turn.id,
            options.timeoutMs ?? 300_000,
          );
    if (completed.status !== "completed") {
      throw new Error(
        `Codex App Server turn did not complete successfully: ${String(completed.status)}`,
      );
    }
    const items = Array.isArray(completed.items) ? completed.items : [];
    const agentMessages = items
      .filter(
        (item): item is Record<string, unknown> =>
          isRecord(item) &&
          item.type === "agentMessage" &&
          typeof item.text === "string",
      )
      .map((item) => String(item.text));
    if (agentMessages.length === 0) {
      throw new Error("completed Codex App Server turn had no Agent message");
    }
    return {
      thread_id_sha256: sha(options.threadId),
      turn_id_sha256: sha(turn.id),
      turn: completed,
      token_usage:
        this.tokenUsage.get(this.turnKey(options.threadId, turn.id)) ?? null,
      agent_messages: agentMessages,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.child.stdin.end();
    this.child.kill();
    this.failAll(new Error("Codex App Server client closed"));
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new Error("Codex App Server client is closed"));
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(
        new Error("request timeout must be a positive integer"),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ method, id, params });
    });
  }

  private notify(method: string): void {
    this.write({ method });
  }

  private write(value: Record<string, unknown>): void {
    if (this.closed) throw new Error("Codex App Server client is closed");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private receiveLine(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) throw new Error("message is not an object");
      message = value;
    } catch (error) {
      this.failAll(
        new Error(
          `Codex App Server emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }
    if (
      Number.isInteger(message.id) &&
      ("result" in message || "error" in message)
    ) {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error !== undefined) {
        pending.reject(
          new Error(
            `Codex App Server request failed: ${JSON.stringify(message.error)}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (Number.isInteger(message.id) && typeof message.method === "string") {
      this.write({
        id: Number(message.id),
        error: {
          code: -32601,
          message: `ContextAdapt refuses unhandled server request ${message.method}`,
        },
      });
      return;
    }
    if (typeof message.method !== "string") return;
    const params = isRecord(message.params) ? message.params : {};
    this.captureNotification(message.method, params);
    for (const handler of this.notificationHandlers) {
      handler(message.method, params);
    }
  }

  private captureNotification(
    method: string,
    params: Record<string, unknown>,
  ): void {
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    if (method === "thread/tokenUsage/updated") {
      const turnId = typeof params.turnId === "string" ? params.turnId : "";
      if (threadId && turnId && isRecord(params.tokenUsage)) {
        this.tokenUsage.set(this.turnKey(threadId, turnId), params.tokenUsage);
      }
      return;
    }
    if (method !== "turn/completed" || !isRecord(params.turn)) return;
    const turnId = typeof params.turn.id === "string" ? params.turn.id : "";
    if (!threadId || !turnId) return;
    const key = this.turnKey(threadId, turnId);
    this.completedTurns.set(key, params.turn);
    const waiters = this.turnWaiters.get(key) ?? [];
    this.turnWaiters.delete(key);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(params.turn);
    }
  }

  private waitForTurn(
    threadId: string,
    turnId: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const key = this.turnKey(threadId, turnId);
    const completed = this.completedTurns.get(key);
    if (completed) return Promise.resolve(completed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const remaining = (this.turnWaiters.get(key) ?? []).filter(
          (entry) => entry.resolve !== resolve,
        );
        if (remaining.length > 0) this.turnWaiters.set(key, remaining);
        else this.turnWaiters.delete(key);
        reject(new Error("Codex App Server turn timed out"));
      }, timeoutMs);
      const waiters = this.turnWaiters.get(key) ?? [];
      waiters.push({ resolve, reject, timer });
      this.turnWaiters.set(key, waiters);
    });
  }

  private turnKey(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`;
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiters of this.turnWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.turnWaiters.clear();
  }
}
