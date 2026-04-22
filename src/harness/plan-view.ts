import { nowIso } from "./time";
import type {
  HarnessLaneId,
  HarnessNodeStatus,
  HarnessPlanStep,
  HarnessPlanStepSource,
  HarnessPlanStepStatus,
  HarnessPlanView,
  HarnessRunBoard,
  HarnessRunEvent,
  HarnessTaskNode,
} from "./types";

type PlannerGeneratedCase = {
  id?: string | null;
  title?: string | null;
  goal?: string | null;
  instructions?: unknown;
};

type PlannerPublishResult = {
  summary?: string | null;
};

type ContractLike = {
  caseId?: string;
  title?: string;
  goal?: string;
  instructions?: unknown;
};

type EvaluationLike = {
  passed?: boolean;
  failureReason?: string | null;
};

export type HarnessPlanArtifacts = {
  contract: ContractLike | null;
  evaluation: EvaluationLike | null;
  planner: {
    generatedCases?: unknown;
    publishResult?: PlannerPublishResult | null;
    outputRaw?: string | null;
  } | null;
};

type CandidatePlanStep = {
  title: string;
  description: string;
  source: HarnessPlanStepSource;
  evidenceEventIds: string[];
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "their",
  "then",
  "this",
  "to",
  "use",
  "with",
]);

function normalizeWhitespace(value: string | null | undefined) {
  return (value ?? "").replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function collapseInline(value: string | null | undefined) {
  return normalizeWhitespace(value).replace(/\s+/g, " ").trim();
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string").map((item) => normalizeWhitespace(item)).filter(Boolean);
}

function shortenSentence(value: string, maxLength = 96) {
  const normalized = collapseInline(value);
  if (!normalized) {
    return "Untitled step";
  }
  const sentence = normalized.split(/[.!?](?:\s|$)/)[0]?.trim() ?? normalized;
  if (sentence.length <= maxLength) {
    return sentence;
  }
  const sliced = sentence.slice(0, maxLength);
  const boundary = sliced.lastIndexOf(" ");
  return `${(boundary > 48 ? sliced.slice(0, boundary) : sliced).trim()}...`;
}

function composeDescription(parts: Array<string | null | undefined>) {
  return parts
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean)
    .join("\n\n");
}

function numberedStepsFromText(text: string, source: HarnessPlanStepSource, eventId?: string) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return [] as CandidatePlanStep[];
  }

  const matches = [...normalized.matchAll(/(?:^|\n)\s*(\d+)[.)]\s+([\s\S]*?)(?=(?:\n\s*\d+[.)]\s+)|$)/g)];
  if (matches.length === 0) {
    return [];
  }

  return matches
    .map((match) => normalizeWhitespace(match[2]))
    .filter(Boolean)
    .map((description) => ({
      title: shortenSentence(description),
      description,
      source,
      evidenceEventIds: eventId ? [eventId] : [],
    }));
}

function plannerCasesFromUnknown(value: unknown) {
  if (Array.isArray(value)) {
    return value as PlannerGeneratedCase[];
  }

  if (value && typeof value === "object") {
    const maybeCases = (value as { generatedCases?: unknown }).generatedCases;
    if (Array.isArray(maybeCases)) {
      return maybeCases as PlannerGeneratedCase[];
    }
  }

  return [] as PlannerGeneratedCase[];
}

function extractAgentMessageText(event: HarnessRunEvent) {
  const raw = event.raw;
  const item = raw.item;
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string") {
      return text;
    }
  }
  const fallback = raw.text;
  return typeof fallback === "string" ? fallback : null;
}

function plannerSteps(artifacts: HarnessPlanArtifacts): CandidatePlanStep[] {
  const planner = artifacts.planner;
  if (!planner) {
    return [] as CandidatePlanStep[];
  }

  const generatedCases = plannerCasesFromUnknown(planner.generatedCases);
  if (generatedCases.length > 0) {
    return generatedCases.map((item) => {
      const title = normalizeWhitespace(item.title) || "Generated case";
      const goal = normalizeWhitespace(item.goal);
      const instructions = asStringArray(item.instructions).slice(0, 2);
      return {
        title,
        description: composeDescription([
          goal,
          instructions.length > 0 ? `Planned work:\n${instructions.map((step, index) => `${index + 1}. ${step}`).join("\n")}` : null,
        ]),
        source: "planner_output" as const,
        evidenceEventIds: [],
      };
    });
  }

  if (typeof planner.outputRaw === "string") {
    try {
      const parsed = JSON.parse(planner.outputRaw) as unknown;
      const parsedCases = plannerCasesFromUnknown(parsed);
      if (parsedCases.length > 0) {
        return parsedCases.map((item) => ({
          title: normalizeWhitespace(item.title) || "Generated case",
          description: composeDescription([
            item.goal ?? null,
            asStringArray(item.instructions).join("\n"),
          ]),
          source: "planner_output",
          evidenceEventIds: [],
        }));
      }
    } catch {
      const steps = numberedStepsFromText(planner.outputRaw, "planner_output");
      if (steps.length > 0) {
        return steps;
      }
    }
  }

  return [];
}

