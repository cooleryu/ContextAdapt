import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, parse, resolve } from "node:path";

export interface OmpHostInstallResult {
  host: "omp";
  scope: "user" | "project";
  omp_command: string;
  omp_version: string;
  package_root: string;
  install_cwd: string;
  extension_entry: string;
  linked: true;
  verified_by_plugin_list: true;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type OmpInstallRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => CommandResult;

const defaultRunner: OmpInstallRunner = (command, args, options) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
};

function boundedFailure(result: CommandResult): string {
  return (
    result.stderr ||
    result.stdout ||
    result.error?.message ||
    "unknown error"
  )
    .replaceAll(homedir(), "~")
    .slice(0, 1_000);
}

export function findContextAdaptPackageRoot(startDirectory: string): string {
  let current = resolve(startDirectory);
  const root = parse(current).root;
  while (true) {
    const packagePath = resolve(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const value: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
        if (
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          (value as Record<string, unknown>).name === "contextadapt"
        ) {
          return current;
        }
      } catch {
        // Continue toward the filesystem root.
      }
    }
    if (current === root) break;
    current = dirname(current);
  }
  throw new Error("could not locate the installed contextadapt package root");
}

export function defaultOmpCommand(): string {
  if (process.env.OMP_COMMAND?.trim()) return process.env.OMP_COMMAND.trim();
  const bunGlobal = resolve(homedir(), ".bun/bin/omp");
  return existsSync(bunGlobal) ? bunGlobal : "omp";
}

export function installOmpHost(options: {
  packageRoot: string;
  installCwd?: string;
  ompCommand?: string;
  scope?: "user" | "project";
  runner?: OmpInstallRunner;
}): OmpHostInstallResult {
  const packageRoot = resolve(options.packageRoot);
  const installCwd = resolve(options.installCwd ?? packageRoot);
  const packagePath = resolve(packageRoot, "package.json");
  const manifest: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("contextadapt package.json must contain one object");
  }
  const omp = (manifest as Record<string, unknown>).omp;
  const extensions =
    omp && typeof omp === "object" && !Array.isArray(omp)
      ? (omp as Record<string, unknown>).extensions
      : null;
  const entry = Array.isArray(extensions)
    ? extensions.find((value): value is string => typeof value === "string")
    : typeof extensions === "string"
      ? extensions
      : null;
  if (!entry) {
    throw new Error("contextadapt package is missing omp.extensions");
  }
  const extensionEntry = resolve(packageRoot, entry);
  if (!existsSync(extensionEntry)) {
    throw new Error(
      `OMP extension entry is not built: ${entry}; run npm run build first`,
    );
  }
  const runner = options.runner ?? defaultRunner;
  const command = options.ompCommand ?? defaultOmpCommand();
  const scope = options.scope ?? "user";
  const version = runner(command, ["--version"], { cwd: packageRoot });
  if (version.status !== 0) {
    throw new Error(`OMP is unavailable: ${boundedFailure(version)}`);
  }
  const linked = runner(
    command,
    ["plugin", "link", packageRoot, "--scope", scope, "--json"],
    { cwd: installCwd },
  );
  if (linked.status !== 0) {
    throw new Error(`OMP plugin link failed: ${boundedFailure(linked)}`);
  }
  const listed = runner(command, ["plugin", "list", "--json"], {
    cwd: installCwd,
  });
  if (listed.status !== 0 || !listed.stdout.includes("contextadapt")) {
    throw new Error(
      `OMP did not report the linked contextadapt plugin: ${boundedFailure(listed)}`,
    );
  }
  return {
    host: "omp",
    scope,
    omp_command: command,
    omp_version: version.stdout.trim() || version.stderr.trim(),
    package_root: packageRoot,
    install_cwd: installCwd,
    extension_entry: extensionEntry,
    linked: true,
    verified_by_plugin_list: true,
  };
}
