import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { nowIso } from "./time";
import type {
  HarnessArtifactStore,
  HarnessLaneBoard,
  HarnessLaneId,
  HarnessNodeStatus,
  HarnessPhase,
  HarnessRunBoard,
  HarnessRunEvent,
  HarnessRunEventKind,
  HarnessRunSpec,
  HarnessTaskNode,
} from "./types";

const LANE_ORDER: HarnessLaneId[] = ["planner", "executor", "evaluator", "handoff", "subagents"];

const LANE_LABELS: Record<HarnessLaneId, string> = {
  planner: "Planner",
  executor: "Executor",
  evaluator: "Evaluator",
  handoff: "Handoff",
  subagents: "Subagents",
};

function phaseLane(phase: HarnessPhase | null): HarnessLaneId | null {
  switch (phase) {
    case "plan":
      return "planner";
    case "execute":
      return "executor";
    case "evaluate":
      return "evaluator";
    case "handoff":
      return "handoff";
    default:
      return null;
  }
}

function eventId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyLane(lane: HarnessLaneId): HarnessLaneBoard {
  return {
    lane,
    label: LANE_LABELS[lane],
    status: "idle",
    activeTaskId: null,
    activeTaskTitle: null,
    totalTasks: 0,
    runningTasks: 0,
    completedTasks: 0,
    failedTasks: 0,
    taskIds: [],
  };
}

export function createEmptyRunBoard(spec: HarnessRunSpec): HarnessRunBoard {
  return {
    runId: spec.runId,
    targetId: spec.targetId,
    phase: null,
    activeLane: null,
    activeNodeId: null,
    latestSummary: null,
    updatedAt: nowIso(),
    lanes: {
      planner: emptyLane("planner"),
      executor: emptyLane("executor"),
      evaluator: emptyLane("evaluator"),
      handoff: emptyLane("handoff"),
      subagents: emptyLane("subagents"),
    },
    tasks: [],
  };
}

function taskSortScore(task: HarnessTaskNode) {
  const priority: Record<HarnessNodeStatus, number> = {
    running: 0,
    failed: 1,
    interrupted: 2,
    pending: 3,
    completed: 4,
  };
  return priority[task.status];
}

function sortTasks(tasks: HarnessTaskNode[]) {
  return [...tasks].sort((left, right) => {
    const priority = taskSortScore(left) - taskSortScore(right);
    if (priority !== 0) {
      return priority;
    }

    const leftTs = left.startedAt ?? left.finishedAt ?? "";
    const rightTs = right.startedAt ?? right.finishedAt ?? "";
    return rightTs.localeCompare(leftTs);
  });
}

function normalizeNodeStatus(status: string | undefined, fallback: HarnessNodeStatus): HarnessNodeStatus {
  switch (status) {
    case "running":
    case "completed":
    case "failed":
    case "interrupted":
    case "pending":
      return status;
    default:
      return fallback;
  }
}

function itemKind(type: unknown): HarnessRunEventKind {
  switch (type) {
    case "agent_message":
    case "command_execution":
    case "file_change":
      return type;
    default:
      return "item";
  }
}

