import { execFileSync, spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { FileArtifactStore } from "./artifact-store";
import { doctorHarness, evaluateHarness, peekNextHarnessWork, reconcileHarnessRun, resumeHarness, runHarness } from "./engine";
import { readRunBoard, readRunEvents, rebuildAndWriteRunBoard } from "./run-board";
import { JsonStateBackend, JsonWorkerStatusBackend } from "./state-backend";
import { runShellCommand } from "./process";
import { createRunId, nowIso } from "./time";
import { createRunSpec } from "./targets";
import type {
  DoctorCheck,
  ExternalTargetConfig,
  HarnessCheckpoint,
  HarnessReadyWorkItem,
  HarnessRunSpec,
  HarnessWorkerStatus,
} from "./types";

export type HarnessCliArgs = {
  adapter: string | null;
  manifest: string;
  targetsFile: string;
  target: string | null;
  runId: string | null;
  model: string | null;
  task: string | null;
};

export function defaultCliArgs(): HarnessCliArgs {
  return {
    adapter: null,
    manifest: "harness.manifest.json",
    targetsFile: "harness.targets.json",
    target: null,
    runId: null,
    model: null,
    task: null,
  };
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

function tsxEntrypoint(controlRepoRoot: string) {
  return path.join(controlRepoRoot, "node_modules", "tsx", "dist", "cli.mjs");
}

function workerLogPaths(spec: HarnessRunSpec) {
  return {
    stdoutLog: path.join(spec.artifactRoot, "worker-stdout.log").replaceAll("\\", "/"),
    stderrLog: path.join(spec.artifactRoot, "worker-stderr.log").replaceAll("\\", "/"),
  };
}

function expandPathEntry(value: string, cwd: string) {
  const withPercentExpansion = value.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? "");
  const withEnvExpansion = withPercentExpansion.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => process.env[name] ?? "");
  const withTildeExpansion = withEnvExpansion.startsWith("~")
    ? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", withEnvExpansion.slice(1))
    : withEnvExpansion;
  return path.isAbsolute(withTildeExpansion) ? path.normalize(withTildeExpansion) : path.normalize(path.join(cwd, withTildeExpansion));
}

function applyPathEntries(entries: string[]) {
  if (entries.length === 0) {
    return [];
  }

  const existingPath = process.env.PATH ?? "";
  const currentEntries = existingPath.split(path.delimiter).filter(Boolean);
  const normalizedCurrent = new Set(currentEntries.map((item) => path.normalize(item).toLowerCase()));
  const applied: string[] = [];

  for (const entry of entries) {
    if (!existsSync(entry)) {
      continue;
    }
    const normalized = path.normalize(entry).toLowerCase();
    if (normalizedCurrent.has(normalized)) {
      continue;
    }
    currentEntries.unshift(entry);
    normalizedCurrent.add(normalized);
    applied.push(entry);
  }

  if (applied.length > 0) {
    process.env.PATH = currentEntries.join(path.delimiter);
  }

  return applied;
}

function summarizeFailedChecks(checks: DoctorCheck[]) {
  const failed = checks.filter((item) => !item.passed);
  if (failed.length === 0) {
    return null;
  }
  return failed.map((item) => `${item.label}: ${item.detail}`).join(" | ");
}

async function loadExternalTargetConfigForSpec(controlRepoRoot: string, args: HarnessCliArgs, spec: HarnessRunSpec) {
  if (spec.adapterId !== "external-generic") {
    return null;
  }

  const { target } = await createRunSpec({
    controlRepoRoot,
    manifestPath: args.manifest,
    targetRegistryPath: args.targetsFile,
    targetId: spec.targetId,
    adapterId: spec.adapterId,
    runId: spec.runId,
    model: spec.model,
    taskId: spec.taskId,
  });

  return {
    target,
    config: JSON.parse(await readFile(target.adapterConfigPath, "utf8")) as ExternalTargetConfig,
  };
}

