import {
  applyNextMilestonePublication,
  buildNextMilestoneOutput,
  computeActiveMilestone,
  defaultNextMilestoneOutput,
  finalMilestone,
  isMilestoneComplete,
  loadJson,
  milestonesPath,
  nextMilestoneOutputPath,
  saveJson,
  taskBoardPath,
  type Milestone,
  type NextMilestoneOutput,
  type TaskBoard,
} from "./planner-state";

function printSummary(output: NextMilestoneOutput) {
  for (const line of output.summary) {
    console.log(`- ${line}`);
  }
}

async function propose() {
  const [milestones, taskBoard] = await Promise.all([
    loadJson<Milestone[]>(milestonesPath),
    loadJson<TaskBoard>(taskBoardPath),
  ]);

  const output = buildNextMilestoneOutput(taskBoard, milestones);
  await saveJson(nextMilestoneOutputPath, output);

  console.log(`Next milestone proposal prepared from: ${output.basedOnMilestoneId ?? "none"}`);
  printSummary(output);

  if (output.proposal) {
    console.log(`Proposed milestone: ${output.proposal.id}`);
  }
}

async function publish() {
  const [milestones, taskBoard, nextMilestoneOutput] = await Promise.all([
    loadJson<Milestone[]>(milestonesPath),
    loadJson<TaskBoard>(taskBoardPath),
    loadJson<NextMilestoneOutput>(nextMilestoneOutputPath),
  ]);

  if (!nextMilestoneOutput.proposal) {
    throw new Error("No next milestone proposal is available. Run pnpm next-milestone:propose first.");
  }

  const lastMilestone = finalMilestone(milestones);
  const activeMilestone = computeActiveMilestone(taskBoard, milestones);

  if (!lastMilestone || !activeMilestone) {
    throw new Error("Milestone state is missing. Cannot publish a next milestone proposal.");
  }

  if (activeMilestone.id !== lastMilestone.id) {
    throw new Error(
      `Active milestone ${activeMilestone.id} is not the final milestone ${lastMilestone.id}. Finish the current roadmap before publishing the next milestone proposal.`,
    );
  }

  if (!isMilestoneComplete(taskBoard, lastMilestone)) {
    throw new Error(
      `Final milestone ${lastMilestone.id} is not fully verified yet. Complete it before publishing the next milestone proposal.`,
    );
  }

  if ((nextMilestoneOutput.basedOnMilestoneId ?? null) !== lastMilestone.id) {
    throw new Error(
      `Proposal was generated from ${nextMilestoneOutput.basedOnMilestoneId ?? "none"}, but the current final milestone is ${lastMilestone.id}. Regenerate the proposal before publishing.`,
    );
  }

  const published = applyNextMilestonePublication(milestones, nextMilestoneOutput);
  await saveJson(milestonesPath, published);

  console.log(`Leader accepted next milestone proposal: ${nextMilestoneOutput.proposal.id}`);
  console.log("Run `pnpm planner:propose` next to publish the new milestone's task blueprints into the task board.");
}

async function main() {
  const command = process.argv[2] ?? "propose";

  if (command === "propose") {
    await propose();
    return;
  }

  if (command === "publish") {
    await publish();
    return;
  }

  if (command === "reset-output") {
    await saveJson(nextMilestoneOutputPath, defaultNextMilestoneOutput());
    console.log("Next milestone output reset.");
    return;
  }

  throw new Error("Unknown command. Expected propose, publish, or reset-output.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
