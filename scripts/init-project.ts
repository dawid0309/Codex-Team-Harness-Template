import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeConfig, readProjectConfig, root, syncProjectFiles, writeProjectConfig } from "./project-config";
import { defaultNextMilestoneOutput, defaultPlannerOutput } from "./planner-state";

type Args = Record<string, string>;

function parseArgs(argv: string[]) {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }
    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

async function promptIfNeeded(currentArgs: Args) {
  const existing = await readProjectConfig();
  const rl = readline.createInterface({ input, output });

  try {
    const name =
      currentArgs.name ??
      (await rl.question(`Project name [${existing.name}]: `)).trim() ??
      existing.name;
    const slug =
      currentArgs.slug ??
      (await rl.question(`Package slug [${existing.slug}]: `)).trim() ??
      existing.slug;
    const goal =
      currentArgs.goal ??
      (await rl.question(`Project goal [${existing.goal}]: `)).trim() ??
      existing.goal;
    const stack =
      currentArgs.stack ??
      (await rl.question(`Stack [${existing.stack}]: `)).trim() ??
      existing.stack;
    const owner =
      currentArgs.owner ??
      (await rl.question(`GitHub owner [${existing.owner}]: `)).trim() ??
      existing.owner;
    const repoName =
      currentArgs.repoName ??
      (await rl.question(`Repository name [${existing.repoName}]: `)).trim() ??
      existing.repoName;

    return normalizeConfig(
      {
        name: name || existing.name,
        slug: slug || existing.slug,
        goal: goal || existing.goal,
        stack: stack || existing.stack,
        owner: owner || existing.owner,
        repoName: repoName || existing.repoName,
        licenseHolder: owner || existing.licenseHolder,
        description:
          currentArgs.description ??
          `${name || existing.name}: ${goal || existing.goal}`,
      },
      existing,
    );
  } finally {
    rl.close();
  }
}

async function resetTaskBoard() {
  const milestonesPath = path.join(root, "planning", "milestones.json");
  const taskBoardPath = path.join(root, "planning", "task-board.json");
  const plannerOutputPath = path.join(root, "planning", "planner-output.json");
  const nextMilestoneOutputPath = path.join(root, "planning", "next-milestone-output.json");
  const milestones = JSON.parse(await readFile(milestonesPath, "utf8")) as Array<{ id: string }>;
  const emptyBoard = {
    currentMilestoneId: milestones[0]?.id ?? null,
    lastRefreshedAt: null,
    tasks: [],
  };
  await Promise.all([
    writeFile(taskBoardPath, `${JSON.stringify(emptyBoard, null, 2)}\n`, "utf8"),
    writeFile(plannerOutputPath, `${JSON.stringify(defaultPlannerOutput(), null, 2)}\n`, "utf8"),
    writeFile(nextMilestoneOutputPath, `${JSON.stringify(defaultNextMilestoneOutput(), null, 2)}\n`, "utf8"),
  ]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await promptIfNeeded(args);

  await writeProjectConfig(config);
  await syncProjectFiles(config);
  await resetTaskBoard();

  console.log(`Initialized project metadata for ${config.name}.`);
  console.log("Next steps:");
  console.log("- Run `pnpm verify`");
  console.log("- Review `docs/architecture/system.md` and `planning/milestones.json`");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
