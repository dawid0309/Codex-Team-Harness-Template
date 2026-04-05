import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type TaskStatus = "backlog" | "ready" | "in_progress" | "blocked" | "review" | "verified" | "done";
type TaskCard = {
  id: string;
  title: string;
  milestone: string;
  status: TaskStatus;
  priority: string;
  owner_role: string;
  dependencies: string[];
};
type Milestone = {
  id: string;
  order: number;
  taskBlueprints: Omit<TaskCard, "status">[];
};
type TaskBoard = {
  currentMilestoneId?: string | null;
  lastRefreshedAt?: string | null;
  tasks: TaskCard[];
};

const root = process.cwd();
const milestonesPath = path.join(root, "planning", "milestones.json");
const taskBoardPath = path.join(root, "planning", "task-board.json");

async function loadJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function saveJson<T>(filePath: string, payload: T): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function isDone(status: TaskStatus) {
  return status === "done" || status === "verified";
}

function refreshBoard(taskBoard: TaskBoard, milestones: Milestone[]) {
  const sorted = [...milestones].sort((a, b) => a.order - b.order);
  let activeId = taskBoard.currentMilestoneId ?? sorted[0]?.id;
  let didChange = false;

  for (const milestone of sorted) {
    const existing = taskBoard.tasks.filter((task) => task.milestone === milestone.id);
    const allDone =
      milestone.taskBlueprints.length > 0 &&
      milestone.taskBlueprints.every((blueprint) =>
        existing.some((task) => task.id === blueprint.id && isDone(task.status)),
      );
    if (!allDone) {
      activeId = milestone.id;
      break;
    }
  }

  const active = sorted.find((milestone) => milestone.id === activeId) ?? sorted[0];
  if (taskBoard.currentMilestoneId !== active?.id) {
    didChange = true;
  }
  const map = new Map(taskBoard.tasks.map((task) => [task.id, task]));

  for (const blueprint of active.taskBlueprints) {
    const existing = map.get(blueprint.id);
    const depsOk = blueprint.dependencies.every((dep) => isDone(map.get(dep)?.status ?? "backlog"));
    if (!existing) {
      taskBoard.tasks.push({
        ...blueprint,
        status: depsOk ? "ready" : "backlog",
      });
      didChange = true;
      continue;
    }
    if (existing.status === "backlog" && depsOk) {
      existing.status = "ready";
      didChange = true;
    }
  }

  taskBoard.currentMilestoneId = active.id;
  if (didChange) {
    taskBoard.lastRefreshedAt = new Date().toISOString();
  }
  return taskBoard;
}

async function refresh() {
  const [milestones, taskBoard] = await Promise.all([
    loadJson<Milestone[]>(milestonesPath),
    loadJson<TaskBoard>(taskBoardPath),
  ]);
  const refreshed = refreshBoard(taskBoard, milestones);
  await saveJson(taskBoardPath, refreshed);

  console.log(`Active milestone: ${refreshed.currentMilestoneId}`);
  const ready = refreshed.tasks.filter((task) => task.status === "ready");
  if (ready.length === 0) {
    console.log("No ready tasks.");
    return;
  }
  console.log("Recommended next tasks:");
  for (const task of ready.slice(0, 4)) {
    console.log(`- ${task.id} [${task.priority}] ${task.title} -> ${task.owner_role}`);
  }
}

async function next() {
  const taskBoard = await loadJson<TaskBoard>(taskBoardPath);
  const ready = taskBoard.tasks.filter((task) => task.status === "ready");
  for (const task of ready.slice(0, 4)) {
    console.log(`- ${task.id} [${task.priority}] ${task.title} -> ${task.owner_role}`);
  }
}

const command = process.argv[2] ?? "next";
if (command === "refresh") {
  refresh().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  next().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
