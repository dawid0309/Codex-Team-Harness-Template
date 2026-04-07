import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type TaskStatus =
  | "backlog"
  | "ready"
  | "in_progress"
  | "blocked"
  | "review"
  | "verified"
  | "done";

type TaskMetadata = {
  input_artifacts?: string[];
  expected_output?: string[];
  acceptance?: string[];
  verification?: string[];
  next_consumer?: string;
  [key: string]: unknown;
};

export type TaskCard = TaskMetadata & {
  id: string;
  title: string;
  milestone: string;
  status: TaskStatus;
  priority: string;
  owner_role: string;
  dependencies: string[];
};

export type TaskBlueprint = TaskMetadata & {
  id: string;
  title: string;
  milestone: string;
  priority: string;
  owner_role: string;
  dependencies: string[];
};

export type Milestone = {
  id: string;
  order: number;
  taskBlueprints: TaskBlueprint[];
  [key: string]: unknown;
};

export type TaskBoard = {
  currentMilestoneId?: string | null;
  lastRefreshedAt?: string | null;
  tasks: TaskCard[];
};

export type PlannerStatusUpdate = {
  id: string;
  from: TaskStatus;
  to: TaskStatus;
};

export type PlannerPublication = {
  currentMilestoneId: string | null;
  newTasks: TaskCard[];
  statusUpdates: PlannerStatusUpdate[];
};

export type PlannerReadyTask = Pick<TaskCard, "id" | "title" | "priority" | "owner_role" | "status">;

export type PlannerOutput = {
  generatedAt: string | null;
  activeMilestoneId: string | null;
  summary: string[];
  publication: PlannerPublication;
  recommendedNextTasks: PlannerReadyTask[];
};

export type NextMilestoneOutput = {
  generatedAt: string | null;
  basedOnMilestoneId: string | null;
  summary: string[];
  proposal: Milestone | null;
};

export const root = process.cwd();
export const milestonesPath = path.join(root, "planning", "milestones.json");
export const taskBoardPath = path.join(root, "planning", "task-board.json");
export const plannerOutputPath = path.join(root, "planning", "planner-output.json");
export const nextMilestoneOutputPath = path.join(root, "planning", "next-milestone-output.json");

export async function loadJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function saveJson<T>(filePath: string, payload: T): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function isDone(status: TaskStatus) {
  return status === "done" || status === "verified";
}

function sortedMilestones(milestones: Milestone[]): Milestone[] {
  return [...milestones].sort((left, right) => left.order - right.order);
}

export function milestoneTasks(taskBoard: TaskBoard, milestoneId: string): TaskCard[] {
  return taskBoard.tasks.filter((task) => task.milestone === milestoneId);
}

export function isMilestoneComplete(taskBoard: TaskBoard, milestone: Milestone): boolean {
  const existing = milestoneTasks(taskBoard, milestone.id);

  return (
    milestone.taskBlueprints.length > 0 &&
    milestone.taskBlueprints.every((blueprint) =>
      existing.some((task) => task.id === blueprint.id && isDone(task.status)),
    )
  );
}

export function computeActiveMilestone(taskBoard: TaskBoard, milestones: Milestone[]): Milestone | null {
  const sorted = sortedMilestones(milestones);
  let activeId = taskBoard.currentMilestoneId ?? sorted[0]?.id ?? null;
  let foundIncompleteMilestone = false;

  for (const milestone of sorted) {
    if (!isMilestoneComplete(taskBoard, milestone)) {
      activeId = milestone.id;
      foundIncompleteMilestone = true;
      break;
    }
  }

  if (!foundIncompleteMilestone && sorted.length > 0) {
    activeId = sorted[sorted.length - 1].id;
  }

  return sorted.find((milestone) => milestone.id === activeId) ?? sorted[0] ?? null;
}

export function finalMilestone(milestones: Milestone[]): Milestone | null {
  const sorted = sortedMilestones(milestones);
  return sorted.length > 0 ? sorted[sorted.length - 1] : null;
}

function cloneTaskBoard(taskBoard: TaskBoard): TaskBoard {
  return {
    currentMilestoneId: taskBoard.currentMilestoneId ?? null,
    lastRefreshedAt: taskBoard.lastRefreshedAt ?? null,
    tasks: taskBoard.tasks.map((task) => ({ ...task })),
  };
}

export function defaultPlannerOutput(): PlannerOutput {
  return {
    generatedAt: null,
    activeMilestoneId: null,
    summary: ["No planner proposal has been generated yet."],
    publication: {
      currentMilestoneId: null,
      newTasks: [],
      statusUpdates: [],
    },
    recommendedNextTasks: [],
  };
}

export function defaultNextMilestoneOutput(): NextMilestoneOutput {
  return {
    generatedAt: null,
    basedOnMilestoneId: null,
    summary: ["No next-milestone proposal has been generated yet."],
    proposal: null,
  };
}

