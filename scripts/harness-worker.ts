import {
  defaultCliArgs,
  formatWorkerStatus,
  getEffectiveWorkerStatus,
  resolveResumeRunId,
  runWorkerProcess,
  startBackgroundWorker,
  stopBackgroundWorker,
  type HarnessCliArgs,
} from "../src/harness/worker-controller";

function parseArgs(argv: string[]): HarnessCliArgs {
  const parsed = defaultCliArgs();

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
    if (current === "--targets-file" && next) {
      parsed.targetsFile = next;
      index += 1;
      continue;
    }
    if (current === "--target" && next) {
      parsed.target = next;
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

async function main() {
  const command = process.argv[2] ?? "status";
  const args = parseArgs(process.argv.slice(3));
  const controlRepoRoot = process.cwd();

  switch (command) {
    case "start": {
      const result = await startBackgroundWorker(controlRepoRoot, "run", args);
      console.log("Harness worker started in background.");
      console.log(`Target: ${result.spec.targetId}`);
      console.log(`Run ID: ${result.runId}`);
      console.log(`Status file: ${result.backend.path()}`);
      return;
    }
    case "resume": {
      const runId = await resolveResumeRunId(controlRepoRoot, args);
      const result = await startBackgroundWorker(controlRepoRoot, "resume", { ...args, runId });
      console.log("Harness worker resumed in background.");
      console.log(`Target: ${result.spec.targetId}`);
      console.log(`Run ID: ${result.runId}`);
      console.log(`Status file: ${result.backend.path()}`);
      return;
    }
    case "status": {
      const result = await getEffectiveWorkerStatus(controlRepoRoot, args);
      for (const line of formatWorkerStatus(result.status)) {
        console.log(line);
      }
      return;
    }
    case "stop": {
      const result = await stopBackgroundWorker(controlRepoRoot, args);
      if (!result.stopped) {
        console.log("No active harness worker is running.");
        return;
      }
      console.log("Harness worker stopped.");
      console.log(`Target: ${result.spec.targetId}`);
      return;
    }
    case "worker": {
      const mode = process.argv[3];
      const workerArgs = parseArgs(process.argv.slice(4));
      if (mode !== "run" && mode !== "resume") {
        throw new Error(`Unknown harness worker mode "${mode}". Expected run or resume.`);
      }
      await runWorkerProcess(controlRepoRoot, mode, workerArgs);
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
