import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCodex } from "./codex";
import { NoReadyWorkError } from "./errors";
import { nowIso } from "./time";
import { runShellCommand } from "./process";
import { defaultVerificationConfig, defaultAutonomyConfig, readProjectConfig, type ProjectConfig } from "../../scripts/project-config";
import type {
  DoctorCheck,
  EvaluationEvidence,
  EvaluationResult,
  ExecutionResult,
  HarnessCompletionUpdate,
  HarnessContext,
  HarnessReadyWorkItem,
  HarnessTarget,
  ProjectAdapterManifest,
  SprintContract,
} from "./types";

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

type TaskBlueprint = {
  id: string;
  title: string;
  milestone: string;
  priority: string;
  owner_role: string;
  dependencies: string[];
  input_artifacts?: string[];
  expected_output?: string[];
  acceptance?: string[];
  verification?: string[];
  next_consumer?: string;
};

type Milestone = {
  id: string;
  title: string;
  summary?: string;
  taskBlueprints: TaskBlueprint[];
};

type TaskBoard = {
  currentMilestoneId?: string | null;
  tasks: TaskCard[];
};

async function loadJson<T>(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, payload: unknown) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function contractPrompt(config: ProjectConfig, contract: SprintContract, resume: boolean) {
  const autonomy = config.autonomy ?? defaultAutonomyConfig();
  const base = resume ? autonomy.resumePrompt : autonomy.basePrompt;
  return [
    base,
    "",
    "You are operating inside a generic development harness.",
    `Sprint contract id: ${contract.id}`,
    `Task id: ${contract.caseId}`,
    `Title: ${contract.title}`,
    `Goal: ${contract.goal}`,
    "",
    "Allowed write scope:",
    ...contract.allowedWriteScope.map((item) => `- ${item}`),
    "",
    "Inputs:",
    ...contract.inputs.map((item) => `- ${item}`),
    "",
    "Acceptance checks:",
    ...contract.acceptanceChecks.map((item) => `- ${item}`),
    "",
    "Expected artifacts:",
    ...contract.expectedArtifacts.map((item) => `- ${item}`),
    "",
    "Execution rules:",
    "- Use repository truth first.",
    "- Make one coherent, reviewable unit of progress.",
    "- Leave the repository ready for external evaluation.",
    "- Do not rely on hidden chat-only state.",
  ].join("\n");
}

function deriveGoal(blueprint: TaskBlueprint, milestone: Milestone) {
  const acceptance = blueprint.acceptance?.[0];
  if (acceptance) {
    return acceptance;
  }
  if (milestone.summary) {
    return milestone.summary;
  }
  return blueprint.title;
}

function createContract(task: TaskCard, blueprint: TaskBlueprint, milestone: Milestone, manifest: ProjectAdapterManifest): SprintContract {
  return {
    id: `${task.id.toLowerCase()}-${Date.now()}`,
    adapterId: manifest.id,
    caseId: task.id,
    title: task.title,
    goal: deriveGoal(blueprint, milestone),
    instructions: [
      `Advance ${task.id} for milestone ${task.milestone}.`,
      `Operate within the owner role "${task.owner_role}".`,
      "Stop after a coherent, externally verifiable slice of progress.",
    ],
    inputs: blueprint.input_artifacts ?? [],
    allowedWriteScope: manifest.execution.kind === "codex-cli" ? manifest.execution.defaultWriteScope : [],
    acceptanceChecks: blueprint.verification ?? [],
    expectedArtifacts: blueprint.expected_output ?? [],
    nextConsumer: blueprint.next_consumer ?? null,
    createdAt: nowIso(),
    metadata: {
      milestoneId: task.milestone,
      milestoneTitle: milestone.title,
      priority: task.priority,
      ownerRole: task.owner_role,
      dependencies: task.dependencies,
      acceptance: blueprint.acceptance ?? [],
    },
  };
}