function contractSteps(artifacts: HarnessPlanArtifacts): CandidatePlanStep[] {
  const contract = artifacts.contract;
  if (!contract) {
    return [] as CandidatePlanStep[];
  }

  const instructions = asStringArray(contract.instructions);
  if (instructions.length === 0) {
    const fallback = composeDescription([contract.goal, contract.title]);
    return fallback
      ? [{
        title: shortenSentence(contract.title ?? contract.goal ?? "Planned contract"),
        description: fallback,
        source: "contract" as const,
        evidenceEventIds: [],
      }]
      : [];
  }

  return instructions.map((instruction) => ({
    title: shortenSentence(instruction),
    description: instruction,
    source: "contract" as const,
    evidenceEventIds: [],
  }));
}

function agentMessageSteps(events: HarnessRunEvent[]): CandidatePlanStep[] {
  const candidates = events
    .filter((event) => event.kind === "agent_message")
    .map((event) => ({
      eventId: event.id,
      text: extractAgentMessageText(event),
    }))
    .filter((item): item is { eventId: string; text: string } => typeof item.text === "string" && item.text.length > 0)
    .map((item) => ({
      eventId: item.eventId,
      steps: numberedStepsFromText(item.text, "agent_message", item.eventId),
    }))
    .filter((item) => item.steps.length > 0);

  if (candidates.length === 0) {
    return [] as CandidatePlanStep[];
  }

  return candidates[candidates.length - 1].steps;
}

function combineCandidates(base: CandidatePlanStep[], overlay: CandidatePlanStep[]): CandidatePlanStep[] {
  if (base.length === 0 || overlay.length === 0 || base.length !== overlay.length) {
    return base;
  }

  return base.map((step, index) => {
    const extra = overlay[index];
    return {
      title: extra.title || step.title,
      description: composeDescription([
        extra.description,
        step.source === "contract" && step.description !== extra.description ? `Contract instruction:\n${step.description}` : null,
      ]),
      source: step.source === extra.source ? step.source : "mixed" as const,
      evidenceEventIds: unique([...step.evidenceEventIds, ...extra.evidenceEventIds]),
    };
  });
}

