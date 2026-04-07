import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  defaultAutonomyConfig,
  readProjectConfig,
  root,
  type AutonomyConfig,
  type StopConditionId,
} from "./project-config";

type RuntimeState =
  | "idle"
  | "starting"
  | "running"
  | "stopped"
  | "completed"
  | "failed"
  | "interrupted";

type RuntimeStatus = {
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
};

type TaskBoardTask = {
  milestone: string;
  status: string;
};

type TaskBoard = {
  currentMilestoneId?: string;
  tasks?: TaskBoardTask[];
};

const runtimeDirectory = path.join(root, "data", "runtime");
const statusPath = path.join(runtimeDirectory, "codex-runtime-status.json");
const stdoutLogPath = path.join(runtimeDirectory, "codex-runtime-stdout.log");
const stderrLogPath = path.join(runtimeDirectory, "codex-runtime-stderr.log");
const lastMessagePath = path.join(runtimeDirectory, "codex-runtime-last-message.txt");

function nowIso() {
  return new Date().toISOString();
}

function codexCommand() {
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

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function tsxEntrypoint() {
  return path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
}

function defaultStatus(config: AutonomyConfig = defaultAutonomyConfig()): RuntimeStatus {
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
    issueExportDirectory: config.issueExportDirectory,
    stdoutLog: path.relative(root, stdoutLogPath),
    stderrLog: path.relative(root, stderrLogPath),
    lastMessageFile: path.relative(root, lastMessagePath),
  };
}

async function ensureRuntimeDirectory() {
  await mkdir(runtimeDirectory, { recursive: true });
}

async function readRuntimeStatus(config?: AutonomyConfig): Promise<RuntimeStatus> {
  await ensureRuntimeDirectory();
  if (!existsSync(statusPath)) {
    return defaultStatus(config);
  }

  return JSON.parse(await readFile(statusPath, "utf8")) as RuntimeStatus;
}

