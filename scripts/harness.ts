import path from "node:path";

import { doctorHarness, evaluateHarness, resumeHarness, runHarness } from "../src/harness/engine";

type Args = {
  adapter: string | null;
  manifest: string;
  runId: string | null;
  model: string | null;
  task: string | null;
};

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

function printChecks(checks: { label: string; passed: boolean; detail: string }[]) {
  for (const check of checks) {
    console.log(`- ${check.passed ? "PASS" : "FAIL"} ${check.label}: ${check.detail}`);
  }
}

async function main() {
  const command = process.argv[2] ?? "doctor";
  const args = parseArgs(process.argv.slice(3));
  const repoRoot = process.cwd();
  const manifestPath = path.join(repoRoot, args.manifest);

  switch (command) {
    case "run": {
      const result = await runHarness({
        repoRoot,
        manifestPath: args.manifest,
        adapterId: args.adapter,
        runId: args.runId,
        model: args.model,
        taskId: args.task,
      });
      console.log(`Harness run completed: ${result.spec.runId}`);
      console.log(`Adapter: ${result.spec.adapterId}`);
      console.log(`Task: ${result.contract.caseId}`);
      console.log(`Evaluation passed: ${result.evaluation.passed}`);
      console.log(`State file: ${result.statePath}`);
      return;
    }
    case "resume": {
      if (!args.runId) {
        throw new Error("Usage: pnpm harness:resume -- --run-id <run-id>");
      }
      const result = await resumeHarness({
        repoRoot,
        manifestPath: args.manifest,
        adapterId: args.adapter,
        runId: args.runId,
        model: args.model,
      });
      console.log(`Harness run resumed: ${result.spec.runId}`);
      console.log(`Task: ${result.contract.caseId}`);
      console.log(`Evaluation passed: ${result.evaluation.passed}`);
      console.log(`State file: ${result.statePath}`);
      return;
    }
    case "eval": {
      if (!args.runId) {
        throw new Error("Usage: pnpm harness:eval -- --run-id <run-id>");
      }
      const result = await evaluateHarness({
        repoRoot,
        manifestPath: args.manifest,
        adapterId: args.adapter,
        runId: args.runId,
      });
      console.log(`Manual evaluation completed for ${result.contract.caseId}.`);
      console.log(`Evaluation passed: ${result.evaluation.passed}`);
      console.log(`State file: ${result.statePath}`);
      return;
    }
    case "doctor": {
      const result = await doctorHarness({
        repoRoot,
        manifestPath: args.manifest,
        adapterId: args.adapter,
      });
      printChecks(result.checks);
      const failed = result.checks.filter((item) => !item.passed);
      console.log(`Doctor checks: ${result.checks.length}, failed: ${failed.length}`);
      if (failed.length > 0) {
        process.exitCode = 1;
      }
      return;
    }
    default:
      throw new Error(`Unknown harness command "${command}". Expected run, resume, eval, or doctor.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
