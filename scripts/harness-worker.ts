import { execFileSync, spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadHarnessManifest } from "../src/harness/manifest";
import { JsonStateBackend, JsonWorkerStatusBackend } from "../src/harness/state-backend";
import { createRunId, nowIso } from "../src/harness/time";
import { type HarnessRunSpec, type HarnessWorkerStatus } from "../src/harness/types";
import { resumeHarness, runHarness } from "../src/harness/engine";

type Args = {
  adapter: string | null;
  manifest: string;
  runId: string | null;
  model: string | null;
  task: string | null;
};

const root = process.cwd();

function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    adapter: null,
    manifest: "harness.manifest.json",
    runId: null,
    model: null,
    task: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--adapter" && next) {
      parsed.adapter = next;
      index += 1;
      continue;
    }
    if (current === "--manifest" && next) {
      parsed.manifest = next;
      index += 1;
      continue;
    }
    if (current === "--run-id" && next) {
      parsed.runId = next;
      index += 1;
      continue;
    }
    if (current === "--model" && next) {
      parsed.model = next;
      index += 1;
      continue;
    }
    if (current === "--task" && next) {
      parsed.task = next;
      index += 1;
    }
  }

  return parsed;
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

function tsxEntrypoint() {
  return path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
}

async function buildSpec(args: Args, runId?: string | null): Promise<HarnessRunSpec> {
  const manifestFile = await loadHarnessManifest(root, args.manifest);
  return {
    adapterId: args.adapter ?? manifestFile.defaultAdapter,
    artifactRoot: manifestFile.artifactRoot,
    manifestPath: args.manifest,
    repoRoot: root,
    runId: runId ?? args.runId ?? createRunId(),
    model: args.model,
    taskId: args.task,
  };
}

async function readWorkerStatus(spec: HarnessRunSpec) {
  const backend = new JsonWorkerStatusBackend(spec);
  return {
    backend,
    status: await backend.read(),
  };
}

async function enrichWorkerStatus(spec: HarnessRunSpec, status: HarnessWorkerStatus) {
  if (!status.runId) {
    return status;
  }

  const liveSpec: HarnessRunSpec = { ...spec, runId: status.runId, adapterId: status.adapterId ?? spec.adapterId };
  const liveBackend = new JsonStateBackend(liveSpec);
  const liveState = await liveBackend.read();
  if (liveState.runId !== status.runId) {
    return status;
  }

  return {
    ...status,
    adapterId: status.adapterId ?? liveState.adapterId ?? spec.adapterId,
    threadId: liveState.threadId ?? status.threadId,
    latestSummary: liveState.latestSummary ?? status.latestSummary,
    latestCheckpoint: liveState.latestCheckpoint ?? status.latestCheckpoint,
    startedAt: liveState.startedAt ?? status.startedAt,
  };
}

async function updateLiveStateToInterrupted(spec: HarnessRunSpec, status: HarnessWorkerStatus) {
  if (!status.runId) {
    return;
  }

  const liveSpec: HarnessRunSpec = { ...spec, runId: status.runId, adapterId: status.adapterId ?? spec.adapterId };
  const backend = new JsonStateBackend(liveSpec);
  await backend.update((current) => ({
    ...current,
    status: "interrupted",
    runId: status.runId,
    adapterId: status.adapterId ?? current.adapterId,
    threadId: status.threadId ?? current.threadId,
    latestSummary: "Harness worker stopped by operator.",
    failureReason: null,
    updatedAt: nowIso(),
  }));
}

