import { resolve } from "node:path";
import {
  evaluateExecutorCall,
  loadExecutorGuard,
} from "../../core/src/index.js";

export interface OmpToolCall {
  toolName: string;
  input: Record<string, unknown>;
  toolCallId?: string;
}
export interface OmpContext {
  cwd?: string;
  sessionManager?: { getSessionId?(): string | undefined };
}
export interface OmpApi {
  on(
    event: "tool_call",
    handler: (
      event: OmpToolCall,
      context: OmpContext,
    ) => Promise<{ block: true; reason: string } | undefined>,
  ): void;
}

/** Native, in-process OMP 17.x pre-tool guard. It fails closed for guarded calls. */
export default function contextAdaptGuard(omp: OmpApi): void {
  omp.on("tool_call", async (event, context) => {
    if (
      !["write", "edit", "bash", "python", "notebook"].includes(event.toolName)
    )
      return undefined;
    const cwd = context.cwd ?? process.cwd();
    const policy =
      process.env.CONTEXTADAPT_GUARD ??
      resolve(cwd, ".contextadapt/executor-guard.json");
    try {
      const decision = evaluateExecutorCall(
        "omp",
        {
          tool_name: event.toolName,
          tool_input: event.input,
          cwd,
          session_id: context.sessionManager?.getSessionId?.(),
          tool_call_id: event.toolCallId,
        },
        await loadExecutorGuard(policy),
      );
      return decision.decision === "BLOCK"
        ? {
            block: true,
            reason: `ContextAdapt blocked this tool call: ${decision.reasons.join("; ")}`,
          }
        : undefined;
    } catch (error) {
      return {
        block: true,
        reason: `ContextAdapt guard failed closed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}
