import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
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
  | "blocked"
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
  runtimeCodexHome: string;
  environmentMode: "repo-scoped";
  consecutiveTerminalBlockers: number;
  lastBlockerSignature: string | null;
  maxConsecutiveTerminalBlockers: number;
  lastExitCode: number | null;
};

type TaskBoardTask = {
  milestone: string;
  status: string;
};

type TaskBoard = {
  currentMilestoneId?: string;
  tasks?: TaskBoardTask[];
};

type TerminalBlocker = {
  signature: string;
  label: string;
};

type CycleResult = {
  exitCode: number;
  lastMessage: string;
  stdoutText: string;
  stderrText: string;
  blocker: TerminalBlocker | null;
};

type RuntimeEvent = {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
  };
};

const runtimeDirectory = path.join(root, "data", "runtime");
const runtimeCodexHomePath = path.join(runtimeDirectory, "codex-home");
const runtimeConfigPath = path.join(runtimeCodexHomePath, "config.toml");
const statusPath = path.join(runtimeDirectory, "codex-runtime-status.json");
const stdoutLogPath = path.join(runtimeDirectory, "codex-runtime-stdout.log");
const stderrLogPath = path.join(runtimeDirectory, "codex-runtime-stderr.log");
const lastMessagePath = path.join(runtimeDirectory, "codex-runtime-last-message.txt");
const runtimeSourceConfigEnv = "FOUNDRY_RUNTIME_SOURCE_CODEX_CONFIG";

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
    runtimeCodexHome: path.relative(root, runtimeCodexHomePath),
    environmentMode: "repo-scoped",
    consecutiveTerminalBlockers: 0,
    lastBlockerSignature: null,
    maxConsecutiveTerminalBlockers: Math.max(1, config.maxConsecutiveTerminalBlockers),
    lastExitCode: null,
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

  const loaded = JSON.parse(await readFile(statusPath, "utf8")) as Partial<RuntimeStatus>;
  return {
    ...defaultStatus(config),
    ...loaded,
  };
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

function actualCodexConfigPath() {
  return process.env[runtimeSourceConfigEnv] ?? path.join(process.env.USERPROFILE ?? os.homedir(), ".codex", "config.toml");
}

function buildRepoScopedCodexConfig(config: AutonomyConfig): string {
  const globalConfigPath = actualCodexConfigPath();
  const allowedRootKeys = new Set([
    "model_provider",
    "model",
    "model_reasoning_effort",
    "disable_response_storage",
  ]);
  const allowedSection = (name: string) => name === "windows" || name.startsWith("model_providers.");
  const emittedRootKeys = new Set<string>();
  const lines: string[] = [];

  if (existsSync(globalConfigPath)) {
    const source = readFileSync(globalConfigPath, "utf8");
    const rawLines = source.split(/\r?\n/);

    let currentSection: string | null = null;
    let sectionBuffer: string[] = [];

    const flushSection = () => {
      if (currentSection && allowedSection(currentSection)) {
        while (sectionBuffer.length > 0 && sectionBuffer[sectionBuffer.length - 1] === "") {
          sectionBuffer.pop();
        }
        lines.push(...sectionBuffer, "");
      }
      currentSection = null;
      sectionBuffer = [];
    };

    for (const line of rawLines) {
      const sectionMatch = line.match(/^\s*\[(.+?)\]\s*$/);
      if (sectionMatch) {
        flushSection();
        currentSection = sectionMatch[1];
        sectionBuffer = [line];
        continue;
      }

      if (currentSection) {
        sectionBuffer.push(line);
        continue;
      }

      const keyMatch = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
      if (!keyMatch) {
        continue;
      }

      const key = keyMatch[1];
      if (allowedRootKeys.has(key)) {
        lines.push(line);
        emittedRootKeys.add(key);
      }
    }

    flushSection();
  }

  if (!emittedRootKeys.has("disable_response_storage")) {
    lines.push('disable_response_storage = true');
  }

  if (config.model && !emittedRootKeys.has("model")) {
    lines.push(`model = "${config.model}"`);
  }

  return `${lines.join("\n").trim()}\n`;
}

