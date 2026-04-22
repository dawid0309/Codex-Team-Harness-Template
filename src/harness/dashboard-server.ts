import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { URL } from "node:url";

import { FileArtifactStore } from "./artifact-store";
import {
  createEmptyRunBoard,
  createLifecycleEvent,
  normalizeCodexEvent,
  readRunEvents,
  rebuildRunBoard,
} from "./run-board";
import { buildPlanView } from "./plan-view";
import { JsonStateBackend } from "./state-backend";
import { loadTargetRegistry, resolveTargetRegistration } from "./targets";
import {
  buildSpec,
  defaultCliArgs,
  getEffectiveWorkerStatus,
  resolveResumeRunId,
  runManualEvaluation,
  startBackgroundWorker,
  stopBackgroundWorker,
  type HarnessCliArgs,
} from "./worker-controller";
import type { HarnessPlanView, HarnessRunBoard, HarnessRunEvent, HarnessTaskNode } from "./types";

type DashboardServerOptions = {
  controlRepoRoot: string;
  manifestPath: string;
  targetRegistryPath: string;
  port: number;
};

type DashboardActionBody = {
  runId?: string;
  task?: string;
  model?: string;
};

function json(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function text(response: ServerResponse, statusCode: number, content: string, contentType = "text/plain; charset=utf-8") {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", contentType);
  response.end(content);
}

function baseArgs(options: DashboardServerOptions, targetId: string, body?: DashboardActionBody): HarnessCliArgs {
  return {
    ...defaultCliArgs(),
    manifest: options.manifestPath,
    targetsFile: options.targetRegistryPath,
    target: targetId,
    runId: body?.runId ?? null,
    model: body?.model ?? null,
    task: body?.task ?? null,
  };
}

async function readJsonIfExists<T>(filePath: string) {
  if (!existsSync(filePath)) {
    return null;
  }

  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readTextIfExists(filePath: string) {
  if (!existsSync(filePath)) {
    return null;
  }

  return readFile(filePath, "utf8");
}

async function tailFile(filePath: string, maxChars = 4000) {
  if (!existsSync(filePath)) {
    return null;
  }

  const content = await readFile(filePath, "utf8");
  if (content.length <= maxChars) {
    return content;
  }

  return content.slice(content.length - maxChars);
}

async function parseBody(request: IncomingMessage): Promise<DashboardActionBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw) as DashboardActionBody;
}

async function loadTargets(options: DashboardServerOptions) {
  const registry = await loadTargetRegistry(options.controlRepoRoot, options.targetRegistryPath);
  return Object.values(registry.targets).map((target) => {
    const resolved = resolveTargetRegistration(options.controlRepoRoot, registry, target.id);
    return {
      id: resolved.id,
      label: resolved.label,
      repoRoot: resolved.repoRoot,
      adapterId: resolved.adapterId,
      artifactRoot: resolved.artifactRoot,
      adapterConfigPath: resolved.adapterConfigPath,
    };
  });
}

function fallbackBoardFromDetail(targetId: string, runId: string, detail: Awaited<ReturnType<typeof readRunArtifacts>>) {
  const board = createEmptyRunBoard({
    targetId,
    adapterId: "unknown",
    artifactRoot: "",
    manifestPath: "",
    targetRegistryPath: "",
    controlRepoRoot: "",
    targetRepoRoot: "",
    runId,
    model: null,
    taskId: null,
  });
  const contract = detail.contract as { caseId?: string; title?: string } | null;
  const checkpoint = detail.checkpoint as { phase?: string; summary?: string; updatedAt?: string } | null;
  const evaluation = detail.evaluation as { passed?: boolean; failureReason?: string | null } | null;
  const planner = detail.planner as {
    publishResult?: { summary?: string | null; publishedCount?: number | null } | null;
    generatedCases?: Array<{ id?: string | null; title?: string | null }> | null;
  } | null;
  const plannerSummary = planner?.publishResult?.summary ?? null;
  const plannerPublishedCount = planner?.publishResult?.publishedCount ?? planner?.generatedCases?.length ?? 0;
  board.phase = checkpoint?.phase === "plan" || checkpoint?.phase === "execute" || checkpoint?.phase === "evaluate" || checkpoint?.phase === "handoff"
    ? checkpoint.phase
    : plannerSummary
      ? "plan"
      : null;
  board.latestSummary = checkpoint?.summary ?? plannerSummary ?? null;
  board.updatedAt = checkpoint?.updatedAt ?? board.updatedAt;
  if (!contract?.caseId && plannerSummary) {
    board.tasks = [
      {
        id: "lane:planner:main",
        runId,
        lane: "planner",
        kind: "lifecycle",
        title: plannerPublishedCount > 0
          ? `Planner replenished ${plannerPublishedCount} case(s)`
          : "Planner checked for next work",
        status: "completed",
        startedAt: checkpoint?.updatedAt ?? null,
        finishedAt: checkpoint?.updatedAt ?? null,
        summary: plannerSummary,
        filePaths: [],
        command: null,
        children: [],
        parentId: null,
        rawEventIds: [],
      },
    ];
    board.lanes.planner = {
      ...board.lanes.planner,
      status: "completed",
      activeTaskId: "lane:planner:main",
      activeTaskTitle: plannerPublishedCount > 0
        ? `Planner replenished ${plannerPublishedCount} case(s)`
        : "Planner checked for next work",
      totalTasks: 1,
      completedTasks: 1,
      taskIds: ["lane:planner:main"],
    };
    board.activeLane = "planner";
    board.activeNodeId = "lane:planner:main";
  }
  if (contract?.caseId) {
    board.tasks = [
      {
        id: "lane:planner:main",
        runId,
        lane: "planner",
        kind: "lifecycle",
        title: contract.title ? `Planned ${contract.caseId}` : `Planned ${contract.caseId}`,
        status: checkpoint?.phase === "plan" ? "completed" : "completed",
        startedAt: checkpoint?.updatedAt ?? null,
        finishedAt: checkpoint?.updatedAt ?? null,
        summary: checkpoint?.summary ?? null,
        filePaths: [],
        command: null,
        children: [],
        parentId: null,
        rawEventIds: [],
      },
    ];
  }
  board.lanes.planner = {
    ...board.lanes.planner,
    status: contract?.caseId ? "completed" : "idle",
    activeTaskId: contract?.caseId ? "lane:planner:main" : null,
    activeTaskTitle: contract?.title ? `Planned ${contract.caseId}` : null,
    totalTasks: contract?.caseId ? 1 : 0,
    completedTasks: contract?.caseId ? 1 : 0,
    taskIds: contract?.caseId ? ["lane:planner:main"] : [],
  };
  if (board.phase === "execute") {
    board.activeLane = "executor";
  } else if (board.phase === "evaluate") {
    board.activeLane = "evaluator";
  } else if (board.phase === "handoff") {
    board.activeLane = "handoff";
  } else if (board.phase === "plan") {
    board.activeLane = "planner";
  }
  if (evaluation && evaluation.failureReason) {
    board.lanes.evaluator.status = evaluation.passed ? "completed" : "failed";
  }
  return board;
}

