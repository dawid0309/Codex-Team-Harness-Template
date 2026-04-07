import { readFile } from "node:fs/promises";
import path from "node:path";

async function load(relativePath: string) {
  return JSON.parse(await readFile(path.join(process.cwd(), relativePath), "utf8"));
}

async function main() {
  const milestones = await load("planning/milestones.json");
  const taskBoard = await load("planning/task-board.json");
  const plannerOutput = await load("planning/planner-output.json");
  const nextMilestoneOutput = await load("planning/next-milestone-output.json");

  if (!Array.isArray(milestones) || milestones.length === 0) {
    throw new Error("milestones.json must contain at least one milestone.");
  }

  if (!Array.isArray(taskBoard.tasks)) {
    throw new Error("task-board.json must contain a tasks array.");
  }

  if (!plannerOutput || typeof plannerOutput !== "object") {
    throw new Error("planner-output.json must contain a planner output object.");
  }

  if (!plannerOutput.publication || !Array.isArray(plannerOutput.publication.newTasks)) {
    throw new Error("planner-output.json must include publication.newTasks.");
  }

  if (!Array.isArray(plannerOutput.publication.statusUpdates)) {
    throw new Error("planner-output.json must include publication.statusUpdates.");
  }

  if (!nextMilestoneOutput || typeof nextMilestoneOutput !== "object") {
    throw new Error("next-milestone-output.json must contain a next milestone output object.");
  }

  if (!Array.isArray(nextMilestoneOutput.summary)) {
    throw new Error("next-milestone-output.json must include a summary array.");
  }

  if (!Object.prototype.hasOwnProperty.call(nextMilestoneOutput, "proposal")) {
    throw new Error("next-milestone-output.json must include a proposal field.");
  }

  console.log(`Smoke OK: ${milestones.length} milestones, ${taskBoard.tasks.length} tasks, planner and next-milestone outputs present.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