function nextMilestoneNumber(baseMilestone: Milestone, milestones: Milestone[]): number {
  const idMatch = baseMilestone.id.match(/^m(\d+)/i);
  const highestOrder = sortedMilestones(milestones).at(-1)?.order ?? baseMilestone.order;
  const nextById = idMatch ? Number(idMatch[1]) + 1 : baseMilestone.order + 1;
  return Math.max(highestOrder + 1, nextById);
}

function buildDefaultNextMilestoneProposal(baseMilestone: Milestone, milestones: Milestone[]): Milestone {
  const milestoneNumber = nextMilestoneNumber(baseMilestone, milestones);
  const milestoneId = `m${milestoneNumber}-next-iteration`;
  const taskPrefix = `M${milestoneNumber}`;

  return {
    id: milestoneId,
    slug: "next-iteration",
    order: (sortedMilestones(milestones).at(-1)?.order ?? baseMilestone.order) + 1,
    title: `Milestone ${milestoneNumber}: Next Iteration`,
    summary: `Proposed follow-on milestone after ${baseMilestone.id} reached verified completion.`,
    completionDefinition: [
      "The next milestone outcome is written into repository truth and accepted by the leader",
      "At least one new delivery slice is shipped from the proposed blueprint",
      "Verification and handoff artifacts are updated for the new iteration",
    ],
    taskBlueprints: [
      {
        id: `${taskPrefix}-T001`,
        title: "Define the next milestone scope from repository truth",
        milestone: milestoneId,
        priority: "P0",
        owner_role: "planner",
        dependencies: [],
        input_artifacts: [
          "docs/architecture/system.md",
          "planning/milestones.json",
          "planning/task-board.json",
        ],
        expected_output: [
          "Accepted milestone scope",
          "updated roadmap context",
        ],
        acceptance: [
          "The next milestone goal is concrete enough to hand off to builders",
        ],
        verification: [
          "pnpm planner:propose",
        ],
        next_consumer: "builder-engine",
      },
      {
        id: `${taskPrefix}-T002`,
        title: "Implement the next highest-leverage delivery slice",
        milestone: milestoneId,
        priority: "P0",
        owner_role: "builder-engine",
        dependencies: [`${taskPrefix}-T001`],
        input_artifacts: [
          "docs/architecture/system.md",
          "planning/milestones.json",
        ],
        expected_output: [
          "Next iteration implementation slice",
        ],
        acceptance: [
          "The newly proposed milestone produces a tangible repo outcome",
        ],
        verification: [
          "pnpm verify",
        ],
        next_consumer: "verifier-reviewer",
      },
      {
        id: `${taskPrefix}-T003`,
        title: "Verify and hand off the new iteration slice",
        milestone: milestoneId,
        priority: "P1",
        owner_role: "verifier-reviewer",
        dependencies: [`${taskPrefix}-T002`],
        input_artifacts: [
          "planning/task-board.json",
          "docs/issues/harness/",
        ],
        expected_output: [
          "Verification evidence",
          "handoff-ready milestone state",
        ],
        acceptance: [
          "The milestone can continue from verified repository state",
        ],
        verification: [
          "pnpm verify",
          "pnpm issues:export",
        ],
        next_consumer: "planner",
      },
    ],
  };
}

export function buildNextMilestoneOutput(taskBoard: TaskBoard, milestones: Milestone[]): NextMilestoneOutput {
  const activeMilestone = computeActiveMilestone(taskBoard, milestones);
  const lastMilestone = finalMilestone(milestones);

  if (!activeMilestone || !lastMilestone) {
    return {
      ...defaultNextMilestoneOutput(),
      generatedAt: new Date().toISOString(),
      summary: ["No milestones are available, so the next-milestone planner cannot propose a roadmap extension."],
    };
  }

  if (activeMilestone.id !== lastMilestone.id) {
    return {
      ...defaultNextMilestoneOutput(),
      generatedAt: new Date().toISOString(),
      basedOnMilestoneId: activeMilestone.id,
      summary: [
        `Active milestone ${activeMilestone.id} is not the final milestone.`,
        "Finish the existing roadmap before proposing a new milestone.",
      ],
    };
  }

  if (!isMilestoneComplete(taskBoard, lastMilestone)) {
    return {
      ...defaultNextMilestoneOutput(),
      generatedAt: new Date().toISOString(),
      basedOnMilestoneId: lastMilestone.id,
      summary: [
        `Final milestone ${lastMilestone.id} is not fully verified yet.`,
        "Complete every task in the current roadmap before proposing the next milestone.",
      ],
    };
  }

  const proposal = buildDefaultNextMilestoneProposal(lastMilestone, milestones);

  return {
    generatedAt: new Date().toISOString(),
    basedOnMilestoneId: lastMilestone.id,
    summary: [
      `Final milestone ${lastMilestone.id} is fully complete and no later milestone blueprint exists.`,
      `Planner proposed ${proposal.id} as the next roadmap iteration.`,
      "Leader should review planning/next-milestone-output.json and accept it with `pnpm next-milestone:publish` if it matches repository truth.",
    ],
    proposal,
  };
}