async function ensureWorkerPrerequisites(controlRepoRoot: string, args: HarnessCliArgs, spec: HarnessRunSpec) {
  const externalTarget = await loadExternalTargetConfigForSpec(controlRepoRoot, args, spec);
  const bootstrap = externalTarget?.config.bootstrap;
  const resolvedPathEntries = (bootstrap?.pathEntries ?? [])
    .map((item) => expandPathEntry(item, externalTarget?.target.repoRoot ?? controlRepoRoot));

  applyPathEntries(resolvedPathEntries);

  let doctorResult = await doctorHarness({
    controlRepoRoot,
    manifestPath: args.manifest,
    targetRegistryPath: args.targetsFile,
    targetId: spec.targetId,
    adapterId: spec.adapterId,
  });
  let failedSummary = summarizeFailedChecks(doctorResult.checks);
  if (!failedSummary) {
    return {
      checks: doctorResult.checks,
      bootstrapAttempted: false,
      bootstrapSummary: null,
    };
  }

  if (!bootstrap?.enabled || !bootstrap.commands || bootstrap.commands.length === 0) {
    throw new Error(`Worker prerequisite check failed for ${spec.targetId}: ${failedSummary}`);
  }

  const bootstrapSummaries: string[] = [];
  for (const command of bootstrap.commands) {
    const result = await runShellCommand(command.command, externalTarget?.target.repoRoot ?? controlRepoRoot);
    const output = (result.stdout || result.stderr).trim();
    if (result.exitCode !== 0) {
      const detail = output ? ` ${output}` : "";
      throw new Error(`Bootstrap command "${command.label}" failed with exit code ${result.exitCode}.${detail}`);
    }
    bootstrapSummaries.push(command.label);
  }

  applyPathEntries(resolvedPathEntries);
  doctorResult = await doctorHarness({
    controlRepoRoot,
    manifestPath: args.manifest,
    targetRegistryPath: args.targetsFile,
    targetId: spec.targetId,
    adapterId: spec.adapterId,
  });
  failedSummary = summarizeFailedChecks(doctorResult.checks);
  if (failedSummary) {
    throw new Error(`Worker prerequisite check still failing after bootstrap for ${spec.targetId}: ${failedSummary}`);
  }

  return {
    checks: doctorResult.checks,
    bootstrapAttempted: true,
    bootstrapSummary: bootstrapSummaries.length > 0
      ? `Bootstrap completed: ${bootstrapSummaries.join(", ")}.`
      : "Bootstrap completed.",
  };
}

type WorkerLaunchPlan = {
  requestedMode: "run" | "resume";
  effectiveMode: "run" | "resume";
  runId: string;
  resumeSourceRunId: string | null;
  launchSummary: string;
};

async function writeWorkerCycleStatus(input: {
  backend: JsonWorkerStatusBackend;
  spec: HarnessRunSpec;
  runId: string;
  startedAt: string;
  item: HarnessReadyWorkItem;
  latestSummary: string;
}) {
  const logs = workerLogPaths(input.spec);
  await input.backend.write({
    state: "running",
    workerPid: process.pid,
    runId: input.runId,
    targetId: input.spec.targetId,
    adapterId: input.spec.adapterId,
    phase: "plan",
    activeLane: "planner",
    activeTaskId: "lane:planner:main",
    activeTaskTitle: `Planning ${input.item.id}`,
    activeSubagentCount: 0,
    caseId: input.item.id,
    title: input.item.title,
    threadId: null,
    startedAt: input.startedAt,
    updatedAt: nowIso(),
    latestSummary: input.latestSummary,
    latestCheckpoint: null,
    stdoutLog: logs.stdoutLog,
    stderrLog: logs.stderrLog,
  });
}

export async function buildSpec(controlRepoRoot: string, args: HarnessCliArgs, runId?: string | null): Promise<HarnessRunSpec> {
  const { spec } = await createRunSpec({
    controlRepoRoot,
    manifestPath: args.manifest,
    targetRegistryPath: args.targetsFile,
    targetId: args.target,
    adapterId: args.adapter,
    runId: runId ?? args.runId ?? createRunId(),
    model: args.model,
    taskId: args.task,
  });
  return spec;
}

export async function readWorkerStatus(spec: HarnessRunSpec) {
  const backend = new JsonWorkerStatusBackend(spec);
  return {
    backend,
    status: await backend.read(),
  };
}

