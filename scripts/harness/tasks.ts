import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type TaskStatus =
  | "backlog"
  | "ready"
  | "in_progress"
  | "blocked"
  | "review"
  | "verified"
  | "done";

type TaskCard = {
  id: string;
  title: string;
  milestone: string;
  status: TaskStatus;
  priority: string;
  owner_role: string;
  dependencies: string[];
};

type TaskBoard = {
  currentMilestoneId?: string | null;
  lastRefreshedAt?: string | null;
  tasks: TaskCard[];
};

const root = process.cwd();
const taskBoardPath = path.join(root, "planning", "task-board.json");
const allowedStatuses: TaskStatus[] = [
  "backlog",
  "ready",
  "in_progress",
  "blocked",
  "review",
  "verified",
  "done",
];

async function loadBoard(): Promise<TaskBoard> {
  return JSON.parse(await readFile(taskBoardPath, "utf8")) as TaskBoard;
}

async function saveBoard(taskBoard: TaskBoard): Promise<void> {
  await writeFile(taskBoardPath, `${JSON.stringify(taskBoard, null, 2)}\n`, "utf8");
}

function printTask(task: TaskCard) {
  const deps = task.dependencies.length > 0 ? ` deps:${task.dependencies.join(",")}` : "";
  console.log(`- ${task.id} [${task.status}] [${task.priority}] ${task.title} -> ${task.owner_role}${deps}`);
}

async function status(filter?: TaskStatus) {
  const taskBoard = await loadBoard();
  const tasks = filter ? taskBoard.tasks.filter((task) => task.status === filter) : taskBoard.tasks;
  const counts = allowedStatuses.map(
    (value) => `${value}:${taskBoard.tasks.filter((task) => task.status === value).length}`,
  );

  console.log(`Current milestone: ${taskBoard.currentMilestoneId ?? "none"}`);
  console.log(`Last refreshed: ${taskBoard.lastRefreshedAt ?? "never"}`);
  console.log(`Task counts: ${counts.join(" | ")}`);

  if (tasks.length === 0) {
    console.log(filter ? `No tasks with status ${filter}.` : "No tasks on the board.");
    return;
  }

  console.log("Tasks:");
  for (const task of tasks) {
    printTask(task);
  }
}

async function plan() {
  const taskBoard = await loadBoard();
  const ready = taskBoard.tasks.filter((task) => task.status === "ready");

  if (ready.length === 0) {
    console.log("No ready tasks. Run `pnpm planner:refresh` to repopulate the board.");
    return;
  }

  console.log("Recommended next tasks:");
  for (const task of ready.slice(0, 4)) {
    printTask(task);
  }
}

function parseStatus(value: string): TaskStatus {
  if (allowedStatuses.includes(value as TaskStatus)) {
    return value as TaskStatus;
  }

  throw new Error(`Invalid status '${value}'. Expected one of: ${allowedStatuses.join(", ")}`);
}

async function update(taskId: string | undefined, nextStatusRaw: string | undefined) {
  if (!taskId || !nextStatusRaw) {
    throw new Error("Usage: pnpm tasks:update -- <task-id> <status>");
  }

  const nextStatus = parseStatus(nextStatusRaw);
  const taskBoard = await loadBoard();
  const task = taskBoard.tasks.find((entry) => entry.id === taskId);

  if (!task) {
    throw new Error(`Task '${taskId}' was not found in planning/task-board.json`);
  }

  task.status = nextStatus;
  await saveBoard(taskBoard);
  console.log(`Updated ${task.id} to ${task.status}.`);
}

async function main() {
  const command = process.argv[2] ?? "status";

  if (command === "plan") {
    await plan();
    return;
  }

  if (command === "status") {
    const maybeFilter = process.argv[3];
    await status(maybeFilter ? parseStatus(maybeFilter) : undefined);
    return;
  }

  if (command === "update") {
    await update(process.argv[3], process.argv[4]);
    return;
  }

  throw new Error(`Unknown command '${command}'. Expected plan, status, or update.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
