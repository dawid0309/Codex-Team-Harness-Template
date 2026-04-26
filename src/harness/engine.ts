import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { FileArtifactStore } from "./artifact-store";
import { isNoReadyWorkError } from "./errors";
import { createExternalTargetAdapter } from "./external-target";
import { createFoundryAdapter } from "./foundry-adapter";
import { createLangfuseLiveRunObserver, scoreHarnessEvaluation, type LangfuseLiveRunObserver } from "./langfuse-observability";
import { loadHarnessManifest, resolveAdapterManifest } from "./manifest";
import { appendRunEventAndRebuild, createEmptyRunBoard, createLifecycleEvent, normalizeCodexEvent, readRunBoard, readRunEvents } from "./run-board";
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
  CodexTerminalEventType,
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
  private readonly langfuse: LangfuseLiveRunObserver;

  constructor(
    private readonly spec: HarnessRunSpec,
    private readonly store: HarnessArtifactStore,
  ) {
    this.langfuse = createLangfuseLiveRunObserver(spec);
  }

  async initialize(options: { reset: boolean }) {
    if (options.reset) {
      await this.store.writeText("events.jsonl", "");
      await this.store.writeJson("run-board.json", createEmptyRunBoard(this.spec));
    } else if (!existsSync(this.store.resolve("events.jsonl"))) {
      await this.store.writeText("events.jsonl", "");
    }
    if (!existsSync(this.store.resolve("run-board.json"))) {
      await this.store.writeJson("run-board.json", createEmptyRunBoard(this.spec));
    }
    await this.langfuse.initialize().catch((error) => {
      console.warn(`[Langfuse] Live observer disabled for ${this.spec.runId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async recordLifecycle(input: {
    phase: HarnessPhase;
    lane: "planner" | "executor" | "evaluator" | "handoff";
    status: "pending" | "running" | "completed" | "failed" | "interrupted";
    title: string;
    summary: string | null;
  }) {
    return this.enqueue(async () => {
      const event = createLifecycleEvent({
        spec: this.spec,
        phase: input.phase,
        lane: input.lane,
        status: input.status,
        title: input.title,
        summary: input.summary,
      });
      await appendRunEventAndRebuild(this.spec, this.store, event);
      await this.langfuse.recordLifecycle(event).catch((error) => {
        console.warn(`[Langfuse] Failed to record lifecycle event for ${this.spec.runId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  async recordCodexEvent(phase: HarnessPhase, raw: Record<string, unknown>) {
    return this.enqueue(async () => {
      const event = normalizeCodexEvent(this.spec, phase, raw);
      if (!event) {
        return;
      }
      await appendRunEventAndRebuild(this.spec, this.store, event);
      await this.langfuse.recordEvent(event).catch((error) => {
        console.warn(`[Langfuse] Failed to record Codex event for ${this.spec.runId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  async updateContract(contract: SprintContract) {
    await this.langfuse.updateContract(contract).catch((error) => {
      console.warn(`[Langfuse] Failed to update contract metadata for ${this.spec.runId}: ${error instanceof Error ? error.message : String(error)}`);
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

async function readLastMessage(filePath: string) {
  if (!existsSync(filePath)) {
    return null;
  }
  const content = (await readFile(filePath, "utf8")).trim();
  return content || null;
}

async function inferExecutionTerminalState(spec: HarnessRunSpec, store: HarnessArtifactStore) {
  const [events, board] = await Promise.all([
    readRunEvents(store).catch(() => [] as Awaited<ReturnType<typeof readRunEvents>>),
    readRunBoard(store).catch(() => null),
  ]);
  const threadStarted = events.find((event) => event.raw?.type === "thread.started");
  const terminalEvent = [...events].reverse().find((event) => (
    event.raw?.type === "turn.completed" || event.raw?.type === "turn.failed"
  )) ?? null;
  const terminalEventType = (terminalEvent?.raw?.type as CodexTerminalEventType | undefined)
    ?? (board?.lanes.executor.status === "completed" ? "turn.completed" : null);
  return {
    events,
    board,
    threadId: typeof threadStarted?.raw?.thread_id === "string" ? threadStarted.raw.thread_id : null,
    terminalEventType: terminalEventType ?? (board?.lanes.executor.status === "failed" ? "turn.failed" : null),
    terminalEventAt: terminalEvent?.ts ?? null,
    turnCompleted: terminalEventType === "turn.completed",
  };
}

function executionArtifactPaths(store: HarnessArtifactStore, resume: boolean) {
  const prefix = resume ? "execution/resume" : "execution/run";
  return {
    stdoutLog: store.resolve(`${prefix}.stdout.log`),
    stderrLog: store.resolve(`${prefix}.stderr.log`),
    lastMessageFile: store.resolve(`${prefix}.last-message.txt`),
    promptFile: store.resolve(resume ? "prompts/resume.md" : "prompts/execute.md"),
  };
}

async function ensureExecutionArtifact(context: HarnessContext, contract: SprintContract, resume: boolean) {
  const primaryFile = resume ? "execution.resume.json" : "execution.json";
  const existing = await context.artifactStore.readJson<ExecutionResult>(primaryFile).catch(() => null);
  if (existing) {
    return { execution: existing, reconciled: false, file: context.artifactStore.resolve(primaryFile) };
  }

  const inferred = await inferExecutionTerminalState(context.runSpec, context.artifactStore);
  if (!inferred.terminalEventType) {
    return { execution: null, reconciled: false, file: null };
  }

  const paths = executionArtifactPaths(context.artifactStore, resume);
  const lastMessage = await readLastMessage(paths.lastMessageFile);
  const execution: ExecutionResult = {
    exitCode: inferred.terminalEventType === "turn.failed" ? 1 : 0,
    passed: inferred.terminalEventType === "turn.completed",
    failureReason: inferred.terminalEventType === "turn.failed"
      ? (lastMessage ?? "Codex turn failed before harness finalization.")
      : null,
    sandboxModeRequested: "unknown",
    sandboxModeUsed: "unknown",
    fallbackApplied: false,
    resume,
    threadId: inferred.threadId,
    startedAt: inferred.events[0]?.ts ?? nowIso(),
    finishedAt: inferred.terminalEventAt ?? nowIso(),
    elapsedSeconds: 0,
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
    promptFile: paths.promptFile,
    lastMessageFile: paths.lastMessageFile,
    lastMessage,
    turnCompleted: inferred.turnCompleted,
    terminalEventType: inferred.terminalEventType,
    terminalEventAt: inferred.terminalEventAt,
    finalizationState: "partial",
  };
  const executionFile = await context.artifactStore.writeJson(primaryFile, execution);
  await context.artifactStore.writeJson("execution.reconciled.json", {
    reconciledAt: nowIso(),
    reconciliationReason: `Recovered missing ${primaryFile} from Codex terminal events.`,
    source: inferred.terminalEventType,
    execution,
  });
  return { execution, reconciled: true, file: executionFile };
}

async function persistExecutionCheckpoint(input: {
  spec: HarnessRunSpec;
  store: HarnessArtifactStore;
  stateBackend: JsonStateBackend;
  contract: SprintContract;
  execution: ExecutionResult;
  contractFile: string;
  executionFile: string;
  summaryPrefix?: string;
}) {
  const checkpoint = await writePhaseCheckpoint(input.spec, input.store, "execute", {
    caseId: input.contract.caseId,
    title: input.contract.title,
    contractFile: relativeToControlRepo(input.spec, input.contractFile),
    executionFile: relativeToControlRepo(input.spec, input.executionFile),
    threadId: input.execution.threadId,
    summary: input.execution.lastMessage ?? `${input.summaryPrefix ?? "Execution completed"} for ${input.contract.caseId}.`,
  });
  await updateLiveState(input.stateBackend, input.spec, "executed", {
    phase: "execute",
    caseId: input.contract.caseId,
    title: input.contract.title,
    threadId: input.execution.threadId,
    summary: input.execution.lastMessage ?? `${input.summaryPrefix ?? "Execution completed"} for ${input.contract.caseId}.`,
    checkpointPath: relativeToControlRepo(input.spec, checkpoint),
  });
  return checkpoint;
}

async function finalizeRunArtifacts(input: {
  spec: HarnessRunSpec;
  context: HarnessContext;
  stateBackend: JsonStateBackend;
  recorder: RunEventRecorder;
  contract: SprintContract;
  execution: ExecutionResult;
  evaluation: EvaluationResult;
  completion: HarnessCompletionUpdate | null;
  contractFile: string;
  executionFile: string;
  evaluationFile: string;
  resume: boolean;
}) {
  const handoffFile = input.resume ? "handoff.resume.md" : "handoff.md";
  await input.recorder.recordLifecycle({
    phase: "handoff",
    lane: "handoff",
    status: "running",
    title: input.resume ? `Preparing resumed handoff for ${input.contract.caseId}` : `Preparing handoff for ${input.contract.caseId}`,
    summary: `Preparing handoff for ${input.contract.caseId}.`,
  });
  await input.context.artifactStore.writeText(
    handoffFile,
    [
      "# Harness Handoff",
      "",
      `- run_id: ${input.spec.runId}`,
      `- target: ${input.spec.targetId}`,
      `- adapter: ${input.spec.adapterId}`,
      `- task: ${input.contract.caseId}`,
      `- title: ${input.contract.title}`,
      `- thread_id: ${input.execution.threadId ?? "n/a"}`,
      `- execution_passed: ${input.execution.passed}`,
      `- evaluation_passed: ${input.evaluation.passed}`,
      `- evaluation_class: ${input.evaluation.failureClass ?? "none"}`,
      `- retryable: ${input.evaluation.retryable}`,
      `- completion_update: ${input.completion?.summary ?? "none"}`,
      `- summary: ${input.execution.lastMessage ?? input.evaluation.failureReason ?? "No summary emitted."}`,
    ].join("\n"),
  );
  const finalExecution: ExecutionResult = {
    ...input.execution,
    finalizationState: "finalized",
  };
  await input.context.artifactStore.writeJson(input.resume ? "execution.resume.json" : "execution.json", finalExecution);
  const handoffCheckpoint = await writePhaseCheckpoint(input.spec, input.context.artifactStore, "handoff", {
    caseId: input.contract.caseId,
    title: input.contract.title,
    contractFile: relativeToControlRepo(input.spec, input.contractFile),
    executionFile: relativeToControlRepo(input.spec, input.executionFile),
    evaluationFile: relativeToControlRepo(input.spec, input.evaluationFile),
    threadId: input.execution.threadId,
    summary: input.evaluation.passed
      ? `${input.resume ? "Resumed run completed" : "Completed"} ${input.contract.caseId}.`
      : input.evaluation.failureReason ?? `Evaluation failed for ${input.contract.caseId}.`,
  });
  await input.recorder.recordLifecycle({
    phase: "handoff",
    lane: "handoff",
    status: input.evaluation.passed ? "completed" : "failed",
    title: input.evaluation.passed
      ? `${input.resume ? "Resumed run completed" : "Completed"} ${input.contract.caseId}`
      : `${input.resume ? "Resumed handoff failed" : "Handoff failed"} for ${input.contract.caseId}`,
    summary: input.evaluation.passed
      ? `${input.resume ? "Resumed run completed" : "Completed"} ${input.contract.caseId}.`
      : input.evaluation.failureReason ?? `Evaluation failed for ${input.contract.caseId}.`,
  });
  await input.recorder.flush();
  await updateLiveState(input.stateBackend, input.spec, input.evaluation.passed ? "completed" : "failed", {
    phase: "handoff",
    caseId: input.contract.caseId,
    title: input.contract.title,
    threadId: input.execution.threadId,
    summary: input.evaluation.passed
      ? `${input.resume ? "Resumed run completed" : "Completed"} ${input.contract.caseId}.`
      : input.evaluation.failureReason ?? `Evaluation failed for ${input.contract.caseId}.`,
    failureReason: input.evaluation.failureReason,
    checkpointPath: relativeToControlRepo(input.spec, handoffCheckpoint),
  });
  return finalExecution;
}

async function reconcileRunArtifacts(input: {
  spec: HarnessRunSpec;
  context: HarnessContext;
  targetAdapter: HarnessTarget;
  stateBackend: JsonStateBackend;
  recorder: RunEventRecorder;
  contract: SprintContract;
  contractFile: string;
}) {
  const primaryExecution = await ensureExecutionArtifact(input.context, input.contract, false);
  if (!primaryExecution.execution) {
    return null;
  }
  let execution = primaryExecution.execution;
  if (primaryExecution.reconciled && primaryExecution.file) {
    await persistExecutionCheckpoint({
      spec: input.spec,
      store: input.context.artifactStore,
      stateBackend: input.stateBackend,
      contract: input.contract,
      execution,
      contractFile: input.contractFile,
      executionFile: primaryExecution.file,
      summaryPrefix: "Recovered execution",
    });
    await input.recorder.recordLifecycle({
      phase: "execute",
      lane: "executor",
      status: execution.passed ? "completed" : "failed",
      title: execution.passed ? `Recovered execution for ${input.contract.caseId}` : `Recovered failed execution for ${input.contract.caseId}`,
      summary: execution.lastMessage ?? execution.failureReason ?? `Recovered execution for ${input.contract.caseId}.`,
    });
  }

  let evaluation = await input.context.artifactStore.readJson<EvaluationResult>("evaluation.json").catch(() => null);
  let completion = await input.context.artifactStore.readJson<HarnessCompletionUpdate>("completion.json").catch(() => null);
  const checkpoint = await input.context.artifactStore.readJson<HarnessCheckpoint>("checkpoint.json").catch(() => null);
  if (!evaluation) {
    await updateLiveState(input.stateBackend, input.spec, "evaluating", {
      phase: "evaluate",
      caseId: input.contract.caseId,
      title: input.contract.title,
      threadId: execution.threadId,
      summary: `Reconciling evaluation for ${input.contract.caseId}.`,
      failureReason: null,
    });
    await input.recorder.recordLifecycle({
      phase: "evaluate",
      lane: "evaluator",
      status: "running",
      title: `Reconciling evaluation for ${input.contract.caseId}`,
      summary: `Reconciling evaluation for ${input.contract.caseId}.`,
    });
    evaluation = await input.targetAdapter.evaluate({ ...input.context, contract: input.contract, execution });
    const evaluationFile = await input.context.artifactStore.writeJson("evaluation.json", evaluation);
    await scoreHarnessEvaluation(input.spec, input.context.artifactStore, evaluation);
    if (evaluation.passed && input.targetAdapter.completeWork) {
      completion = await input.targetAdapter.completeWork({
        ...input.context,
        contract: input.contract,
        execution,
        evaluation,
      });
      if (completion) {
        await input.context.artifactStore.writeJson("completion.json", completion);
      }
    }
    await input.recorder.recordLifecycle({
      phase: "evaluate",
      lane: "evaluator",
      status: evaluation.passed ? "completed" : "failed",
      title: evaluation.passed ? `Evaluation passed for ${input.contract.caseId}` : `Evaluation failed for ${input.contract.caseId}`,
      summary: evaluation.passed
        ? `Evaluation passed for ${input.contract.caseId}.`
        : evaluation.failureReason ?? `Evaluation failed for ${input.contract.caseId}.`,
    });
    execution = await finalizeRunArtifacts({
      spec: input.spec,
      context: input.context,
      stateBackend: input.stateBackend,
      recorder: input.recorder,
      contract: input.contract,
      execution,
      evaluation,
      completion: completion ?? null,
      contractFile: input.contractFile,
      executionFile: primaryExecution.file ?? input.context.artifactStore.resolve("execution.json"),
      evaluationFile,
      resume: false,
    });
  } else if ((checkpoint?.phase !== "handoff") || execution.finalizationState !== "finalized") {
    if (evaluation.passed && !completion && input.targetAdapter.completeWork) {
      completion = await input.targetAdapter.completeWork({
        ...input.context,
        contract: input.contract,
        execution,
        evaluation,
      });
      if (completion) {
        await input.context.artifactStore.writeJson("completion.json", completion);
      }
    }
    execution = await finalizeRunArtifacts({
      spec: input.spec,
      context: input.context,
      stateBackend: input.stateBackend,
      recorder: input.recorder,
      contract: input.contract,
      execution,
      evaluation,
      completion: completion ?? null,
      contractFile: input.contractFile,
      executionFile: primaryExecution.file ?? input.context.artifactStore.resolve("execution.json"),
      evaluationFile: input.context.artifactStore.resolve("evaluation.json"),
      resume: false,
    });
  }

  return { execution, evaluation, completion };
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
    await recorder.updateContract(contract);
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
    await persistExecutionCheckpoint({
      spec,
      store: context.artifactStore,
      stateBackend,
      contract,
      execution,
      contractFile,
      executionFile,
    });
    if (!execution.passed) {
      await recorder.flush();
      throw new Error(execution.failureReason ?? `Execution failed with exit code ${execution.exitCode}.`);
    }
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
    await scoreHarnessEvaluation(spec, context.artifactStore, evaluation);
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
    execution = await finalizeRunArtifacts({
      spec,
      context,
      stateBackend,
      recorder,
      contract,
      execution,
      evaluation,
      completion,
      contractFile,
      executionFile,
      evaluationFile,
      resume: false,
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
  await recorder.updateContract(contract);
  const reconciled = await reconcileRunArtifacts({
    spec,
    context,
    targetAdapter: target,
    stateBackend,
    recorder,
    contract,
    contractFile: context.artifactStore.resolve("contract.json"),
  });
  if (reconciled?.evaluation) {
    return {
      spec,
      contract,
      execution: {
        ...reconciled.execution,
        finalizationState: "finalized",
      },
      evaluation: reconciled.evaluation,
      statePath: stateBackend.path(),
    };
  }

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
  await persistExecutionCheckpoint({
    spec,
    store: context.artifactStore,
    stateBackend,
    contract,
    execution,
    contractFile: context.artifactStore.resolve("contract.json"),
    executionFile,
    summaryPrefix: "Resume execution completed",
  });
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
  await scoreHarnessEvaluation(spec, context.artifactStore, evaluation);
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
  const finalizedExecution = await finalizeRunArtifacts({
    spec,
    context,
    stateBackend,
    recorder,
    contract,
    execution,
    evaluation,
    completion,
    contractFile: context.artifactStore.resolve("contract.json"),
    executionFile,
    evaluationFile,
    resume: true,
  });

  return { spec, contract, execution: finalizedExecution, evaluation, statePath: stateBackend.path() };
}

export async function reconcileHarnessRun(input: {
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
  const targetAdapter = createTarget(context);
  const stateBackend = new JsonStateBackend(spec);
  const contract = await context.artifactStore.readJson<SprintContract>("contract.json").catch(() => null);
  if (!contract) {
    return { spec, reconciled: false, execution: null, evaluation: null };
  }
  const recorder = new RunEventRecorder(spec, context.artifactStore);
  await recorder.initialize({ reset: false });
  await recorder.updateContract(contract);
  const result = await reconcileRunArtifacts({
    spec,
    context,
    targetAdapter,
    stateBackend,
    recorder,
    contract,
    contractFile: context.artifactStore.resolve("contract.json"),
  });
  return {
    spec,
    reconciled: !!result,
    execution: result?.execution ?? null,
    evaluation: result?.evaluation ?? null,
  };
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
  await recorder.updateContract(contract);
  await recorder.recordLifecycle({
    phase: "evaluate",
    lane: "evaluator",
    status: "running",
    title: `Manual evaluation for ${contract.caseId}`,
    summary: `Manual evaluation started for ${contract.caseId}.`,
  });
  const evaluation = await target.evaluate({ ...context, contract, execution });
  const evaluationFile = await context.artifactStore.writeJson("evaluation.manual.json", evaluation);
  await scoreHarnessEvaluation(spec, context.artifactStore, evaluation);
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