function trimText(value: string | null | undefined, maxLength = 240) {
  if (!value) {
    return null;
  }

  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return null;
  }
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength - 3)}...`;
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseFilePaths(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => safeRecord(item).path)
    .filter((item): item is string => typeof item === "string" && item.length > 0);
}

function commandTitle(command: string | null) {
  if (!command) {
    return "Command execution";
  }
  const trimmed = trimText(command, 90);
  return trimmed ?? "Command execution";
}

function itemTitle(item: Record<string, unknown>) {
  const type = item.type;
  if (type === "agent_message") {
    return "Agent message";
  }
  if (type === "command_execution") {
    return commandTitle(typeof item.command === "string" ? item.command : null);
  }
  if (type === "file_change") {
    const changes = parseFilePaths(item.changes);
    if (changes.length === 1) {
      return `File change: ${changes[0]}`;
    }
    if (changes.length > 1) {
      return `File changes (${changes.length})`;
    }
    return "File change";
  }
  return typeof type === "string" ? type : "Execution item";
}

function itemSummary(item: Record<string, unknown>) {
  if (item.type === "agent_message") {
    return trimText(typeof item.text === "string" ? item.text : null, 400);
  }
  if (item.type === "command_execution") {
    const output = trimText(typeof item.aggregated_output === "string" ? item.aggregated_output : null, 400);
    if (output) {
      return output;
    }
    const command = trimText(typeof item.command === "string" ? item.command : null, 220);
    return command;
  }
  if (item.type === "file_change") {
    const changes = parseFilePaths(item.changes);
    if (changes.length > 0) {
      return changes.join(", ");
    }
  }
  return null;
}

export function createLifecycleEvent(input: {
  spec: HarnessRunSpec;
  phase: HarnessPhase;
  lane: HarnessLaneId;
  status: HarnessNodeStatus;
  title: string;
  summary: string | null;
  itemId?: string | null;
  parentItemId?: string | null;
  raw?: Record<string, unknown>;
}) {
  return {
    id: eventId(input.lane),
    runId: input.spec.runId,
    targetId: input.spec.targetId,
    ts: nowIso(),
    kind: "lifecycle" as const,
    phase: input.phase,
    lane: input.lane,
    status: input.status,
    title: input.title,
    summary: input.summary,
    itemId: input.itemId ?? `lane:${input.lane}:main`,
    parentItemId: input.parentItemId ?? null,
    raw: input.raw ?? {},
  } satisfies HarnessRunEvent;
}

export function normalizeCodexEvent(spec: HarnessRunSpec, phase: HarnessPhase, raw: Record<string, unknown>) {
  const type = typeof raw.type === "string" ? raw.type : null;
  if (!type) {
    return null;
  }

  if (type === "thread.started") {
    return {
      id: eventId("thread"),
      runId: spec.runId,
      targetId: spec.targetId,
      ts: nowIso(),
      kind: "session" as const,
      phase,
      lane: "subagents" as const,
      status: "completed" as const,
      title: "Codex thread started",
      summary: typeof raw.thread_id === "string" ? raw.thread_id : null,
      itemId: typeof raw.thread_id === "string" ? `thread:${raw.thread_id}` : null,
      parentItemId: null,
      raw,
    } satisfies HarnessRunEvent;
  }

  if (type === "turn.started") {
    return {
      id: eventId("turn"),
      runId: spec.runId,
      targetId: spec.targetId,
      ts: nowIso(),
      kind: "session" as const,
      phase,
      lane: "subagents" as const,
      status: "running" as const,
      title: "Codex turn started",
      summary: null,
      itemId: "turn:current",
      parentItemId: null,
      raw,
    } satisfies HarnessRunEvent;
  }

  if (type === "turn.completed") {
    return {
      id: eventId("turn"),
      runId: spec.runId,
      targetId: spec.targetId,
      ts: nowIso(),
      kind: "session" as const,
      phase,
      lane: "subagents" as const,
      status: "completed" as const,
      title: "Codex turn completed",
      summary: null,
      itemId: "turn:current",
      parentItemId: null,
      raw,
    } satisfies HarnessRunEvent;
  }

  if (type === "turn.failed") {
    const error = safeRecord(raw.error);
    return {
      id: eventId("turn"),
      runId: spec.runId,
      targetId: spec.targetId,
      ts: nowIso(),
      kind: "error" as const,
      phase,
      lane: "subagents" as const,
      status: "failed" as const,
      title: "Codex turn failed",
      summary: trimText(typeof error.message === "string" ? error.message : null, 400),
      itemId: "turn:current",
      parentItemId: null,
      raw,
    } satisfies HarnessRunEvent;
  }

  if (type === "error") {
    return {
      id: eventId("error"),
      runId: spec.runId,
      targetId: spec.targetId,
      ts: nowIso(),
      kind: "error" as const,
      phase,
      lane: "subagents" as const,
      status: "failed" as const,
      title: "Codex error",
      summary: trimText(typeof raw.message === "string" ? raw.message : null, 400),
      itemId: null,
      parentItemId: null,
      raw,
    } satisfies HarnessRunEvent;
  }

  if (type === "item.started" || type === "item.completed") {
    const item = safeRecord(raw.item);
    const itemId = typeof item.id === "string" ? item.id : eventId("item");
    const rawStatus = typeof item.status === "string" ? item.status : undefined;
    const eventStatus = type === "item.started"
      ? normalizeNodeStatus(rawStatus, "running")
      : normalizeNodeStatus(rawStatus, "completed");
    return {
      id: eventId("item"),
      runId: spec.runId,
      targetId: spec.targetId,
      ts: nowIso(),
      kind: itemKind(item.type),
      phase,
      lane: "subagents" as const,
      status: eventStatus,
      title: itemTitle(item),
      summary: itemSummary(item),
      itemId,
      parentItemId: null,
      raw,
    } satisfies HarnessRunEvent;
  }

  return null;
}

function updateNodeFromEvent(node: HarnessTaskNode | undefined, event: HarnessRunEvent) {
  const rawItem = safeRecord(event.raw.item);
  const command = typeof rawItem.command === "string" ? rawItem.command : null;
  const filePaths = parseFilePaths(rawItem.changes);
  const next: HarnessTaskNode = node
    ? {
        ...node,
        title: event.title || node.title,
        status: event.status,
        summary: event.summary ?? node.summary,
        command: command ?? node.command,
        filePaths: filePaths.length > 0 ? filePaths : node.filePaths,
        parentId: event.parentItemId ?? node.parentId,
        rawEventIds: node.rawEventIds.includes(event.id) ? node.rawEventIds : [...node.rawEventIds, event.id],
      }
    : {
        id: event.itemId ?? event.id,
        runId: event.runId,
        lane: event.lane,
        kind: event.kind,
        title: event.title,
        status: event.status,
        startedAt: null,
        finishedAt: null,
        summary: event.summary,
        filePaths,
        command,
        children: [],
        parentId: event.parentItemId,
        rawEventIds: [event.id],
      };

  if (event.status === "running" && !next.startedAt) {
    next.startedAt = event.ts;
  }

  if ((event.status === "completed" || event.status === "failed" || event.status === "interrupted") && !next.startedAt) {
    next.startedAt = event.ts;
  }

  if (event.status === "completed" || event.status === "failed" || event.status === "interrupted") {
    next.finishedAt = event.ts;
  }

  return next;
}

function shouldUseEventAsBoardSummary(event: HarnessRunEvent) {
  return event.kind === "lifecycle" || event.kind === "agent_message" || event.kind === "error";
}

function isTerminalSubagentFailure(task: HarnessTaskNode) {
  return task.lane === "subagents"
    && task.status === "failed"
    && (task.kind === "error" || task.id === "turn:current");
}

function finalizeBoard(board: HarnessRunBoard) {
  const taskMap = new Map(board.tasks.map((task) => [task.id, task]));
  for (const task of taskMap.values()) {
    if (!task.parentId) {
      continue;
    }
    const parent = taskMap.get(task.parentId);
    if (!parent) {
      continue;
    }
    if (!parent.children.includes(task.id)) {
      parent.children = [...parent.children, task.id];
    }
  }

  const terminalSubagentTask = taskMap.get("turn:current");
  const shouldCloseSubagentTasks = board.phase === "handoff"
    || board.phase === "evaluate"
    || terminalSubagentTask?.status === "completed"
    || terminalSubagentTask?.status === "failed"
    || terminalSubagentTask?.status === "interrupted";
  if (shouldCloseSubagentTasks) {
    const finishedAt = terminalSubagentTask?.finishedAt ?? board.updatedAt;
    const danglingStatus: HarnessNodeStatus = terminalSubagentTask?.status === "failed"
      ? "failed"
      : "interrupted";
    for (const task of taskMap.values()) {
      if (task.lane !== "subagents" || task.status !== "running") {
        continue;
      }
      task.status = danglingStatus;
      task.startedAt = task.startedAt ?? finishedAt;
      task.finishedAt = finishedAt;
    }
  }

  const lanes = { ...board.lanes };
  for (const lane of LANE_ORDER) {
    const laneTasks = sortTasks(
      [...taskMap.values()].filter((task) => task.lane === lane),
    );
    const runningTasks = laneTasks.filter((task) => task.status === "running");
    const failedTasks = laneTasks.filter((task) => task.status === "failed");
    const completedTasks = laneTasks.filter((task) => task.status === "completed");
    const terminalFailedTasks = lane === "subagents"
      ? failedTasks.filter((task) => isTerminalSubagentFailure(task))
      : failedTasks;
    const activeTask = runningTasks[0] ?? terminalFailedTasks[0] ?? failedTasks[0] ?? laneTasks[0] ?? null;
    let status: HarnessLaneBoard["status"] = "idle";
    if (runningTasks.length > 0) {
      status = "running";
    } else if (terminalFailedTasks.length > 0) {
      status = "failed";
    } else if (laneTasks.length > 0 && completedTasks.length === laneTasks.length) {
      status = "completed";
    } else if (laneTasks.length > 0) {
      status = "pending";
    }

    lanes[lane] = {
      ...lanes[lane],
      status,
      activeTaskId: activeTask?.id ?? null,
      activeTaskTitle: activeTask?.title ?? null,
      totalTasks: laneTasks.length,
      runningTasks: runningTasks.length,
      completedTasks: completedTasks.length,
      failedTasks: failedTasks.length,
      taskIds: laneTasks.map((task) => task.id),
    };
  }

  const orderedTasks = sortTasks([...taskMap.values()]);
  const preferredLane = phaseLane(board.phase);
  const activeLane = (preferredLane && lanes[preferredLane].status !== "idle"
    ? preferredLane
    : null)
    ?? LANE_ORDER.find((lane) => lanes[lane].status === "running")
    ?? LANE_ORDER.find((lane) => lanes[lane].status === "failed")
    ?? board.activeLane
    ?? null;
  const activeNodeId = activeLane ? lanes[activeLane].activeTaskId : null;

  return {
    ...board,
    activeLane,
    activeNodeId,
    lanes,
    tasks: orderedTasks,
  };
}

export function rebuildRunBoard(spec: HarnessRunSpec, events: HarnessRunEvent[]) {
  const board = createEmptyRunBoard(spec);
  const taskMap = new Map<string, HarnessTaskNode>();

  for (const event of events) {
    board.phase = event.phase;
    if (event.summary && shouldUseEventAsBoardSummary(event)) {
      board.latestSummary = event.summary;
    }
    board.updatedAt = event.ts;
    const nodeId = event.itemId ?? event.id;
    const current = taskMap.get(nodeId);
    taskMap.set(nodeId, updateNodeFromEvent(current, event));
  }

  board.tasks = [...taskMap.values()];
  return finalizeBoard(board);
}

export async function readRunEvents(store: HarnessArtifactStore) {
  const target = store.resolve("events.jsonl");
  if (!existsSync(target)) {
    return [] as HarnessRunEvent[];
  }

  const content = await readFile(target, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HarnessRunEvent);
}

export async function readRunBoard(store: HarnessArtifactStore) {
  const target = store.resolve("run-board.json");
  if (!existsSync(target)) {
    return null;
  }

  return JSON.parse(await readFile(target, "utf8")) as HarnessRunBoard;
}

export async function rebuildAndWriteRunBoard(spec: HarnessRunSpec, store: HarnessArtifactStore) {
  const events = await readRunEvents(store);
  const board = rebuildRunBoard(spec, events);
  await store.writeJson("run-board.json", board);
  return board;
}

export async function appendRunEventAndRebuild(spec: HarnessRunSpec, store: HarnessArtifactStore, event: HarnessRunEvent) {
  await store.appendJsonLine("events.jsonl", event);
  const events = await readRunEvents(store);
  const board = rebuildRunBoard(spec, events);
  await store.writeJson("run-board.json", board);
  return board;
}