async function commandStatus(args: Args) {
  const spec = await buildSpec(args);
  const { backend, status } = await readWorkerStatus(spec);
  let effective = await enrichWorkerStatus(spec, status);

  if ((effective.state === "starting" || effective.state === "running") && !isProcessAlive(effective.workerPid)) {
    effective = {
      ...effective,
      state: "interrupted",
      workerPid: null,
      updatedAt: nowIso(),
      latestSummary: effective.latestSummary ?? "Harness worker is no longer running.",
    };
    await backend.write(effective);
  }

  console.log(`State: ${effective.state}`);
  console.log(`Worker PID: ${effective.workerPid ?? "n/a"}`);
  console.log(`Run ID: ${effective.runId ?? "n/a"}`);
  console.log(`Adapter: ${effective.adapterId ?? "n/a"}`);
  console.log(`Thread ID: ${effective.threadId ?? "n/a"}`);
  console.log(`Started: ${effective.startedAt ?? "n/a"}`);
  console.log(`Updated: ${effective.updatedAt}`);
  console.log(`Latest checkpoint: ${effective.latestCheckpoint ?? "n/a"}`);
  console.log(`Latest summary: ${effective.latestSummary ?? "n/a"}`);
  console.log(`Stdout log: ${effective.stdoutLog}`);
  console.log(`Stderr log: ${effective.stderrLog}`);
}

async function spawnWorker(mode: "run" | "resume", args: Args) {
  const runId = args.runId ?? createRunId();
  const spec = await buildSpec(args, runId);
  const backend = new JsonWorkerStatusBackend(spec);
  const current = await backend.read();

  if ((current.state === "starting" || current.state === "running") && isProcessAlive(current.workerPid)) {
    throw new Error("Harness worker is already active. Run `pnpm harness:worker:status` or `pnpm harness:worker:stop` first.");
  }

  await mkdir(path.join(root, spec.artifactRoot), { recursive: true });
  const stdoutLog = path.join(root, spec.artifactRoot, "worker-stdout.log");
  const stderrLog = path.join(root, spec.artifactRoot, "worker-stderr.log");
  await writeFile(stdoutLog, "", "utf8");
  await writeFile(stderrLog, "", "utf8");

  await backend.write({
    state: "starting",
    workerPid: null,
    runId,
    adapterId: spec.adapterId,
    threadId: null,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    latestSummary: mode === "run" ? "Harness worker starting." : "Harness worker resuming.",
    latestCheckpoint: null,
    stdoutLog: path.relative(root, stdoutLog).replaceAll("\\", "/"),
    stderrLog: path.relative(root, stderrLog).replaceAll("\\", "/"),
  });

  const childArgs = [
    tsxEntrypoint(),
    path.join(root, "scripts", "harness-worker.ts"),
    "worker",
    mode,
    "--manifest",
    args.manifest,
    "--run-id",
    runId,
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
    cwd: root,
    detached: true,
    stdio: ["ignore", openSync(stdoutLog, "a"), openSync(stderrLog, "a")],
  });
  child.unref();

  await backend.update((existing) => ({
    ...existing,
    state: "running",
    workerPid: child.pid ?? null,
    latestSummary: mode === "run" ? `Harness worker started for ${runId}.` : `Harness worker resumed for ${runId}.`,
  }));

  console.log(`Harness worker ${mode === "run" ? "started" : "resumed"} in background.`);
  console.log(`Run ID: ${runId}`);
  console.log(`Status file: ${backend.path()}`);
}

async function commandStop(args: Args) {
  const spec = await buildSpec(args);
  const { backend, status } = await readWorkerStatus(spec);

  if (!status.workerPid || !isProcessAlive(status.workerPid)) {
    console.log("No active harness worker is running.");
    return;
  }

  terminateProcess(status.workerPid);
  const next = await enrichWorkerStatus(spec, status);
  await backend.write({
    ...next,
    state: "interrupted",
    workerPid: null,
    updatedAt: nowIso(),
    latestSummary: "Harness worker stopped by operator.",
  });
  await updateLiveStateToInterrupted(spec, next);

  console.log("Harness worker stopped.");
}