function sanitizeLabel(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

async function artifactRootWrite(root: string, relativePath: string, content: string) {
  const fs = await import("node:fs/promises");
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  return target;
}

async function runVerificationCommands(
  targetRepoRoot: string,
  commands: { label: string; command: string }[],
  artifactRoot: string,
): Promise<EvaluationEvidence[]> {
  const results: EvaluationEvidence[] = [];
  for (const [index, item] of commands.entries()) {
    const result = await runShellCommand(item.command, targetRepoRoot);
    const label = sanitizeLabel(item.label);
    const stdoutLog = await artifactRootWrite(artifactRoot, `eval/${index + 1}-${label}.stdout.log`, result.stdout);
    const stderrLog = await artifactRootWrite(artifactRoot, `eval/${index + 1}-${label}.stderr.log`, result.stderr);
    results.push({
      label: item.label,
      command: item.command,
      passed: result.exitCode === 0,
      returnCode: result.exitCode,
      stdoutLog,
      stderrLog,
      elapsedSeconds: result.elapsedSeconds,
    });
    if (result.exitCode !== 0) {
      break;
    }
  }
  return results;
}

function selectReadyTask(board: TaskBoard, selectedTaskId: string | null) {
  const readyTasks = board.tasks.filter((task) => task.status === "ready");
  if (selectedTaskId) {
    const selected = readyTasks.find((item) => item.id === selectedTaskId);
    if (!selected) {
      throw new Error(`Task "${selectedTaskId}" is not ready on the current board.`);
    }
    return selected;
  }
  return readyTasks[0] ?? null;
}

async function loadBoardAndMilestones(context: HarnessContext, manifest: ProjectAdapterManifest) {
  if (manifest.planner.kind !== "task-board") {
    throw new Error(`Foundry adapter requires task-board planner config, received "${manifest.planner.kind}".`);
  }

  if (manifest.planner.refreshCommand) {
    const refreshResult = await runShellCommand(manifest.planner.refreshCommand, context.targetRepoRoot);
    if (refreshResult.exitCode !== 0) {
      throw new Error(`Planner refresh failed: ${refreshResult.stderr || refreshResult.stdout}`.trim());
    }
  }

  const boardPath = path.join(context.targetRepoRoot, manifest.planner.taskBoardPath);
  const milestonesPath = path.join(context.targetRepoRoot, manifest.planner.milestonesPath);
  const [board, milestones] = await Promise.all([
    loadJson<TaskBoard>(boardPath),
    loadJson<Milestone[]>(milestonesPath),
  ]);

  return { boardPath, board, milestones };
}

async function markTaskStatus(
  boardPath: string,
  board: TaskBoard,
  contract: SprintContract,
  nextStatus: TaskStatus,
): Promise<HarnessCompletionUpdate | null> {
  const index = board.tasks.findIndex((task) => task.id === contract.caseId);
  if (index < 0) {
    throw new Error(`Task "${contract.caseId}" was not found in ${boardPath}.`);
  }

  const current = board.tasks[index];
  if (current.status === nextStatus) {
    return {
      itemId: current.id,
      title: current.title,
      fromStatus: current.status,
      toStatus: nextStatus,
      sourcePath: boardPath,
      summary: `Task ${current.id} already marked ${nextStatus}.`,
    };
  }

  board.tasks[index] = {
    ...current,
    status: nextStatus,
  };
  await writeJson(boardPath, board);
  return {
    itemId: current.id,
    title: current.title,
    fromStatus: current.status,
    toStatus: nextStatus,
    sourcePath: boardPath,
    summary: `Updated ${current.id} from ${current.status} to ${nextStatus}.`,
  };
}

export function createFoundryAdapter(manifest: ProjectAdapterManifest): HarnessTarget {
  return {
    manifest,
    async peekReadyWork(context: HarnessContext) {
      const { board } = await loadBoardAndMilestones(context, manifest);
      const task = selectReadyTask(board, context.selectedTaskId);
      if (!task) {
        return null;
      }
      return {
        id: task.id,
        title: task.title,
      } satisfies HarnessReadyWorkItem;
    },
    async plan(context: HarnessContext) {
      const { boardPath, board, milestones } = await loadBoardAndMilestones(context, manifest);
      const task = selectReadyTask(board, context.selectedTaskId);

      if (!task) {
        throw new NoReadyWorkError("No ready task is available for the foundry adapter.");
      }

      const milestone = milestones.find((item) => item.id === task.milestone);
      if (!milestone) {
        throw new Error(`Milestone "${task.milestone}" was not found for task board ${boardPath}.`);
      }

      const blueprint = milestone.taskBlueprints.find((item) => item.id === task.id);
      if (!blueprint) {
        throw new Error(`Task blueprint "${task.id}" was not found in milestone "${milestone.id}".`);
      }

      return createContract(task, blueprint, milestone, manifest);
    },
    async execute(context: HarnessContext & { contract: SprintContract; threadId: string | null; resume: boolean }) {
      if (manifest.execution.kind !== "codex-cli") {
        throw new Error(`Foundry adapter requires codex-cli execution config, received "${manifest.execution.kind}".`);
      }

      const config = await readProjectConfig();
      const autonomy = config.autonomy ?? defaultAutonomyConfig();
      const prompt = contractPrompt(config, context.contract, context.resume);
      const promptFile = context.artifactStore.resolve(context.resume ? "prompts/resume.md" : "prompts/execute.md");
      const stdoutLog = context.artifactStore.resolve(context.resume ? "execution/resume.stdout.log" : "execution/run.stdout.log");
      const stderrLog = context.artifactStore.resolve(context.resume ? "execution/resume.stderr.log" : "execution/run.stderr.log");
      const lastMessageFile = context.artifactStore.resolve(context.resume ? "execution/resume.last-message.txt" : "execution/run.last-message.txt");
      const startedAt = nowIso();

      const result = await runCodex({
        repoRoot: context.targetRepoRoot,
        prompt,
        promptFile,
        stdoutLog,
        stderrLog,
        lastMessageFile,
        sandboxMode: autonomy.sandboxMode,
        model: context.runSpec.model ?? autonomy.model,
        threadId: context.threadId,
        onThreadStarted: context.executionObserver?.onThreadStarted,
        onEvent: context.executionObserver?.onCodexEvent,
      });

      const execution: ExecutionResult = {
        exitCode: result.exitCode,
        passed: result.exitCode === 0 && !result.failureReason,
        failureReason: result.failureReason,
        sandboxModeRequested: result.sandboxModeRequested,
        sandboxModeUsed: result.sandboxModeUsed,
        fallbackApplied: result.fallbackApplied,
        resume: context.resume,
        threadId: result.threadId,
        startedAt,
        finishedAt: nowIso(),
        elapsedSeconds: result.elapsedSeconds,
        stdoutLog,
        stderrLog,
        promptFile,
        lastMessageFile,
        lastMessage: result.lastMessage,
      };

      return execution;
    },
    async evaluate(context: HarnessContext & { contract: SprintContract; execution: ExecutionResult }) {
      if (manifest.evaluation.kind !== "verification-stages") {
        throw new Error(`Foundry adapter requires verification-stages config, received "${manifest.evaluation.kind}".`);
      }

      const config = await readProjectConfig();
      const stages = (config.verification ?? defaultVerificationConfig()).stages.filter((stage) => stage.enabled);
      const commands = stages.map((stage) => ({ label: stage.id, command: stage.command }));
      const startedAt = nowIso();
      const evidence = await runVerificationCommands(context.targetRepoRoot, commands, context.artifactStore.runDir);
      const failed = evidence.find((item) => !item.passed) ?? null;

      const result: EvaluationResult = {
        passed: !failed,
        retryable: true,
        failureReason: failed ? `Evaluation stage "${failed.label}" failed.` : null,
        findings: failed ? [`${failed.label} failed with exit code ${failed.returnCode ?? "unknown"}.`] : [],
        evidence,
        startedAt,
        finishedAt: nowIso(),
        elapsedSeconds: evidence.reduce((sum, item) => sum + item.elapsedSeconds, 0),
      };

      return result;
    },
    async completeWork(context: HarnessContext & {
      contract: SprintContract;
      execution: ExecutionResult;
      evaluation: EvaluationResult;
    }) {
      if (!context.evaluation.passed) {
        return null;
      }
      const { boardPath, board } = await loadBoardAndMilestones(context, manifest);
      return markTaskStatus(boardPath, board, context.contract, "verified");
    },
    async doctor(context: HarnessContext) {
      const checks: DoctorCheck[] = [];
      for (const relativePath of manifest.doctor.requiredFiles) {
        checks.push({
          label: `required-file:${relativePath}`,
          passed: existsSync(path.join(context.targetRepoRoot, relativePath)),
          detail: relativePath,
        });
      }

      for (const command of manifest.doctor.requiredCommands) {
        const result = await runShellCommand(command, context.targetRepoRoot);
        checks.push({
          label: `command:${command}`,
          passed: result.exitCode === 0,
          detail: result.exitCode === 0 ? "available" : (result.stderr || result.stdout || "unavailable").trim(),
        });
      }

      return checks;
    },
  };
}