export function buildPlannerOutput(taskBoard: TaskBoard, milestones: Milestone[]): PlannerOutput {
  const activeMilestone = computeActiveMilestone(taskBoard, milestones);

  if (!activeMilestone) {
    return {
      ...defaultPlannerOutput(),
      generatedAt: new Date().toISOString(),
      summary: ["No milestones are available, so the planner cannot publish tasks."],
    };
  }

  const map = new Map(taskBoard.tasks.map((task) => [task.id, task]));
  const publication: PlannerPublication = {
    currentMilestoneId: activeMilestone.id,
    newTasks: [],
    statusUpdates: [],
  };

  for (const blueprint of activeMilestone.taskBlueprints) {
    const existing = map.get(blueprint.id);
    const depsOk = blueprint.dependencies.every((dep) => isDone(map.get(dep)?.status ?? "backlog"));

    if (!existing) {
      publication.newTasks.push({
        ...blueprint,
        status: depsOk ? "ready" : "backlog",
      });
      continue;
    }

    if (existing.status === "backlog" && depsOk) {
      publication.statusUpdates.push({
        id: existing.id,
        from: existing.status,
        to: "ready",
      });
    }
  }

  const preview = applyPlannerPublication(cloneTaskBoard(taskBoard), {
    generatedAt: new Date().toISOString(),
    activeMilestoneId: activeMilestone.id,
    summary: [],
    publication,
    recommendedNextTasks: [],
  }, false);

  const recommendedNextTasks = preview.tasks
    .filter((task) => task.status === "ready")
    .slice(0, 4)
    .map((task) => ({
      id: task.id,
      title: task.title,
      priority: task.priority,
      owner_role: task.owner_role,
      status: task.status,
    }));

  const summary = [
    `Planner proposed ${publication.newTasks.length} new task publication(s).`,
    `Planner proposed ${publication.statusUpdates.length} backlog-to-ready transition(s).`,
    `Leader should accept or reject publication for milestone ${activeMilestone.id}.`,
  ];

  const lastMilestone = finalMilestone(milestones);
  if (
    lastMilestone &&
    activeMilestone.id === lastMilestone.id &&
    isMilestoneComplete(taskBoard, lastMilestone) &&
    publication.newTasks.length === 0 &&
    publication.statusUpdates.length === 0 &&
    recommendedNextTasks.length === 0
  ) {
    summary.splice(
      0,
      summary.length,
      `Final milestone ${activeMilestone.id} is fully complete and has no later blueprint to publish.`,
      "Run `pnpm next-milestone:propose` to generate the next roadmap proposal.",
      "Leader should review planning/next-milestone-output.json before extending planning/milestones.json.",
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    activeMilestoneId: activeMilestone.id,
    summary,
    publication,
    recommendedNextTasks,
  };
}

export function applyPlannerPublication(
  taskBoard: TaskBoard,
  plannerOutput: PlannerOutput,
  markRefreshed = true,
): TaskBoard {
  let didChange = false;

  if ((taskBoard.currentMilestoneId ?? null) !== plannerOutput.publication.currentMilestoneId) {
    taskBoard.currentMilestoneId = plannerOutput.publication.currentMilestoneId;
    didChange = true;
  }

  const map = new Map(taskBoard.tasks.map((task) => [task.id, task]));
  for (const task of plannerOutput.publication.newTasks) {
    if (map.has(task.id)) {
      continue;
    }
    const clone = { ...task };
    taskBoard.tasks.push(clone);
    map.set(clone.id, clone);
    didChange = true;
  }

  for (const update of plannerOutput.publication.statusUpdates) {
    const existing = map.get(update.id);
    if (!existing || existing.status === update.to) {
      continue;
    }
    existing.status = update.to;
    didChange = true;
  }

  if (didChange && markRefreshed) {
    taskBoard.lastRefreshedAt = new Date().toISOString();
  }

  return taskBoard;
}

export function applyNextMilestonePublication(
  milestones: Milestone[],
  nextMilestoneOutput: NextMilestoneOutput,
): Milestone[] {
  if (!nextMilestoneOutput.proposal) {
    throw new Error("next-milestone-output.json does not contain a proposal to publish.");
  }

  if (milestones.some((milestone) => milestone.id === nextMilestoneOutput.proposal?.id)) {
    throw new Error(`Milestone ${nextMilestoneOutput.proposal.id} already exists in planning/milestones.json.`);
  }

  return sortedMilestones([...milestones, nextMilestoneOutput.proposal]);
}
