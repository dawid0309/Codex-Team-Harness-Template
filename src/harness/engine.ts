import { existsSync } from "node:fs";
import path from "node:path";

import { FileArtifactStore } from "./artifact-store";
import { isNoReadyWorkError } from "./errors";
import { createExternalTargetAdapter } from "./external-target";
import { createFoundryAdapter } from "./foundry-adapter";
import { loadHarnessManifest, resolveAdapterManifest } from "./manifest";
import { appendRunEventAndRebuild, createEmptyRunBoard, createLifecycleEvent, normalizeCodexEvent } from "./run-board";
import { JsonStateBackend, writeCheckpoint } from "./state-backend";
import { createRunId, nowIso } from "./time";
import { createRunSpec, resolveTargetForSpec } from "./targets";
import type {
  HarnessCompletionUpdate,
  EvaluationResult,
  ExecutionResult,
  HarnessArtifactStore,
  HarnessCheckpoint,
  HarnessContext,
  HarnessLiveState,
  HarnessPhase,
  HarnessReadyWorkItem,
  HarnessRunSpec,
  HarnessRunStatus,
  HarnessTarget,
  SprintContract,
} from "./types";

class RunEventRecorder {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly spec: HarnessRunSpec,
    private readonly store: HarnessArtifactStore,
  ) {}

  async initialize(options: { reset: boolean }) {
    if (options.reset) {
      await this.store.writeText("events.jsonl", "");
      await this.store.writeJson("run-board.json", createEmptyRunBoard(this.spec));
      return;
    }

    if (!existsSync(this.store.resolve("events.jsonl"))) {
      await this.store.writeText("events.jsonl", "");
    }
    if (!existsSync(this.store.resolve("run-board.json"))) {
      await this.store.writeJson("run-board.json", createEmptyRunBoard(this.spec));
    }
  }

  async recordLifecycle(input: {
    phase: HarnessPhase;
    lane: "planner" | "executor" | "evaluator" | "handoff";
    status: "pending" | "running" | "completed" | "failed" | "interrupted";
    title: string;
    summary: string | null;
  }) {
    return this.enqueue(async () => {
      await appendRunEventAndRebuild(this.spec, this.store, createLifecycleEvent({
        spec: this.spec,
        phase: input.phase,
        lane: input.lane,
        status: input.status,
        title: input.title,
        summary: input.summary,
      }));
    });
  }

  async recordCodexEvent(phase: HarnessPhase, raw: Record<string, unknown>) {
    return this.enqueue(async () => {
      const event = normalizeCodexEvent(this.spec, phase, raw);
      if (!event) {
        return;
      }
      await appendRunEventAndRebuild(this.spec, this.store, event);
    });
  }

  async flush() {
    await this.chain;
  }

  private async enqueue(task: () => Promise<void>) {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    await next;
  }
}

function createTarget(context: HarnessContext): HarnessTarget {
  if (context.manifest.id === "foundry") {
    return createFoundryAdapter(context.manifest);
  }
  if (context.manifest.id === "external-generic") {
    return createExternalTargetAdapter(context.manifest);
  }
  throw new Error(`No target factory is registered for adapter "${context.manifest.id}".`);
}

function relativeToControlRepo(spec: HarnessRunSpec, absolutePath: string) {
  return path.relative(spec.controlRepoRoot, absolutePath).replaceAll("\\", "/");
}

function statusPhase(status: HarnessRunStatus, currentPhase: HarnessPhase | null): HarnessPhase | null {
  switch (status) {
    case "planning":
    case "planned":
      return "plan";
    case "executing":
    case "executed":
      return "execute";
    case "evaluating":
      return "evaluate";
    case "completed":
    case "failed":
      return "handoff";
    case "interrupted":
      return currentPhase;
    default:
      return currentPhase;
  }
}

