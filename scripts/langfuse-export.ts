import path from "node:path";

import { exportHarnessRunToLangfuse, listHarnessRunDirs, shutdownLangfuse } from "../src/harness/langfuse-observability";
import { loadTargetRegistry, resolveTargetRegistration } from "../src/harness/targets";

type Args = {
  target: string | null;
  runId: string | null;
  all: boolean;
  force: boolean;
  targetsFile: string;
};

function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    target: null,
    runId: null,
    all: false,
    force: false,
    targetsFile: "harness.targets.json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
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
    if (current === "--targets-file" && next) {
      parsed.targetsFile = next;
      index += 1;
      continue;
    }
    if (current === "--all") {
      parsed.all = true;
      continue;
    }
    if (current === "--force") {
      parsed.force = true;
    }
  }
  return parsed;
}

async function resolveRunDirs(controlRepoRoot: string, args: Args) {
  const registry = await loadTargetRegistry(controlRepoRoot, args.targetsFile);
  const target = resolveTargetRegistration(controlRepoRoot, registry, args.target);
  if (args.all) {
    return {
      target,
      runDirs: await listHarnessRunDirs(controlRepoRoot, target.artifactRoot),
    };
  }
  if (!args.runId) {
    throw new Error("Usage: pnpm langfuse:export -- --target <target-id> --run-id <run-id> OR --all");
  }
  return {
    target,
    runDirs: [path.join(controlRepoRoot, target.artifactRoot, "runs", args.runId)],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const controlRepoRoot = process.cwd();
  const { target, runDirs } = await resolveRunDirs(controlRepoRoot, args);
  if (runDirs.length === 0) {
    console.log(`No runs found for target ${target.id}.`);
    return;
  }

  let exported = 0;
  let skipped = 0;
  for (const runDir of runDirs) {
    const result = await exportHarnessRunToLangfuse({
      controlRepoRoot,
      runDir,
      force: args.force,
      mode: "historical",
    });
    if (result.skipped) {
      skipped += 1;
      console.log(`Skipped ${path.basename(runDir)}${result.traceUrl ? ` -> ${result.traceUrl}` : ""}`);
      continue;
    }
    exported += 1;
    console.log(`Exported ${result.runId ?? path.basename(runDir)}${result.traceUrl ? ` -> ${result.traceUrl}` : ""}`);
  }
  await shutdownLangfuse();
  console.log(`Langfuse export complete for ${target.id}. Exported: ${exported}, skipped: ${skipped}.`);
}

main().catch(async (error) => {
  await shutdownLangfuse();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
