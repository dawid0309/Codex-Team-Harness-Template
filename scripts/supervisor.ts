import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { readHarnessConfig, resolveHarnessWorkdir, type HarnessConfig } from "./harness-config";
import { root } from "./project-config";
import {
  ensureRuntimeDirectory,
  isProcessAlive,
  nowIso,
  pnpmCommand,
  readRuntimeStatus,
  runtimeStatusPath,
  supervisorStatusPath,
  terminateProcess,
  tsxEntrypoint,
  writeRuntimeStatus,
  type RuntimeState,
  type RuntimeStatus,
} from "./runtime-shared";

type SupervisorState =
  | "idle"
  | "starting"
  | "running"
  | "restarting"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";

type SupervisorStatus = {
  state: SupervisorState;
  supervisorPid: number | null;
  startTime: string | null;
  lastHeartbeat: string | null;
  restartCount: number;
  nextLaunchAt: string | null;
  lastLaunchAt: string | null;
  lastLaunchCommand: string | null;
  lastLaunchExitCode: number | null;
  lastMessage: string | null;
  pollIntervalSeconds: number;
  restartBackoffSeconds: number;
  maxRestartsPerHour: number;
  childCommand: string | null;
  workdir: string;
  runtimeState: RuntimeState | null;
  runtimeWorkerPid: number | null;
  runtimeThreadId: string | null;
  runtimeCycleCount: number;
  recentRestartTimestamps: string[];
};

type ShellCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

function defaultSupervisorStatus(config: HarnessConfig): SupervisorStatus {
  return {
    state: "idle",
    supervisorPid: null,
    startTime: null,
    lastHeartbeat: null,
    restartCount: 0,
    nextLaunchAt: null,
    lastLaunchAt: null,
    lastLaunchCommand: config.supervisor.childCommand,
    lastLaunchExitCode: null,
    lastMessage: null,
    pollIntervalSeconds: config.supervisor.pollIntervalSeconds,
    restartBackoffSeconds: config.supervisor.restartBackoffSeconds,
    maxRestartsPerHour: config.supervisor.maxRestartsPerHour,
    childCommand: config.supervisor.childCommand,
    workdir: resolveHarnessWorkdir(config),
    runtimeState: null,
    runtimeWorkerPid: null,
    runtimeThreadId: null,
    runtimeCycleCount: 0,
    recentRestartTimestamps: [],
  };
}

async function readSupervisorStatus(config: HarnessConfig): Promise<SupervisorStatus> {
  await ensureRuntimeDirectory();
  if (!existsSync(supervisorStatusPath)) {
    return defaultSupervisorStatus(config);
  }

  const raw = await readFile(supervisorStatusPath, "utf8");
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as Partial<SupervisorStatus>;
  return {
    ...defaultSupervisorStatus(config),
    ...parsed,
    recentRestartTimestamps: Array.isArray(parsed.recentRestartTimestamps)
      ? parsed.recentRestartTimestamps.filter((value): value is string => typeof value === "string")
      : [],
  };
}

async function writeSupervisorStatus(status: SupervisorStatus) {
  await ensureRuntimeDirectory();
  await writeFile(supervisorStatusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

async function updateSupervisorStatus(
  config: HarnessConfig,
  updater: (status: SupervisorStatus) => SupervisorStatus | Promise<SupervisorStatus>,
) {
  const current = await readSupervisorStatus(config);
  const next = await updater(current);
  await writeSupervisorStatus(next);
  return next;
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeRuntimeState(status: RuntimeStatus): RuntimeState {
  if ((status.state === "starting" || status.state === "running") && !isProcessAlive(status.workerPid)) {
    return "interrupted";
  }

  return status.state;
}

function summarize(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

async function runShellCommand(command: string, cwd: string, timeoutMs?: number): Promise<ShellCommandResult> {
  return await new Promise<ShellCommandResult>((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env: process.env,
      shell: process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    if (timeoutMs && timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminateProcess(child.pid ?? null);
      }, timeoutMs);
    }

    child.once("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });

    child.once("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({
        exitCode: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      });
    });
  });
}

function nextLaunchCommand(config: HarnessConfig, runtimeStatus: RuntimeStatus): string {
  if (config.supervisor.childCommand) {
    return config.supervisor.childCommand;
  }

  const canResume =
    Boolean(runtimeStatus.threadId) &&
    ["stopped", "interrupted", "failed", "blocked"].includes(normalizeRuntimeState(runtimeStatus));

  return `${pnpmCommand()} ${canResume ? "runtime:resume" : "runtime:start"}`;
}