async function resolveResumeRunId(args: Args) {
  if (args.runId) {
    return args.runId;
  }

  const spec = await buildSpec(args);
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

async function commandWorker(mode: "run" | "resume", args: Args) {
  const runId = mode === "resume" ? await resolveResumeRunId(args) : (args.runId ?? createRunId());
  const spec = await buildSpec({ ...args, runId }, runId);
  const backend = new JsonWorkerStatusBackend(spec);

  await backend.update((current) => ({
    ...current,
    state: "running",
    workerPid: process.pid,
    runId,
    adapterId: spec.adapterId,
    startedAt: current.startedAt ?? nowIso(),
    latestSummary: mode === "run" ? `Running harness cycle ${runId}.` : `Resuming harness cycle ${runId}.`,
  }));

  try {
    const result = mode === "run"
      ? await runHarness({
          repoRoot: root,
          manifestPath: args.manifest,
          adapterId: spec.adapterId,
          runId,
          model: args.model,
          taskId: args.task,
        })
      : await resumeHarness({
          repoRoot: root,
          manifestPath: args.manifest,
          adapterId: spec.adapterId,
          runId,
          model: args.model,
        });

    const liveState = await new JsonStateBackend(spec).read();
    const effectiveLiveState = liveState.runId === runId
      ? liveState
      : {
          ...liveState,
          threadId: result.execution.threadId,
          latestCheckpoint: null,
          latestSummary: result.execution.lastMessage ?? "Harness worker completed.",
          startedAt: nowIso(),
        };
    await backend.write({
      state: result.evaluation.passed ? "completed" : "failed",
      workerPid: null,
      runId: result.spec.runId,
      adapterId: result.spec.adapterId,
      threadId: result.execution.threadId,
      startedAt: effectiveLiveState.startedAt ?? nowIso(),
      updatedAt: nowIso(),
      latestSummary: effectiveLiveState.latestSummary ?? result.execution.lastMessage ?? "Harness worker completed.",
      latestCheckpoint: effectiveLiveState.latestCheckpoint,
      stdoutLog: path.join(result.spec.artifactRoot, "worker-stdout.log").replaceAll("\\", "/"),
      stderrLog: path.join(result.spec.artifactRoot, "worker-stderr.log").replaceAll("\\", "/"),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const liveState = await new JsonStateBackend(spec).read();
    if (liveState.runId !== runId) {
      await new JsonStateBackend(spec).update((current) => ({
        ...current,
        status: "failed",
        runId,
        adapterId: spec.adapterId,
        threadId: null,
        startedAt: current.startedAt ?? nowIso(),
        latestCheckpoint: null,
        latestSummary: message,
        failureReason: message,
        updatedAt: nowIso(),
      }));
    }
    const effectiveLiveState = liveState.runId === runId
      ? liveState
      : {
          ...liveState,
          threadId: null,
          latestCheckpoint: null,
          latestSummary: message,
          startedAt: nowIso(),
        };
    await backend.write({
      state: "failed",
      workerPid: null,
      runId,
      adapterId: spec.adapterId,
      threadId: effectiveLiveState.threadId,
      startedAt: effectiveLiveState.startedAt ?? nowIso(),
      updatedAt: nowIso(),
      latestSummary: message,
      latestCheckpoint: effectiveLiveState.latestCheckpoint,
      stdoutLog: path.join(spec.artifactRoot, "worker-stdout.log").replaceAll("\\", "/"),
      stderrLog: path.join(spec.artifactRoot, "worker-stderr.log").replaceAll("\\", "/"),
    });
    throw error;
  }
}

async function main() {
  const command = process.argv[2] ?? "status";
  const args = parseArgs(process.argv.slice(3));

  switch (command) {
    case "start":
      await spawnWorker("run", args);
      return;
    case "resume":
      await spawnWorker("resume", { ...args, runId: await resolveResumeRunId(args) });
      return;
    case "status":
      await commandStatus(args);
      return;
    case "stop":
      await commandStop(args);
      return;
    case "worker": {
      const mode = process.argv[3];
      const workerArgs = parseArgs(process.argv.slice(4));
      if (mode !== "run" && mode !== "resume") {
        throw new Error(`Unknown harness worker mode "${mode}". Expected run or resume.`);
      }
      await commandWorker(mode, workerArgs);
      return;
    }
    default:
      throw new Error(`Unknown harness worker command "${command}". Expected start, status, stop, resume, or worker.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
