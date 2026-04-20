import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { runCodex } from "./codex";
import { nowIso } from "./time";
import { runShellCommand } from "./process";
import { defaultVerificationConfig, defaultAutonomyConfig, readProjectConfig, type ProjectConfig } from "../../scripts/project-config";
import type {
  DoctorCheck,
  EvaluationEvidence,
  EvaluationResult,
  ExecutionResult,
  HarnessContext,
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
    allowedWriteScope: manifest.execution.defaultWriteScope,
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

async function runVerificationCommands(
  repoRoot: string,
  commands: { label: string; command: string }[],
  artifactRoot: string,
): Promise<EvaluationEvidence[]> {
  const results: EvaluationEvidence[] = [];
  for (const [index, item] of commands.entries()) {
    const result = await runShellCommand(item.command, repoRoot);
    const stdoutLog = await artifactRootWrite(artifactRoot, `eval/${index + 1}-${item.label}.stdout.log`, result.stdout);
    const stderrLog = await artifactRootWrite(artifactRoot, `eval/${index + 1}-${item.label}.stderr.log`, result.stderr);
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

async function artifactRootWrite(root: string, relativePath: string, content: string) {
  const fs = await import("node:fs/promises");
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  return target;
}

export function createFoundryAdapter(manifest: ProjectAdapterManifest): HarnessTarget {
  return {
    manifest,
    async plan(context: HarnessContext) {
      if (manifest.planner.refreshCommand) {
        const refreshResult = await runShellCommand(manifest.planner.refreshCommand, context.repoRoot);
        if (refreshResult.exitCode !== 0) {
          throw new Error(`Planner refresh failed: ${refreshResult.stderr || refreshResult.stdout}`.trim());
        }
      }

      const boardPath = path.join(context.repoRoot, manifest.planner.taskBoardPath);
      const milestonesPath = path.join(context.repoRoot, manifest.planner.milestonesPath);
      const [board, milestones] = await Promise.all([
        loadJson<TaskBoard>(boardPath),
        loadJson<Milestone[]>(milestonesPath),
      ]);
      const readyTasks = board.tasks.filter((task) => task.status === "ready");
      const task = context.selectedTaskId
        ? readyTasks.find((item) => item.id === context.selectedTaskId)
        : readyTasks[0];

      if (!task) {
        throw new Error(
          context.selectedTaskId
            ? `Task "${context.selectedTaskId}" is not ready on the current board.`
            : "No ready task is available for the foundry adapter.",
        );
      }

      const milestone = milestones.find((item) => item.id === task.milestone);
      if (!milestone) {
        throw new Error(`Milestone "${task.milestone}" was not found in ${manifest.planner.milestonesPath}.`);
      }

      const blueprint = milestone.taskBlueprints.find((item) => item.id === task.id);
      if (!blueprint) {
        throw new Error(`Task blueprint "${task.id}" was not found in milestone "${milestone.id}".`);
      }

      return createContract(task, blueprint, milestone, manifest);
    },
    async execute(context: HarnessContext & { contract: SprintContract; threadId: string | null; resume: boolean }) {
      const config = await readProjectConfig();
      const autonomy = config.autonomy ?? defaultAutonomyConfig();
      const prompt = contractPrompt(config, context.contract, context.resume);
      const promptFile = context.artifactStore.resolve(context.resume ? "prompts/resume.md" : "prompts/execute.md");
      const stdoutLog = context.artifactStore.resolve(context.resume ? "execution/resume.stdout.log" : "execution/run.stdout.log");
      const stderrLog = context.artifactStore.resolve(context.resume ? "execution/resume.stderr.log" : "execution/run.stderr.log");
      const lastMessageFile = context.artifactStore.resolve(context.resume ? "execution/resume.last-message.txt" : "execution/run.last-message.txt");
      const startedAt = nowIso();

      const result = await runCodex({
        repoRoot: context.repoRoot,
        prompt,
        promptFile,
        stdoutLog,
        stderrLog,
        lastMessageFile,
        sandboxMode: autonomy.sandboxMode,
        model: context.runSpec.model ?? autonomy.model,
        threadId: context.threadId,
      });

      const execution: ExecutionResult = {
        exitCode: result.exitCode,
        passed: result.exitCode === 0,
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
      const config = await readProjectConfig();
      const stages = (config.verification ?? defaultVerificationConfig()).stages.filter((stage) => stage.enabled);
      const commands = stages.map((stage) => ({ label: stage.id, command: stage.command }));
      const startedAt = nowIso();
      const evidence = await runVerificationCommands(context.repoRoot, commands, context.artifactStore.runDir);
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
    async doctor(context: HarnessContext) {
      const checks: DoctorCheck[] = [];
      for (const relativePath of manifest.doctor.requiredFiles) {
        checks.push({
          label: `required-file:${relativePath}`,
          passed: existsSync(path.join(context.repoRoot, relativePath)),
          detail: relativePath,
        });
      }

      for (const command of manifest.doctor.requiredCommands) {
        const result = await runShellCommand(command, context.repoRoot);
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