export async function enrichWorkerStatus(spec: HarnessRunSpec, status: HarnessWorkerStatus) {
  if (!status.runId) {
    return status;
  }

  const liveSpec: HarnessRunSpec = { ...spec, runId: status.runId, adapterId: status.adapterId ?? spec.adapterId };
  const liveBackend = new JsonStateBackend(liveSpec);
  const liveState = await liveBackend.read();
  const artifactStore = new FileArtifactStore(liveSpec);
  await artifactStore.ensure();
  const events = await readRunEvents(artifactStore).catch(() => [] as Awaited<ReturnType<typeof readRunEvents>>);
  const board = events.length > 0
    ? await rebuildAndWriteRunBoard(liveSpec, artifactStore).catch(() => null)
    : await readRunBoard(artifactStore).catch(() => null);
  if (liveState.runId !== status.runId) {
    return {
      ...status,
      updatedAt: board?.updatedAt ?? status.updatedAt,
      latestSummary: board?.latestSummary ?? status.latestSummary,
      activeLane: board?.activeLane ?? status.activeLane,
      activeTaskId: board?.activeNodeId ?? status.activeTaskId,
      activeTaskTitle: board?.tasks.find((task) => task.id === board.activeNodeId)?.title ?? status.activeTaskTitle,
      activeSubagentCount: board?.lanes.subagents.runningTasks ?? status.activeSubagentCount,
    };
  }

  return {
    ...status,
    targetId: status.targetId ?? liveState.targetId ?? spec.targetId,
    adapterId: status.adapterId ?? liveState.adapterId ?? spec.adapterId,
    phase: liveState.phase ?? status.phase,
    caseId: liveState.caseId ?? status.caseId,
    title: liveState.title ?? status.title,
    threadId: liveState.threadId ?? status.threadId,
    latestSummary: board?.latestSummary ?? liveState.latestSummary ?? status.latestSummary,
    latestCheckpoint: liveState.latestCheckpoint ?? status.latestCheckpoint,
    startedAt: liveState.startedAt ?? status.startedAt,
    updatedAt: board?.updatedAt ?? liveState.updatedAt ?? status.updatedAt,
    activeLane: board?.activeLane ?? status.activeLane,
    activeTaskId: board?.activeNodeId ?? status.activeTaskId,
    activeTaskTitle: board?.tasks.find((task) => task.id === board.activeNodeId)?.title ?? status.activeTaskTitle,
    activeSubagentCount: board?.lanes.subagents.runningTasks ?? status.activeSubagentCount,
  };
}

export async function updateLiveStateToInterrupted(spec: HarnessRunSpec, status: HarnessWorkerStatus) {
  if (!status.runId) {
    return;
  }

  const liveSpec: HarnessRunSpec = { ...spec, runId: status.runId, adapterId: status.adapterId ?? spec.adapterId };
  const backend = new JsonStateBackend(liveSpec);
  await backend.update((current) => ({
    ...current,
    status: "interrupted",
    phase: current.phase,
    runId: status.runId,
    targetId: status.targetId ?? current.targetId,
    adapterId: status.adapterId ?? current.adapterId,
    caseId: status.caseId ?? current.caseId,
    title: status.title ?? current.title,
    threadId: status.threadId ?? current.threadId,
    latestSummary: "Harness worker stopped by operator.",
    failureReason: null,
    updatedAt: nowIso(),
  }));
}

export async function getEffectiveWorkerStatus(controlRepoRoot: string, args: HarnessCliArgs) {
  const spec = await buildSpec(controlRepoRoot, args);
  const { backend, status } = await readWorkerStatus(spec);
  let effective = await enrichWorkerStatus(spec, status);
  let shouldPersist = JSON.stringify(effective) !== JSON.stringify(status);

  if (
    effective.runId
    && (
      effective.state === "interrupted"
      || effective.state === "failed"
      || ((effective.state === "starting" || effective.state === "running") && !isProcessAlive(effective.workerPid))
    )
  ) {
    await reconcileHarnessRun({
      controlRepoRoot,
      manifestPath: args.manifest,
      targetRegistryPath: args.targetsFile,
      targetId: spec.targetId,
      adapterId: spec.adapterId,
      runId: effective.runId,
      model: args.model,
    }).catch(() => null);
    effective = await enrichWorkerStatus(spec, await backend.read());
    shouldPersist = true;
  }

  if (effective.runId) {
    const liveSpec = { ...spec, runId: effective.runId, adapterId: effective.adapterId ?? spec.adapterId };
    const liveState = await new JsonStateBackend(liveSpec).read();
    if (liveState.runId === effective.runId && (liveState.status === "completed" || liveState.status === "failed")) {
      effective = {
        ...effective,
        state: liveState.status === "completed" ? "completed" : "failed",
        phase: liveState.phase ?? effective.phase,
        latestSummary: liveState.latestSummary ?? effective.latestSummary,
        latestCheckpoint: liveState.latestCheckpoint ?? effective.latestCheckpoint,
        updatedAt: liveState.updatedAt ?? effective.updatedAt,
      };
      shouldPersist = true;
    }
  }

  if ((effective.state === "starting" || effective.state === "running") && !isProcessAlive(effective.workerPid)) {
    effective = {
      ...effective,
      state: "interrupted",
      workerPid: null,
      updatedAt: nowIso(),
      latestSummary: effective.latestSummary ?? "Harness worker is no longer running.",
    };
    shouldPersist = true;
  }

  if (shouldPersist) {
    await backend.write(effective);
  }

  return { spec, backend, status: effective };
}