async function updateLiveState(
  stateBackend: JsonStateBackend,
  spec: HarnessRunSpec,
  status: HarnessRunStatus,
  options: {
    phase?: HarnessPhase | null;
    caseId?: string | null;
    title?: string | null;
    threadId?: string | null;
    summary?: string | null;
    failureReason?: string | null;
    checkpointPath?: string | null;
    startedAt?: string | null;
  } = {},
) {
  const hasThreadId = Object.prototype.hasOwnProperty.call(options, "threadId");
  const hasSummary = Object.prototype.hasOwnProperty.call(options, "summary");
  const hasFailureReason = Object.prototype.hasOwnProperty.call(options, "failureReason");
  const hasCheckpointPath = Object.prototype.hasOwnProperty.call(options, "checkpointPath");
  const hasStartedAt = Object.prototype.hasOwnProperty.call(options, "startedAt");
  const hasPhase = Object.prototype.hasOwnProperty.call(options, "phase");
  const hasCaseId = Object.prototype.hasOwnProperty.call(options, "caseId");
  const hasTitle = Object.prototype.hasOwnProperty.call(options, "title");

  await stateBackend.update((current) => ({
    ...current,
    status,
    phase: hasPhase ? options.phase ?? null : statusPhase(status, current.phase),
    runId: spec.runId,
    targetId: spec.targetId,
    adapterId: spec.adapterId,
    caseId: hasCaseId ? options.caseId ?? null : current.caseId,
    title: hasTitle ? options.title ?? null : current.title,
    threadId: hasThreadId ? options.threadId ?? null : current.threadId,
    startedAt: hasStartedAt ? options.startedAt ?? null : current.startedAt ?? nowIso(),
    latestCheckpoint: hasCheckpointPath ? options.checkpointPath ?? null : current.latestCheckpoint,
    latestSummary: hasSummary ? options.summary ?? null : current.latestSummary,
    failureReason: hasFailureReason ? options.failureReason ?? null : current.failureReason,
    updatedAt: nowIso(),
  }));
}

async function writePhaseCheckpoint(
  spec: HarnessRunSpec,
  store: HarnessArtifactStore,
  phase: HarnessCheckpoint["phase"],
  payload: {
    caseId?: string | null;
    title?: string | null;
    contractFile?: string | null;
    executionFile?: string | null;
    evaluationFile?: string | null;
    threadId?: string | null;
    summary?: string | null;
  },
) {
  const checkpointPath = store.resolve("checkpoint.json");
  const checkpoint: HarnessCheckpoint = {
    runId: spec.runId,
    targetId: spec.targetId,
    adapterId: spec.adapterId,
    phase,
    caseId: payload.caseId ?? null,
    title: payload.title ?? null,
    contractFile: payload.contractFile ?? null,
    executionFile: payload.executionFile ?? null,
    evaluationFile: payload.evaluationFile ?? null,
    threadId: payload.threadId ?? null,
    updatedAt: nowIso(),
    summary: payload.summary ?? null,
  };
  await writeCheckpoint(checkpointPath, checkpoint);
  return checkpointPath;
}

async function buildContext(spec: HarnessRunSpec) {
  const manifestFile = await loadHarnessManifest(spec.controlRepoRoot, spec.manifestPath);
  const manifest = resolveAdapterManifest(manifestFile, spec.adapterId);
  const artifactStore = new FileArtifactStore(spec);
  await artifactStore.ensure();
  const { target } = await resolveTargetForSpec({
    controlRepoRoot: spec.controlRepoRoot,
    targetRegistryPath: spec.targetRegistryPath,
    targetId: spec.targetId,
  });
  const context: HarnessContext = {
    controlRepoRoot: spec.controlRepoRoot,
    targetRepoRoot: spec.targetRepoRoot,
    runSpec: spec,
    target,
    manifest,
    artifactStore,
    selectedTaskId: spec.taskId,
  };
  return context;
}

function createExecutionObserver(
  stateBackend: JsonStateBackend,
  spec: HarnessRunSpec,
  contract: SprintContract,
  recorder: RunEventRecorder,
): NonNullable<HarnessContext["executionObserver"]> {
  return {
    onThreadStarted: async (threadId: string) => {
      await updateLiveState(stateBackend, spec, "executing", {
        phase: "execute",
        caseId: contract.caseId,
        title: contract.title,
        threadId,
        summary: `Executing ${contract.caseId}.`,
        failureReason: null,
      });
    },
    onCodexEvent: async (event: Record<string, unknown>) => {
      await recorder.recordCodexEvent("execute", event);
    },
  };
}