function tokenize(text: string) {
  return unique(
    collapseInline(text)
      .toLowerCase()
      .replace(/[`"'()[\]{}<>:;,./\\|!?+=*&^%$#@~-]/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  );
}

function taskText(task: HarnessTaskNode) {
  return composeDescription([
    task.title,
    task.summary,
    task.command,
    task.filePaths.join(" "),
  ]);
}

function scoreTask(step: CandidatePlanStep, task: HarnessTaskNode) {
  const stepTokens = tokenize(`${step.title} ${step.description}`);
  const taskTokens = new Set(tokenize(taskText(task)));
  let overlap = 0;
  for (const token of stepTokens) {
    if (taskTokens.has(token)) {
      overlap += token.length >= 8 ? 2 : 1;
    }
  }

  const taskBody = collapseInline(taskText(task)).toLowerCase();
  const stepBody = collapseInline(step.description).toLowerCase();
  if (stepBody && taskBody.includes(stepBody.slice(0, Math.min(stepBody.length, 28)))) {
    overlap += 3;
  }
  if (task.command && /mvn|test|verify|compile/.test(task.command.toLowerCase()) && /test|verify|check/.test(stepBody)) {
    overlap += 2;
  }
  if (task.filePaths.some((filePath) => stepBody.includes(pathLeaf(filePath).toLowerCase()))) {
    overlap += 2;
  }
  return overlap;
}

function pathLeaf(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? normalized;
}

function compareTaskOrder(left: HarnessTaskNode, right: HarnessTaskNode) {
  const leftKey = left.startedAt ?? left.finishedAt ?? left.id;
  const rightKey = right.startedAt ?? right.finishedAt ?? right.id;
  return leftKey.localeCompare(rightKey);
}

function comparablePlanStatus(status: HarnessNodeStatus | null): HarnessPlanStepStatus {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "interrupted":
      return "failed";
    default:
      return "pending";
  }
}

function chooseBaseSteps(artifacts: HarnessPlanArtifacts, events: HarnessRunEvent[]): CandidatePlanStep[] {
  const fromContract = contractSteps(artifacts);
  const fromAgent = agentMessageSteps(events);
  const fromPlanner = plannerSteps(artifacts);

  if (fromContract.length > 0) {
    return combineCandidates(fromContract, fromAgent);
  }
  if (fromAgent.length > 0) {
    return fromAgent;
  }
  if (fromPlanner.length > 0) {
    return fromPlanner;
  }
  return [] as CandidatePlanStep[];
}

function selectActiveTask(board: HarnessRunBoard) {
  const direct = board.activeNodeId ? board.tasks.find((task) => task.id === board.activeNodeId) ?? null : null;
  if (direct) {
    return direct;
  }
  if (!board.activeLane) {
    return null;
  }
  const lane = board.lanes[board.activeLane];
  return lane.activeTaskId ? board.tasks.find((task) => task.id === lane.activeTaskId) ?? null : null;
}

function isPlanSubtaskCandidate(task: HarnessTaskNode) {
  if (task.lane === "planner" || task.kind === "session") {
    return false;
  }
  return true;
}

function isFailureStatus(status: HarnessNodeStatus | null | undefined) {
  return status === "failed" || status === "interrupted";
}

function assignTasksToSteps(
  steps: CandidatePlanStep[],
  orderedTasks: HarnessTaskNode[],
  matchedTasks: Array<HarnessTaskNode | null>,
  currentTask: HarnessTaskNode | null,
  activeStepIndex: number | null,
) {
  const buckets = steps.map(() => [] as HarnessTaskNode[]);
  let lastAssignedIndex = 0;

  for (const task of orderedTasks) {
    let assignedIndex = matchedTasks.findIndex((candidate) => candidate?.id === task.id);

    if (assignedIndex < 0 && currentTask && activeStepIndex !== null && currentTask.id === task.id) {
      assignedIndex = activeStepIndex;
    }

    if (assignedIndex < 0) {
      let bestIndex = -1;
      let bestScore = 0;
      for (let index = 0; index < steps.length; index += 1) {
        const score = scoreTask(steps[index], task);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
      if (bestIndex >= 0 && bestScore > 0) {
        assignedIndex = bestIndex;
      }
    }

    if (assignedIndex < 0) {
      assignedIndex = activeStepIndex ?? lastAssignedIndex ?? 0;
    }

    lastAssignedIndex = Math.max(0, assignedIndex);
    buckets[Math.max(0, Math.min(steps.length - 1, assignedIndex))].push(task);
  }

  return buckets;
}

export function buildPlanView(
  runId: string,
  targetId: string,
  artifacts: HarnessPlanArtifacts,
  board: HarnessRunBoard,
  events: HarnessRunEvent[],
): HarnessPlanView {
  const baseSteps = chooseBaseSteps(artifacts, events);
  const currentTask = selectActiveTask(board);
  const orderedTasks = board.tasks
    .filter((task) => task.lane !== "planner" || baseSteps.every((step) => step.source === "planner_output"))
    .sort(compareTaskOrder);
  const subtaskCandidates = orderedTasks.filter(isPlanSubtaskCandidate);
  const assignedTaskIds = new Set<string>();
  const matchedTasks: Array<HarnessTaskNode | null> = [];
  let taskCursor = 0;

  for (const step of baseSteps) {
    let bestTask: HarnessTaskNode | null = null;
    let bestTaskIndex = -1;
    let bestScore = 0;
    for (let index = taskCursor; index < orderedTasks.length; index += 1) {
      const task = orderedTasks[index];
      if (assignedTaskIds.has(task.id)) {
        continue;
      }
      const score = scoreTask(step, task);
      if (score > bestScore) {
        bestScore = score;
        bestTask = task;
        bestTaskIndex = index;
      }
    }
    if (bestTask && bestScore > 0) {
      assignedTaskIds.add(bestTask.id);
      taskCursor = Math.max(taskCursor, bestTaskIndex + 1);
      matchedTasks.push(bestTask);
    } else {
      matchedTasks.push(null);
    }
  }

  let activeStepIndex: number | null = null;
  if (currentTask) {
    const matchedIndex = matchedTasks.findIndex((task) => task?.id === currentTask.id);
    if (matchedIndex >= 0) {
      activeStepIndex = matchedIndex;
    } else {
      let bestScore = 0;
      for (let index = 0; index < baseSteps.length; index += 1) {
        const score = scoreTask(baseSteps[index], currentTask);
        if (score > bestScore) {
          bestScore = score;
          activeStepIndex = index;
        }
      }
      if (bestScore === 0) {
        activeStepIndex = null;
      }
    }
  }

  const evaluationPassed = artifacts.evaluation?.passed === true;
  const evaluationFailed = artifacts.evaluation?.passed === false || Boolean(artifacts.evaluation?.failureReason);
  const executionFailed = isFailureStatus(currentTask?.status)
    || isFailureStatus(board.lanes.executor.status === "idle" ? null : board.lanes.executor.status)
    || isFailureStatus(board.lanes.evaluator.status === "idle" ? null : board.lanes.evaluator.status)
    || isFailureStatus(board.lanes.handoff.status === "idle" ? null : board.lanes.handoff.status);
  if (activeStepIndex === null && baseSteps.length > 0) {
    if (board.phase === "plan") {
      activeStepIndex = 0;
    } else if (board.phase === "execute" || board.phase === "evaluate" || board.phase === "handoff" || evaluationPassed || evaluationFailed) {
      activeStepIndex = baseSteps.length - 1;
    }
  }

  const stepSubtasks = assignTasksToSteps(baseSteps, subtaskCandidates, matchedTasks, currentTask, activeStepIndex);
  const steps: HarnessPlanStep[] = baseSteps.map((step, index) => {
    const matchedTask = matchedTasks[index];
    const subtasks = stepSubtasks[index] ?? [];
    const activeSubtask = subtasks.find((task) => task.id === currentTask?.id)
      ?? subtasks.find((task) => task.status === "running")
      ?? null;
    const matchedFailed = isFailureStatus(matchedTask?.status);
    const bucketRunning = subtasks.some((task) => task.status === "running");
    const bucketFailed = subtasks.some((task) => isFailureStatus(task.status));
    const bucketCompleted = subtasks.length > 0 && subtasks.every((task) => task.status === "completed");
    let status: HarnessPlanStepStatus = "pending";
    if (matchedTask) {
      status = comparablePlanStatus(matchedTask.status);
    }

    if (bucketRunning) {
      status = "running";
    } else if (bucketFailed) {
      status = "failed";
    } else if (bucketCompleted) {
      status = "completed";
    }

    if (activeStepIndex !== null) {
      if (index < activeStepIndex) {
        status = matchedFailed ? "failed" : "completed";
      } else if (index === activeStepIndex) {
        if (evaluationFailed || executionFailed || matchedFailed || bucketFailed) {
          status = "failed";
        } else if (!evaluationPassed) {
          status = board.phase === "handoff" ? "completed" : "running";
        }
      } else {
        status = evaluationPassed ? "completed" : "pending";
      }
    }

    if (evaluationPassed) {
      status = "completed";
    }

    return {
      id: `plan-step-${index + 1}`,
      runId,
      targetId,
      index: index + 1,
      title: step.title,
      description: step.description,
      status,
      source: step.source,
      matchedTaskId: matchedTask?.id ?? null,
      matchedTaskTitle: matchedTask?.title ?? null,
      matchedTaskLane: matchedTask?.lane ?? null,
      matchedTaskStatus: matchedTask?.status ?? null,
      evidenceTaskIds: matchedTask ? [matchedTask.id] : [],
      evidenceEventIds: unique([
        ...step.evidenceEventIds,
        ...(matchedTask?.rawEventIds ?? []),
        ...subtasks.flatMap((task) => task.rawEventIds),
      ]),
      startedAt: matchedTask?.startedAt ?? subtasks[0]?.startedAt ?? null,
      finishedAt: matchedTask?.finishedAt ?? subtasks.at(-1)?.finishedAt ?? null,
      updatedAt: matchedTask?.finishedAt ?? matchedTask?.startedAt ?? subtasks.at(-1)?.finishedAt ?? subtasks.at(-1)?.startedAt ?? nowIso(),
      isActive: activeStepIndex === index,
      activeSubtaskId: activeSubtask?.id ?? null,
      activeSubtaskTitle: activeSubtask?.title ?? null,
      totalSubtasks: subtasks.length,
      runningSubtasks: subtasks.filter((task) => task.status === "running").length,
      completedSubtasks: subtasks.filter((task) => task.status === "completed").length,
      failedSubtasks: subtasks.filter((task) => isFailureStatus(task.status)).length,
      subtasks: subtasks.map((task) => ({
        id: task.id,
        title: task.title,
        kind: task.kind,
        lane: task.lane,
        status: task.status,
        summary: task.summary,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        filePaths: task.filePaths,
        command: task.command,
        isActive: task.id === currentTask?.id,
      })),
    };
  });

  const contract = artifacts.contract;
  const plannerSummary = artifacts.planner?.publishResult?.summary ?? null;
  const source = steps[0]?.source ?? "none";

  return {
    runId,
    targetId,
    title: normalizeWhitespace(contract?.title) || (plannerSummary ? "Replenishment planner" : null),
    summary: composeDescription([
      contract?.goal ?? null,
      plannerSummary,
      board.latestSummary,
    ]) || null,
    source,
    activeStepId: activeStepIndex !== null ? `plan-step-${activeStepIndex + 1}` : null,
    activeStepIndex: activeStepIndex !== null ? activeStepIndex + 1 : null,
    currentTaskId: currentTask?.id ?? null,
    currentTaskTitle: currentTask?.title ?? null,
    currentTaskLane: currentTask?.lane ?? board.activeLane ?? null,
    steps,
  };
}
