import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { defaultAutonomyConfig, root, type AutonomyConfig, type StopConditionId } from "./project-config";

export type RuntimeState =
  | "idle"
  | "starting"
  | "running"
  | "stopped"
  | "completed"
  | "failed"
  | "blocked"
  | "interrupted";

export type HookStatus = {
  command: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  succeeded: boolean | null;
  summary: string | null;
};

export type RuntimeStatus = {
  state: RuntimeState;
  workerPid: number | null;
  activeChildPid: number | null;
  threadId: string | null;
  startTime: string | null;
  lastHeartbeat: string | null;
  selectedStopCondition: StopConditionId;
  latestResultSummary: string | null;
  cycleCount: number;
  issueExportDirectory: string;
  stdoutLog: string;
  stderrLog: string;
  lastMessageFile: string;
  runtimeCodexHome: string;
  environmentMode: "repo-scoped";
  consecutiveTerminalBlockers: number;
  lastBlockerSignature: string | null;
  maxConsecutiveTerminalBlockers: number;
  lastExitCode: number | null;
  effectiveSandboxMode: string;
  lastCycleExecutedRepoCommand: boolean;
  lastPostIterationHook: HookStatus | null;
};

export const runtimeDirectory = path.join(root, "data", "runtime");
export const runtimeStatusPath = path.join(runtimeDirectory, "codex-runtime-status.json");
export const stdoutLogPath = path.join(runtimeDirectory, "codex-runtime-stdout.log");
export const stderrLogPath = path.join(runtimeDirectory, "codex-runtime-stderr.log");
export const lastMessagePath = path.join(runtimeDirectory, "codex-runtime-last-message.txt");
export const supervisorStatusPath = path.join(runtimeDirectory, "supervisor-status.json");

export function nowIso() {
  return new Date().toISOString();
}

export function codexCommand() {
  if (process.platform !== "win32") {
    return "codex";
  }

  try {
    const resolved = execFileSync("where.exe", ["codex.cmd"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (resolved) {
      return resolved;
    }
  } catch {
    // fall through to PATH lookup
  }

  return "codex.cmd";
}

export function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

export function tsxEntrypoint() {
  return path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
}

export function defaultHookStatus(command: string | null = null): HookStatus {
  return {
    command,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    succeeded: null,
    summary: null,
  };
}

export function defaultRuntimeStatus(
  config: AutonomyConfig = defaultAutonomyConfig(),
): RuntimeStatus {
  return {
    state: "idle",
    workerPid: null,
    activeChildPid: null,
    threadId: null,
    startTime: null,
    lastHeartbeat: null,
    selectedStopCondition: config.selectedStopCondition,
    latestResultSummary: null,
    cycleCount: 0,
    issueExportDirectory: config.issueExportDirectory ?? "docs/issues/harness",
    stdoutLog: path.relative(root, stdoutLogPath),
    stderrLog: path.relative(root, stderrLogPath),
    lastMessageFile: path.relative(root, lastMessagePath),
    runtimeCodexHome: path.relative(root, path.join(runtimeDirectory, "codex-home")),
    environmentMode: "repo-scoped",
    consecutiveTerminalBlockers: 0,
    lastBlockerSignature: null,
    maxConsecutiveTerminalBlockers: 3,
    lastExitCode: null,
    effectiveSandboxMode: config.sandboxMode,
    lastCycleExecutedRepoCommand: false,
    lastPostIterationHook: defaultHookStatus(),
  };
}

export async function ensureRuntimeDirectory() {
  await mkdir(runtimeDirectory, { recursive: true });
}

export async function readRuntimeStatus(config?: AutonomyConfig): Promise<RuntimeStatus> {
  await ensureRuntimeDirectory();
  if (!existsSync(runtimeStatusPath)) {
    return defaultRuntimeStatus(config);
  }

  const raw = await readFile(runtimeStatusPath, "utf8");
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as Partial<RuntimeStatus>;
  return {
    ...defaultRuntimeStatus(config),
    ...parsed,
    lastPostIterationHook: parsed.lastPostIterationHook
      ? {
          ...defaultHookStatus(parsed.lastPostIterationHook.command ?? null),
          ...parsed.lastPostIterationHook,
        }
      : defaultHookStatus(),
  };
}

export async function writeRuntimeStatus(status: RuntimeStatus) {
  await ensureRuntimeDirectory();
  await writeFile(runtimeStatusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

export async function updateRuntimeStatus(
  updater: (status: RuntimeStatus) => RuntimeStatus | Promise<RuntimeStatus>,
  config?: AutonomyConfig,
) {
  const current = await readRuntimeStatus(config);
  const next = await updater(current);
  await writeRuntimeStatus(next);
  return next;
}

export function isProcessAlive(pid: number | null): boolean {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function terminateProcess(pid: number | null) {
  if (!pid) {
    return;
  }

  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
      return;
    }

    process.kill(pid, "SIGTERM");
  } catch {
    // ignore missing processes
  }
}