export async function runHarness(input: {
  controlRepoRoot: string;
  manifestPath?: string;
  targetRegistryPath?: string;
  targetId?: string | null;
  adapterId?: string | null;
  runId?: string | null;
  model?: string | null;
  taskId?: string | null;
}) {
  const { spec, target } = await createRunSpec({
    controlRepoRoot: input.controlRepoRoot,
    manifestPath: input.manifestPath,
    targetRegistryPath: input.targetRegistryPath,
    targetId: input.targetId ?? null,
    adapterId: input.adapterId ?? null,
    runId: input.runId ?? createRunId(),
    model: input.model ?? null,
    taskId: input.taskId ?? null,
  });

  const stateBackend = new JsonStateBackend(spec);
  const context = await buildContext(spec);
  const targetAdapter = createTarget(context);
  const recorder = new RunEventRecorder(spec, context.artifactStore);
  await context.artifactStore.writeJson("run-spec.json", spec);
  await context.artifactStore.writeJson("target-registration.json", target);
  await recorder.initialize({ reset: true });
  await updateLiveState(stateBackend, spec, "planning", {
    phase: "plan",
    caseId: null,
    title: null,
    threadId: null,
    startedAt: nowIso(),
    summary: `Planning ${spec.targetId}.`,
    failureReason: null,
    checkpointPath: null,
  });
  await recorder.recordLifecycle({
    phase: "plan",
    lane: "planner",
    status: "running",
    title: `Planning ${spec.targetId}`,
    summary: `Planning ${spec.targetId}.`,
  });

  let contract: SprintContract | null = null;
  let execution: ExecutionResult | null = null;
  let evaluation: EvaluationResult | null = null;
  let completion: HarnessCompletionUpdate | null = null;

  try {
    contract = await targetAdapter.plan(context);
    const contractFile = await context.artifactStore.writeJson("contract.json", contract);
    const planCheckpoint = await writePhaseCheckpoint(spec, context.artifactStore, "plan", {
      caseId: contract.caseId,
      title: contract.title,
      contractFile: relativeToControlRepo(spec, contractFile),
      summary: `Contract ready for ${contract.caseId}.`,
    });
    await updateLiveState(stateBackend, spec, "planned", {
      phase: "plan",
      caseId: contract.caseId,
      title: contract.title,
      summary: `Planned ${contract.caseId}: ${contract.title}`,
      failureReason: null,
      checkpointPath: relativeToControlRepo(spec, planCheckpoint),
    });
    await recorder.recordLifecycle({
      phase: "plan",
      lane: "planner",
      status: "completed",
      title: `Planned ${contract.caseId}`,
      summary: `Contract ready for ${contract.caseId}.`,
    });

    await updateLiveState(stateBackend, spec, "executing", {
      phase: "execute",
      caseId: contract.caseId,
      title: contract.title,
      threadId: null,
      summary: `Executing ${contract.caseId}.`,
      failureReason: null,
    });
    await recorder.recordLifecycle({
      phase: "execute",
      lane: "executor",
      status: "running",
      title: `Executing ${contract.caseId}`,
      summary: `Executing ${contract.caseId}.`,
    });
    execution = await targetAdapter.execute({
      ...context,
      contract,
      threadId: null,
      resume: false,
      executionObserver: createExecutionObserver(stateBackend, spec, contract, recorder),
    });
    const executionFile = await context.artifactStore.writeJson("execution.json", execution);
    if (!execution.passed) {
      await recorder.flush();
      throw new Error(execution.failureReason ?? `Execution failed with exit code ${execution.exitCode}.`);
    }

    const executeCheckpoint = await writePhaseCheckpoint(spec, context.artifactStore, "execute", {
      caseId: contract.caseId,
      title: contract.title,
      contractFile: relativeToControlRepo(spec, contractFile),
      executionFile: relativeToControlRepo(spec, executionFile),
      threadId: execution.threadId,
      summary: execution.lastMessage ?? `Execution completed for ${contract.caseId}.`,
    });
    await updateLiveState(stateBackend, spec, "executed", {
      phase: "execute",
      caseId: contract.caseId,
      title: contract.title,
      threadId: execution.threadId,
      summary: execution.lastMessage ?? `Execution completed for ${contract.caseId}.`,
      checkpointPath: relativeToControlRepo(spec, executeCheckpoint),
    });
    await recorder.recordLifecycle({
      phase: "execute",
      lane: "executor",
      status: "completed",
      title: `Execution completed for ${contract.caseId}`,
      summary: execution.lastMessage ?? `Execution completed for ${contract.caseId}.`,
    });

    await updateLiveState(stateBackend, spec, "evaluating", {
      phase: "evaluate",
      caseId: contract.caseId,
      title: contract.title,
      threadId: execution.threadId,
      summary: `Evaluating ${contract.caseId}.`,
    });
    await recorder.recordLifecycle({
      phase: "evaluate",
      lane: "evaluator",
      status: "running",
      title: `Evaluating ${contract.caseId}`,
      summary: `Evaluating ${contract.caseId}.`,
    });
    evaluation = await targetAdapter.evaluate({ ...context, contract, execution });
    const evaluationFile = await context.artifactStore.writeJson("evaluation.json", evaluation);
    if (evaluation.passed && targetAdapter.completeWork) {
      completion = await targetAdapter.completeWork({ ...context, contract, execution, evaluation });
      if (completion) {
        await context.artifactStore.writeJson("completion.json", completion);
      }
    }
    await recorder.recordLifecycle({
      phase: "evaluate",
      lane: "evaluator",
      status: evaluation.passed ? "completed" : "failed",
      title: evaluation.passed ? `Evaluation passed for ${contract.caseId}` : `Evaluation failed for ${contract.caseId}`,
      summary: evaluation.passed
        ? `Evaluation passed for ${contract.caseId}.`
        : evaluation.failureReason ?? `Evaluation failed for ${contract.caseId}.`,
    });
    await recorder.recordLifecycle({
      phase: "handoff",
      lane: "handoff",
      status: "running",
      title: `Preparing handoff for ${contract.caseId}`,
      summary: `Preparing handoff for ${contract.caseId}.`,
    });
    await context.artifactStore.writeText(
      "handoff.md",
      [
        "# Harness Handoff",
        "",
        `- run_id: ${spec.runId}`,
        `- target: ${spec.targetId}`,
        `- adapter: ${spec.adapterId}`,
        `- task: ${contract.caseId}`,
        `- title: ${contract.title}`,
        `- thread_id: ${execution.threadId ?? "n/a"}`,
        `- execution_passed: ${execution.passed}`,
        `- evaluation_passed: ${evaluation.passed}`,
        `- completion_update: ${completion?.summary ?? "none"}`,
        `- summary: ${execution.lastMessage ?? evaluation.failureReason ?? "No summary emitted."}`,
      ].join("\n"),
    );

    const handoffCheckpoint = await writePhaseCheckpoint(spec, context.artifactStore, "handoff", {
      caseId: contract.caseId,
      title: contract.title,
      contractFile: relativeToControlRepo(spec, contractFile),
      executionFile: relativeToControlRepo(spec, executionFile),
      evaluationFile: relativeToControlRepo(spec, evaluationFile),
      threadId: execution.threadId,
      summary: evaluation.passed
        ? `Completed ${contract.caseId}.`
        : evaluation.failureReason ?? `Evaluation failed for ${contract.caseId}.`,
    });
    await recorder.recordLifecycle({
      phase: "handoff",
      lane: "handoff",
      status: evaluation.passed ? "completed" : "failed",
      title: evaluation.passed ? `Completed ${contract.caseId}` : `Handoff failed for ${contract.caseId}`,
      summary: evaluation.passed
        ? `Completed ${contract.caseId}.`
        : evaluation.failureReason ?? `Evaluation failed for ${contract.caseId}.`,
    });
    await recorder.flush();

    await updateLiveState(stateBackend, spec, evaluation.passed ? "completed" : "failed", {
      phase: "handoff",
      caseId: contract.caseId,
      title: contract.title,
      threadId: execution.threadId,
      summary: evaluation.passed
        ? `Completed ${contract.caseId}.`
        : evaluation.failureReason ?? `Evaluation failed for ${contract.caseId}.`,
      failureReason: evaluation.failureReason,
      checkpointPath: relativeToControlRepo(spec, handoffCheckpoint),
    });
    return { spec, contract, execution, evaluation, statePath: stateBackend.path() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const checkpointAbsolute = context.artifactStore.resolve("checkpoint.json");
    const failedPhase: HarnessPhase = evaluation
      ? "evaluate"
      : execution
        ? "execute"
        : "plan";
    const failedLane = failedPhase === "plan"
      ? "planner"
      : failedPhase === "execute"
        ? "executor"
        : "evaluator";
    await recorder.recordLifecycle({
      phase: failedPhase,
      lane: failedLane,
      status: "failed",
      title: `${failedLane} failed`,
      summary: message,
    });
    await recorder.flush();
    await updateLiveState(stateBackend, spec, "failed", {
      phase: failedPhase,
      caseId: contract?.caseId ?? null,
      title: contract?.title ?? null,
      threadId: execution?.threadId ?? null,
      summary: message,
      failureReason: message,
      checkpointPath: existsSync(checkpointAbsolute) ? relativeToControlRepo(spec, checkpointAbsolute) : null,
    });
    throw error;
  }
}

export async function resumeHarness(input: {
  controlRepoRoot: string;
  manifestPath?: string;
  targetRegistryPath?: string;
  runId: string;
  targetId?: string | null;
  adapterId?: string | null;
  model?: string | null;
}) {
  const { spec } = await createRunSpec({
    controlRepoRoot: input.controlRepoRoot,
    manifestPath: input.manifestPath,
    targetRegistryPath: input.targetRegistryPath,
    targetId: input.targetId ?? null,
    adapterId: input.adapterId ?? null,
    runId: input.runId,
    model: input.model ?? null,
    taskId: null,
  });

  const context = await buildContext(spec);
  const target = createTarget(context);
  const stateBackend = new JsonStateBackend(spec);
  const contract = await context.artifactStore.readJson<SprintContract>("contract.json");
  const checkpoint = await context.artifactStore.readJson<HarnessCheckpoint>("checkpoint.json");
  const recorder = new RunEventRecorder(spec, context.artifactStore);
  await recorder.initialize({ reset: false });

  await updateLiveState(stateBackend, spec, "executing", {
    phase: "execute",
    caseId: contract.caseId,
    title: contract.title,
    threadId: checkpoint.threadId,
    summary: `Resuming ${contract.caseId}.`,
    failureReason: null,
  });
  await recorder.recordLifecycle({
    phase: "execute",
    lane: "executor",
    status: "running",
    title: `Resuming ${contract.caseId}`,
    summary: `Resuming ${contract.caseId}.`,
  });

  const execution = await target.execute({
    ...context,
    contract,
    threadId: checkpoint.threadId,
    resume: true,
    executionObserver: createExecutionObserver(stateBackend, spec, contract, recorder),
  });
  const executionFile = await context.artifactStore.writeJson("execution.resume.json", execution);
  if (!execution.passed) {
    const message = execution.failureReason ?? `Resume execution failed with exit code ${execution.exitCode}.`;
    await recorder.recordLifecycle({
      phase: "execute",
      lane: "executor",
      status: "failed",
      title: `Resume execution failed for ${contract.caseId}`,
      summary: message,
    });
    await recorder.flush();
    await updateLiveState(stateBackend, spec, "failed", {
      phase: "execute",
      caseId: contract.caseId,
      title: contract.title,
      threadId: execution.threadId,
      summary: message,
      failureReason: message,
      checkpointPath: relativeToControlRepo(spec, context.artifactStore.resolve("checkpoint.json")),
    });
    throw new Error(message);
  }

  await updateLiveState(stateBackend, spec, "evaluating", {
    phase: "evaluate",
    caseId: contract.caseId,
    title: contract.title,
    threadId: execution.threadId,
    summary: `Evaluating resumed run ${contract.caseId}.`,
  });
  await recorder.recordLifecycle({
    phase: "execute",
    lane: "executor",
    status: "completed",
    title: `Resume execution completed for ${contract.caseId}`,
    summary: execution.lastMessage ?? `Resume execution completed for ${contract.caseId}.`,
  });
  await recorder.recordLifecycle({
    phase: "evaluate",
    lane: "evaluator",
    status: "running",
    title: `Evaluating resumed run ${contract.caseId}`,
    summary: `Evaluating resumed run ${contract.caseId}.`,
  });
  const evaluation = await target.evaluate({ ...context, contract, execution });
  const evaluationFile = await context.artifactStore.writeJson("evaluation.resume.json", evaluation);
  let completion: HarnessCompletionUpdate | null = null;
  if (evaluation.passed && target.completeWork) {
    completion = await target.completeWork({ ...context, contract, execution, evaluation });
    if (completion) {
      await context.artifactStore.writeJson("completion.resume.json", completion);
    }
  }
  await recorder.recordLifecycle({
    phase: "evaluate",
    lane: "evaluator",
    status: evaluation.passed ? "completed" : "failed",
    title: evaluation.passed ? `Evaluation passed for ${contract.caseId}` : `Evaluation failed for ${contract.caseId}`,
    summary: evaluation.passed
      ? `Evaluation passed for ${contract.caseId}.`
      : evaluation.failureReason ?? `Evaluation failed for ${contract.caseId}.`,
  });
  await recorder.recordLifecycle({
    phase: "handoff",
    lane: "handoff",
    status: "running",
    title: `Preparing resumed handoff for ${contract.caseId}`,
    summary: `Preparing handoff for ${contract.caseId}.`,
  });
  await context.artifactStore.writeText(
    "handoff.resume.md",
    [
      "# Harness Handoff",
      "",
      `- run_id: ${spec.runId}`,
      `- target: ${spec.targetId}`,
      `- adapter: ${spec.adapterId}`,
      `- task: ${contract.caseId}`,
      `- title: ${contract.title}`,
      `- thread_id: ${execution.threadId ?? "n/a"}`,
      `- execution_passed: ${execution.passed}`,
      `- evaluation_passed: ${evaluation.passed}`,
      `- completion_update: ${completion?.summary ?? "none"}`,
      `- summary: ${execution.lastMessage ?? evaluation.failureReason ?? "No summary emitted."}`,
    ].join("\n"),
  );
  const handoffCheckpoint = await writePhaseCheckpoint(spec, context.artifactStore, "handoff", {
    caseId: contract.caseId,
    title: contract.title,
    contractFile: "contract.json",
    executionFile: relativeToControlRepo(spec, executionFile),
    evaluationFile: relativeToControlRepo(spec, evaluationFile),
    threadId: execution.threadId,
    summary: evaluation.passed
      ? `Resumed run completed for ${contract.caseId}.`
      : evaluation.failureReason ?? `Evaluation failed for ${contract.caseId}.`,
  });
  await recorder.recordLifecycle({
    phase: "handoff",
    lane: "handoff",
    status: evaluation.passed ? "completed" : "failed",
    title: evaluation.passed ? `Resumed run completed for ${contract.caseId}` : `Resumed handoff failed for ${contract.caseId}`,
    summary: evaluation.passed
      ? `Resumed run completed for ${contract.caseId}.`
      : evaluation.failureReason ?? `Evaluation failed for ${contract.caseId}.`,
  });
  await recorder.flush();
  await updateLiveState(stateBackend, spec, evaluation.passed ? "completed" : "failed", {
    phase: "handoff",
    caseId: contract.caseId,
    title: contract.title,
    threadId: execution.threadId,
    summary: evaluation.passed
      ? `Resumed run completed for ${contract.caseId}.`
      : evaluation.failureReason ?? `Evaluation failed for ${contract.caseId}.`,
    failureReason: evaluation.failureReason,
    checkpointPath: relativeToControlRepo(spec, handoffCheckpoint),
  });

  return { spec, contract, execution, evaluation, statePath: stateBackend.path() };
}

export async function evaluateHarness(input: {
  controlRepoRoot: string;
  manifestPath?: string;
  targetRegistryPath?: string;
  runId: string;
  targetId?: string | null;
  adapterId?: string | null;
}) {
  const { spec } = await createRunSpec({
    controlRepoRoot: input.controlRepoRoot,
    manifestPath: input.manifestPath,
    targetRegistryPath: input.targetRegistryPath,
    targetId: input.targetId ?? null,
    adapterId: input.adapterId ?? null,
    runId: input.runId,
    model: null,
    taskId: null,
  });

  const context = await buildContext(spec);
  const target = createTarget(context);
  const contract = await context.artifactStore.readJson<SprintContract>("contract.json");
  const execution = await context.artifactStore.readJson<ExecutionResult>("execution.json").catch(() =>
    context.artifactStore.readJson<ExecutionResult>("execution.resume.json"),
  );
  const recorder = new RunEventRecorder(spec, context.artifactStore);
  await recorder.initialize({ reset: false });
  await recorder.recordLifecycle({
    phase: "evaluate",
    lane: "evaluator",
    status: "running",
    title: `Manual evaluation for ${contract.caseId}`,
    summary: `Manual evaluation started for ${contract.caseId}.`,
  });
  const evaluation = await target.evaluate({ ...context, contract, execution });
  const evaluationFile = await context.artifactStore.writeJson("evaluation.manual.json", evaluation);
  await recorder.recordLifecycle({
    phase: "evaluate",
    lane: "evaluator",
    status: evaluation.passed ? "completed" : "failed",
    title: evaluation.passed ? `Manual evaluation passed for ${contract.caseId}` : `Manual evaluation failed for ${contract.caseId}`,
    summary: evaluation.passed
      ? `Manual evaluation passed for ${contract.caseId}.`
      : evaluation.failureReason ?? `Manual evaluation failed for ${contract.caseId}.`,
  });
  await recorder.recordLifecycle({
    phase: "handoff",
    lane: "handoff",
    status: evaluation.passed ? "completed" : "failed",
    title: evaluation.passed ? `Manual handoff completed for ${contract.caseId}` : `Manual handoff failed for ${contract.caseId}`,
    summary: evaluation.passed
      ? `Manual evaluation passed for ${contract.caseId}.`
      : evaluation.failureReason ?? `Manual evaluation failed for ${contract.caseId}.`,
  });
  await recorder.flush();
  const stateBackend = new JsonStateBackend(spec);
  await updateLiveState(stateBackend, spec, evaluation.passed ? "completed" : "failed", {
    phase: "handoff",
    caseId: contract.caseId,
    title: contract.title,
    threadId: execution.threadId,
    summary: evaluation.passed
      ? `Manual evaluation passed for ${contract.caseId}.`
      : evaluation.failureReason ?? `Manual evaluation failed for ${contract.caseId}.`,
    failureReason: evaluation.failureReason,
    checkpointPath: relativeToControlRepo(spec, evaluationFile),
  });
  return { spec, contract, execution, evaluation, statePath: stateBackend.path() };
}

export async function doctorHarness(input: {
  controlRepoRoot: string;
  manifestPath?: string;
  targetRegistryPath?: string;
  targetId?: string | null;
  adapterId?: string | null;
}) {
  const { spec } = await createRunSpec({
    controlRepoRoot: input.controlRepoRoot,
    manifestPath: input.manifestPath,
    targetRegistryPath: input.targetRegistryPath,
    targetId: input.targetId ?? null,
    adapterId: input.adapterId ?? null,
    runId: createRunId(),
    model: null,
    taskId: null,
  });

  const context = await buildContext(spec);
  const target = createTarget(context);
  const checks = await target.doctor(context);
  return {
    spec,
    checks,
    statePath: new JsonStateBackend(spec).path(),
  };
}

export async function peekNextHarnessWork(input: {
  controlRepoRoot: string;
  manifestPath?: string;
  targetRegistryPath?: string;
  targetId?: string | null;
  adapterId?: string | null;
  runId?: string | null;
  model?: string | null;
  taskId?: string | null;
}): Promise<{ spec: HarnessRunSpec; item: HarnessReadyWorkItem | null; summary: string | null }> {
  const { spec } = await createRunSpec({
    controlRepoRoot: input.controlRepoRoot,
    manifestPath: input.manifestPath,
    targetRegistryPath: input.targetRegistryPath,
    targetId: input.targetId ?? null,
    adapterId: input.adapterId ?? null,
    runId: input.runId ?? createRunId(),
    model: input.model ?? null,
    taskId: input.taskId ?? null,
  });

  const context = await buildContext(spec);
  const target = createTarget(context);

  if (target.peekReadyWork) {
    const item = await target.peekReadyWork(context);
    const publishResult = await context.artifactStore
      .readJson<{ summary?: string | null }>("planner/publish-result.json")
      .catch(() => null);
    return {
      spec,
      item,
      summary: item?.generationSummary ?? publishResult?.summary ?? null,
    };
  }

  try {
    const contract = await target.plan(context);
    return {
      spec,
      item: {
        id: contract.caseId,
        title: contract.title,
      },
      summary: null,
    };
  } catch (error) {
    if (isNoReadyWorkError(error)) {
      const summary = await context.artifactStore
        .readJson<{ summary?: string | null }>("planner/publish-result.json")
        .then((result) => result?.summary ?? null)
        .catch(() => null);
      return { spec, item: null, summary };
    }
    throw error;
  }
}
