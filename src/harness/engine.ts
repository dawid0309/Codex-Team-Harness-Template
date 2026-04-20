import { existsSync } from "node:fs";
import path from "node:path";

import { FileArtifactStore } from "./artifact-store";
import { createFoundryAdapter } from "./foundry-adapter";
import { loadHarnessManifest, resolveAdapterManifest } from "./manifest";
import { JsonStateBackend, writeCheckpoint } from "./state-backend";
import { createRunId, nowIso } from "./time";
import type {
  DoctorCheck,
  EvaluationResult,
  ExecutionResult,
  HarnessArtifactStore,
  HarnessCheckpoint,
  HarnessContext,
  HarnessLiveState,
  HarnessRunSpec,
  HarnessRunStatus,
  HarnessTarget,
  SprintContract,
} from "./types";

function createTarget(context: HarnessContext): HarnessTarget {
  if (context.manifest.id === "foundry") {
    return createFoundryAdapter(context.manifest);
  }
  throw new Error(`No target factory is registered for adapter "${context.manifest.id}".`);
}

function relativeToRepo(spec: HarnessRunSpec, absolutePath: string) {
  return path.relative(spec.repoRoot, absolutePath).replaceAll("\\", "/");
}

async function updateLiveState(
  stateBackend: JsonStateBackend,
  spec: HarnessRunSpec,
  status: HarnessRunStatus,
  options: {
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
  await stateBackend.update((current) => ({
    ...current,
    status,
    runId: spec.runId,
    adapterId: spec.adapterId,
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
  stateBackend: JsonStateBackend,
  phase: HarnessCheckpoint["phase"],
  payload: {
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
    adapterId: spec.adapterId,
    phase,
    contractFile: payload.contractFile ?? null,
    executionFile: payload.executionFile ?? null,
    evaluationFile: payload.evaluationFile ?? null,
    threadId: payload.threadId ?? null,
    updatedAt: nowIso(),
    summary: payload.summary ?? null,
  };
  await writeCheckpoint(checkpointPath, checkpoint);
  await updateLiveState(stateBackend, spec, phase === "evaluate" ? "completed" : "executed", {
    threadId: payload.threadId,
    summary: payload.summary,
    checkpointPath: relativeToRepo(spec, checkpointPath),
  });
  return checkpointPath;
}

async function buildContext(spec: HarnessRunSpec) {
  const manifestFile = await loadHarnessManifest(spec.repoRoot, spec.manifestPath);
  const manifest = resolveAdapterManifest(manifestFile, spec.adapterId);
  const artifactStore = new FileArtifactStore(spec);
  await artifactStore.ensure();
  const context: HarnessContext = {
    repoRoot: spec.repoRoot,
    runSpec: spec,
    manifest,
    artifactStore,
    selectedTaskId: spec.taskId,
  };
  return context;
}

export async function runHarness(input: {
  repoRoot: string;
  manifestPath?: string;
  adapterId?: string | null;
  runId?: string | null;
  model?: string | null;
  taskId?: string | null;
}) {
  const manifestFile = await loadHarnessManifest(input.repoRoot, input.manifestPath);
  const adapterId = input.adapterId ?? manifestFile.defaultAdapter;
  const spec: HarnessRunSpec = {
    adapterId,
    artifactRoot: manifestFile.artifactRoot,
    manifestPath: input.manifestPath ?? "harness.manifest.json",
    repoRoot: input.repoRoot,
    runId: input.runId ?? createRunId(),
    model: input.model ?? null,
    taskId: input.taskId ?? null,
  };
  const stateBackend = new JsonStateBackend(spec);
  const context = await buildContext(spec);
  const target = createTarget(context);
  await context.artifactStore.writeJson("run-spec.json", spec);
  await updateLiveState(stateBackend, spec, "planning", { startedAt: nowIso() });

  let contract: SprintContract | null = null;
  let execution: ExecutionResult | null = null;
  let evaluation: EvaluationResult | null = null;

  try {
    contract = await target.plan(context);
    const contractFile = await context.artifactStore.writeJson("contract.json", contract);
    await updateLiveState(stateBackend, spec, "planned", {
      summary: `Planned ${contract.caseId}: ${contract.title}`,
      checkpointPath: relativeToRepo(spec, contractFile),
    });
    await writePhaseCheckpoint(spec, context.artifactStore, stateBackend, "plan", {
      contractFile: relativeToRepo(spec, contractFile),
      summary: `Contract ready for ${contract.caseId}.`,
    });

    await updateLiveState(stateBackend, spec, "executing", {
      summary: `Executing ${contract.caseId}.`,
    });
    execution = await target.execute({ ...context, contract, threadId: null, resume: false });
    const executionFile = await context.artifactStore.writeJson("execution.json", execution);
    if (!execution.passed) {
      throw new Error(`Execution failed with exit code ${execution.exitCode}.`);
    }

    await writePhaseCheckpoint(spec, context.artifactStore, stateBackend, "execute", {
      contractFile: relativeToRepo(spec, contractFile),
      executionFile: relativeToRepo(spec, executionFile),
      threadId: execution.threadId,
      summary: execution.lastMessage ?? `Execution completed for ${contract.caseId}.`,
    });

    await updateLiveState(stateBackend, spec, "evaluating", {
      threadId: execution.threadId,
      summary: `Evaluating ${contract.caseId}.`,
    });
    evaluation = await target.evaluate({ ...context, contract, execution });
    const evaluationFile = await context.artifactStore.writeJson("evaluation.json", evaluation);
    await context.artifactStore.writeText(
      "handoff.md",
      [
        `# Harness Handoff`,
        "",
        `- run_id: ${spec.runId}`,
        `- adapter: ${spec.adapterId}`,
        `- task: ${contract.caseId}`,
        `- title: ${contract.title}`,
        `- thread_id: ${execution.threadId ?? "n/a"}`,
        `- execution_passed: ${execution.passed}`,
        `- evaluation_passed: ${evaluation.passed}`,
        `- summary: ${execution.lastMessage ?? evaluation.failureReason ?? "No summary emitted."}`,
      ].join("\n"),
    );

    await writePhaseCheckpoint(spec, context.artifactStore, stateBackend, "evaluate", {
      contractFile: relativeToRepo(spec, contractFile),
      executionFile: relativeToRepo(spec, executionFile),
      evaluationFile: relativeToRepo(spec, evaluationFile),
      threadId: execution.threadId,
      summary: evaluation.passed
        ? `Completed ${contract.caseId}.`
        : evaluation.failureReason ?? `Evaluation failed for ${contract.caseId}.`,
    });

    await updateLiveState(stateBackend, spec, evaluation.passed ? "completed" : "failed", {
      threadId: execution.threadId,
      summary: evaluation.passed
        ? `Completed ${contract.caseId}.`
        : evaluation.failureReason ?? `Evaluation failed for ${contract.caseId}.`,
      failureReason: evaluation.failureReason,
      checkpointPath: relativeToRepo(spec, context.artifactStore.resolve("checkpoint.json")),
    });
    return { spec, contract, execution, evaluation, statePath: stateBackend.path() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const checkpointAbsolute = context.artifactStore.resolve("checkpoint.json");
    await updateLiveState(stateBackend, spec, "failed", {
      threadId: execution?.threadId ?? null,
      summary: message,
      failureReason: message,
      checkpointPath: existsSync(checkpointAbsolute) ? relativeToRepo(spec, checkpointAbsolute) : null,
    });
    throw error;
  }
}

export async function resumeHarness(input: {
  repoRoot: string;
  manifestPath?: string;
  runId: string;
  adapterId?: string | null;
  model?: string | null;
}) {
  const manifestFile = await loadHarnessManifest(input.repoRoot, input.manifestPath);
  const adapterId = input.adapterId ?? manifestFile.defaultAdapter;
  const spec: HarnessRunSpec = {
    adapterId,
    artifactRoot: manifestFile.artifactRoot,
    manifestPath: input.manifestPath ?? "harness.manifest.json",
    repoRoot: input.repoRoot,
    runId: input.runId,
    model: input.model ?? null,
    taskId: null,
  };
  const context = await buildContext(spec);
  const target = createTarget(context);
  const stateBackend = new JsonStateBackend(spec);
  const contract = await context.artifactStore.readJson<SprintContract>("contract.json");
  const checkpoint = await context.artifactStore.readJson<HarnessCheckpoint>("checkpoint.json");

  await updateLiveState(stateBackend, spec, "executing", {
    threadId: checkpoint.threadId,
    summary: `Resuming ${contract.caseId}.`,
  });

  const execution = await target.execute({
    ...context,
    contract,
    threadId: checkpoint.threadId,
    resume: true,
  });
  const executionFile = await context.artifactStore.writeJson("execution.resume.json", execution);
  if (!execution.passed) {
    const message = `Resume execution failed with exit code ${execution.exitCode}.`;
    await updateLiveState(stateBackend, spec, "failed", {
      threadId: execution.threadId,
      summary: message,
      failureReason: message,
      checkpointPath: relativeToRepo(spec, context.artifactStore.resolve("checkpoint.json")),
    });
    throw new Error(message);
  }

  await updateLiveState(stateBackend, spec, "evaluating", {
    threadId: execution.threadId,
    summary: `Evaluating resumed run ${contract.caseId}.`,
  });
  const evaluation = await target.evaluate({ ...context, contract, execution });
  const evaluationFile = await context.artifactStore.writeJson("evaluation.resume.json", evaluation);
  await writePhaseCheckpoint(spec, context.artifactStore, stateBackend, "evaluate", {
    contractFile: "contract.json",
    executionFile: relativeToRepo(spec, executionFile),
    evaluationFile: relativeToRepo(spec, evaluationFile),
    threadId: execution.threadId,
    summary: evaluation.passed
      ? `Resumed run completed for ${contract.caseId}.`
      : evaluation.failureReason ?? `Evaluation failed for ${contract.caseId}.`,
  });
  await updateLiveState(stateBackend, spec, evaluation.passed ? "completed" : "failed", {
    threadId: execution.threadId,
    summary: evaluation.passed
      ? `Resumed run completed for ${contract.caseId}.`
      : evaluation.failureReason ?? `Evaluation failed for ${contract.caseId}.`,
    failureReason: evaluation.failureReason,
    checkpointPath: relativeToRepo(spec, context.artifactStore.resolve("checkpoint.json")),
  });

  return { spec, contract, execution, evaluation, statePath: stateBackend.path() };
}

export async function evaluateHarness(input: {
  repoRoot: string;
  manifestPath?: string;
  runId: string;
  adapterId?: string | null;
}) {
  const manifestFile = await loadHarnessManifest(input.repoRoot, input.manifestPath);
  const adapterId = input.adapterId ?? manifestFile.defaultAdapter;
  const spec: HarnessRunSpec = {
    adapterId,
    artifactRoot: manifestFile.artifactRoot,
    manifestPath: input.manifestPath ?? "harness.manifest.json",
    repoRoot: input.repoRoot,
    runId: input.runId,
    model: null,
    taskId: null,
  };
  const context = await buildContext(spec);
  const target = createTarget(context);
  const contract = await context.artifactStore.readJson<SprintContract>("contract.json");
  const execution = await context.artifactStore.readJson<ExecutionResult>("execution.json").catch(() =>
    context.artifactStore.readJson<ExecutionResult>("execution.resume.json"),
  );
  const evaluation = await target.evaluate({ ...context, contract, execution });
  const evaluationFile = await context.artifactStore.writeJson("evaluation.manual.json", evaluation);
  const stateBackend = new JsonStateBackend(spec);
  await updateLiveState(stateBackend, spec, evaluation.passed ? "completed" : "failed", {
    threadId: execution.threadId,
    summary: evaluation.passed
      ? `Manual evaluation passed for ${contract.caseId}.`
      : evaluation.failureReason ?? `Manual evaluation failed for ${contract.caseId}.`,
    failureReason: evaluation.failureReason,
    checkpointPath: relativeToRepo(spec, evaluationFile),
  });
  return { spec, contract, execution, evaluation, statePath: stateBackend.path() };
}

export async function doctorHarness(input: {
  repoRoot: string;
  manifestPath?: string;
  adapterId?: string | null;
}) {
  const manifestFile = await loadHarnessManifest(input.repoRoot, input.manifestPath);
  const adapterId = input.adapterId ?? manifestFile.defaultAdapter;
  const spec: HarnessRunSpec = {
    adapterId,
    artifactRoot: manifestFile.artifactRoot,
    manifestPath: input.manifestPath ?? "harness.manifest.json",
    repoRoot: input.repoRoot,
    runId: createRunId(),
    model: null,
    taskId: null,
  };
  const context = await buildContext(spec);
  const target = createTarget(context);
  const checks = await target.doctor(context);
  return {
    spec,
    checks,
    statePath: new JsonStateBackend(spec).path(),
  };
}
