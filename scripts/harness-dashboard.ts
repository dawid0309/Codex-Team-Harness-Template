import { startDashboardServer } from "../src/harness/dashboard-server";

type DashboardArgs = {
  manifest: string;
  targetsFile: string;
  port: number;
};

function parseArgs(argv: string[]): DashboardArgs {
  const parsed: DashboardArgs = {
    manifest: "harness.manifest.json",
    targetsFile: "harness.targets.json",
    port: 4783,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
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
    if (current === "--port" && next) {
      parsed.port = Number(next);
      index += 1;
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const controlRepoRoot = process.cwd();
  await startDashboardServer({
    controlRepoRoot,
    manifestPath: args.manifest,
    targetRegistryPath: args.targetsFile,
    port: args.port,
  });

  console.log(`Harness dashboard running at http://127.0.0.1:${args.port}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
