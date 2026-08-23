/** ContextAdapt pre-execution guard for Oh My Pi / OMP 17.x. */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export default function contextAdaptGuard(pi: any) {
	pi.on("tool_call", async (event: any, ctx: any) => {
		if (!["write", "edit", "bash", "python", "notebook"].includes(event.toolName)) return undefined;
		const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
		const executable = process.env.CONTEXTADAPT_BIN || "contextadapt";
		const guardPath = process.env.CONTEXTADAPT_GUARD || resolve(cwd, ".contextadapt/executor-guard.json");
		const payload = JSON.stringify({
			tool_name: event.toolName,
			tool_input: event.input,
			cwd,
			session_id: ctx.sessionManager?.getSessionId?.(),
			tool_call_id: event.toolCallId,
		});
		const result = spawnSync(executable, ["executor-hook", "omp", "--policy", guardPath, "--format", "json"], {
			input: payload,
			encoding: "utf8",
			env: process.env,
		});
		if (result.status !== 0) {
			return { block: true, reason: `ContextAdapt guard failed closed: ${(result.stderr || "unknown error").trim()}` };
		}
		try {
			const decision = JSON.parse(result.stdout);
			if (decision.decision === "BLOCK") {
				return { block: true, reason: `ContextAdapt blocked this tool call: ${decision.reasons.join("; ")}` };
			}
			return undefined;
		} catch (error) {
			return { block: true, reason: `ContextAdapt guard returned invalid JSON: ${String(error)}` };
		}
	});
}
