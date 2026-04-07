import {
  applyPlannerPublication,
  defaultPlannerOutput,
  buildPlannerOutput,
  loadJson,
  milestonesPath,
  plannerOutputPath,
  saveJson,
  taskBoardPath,
  type Milestone,
  type PlannerOutput,
  type TaskBoard,
} from "./planner-state";

function printRecommendations(output: PlannerOutput) {
  if (output.recommendedNextTasks.length === 0) {
    console.log("No ready tasks.");
    return;
  }

  console.log("Recommended next tasks:");
  for (const task of output.recommendedNextTasks) {
    console.log(`- ${task.id} [${task.priority}] ${task.title} -> ${task.owner_role}`);
  }
}

async function propose() {
  const [milestones, taskBoard] = await Promise.all([
    loadJson<Milestone[]>(milestonesPath),
    loadJson<TaskBoard>(taskBoardPath),
  ]);

  const output = buildPlannerOutput(taskBoard, milestones);
  await saveJson(plannerOutputPath, output);

  console.log(`Planner proposal prepared for milestone: ${output.activeMilestoneId ?? "none"}`);
  for (const line of output.summary) {
    console.log(`- ${line}`);
  }
  printRecommendations(output);
}

async function publish() {
  const [taskBoard, plannerOutput] = await Promise.all([
    loadJson<TaskBoard>(taskBoardPath),
    loadJson<PlannerOutput>(plannerOutputPath),
  ]);

  const published = applyPlannerPublication(taskBoard, plannerOutput, true);
  await saveJson(taskBoardPath, published);

  console.log(`Leader accepted planner output for milestone: ${published.currentMilestoneId ?? "none"}`);
  printRecommendations(plannerOutput);
}

async function refresh() {
  await propose();
  await publish();
}

async function next() {
  const [milestones, taskBoard] = await Promise.all([
    loadJson<Milestone[]>(milestonesPath),
    loadJson<TaskBoard>(taskBoardPath),
  ]);
  const ready = taskBoard.tasks.filter((task) => task.status === "ready");

  if (ready.length === 0) {
    console.log("No ready tasks.");
    const output = buildPlannerOutput(taskBoard, milestones);
    for (const line of output.summary) {
      console.log(`- ${line}`);
    }
    return;
  }

  for (const task of ready.slice(0, 4)) {
    console.log(`- ${task.id} [${task.priority}] ${task.title} -> ${task.owner_role}`);
  }
}

async function main() {
  const command = process.argv[2] ?? "next";

  if (command === "propose") {
    await propose();
    return;
  }

  if (command === "publish") {
    await publish();
    return;
  }

  if (command === "refresh") {
    await refresh();
    return;
  }

  if (command === "next") {
    await next();
    return;
  }

  if (command === "reset-output") {
    await saveJson(plannerOutputPath, defaultPlannerOutput());
    console.log("Planner output reset.");
    return;
  }

  throw new Error(`Unknown command '${command}'. Expected propose, publish, refresh, next, or reset-output.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
