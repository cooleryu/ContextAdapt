/** Exercise the native OMP tool_call lifecycle with the ContextAdapt extension. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const runtimeDir = process.env.OMP_RUNTIME_DIR;
const labDir = process.env.CONTEXTADAPT_LAB_DIR;
const guardPath = process.env.CONTEXTADAPT_GUARD;
const guardBin = process.env.CONTEXTADAPT_BIN;
if (!runtimeDir || !labDir || !guardPath || !guardBin) {
	throw new Error("OMP_RUNTIME_DIR, CONTEXTADAPT_LAB_DIR, CONTEXTADAPT_GUARD, and CONTEXTADAPT_BIN are required");
}

const codingUrl = pathToFileURL(
	join(runtimeDir, "node_modules", "@oh-my-pi", "pi-coding-agent", "src", "index.ts"),
).href;
const mockUrl = pathToFileURL(
	join(runtimeDir, "node_modules", "@oh-my-pi", "pi-ai", "src", "providers", "mock.ts"),
).href;
const { createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager } = await import(codingUrl);
const { createMockModel, registerMockApi } = await import(mockUrl);
registerMockApi("contextadapt-executor-lab");

const extensionPath = resolve(import.meta.dir, "..", "integrations", "omp", "contextadapt-guard.ts");
if (!existsSync(extensionPath)) throw new Error(`missing extension: ${extensionPath}`);
const guardExtension = (await import(pathToFileURL(extensionPath).href)).default;

type LabCase = {
	name: string;
	target: string;
	content: string;
	expectWrite: boolean;
};

const cases: LabCase[] = [
	{
		name: "stale_context",
		target: "staging/config.json",
		content: '{"environment":"staging","timeout":30}\n',
		expectWrite: false,
	},
	{
		name: "current_context",
		target: "production/config.json",
		content: '{"environment":"production","timeout":60}\n',
		expectWrite: true,
	},
];

const results: Array<Record<string, unknown>> = [];
for (const entry of cases) {
	const caseDir = join(labDir, entry.name);
	const targetPath = join(caseDir, entry.target);
	mkdirSync(resolve(targetPath, ".."), { recursive: true });
	const initial = '{"environment":"initial","timeout":10}\n';
	writeFileSync(targetPath, initial, "utf8");

	const mock = createMockModel({
		id: `contextadapt-${entry.name}`,
		responses: [
			{
				content: [
					{
						type: "toolCall",
						id: `write-${entry.name}`,
						name: "write",
						arguments: { path: entry.target, content: entry.content },
					},
				],
			},
			{ content: ["done"] },
		],
	});
	const agentDir = join(caseDir, ".omp-agent");
	const authStorage = await discoverAuthStorage(agentDir);
	authStorage.setRuntimeApiKey("mock", "contextadapt-local-mock-key");
	const modelRegistry = new ModelRegistry(authStorage);

	const { session, extensionsResult } = await createAgentSession({
		cwd: caseDir,
		agentDir,
		authStorage,
		modelRegistry,
		model: mock,
		getApiKey: () => "contextadapt-local-mock-key",
		sessionManager: SessionManager.inMemory(caseDir),
		extensions: [guardExtension],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: ["write"],
		autoApprove: true,
		contextFiles: [],
		rules: [],
		skills: [],
	});
	await session.prompt(`Execute the scripted ${entry.name} write.`);
	const finalContent = readFileSync(targetPath, "utf8");
	const wrote = finalContent === entry.content;
	const toolResults = session.state.messages
		.filter((message: any) => message.role === "toolResult")
		.map((message: any) => ({ isError: message.isError, content: message.content }));
	results.push({
		case: entry.name,
		target: entry.target,
		expected_write: entry.expectWrite,
		actual_write: wrote,
		file_unchanged: finalContent === initial,
		tool_results: toolResults,
		loaded_extensions: extensionsResult.extensions.map((extension: any) => extension.path ?? extension.name ?? "loaded"),
		extension_errors: extensionsResult.errors,
		pass: wrote === entry.expectWrite,
	});
	await session.dispose?.();
}

process.stdout.write(`${JSON.stringify({ host: "omp", executor: "native_tool_call", results }, null, 2)}\n`);