async function backfillBoardFromArtifacts(
  options: DashboardServerOptions,
  targetId: string,
  runId: string,
  store: FileArtifactStore,
  detail: Awaited<ReturnType<typeof readRunArtifacts>>,
) {
  const spec = await buildSpec(options.controlRepoRoot, baseArgs(options, targetId, { runId }), runId);
  const events = [] as HarnessRunEvent[];
  const contract = detail.contract as { caseId?: string; title?: string } | null;
  const execution = detail.execution as { lastMessage?: string | null; stdoutLog?: string | null; finishedAt?: string | null } | null;
  const evaluation = detail.evaluation as { passed?: boolean; failureReason?: string | null } | null;
  const checkpoint = detail.checkpoint as { phase?: string; summary?: string | null } | null;
  const planner = detail.planner as {
    publishResult?: { summary?: string | null; publishedCount?: number | null } | null;
    generatedCases?: Array<{ id?: string | null; title?: string | null }> | null;
  } | null;

  if (planner?.publishResult?.summary) {
    const plannerPublishedCount = planner.publishResult.publishedCount ?? planner.generatedCases?.length ?? 0;
    events.push(createLifecycleEvent({
      spec,
      phase: "plan",
      lane: "planner",
      status: "completed",
      title: plannerPublishedCount > 0
        ? `Planner replenished ${plannerPublishedCount} case(s)`
        : "Planner checked for next work",
      summary: planner.publishResult.summary,
    }));
  }

  if (contract?.caseId) {
    events.push(createLifecycleEvent({
      spec,
      phase: "plan",
      lane: "planner",
      status: "completed",
      title: `Planned ${contract.caseId}`,
      summary: checkpoint?.summary ?? `Contract ready for ${contract.caseId}.`,
    }));
  }

  const stdoutLogPath = typeof execution?.stdoutLog === "string" ? execution.stdoutLog : null;
  if (stdoutLogPath && existsSync(stdoutLogPath)) {
    events.push(createLifecycleEvent({
      spec,
      phase: "execute",
      lane: "executor",
      status: "completed",
      title: `Execution completed for ${contract?.caseId ?? runId}`,
      summary: execution?.lastMessage ?? checkpoint?.summary ?? null,
    }));
    const rawStdout = await readFile(stdoutLogPath, "utf8");
    for (const line of rawStdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      try {
        const rawEvent = JSON.parse(line) as Record<string, unknown>;
        const normalized = normalizeCodexEvent(spec, "execute", rawEvent);
        if (normalized) {
          events.push(normalized);
        }
      } catch {
        // ignore non-json stdout lines
      }
    }
  }

  if (evaluation) {
    events.push(createLifecycleEvent({
      spec,
      phase: "evaluate",
      lane: "evaluator",
      status: evaluation.passed ? "completed" : "failed",
      title: evaluation.passed ? `Evaluation passed for ${contract?.caseId ?? runId}` : `Evaluation failed for ${contract?.caseId ?? runId}`,
      summary: evaluation.passed
        ? `Evaluation passed for ${contract?.caseId ?? runId}.`
        : evaluation.failureReason ?? `Evaluation failed for ${contract?.caseId ?? runId}.`,
    }));
  }

  if (checkpoint?.phase === "handoff") {
    events.push(createLifecycleEvent({
      spec,
      phase: "handoff",
      lane: "handoff",
      status: evaluation?.passed === false ? "failed" : "completed",
      title: evaluation?.passed === false ? `Handoff failed for ${contract?.caseId ?? runId}` : `Completed ${contract?.caseId ?? runId}`,
      summary: checkpoint.summary ?? null,
    }));
  }

  if (events.length === 0) {
    return fallbackBoardFromDetail(targetId, runId, detail);
  }

  await store.writeText("events.jsonl", `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const board = rebuildRunBoard(spec, events);
  await store.writeJson("run-board.json", board);
  return board;
}

async function readBoardData(options: DashboardServerOptions, targetId: string, runId: string) {
  const spec = await buildSpec(options.controlRepoRoot, baseArgs(options, targetId, { runId }), runId);
  const store = new FileArtifactStore(spec);
  await store.ensure();
  const events = await readRunEvents(store).catch(() => [] as HarnessRunEvent[]);
  if (events.length > 0) {
    const board = rebuildRunBoard(spec, events);
    await store.writeJson("run-board.json", board);
    return board;
  }
  const board = await readJsonIfExists<HarnessRunBoard>(store.resolve("run-board.json"));
  if (board && (board.tasks.length > 0 || board.latestSummary || board.activeLane)) {
    return board;
  }
  return backfillBoardFromArtifacts(options, targetId, runId, store, await readRunArtifacts(options, targetId, runId));
}

async function readEventsData(options: DashboardServerOptions, targetId: string, runId: string, limit?: number) {
  const spec = await buildSpec(options.controlRepoRoot, baseArgs(options, targetId, { runId }), runId);
  const store = new FileArtifactStore(spec);
  await store.ensure();
  let events = await readRunEvents(store);
  if (events.length === 0) {
    await readBoardData(options, targetId, runId);
    events = await readRunEvents(store);
  }
  if (!limit || limit <= 0) {
    return events;
  }
  return events.slice(Math.max(0, events.length - limit));
}

async function readTaskData(options: DashboardServerOptions, targetId: string, runId: string, taskNodeId: string) {
  const [board, events] = await Promise.all([
    readBoardData(options, targetId, runId),
    readEventsData(options, targetId, runId),
  ]);
  const task = board.tasks.find((item) => item.id === taskNodeId) ?? null;
  const relatedEvents = task
    ? events.filter((event) => task.rawEventIds.includes(event.id) || event.itemId === task.id)
    : [];
  return {
    board,
    task,
    events: relatedEvents,
  };
}

async function readPlanData(
  options: DashboardServerOptions,
  targetId: string,
  runId: string,
  detailInput?: Awaited<ReturnType<typeof readRunArtifacts>>,
  boardInput?: HarnessRunBoard,
  eventsInput?: HarnessRunEvent[],
) {
  const [detail, board, events] = await Promise.all([
    detailInput ? Promise.resolve(detailInput) : readRunArtifacts(options, targetId, runId),
    boardInput ? Promise.resolve(boardInput) : readBoardData(options, targetId, runId),
    eventsInput ? Promise.resolve(eventsInput) : readEventsData(options, targetId, runId),
  ]);

  return buildPlanView(runId, targetId, {
    contract: detail.contract as Record<string, unknown> | null,
    evaluation: detail.evaluation as Record<string, unknown> | null,
    planner: detail.planner as {
      generatedCases?: unknown;
      publishResult?: Record<string, unknown> | null;
      outputRaw?: string | null;
    } | null,
  }, board, events);
}

async function readRunArtifacts(options: DashboardServerOptions, targetId: string, runId: string) {
  const spec = await buildSpec(options.controlRepoRoot, baseArgs(options, targetId, { runId }), runId);
  const runDir = path.join(options.controlRepoRoot, spec.artifactRoot, "runs", runId);
  const [
    contract,
    execution,
    executionResume,
    evaluation,
    evaluationResume,
    evaluationManual,
    checkpoint,
    handoff,
    handoffResume,
    plannerContext,
    plannerGeneratedCases,
    plannerPublishResult,
    plannerOutputRaw,
  ] = await Promise.all([
    readJsonIfExists<Record<string, unknown>>(path.join(runDir, "contract.json")),
    readJsonIfExists<Record<string, unknown>>(path.join(runDir, "execution.json")),
    readJsonIfExists<Record<string, unknown>>(path.join(runDir, "execution.resume.json")),
    readJsonIfExists<Record<string, unknown>>(path.join(runDir, "evaluation.json")),
    readJsonIfExists<Record<string, unknown>>(path.join(runDir, "evaluation.resume.json")),
    readJsonIfExists<Record<string, unknown>>(path.join(runDir, "evaluation.manual.json")),
    readJsonIfExists<Record<string, unknown>>(path.join(runDir, "checkpoint.json")),
    readTextIfExists(path.join(runDir, "handoff.md")),
    readTextIfExists(path.join(runDir, "handoff.resume.md")),
    readJsonIfExists<Record<string, unknown>>(path.join(runDir, "planner", "context.json")),
    readJsonIfExists<Record<string, unknown>>(path.join(runDir, "planner", "generated-cases.json")),
    readJsonIfExists<Record<string, unknown>>(path.join(runDir, "planner", "publish-result.json")),
    readTextIfExists(path.join(runDir, "planner", "output.raw.txt")),
  ]);
  return {
    runId,
    runDir: path.relative(options.controlRepoRoot, runDir).replaceAll("\\", "/"),
    contract,
    execution: executionResume ?? execution,
    executionPrimary: execution,
    executionResume,
    evaluation: evaluationManual ?? evaluationResume ?? evaluation,
    evaluationPrimary: evaluation,
    evaluationResume,
    evaluationManual,
    checkpoint,
    handoff: handoffResume ?? handoff,
    handoffPrimary: handoff,
    handoffResume,
    planner: {
      context: plannerContext,
      generatedCases: plannerGeneratedCases,
      publishResult: plannerPublishResult,
      outputRaw: plannerOutputRaw,
    },
  };
}

async function readRunDetails(options: DashboardServerOptions, targetId: string, runId: string) {
  const detail = await readRunArtifacts(options, targetId, runId);
  const [board, events] = await Promise.all([
    readBoardData(options, targetId, runId),
    readEventsData(options, targetId, runId),
  ]);
  const plan = await readPlanData(options, targetId, runId, detail, board, events);
  return {
    ...detail,
    board,
    plan,
  };
}

async function listRuns(options: DashboardServerOptions, targetId: string) {
  const spec = await buildSpec(options.controlRepoRoot, baseArgs(options, targetId));
  const runsDir = path.join(options.controlRepoRoot, spec.artifactRoot, "runs");
  if (!existsSync(runsDir)) {
    return [];
  }

  const entries = await readdir(runsDir, { withFileTypes: true });
  const runIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  const summaries = [];
  for (const runId of runIds) {
    const detail = await readRunDetails(options, targetId, runId);
    const contract = detail.contract as { caseId?: string; title?: string } | null;
    const checkpoint = detail.checkpoint as { phase?: string; summary?: string; updatedAt?: string } | null;
    const evaluation = detail.evaluation as { passed?: boolean; failureReason?: string | null } | null;
    const board = detail.board as HarnessRunBoard | null;
    const planner = detail.planner as {
      publishResult?: { summary?: string | null; firstReadyCaseId?: string | null } | null;
      generatedCases?: Array<{ id?: string | null; title?: string | null }> | null;
    } | null;
    const plannerFirstCase = planner?.generatedCases?.[0] ?? null;
    summaries.push({
      runId,
      caseId: contract?.caseId ?? planner?.publishResult?.firstReadyCaseId ?? plannerFirstCase?.id ?? null,
      title: contract?.title ?? plannerFirstCase?.title ?? (planner?.publishResult?.summary ? "Auto replenishment planner" : null),
      phase: board?.phase ?? checkpoint?.phase ?? (planner?.publishResult?.summary ? "plan" : null),
      summary: board?.latestSummary ?? checkpoint?.summary ?? planner?.publishResult?.summary ?? null,
      updatedAt: board?.updatedAt ?? checkpoint?.updatedAt ?? null,
      evaluationPassed: evaluation?.passed ?? null,
      failureReason: evaluation?.failureReason ?? null,
    });
  }

  return summaries;
}

async function readTargetStatus(options: DashboardServerOptions, targetId: string) {
  const args = baseArgs(options, targetId);
  const { spec, status } = await getEffectiveWorkerStatus(options.controlRepoRoot, args);
  const liveState = await new JsonStateBackend(spec).read();
  const stdoutLogPath = path.isAbsolute(status.stdoutLog)
    ? status.stdoutLog
    : path.join(options.controlRepoRoot, status.stdoutLog);
  const stderrLogPath = path.isAbsolute(status.stderrLog)
    ? status.stderrLog
    : path.join(options.controlRepoRoot, status.stderrLog);

  const currentRun = status.runId ? await readRunDetails(options, targetId, status.runId) : null;
  const board = currentRun?.board ?? null;
  const plan = currentRun?.plan ?? null;
  return {
    targetId,
    targetRepoRoot: spec.targetRepoRoot,
    artifactRoot: spec.artifactRoot,
    activeLane: board?.activeLane ?? status.activeLane ?? null,
    activeTask: board?.tasks.find((task) => task.id === (board?.activeNodeId ?? status.activeTaskId)) ?? null,
    activePlanStep: plan?.steps.find((step) => step.id === plan.activeStepId) ?? null,
    activeSubagentCount: board?.lanes.subagents.runningTasks ?? status.activeSubagentCount,
    workerStatus: status,
    liveState,
    board,
    plan,
    logs: {
      stdoutPath: path.relative(options.controlRepoRoot, stdoutLogPath).replaceAll("\\", "/"),
      stderrPath: path.relative(options.controlRepoRoot, stderrLogPath).replaceAll("\\", "/"),
      stdoutTail: await tailFile(stdoutLogPath),
      stderrTail: await tailFile(stderrLogPath),
    },
    currentRun,
  };
}

function htmlPage(port: number) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Harness Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5efe2;
      --surface: rgba(255, 252, 245, 0.92);
      --panel: #fffaf0;
      --ink: #1b1a17;
      --muted: #6a655d;
      --accent: #0c7c59;
      --accent-strong: #0b5d45;
      --warn: #a64b00;
      --error: #9b2226;
      --border: rgba(27, 26, 23, 0.12);
      --shadow: 0 18px 42px rgba(87, 68, 30, 0.12);
      --radius: 18px;
      --mono: "Cascadia Code", "IBM Plex Mono", Consolas, monospace;
      --sans: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--sans);
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(12, 124, 89, 0.16), transparent 28%),
        radial-gradient(circle at top right, rgba(166, 75, 0, 0.12), transparent 26%),
        linear-gradient(180deg, #f8f4ea 0%, var(--bg) 100%);
      min-height: 100vh;
    }
    .shell {
      max-width: 1440px;
      margin: 0 auto;
      padding: 28px;
    }
    .hero {
      display: grid;
      gap: 18px;
      grid-template-columns: 1.6fr 1fr;
      align-items: end;
      margin-bottom: 22px;
    }
    .hero-card, .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      backdrop-filter: blur(14px);
    }
    .hero-card {
      padding: 24px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(2rem, 5vw, 3.4rem);
      letter-spacing: -0.04em;
      line-height: 0.95;
    }
    .sub {
      margin: 0;
      color: var(--muted);
      max-width: 54rem;
      line-height: 1.5;
    }
    .port {
      font-family: var(--mono);
      color: var(--accent-strong);
      font-size: 0.95rem;
    }
    .layout {
      display: grid;
      grid-template-columns: 330px 1fr;
      gap: 20px;
    }
    .sidebar, .main {
      display: grid;
      gap: 18px;
      align-content: start;
    }
    .panel {
      padding: 18px;
    }
    .panel h2, .panel h3 {
      margin: 0 0 12px;
      font-size: 1rem;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    label {
      display: block;
      font-size: 0.82rem;
      color: var(--muted);
      margin-bottom: 6px;
    }
    select, input, button, textarea {
      font: inherit;
    }
    select, input {
      width: 100%;
      border-radius: 12px;
      border: 1px solid var(--border);
      padding: 11px 12px;
      background: #fff;
      color: var(--ink);
    }
    .actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    button {
      border: none;
      border-radius: 12px;
      padding: 12px 14px;
      cursor: pointer;
      transition: transform 120ms ease, opacity 120ms ease, background 120ms ease;
      font-weight: 600;
    }
    button:hover { transform: translateY(-1px); }
    button:disabled { opacity: 0.55; cursor: progress; transform: none; }
    .primary { background: var(--accent); color: white; }
    .secondary { background: #ebe4d4; color: var(--ink); }
    .danger { background: #f7d9d9; color: var(--error); }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    .stat {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
      min-height: 110px;
    }
    .stat .label {
      font-size: 0.8rem;
      color: var(--muted);
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .stat .value {
      font-size: 1.1rem;
      font-weight: 700;
      line-height: 1.25;
      word-break: break-word;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 11px;
      border-radius: 999px;
      font-weight: 700;
      font-size: 0.88rem;
      background: #e5f3ed;
      color: var(--accent-strong);
    }
    .badge.failed { background: #fae0e0; color: var(--error); }
    .badge.interrupted { background: #f9ead7; color: var(--warn); }
    .two-col {
      display: grid;
      grid-template-columns: 1.05fr 0.95fr;
      gap: 18px;
    }
    .list {
      display: grid;
      gap: 10px;
      max-height: 430px;
      overflow: auto;
      padding-right: 2px;
    }
    .run {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
      background: var(--panel);
      cursor: pointer;
    }
    .run.active {
      border-color: rgba(12, 124, 89, 0.45);
      box-shadow: inset 0 0 0 1px rgba(12, 124, 89, 0.2);
    }
    .run-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }
    .run-id {
      font-family: var(--mono);
      font-size: 0.85rem;
      color: var(--muted);
    }
    .run-title {
      font-weight: 700;
      margin-bottom: 4px;
    }
    .run-summary {
      color: var(--muted);
      font-size: 0.92rem;
      line-height: 1.4;
    }
    .lane-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
    }
    .lane-card {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
      background: var(--panel);
      cursor: pointer;
    }
    .lane-card.active {
      border-color: rgba(12, 124, 89, 0.45);
      box-shadow: inset 0 0 0 1px rgba(12, 124, 89, 0.2);
    }
    .lane-top, .task-top {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      margin-bottom: 8px;
    }
    .lane-name, .task-title {
      font-weight: 700;
    }
    .lane-meta, .task-meta {
      color: var(--muted);
      font-size: 0.86rem;
      line-height: 1.45;
    }
    .task-list {
      display: grid;
      gap: 10px;
      max-height: 360px;
      overflow: auto;
      padding-right: 2px;
    }
    .task-card {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
      background: var(--panel);
      cursor: pointer;
    }
    .task-card.active {
      border-color: rgba(166, 75, 0, 0.45);
      box-shadow: inset 0 0 0 1px rgba(166, 75, 0, 0.18);
    }
    .task-summary {
      color: var(--muted);
      font-size: 0.9rem;
      line-height: 1.45;
      margin-top: 8px;
    }
    .plan-layout {
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      gap: 18px;
    }
    .plan-list {
      display: grid;
      gap: 10px;
      max-height: 420px;
      overflow: auto;
      padding-right: 2px;
    }
    .plan-step {
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 14px;
      background: linear-gradient(180deg, rgba(255, 250, 240, 0.98), rgba(249, 241, 228, 0.92));
      cursor: pointer;
      text-align: left;
    }
    .plan-step.active {
      border-color: rgba(12, 124, 89, 0.5);
      box-shadow: inset 0 0 0 1px rgba(12, 124, 89, 0.22);
      background: linear-gradient(180deg, rgba(235, 248, 242, 0.98), rgba(246, 251, 248, 0.92));
    }
    .plan-step.current {
      outline: 2px solid rgba(166, 75, 0, 0.2);
      outline-offset: 0;
    }
    .plan-step-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }
    .plan-step-index {
      font-family: var(--mono);
      font-size: 0.82rem;
      color: var(--accent-strong);
      margin-bottom: 6px;
    }
    .plan-step-title {
      font-weight: 700;
      line-height: 1.35;
      margin-bottom: 6px;
    }
    .plan-step-desc {
      color: var(--muted);
      font-size: 0.9rem;
      line-height: 1.5;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .plan-step-meta {
      margin-top: 10px;
      color: var(--muted);
      font-size: 0.82rem;
      line-height: 1.45;
    }
    .plan-detail {
      display: grid;
      gap: 14px;
    }
    .plan-detail-box {
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--panel);
      padding: 14px;
    }
    .plan-detail-box h4 {
      margin: 0 0 8px;
      font-size: 0.82rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .plan-detail-title {
      font-size: 1.08rem;
      font-weight: 700;
      line-height: 1.4;
      margin-bottom: 8px;
    }
    .plan-detail-text {
      color: var(--ink);
      line-height: 1.65;
      white-space: pre-wrap;
    }
    .plan-detail-meta {
      color: var(--muted);
      font-size: 0.86rem;
      line-height: 1.55;
      white-space: pre-wrap;
    }
    .subtask-list {
      display: grid;
      gap: 10px;
    }
    .subtask-item {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: rgba(255, 252, 245, 0.9);
      padding: 12px;
    }
    .subtask-item.active {
      border-color: rgba(12, 124, 89, 0.45);
      box-shadow: inset 0 0 0 1px rgba(12, 124, 89, 0.2);
      background: rgba(235, 248, 242, 0.92);
    }
    .subtask-top {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      margin-bottom: 6px;
    }
    .subtask-title {
      font-weight: 700;
      line-height: 1.4;
    }
    .subtask-meta {
      color: var(--muted);
      font-size: 0.82rem;
      line-height: 1.45;
      margin-top: 6px;
      white-space: pre-wrap;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 9px;
      font-size: 0.78rem;
      font-weight: 700;
      background: #ebe4d4;
      color: var(--ink);
    }
    .pill.running { background: #e5f3ed; color: var(--accent-strong); }
    .pill.failed { background: #fae0e0; color: var(--error); }
    .pill.completed { background: #e8efe6; color: #315c2b; }
    .pill.interrupted { background: #f9ead7; color: var(--warn); }
    pre {
      margin: 0;
      padding: 14px;
      border-radius: 14px;
      background: #181815;
      color: #f6f1e7;
      overflow: auto;
      font-family: var(--mono);
      font-size: 0.84rem;
      line-height: 1.5;
    }
    .muted {
      color: var(--muted);
      line-height: 1.5;
    }
    .split {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
    }
    .meta dl {
      display: grid;
      grid-template-columns: 130px 1fr;
      gap: 10px 14px;
      margin: 0;
    }
    .meta dt {
      color: var(--muted);
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .meta dd {
      margin: 0;
      font-family: var(--mono);
      font-size: 0.92rem;
      overflow-wrap: anywhere;
    }
    .toast {
      position: fixed;
      right: 24px;
      bottom: 24px;
      background: rgba(24, 24, 21, 0.94);
      color: white;
      padding: 14px 16px;
      border-radius: 14px;
      box-shadow: var(--shadow);
      opacity: 0;
      transform: translateY(10px);
      transition: opacity 160ms ease, transform 160ms ease;
      pointer-events: none;
    }
    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }
    @media (max-width: 1100px) {
      .hero, .layout, .two-col, .split, .grid, .lane-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="hero-card">
        <div class="port">Local dashboard at http://127.0.0.1:${port}</div>
        <h1>Harness Control Deck</h1>
        <p class="sub">Monitor external targets, inspect contracts and evidence, and drive the same harness worker lifecycle from one place without coupling runtime state back into the product repository.</p>
      </div>
      <div class="hero-card">
        <div class="meta">
          <dl>
            <dt>Control Repo</dt><dd id="controlRepo">loading</dd>
            <dt>Selected Target</dt><dd id="selectedTargetLabel">loading</dd>
            <dt>Selected Run</dt><dd id="selectedRunLabel">n/a</dd>
          </dl>
        </div>
      </div>
    </section>

    <section class="layout">
      <aside class="sidebar">
        <div class="panel">
          <h2>Target</h2>
          <label for="targetSelect">Target repository</label>
          <select id="targetSelect"></select>
          <div style="height: 12px"></div>
          <label for="taskInput">Task / Case override</label>
          <input id="taskInput" placeholder="Optional case id" />
          <div style="height: 12px"></div>
          <label for="modelInput">Model override</label>
          <input id="modelInput" placeholder="Optional model" />
        </div>

        <div class="panel">
          <h2>Controls</h2>
          <div class="actions">
            <button id="startBtn" class="primary">Start</button>
            <button id="resumeBtn" class="secondary">Resume</button>
            <button id="evalBtn" class="secondary">Eval</button>
            <button id="stopBtn" class="danger">Stop</button>
          </div>
          <p class="muted" style="margin-top: 12px;">Start uses the task/model fields above. Resume and eval use the selected run when available, otherwise the latest known run for the target.</p>
        </div>

        <div class="panel">
          <h2>Run History</h2>
          <div id="runList" class="list"></div>
        </div>
      </aside>

      <main class="main">
        <div class="panel">
          <h2>Live Status</h2>
          <div class="grid">
            <div class="stat"><div class="label">Worker State</div><div class="value" id="workerState">n/a</div></div>
            <div class="stat"><div class="label">Run ID</div><div class="value" id="runId">n/a</div></div>
            <div class="stat"><div class="label">Phase</div><div class="value" id="phase">n/a</div></div>
            <div class="stat"><div class="label">Case</div><div class="value" id="caseTitle">n/a</div></div>
            <div class="stat"><div class="label">Current Step</div><div class="value" id="currentStepLabel">n/a</div></div>
          </div>
          <div style="height: 12px"></div>
          <div id="statusBadge" class="badge">idle</div>
          <p class="muted" id="summaryText" style="margin-top: 12px;">Waiting for data.</p>
        </div>

        <div class="panel">
          <h2>Plan Steps</h2>
          <div class="plan-layout">
            <div id="planList" class="plan-list"></div>
            <div id="planDetail" class="plan-detail">
              <div class="plan-detail-box">
                <h4>Step Detail</h4>
                <div class="plan-detail-title">No plan loaded.</div>
                <div class="plan-detail-text">Select a run to inspect extracted steps from planner output, contract instructions, and agent messages.</div>
              </div>
            </div>
          </div>
        </div>

        <div class="panel">
          <h2>Execution Board</h2>
          <div id="laneBoard" class="lane-grid"></div>
        </div>

        <div class="two-col">
          <div class="panel">
            <h3>Lane Tasks</h3>
            <div id="taskList" class="task-list"></div>
          </div>
          <div class="panel">
            <h3>Task Detail</h3>
            <pre id="taskDetail">Select a lane or task node to inspect the current execution unit.</pre>
          </div>
        </div>

        <div class="two-col">
          <div class="panel meta">
            <h3>Worker Metadata</h3>
            <dl>
              <dt>Target Repo</dt><dd id="targetRepo">n/a</dd>
              <dt>Adapter</dt><dd id="adapterId">n/a</dd>
              <dt>Active Lane</dt><dd id="activeLane">n/a</dd>
              <dt>Active Task</dt><dd id="activeTask">n/a</dd>
              <dt>Subagents</dt><dd id="activeSubagents">0</dd>
              <dt>Thread</dt><dd id="threadId">n/a</dd>
              <dt>Checkpoint</dt><dd id="checkpointPath">n/a</dd>
              <dt>Stdout</dt><dd id="stdoutPath">n/a</dd>
              <dt>Stderr</dt><dd id="stderrPath">n/a</dd>
            </dl>
          </div>
          <div class="panel meta">
            <h3>Live State</h3>
            <dl>
              <dt>Status</dt><dd id="liveStatus">n/a</dd>
              <dt>Phase</dt><dd id="livePhase">n/a</dd>
              <dt>Started</dt><dd id="startedAt">n/a</dd>
              <dt>Updated</dt><dd id="updatedAt">n/a</dd>
              <dt>Failure</dt><dd id="failureReason">n/a</dd>
              <dt>Artifact Root</dt><dd id="artifactRoot">n/a</dd>
            </dl>
          </div>
        </div>

        <div class="split">
          <div class="panel">
            <h3>Event Feed</h3>
            <pre id="eventsTail">Loading...</pre>
          </div>
          <div class="panel">
            <h3>Worker Stdout Tail</h3>
            <pre id="stdoutTail">Loading...</pre>
          </div>
        </div>

        <div class="split">
          <div class="panel">
            <h3>Worker Stderr Tail</h3>
            <pre id="stderrTail">Loading...</pre>
          </div>
          <div class="panel">
            <h3>Current Handoff</h3>
            <pre id="handoffText">No handoff loaded.</pre>
          </div>
        </div>

        <div class="split">
          <div class="panel">
            <h3>Run Detail</h3>
            <pre id="runDetail">Select a run to inspect contract, execution, evaluation, and handoff artifacts.</pre>
          </div>
          <div class="panel">
            <h3>Board JSON</h3>
            <pre id="boardJson">No board loaded.</pre>
          </div>
        </div>
      </main>
    </section>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    const state = {
      targets: [],
      targetId: null,
      selectedRunId: null,
      selectedLane: null,
      selectedTaskId: null,
      selectedPlanStepId: null,
      board: null,
      plan: null,
      pollHandle: null,
      busy: false,
    };

    const targetSelect = document.getElementById("targetSelect");
    const taskInput = document.getElementById("taskInput");
    const modelInput = document.getElementById("modelInput");
    const runList = document.getElementById("runList");
    const toast = document.getElementById("toast");
    const laneBoard = document.getElementById("laneBoard");
    const taskList = document.getElementById("taskList");
    const planList = document.getElementById("planList");
    const planDetail = document.getElementById("planDetail");

    function showToast(message, isError = false) {
      toast.textContent = message;
      toast.style.background = isError ? "rgba(155, 34, 38, 0.95)" : "rgba(24, 24, 21, 0.94)";
      toast.classList.add("show");
      window.clearTimeout(showToast.timer);
      showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2200);
    }

    function setBusy(busy) {
      state.busy = busy;
      document.querySelectorAll("button").forEach((button) => button.disabled = busy);
    }

    function statusBadgeClass(stateName) {
      if (stateName === "failed") return "badge failed";
      if (stateName === "interrupted") return "badge interrupted";
      return "badge";
    }

    function pillClass(status) {
      return "pill " + (status || "");
    }

    function laneIds() {
      return ["planner", "executor", "evaluator", "handoff", "subagents"];
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function formatMultiline(value) {
      return escapeHtml(value || "").replace(/\n/g, "<br />");
    }

    async function api(path, options) {
      const response = await fetch(path, options);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || response.statusText);
      }
      return response.json();
    }

    async function loadTargets() {
      const payload = await api("/api/targets");
      const externalTargets = payload.targets.filter((target) => target.id !== "foundry");
      state.targets = externalTargets.length > 0 ? externalTargets : payload.targets;
      targetSelect.innerHTML = "";
      state.targets.forEach((target) => {
        const option = document.createElement("option");
        option.value = target.id;
        option.textContent = target.label + " (" + target.id + ")";
        targetSelect.appendChild(option);
      });
      state.targetId = state.targets[0]?.id ?? null;
      if (state.targetId) {
        targetSelect.value = state.targetId;
      }
      document.getElementById("controlRepo").textContent = payload.controlRepoRoot;
    }

    async function refreshRuns() {
      if (!state.targetId) return;
      const payload = await api("/api/targets/" + encodeURIComponent(state.targetId) + "/runs");
      runList.innerHTML = "";
      if (payload.runs.length === 0) {
        runList.innerHTML = '<div class="muted">No runs recorded for this target yet.</div>';
        return;
      }
      if (!state.selectedRunId) {
        state.selectedRunId = payload.runs[0].runId;
      }
      payload.runs.forEach((run) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "run" + (state.selectedRunId === run.runId ? " active" : "");
        item.innerHTML =
          '<div class="run-top"><span class="run-id">' + run.runId + '</span><span class="' + statusBadgeClass(run.evaluationPassed === false ? "failed" : "completed") + '">' + (run.phase || "n/a") + '</span></div>' +
          '<div class="run-title">' + (run.title || "Untitled run") + '</div>' +
          '<div class="run-summary">' + (run.summary || "No summary recorded.") + '</div>';
        item.addEventListener("click", async () => {
          state.selectedRunId = run.runId;
          state.selectedLane = null;
          state.selectedTaskId = null;
          state.selectedPlanStepId = null;
          await refreshRuns();
          await refreshRunDetail();
          await refreshBoard();
          await refreshTaskDetail();
        });
        runList.appendChild(item);
      });
    }

    async function refreshRunDetail() {
      if (!state.targetId || !state.selectedRunId) {
        document.getElementById("runDetail").textContent = "No run selected.";
        document.getElementById("handoffText").textContent = "No handoff loaded.";
        document.getElementById("boardJson").textContent = "No board loaded.";
        document.getElementById("selectedRunLabel").textContent = "n/a";
        return;
      }
      const detail = await api("/api/targets/" + encodeURIComponent(state.targetId) + "/runs/" + encodeURIComponent(state.selectedRunId));
      document.getElementById("selectedRunLabel").textContent = detail.run.runId;
      state.plan = detail.run.plan || state.plan;
      document.getElementById("runDetail").textContent = JSON.stringify({
        contract: detail.run.contract,
        execution: detail.run.execution,
        evaluation: detail.run.evaluation,
        checkpoint: detail.run.checkpoint,
        planner: detail.run.planner,
        plan: detail.run.plan,
      }, null, 2);
      document.getElementById("handoffText").textContent = detail.run.handoff || "No handoff loaded.";
      document.getElementById("boardJson").textContent = JSON.stringify(detail.run.board || {}, null, 2);
    }

    async function refreshStatus() {
      if (!state.targetId) return;
      const payload = await api("/api/targets/" + encodeURIComponent(state.targetId) + "/status");
      const worker = payload.status.workerStatus;
      const live = payload.status.liveState;
      state.board = payload.status.board || state.board;
      state.plan = payload.status.plan || state.plan;
      document.getElementById("selectedTargetLabel").textContent = payload.status.targetId;
      document.getElementById("workerState").textContent = worker.state || "n/a";
      document.getElementById("runId").textContent = worker.runId || "n/a";
      document.getElementById("phase").textContent = worker.phase || "n/a";
      document.getElementById("caseTitle").textContent = worker.caseId ? worker.caseId + " - " + (worker.title || "") : "n/a";
      document.getElementById("currentStepLabel").textContent = payload.status.activePlanStep
        ? "Step " + payload.status.activePlanStep.index + " of " + ((payload.status.plan?.steps || []).length || payload.status.activePlanStep.index)
        : "n/a";
      const badge = document.getElementById("statusBadge");
      badge.className = statusBadgeClass(worker.state);
      badge.textContent = worker.state || "idle";
      document.getElementById("summaryText").textContent = worker.latestSummary || "No summary recorded.";
      document.getElementById("targetRepo").textContent = payload.status.targetRepoRoot;
      document.getElementById("adapterId").textContent = worker.adapterId || "n/a";
      document.getElementById("activeLane").textContent = payload.status.activeLane || "n/a";
      document.getElementById("activeTask").textContent = payload.status.activeTask ? payload.status.activeTask.title : (worker.activeTaskTitle || worker.activeTaskId || "n/a");
      document.getElementById("activeSubagents").textContent = String(payload.status.activeSubagentCount || 0);
      document.getElementById("threadId").textContent = worker.threadId || "n/a";
      document.getElementById("checkpointPath").textContent = worker.latestCheckpoint || "n/a";
      document.getElementById("stdoutPath").textContent = payload.status.logs.stdoutPath || "n/a";
      document.getElementById("stderrPath").textContent = payload.status.logs.stderrPath || "n/a";
      document.getElementById("liveStatus").textContent = live.status || "n/a";
      document.getElementById("livePhase").textContent = live.phase || "n/a";
      document.getElementById("startedAt").textContent = live.startedAt || "n/a";
      document.getElementById("updatedAt").textContent = live.updatedAt || "n/a";
      document.getElementById("failureReason").textContent = live.failureReason || "n/a";
      document.getElementById("artifactRoot").textContent = payload.status.artifactRoot || "n/a";
      document.getElementById("stdoutTail").textContent = payload.status.logs.stdoutTail || "";
      document.getElementById("stderrTail").textContent = payload.status.logs.stderrTail || "";
      document.getElementById("boardJson").textContent = JSON.stringify(payload.status.board || {}, null, 2);
      if (!state.selectedRunId && worker.runId) {
        state.selectedRunId = worker.runId;
      }
      if (payload.status.currentRun && payload.status.currentRun.runId === state.selectedRunId) {
        document.getElementById("runDetail").textContent = JSON.stringify({
          contract: payload.status.currentRun.contract,
          execution: payload.status.currentRun.execution,
          evaluation: payload.status.currentRun.evaluation,
          checkpoint: payload.status.currentRun.checkpoint,
          planner: payload.status.currentRun.planner,
          plan: payload.status.currentRun.plan,
        }, null, 2);
        document.getElementById("handoffText").textContent = payload.status.currentRun.handoff || "No handoff loaded.";
      }
    }

    function renderLaneBoard(board) {
      laneBoard.innerHTML = "";
      if (!board) {
        laneBoard.innerHTML = '<div class="muted">No board data yet.</div>';
        return;
      }
      laneIds().forEach((laneId) => {
        const lane = board.lanes[laneId];
        const card = document.createElement("button");
        card.type = "button";
        card.className = "lane-card" + (state.selectedLane === laneId ? " active" : "");
        card.innerHTML =
          '<div class="lane-top"><div class="lane-name">' + lane.label + '</div><span class="' + pillClass(lane.status) + '">' + lane.status + '</span></div>' +
          '<div class="lane-meta">Tasks: ' + lane.totalTasks + ' | Running: ' + lane.runningTasks + ' | Done: ' + lane.completedTasks + ' | Failed: ' + lane.failedTasks + '</div>' +
          '<div class="lane-meta" style="margin-top:8px;">Active: ' + (lane.activeTaskTitle || "n/a") + '</div>';
        card.addEventListener("click", async () => {
          state.selectedLane = laneId;
          state.selectedTaskId = lane.activeTaskId || null;
          renderLaneBoard(board);
          renderTaskList(board);
          await refreshTaskDetail();
        });
        laneBoard.appendChild(card);
      });
    }

    function renderTaskList(board) {
      taskList.innerHTML = "";
      if (!board) {
        taskList.innerHTML = '<div class="muted">No task data yet.</div>';
        return;
      }
      const laneId = state.selectedLane || board.activeLane || "planner";
      const tasks = board.tasks.filter((task) => task.lane === laneId);
      if (tasks.length === 0) {
        taskList.innerHTML = '<div class="muted">No task nodes for this lane yet.</div>';
        return;
      }
      if (!state.selectedTaskId || !tasks.some((task) => task.id === state.selectedTaskId)) {
        state.selectedTaskId = tasks[0].id;
      }
      tasks.forEach((task) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "task-card" + (state.selectedTaskId === task.id ? " active" : "");
        card.innerHTML =
          '<div class="task-top"><div class="task-title">' + task.title + '</div><span class="' + pillClass(task.status) + '">' + task.status + '</span></div>' +
          '<div class="task-meta">Kind: ' + task.kind + ' | Started: ' + (task.startedAt || "n/a") + '</div>' +
          '<div class="task-summary">' + (task.summary || "No summary recorded.") + '</div>';
        card.addEventListener("click", async () => {
          state.selectedTaskId = task.id;
          renderTaskList(board);
          await refreshTaskDetail();
        });
        taskList.appendChild(card);
      });
    }

    function renderPlanList(plan) {
      planList.innerHTML = "";
      if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
        planList.innerHTML = '<div class="muted">No structured plan steps were extracted for this run yet.</div>';
        return;
      }
      if (!state.selectedPlanStepId || !plan.steps.some((step) => step.id === state.selectedPlanStepId)) {
        state.selectedPlanStepId = plan.activeStepId || plan.steps[0].id;
      }
      plan.steps.forEach((step) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "plan-step"
          + (state.selectedPlanStepId === step.id ? " active" : "")
          + (step.isActive ? " current" : "");
        card.innerHTML =
          '<div class="plan-step-top"><div>'
            + '<div class="plan-step-index">Step ' + step.index + '</div>'
            + '<div class="plan-step-title">' + escapeHtml(step.title) + '</div>'
          + '</div><span class="' + pillClass(step.status) + '">' + escapeHtml(step.status) + '</span></div>'
          + '<div class="plan-step-desc">' + escapeHtml(step.description) + '</div>'
          + '<div class="plan-step-meta">Source: ' + escapeHtml(step.source)
            + ' | Tasks: ' + String(step.totalSubtasks || 0)
            + (step.runningSubtasks ? ' | Running: ' + String(step.runningSubtasks) : '')
            + (step.failedSubtasks ? ' | Failed: ' + String(step.failedSubtasks) : '')
            + (step.activeSubtaskTitle ? ' | Active: ' + escapeHtml(step.activeSubtaskTitle) : '')
            + '</div>';
        card.addEventListener("click", () => {
          state.selectedPlanStepId = step.id;
          renderPlanList(plan);
          renderPlanDetail(plan);
        });
        planList.appendChild(card);
      });
    }

    function renderPlanDetail(plan) {
      if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
        planDetail.innerHTML =
          '<div class="plan-detail-box"><h4>Step Detail</h4><div class="plan-detail-title">No plan loaded.</div><div class="plan-detail-text">This run has not produced a contract, planner output, or agent-message plan that the dashboard can structure yet.</div></div>';
        return;
      }
      const step = plan.steps.find((item) => item.id === state.selectedPlanStepId) || plan.steps[0];
      if (!step) {
        planDetail.innerHTML =
          '<div class="plan-detail-box"><h4>Step Detail</h4><div class="plan-detail-title">No step selected.</div></div>';
        return;
      }
      const linkedNode = step.matchedTaskTitle
        ? 'Linked executor/subagent node: ' + step.matchedTaskTitle
        : 'No executor/subagent node matched this step yet.';
      const progressSummary = plan.activeStepId === step.id
        ? 'This is the current step the harness is driving right now.'
        : 'This step is currently marked as ' + step.status + '.';
      const subtasksHtml = Array.isArray(step.subtasks) && step.subtasks.length > 0
        ? '<div class="plan-detail-box">'
          + '<h4>Step Tasks</h4>'
          + '<div class="subtask-list">'
          + step.subtasks.map((subtask) =>
            '<div class="subtask-item' + (subtask.isActive ? ' active' : '') + '">'
              + '<div class="subtask-top"><div class="subtask-title">' + escapeHtml(subtask.title) + '</div><span class="' + pillClass(subtask.status) + '">' + escapeHtml(subtask.status) + '</span></div>'
              + '<div class="subtask-meta">' + formatMultiline([
                'Kind: ' + subtask.kind,
                'Lane: ' + subtask.lane,
                subtask.startedAt ? 'Started: ' + subtask.startedAt : null,
                subtask.finishedAt ? 'Finished: ' + subtask.finishedAt : null,
                subtask.command ? 'Command: ' + subtask.command : null,
                Array.isArray(subtask.filePaths) && subtask.filePaths.length > 0 ? 'Files: ' + subtask.filePaths.join(', ') : null,
                subtask.summary || null,
              ].filter(Boolean).join('\n')) + '</div>'
            + '</div>'
          ).join('')
          + '</div>'
        + '</div>'
        : '<div class="plan-detail-box"><h4>Step Tasks</h4><div class="plan-detail-meta">No concrete executor/subagent tasks have been mapped to this step yet.</div></div>';
      planDetail.innerHTML =
        '<div class="plan-detail-box">'
          + '<h4>Run Plan</h4>'
          + '<div class="plan-detail-title">' + escapeHtml(plan.title || "Extracted execution plan") + '</div>'
          + '<div class="plan-detail-meta">' + formatMultiline(plan.summary || "No overall plan summary recorded.") + '</div>'
        + '</div>'
        + '<div class="plan-detail-box">'
          + '<h4>Selected Step</h4>'
          + '<div class="plan-detail-title">Step ' + step.index + ': ' + escapeHtml(step.title) + '</div>'
          + '<div class="plan-detail-text">' + formatMultiline(step.description) + '</div>'
        + '</div>'
        + '<div class="plan-detail-box">'
          + '<h4>Status Mapping</h4>'
          + '<div class="plan-detail-meta">'
            + formatMultiline([
              'Step status: ' + step.status,
              'Plan source: ' + step.source,
              progressSummary,
              linkedNode,
              'Mapped tasks: ' + String(step.totalSubtasks || 0),
              step.activeSubtaskTitle ? 'Current task in this step: ' + step.activeSubtaskTitle : null,
              step.matchedTaskLane ? 'Linked lane: ' + step.matchedTaskLane : null,
              step.matchedTaskStatus ? 'Linked node status: ' + step.matchedTaskStatus : null,
            ].filter(Boolean).join('\n'))
          + '</div>'
        + '</div>';
      planDetail.innerHTML += subtasksHtml;
    }

    async function refreshBoard() {
      if (!state.targetId || !state.selectedRunId) {
        state.board = null;
        state.plan = null;
        renderLaneBoard(null);
        renderTaskList(null);
        renderPlanList(null);
        renderPlanDetail(null);
        document.getElementById("eventsTail").textContent = "No events loaded.";
        return;
      }
      const [boardPayload, eventsPayload, planPayload] = await Promise.all([
        api("/api/targets/" + encodeURIComponent(state.targetId) + "/runs/" + encodeURIComponent(state.selectedRunId) + "/board"),
        api("/api/targets/" + encodeURIComponent(state.targetId) + "/runs/" + encodeURIComponent(state.selectedRunId) + "/events?limit=30"),
        api("/api/targets/" + encodeURIComponent(state.targetId) + "/runs/" + encodeURIComponent(state.selectedRunId) + "/plan"),
      ]);
      state.board = boardPayload.board;
      state.plan = planPayload.plan;
      if (!state.selectedLane || !state.board.lanes[state.selectedLane]) {
        state.selectedLane = state.board.activeLane || laneIds().find((laneId) => state.board.lanes[laneId].totalTasks > 0) || "planner";
      }
      renderLaneBoard(state.board);
      renderTaskList(state.board);
      renderPlanList(state.plan);
      renderPlanDetail(state.plan);
      document.getElementById("eventsTail").textContent = JSON.stringify(eventsPayload.events, null, 2);
      document.getElementById("boardJson").textContent = JSON.stringify(state.board, null, 2);
    }

    async function refreshTaskDetail() {
      if (!state.targetId || !state.selectedRunId || !state.selectedTaskId) {
        document.getElementById("taskDetail").textContent = "Select a task node to inspect the current execution unit.";
        return;
      }
      const payload = await api(
        "/api/targets/" + encodeURIComponent(state.targetId) + "/runs/" + encodeURIComponent(state.selectedRunId) + "/tasks/" + encodeURIComponent(state.selectedTaskId),
      );
      document.getElementById("taskDetail").textContent = JSON.stringify({
        task: payload.task,
        events: payload.events,
      }, null, 2);
    }

    async function performAction(action, body) {
      if (!state.targetId) return;
      try {
        setBusy(true);
        const payload = await api("/api/targets/" + encodeURIComponent(state.targetId) + "/" + action, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {}),
        });
        showToast(payload.message || (action + " completed"));
        if (payload.runId) {
          state.selectedRunId = payload.runId;
          state.selectedLane = null;
          state.selectedTaskId = null;
          state.selectedPlanStepId = null;
        }
        await refreshAll();
      } catch (error) {
        showToast(error.message || String(error), true);
      } finally {
        setBusy(false);
      }
    }

    async function refreshAll() {
      await refreshStatus();
      await refreshRuns();
      await refreshRunDetail();
      await refreshBoard();
      await refreshTaskDetail();
    }

    targetSelect.addEventListener("change", async () => {
      state.targetId = targetSelect.value;
      state.selectedRunId = null;
      state.selectedLane = null;
      state.selectedTaskId = null;
      state.selectedPlanStepId = null;
      await refreshAll();
    });

    document.getElementById("startBtn").addEventListener("click", async () => {
      await performAction("start", {
        task: taskInput.value.trim() || undefined,
        model: modelInput.value.trim() || undefined,
      });
    });

    document.getElementById("resumeBtn").addEventListener("click", async () => {
      await performAction("resume", {
        runId: state.selectedRunId || undefined,
        model: modelInput.value.trim() || undefined,
      });
    });

    document.getElementById("evalBtn").addEventListener("click", async () => {
      await performAction("eval", {
        runId: state.selectedRunId || undefined,
      });
    });

    document.getElementById("stopBtn").addEventListener("click", async () => {
      await performAction("stop");
    });

    async function bootstrap() {
      await loadTargets();
      await refreshAll();
      state.pollHandle = window.setInterval(() => {
        refreshStatus().catch((error) => console.error(error));
        refreshRuns().catch((error) => console.error(error));
        refreshBoard().catch((error) => console.error(error));
        refreshTaskDetail().catch((error) => console.error(error));
      }, 2500);
    }

    bootstrap().catch((error) => showToast(error.message || String(error), true));
  </script>
</body>
</html>`;
}

async function handleAction(
  options: DashboardServerOptions,
  response: ServerResponse,
  targetId: string,
  action: string,
  body: DashboardActionBody,
) {
  const args = baseArgs(options, targetId, body);
  switch (action) {
    case "start": {
      const result = await startBackgroundWorker(options.controlRepoRoot, "run", args);
      json(response, 200, {
        ok: true,
        message: `Started harness worker for ${result.spec.targetId}.`,
        runId: result.runId,
      });
      return;
    }
    case "stop": {
      const result = await stopBackgroundWorker(options.controlRepoRoot, args);
      json(response, 200, {
        ok: true,
        message: result.stopped ? `Stopped harness worker for ${result.spec.targetId}.` : "No active harness worker is running.",
      });
      return;
    }
    case "resume": {
      const runId = body.runId ?? await resolveResumeRunId(options.controlRepoRoot, args);
      const result = await startBackgroundWorker(options.controlRepoRoot, "resume", { ...args, runId });
      json(response, 200, {
        ok: true,
        message: `Resumed harness worker for ${result.spec.targetId}.`,
        runId: result.runId,
      });
      return;
    }
    case "eval": {
      const runId = body.runId ?? await resolveResumeRunId(options.controlRepoRoot, args);
      const result = await runManualEvaluation(options.controlRepoRoot, { ...args, runId });
      json(response, 200, {
        ok: true,
        message: `Manual evaluation completed for ${result.contract.caseId}.`,
        runId: result.spec.runId,
        passed: result.evaluation.passed,
      });
      return;
    }
    default:
      json(response, 404, { error: `Unknown action "${action}".` });
  }
}

export async function startDashboardServer(options: DashboardServerOptions) {
  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${options.port}`);
      const segments = url.pathname.split("/").filter(Boolean);

      if (method === "GET" && url.pathname === "/") {
        text(response, 200, htmlPage(options.port), "text/html; charset=utf-8");
        return;
      }

      if (method === "GET" && segments.length === 2 && segments[0] === "api" && segments[1] === "targets") {
        const targets = await loadTargets(options);
        json(response, 200, {
          controlRepoRoot: options.controlRepoRoot,
          targets,
        });
        return;
      }

      if (segments.length >= 4 && segments[0] === "api" && segments[1] === "targets") {
        const targetId = decodeURIComponent(segments[2]);

        if (method === "GET" && segments.length === 4 && segments[3] === "status") {
          json(response, 200, {
            status: await readTargetStatus(options, targetId),
          });
          return;
        }

        if (method === "GET" && segments.length === 4 && segments[3] === "runs") {
          json(response, 200, {
            runs: await listRuns(options, targetId),
          });
          return;
        }

        if (method === "GET" && segments.length === 5 && segments[3] === "runs") {
          const runId = decodeURIComponent(segments[4]);
          json(response, 200, {
            run: await readRunDetails(options, targetId, runId),
          });
          return;
        }

        if (method === "GET" && segments.length === 6 && segments[3] === "runs" && segments[5] === "board") {
          const runId = decodeURIComponent(segments[4]);
          json(response, 200, {
            board: await readBoardData(options, targetId, runId),
          });
          return;
        }

        if (method === "GET" && segments.length === 6 && segments[3] === "runs" && segments[5] === "plan") {
          const runId = decodeURIComponent(segments[4]);
          json(response, 200, {
            plan: await readPlanData(options, targetId, runId),
          });
          return;
        }

        if (method === "GET" && segments.length === 6 && segments[3] === "runs" && segments[5] === "events") {
          const runId = decodeURIComponent(segments[4]);
          const limit = Number(url.searchParams.get("limit") ?? "0");
          json(response, 200, {
            events: await readEventsData(options, targetId, runId, Number.isFinite(limit) ? limit : 0),
          });
          return;
        }

        if (method === "GET" && segments.length === 6 && segments[3] === "runs" && segments[5] === "tasks") {
          const runId = decodeURIComponent(segments[4]);
          const board = await readBoardData(options, targetId, runId);
          json(response, 200, {
            tasks: board.tasks,
            board,
          });
          return;
        }

        if (method === "GET" && segments.length === 7 && segments[3] === "runs" && segments[5] === "tasks") {
          const runId = decodeURIComponent(segments[4]);
          const taskNodeId = decodeURIComponent(segments[6]);
          json(response, 200, await readTaskData(options, targetId, runId, taskNodeId));
          return;
        }

        if (method === "POST" && segments.length === 4) {
          const action = segments[3];
          const body = await parseBody(request);
          await handleAction(options, response, targetId, action, body);
          return;
        }
      }

      json(response, 404, { error: "Not found." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(response, 500, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });

  return server;
}