async function ensureRepoScopedCodexHome(config: AutonomyConfig) {
  await mkdir(runtimeCodexHomePath, { recursive: true });
  const configText = buildRepoScopedCodexConfig(config);
  await writeFile(runtimeConfigPath, configText, "utf8");
}

function buildRuntimeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_")) {
      delete env[key];
    }
  }

  env.CODEX_HOME = runtimeCodexHomePath;
  env.HOME = runtimeCodexHomePath;
  env.USERPROFILE = runtimeCodexHomePath;
  env[runtimeSourceConfigEnv] = path.join(process.env.USERPROFILE ?? os.homedir(), ".codex", "config.toml");
  env.POWERSHELL_TELEMETRY_OPTOUT = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.NO_COLOR = "1";

  if (process.platform === "win32") {
    const parsed = path.parse(runtimeCodexHomePath);
    env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, "");
    env.HOMEPATH = `\\${path.relative(parsed.root, runtimeCodexHomePath).replace(/\//g, "\\")}`;
    env.COMSPEC = process.env.ComSpec ?? process.env.COMSPEC ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
  }

  return env;
}

function buildCodexArgs(status: RuntimeStatus, config: AutonomyConfig): string[] {
  const args: string[] = ["-c", "shell_environment_policy.inherit=none"];

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

function runtimePrompt(basePrompt: string): string {
  return `${basePrompt}

Runtime-specific constraints:
- Treat this as a repo-scoped runtime and ignore workstation-global state that is not stored in the repository.
- If you invoke PowerShell directly, always include -NoProfile.
- If policy, write capability, or sandbox constraints block progress, say so explicitly instead of retrying silently.`;
}

function trimBuffer(buffer: string, maxChars = 12000) {
  return buffer.length > maxChars ? buffer.slice(buffer.length - maxChars) : buffer;
}

async function appendLog(filePath: string, chunk: string) {
  await appendFile(filePath, chunk, "utf8");
}

function detectTerminalBlocker(lastMessage: string, stdoutText: string, stderrText: string): TerminalBlocker | null {
  const text = `${lastMessage}\n${stdoutText}\n${stderrText}`;

  const matchers: Array<TerminalBlocker & { patterns: RegExp[] }> = [
    {
      signature: "workspace-read-only",
      label: "workspace or sandbox is read-only",
      patterns: [
        /workspace is read-only/i,
        /read-only workspace/i,
        /workspace remains read-only/i,
        /sandbox.*read-only/i,
        /cannot write (files|changes|to)/i,
        /no writable/i,
        /missing write capability/i,
        /write capability/i,
      ],
    },
    {
      signature: "policy-rejection",
      label: "approval or policy rejection prevents progress",
      patterns: [
        /approval policy/i,
        /requires approval/i,
        /blocked by policy/i,
        /policy rejection/i,
        /not permitted by policy/i,
      ],
    },
    {
      signature: "command-not-executable",
      label: "required planner or repo command is not executable",
      patterns: [
        /pnpm planner:propose.*not executable/i,
        /pnpm planner:publish.*not executable/i,
        /command .* not executable/i,
      ],
    },
  ];

  for (const matcher of matchers) {
    if (matcher.patterns.some((pattern) => pattern.test(text))) {
      return {
        signature: matcher.signature,
        label: matcher.label,
      };
    }
  }

  return null;
}

function extractRuntimeEventText(event: RuntimeEvent): string {
  const segments: string[] = [];

  if (event.type) {
    segments.push(event.type);
  }

  if (event.item?.type === "command_execution") {
    if (event.item.command) {
      segments.push(event.item.command);
    }
    if (event.item.aggregated_output) {
      segments.push(event.item.aggregated_output);
    }
    if (typeof event.item.exit_code === "number") {
      segments.push(`exit_code=${event.item.exit_code}`);
    }
    if (event.item.status) {
      segments.push(`status=${event.item.status}`);
    }
  }

  return segments.join("\n").trim();
}

async function runCodexCycle(status: RuntimeStatus, config: AutonomyConfig): Promise<CycleResult> {
  const prompt = runtimePrompt(status.threadId ? config.resumePrompt : config.basePrompt);
  const args = buildCodexArgs(status, config);
  const env = buildRuntimeEnvironment();

  const child = spawn(codexCommand(), args, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : false,
    env,
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
      runtimeCodexHome: path.relative(root, runtimeCodexHomePath),
      environmentMode: "repo-scoped",
    }),
    config,
  );

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdin.end(prompt);

  let stdoutBuffer = "";
  let stdoutSignalsBuffer = "";
  let stderrBuffer = "";

  const processStdoutLine = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const event = JSON.parse(trimmed) as RuntimeEvent;
      const eventText = extractRuntimeEventText(event);
      if (eventText) {
        stdoutSignalsBuffer = trimBuffer(`${stdoutSignalsBuffer}\n${eventText}`);
      }

      if (event.type === "thread.started" && event.thread_id) {
        await updateRuntimeStatus(
          (current) => ({
            ...current,
            threadId: event.thread_id ?? current.threadId,
            lastHeartbeat: nowIso(),
          }),
          config,
        );
        return;
      }
    } catch {
      stdoutSignalsBuffer = trimBuffer(`${stdoutSignalsBuffer}\n${trimmed}`);
    }

    await updateRuntimeStatus(
      (current) => ({
        ...current,
        lastHeartbeat: nowIso(),
      }),
      config,
    );
  };

  child.stdout.on("data", async (chunk: string) => {
    stdoutBuffer += chunk;
    stdoutBuffer = trimBuffer(stdoutBuffer);
    await appendLog(stdoutLogPath, chunk);

    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      await processStdoutLine(line);
    }
  });

  child.stderr.on("data", async (chunk: string) => {
    stderrBuffer += chunk;
    stderrBuffer = trimBuffer(stderrBuffer);
    await appendLog(stderrLogPath, chunk);
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

  if (stdoutBuffer.trim()) {
    await processStdoutLine(stdoutBuffer);
  }

  const lastMessage = existsSync(lastMessagePath) ? await readFile(lastMessagePath, "utf8") : "";
  const trimmedLastMessage = lastMessage.trim();
  const blocker = detectTerminalBlocker(trimmedLastMessage, stdoutSignalsBuffer, stderrBuffer);
  return {
    exitCode,
    lastMessage: trimmedLastMessage,
    stdoutText: stdoutSignalsBuffer.trim(),
    stderrText: stderrBuffer,
    blocker,
  };
}

function nextStateForCycle(
  cycleResult: CycleResult,
  matchedStopCondition: boolean,
  blockerCount: number,
  blockerBudget: number,
): RuntimeState {
  if (cycleResult.exitCode !== 0) {
    return "failed";
  }

  if (matchedStopCondition) {
    return "completed";
  }

  if (cycleResult.blocker && blockerCount >= blockerBudget) {
    return "blocked";
  }

  return "running";
}

function resultSummary(
  currentCycleCount: number,
  config: AutonomyConfig,
  cycleResult: CycleResult,
  matchedStopCondition: boolean,
  blockerCount: number,
  blockerBudget: number,
  nextState: RuntimeState,
): string {
  if (cycleResult.exitCode !== 0) {
    return cycleResult.blocker
      ? `Codex CLI exited with code ${cycleResult.exitCode}. Terminal blocker detected: ${cycleResult.blocker.label}.`
      : `Codex CLI exited with code ${cycleResult.exitCode}.`;
  }

  if (nextState === "blocked" && cycleResult.blocker) {
    return `Blocked after ${blockerCount} repeated terminal blocker cycle(s): ${cycleResult.blocker.label}.`;
  }

  if (matchedStopCondition) {
    return (
      formatSummary(cycleResult.lastMessage) ??
      `Stop condition "${config.selectedStopCondition}" matched.`
    );
  }

  if (cycleResult.blocker) {
    return `Terminal blocker detected (${blockerCount}/${blockerBudget}): ${cycleResult.blocker.label}. Runtime will stop automatically if it repeats.`;
  }

  return (
    formatSummary(cycleResult.lastMessage) ??
    `Cycle ${currentCycleCount + 1} completed. Stop condition not matched yet.`
  );
}

async function runWorker() {
  const projectConfig = await readProjectConfig();
  const config = projectConfig.autonomy ?? defaultAutonomyConfig();

  await ensureRepoScopedCodexHome(config);

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
      runtimeCodexHome: path.relative(root, runtimeCodexHomePath),
      environmentMode: "repo-scoped",
      maxConsecutiveTerminalBlockers: Math.max(1, config.maxConsecutiveTerminalBlockers),
    }),
    config,
  );

  while (true) {
    const status = await readRuntimeStatus(config);
    if (status.state === "stopped") {
      return;
    }

    const cycleResult = await runCodexCycle(status, config);
    const matchedStopCondition =
      cycleResult.exitCode === 0
        ? await evaluateStopCondition(config.selectedStopCondition, config.issueExportDirectory)
        : false;

    const blockerCount = cycleResult.blocker
      ? status.lastBlockerSignature === cycleResult.blocker.signature
        ? status.consecutiveTerminalBlockers + 1
        : 1
      : 0;
    const blockerBudget = Math.max(1, config.maxConsecutiveTerminalBlockers);
    const nextState = nextStateForCycle(cycleResult, matchedStopCondition, blockerCount, blockerBudget);

    await updateRuntimeStatus(
      (current) => ({
        ...current,
        state: nextState,
        workerPid: nextState === "running" ? process.pid : null,
        activeChildPid: null,
        lastHeartbeat: nowIso(),
        cycleCount: current.cycleCount + 1,
        latestResultSummary: resultSummary(
          current.cycleCount,
          config,
          cycleResult,
          matchedStopCondition,
          blockerCount,
          blockerBudget,
          nextState,
        ),
        consecutiveTerminalBlockers: cycleResult.blocker ? blockerCount : 0,
        lastBlockerSignature: cycleResult.blocker?.signature ?? null,
        maxConsecutiveTerminalBlockers: blockerBudget,
        lastExitCode: cycleResult.exitCode,
        runtimeCodexHome: path.relative(root, runtimeCodexHomePath),
        environmentMode: "repo-scoped",
      }),
      config,
    );

    if (nextState === "completed" || nextState === "failed" || nextState === "blocked") {
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
    !["stopped", "interrupted", "failed", "blocked"].includes(status.state)
  ) {
    throw new Error("runtime:resume is only valid from stopped, interrupted, failed, or blocked state.");
  }

  if (mode === "resume" && !status.threadId) {
    throw new Error("runtime:resume requires an existing Codex thread id in runtime state.");
  }

  await ensureRepoScopedCodexHome(config);

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
          consecutiveTerminalBlockers: 0,
          lastBlockerSignature: null,
          lastExitCode: null,
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
    env: buildRuntimeEnvironment(),
  });
  child.unref();

  await updateRuntimeStatus(
    (current) => ({
      ...current,
      workerPid: child.pid ?? null,
      latestResultSummary:
        mode === "start"
          ? "Background runtime started with repo-scoped Codex home."
          : "Background runtime resumed with repo-scoped Codex home.",
      runtimeCodexHome: path.relative(root, runtimeCodexHomePath),
      environmentMode: "repo-scoped",
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
  console.log(`Last exit code: ${effectiveStatus.lastExitCode ?? "n/a"}`);
  console.log(`Issue export directory: ${effectiveStatus.issueExportDirectory}`);
  console.log(`Runtime Codex home: ${effectiveStatus.runtimeCodexHome}`);
  console.log(`Environment mode: ${effectiveStatus.environmentMode}`);
  console.log(`Terminal blocker streak: ${effectiveStatus.consecutiveTerminalBlockers}/${effectiveStatus.maxConsecutiveTerminalBlockers}`);
  console.log(`Last blocker signature: ${effectiveStatus.lastBlockerSignature ?? "n/a"}`);
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