async function writeRuntimeStatus(status: RuntimeStatus) {
  await ensureRuntimeDirectory();
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

async function updateRuntimeStatus(
  updater: (status: RuntimeStatus) => RuntimeStatus | Promise<RuntimeStatus>,
  config?: AutonomyConfig,
) {
  const current = await readRuntimeStatus(config);
  const next = await updater(current);
  await writeRuntimeStatus(next);
  return next;
}

function isProcessAlive(pid: number | null): boolean {
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

function terminateProcess(pid: number | null) {
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

async function readTaskBoard(): Promise<TaskBoard> {
  const taskBoardPath = path.join(root, "planning", "task-board.json");
  return JSON.parse(await readFile(taskBoardPath, "utf8")) as TaskBoard;
}

async function issueExportsPresent(issueExportDirectory: string): Promise<boolean> {
  const absoluteDirectory = path.join(root, issueExportDirectory);
  if (!existsSync(absoluteDirectory)) {
    return false;
  }

  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  return files.includes("README.md") && files.some((file) => /^issue-\d+\.md$/.test(file));
}

function activeMilestoneTasks(board: TaskBoard): TaskBoardTask[] {
  const activeMilestone = board.currentMilestoneId;
  const tasks = board.tasks ?? [];
  if (!activeMilestone) {
    return [];
  }

  return tasks.filter((task) => task.milestone === activeMilestone);
}

async function evaluateStopCondition(condition: StopConditionId, issueExportDirectory: string): Promise<boolean> {
  const board = await readTaskBoard();
  const tasks = activeMilestoneTasks(board);
  const noReadyOrInProgress = tasks.every(
    (task) => task.status !== "ready" && task.status !== "in_progress",
  );
  const milestoneComplete =
    tasks.length > 0 && tasks.every((task) => task.status === "verified" || task.status === "done");
  const exportsPresent = await issueExportsPresent(issueExportDirectory);

  switch (condition) {
    case "active_milestone_no_ready_or_in_progress":
      return noReadyOrInProgress;
    case "active_milestone_all_done":
      return milestoneComplete;
    case "issue_exports_present":
      return exportsPresent;
    case "milestone_complete_and_issue_exports_present":
      return milestoneComplete && exportsPresent;
    default:
      return false;
  }
}

function formatSummary(text: string | null | undefined): string | null {
  if (!text) {
    return null;
  }

  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 240 ? `${singleLine.slice(0, 237)}...` : singleLine;
}

function buildCodexArgs(
  status: RuntimeStatus,
  config: AutonomyConfig,
): string[] {
  const args: string[] = [];
  if (!status.threadId) {
    args.push("exec", "--json", "-C", root, "-s", config.sandboxMode, "-o", lastMessagePath);
    if (config.model) {
      args.push("-m", config.model);
    }
    args.push("-");
    return args;
  }

  args.push("exec", "resume", status.threadId, "--json", "-o", lastMessagePath);
  if (config.model) {
    args.push("-m", config.model);
  }
  args.push("-");
  return args;
}

async function runCodexCycle(status: RuntimeStatus, config: AutonomyConfig) {
  const prompt = status.threadId ? config.resumePrompt : config.basePrompt;
  const args = buildCodexArgs(status, config);

  const child = spawn(codexCommand(), args, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : false,
  });

  await updateRuntimeStatus(
    (current) => ({
      ...current,
      state: "running",
      workerPid: process.pid,
      activeChildPid: child.pid ?? null,
      lastHeartbeat: nowIso(),
      selectedStopCondition: config.selectedStopCondition,
      issueExportDirectory: config.issueExportDirectory,
    }),
    config,
  );

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdin.end(prompt);

  let stdoutBuffer = "";
  child.stdout.on("data", async (chunk: string) => {
    stdoutBuffer += chunk;
    await writeFile(stdoutLogPath, chunk, { encoding: "utf8", flag: "a" });

    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const event = JSON.parse(trimmed) as { type?: string; thread_id?: string };
        if (event.type === "thread.started" && event.thread_id) {
          await updateRuntimeStatus(
            (current) => ({
              ...current,
              threadId: event.thread_id ?? current.threadId,
              lastHeartbeat: nowIso(),
            }),
            config,
          );
        } else {
          await updateRuntimeStatus(
            (current) => ({
              ...current,
              lastHeartbeat: nowIso(),
            }),
            config,
          );
        }
      } catch {
        await updateRuntimeStatus(
          (current) => ({
            ...current,
            lastHeartbeat: nowIso(),
          }),
          config,
        );
      }
    }
  });

  child.stderr.on("data", async (chunk: string) => {
    await writeFile(stderrLogPath, chunk, { encoding: "utf8", flag: "a" });
    await updateRuntimeStatus(
      (current) => ({
        ...current,
        lastHeartbeat: nowIso(),
      }),
      config,
    );
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

  const lastMessage = existsSync(lastMessagePath) ? await readFile(lastMessagePath, "utf8") : "";
  return {
    exitCode,
    lastMessage: lastMessage.trim(),
  };
}

async function runWorker() {
  const projectConfig = await readProjectConfig();
  const config = projectConfig.autonomy ?? defaultAutonomyConfig();

  await updateRuntimeStatus(
    (current) => ({
      ...current,
      state: "starting",
      workerPid: process.pid,
      activeChildPid: null,
      startTime: current.startTime ?? nowIso(),
      lastHeartbeat: nowIso(),
      selectedStopCondition: config.selectedStopCondition,
      issueExportDirectory: config.issueExportDirectory,
    }),
    config,
  );

  while (true) {
    const status = await readRuntimeStatus(config);
    if (status.state === "stopped") {
      return;
    }

    const cycleResult = await runCodexCycle(status, config);
    const matchedStopCondition = cycleResult.exitCode === 0
      ? await evaluateStopCondition(config.selectedStopCondition, config.issueExportDirectory)
      : false;

    const nextState: RuntimeState =
      cycleResult.exitCode !== 0
        ? "failed"
        : matchedStopCondition
          ? "completed"
          : "running";

    await updateRuntimeStatus(
      (current) => ({
        ...current,
        state: nextState,
        workerPid: nextState === "running" ? process.pid : null,
        activeChildPid: null,
        lastHeartbeat: nowIso(),
        cycleCount: current.cycleCount + 1,
        latestResultSummary:
          cycleResult.exitCode === 0
            ? matchedStopCondition
              ? formatSummary(cycleResult.lastMessage) ??
                `Stop condition "${config.selectedStopCondition}" matched.`
              : formatSummary(cycleResult.lastMessage) ??
                `Cycle ${current.cycleCount + 1} completed. Stop condition not matched yet.`
            : `Codex CLI exited with code ${cycleResult.exitCode}.`,
      }),
      config,
    );

    if (nextState === "completed" || nextState === "failed") {
      return;
    }
  }
}

async function spawnWorker(mode: "start" | "resume") {
  const projectConfig = await readProjectConfig();
  const config = projectConfig.autonomy ?? defaultAutonomyConfig();
  const status = await readRuntimeStatus(config);

  if ((status.state === "starting" || status.state === "running") && isProcessAlive(status.workerPid)) {
    throw new Error("Runtime is already active. Run pnpm runtime:status or pnpm runtime:stop first.");
  }

  if (
    mode === "resume" &&
    !["stopped", "interrupted", "failed"].includes(status.state)
  ) {
    throw new Error("runtime:resume is only valid from stopped, interrupted, or failed state.");
  }

  if (mode === "resume" && !status.threadId) {
    throw new Error("runtime:resume requires an existing Codex thread id in runtime state.");
  }

  const seededStatus: RuntimeStatus =
    mode === "start"
      ? {
          ...defaultStatus(config),
          state: "starting",
          startTime: nowIso(),
          lastHeartbeat: nowIso(),
        }
      : {
          ...status,
          state: "starting",
          lastHeartbeat: nowIso(),
        };

  if (mode === "start") {
    await writeFile(stdoutLogPath, "", "utf8");
    await writeFile(stderrLogPath, "", "utf8");
    await writeFile(lastMessagePath, "", "utf8");
  }

  await writeRuntimeStatus(seededStatus);

  const child = spawn(process.execPath, [tsxEntrypoint(), path.join(root, "scripts", "runtime.ts"), "worker"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  await updateRuntimeStatus(
    (current) => ({
      ...current,
      workerPid: child.pid ?? null,
      latestResultSummary:
        mode === "start"
          ? "Background runtime started."
          : "Background runtime resumed.",
    }),
    config,
  );

  console.log(`Codex runtime ${mode === "start" ? "started" : "resumed"} in background.`);
}

async function commandStatus() {
  const projectConfig = await readProjectConfig();
  const config = projectConfig.autonomy ?? defaultAutonomyConfig();
  const status = await readRuntimeStatus(config);

  let effectiveStatus = status;
  if (
    (status.state === "starting" || status.state === "running") &&
    !isProcessAlive(status.workerPid)
  ) {
    effectiveStatus = {
      ...status,
      state: "interrupted",
      activeChildPid: null,
      latestResultSummary:
        status.latestResultSummary ?? "Worker process is no longer running.",
    };
    await writeRuntimeStatus(effectiveStatus);
  }

  console.log(`State: ${effectiveStatus.state}`);
  console.log(`Worker PID: ${effectiveStatus.workerPid ?? "n/a"}`);
  console.log(`Active child PID: ${effectiveStatus.activeChildPid ?? "n/a"}`);
  console.log(`Thread ID: ${effectiveStatus.threadId ?? "n/a"}`);
  console.log(`Started: ${effectiveStatus.startTime ?? "n/a"}`);
  console.log(`Last heartbeat: ${effectiveStatus.lastHeartbeat ?? "n/a"}`);
  console.log(`Stop condition: ${effectiveStatus.selectedStopCondition}`);
  console.log(`Cycles: ${effectiveStatus.cycleCount}`);
  console.log(`Issue export directory: ${effectiveStatus.issueExportDirectory}`);
  console.log(`Latest result: ${effectiveStatus.latestResultSummary ?? "n/a"}`);
  console.log(`Stdout log: ${effectiveStatus.stdoutLog}`);
  console.log(`Stderr log: ${effectiveStatus.stderrLog}`);
  console.log(`Last message file: ${effectiveStatus.lastMessageFile}`);
}

async function commandStop() {
  const projectConfig = await readProjectConfig();
  const config = projectConfig.autonomy ?? defaultAutonomyConfig();
  const status = await readRuntimeStatus(config);

  terminateProcess(status.activeChildPid);
  terminateProcess(status.workerPid);

  await writeRuntimeStatus({
    ...status,
    state: "stopped",
    activeChildPid: null,
    workerPid: null,
    lastHeartbeat: nowIso(),
    latestResultSummary: "Runtime stopped by operator.",
  });

  console.log("Codex runtime stopped.");
}

async function main() {
  await ensureRuntimeDirectory();
  const command = process.argv[2] ?? "status";

  switch (command) {
    case "start":
      await spawnWorker("start");
      return;
    case "resume":
      await spawnWorker("resume");
      return;
    case "status":
      await commandStatus();
      return;
    case "stop":
      await commandStop();
      return;
    case "worker":
      await runWorker();
      return;
    default:
      throw new Error(`Unknown runtime command "${command}".`);
  }
}

main().catch(async (error) => {
  const projectConfig = existsSync(path.join(root, "project.config.json")) ? await readProjectConfig() : null;
  const config = projectConfig?.autonomy ?? defaultAutonomyConfig();
  const message = error instanceof Error ? error.message : String(error);

  await updateRuntimeStatus(
    (current) => ({
      ...current,
      state: "failed",
      activeChildPid: null,
      workerPid: current.workerPid === process.pid ? null : current.workerPid,
      lastHeartbeat: nowIso(),
      latestResultSummary: message,
    }),
    config,
  ).catch(() => undefined);

  console.error(message);
  process.exitCode = 1;
});