function pruneRestartHistory(timestamps: string[], maxRestartsPerHour: number) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const recent = timestamps.filter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= cutoff;
  });

  return recent.slice(-Math.max(1, maxRestartsPerHour));
}

async function markRuntimeStopped(summary: string) {
  const runtimeStatus = await readRuntimeStatus();
  await writeRuntimeStatus({
    ...runtimeStatus,
    state: "stopped",
    workerPid: null,
    activeChildPid: null,
    lastHeartbeat: nowIso(),
    latestResultSummary: summary,
  });
}

async function runSupervisorWorker() {
  const config = await readHarnessConfig();

  await updateSupervisorStatus(config, (current) => ({
    ...current,
    state: "starting",
    supervisorPid: process.pid,
    startTime: current.startTime ?? nowIso(),
    lastHeartbeat: nowIso(),
    pollIntervalSeconds: config.supervisor.pollIntervalSeconds,
    restartBackoffSeconds: config.supervisor.restartBackoffSeconds,
    maxRestartsPerHour: config.supervisor.maxRestartsPerHour,
    childCommand: config.supervisor.childCommand,
    workdir: resolveHarnessWorkdir(config),
    lastMessage: "Supervisor worker is running.",
  }));

  while (true) {
    const latestConfig = await readHarnessConfig();
    const supervisorStatus = await readSupervisorStatus(latestConfig);
    if (supervisorStatus.state === "stopped") {
      return;
    }

    const runtimeStatus = await readRuntimeStatus();
    const normalizedRuntimeState = normalizeRuntimeState(runtimeStatus);
    const runtimeAlive = isProcessAlive(runtimeStatus.workerPid);

    if (normalizedRuntimeState === "starting" || (normalizedRuntimeState === "running" && runtimeAlive)) {
      await writeSupervisorStatus({
        ...supervisorStatus,
        state: "running",
        supervisorPid: process.pid,
        lastHeartbeat: nowIso(),
        pollIntervalSeconds: latestConfig.supervisor.pollIntervalSeconds,
        restartBackoffSeconds: latestConfig.supervisor.restartBackoffSeconds,
        maxRestartsPerHour: latestConfig.supervisor.maxRestartsPerHour,
        childCommand: latestConfig.supervisor.childCommand,
        workdir: resolveHarnessWorkdir(latestConfig),
        runtimeState: normalizedRuntimeState,
        runtimeWorkerPid: runtimeStatus.workerPid,
        runtimeThreadId: runtimeStatus.threadId,
        runtimeCycleCount: runtimeStatus.cycleCount,
        lastMessage: `Runtime ${normalizedRuntimeState} and worker is healthy.`,
      });
      await sleep(latestConfig.supervisor.pollIntervalSeconds * 1000);
      continue;
    }

    if (normalizedRuntimeState === "completed" || normalizedRuntimeState === "stopped") {
      await writeSupervisorStatus({
        ...supervisorStatus,
        state: normalizedRuntimeState === "completed" ? "completed" : "stopped",
        supervisorPid: process.pid,
        lastHeartbeat: nowIso(),
        runtimeState: normalizedRuntimeState,
        runtimeWorkerPid: runtimeStatus.workerPid,
        runtimeThreadId: runtimeStatus.threadId,
        runtimeCycleCount: runtimeStatus.cycleCount,
        lastMessage:
          normalizedRuntimeState === "completed"
            ? "Runtime completed normally; supervisor will exit."
            : "Runtime stopped by operator; supervisor will exit.",
      });
      return;
    }

    const recentRestartTimestamps = pruneRestartHistory(
      supervisorStatus.recentRestartTimestamps,
      latestConfig.supervisor.maxRestartsPerHour,
    );
    if (recentRestartTimestamps.length >= latestConfig.supervisor.maxRestartsPerHour) {
      await writeSupervisorStatus({
        ...supervisorStatus,
        state: "failed",
        supervisorPid: process.pid,
        lastHeartbeat: nowIso(),
        runtimeState: normalizedRuntimeState,
        runtimeWorkerPid: runtimeStatus.workerPid,
        runtimeThreadId: runtimeStatus.threadId,
        runtimeCycleCount: runtimeStatus.cycleCount,
        recentRestartTimestamps,
        lastMessage: `Restart limit reached (${latestConfig.supervisor.maxRestartsPerHour}/hour).`,
      });
      return;
    }

    const launchCommand = nextLaunchCommand(latestConfig, runtimeStatus);
    const launchAt = nowIso();
    await writeSupervisorStatus({
      ...supervisorStatus,
      state: supervisorStatus.restartCount === 0 ? "starting" : "restarting",
      supervisorPid: process.pid,
      lastHeartbeat: launchAt,
      lastLaunchAt: launchAt,
      lastLaunchCommand: launchCommand,
      lastLaunchExitCode: null,
      nextLaunchAt: null,
      pollIntervalSeconds: latestConfig.supervisor.pollIntervalSeconds,
      restartBackoffSeconds: latestConfig.supervisor.restartBackoffSeconds,
      maxRestartsPerHour: latestConfig.supervisor.maxRestartsPerHour,
      childCommand: latestConfig.supervisor.childCommand,
      workdir: resolveHarnessWorkdir(latestConfig),
      runtimeState: normalizedRuntimeState,
      runtimeWorkerPid: runtimeStatus.workerPid,
      runtimeThreadId: runtimeStatus.threadId,
      runtimeCycleCount: runtimeStatus.cycleCount,
      lastMessage: `Launching runtime with "${launchCommand}".`,
    });

    let launchResult: ShellCommandResult;
    try {
      launchResult = await runShellCommand(launchCommand, resolveHarnessWorkdir(latestConfig), 120000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextLaunchAt = new Date(Date.now() + latestConfig.supervisor.restartBackoffSeconds * 1000).toISOString();
      await writeSupervisorStatus({
        ...supervisorStatus,
        state: "restarting",
        supervisorPid: process.pid,
        lastHeartbeat: nowIso(),
        restartCount: supervisorStatus.restartCount + 1,
        nextLaunchAt,
        lastLaunchAt: launchAt,
        lastLaunchCommand: launchCommand,
        lastLaunchExitCode: null,
        runtimeState: normalizedRuntimeState,
        runtimeWorkerPid: runtimeStatus.workerPid,
        runtimeThreadId: runtimeStatus.threadId,
        runtimeCycleCount: runtimeStatus.cycleCount,
        recentRestartTimestamps: [...recentRestartTimestamps, launchAt],
        lastMessage: summarize(message) ?? "Launch command failed.",
      });
      await sleep(latestConfig.supervisor.restartBackoffSeconds * 1000);
      continue;
    }

    const restartCount = supervisorStatus.restartCount + 1;
    const launchSummary = summarize(launchResult.stdout) ?? summarize(launchResult.stderr);

    await writeSupervisorStatus({
      ...supervisorStatus,
      state: launchResult.exitCode === 0 ? "running" : "restarting",
      supervisorPid: process.pid,
      lastHeartbeat: nowIso(),
      restartCount,
      nextLaunchAt:
        launchResult.exitCode === 0
          ? null
          : new Date(Date.now() + latestConfig.supervisor.restartBackoffSeconds * 1000).toISOString(),
      lastLaunchAt: launchAt,
      lastLaunchCommand: launchCommand,
      lastLaunchExitCode: launchResult.exitCode,
      pollIntervalSeconds: latestConfig.supervisor.pollIntervalSeconds,
      restartBackoffSeconds: latestConfig.supervisor.restartBackoffSeconds,
      maxRestartsPerHour: latestConfig.supervisor.maxRestartsPerHour,
      childCommand: latestConfig.supervisor.childCommand,
      workdir: resolveHarnessWorkdir(latestConfig),
      runtimeState: normalizedRuntimeState,
      runtimeWorkerPid: runtimeStatus.workerPid,
      runtimeThreadId: runtimeStatus.threadId,
      runtimeCycleCount: runtimeStatus.cycleCount,
      recentRestartTimestamps: [...recentRestartTimestamps, launchAt],
      lastMessage:
        launchResult.exitCode === 0
          ? launchSummary ?? "Launch command completed successfully."
          : launchSummary ?? `Launch command exited with code ${launchResult.exitCode}.`,
    });

    if (launchResult.exitCode !== 0) {
      await sleep(latestConfig.supervisor.restartBackoffSeconds * 1000);
      continue;
    }

    await sleep(Math.min(2000, latestConfig.supervisor.pollIntervalSeconds * 1000));
  }
}

async function commandStart() {
  const config = await readHarnessConfig();
  const status = await readSupervisorStatus(config);
  if (
    ["starting", "running", "restarting"].includes(status.state) &&
    isProcessAlive(status.supervisorPid)
  ) {
    console.log("Runtime supervisor is already active.");
    return;
  }

  const seededStatus: SupervisorStatus = {
    ...defaultSupervisorStatus(config),
    state: "starting",
    startTime: nowIso(),
    lastHeartbeat: nowIso(),
    lastMessage: "Starting detached runtime supervisor.",
  };
  await writeSupervisorStatus(seededStatus);

  const child = spawn(process.execPath, [tsxEntrypoint(), path.join(root, "scripts", "supervisor.ts"), "worker"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  await writeSupervisorStatus({
    ...seededStatus,
    supervisorPid: child.pid ?? null,
    lastHeartbeat: nowIso(),
    lastMessage: "Runtime supervisor started in background.",
  });

  console.log("Runtime supervisor started in background.");
}

async function commandStatus() {
  const config = await readHarnessConfig();
  const runtimeStatus = await readRuntimeStatus();
  const status = await readSupervisorStatus(config);
  const supervisorAlive = isProcessAlive(status.supervisorPid);
  const effectiveStatus =
    ["starting", "running", "restarting"].includes(status.state) && !supervisorAlive
      ? {
          ...status,
          state: "interrupted" as const,
          runtimeState: normalizeRuntimeState(runtimeStatus),
          runtimeWorkerPid: runtimeStatus.workerPid,
          runtimeThreadId: runtimeStatus.threadId,
          runtimeCycleCount: runtimeStatus.cycleCount,
          lastMessage: status.lastMessage ?? "Supervisor process is no longer running.",
        }
      : status;

  if (effectiveStatus !== status) {
    await writeSupervisorStatus(effectiveStatus);
  }

  console.log(`Supervisor state: ${effectiveStatus.state}`);
  console.log(`Supervisor PID: ${effectiveStatus.supervisorPid ?? "n/a"}`);
  console.log(`Supervisor alive: ${supervisorAlive}`);
  console.log(`Started: ${effectiveStatus.startTime ?? "n/a"}`);
  console.log(`Last heartbeat: ${effectiveStatus.lastHeartbeat ?? "n/a"}`);
  console.log(`Restarts: ${effectiveStatus.restartCount}`);
  console.log(`Next launch at: ${effectiveStatus.nextLaunchAt ?? "n/a"}`);
  console.log(`Last launch at: ${effectiveStatus.lastLaunchAt ?? "n/a"}`);
  console.log(`Last launch command: ${effectiveStatus.lastLaunchCommand ?? "n/a"}`);
  console.log(`Last launch exit code: ${effectiveStatus.lastLaunchExitCode ?? "n/a"}`);
  console.log(`Poll interval: ${effectiveStatus.pollIntervalSeconds}s`);
  console.log(`Restart backoff: ${effectiveStatus.restartBackoffSeconds}s`);
  console.log(`Max restarts/hour: ${effectiveStatus.maxRestartsPerHour}`);
  console.log(`Runtime state: ${effectiveStatus.runtimeState ?? normalizeRuntimeState(runtimeStatus)}`);
  console.log(`Runtime worker PID: ${effectiveStatus.runtimeWorkerPid ?? runtimeStatus.workerPid ?? "n/a"}`);
  console.log(`Runtime thread ID: ${effectiveStatus.runtimeThreadId ?? runtimeStatus.threadId ?? "n/a"}`);
  console.log(`Runtime cycles: ${effectiveStatus.runtimeCycleCount || runtimeStatus.cycleCount}`);
  console.log(`Workdir: ${effectiveStatus.workdir}`);
  console.log(`Status file: ${path.relative(root, supervisorStatusPath)}`);
  console.log(`Runtime status file: ${path.relative(root, runtimeStatusPath)}`);
  console.log(`Message: ${effectiveStatus.lastMessage ?? "n/a"}`);
}

async function commandStop() {
  const config = await readHarnessConfig();
  const status = await readSupervisorStatus(config);
  const runtimeStatus = await readRuntimeStatus();

  terminateProcess(runtimeStatus.activeChildPid);
  terminateProcess(runtimeStatus.workerPid);
  terminateProcess(status.supervisorPid);
  await markRuntimeStopped("Runtime stopped by operator through supervisor control.");

  await writeSupervisorStatus({
    ...status,
    state: "stopped",
    supervisorPid: null,
    lastHeartbeat: nowIso(),
    nextLaunchAt: null,
    runtimeState: "stopped",
    runtimeWorkerPid: null,
    lastMessage: "Supervisor stopped by operator.",
  });

  console.log("Runtime supervisor stopped.");
}

async function projectStatusSection(config: HarnessConfig): Promise<string | null> {
  const command = config.hooks.projectStatusCommand;
  if (!command) {
    return null;
  }

  try {
    const result = await runShellCommand(command, root, 15000);
    const heading = `Project status command: ${command}`;
    if (result.timedOut) {
      return `${heading}\nTimed out after 15s.`;
    }
    if (result.exitCode !== 0) {
      return `${heading}\nExit code ${result.exitCode}\n${result.stderr || result.stdout || "No output."}`;
    }
    return `${heading}\n${result.stdout || "(no output)"}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Project status command: ${command}\nFailed: ${message}`;
  }
}

function formatHookLine(runtimeStatus: RuntimeStatus) {
  const hook = runtimeStatus.lastPostIterationHook;
  if (!hook?.command) {
    return "Post-iteration hook: not configured";
  }

  return `Post-iteration hook: ${hook.command} | ok=${hook.succeeded ?? "n/a"} | exit=${hook.exitCode ?? "n/a"} | summary=${hook.summary ?? "n/a"}`;
}

async function renderWatchOutput() {
  const config = await readHarnessConfig();
  const supervisorStatus = await readSupervisorStatus(config);
  const runtimeStatus = await readRuntimeStatus();
  const supervisorAlive = isProcessAlive(supervisorStatus.supervisorPid);
  const runtimeAlive = isProcessAlive(runtimeStatus.workerPid);
  const projectSection = await projectStatusSection(config);

  const lines = [
    "Codex Harness Watch",
    `Time: ${new Date().toLocaleString()}`,
    "",
    `Supervisor: ${supervisorStatus.state} | pid=${supervisorStatus.supervisorPid ?? "n/a"} | alive=${supervisorAlive} | restarts=${supervisorStatus.restartCount}`,
    `Heartbeat: ${supervisorStatus.lastHeartbeat ?? "n/a"} | next launch=${supervisorStatus.nextLaunchAt ?? "n/a"}`,
    `Launch: ${supervisorStatus.lastLaunchCommand ?? "n/a"} | exit=${supervisorStatus.lastLaunchExitCode ?? "n/a"}`,
    `Supervisor message: ${supervisorStatus.lastMessage ?? "n/a"}`,
    "",
    `Runtime: ${normalizeRuntimeState(runtimeStatus)} | worker=${runtimeStatus.workerPid ?? "n/a"} | alive=${runtimeAlive} | child=${runtimeStatus.activeChildPid ?? "n/a"}`,
    `Thread: ${runtimeStatus.threadId ?? "n/a"} | cycles=${runtimeStatus.cycleCount} | last exit=${runtimeStatus.lastExitCode ?? "n/a"}`,
    `Stop condition: ${runtimeStatus.selectedStopCondition} | sandbox=${runtimeStatus.effectiveSandboxMode}`,
    `Latest result: ${runtimeStatus.latestResultSummary ?? "n/a"}`,
    formatHookLine(runtimeStatus),
  ];

  if (projectSection) {
    lines.push("", projectSection);
  }

  lines.push(
    "",
    `Harness config: ${path.relative(root, path.join(root, "harness.config.json"))}`,
    `Supervisor status: ${path.relative(root, supervisorStatusPath)}`,
    `Runtime status: ${path.relative(root, runtimeStatusPath)}`,
  );

  return lines.join("\n");
}

async function commandWatch() {
  const args = new Set(process.argv.slice(3));
  const once = args.has("--once");
  const config = await readHarnessConfig();

  do {
    console.clear();
    console.log(await renderWatchOutput());
    if (once) {
      return;
    }
    await sleep(config.supervisor.pollIntervalSeconds * 1000);
  } while (true);
}

async function main() {
  await ensureRuntimeDirectory();
  const command = process.argv[2] ?? "status";

  switch (command) {
    case "start":
      await commandStart();
      return;
    case "status":
      await commandStatus();
      return;
    case "stop":
      await commandStop();
      return;
    case "watch":
      await commandWatch();
      return;
    case "worker":
      await runSupervisorWorker();
      return;
    default:
      throw new Error(`Unknown supervisor command "${command}".`);
  }
}

main().catch(async (error) => {
  const config = await readHarnessConfig().catch(() => null);
  const message = error instanceof Error ? error.message : String(error);

  if (config) {
    await updateSupervisorStatus(config, (current) => ({
      ...current,
      state: "failed",
      supervisorPid: current.supervisorPid === process.pid ? null : current.supervisorPid,
      lastHeartbeat: nowIso(),
      lastMessage: summarize(message) ?? "Supervisor failed.",
    })).catch(() => undefined);
  }

  console.error(message);
  process.exitCode = 1;
});