export function formatWorkerStatus(status: HarnessWorkerStatus) {
  return [
    `Target: ${status.targetId ?? "n/a"}`,
    `State: ${status.state}`,
    `Worker PID: ${status.workerPid ?? "n/a"}`,
    `Run ID: ${status.runId ?? "n/a"}`,
    `Adapter: ${status.adapterId ?? "n/a"}`,
    `Phase: ${status.phase ?? "n/a"}`,
    `Active lane: ${status.activeLane ?? "n/a"}`,
    `Active task: ${status.activeTaskTitle ?? status.activeTaskId ?? "n/a"}`,
    `Active subagents: ${status.activeSubagentCount}`,
    `Case ID: ${status.caseId ?? "n/a"}`,
    `Title: ${status.title ?? "n/a"}`,
    `Thread ID: ${status.threadId ?? "n/a"}`,
    `Started: ${status.startedAt ?? "n/a"}`,
    `Updated: ${status.updatedAt}`,
    `Latest checkpoint: ${status.latestCheckpoint ?? "n/a"}`,
    `Latest summary: ${status.latestSummary ?? "n/a"}`,
    `Stdout log: ${status.stdoutLog}`,
    `Stderr log: ${status.stderrLog}`,
  ];
}

export async function startBackgroundWorker(controlRepoRoot: string, mode: "run" | "resume", args: HarnessCliArgs) {
  const launch = await resolveWorkerLaunchPlan(controlRepoRoot, mode, args);
  const runId = launch.runId;
  const spec = await buildSpec(controlRepoRoot, args, runId);
  const backend = new JsonWorkerStatusBackend(spec);
  const current = await backend.read();

  if ((current.state === "starting" || current.state === "running") && isProcessAlive(current.workerPid)) {
    throw new Error("Harness worker is already active. Run `pnpm harness:worker:status` or `pnpm harness:worker:stop` first.");
  }

  await mkdir(path.join(controlRepoRoot, spec.artifactRoot), { recursive: true });
  const stdoutLog = path.join(controlRepoRoot, spec.artifactRoot, "worker-stdout.log");
  const stderrLog = path.join(controlRepoRoot, spec.artifactRoot, "worker-stderr.log");
  await writeFile(stdoutLog, "", "utf8");
  await writeFile(stderrLog, "", "utf8");

  await backend.write({
    state: "starting",
    workerPid: null,
    runId,
    targetId: spec.targetId,
    adapterId: spec.adapterId,
    phase: "plan",
    activeLane: "planner",
    activeTaskId: "lane:planner:main",
    activeTaskTitle: "Checking worker prerequisites",
    activeSubagentCount: 0,
    caseId: null,
    title: null,
    threadId: null,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    latestSummary: "Running doctor checks before worker start.",
    latestCheckpoint: null,
    stdoutLog: path.relative(controlRepoRoot, stdoutLog).replaceAll("\\", "/"),
    stderrLog: path.relative(controlRepoRoot, stderrLog).replaceAll("\\", "/"),
  });

  try {
    const prerequisiteResult = await ensureWorkerPrerequisites(controlRepoRoot, args, spec);
    await backend.update((existing) => ({
      ...existing,
      latestSummary: prerequisiteResult.bootstrapAttempted
        ? prerequisiteResult.bootstrapSummary ?? "Worker prerequisites satisfied after bootstrap."
        : "Worker prerequisites satisfied.",
      updatedAt: nowIso(),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await backend.write({
      state: "failed",
      workerPid: null,
      runId,
      targetId: spec.targetId,
      adapterId: spec.adapterId,
      phase: "plan",
      activeLane: "planner",
      activeTaskId: "lane:planner:main",
      activeTaskTitle: "Worker prerequisite check failed",
      activeSubagentCount: 0,
      caseId: null,
      title: null,
      threadId: null,
      startedAt: nowIso(),
      updatedAt: nowIso(),
      latestSummary: message,
      latestCheckpoint: null,
      stdoutLog: path.relative(controlRepoRoot, stdoutLog).replaceAll("\\", "/"),
      stderrLog: path.relative(controlRepoRoot, stderrLog).replaceAll("\\", "/"),
    });
    throw error;
  }

  await backend.write({
    state: "starting",
    workerPid: null,
    runId,
    targetId: spec.targetId,
    adapterId: spec.adapterId,
    phase: "plan",
    activeLane: "planner",
    activeTaskId: "lane:planner:main",
    activeTaskTitle: "Harness worker starting",
    activeSubagentCount: 0,
    caseId: null,
    title: null,
    threadId: null,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    latestSummary: launch.launchSummary,
    latestCheckpoint: null,
    stdoutLog: path.relative(controlRepoRoot, stdoutLog).replaceAll("\\", "/"),
    stderrLog: path.relative(controlRepoRoot, stderrLog).replaceAll("\\", "/"),
  });

  const childArgs = [
    tsxEntrypoint(controlRepoRoot),
    path.join(controlRepoRoot, "scripts", "harness-worker.ts"),
    "worker",
    launch.effectiveMode,
    "--manifest",
    args.manifest,
    "--targets-file",
    args.targetsFile,
    "--run-id",
    runId,
    "--target",
    spec.targetId,
  ];
  if (spec.adapterId) {
    childArgs.push("--adapter", spec.adapterId);
  }
  if (args.model) {
    childArgs.push("--model", args.model);
  }
  if (args.task) {
    childArgs.push("--task", args.task);
  }

  const child = spawn(process.execPath, childArgs, {
    cwd: controlRepoRoot,
    detached: true,
    stdio: ["ignore", openSync(stdoutLog, "a"), openSync(stderrLog, "a")],
  });
  child.unref();

  await backend.update((existing) => ({
    ...existing,
    state: "running",
    workerPid: child.pid ?? null,
    latestSummary: launch.effectiveMode === "run"
      ? (launch.resumeSourceRunId
          ? `Previous run ${launch.resumeSourceRunId} already completed. Starting the next ready work item as ${runId}.`
          : `Harness worker started for ${runId}.`)
      : `Harness worker resumed for ${runId}.`,
  }));

  return {
    spec,
    backend,
    runId,
  };
}

export async function stopBackgroundWorker(controlRepoRoot: string, args: HarnessCliArgs) {
  const spec = await buildSpec(controlRepoRoot, args);
  const { backend, status } = await readWorkerStatus(spec);

  if (!status.workerPid || !isProcessAlive(status.workerPid)) {
    return {
      spec,
      stopped: false,
      status,
    };
  }

  terminateProcess(status.workerPid);
  if (status.runId) {
    await reconcileHarnessRun({
      controlRepoRoot,
      manifestPath: args.manifest,
      targetRegistryPath: args.targetsFile,
      targetId: spec.targetId,
      adapterId: spec.adapterId,
      runId: status.runId,
      model: args.model,
    }).catch(() => null);
  }
  const next = await enrichWorkerStatus(spec, status);
  if (status.runId) {
    const liveSpec = { ...spec, runId: status.runId, adapterId: status.adapterId ?? spec.adapterId };
    const liveState = await new JsonStateBackend(liveSpec).read();
    if (liveState.runId === status.runId && (liveState.status === "completed" || liveState.status === "failed")) {
      const settledState = liveState.status === "completed" ? "completed" : "failed";
      const settled = {
        ...next,
        state: settledState,
        workerPid: null,
        updatedAt: nowIso(),
        latestSummary: liveState.latestSummary ?? next.latestSummary,
        latestCheckpoint: liveState.latestCheckpoint ?? next.latestCheckpoint,
      } satisfies HarnessWorkerStatus;
      await backend.write(settled);
      return {
        spec,
        stopped: true,
        status: settled,
      };
    }
  }
  await backend.write({
    ...next,
    state: "interrupted",
    workerPid: null,
    updatedAt: nowIso(),
    latestSummary: "Harness worker stopped by operator.",
  });
  await updateLiveStateToInterrupted(spec, next);

  return {
    spec,
    stopped: true,
    status: {
      ...next,
      state: "interrupted" as const,
      workerPid: null,
      updatedAt: nowIso(),
      latestSummary: "Harness worker stopped by operator.",
    },
  };
}

export async function resolveResumeRunId(controlRepoRoot: string, args: HarnessCliArgs) {
  if (args.runId) {
    return args.runId;
  }

  const spec = await buildSpec(controlRepoRoot, args);
  const status = await new JsonWorkerStatusBackend(spec).read();
  if (status.runId) {
    return status.runId;
  }

  const liveState = await new JsonStateBackend(spec).read();
  if (liveState.runId) {
    return liveState.runId;
  }

  throw new Error("harness:worker:resume requires a known run id. Pass `--run-id <run-id>`.");
}

async function resolveWorkerLaunchPlan(
  controlRepoRoot: string,
  mode: "run" | "resume",
  args: HarnessCliArgs,
): Promise<WorkerLaunchPlan> {
  if (mode === "run") {
    return {
      requestedMode: mode,
      effectiveMode: "run",
      runId: args.runId ?? createRunId(),
      resumeSourceRunId: null,
      launchSummary: "Harness worker starting.",
    };
  }

  const requestedRunId = await resolveResumeRunId(controlRepoRoot, args);
  const spec = await buildSpec(controlRepoRoot, { ...args, runId: requestedRunId }, requestedRunId);
  const liveState = await new JsonStateBackend(spec).read();
  const checkpoint = await new FileArtifactStore(spec).readJson<HarnessCheckpoint>("checkpoint.json").catch(() => null);
  const liveStatus = liveState.runId === requestedRunId ? liveState.status : null;
  const alreadyCompleted = checkpoint?.phase === "handoff" || liveStatus === "completed" || liveStatus === "failed";

  if (alreadyCompleted) {
    return {
      requestedMode: mode,
      effectiveMode: "run",
      runId: createRunId(),
      resumeSourceRunId: requestedRunId,
      launchSummary: `Run ${requestedRunId} already reached handoff. Starting the next ready work item instead.`,
    };
  }

  return {
    requestedMode: mode,
    effectiveMode: "resume",
    runId: requestedRunId,
    resumeSourceRunId: requestedRunId,
    launchSummary: `Harness worker resuming ${requestedRunId}.`,
  };
}

export async function runWorkerProcess(controlRepoRoot: string, mode: "run" | "resume", args: HarnessCliArgs) {
  const launch = await resolveWorkerLaunchPlan(controlRepoRoot, mode, args);
  const initialRunId = launch.runId;
  const spec = await buildSpec(controlRepoRoot, { ...args, runId: initialRunId, target: args.target }, initialRunId);
  const backend = new JsonWorkerStatusBackend(spec);
  const workerStartedAt = nowIso();
  const continuousMode = launch.requestedMode === "resume" || !args.task;
  const logs = workerLogPaths(spec);
  let activeRunId = initialRunId;

  await backend.update((current) => ({
    ...current,
    state: "running",
    workerPid: process.pid,
    runId: initialRunId,
    targetId: spec.targetId,
    adapterId: spec.adapterId,
    phase: current.phase ?? "plan",
    activeLane: current.activeLane ?? "planner",
    activeTaskId: current.activeTaskId ?? "lane:planner:main",
    activeTaskTitle: current.activeTaskTitle ?? (launch.effectiveMode === "run" ? "Harness cycle starting" : "Harness cycle resuming"),
    activeSubagentCount: current.activeSubagentCount ?? 0,
    startedAt: current.startedAt ?? workerStartedAt,
    latestSummary: launch.launchSummary,
  }));

  try {
    let cycleMode = launch.effectiveMode;
    let currentRunId = initialRunId;
    let currentTaskId = args.task;
    let completedCycles = 0;
    let pendingPreview: Awaited<ReturnType<typeof peekNextHarnessWork>> | null = null;

    while (true) {
      activeRunId = currentRunId;
      if (cycleMode === "run") {
        const preview = pendingPreview ?? await peekNextHarnessWork({
          controlRepoRoot,
          manifestPath: args.manifest,
          targetRegistryPath: args.targetsFile,
          targetId: spec.targetId,
          adapterId: spec.adapterId,
          runId: currentRunId,
          model: args.model,
          taskId: currentTaskId,
        });
        pendingPreview = null;
        currentRunId = preview.spec.runId;
        activeRunId = preview.spec.runId;

        if (!preview.item) {
          await backend.write({
            state: "completed",
            workerPid: null,
            runId: preview.spec.runId,
            targetId: spec.targetId,
            adapterId: spec.adapterId,
            phase: completedCycles > 0 ? "handoff" : "plan",
            activeLane: completedCycles > 0 ? "handoff" : "planner",
            activeTaskId: completedCycles > 0 ? "lane:handoff:main" : "lane:planner:main",
            activeTaskTitle: completedCycles > 0 ? "No ready work remains" : "Planner found no next work",
            activeSubagentCount: 0,
            caseId: null,
            title: null,
            threadId: null,
            startedAt: workerStartedAt,
            updatedAt: nowIso(),
            latestSummary: preview.summary ?? (completedCycles > 0
              ? `Completed ${completedCycles} cycle(s). No ready work remains for ${spec.targetId}.`
              : `No ready work is available for ${spec.targetId}.`),
            latestCheckpoint: null,
            stdoutLog: logs.stdoutLog,
            stderrLog: logs.stderrLog,
          });
          return;
        }

        await writeWorkerCycleStatus({
          backend,
          spec,
          runId: preview.spec.runId,
          startedAt: workerStartedAt,
          item: preview.item,
          latestSummary: preview.item.generationSummary ?? (completedCycles > 0
            ? `Starting next cycle for ${preview.item.id}.`
            : `Running harness cycle ${preview.spec.runId}.`),
        });
      }

      const result = cycleMode === "run"
        ? await runHarness({
            controlRepoRoot,
            manifestPath: args.manifest,
            targetRegistryPath: args.targetsFile,
            targetId: spec.targetId,
            adapterId: spec.adapterId,
            runId: currentRunId,
            model: args.model,
            taskId: currentTaskId,
          })
        : await resumeHarness({
            controlRepoRoot,
            manifestPath: args.manifest,
            targetRegistryPath: args.targetsFile,
            targetId: spec.targetId,
            adapterId: spec.adapterId,
            runId: currentRunId,
            model: args.model,
          });

      completedCycles += 1;
      currentRunId = result.spec.runId;
      activeRunId = result.spec.runId;

      const liveState = await new JsonStateBackend(result.spec).read();
      const board = await readRunBoard(new FileArtifactStore(result.spec)).catch(() => null);
      const effectiveLiveState = liveState.runId === result.spec.runId
        ? liveState
        : {
            ...liveState,
            phase: "handoff" as const,
            caseId: result.contract.caseId,
            title: result.contract.title,
            threadId: result.execution.threadId,
            latestCheckpoint: null,
            latestSummary: result.execution.lastMessage ?? "Harness worker completed.",
            startedAt: workerStartedAt,
          };

      const writeTerminalStatus = async (latestSummary: string) => {
        await backend.write({
          state: result.evaluation.passed ? "completed" : "failed",
          workerPid: null,
          runId: result.spec.runId,
          targetId: result.spec.targetId,
          adapterId: result.spec.adapterId,
          phase: effectiveLiveState.phase,
          activeLane: board?.activeLane ?? null,
          activeTaskId: board?.activeNodeId ?? null,
          activeTaskTitle: board?.tasks.find((task) => task.id === board.activeNodeId)?.title ?? null,
          activeSubagentCount: board?.lanes.subagents.runningTasks ?? 0,
          caseId: effectiveLiveState.caseId,
          title: effectiveLiveState.title,
          threadId: result.execution.threadId,
          startedAt: workerStartedAt,
          updatedAt: nowIso(),
          latestSummary,
          latestCheckpoint: effectiveLiveState.latestCheckpoint,
          stdoutLog: logs.stdoutLog,
          stderrLog: logs.stderrLog,
        });
      };

      if (!continuousMode) {
        await writeTerminalStatus(
          effectiveLiveState.latestSummary ?? result.execution.lastMessage ?? "Harness worker completed.",
        );
        return;
      }

      const nextRunId = createRunId();
      activeRunId = nextRunId;
      await backend.write({
        state: "running",
        workerPid: process.pid,
        runId: nextRunId,
        targetId: result.spec.targetId,
        adapterId: result.spec.adapterId,
        phase: "plan",
        activeLane: "planner",
        activeTaskId: "lane:planner:main",
        activeTaskTitle: `Planning next cycle after ${result.contract.caseId}`,
        activeSubagentCount: 0,
        caseId: null,
        title: null,
        threadId: null,
        startedAt: workerStartedAt,
        updatedAt: nowIso(),
        latestSummary: `Preparing next cycle after ${result.contract.caseId}.`,
        latestCheckpoint: null,
        stdoutLog: logs.stdoutLog,
        stderrLog: logs.stderrLog,
      });
      pendingPreview = await peekNextHarnessWork({
        controlRepoRoot,
        manifestPath: args.manifest,
        targetRegistryPath: args.targetsFile,
        targetId: spec.targetId,
        adapterId: spec.adapterId,
        runId: nextRunId,
        model: args.model,
        taskId: null,
      });

      if (!pendingPreview.item) {
        await backend.write({
          state: "completed",
          workerPid: null,
          runId: pendingPreview.spec.runId,
          targetId: result.spec.targetId,
          adapterId: result.spec.adapterId,
          phase: "plan",
          activeLane: "planner",
          activeTaskId: "lane:planner:main",
          activeTaskTitle: "Planner found no next work",
          activeSubagentCount: 0,
          caseId: null,
          title: null,
          threadId: null,
          startedAt: workerStartedAt,
          updatedAt: nowIso(),
          latestSummary: pendingPreview.summary ?? `Completed ${completedCycles} cycle(s). No ready work remains for ${result.spec.targetId}.`,
          latestCheckpoint: null,
          stdoutLog: logs.stdoutLog,
          stderrLog: logs.stderrLog,
        });
        return;
      }

      cycleMode = "run";
      currentTaskId = null;
      currentRunId = nextRunId;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const activeSpec: HarnessRunSpec = { ...spec, runId: activeRunId };
    const liveState = await new JsonStateBackend(activeSpec).read();
    const board = await readRunBoard(new FileArtifactStore(activeSpec)).catch(() => null);
    if (liveState.runId !== activeRunId) {
      await new JsonStateBackend(activeSpec).update((current) => ({
        ...current,
        status: "failed",
        phase: current.phase ?? "plan",
        runId: activeRunId,
        targetId: spec.targetId,
        adapterId: spec.adapterId,
        threadId: null,
        startedAt: current.startedAt ?? nowIso(),
        latestCheckpoint: null,
        latestSummary: message,
        failureReason: message,
        updatedAt: nowIso(),
      }));
    }
    const effectiveLiveState = liveState.runId === activeRunId
      ? liveState
      : {
          ...liveState,
          phase: liveState.phase ?? "plan",
          threadId: null,
          latestCheckpoint: null,
          latestSummary: message,
          startedAt: workerStartedAt,
        };
    await backend.write({
      state: "failed",
      workerPid: null,
      runId: activeRunId,
      targetId: spec.targetId,
      adapterId: spec.adapterId,
      phase: effectiveLiveState.phase,
      activeLane: board?.activeLane ?? null,
      activeTaskId: board?.activeNodeId ?? null,
      activeTaskTitle: board?.tasks.find((task) => task.id === board.activeNodeId)?.title ?? null,
      activeSubagentCount: board?.lanes.subagents.runningTasks ?? 0,
      caseId: effectiveLiveState.caseId,
      title: effectiveLiveState.title,
      threadId: effectiveLiveState.threadId,
      startedAt: effectiveLiveState.startedAt ?? workerStartedAt,
      updatedAt: nowIso(),
      latestSummary: message,
      latestCheckpoint: effectiveLiveState.latestCheckpoint,
      stdoutLog: logs.stdoutLog,
      stderrLog: logs.stderrLog,
    });
    throw error;
  }
}

export async function runManualEvaluation(controlRepoRoot: string, args: HarnessCliArgs) {
  if (!args.runId) {
    throw new Error("Usage: pnpm harness:eval -- --target <target-id> --run-id <run-id>");
  }

  return evaluateHarness({
    controlRepoRoot,
    manifestPath: args.manifest,
    targetRegistryPath: args.targetsFile,
    targetId: args.target,
    adapterId: args.adapter,
    runId: args.runId,
  });
}

export function workerLogAbsolutePaths(spec: HarnessRunSpec) {
  return {
    stdoutLog: path.join(spec.controlRepoRoot, spec.artifactRoot, "worker-stdout.log"),
    stderrLog: path.join(spec.controlRepoRoot, spec.artifactRoot, "worker-stderr.log"),
  };
}

export function workerScriptExists(controlRepoRoot: string) {
  return existsSync(path.join(controlRepoRoot, "scripts", "harness-worker.ts"));
}
