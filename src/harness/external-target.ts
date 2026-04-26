import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCodex } from "./codex";
import { NoReadyWorkError } from "./errors";
import { runShellCommand } from "./process";
import { nowIso } from "./time";
import type {
  DoctorCheck,
  ExternalCasePlannerConfig,
  ExternalPlanningEvaluation,
  ExternalPlanningEvaluatorConfig,
  EvaluationFailureClass,
  EvaluationFailureScope,
  EvaluationEvidence,
  EvaluationResult,
  ExecutionResult,
  ExternalDirectionBrief,
  ExternalMilestonePlannerConfig,
  ExternalMilestoneStatus,
  ExternalPlannerContextPacket,
  ExternalPlannerDraftCase,
  ExternalPlannerDraftMilestone,
  ExternalPlannerDraftStrategy,
  ExternalPlanningConfig,
  ExternalPlanningLayer,
  ExternalPlannerPublishResult,
  ExternalStrategyStatus,
  ExternalStrategyPlannerConfig,
  ExternalTargetCase,
  ExternalTargetConfig,
  ExternalTargetMilestone,
  ExternalTargetStrategy,
  HarnessCompletionUpdate,
  HarnessContext,
  PlannerContextBudgetReport,
  PlannerContextBudgetReportEntry,
  HarnessReadyWorkItem,
  HarnessTarget,
  ProjectAdapterManifest,
  SprintContract,
  ExternalPlanningContextBudget,
} from "./types";

const SNAPSHOT_LIMIT = 12_000;
const DIRECTORY_LISTING_LIMIT = 40;

function sanitizeLabel(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function resolveConfigRelativePath(configPath: string, candidate: string) {
  return path.isAbsolute(candidate) ? candidate : path.join(path.dirname(configPath), candidate);
}

function truncateText(value: string, max = SNAPSHOT_LIMIT) {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 3)}...`;
}

function utf8Bytes(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function truncateWithMeta(value: string, max: number) {
  const originalBytes = utf8Bytes(value);
  const content = truncateText(value, max);
  const includedBytes = utf8Bytes(content);
  return {
    content,
    originalBytes,
    includedBytes,
    truncated: includedBytes < originalBytes,
  };
}

type ContextSnapshotEntry = {
  path: string;
  content: string;
  originalBytes: number;
  includedBytes: number;
  truncated: boolean;
};

type ContextBudgetAccumulator = {
  remainingBytes: number;
  truncated: boolean;
  entries: PlannerContextBudgetReportEntry[];
};

function addBudgetEntry(
  accumulator: ContextBudgetAccumulator,
  entry: PlannerContextBudgetReportEntry,
) {
  accumulator.entries.push(entry);
  accumulator.remainingBytes = Math.max(0, accumulator.remainingBytes - entry.includedBytes);
  if (entry.truncated) {
    accumulator.truncated = true;
  }
}

function takeBudgetedStrings(
  key: string,
  values: string[],
  limit: number,
  perItemBytes: number,
  accumulator: ContextBudgetAccumulator,
) {
  const selected = values.slice(0, Math.max(0, limit));
  const normalized = [];
  for (const value of selected) {
    if (accumulator.remainingBytes <= 0) {
      accumulator.truncated = true;
      break;
    }
    const item = truncateWithMeta(value, Math.min(perItemBytes, accumulator.remainingBytes));
    if (item.includedBytes <= 0) {
      accumulator.truncated = true;
      break;
    }
    normalized.push(item);
    accumulator.remainingBytes = Math.max(0, accumulator.remainingBytes - item.includedBytes);
  }
  const originalBytes = values.reduce((sum, value) => sum + utf8Bytes(value), 0);
  const includedBytes = normalized.reduce((sum, item) => sum + item.includedBytes, 0);
  accumulator.entries.push({
    key,
    originalCount: values.length,
    includedCount: normalized.length,
    originalBytes,
    includedBytes,
    truncated: normalized.some((item) => item.truncated) || normalized.length < values.length,
  });
  return normalized.map((item) => item.content);
}

function takeBudgetedJsonItems<T>(
  key: string,
  items: T[],
  accumulator: ContextBudgetAccumulator,
) {
  const encoded = items.map((item) => JSON.stringify(item));
  const selected: T[] = [];
  let includedBytes = 0;
  for (let index = 0; index < items.length; index += 1) {
    const bytes = utf8Bytes(encoded[index]);
    if (bytes > accumulator.remainingBytes) {
      accumulator.truncated = true;
      break;
    }
    selected.push(items[index]);
    includedBytes += bytes;
    accumulator.remainingBytes = Math.max(0, accumulator.remainingBytes - bytes);
  }
  accumulator.entries.push({
    key,
    originalCount: items.length,
    includedCount: selected.length,
    originalBytes: encoded.reduce((sum, item) => sum + utf8Bytes(item), 0),
    includedBytes,
    truncated: selected.length < items.length,
  });
  return selected;
}

function takeBudgetedSnapshots(
  key: string,
  snapshots: ContextSnapshotEntry[],
  limit: number,
  perItemBytes: number,
  accumulator: ContextBudgetAccumulator,
) {
  const selected: ContextSnapshotEntry[] = [];
  for (const snapshot of snapshots.slice(0, Math.max(0, limit))) {
    if (accumulator.remainingBytes <= 0) {
      accumulator.truncated = true;
      break;
    }
    const truncated = truncateWithMeta(snapshot.content, Math.min(perItemBytes, accumulator.remainingBytes));
    if (truncated.includedBytes <= 0) {
      accumulator.truncated = true;
      break;
    }
    selected.push({
      ...snapshot,
      content: truncated.content,
      includedBytes: truncated.includedBytes,
      truncated: snapshot.truncated || truncated.truncated,
    });
    accumulator.remainingBytes = Math.max(0, accumulator.remainingBytes - truncated.includedBytes);
  }
  accumulator.entries.push({
    key,
    originalCount: snapshots.length,
    includedCount: selected.length,
    originalBytes: snapshots.reduce((sum, item) => sum + item.originalBytes, 0),
    includedBytes: selected.reduce((sum, item) => sum + item.includedBytes, 0),
    truncated: selected.some((item) => item.truncated) || selected.length < snapshots.length,
  });
  return selected;
}

function finalizeBudgetReport(accumulator: ContextBudgetAccumulator, maxContextBytes: number): PlannerContextBudgetReport {
  const totalIncludedBytes = accumulator.entries.reduce((sum, entry) => sum + entry.includedBytes, 0);
  return {
    maxContextBytes,
    totalIncludedBytes,
    truncated: accumulator.truncated || totalIncludedBytes > maxContextBytes,
    entries: accumulator.entries,
  };
}

type EvaluationFailureClassification = {
  failureClass: EvaluationFailureClass;
  failureScope: EvaluationFailureScope;
  retryable: boolean;
  blocking: boolean;
  matchedRuleId: string | null;
  normalizedSummary: string;
};

function extractCommandOutputSummary(stdout: string, stderr: string) {
  const combined = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");
  return truncateText(combined, 360);
}

function classifyEvaluationFailure(command: string, stdout: string, stderr: string): EvaluationFailureClassification {
  const combined = `${command}\n${stderr}\n${stdout}`;
  const summary = extractCommandOutputSummary(stdout, stderr) || truncateText(command, 200);
  const rules: Array<{
    id: string;
    test: RegExp;
    failureClass: EvaluationFailureClass;
    failureScope: EvaluationFailureScope;
    retryable: boolean;
    blocking: boolean;
    summary: (match: RegExpMatchArray | null) => string;
  }> = [
    {
      id: "windows-logon-failure",
      test: /CreateProcessWithLogonW failed:\s*\d+/i,
      failureClass: "environment_blocker",
      failureScope: "runtime",
      retryable: false,
      blocking: true,
      summary: (match) => `Windows sandbox logon failed${match?.[0] ? `: ${match[0]}` : "."}`,
    },
    {
      id: "local-gateway-status",
      test: /unexpected status\s+(401|429|5\d\d)\b[^\n]*127\.0\.0\.1:15721\/v1\/responses/i,
      failureClass: "infrastructure_failure",
      failureScope: "runtime",
      retryable: true,
      blocking: true,
      summary: (match) => `Local Codex gateway failed${match?.[1] ? ` with status ${match[1]}` : "."}`,
    },
    {
      id: "powershell-parser-error",
      test: /ParserError|Unexpected token|The string is missing the terminator/i,
      failureClass: "command_error",
      failureScope: "invocation",
      retryable: false,
      blocking: true,
      summary: () => `Command invocation failed because the shell could not parse it. ${summary}`.trim(),
    },
    {
      id: "maven-lifecycle-phase",
      test: /Unknown lifecycle phase\b/i,
      failureClass: "command_error",
      failureScope: "invocation",
      retryable: false,
      blocking: true,
      summary: () => `Maven command shape was invalid. ${summary}`.trim(),
    },
    {
      id: "missing-command",
      test: /is not recognized as the name of a cmdlet|command not found|No such file or directory/i,
      failureClass: "environment_blocker",
      failureScope: "tooling",
      retryable: false,
      blocking: true,
      summary: () => `Required tool or executable was unavailable. ${summary}`.trim(),
    },
    {
      id: "jacoco-coverage",
      test: /jacoco|coverage.*(minimum|required|threshold)|Rule violated for bundle/i,
      failureClass: "quality_gate_failure",
      failureScope: "coverage",
      retryable: true,
      blocking: true,
      summary: () => `Coverage gate failed. ${summary}`.trim(),
    },
    {
      id: "test-failure",
      test: /\bTests run:|\bFailures: \d+|\b<<< FAILURE!|AssertionError|expected:|org\.junit/i,
      failureClass: "functional_failure",
      failureScope: "test",
      retryable: true,
      blocking: true,
      summary: () => `Functional verification failed. ${summary}`.trim(),
    },
    {
      id: "compile-failure",
      test: /\bCOMPILATION ERROR\b|BUILD FAILURE|Failed to execute goal/i,
      failureClass: "functional_failure",
      failureScope: "build",
      retryable: true,
      blocking: true,
      summary: () => `Build or compile verification failed. ${summary}`.trim(),
    },
  ];

  for (const rule of rules) {
    const match = combined.match(rule.test);
    if (match) {
      return {
        failureClass: rule.failureClass,
        failureScope: rule.failureScope,
        retryable: rule.retryable,
        blocking: rule.blocking,
        matchedRuleId: rule.id,
        normalizedSummary: truncateText(rule.summary(match), 360),
      };
    }
  }

  return {
    failureClass: "unknown",
    failureScope: "unknown",
    retryable: false,
    blocking: true,
    matchedRuleId: null,
    normalizedSummary: summary || "Evaluation failed for an unknown reason.",
  };
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item): item is string => item.length > 0);
}

function normalizeMetadata(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function extractNullableString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeCaseLinkage(item: ExternalTargetCase): ExternalTargetCase {
  const metadata = normalizeMetadata(item.metadata);
  const strategyId = item.strategyId ?? extractNullableString(metadata.strategyId);
  const milestoneId = item.milestoneId ?? extractNullableString(metadata.milestoneId);
  return {
    ...item,
    track: item.track ?? null,
    strategyId,
    milestoneId,
    metadata: {
      ...metadata,
      ...(strategyId ? { strategyId } : {}),
      ...(milestoneId ? { milestoneId } : {}),
    },
  };
}

function caseStrategyId(item: ExternalTargetCase) {
  return item.strategyId ?? extractNullableString(item.metadata?.strategyId) ?? null;
}

function caseMilestoneId(item: ExternalTargetCase) {
  return item.milestoneId ?? extractNullableString(item.metadata?.milestoneId) ?? null;
}

function defaultNextConsumer(config: ExternalTargetConfig) {
  return `${sanitizeLabel(config.id || config.label)}-maintainer`;
}

function formatDirectionBrief(brief: ExternalDirectionBrief | undefined) {
  if (!brief) {
    return [];
  }

  const sections = [
    brief.activeTrack ? `- Active track: ${brief.activeTrack}` : null,
    brief.productGoal ? `- Product goal: ${brief.productGoal}` : null,
    brief.userExperience ? `- Intended user experience: ${brief.userExperience}` : null,
    brief.platformScope ? `- Platform scope: ${brief.platformScope}` : null,
    brief.implementationPreference ? `- Implementation preference: ${brief.implementationPreference}` : null,
    ...(brief.constraints ?? []).map((item) => `- Constraint: ${item}`),
    ...(brief.avoid ?? []).map((item) => `- Avoid: ${item}`),
    ...(brief.successSignals ?? []).map((item) => `- Success signal: ${item}`),
    brief.notes ? `- Operator notes: ${brief.notes}` : null,
  ].filter((item): item is string => Boolean(item));

  if (sections.length === 0) {
    return [];
  }

  return [
    "Structured direction brief:",
    ...sections,
    "",
  ];
}

function extractJsonArray(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const tryParse = (candidate: string) => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(trimmed);
  if (direct) {
    return direct;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed) {
      return parsed;
    }
  }

  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    return tryParse(trimmed.slice(firstBracket, lastBracket + 1));
  }

  return null;
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

async function loadExternalTargetConfig(context: HarnessContext) {
  return JSON.parse(await readFile(context.target.adapterConfigPath, "utf8")) as ExternalTargetConfig;
}

async function loadCases(context: HarnessContext, config: ExternalTargetConfig) {
  const cases = JSON.parse(await readFile(casesPathForConfig(context, config), "utf8")) as ExternalTargetCase[];
  return cases.map((item) => normalizeCaseLinkage(item));
}

function casesPathForConfig(context: HarnessContext, config: ExternalTargetConfig) {
  return resolveConfigRelativePath(context.target.adapterConfigPath, config.casesPath);
}

type NormalizedExternalPlanningConfig = {
  enabled: boolean;
  strategyPath: string;
  milestonesPath: string;
  strategy: ExternalStrategyPlannerConfig;
  milestones: ExternalMilestonePlannerConfig;
  cases: ExternalCasePlannerConfig;
  strategyEvaluator: ExternalPlanningEvaluatorConfig;
  milestoneEvaluator: ExternalPlanningEvaluatorConfig;
  contextBudget: ExternalPlanningContextBudget;
};

function normalizePlanningConfig(config: ExternalTargetConfig): NormalizedExternalPlanningConfig {
  const planning = config.planning;
  const defaultBasePrompt = `Plan the next development cases for ${config.label}.`;
  const defaultDirectionNote = planning?.directionNote ?? null;
  const defaultModel = planning?.model ?? null;
  const defaultBatchSize = planning?.batchSize ?? 3;
  const defaultRecentHandoffs = planning?.maxRecentHandoffs ?? 5;
  return {
    enabled: planning?.enabled ?? false,
    strategyPath: planning?.strategyPath ?? "strategy.json",
    milestonesPath: planning?.milestonesPath ?? "milestones.json",
    strategy: {
      agentId: planning?.strategy?.agentId ?? "strategy-planner",
      label: planning?.strategy?.label ?? "Strategy Planner",
      basePrompt: planning?.strategy?.basePrompt
        ?? `Synthesize the long-term development strategy for ${config.label} from repository truth.`,
      directionNote: planning?.strategy?.directionNote ?? defaultDirectionNote,
      model: planning?.strategy?.model ?? defaultModel,
      maxRecentHandoffs: planning?.strategy?.maxRecentHandoffs ?? Math.max(defaultRecentHandoffs, 8),
      refreshAfterVerifiedCases: planning?.strategy?.refreshAfterVerifiedCases ?? 5,
    },
    milestones: {
      agentId: planning?.milestones?.agentId ?? "milestone-planner",
      label: planning?.milestones?.label ?? "Milestone Planner",
      basePrompt: planning?.milestones?.basePrompt
        ?? `Plan the next milestone batch for ${config.label} from the current strategy and repository truth.`,
      directionNote: planning?.milestones?.directionNote ?? defaultDirectionNote,
      model: planning?.milestones?.model ?? defaultModel,
      batchSize: planning?.milestones?.batchSize ?? defaultBatchSize,
    },
    cases: {
      agentId: planning?.cases?.agentId ?? "case-planner",
      label: planning?.cases?.label ?? "Case Planner",
      basePrompt: planning?.cases?.basePrompt ?? planning?.basePrompt ?? defaultBasePrompt,
      directionNote: planning?.cases?.directionNote ?? defaultDirectionNote,
      model: planning?.cases?.model ?? defaultModel,
      batchSize: planning?.cases?.batchSize ?? defaultBatchSize,
      maxRecentHandoffs: planning?.cases?.maxRecentHandoffs ?? defaultRecentHandoffs,
      firstGeneratedStatus: planning?.cases?.firstGeneratedStatus ?? planning?.firstGeneratedStatus ?? "ready",
      remainingGeneratedStatus: planning?.cases?.remainingGeneratedStatus ?? planning?.remainingGeneratedStatus ?? "backlog",
    },
    strategyEvaluator: {
      agentId: planning?.strategyEvaluator?.agentId ?? "strategy-evaluator",
      label: planning?.strategyEvaluator?.label ?? "Strategy Evaluator",
      basePrompt: planning?.strategyEvaluator?.basePrompt
        ?? `Evaluate whether the current ${config.label} strategy should remain active, complete, become superseded, or be marked blocked.`,
      directionNote: planning?.strategyEvaluator?.directionNote ?? defaultDirectionNote,
      model: planning?.strategyEvaluator?.model ?? defaultModel,
    },
    milestoneEvaluator: {
      agentId: planning?.milestoneEvaluator?.agentId ?? "milestone-evaluator",
      label: planning?.milestoneEvaluator?.label ?? "Milestone Evaluator",
      basePrompt: planning?.milestoneEvaluator?.basePrompt
        ?? `Evaluate whether the active ${config.label} milestone should remain active, complete, or be marked blocked.`,
      directionNote: planning?.milestoneEvaluator?.directionNote ?? defaultDirectionNote,
      model: planning?.milestoneEvaluator?.model ?? defaultModel,
    },
    contextBudget: {
      recentRunsLimit: planning?.contextBudget?.recentRunsLimit ?? defaultRecentHandoffs,
      entrySnapshotLimit: planning?.contextBudget?.entrySnapshotLimit ?? 6,
      entrySnapshotBytesPerFile: planning?.contextBudget?.entrySnapshotBytesPerFile ?? 3_000,
      verifiedInputSnapshotLimit: planning?.contextBudget?.verifiedInputSnapshotLimit ?? 4,
      verifiedInputBytesPerFile: planning?.contextBudget?.verifiedInputBytesPerFile ?? 2_000,
      gitStatusMaxLines: planning?.contextBudget?.gitStatusMaxLines ?? 80,
      maxContextBytes: planning?.contextBudget?.maxContextBytes ?? 24_000,
    },
  };
}

function strategyPathForConfig(context: HarnessContext, config: ExternalTargetConfig, planning = normalizePlanningConfig(config)) {
  return resolveConfigRelativePath(context.target.adapterConfigPath, planning.strategyPath);
}

function milestonesPathForConfig(context: HarnessContext, config: ExternalTargetConfig, planning = normalizePlanningConfig(config)) {
  return resolveConfigRelativePath(context.target.adapterConfigPath, planning.milestonesPath);
}

async function loadStrategy(
  context: HarnessContext,
  config: ExternalTargetConfig,
  planning = normalizePlanningConfig(config),
) {
  return readJsonIfExists<ExternalTargetStrategy>(strategyPathForConfig(context, config, planning));
}

async function loadMilestones(
  context: HarnessContext,
  config: ExternalTargetConfig,
  planning = normalizePlanningConfig(config),
) {
  return (await readJsonIfExists<ExternalTargetMilestone[]>(milestonesPathForConfig(context, config, planning))) ?? [];
}

async function writeStrategy(strategyPath: string, strategy: ExternalTargetStrategy) {
  await mkdir(path.dirname(strategyPath), { recursive: true });
  await writeFile(strategyPath, `${JSON.stringify(strategy, null, 2)}\n`, "utf8");
}

async function writeMilestones(milestonesPath: string, milestones: ExternalTargetMilestone[]) {
  await mkdir(path.dirname(milestonesPath), { recursive: true });
  await writeFile(milestonesPath, `${JSON.stringify(milestones, null, 2)}\n`, "utf8");
}

async function writeTargetArtifact<T>(context: HarnessContext, relativePath: string, payload: T) {
  const target = path.join(context.artifactStore.rootDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return target;
}

async function readTargetArtifact<T>(context: HarnessContext, relativePath: string) {
  return readJsonIfExists<T>(path.join(context.artifactStore.rootDir, relativePath));
}

function selectReadyCase(cases: ExternalTargetCase[], selectedTaskId: string | null) {
  const readyCases = cases.filter((item) => item.status === "ready");
  if (selectedTaskId) {
    const selected = readyCases.find((item) => item.id === selectedTaskId);
    if (!selected) {
      throw new Error(`Case "${selectedTaskId}" is not ready for target "external-generic".`);
    }
    return selected;
  }
  return readyCases[0] ?? null;
}

async function writeCases(casesPath: string, cases: ExternalTargetCase[]) {
  await mkdir(path.dirname(casesPath), { recursive: true });
  await writeFile(casesPath, `${JSON.stringify(cases.map((item) => normalizeCaseLinkage(item)), null, 2)}\n`, "utf8");
}

async function markCaseStatus(
  context: HarnessContext,
  contract: SprintContract,
  nextStatus: ExternalTargetCase["status"],
): Promise<HarnessCompletionUpdate | null> {
  const config = await loadExternalTargetConfig(context);
  const casesPath = casesPathForConfig(context, config);
  const cases = await loadCases(context, config);
  const index = cases.findIndex((item) => item.id === contract.caseId);
  if (index < 0) {
    throw new Error(`Case "${contract.caseId}" was not found in ${casesPath}.`);
  }

  const current = cases[index];
  if (current.status === nextStatus) {
    return {
      itemId: current.id,
      title: current.title,
      fromStatus: current.status,
      toStatus: nextStatus,
      sourcePath: casesPath,
      summary: `Case ${current.id} already marked ${nextStatus}.`,
    };
  }

  cases[index] = {
    ...current,
    status: nextStatus,
  };
  await writeCases(casesPath, cases);
  return {
    itemId: current.id,
    title: current.title,
    fromStatus: current.status,
    toStatus: nextStatus,
    sourcePath: casesPath,
    summary: `Updated ${current.id} from ${current.status} to ${nextStatus}.`,
  };
}

function promptForContract(config: ExternalTargetConfig, contract: SprintContract, resume: boolean) {
  const directionNote = config.execution.directionNote?.trim();
  const base = resume ? config.execution.resumePrompt : config.execution.basePrompt;
  return [
    base,
    "",
    ...formatDirectionBrief(config.directionBrief),
    ...(directionNote
      ? [
          "Current operator direction:",
          directionNote,
          "",
        ]
      : []),
    "You are operating inside a generic development harness.",
    `Target: ${config.label}`,
    `Sprint contract id: ${contract.id}`,
    `Case id: ${contract.caseId}`,
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
    "- Operate only inside the target repository.",
    "- Make one coherent, reviewable unit of progress.",
    "- Leave the target repository ready for external evaluation.",
    "- Do not rely on hidden chat-only state.",
  ].join("\n");
}

function createContract(
  manifest: ProjectAdapterManifest,
  config: ExternalTargetConfig,
  externalCase: ExternalTargetCase,
): SprintContract {
  return {
    id: `${externalCase.id.toLowerCase()}-${Date.now()}`,
    adapterId: manifest.id,
    caseId: externalCase.id,
    title: externalCase.title,
    goal: externalCase.goal,
    instructions: externalCase.instructions ?? [`Advance ${externalCase.id} for ${config.label}.`],
    inputs: externalCase.inputs ?? [],
    allowedWriteScope: externalCase.allowedWriteScope ?? config.execution.defaultWriteScope,
    acceptanceChecks: externalCase.acceptanceChecks ?? [],
    expectedArtifacts: externalCase.expectedArtifacts ?? [],
    nextConsumer: externalCase.nextConsumer ?? null,
    createdAt: nowIso(),
    metadata: {
      targetLabel: config.label,
      ...externalCase.metadata,
    },
  };
}

async function artifactRootWrite(root: string, relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return target;
}

async function runEvaluationCommands(
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
    const classification = result.exitCode === 0
      ? {
          failureClass: "unknown" as EvaluationFailureClass,
          failureScope: "unknown" as EvaluationFailureScope,
          retryable: false,
          blocking: false,
          matchedRuleId: null,
          normalizedSummary: `${item.label} passed.`,
        }
      : classifyEvaluationFailure(item.command, result.stdout, result.stderr);
    results.push({
      label: item.label,
      command: item.command,
      passed: result.exitCode === 0,
      returnCode: result.exitCode,
      stdoutLog,
      stderrLog,
      elapsedSeconds: result.elapsedSeconds,
      failureClass: classification.failureClass,
      failureScope: classification.failureScope,
      retryable: classification.retryable,
      blocking: classification.blocking,
      normalizedSummary: classification.normalizedSummary,
      matchedRuleId: classification.matchedRuleId,
    });
    if (result.exitCode !== 0) {
      break;
    }
  }
  return results;
}

async function collectMarkdownPaths(root: string, current = root, accumulator: string[] = []) {
  if (!existsSync(current)) {
    return accumulator;
  }

  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdownPaths(root, absolute, accumulator);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      accumulator.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  return accumulator.sort();
}

async function snapshotPath(repoRoot: string, relativePath: string) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    return null;
  }

  const stats = await import("node:fs/promises").then((fs) => fs.stat(absolutePath));
  if (stats.isFile()) {
    const content = await readFile(absolutePath, "utf8");
    const truncated = truncateWithMeta(content, SNAPSHOT_LIMIT);
    return {
      path: relativePath.replaceAll("\\", "/"),
      content: truncated.content,
      originalBytes: truncated.originalBytes,
      includedBytes: truncated.includedBytes,
      truncated: truncated.truncated,
    };
  }

  if (!stats.isDirectory()) {
    return null;
  }

  const listing = (await collectDirectoryListing(absolutePath)).slice(0, DIRECTORY_LISTING_LIMIT);
  return {
    path: relativePath.replaceAll("\\", "/"),
    ...truncateWithMeta(`Directory listing:\n${listing.join("\n")}`, SNAPSHOT_LIMIT),
  };
}

function isSnapshotEntry(
  value: Awaited<ReturnType<typeof snapshotPath>>,
): value is NonNullable<Awaited<ReturnType<typeof snapshotPath>>> {
  return value !== null;
}

async function collectDirectoryListing(root: string, current = root, accumulator: string[] = []) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    accumulator.push(relative || ".");
    if (entry.isDirectory() && accumulator.length < DIRECTORY_LISTING_LIMIT) {
      await collectDirectoryListing(root, absolute, accumulator);
    }
    if (accumulator.length >= DIRECTORY_LISTING_LIMIT) {
      break;
    }
  }
  return accumulator;
}

async function collectEntrySnapshots(context: HarnessContext) {
  const candidatePaths = ["README.md", "pom.xml"];
  const docsRoot = path.join(context.targetRepoRoot, "docs");
  const docsPaths = await collectMarkdownPaths(context.targetRepoRoot, docsRoot);
  const snapshots = [];

  for (const relativePath of [...candidatePaths, ...docsPaths]) {
    const snapshot = await snapshotPath(context.targetRepoRoot, relativePath);
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }

  return snapshots;
}

async function loadRecentRunSummaries(context: HarnessContext, maxRecentHandoffs: number) {
  const runsDir = path.join(context.controlRepoRoot, context.target.artifactRoot, "runs");
  if (!existsSync(runsDir)) {
    return [];
  }

  const entries = await readdir(runsDir, { withFileTypes: true });
  const runIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  const summaries: ExternalPlannerContextPacket["recentRuns"] = [];
  for (const runId of runIds) {
    if (summaries.length >= maxRecentHandoffs) {
      break;
    }

    const runDir = path.join(runsDir, runId);
    const [contract, evaluation, evaluationResume, evaluationManual, checkpoint, handoff, handoffResume] = await Promise.all([
      readJsonIfExists<{ caseId?: string | null; title?: string | null }>(path.join(runDir, "contract.json")),
      readJsonIfExists<{ passed?: boolean; failureReason?: string | null }>(path.join(runDir, "evaluation.json")),
      readJsonIfExists<{ passed?: boolean; failureReason?: string | null }>(path.join(runDir, "evaluation.resume.json")),
      readJsonIfExists<{ passed?: boolean; failureReason?: string | null }>(path.join(runDir, "evaluation.manual.json")),
      readJsonIfExists<{ updatedAt?: string | null; summary?: string | null }>(path.join(runDir, "checkpoint.json")),
      readTextIfExists(path.join(runDir, "handoff.md")),
      readTextIfExists(path.join(runDir, "handoff.resume.md")),
    ]);

    if (!contract && !checkpoint) {
      continue;
    }

    const effectiveEvaluation = evaluationManual ?? evaluationResume ?? evaluation;
    summaries.push({
      runId,
      caseId: contract?.caseId ?? null,
      title: contract?.title ?? null,
      summary: truncateText((handoffResume ?? handoff ?? checkpoint?.summary ?? "").trim(), 4_000) || null,
      evaluationPassed: effectiveEvaluation?.passed ?? null,
      failureReason: effectiveEvaluation?.failureReason ?? null,
      updatedAt: checkpoint?.updatedAt ?? null,
    });
  }

  return summaries;
}

function deriveCasePrefix(cases: ExternalTargetCase[], config: ExternalTargetConfig) {
  const existing = cases
    .map((item) => item.id.match(/^([A-Z]+)-\d+$/)?.[1])
    .find(Boolean);
  if (existing) {
    return existing;
  }

  const compact = (config.id || config.label)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
  return compact.slice(0, 3) || "CASE";
}

function nextCaseNumber(cases: ExternalTargetCase[]) {
  return cases.reduce((max, item) => {
    const match = item.id.match(/-(\d+)$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
}

function normalizeCaseFingerprintValue(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function caseFingerprintKeys(title: string, goal: string) {
  const normalizedTitle = normalizeCaseFingerprintValue(title);
  const normalizedGoal = normalizeCaseFingerprintValue(goal);
  return [
    normalizedTitle,
    normalizedGoal,
    `${normalizedTitle}::${normalizedGoal}`,
  ].filter((item) => item.length > 0);
}

function compactCaseForPlanner(item: ExternalTargetCase) {
  return {
    id: item.id,
    title: truncateText(item.title, 100),
    status: item.status,
    track: item.track ?? null,
    strategyId: item.strategyId ?? null,
    milestoneId: item.milestoneId ?? null,
    goal: truncateText(item.goal, 140),
  } satisfies ExternalTargetCase;
}

function compactMilestoneForPlanner(item: ExternalTargetMilestone) {
  return {
    id: item.id,
    strategyId: item.strategyId ?? null,
    title: truncateText(item.title, 100),
    status: item.status,
    track: item.track ?? null,
    goal: truncateText(item.goal, 140),
    scope: item.scope.slice(0, 3).map((line) => truncateText(line, 120)),
    exitCriteria: item.exitCriteria.slice(0, 3).map((line) => truncateText(line, 120)),
    successSignals: item.successSignals.slice(0, 3).map((line) => truncateText(line, 120)),
    casePlanningGuidance: item.casePlanningGuidance.slice(0, 3).map((line) => truncateText(line, 120)),
    agentId: item.agentId,
    agentLabel: item.agentLabel,
    generatedAt: item.generatedAt,
    updatedAt: item.updatedAt,
  } satisfies ExternalTargetMilestone;
}

function compactStrategyForPlanner(item: ExternalTargetStrategy | null) {
  if (!item) {
    return null;
  }
  return {
    ...item,
    title: truncateText(item.title, 120),
    summary: truncateText(item.summary, 220),
    horizonGoal: truncateText(item.horizonGoal, 180),
    whyNow: item.whyNow ? truncateText(item.whyNow, 140) : null,
    nextMilestoneThemes: item.nextMilestoneThemes.slice(0, 4).map((line) => truncateText(line, 100)),
    implementationGuidance: item.implementationGuidance.slice(0, 4).map((line) => truncateText(line, 100)),
    risks: item.risks.slice(0, 3).map((line) => truncateText(line, 100)),
    opportunities: item.opportunities.slice(0, 3).map((line) => truncateText(line, 100)),
    successSignals: item.successSignals.slice(0, 4).map((line) => truncateText(line, 100)),
  } satisfies ExternalTargetStrategy;
}

function prioritizedCasesForPlanner(cases: ExternalTargetCase[]) {
  const unfinished = cases.filter((item) => unfinishedCaseStatuses(item.status));
  const recentCompleted = [...cases]
    .reverse()
    .filter((item) => !unfinishedCaseStatuses(item.status))
    .slice(0, 20);
  const seen = new Set<string>();
  return [...unfinished, ...recentCompleted].filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
}

function filterPlannerDrafts(drafts: ExternalPlannerDraftCase[], cases: ExternalTargetCase[]) {
  const seen = new Set<string>();

  for (const item of cases) {
    for (const key of caseFingerprintKeys(item.title, item.goal)) {
      seen.add(key);
    }
  }

  const filtered: ExternalPlannerDraftCase[] = [];
  for (const draft of drafts) {
    const keys = caseFingerprintKeys(draft.title, draft.goal);
    if (keys.some((key) => seen.has(key))) {
      continue;
    }

    filtered.push(draft);
    for (const key of keys) {
      seen.add(key);
    }
  }

  return filtered;
}

function filterMilestoneDrafts(drafts: ExternalPlannerDraftMilestone[], milestones: ExternalTargetMilestone[]) {
  const seen = new Set<string>();
  for (const item of milestones) {
    for (const key of caseFingerprintKeys(item.title, item.goal)) {
      seen.add(key);
    }
  }

  const filtered: ExternalPlannerDraftMilestone[] = [];
  for (const draft of drafts) {
    const keys = caseFingerprintKeys(draft.title, draft.goal);
    if (keys.some((key) => seen.has(key))) {
      continue;
    }
    filtered.push(draft);
    for (const key of keys) {
      seen.add(key);
    }
  }

  return filtered;
}

function normalizePlannerNotes(note: string | null | undefined) {
  const trimmed = note?.trim() ?? "";
  return trimmed ? [
    "Current operator direction for this planner:",
    trimmed,
    "",
  ] : [];
}

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const tryParse = (candidate: string) => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(trimmed);
  if (direct) {
    return direct;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed) {
      return parsed;
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return tryParse(trimmed.slice(firstBrace, lastBrace + 1));
  }

  return null;
}

function deriveStrategyPrefix(cases: ExternalTargetCase[], config: ExternalTargetConfig) {
  return `${deriveCasePrefix(cases, config)}-S`;
}

function deriveMilestonePrefix(cases: ExternalTargetCase[], config: ExternalTargetConfig) {
  return `${deriveCasePrefix(cases, config)}-M`;
}

function nextMilestoneNumber(milestones: ExternalTargetMilestone[]) {
  return milestones.reduce((max, item) => {
    const match = item.id.match(/-M(\d+)$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
}

function activeTrackForConfig(config: ExternalTargetConfig) {
  return config.directionBrief?.activeTrack ?? null;
}

function latestVerifiedCaseCount(cases: ExternalTargetCase[]) {
  return cases.filter((item) => item.status === "verified").length;
}

function strategyHasOpenWork(
  strategy: ExternalTargetStrategy,
  cases: ExternalTargetCase[],
  milestones: ExternalTargetMilestone[],
) {
  const openMilestones = milestones.some((item) => (
    item.strategyId === strategy.id
    && !["completed", "parked"].includes(item.status)
  ));
  if (openMilestones) {
    return true;
  }

  return cases.some((item) => (
    caseStrategyId(item) === strategy.id
    && unfinishedCaseStatuses(item.status)
  ));
}

function shouldRefreshStrategy(
  strategy: ExternalTargetStrategy | null,
  cases: ExternalTargetCase[],
  milestones: ExternalTargetMilestone[],
  config: ExternalTargetConfig,
  planning: NormalizedExternalPlanningConfig,
) {
  if (!strategy) {
    return true;
  }

  if (strategy.status !== "active") {
    return false;
  }

  if (strategy.track !== activeTrackForConfig(config)) {
    return true;
  }

  const refreshAfter = planning.strategy.refreshAfterVerifiedCases ?? null;
  if (!refreshAfter || refreshAfter <= 0) {
    return false;
  }

  if (strategyHasOpenWork(strategy, cases, milestones)) {
    return false;
  }

  const verifiedSinceStrategy = cases.filter((item) => item.status === "verified" && caseStrategyId(item) === strategy.id).length;
  return verifiedSinceStrategy >= refreshAfter;
}

function selectActiveStrategy(strategy: ExternalTargetStrategy | null, activeTrack: string | null) {
  if (!strategy) {
    return null;
  }
  if (strategy.status !== "active") {
    return null;
  }
  if (strategy.track !== activeTrack) {
    return null;
  }
  return strategy;
}

function selectActiveMilestone(
  milestones: ExternalTargetMilestone[],
  activeTrack: string | null,
  strategyId?: string | null,
) {
  return milestones.find((item) => (
    item.status === "active"
    && item.track === activeTrack
    && (strategyId === undefined || item.strategyId === strategyId)
  )) ?? null;
}

function sameTrackMilestones(milestones: ExternalTargetMilestone[], activeTrack: string | null) {
  return milestones.filter((item) => item.track === activeTrack);
}

function unfinishedCaseStatuses(status: ExternalTargetCase["status"]) {
  return !["verified", "done", "parked"].includes(status);
}

function unfinishedCasesForMilestone(cases: ExternalTargetCase[], milestoneId: string) {
  return cases.filter((item) => caseMilestoneId(item) === milestoneId && unfinishedCaseStatuses(item.status));
}

function milestoneBacklogForTrack(
  milestones: ExternalTargetMilestone[],
  activeTrack: string | null,
  strategyId?: string | null,
) {
  return milestones.find((item) => (
    item.status === "backlog"
    && item.track === activeTrack
    && (strategyId === undefined || item.strategyId === strategyId)
  )) ?? null;
}

function backlogCaseForMilestone(cases: ExternalTargetCase[], milestoneId: string, activeTrack: string | null) {
  return cases.find((item) => (
    item.status === "backlog"
    && caseMilestoneId(item) === milestoneId
    && (activeTrack == null || (item.track ?? null) === activeTrack)
  )) ?? null;
}

function activateNextMilestone(
  milestones: ExternalTargetMilestone[],
  activeTrack: string | null,
  completedMilestoneId: string,
  strategyId?: string | null,
) {
  let promotedMilestoneId: string | null = null;
  const next = milestoneBacklogForTrack(milestones, activeTrack, strategyId);
  const updated = milestones.map((item) => {
    if (item.id === completedMilestoneId) {
      return {
        ...item,
        status: "completed" as ExternalMilestoneStatus,
        updatedAt: nowIso(),
      };
    }
    if (next && item.id === next.id) {
      promotedMilestoneId = item.id;
      return {
        ...item,
        status: "active" as ExternalMilestoneStatus,
        updatedAt: nowIso(),
      };
    }
    return item;
  });
  return {
    milestones: updated,
    promotedMilestoneId,
  };
}

function promoteBacklogCase(
  cases: ExternalTargetCase[],
  targetCaseId: string,
): { cases: ExternalTargetCase[]; promoted: ExternalTargetCase | null } {
  let promoted: ExternalTargetCase | null = null;
  const updatedCases = cases.map((item) => {
    if (item.id !== targetCaseId) {
      return item;
    }
    promoted = normalizeCaseLinkage({
      ...item,
      status: "ready",
    });
    return promoted;
  });
  return {
    cases: updatedCases,
    promoted,
  };
}

function strategyIsTerminal(strategy: ExternalTargetStrategy | null) {
  return !strategy || strategy.status === "completed" || strategy.status === "superseded" || strategy.status === "blocked";
}

async function buildPlannerContext(
  context: HarnessContext,
  config: ExternalTargetConfig,
  cases: ExternalTargetCase[],
  planning: NormalizedExternalPlanningConfig,
  strategy: ExternalTargetStrategy | null,
  milestones: ExternalTargetMilestone[],
  activeMilestone: ExternalTargetMilestone | null,
  maxRecentHandoffs: number,
): Promise<ExternalPlannerContextPacket> {
  const compactCases = prioritizedCasesForPlanner(cases).map((item) => compactCaseForPlanner(item));
  const compactMilestones = milestones.map((item) => compactMilestoneForPlanner(item));
  const compactStrategy = compactStrategyForPlanner(strategy);
  const recentRuns = await loadRecentRunSummaries(
    context,
    Math.min(maxRecentHandoffs, planning.contextBudget.recentRunsLimit),
  );
  const gitStatus = await runShellCommand("git status --short", context.targetRepoRoot);
  const entrySnapshots = await collectEntrySnapshots(context);
  const latestVerifiedCase = [...cases].reverse().find((item) => item.status === "verified") ?? null;
  const latestVerifiedRun = latestVerifiedCase
    ? recentRuns.find((item) => item.caseId === latestVerifiedCase.id)
    : null;
  const latestVerifiedInputSnapshots = latestVerifiedCase
    ? (
        await Promise.all((latestVerifiedCase.inputs ?? []).map((item) => snapshotPath(context.targetRepoRoot, item)))
      ).filter(isSnapshotEntry)
    : [];

  const accumulator: ContextBudgetAccumulator = {
    remainingBytes: planning.contextBudget.maxContextBytes,
    truncated: false,
    entries: [],
  };
  const budgetedCurrentStrategy = takeBudgetedJsonItems(
    "currentStrategy",
    compactStrategy ? [compactStrategy] : [],
    accumulator,
  )[0] ?? null;
  const budgetedCurrentMilestones = takeBudgetedJsonItems("currentMilestones", compactMilestones, accumulator);
  const compactRecentRuns = recentRuns.map((item) => ({
    ...item,
    title: item.title ? truncateText(item.title, 100) : null,
    summary: item.summary ? truncateText(item.summary, 220) : null,
    failureReason: item.failureReason ? truncateText(item.failureReason, 180) : null,
  }));
  const budgetedRecentRuns = takeBudgetedJsonItems(
    "recentRuns",
    compactRecentRuns.slice(0, planning.contextBudget.recentRunsLimit),
    accumulator,
  ) as ExternalPlannerContextPacket["recentRuns"];
  const budgetedCurrentCases = takeBudgetedJsonItems("currentCases", compactCases, accumulator);
  const budgetedGitStatus = takeBudgetedStrings(
    "gitStatus",
    [(gitStatus.stdout || gitStatus.stderr).trim().split(/\r?\n/).slice(0, planning.contextBudget.gitStatusMaxLines).join("\n")],
    1,
    Math.max(512, Math.floor(planning.contextBudget.maxContextBytes * 0.15)),
    accumulator,
  )[0] ?? "";
  const budgetedEntrySnapshots = takeBudgetedSnapshots(
    "entrySnapshots",
    entrySnapshots,
    planning.contextBudget.entrySnapshotLimit,
    planning.contextBudget.entrySnapshotBytesPerFile,
    accumulator,
  );
  const budgetedVerifiedInputSnapshots = takeBudgetedSnapshots(
    "latestVerifiedInputSnapshots",
    latestVerifiedInputSnapshots,
    planning.contextBudget.verifiedInputSnapshotLimit,
    planning.contextBudget.verifiedInputBytesPerFile,
    accumulator,
  );
  const budgetReport = finalizeBudgetReport(accumulator, planning.contextBudget.maxContextBytes);

  return {
    targetId: context.target.id,
    targetLabel: config.label,
    targetRepoRoot: context.targetRepoRoot,
    generatedAt: nowIso(),
    truncated: budgetReport.truncated,
    budgetReport,
    currentCases: budgetedCurrentCases,
    currentStrategy: budgetedCurrentStrategy,
    currentMilestones: budgetedCurrentMilestones,
    activeMilestone,
    recentRuns: budgetedRecentRuns,
    gitStatus: budgetedGitStatus,
    entrySnapshots: budgetedEntrySnapshots,
    latestVerifiedCase: latestVerifiedCase
      ? {
          id: latestVerifiedCase.id,
          title: latestVerifiedCase.title,
          goal: latestVerifiedCase.goal,
          summary: latestVerifiedRun?.summary ?? null,
          metadata: latestVerifiedCase.metadata ?? {},
        }
      : null,
    latestVerifiedInputSnapshots: budgetedVerifiedInputSnapshots,
  };
}

function plannerPaths(context: HarnessContext, layer: ExternalPlanningLayer) {
  const plannerDir = layer === "cases"
    ? context.artifactStore.resolve("planner")
    : context.artifactStore.resolve(`planner/${layer}`);
  const plannerWorkspaceRoot = path.join(
    tmpdir(),
    "codex-harness-foundry",
    "planner-workspaces",
    sanitizeLabel(context.target.id),
    context.runSpec.runId,
  );
  const workspaceDir = layer === "cases"
    ? path.join(plannerWorkspaceRoot, "cases")
    : path.join(plannerWorkspaceRoot, layer);
  return {
    plannerDir,
    workspaceDir,
    contextArtifact: path.join(plannerDir, "context.json"),
    promptArtifact: path.join(plannerDir, "prompt.md"),
    outputRawArtifact: path.join(plannerDir, "output.raw.txt"),
    generatedCasesArtifact: path.join(plannerDir, "generated-cases.json"),
    publishResultArtifact: path.join(plannerDir, "publish-result.json"),
    stdoutLog: path.join(plannerDir, "stdout.log"),
    stderrLog: path.join(plannerDir, "stderr.log"),
    workspaceContext: path.join(workspaceDir, "context.json"),
  };
}

function buildStrategyPlannerPrompt(config: ExternalTargetConfig, planning: NormalizedExternalPlanningConfig) {
  return [
    planning.strategy.basePrompt,
    "",
    ...formatDirectionBrief(config.directionBrief),
    ...normalizePlannerNotes(planning.strategy.directionNote),
    `You are the dedicated ${planning.strategy.label} for this external target.`,
    "Read the file `context.json` in the current working directory before deciding anything.",
    "Refresh the long-term strategy for the target based on repository truth, recent verified work, and the current operator direction.",
    "",
    "Rules:",
    "- Focus on durable product direction, not a single code edit.",
    "- Keep the strategy aligned with the current active track and direction brief.",
    "- Use the recent run history to infer what has already been proven and what should come next.",
    "- Do not mention harness internals in the strategy content.",
    "",
    "Return ONLY one JSON object. No markdown. No prose.",
    "Schema:",
    "{",
    '  "title": "string",',
    '  "summary": "string",',
    '  "horizonGoal": "string",',
    '  "whyNow": "string",',
    '  "nextMilestoneThemes": ["string"],',
    '  "implementationGuidance": ["string"],',
    '  "risks": ["string"],',
    '  "opportunities": ["string"],',
    '  "successSignals": ["string"],',
    '  "metadata": { "focusArea": "string" }',
    "}",
  ].join("\n");
}

function buildMilestonePlannerPrompt(config: ExternalTargetConfig, planning: NormalizedExternalPlanningConfig) {
  return [
    planning.milestones.basePrompt,
    "",
    ...formatDirectionBrief(config.directionBrief),
    ...normalizePlannerNotes(planning.milestones.directionNote),
    `You are the dedicated ${planning.milestones.label} for this external target.`,
    "Read the file `context.json` in the current working directory before deciding anything.",
    `Generate exactly up to ${planning.milestones.batchSize} milestones that turn the current strategy into staged execution.`,
    "",
    "Rules:",
    "- Use the current strategy as the top-level source of truth.",
    "- Keep milestones sequential, concrete, and meaningfully larger than one case.",
    "- Avoid repeating existing active, backlog, completed, or parked milestones.",
    "- Keep milestone descriptions free of harness-internal wording.",
    "",
    "Return ONLY a JSON array. No markdown. No prose.",
    "Each item must use this schema:",
    "[",
    "  {",
    '    "title": "string",',
    '    "goal": "string",',
    '    "scope": ["string"],',
    '    "exitCriteria": ["string"],',
    '    "successSignals": ["string"],',
    '    "casePlanningGuidance": ["string"],',
    '    "metadata": { "focusArea": "string" }',
    "  }",
    "]",
  ].join("\n");
}

function buildCasePlannerPrompt(config: ExternalTargetConfig, planning: NormalizedExternalPlanningConfig) {
  return [
    planning.cases.basePrompt,
    "",
    ...formatDirectionBrief(config.directionBrief),
    ...normalizePlannerNotes(planning.cases.directionNote),
    `You are the dedicated ${planning.cases.label} for this external target.`,
    "Read the file `context.json` in the current working directory before deciding anything.",
    `Generate exactly up to ${planning.cases.batchSize} next cases for the active milestone in the target repository.`,
    "",
    "Rules:",
    "- Propose only the next most valuable product work after the currently verified work.",
    "- Use the active strategy and active milestone as the primary planning boundary.",
    "- Do not repeat any existing case, including verified, backlog, ready, in-progress, blocked, review, done, or parked history.",
    "- Assume the harness will stamp each published case with the current active track, strategy, and milestone lineage.",
    "- Keep each case implementable in one coherent harness cycle.",
    "- Do not mention harness internals in the case content.",
    "- Do not assign ids or statuses.",
    "- Stay within the target's likely write scope unless the repository context clearly requires more.",
    "",
    "Return ONLY a JSON array. No markdown. No prose.",
    "Each item must use this schema:",
    "[",
    "  {",
    '    "title": "string",',
    '    "goal": "string",',
    '    "instructions": ["string"],',
    '    "inputs": ["string"],',
    '    "allowedWriteScope": ["string"],',
    '    "acceptanceChecks": ["string"],',
    '    "expectedArtifacts": ["string"],',
    '    "nextConsumer": "string|null",',
    '    "metadata": { "focusArea": "string" }',
    "  }",
    "]",
  ].join("\n");
}

function buildStrategyEvaluatorPrompt(config: ExternalTargetConfig, planning: NormalizedExternalPlanningConfig) {
  return [
    planning.strategyEvaluator.basePrompt,
    "",
    ...formatDirectionBrief(config.directionBrief),
    ...normalizePlannerNotes(planning.strategyEvaluator.directionNote),
    `You are the dedicated ${planning.strategyEvaluator.label} for this external target.`,
    "Read the file `context.json` in the current working directory before deciding anything.",
    "Evaluate the current strategy with a medium-strict bar.",
    "",
    "Decision policy:",
    "- Return `completed` only when the strategy's main success signals are materially satisfied and milestone progression shows the main arc has landed.",
    "- Return `superseded` only when repository truth and direction clearly point to a replacement strategy.",
    "- Return `blocked` only when the strategy cannot advance without an external unblocker.",
    "- Fail closed. If evidence is mixed or weak, keep the strategy `active`.",
    "",
    "Return ONLY one JSON object. No markdown. No prose.",
    "Schema:",
    "{",
    '  "status": "active|completed|superseded|blocked",',
    '  "decision": "active|completed|superseded|blocked",',
    '  "summary": "string",',
    '  "evidence": ["string"],',
    '  "matchedExitCriteria": ["string"],',
    '  "missingExitCriteria": ["string"],',
    '  "recommendedNextAction": "string|null"',
    "}",
  ].join("\n");
}

function buildMilestoneEvaluatorPrompt(config: ExternalTargetConfig, planning: NormalizedExternalPlanningConfig) {
  return [
    planning.milestoneEvaluator.basePrompt,
    "",
    ...formatDirectionBrief(config.directionBrief),
    ...normalizePlannerNotes(planning.milestoneEvaluator.directionNote),
    `You are the dedicated ${planning.milestoneEvaluator.label} for this external target.`,
    "Read the file `context.json` in the current working directory before deciding anything.",
    "Evaluate the active milestone with a medium-strict bar.",
    "",
    "Decision policy:",
    "- Return `completed` only when there are no ready, in-progress, review, or blocked cases left for this milestone and most exit criteria are materially satisfied.",
    "- Minor non-critical leftovers are allowed if recent verified work clearly supports closure.",
    "- Return `blocked` only when the milestone cannot proceed without an external unblocker.",
    "- Fail closed. If evidence is mixed or weak, keep the milestone `active`.",
    "",
    "Return ONLY one JSON object. No markdown. No prose.",
    "Schema:",
    "{",
    '  "status": "active|completed|blocked",',
    '  "decision": "active|completed|blocked",',
    '  "summary": "string",',
    '  "evidence": ["string"],',
    '  "matchedExitCriteria": ["string"],',
    '  "missingExitCriteria": ["string"],',
    '  "recommendedNextAction": "string|null"',
    "}",
  ].join("\n");
}

function normalizePlanningEvaluation(
  layer: "strategy" | "milestone",
  candidate: Record<string, unknown> | null,
  context: HarnessContext,
  agentId: string,
  agentLabel: string,
  strategyId: string | null,
  milestoneId: string | null,
): ExternalPlanningEvaluation | null {
  if (!candidate) {
    return null;
  }

  const allowedDecisions = layer === "strategy"
    ? new Set(["active", "completed", "superseded", "blocked"])
    : new Set(["active", "completed", "blocked"]);
  const decision = typeof candidate.decision === "string" ? candidate.decision.trim() : "";
  const status = typeof candidate.status === "string" ? candidate.status.trim() : decision;
  const summary = typeof candidate.summary === "string" ? candidate.summary.trim() : "";
  if (!allowedDecisions.has(decision) || !allowedDecisions.has(status) || !summary) {
    return null;
  }

  return {
    layer,
    targetId: context.target.id,
    strategyId,
    milestoneId,
    agentId,
    agentLabel,
    evaluatedAt: nowIso(),
    sourceRunId: context.runSpec.runId,
    status: status as ExternalPlanningEvaluation["status"],
    decision: decision as ExternalPlanningEvaluation["decision"],
    summary,
    evidence: normalizeStringArray(candidate.evidence),
    matchedExitCriteria: normalizeStringArray(candidate.matchedExitCriteria),
    missingExitCriteria: normalizeStringArray(candidate.missingExitCriteria),
    recommendedNextAction: typeof candidate.recommendedNextAction === "string"
      ? candidate.recommendedNextAction.trim() || null
      : null,
  };
}

function normalizePlannerDraftCase(
  draft: unknown,
  config: ExternalTargetConfig,
): ExternalPlannerDraftCase | null {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    return null;
  }

  const candidate = draft as Record<string, unknown>;
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const goal = typeof candidate.goal === "string" ? candidate.goal.trim() : "";
  if (!title || !goal) {
    return null;
  }

  const nextConsumer = candidate.nextConsumer == null
    ? null
    : typeof candidate.nextConsumer === "string"
      ? candidate.nextConsumer.trim() || null
      : null;

  return {
    title,
    goal,
    instructions: normalizeStringArray(candidate.instructions),
    inputs: normalizeStringArray(candidate.inputs),
    allowedWriteScope: normalizeStringArray(candidate.allowedWriteScope).length > 0
      ? normalizeStringArray(candidate.allowedWriteScope)
      : config.execution.defaultWriteScope,
    acceptanceChecks: normalizeStringArray(candidate.acceptanceChecks),
    expectedArtifacts: normalizeStringArray(candidate.expectedArtifacts),
    nextConsumer,
    metadata: normalizeMetadata(candidate.metadata),
  };
}

function normalizePlannerDraftStrategy(draft: unknown): ExternalPlannerDraftStrategy | null {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    return null;
  }

  const candidate = draft as Record<string, unknown>;
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const summary = typeof candidate.summary === "string" ? candidate.summary.trim() : "";
  const horizonGoal = typeof candidate.horizonGoal === "string" ? candidate.horizonGoal.trim() : "";
  if (!title || !summary || !horizonGoal) {
    return null;
  }

  return {
    title,
    summary,
    horizonGoal,
    whyNow: typeof candidate.whyNow === "string" ? candidate.whyNow.trim() || null : null,
    nextMilestoneThemes: normalizeStringArray(candidate.nextMilestoneThemes),
    implementationGuidance: normalizeStringArray(candidate.implementationGuidance),
    risks: normalizeStringArray(candidate.risks),
    opportunities: normalizeStringArray(candidate.opportunities),
    successSignals: normalizeStringArray(candidate.successSignals),
    metadata: normalizeMetadata(candidate.metadata),
  };
}

function normalizePlannerDraftMilestone(draft: unknown): ExternalPlannerDraftMilestone | null {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    return null;
  }

  const candidate = draft as Record<string, unknown>;
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const goal = typeof candidate.goal === "string" ? candidate.goal.trim() : "";
  if (!title || !goal) {
    return null;
  }

  return {
    title,
    goal,
    scope: normalizeStringArray(candidate.scope),
    exitCriteria: normalizeStringArray(candidate.exitCriteria),
    successSignals: normalizeStringArray(candidate.successSignals),
    casePlanningGuidance: normalizeStringArray(candidate.casePlanningGuidance),
    metadata: normalizeMetadata(candidate.metadata),
  };
}

function createGeneratedStrategy(
  draft: ExternalPlannerDraftStrategy,
  existing: ExternalTargetStrategy | null,
  cases: ExternalTargetCase[],
  config: ExternalTargetConfig,
  planning: NormalizedExternalPlanningConfig,
  runId: string,
) {
  const revision = (existing?.revision ?? 0) + 1;
  return {
    id: `${deriveStrategyPrefix(cases, config)}${String(revision).padStart(3, "0")}`,
    revision,
    status: "active" as ExternalStrategyStatus,
    track: activeTrackForConfig(config),
    title: draft.title,
    summary: draft.summary,
    horizonGoal: draft.horizonGoal,
    whyNow: draft.whyNow ?? null,
    nextMilestoneThemes: draft.nextMilestoneThemes ?? [],
    implementationGuidance: draft.implementationGuidance ?? [],
    risks: draft.risks ?? [],
    opportunities: draft.opportunities ?? [],
    successSignals: draft.successSignals ?? [],
    agentId: planning.strategy.agentId,
    agentLabel: planning.strategy.label,
    generatedAt: existing?.generatedAt ?? nowIso(),
    updatedAt: nowIso(),
    sourceRunId: runId,
    metadata: draft.metadata ?? {},
  } satisfies ExternalTargetStrategy;
}

function createGeneratedMilestones(
  drafts: ExternalPlannerDraftMilestone[],
  existing: ExternalTargetMilestone[],
  strategy: ExternalTargetStrategy,
  config: ExternalTargetConfig,
  planning: NormalizedExternalPlanningConfig,
) {
  const prefix = deriveMilestonePrefix([], config);
  let nextNumber = nextMilestoneNumber(existing);
  return drafts.map((draft, index) => ({
    id: `${prefix}${String(nextNumber++).padStart(3, "0")}`,
    strategyId: strategy.id,
    title: draft.title,
    status: index === 0 ? "active" as ExternalMilestoneStatus : "backlog" as ExternalMilestoneStatus,
    track: activeTrackForConfig(config),
    goal: draft.goal,
    scope: draft.scope ?? [],
    exitCriteria: draft.exitCriteria ?? [],
    successSignals: draft.successSignals ?? [],
    casePlanningGuidance: draft.casePlanningGuidance ?? [],
    agentId: planning.milestones.agentId,
    agentLabel: planning.milestones.label,
    generatedAt: nowIso(),
    updatedAt: nowIso(),
    metadata: draft.metadata ?? {},
  } satisfies ExternalTargetMilestone));
}

function createGeneratedCases(
  drafts: ExternalPlannerDraftCase[],
  cases: ExternalTargetCase[],
  config: ExternalTargetConfig,
  planning: NormalizedExternalPlanningConfig,
  runId: string,
  strategy: ExternalTargetStrategy,
  milestone: ExternalTargetMilestone,
) {
  const prefix = deriveCasePrefix(cases, config);
  let nextNumber = nextCaseNumber(cases);

  return drafts.map((draft, index) => ({
    id: `${prefix}-${String(nextNumber++).padStart(3, "0")}`,
    title: draft.title,
    status: index === 0
      ? planning.cases.firstGeneratedStatus
      : planning.cases.remainingGeneratedStatus,
    track: config.directionBrief?.activeTrack ?? null,
    strategyId: strategy.id,
    milestoneId: milestone.id,
    goal: draft.goal,
    instructions: draft.instructions && draft.instructions.length > 0
      ? draft.instructions
      : [`Advance ${draft.title} for ${config.label}.`],
    inputs: draft.inputs ?? [],
    allowedWriteScope: draft.allowedWriteScope && draft.allowedWriteScope.length > 0
      ? draft.allowedWriteScope
      : config.execution.defaultWriteScope,
    acceptanceChecks: draft.acceptanceChecks ?? [],
    expectedArtifacts: draft.expectedArtifacts ?? [],
    nextConsumer: draft.nextConsumer ?? defaultNextConsumer(config),
    metadata: {
      ...draft.metadata,
      generatedByPlanner: true,
      plannerRunId: runId,
      generatedAt: nowIso(),
      generationMode: "auto-replenishment",
      plannerLayer: "cases",
      plannerAgentId: planning.cases.agentId,
      strategyId: strategy.id,
      milestoneId: milestone.id,
    },
  } satisfies ExternalTargetCase));
}

async function runPlannerLayer(
  context: HarnessContext,
  planning: NormalizedExternalPlanningConfig,
  config: ExternalTargetConfig,
  layer: ExternalPlanningLayer,
  prompt: string,
  contextPacket: ExternalPlannerContextPacket,
  model: string | null,
) {
  const paths = plannerPaths(context, layer);
  await mkdir(paths.plannerDir, { recursive: true });
  await mkdir(paths.workspaceDir, { recursive: true });

  await context.artifactStore.writeJson("planner/context.json", contextPacket);
  await context.artifactStore.writeJson("planner/context-budget.json", contextPacket.budgetReport);
  if (layer !== "cases") {
    await context.artifactStore.writeJson(`planner/${layer}/context.json`, contextPacket);
    await context.artifactStore.writeJson(`planner/${layer}/context-budget.json`, contextPacket.budgetReport);
  }
  await writeFile(paths.workspaceContext, `${JSON.stringify(contextPacket, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(paths.workspaceDir, "AGENTS.md"),
    [
      "# External Planner Workspace",
      "",
      "- This is an isolated harness planner workspace.",
      "- The only project context file in this workspace is `context.json`.",
      "- Do not assume `project.config.json`, `planning/task-board.json`, `planning/milestones.json`, or `docs/*` exist here.",
      "- Do not read parent-repository planning files.",
      "- Base every planning decision on `context.json` and the prompt for this run.",
      "",
    ].join("\n"),
    "utf8",
  );
  await context.artifactStore.writeText(layer === "cases" ? "planner/prompt.md" : `planner/${layer}/prompt.md`, prompt);

  const plannerResult = await runCodex({
    repoRoot: paths.workspaceDir,
    prompt,
    promptFile: paths.promptArtifact,
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
    lastMessageFile: paths.outputRawArtifact,
    sandboxMode: config.execution.sandboxMode,
    model: model ?? context.runSpec.model ?? config.execution.model,
    threadId: null,
    skipGitRepoCheck: true,
  });

  const rawOutput = plannerResult.lastMessage ?? (await readTextIfExists(paths.outputRawArtifact)) ?? "";
  if (plannerResult.failureReason || plannerResult.exitCode !== 0) {
    throw new Error(plannerResult.failureReason ?? `Planner run failed with exit code ${plannerResult.exitCode}.`);
  }

  if (layer !== "cases") {
    await context.artifactStore.writeText(`planner/${layer}/output.raw.txt`, rawOutput);
  }

  return {
    rawOutput,
    paths,
  };
}

async function loadStrategyEvaluation(context: HarnessContext) {
  return readTargetArtifact<ExternalPlanningEvaluation>(context, "strategy-evaluation.json");
}

function shouldRefreshStrategyEvaluation(
  strategy: ExternalTargetStrategy,
  evaluation: ExternalPlanningEvaluation | null,
) {
  if (!evaluation) {
    return true;
  }

  if (evaluation.layer !== "strategy" || evaluation.strategyId !== strategy.id) {
    return true;
  }

  if (strategy.updatedAt && evaluation.evaluatedAt < strategy.updatedAt) {
    return true;
  }

  return false;
}

async function loadMilestoneEvaluations(context: HarnessContext) {
  return (await readTargetArtifact<Record<string, ExternalPlanningEvaluation>>(context, "milestone-evaluations.json")) ?? {};
}

async function writeStrategyEvaluation(context: HarnessContext, evaluation: ExternalPlanningEvaluation) {
  await context.artifactStore.writeJson("planner/strategy/evaluation.json", evaluation);
  await writeTargetArtifact(context, "strategy-evaluation.json", evaluation);
}

async function writeMilestoneEvaluation(context: HarnessContext, milestoneId: string, evaluation: ExternalPlanningEvaluation) {
  await context.artifactStore.writeJson(`planner/milestones/${milestoneId}.evaluation.json`, evaluation);
  const current = await loadMilestoneEvaluations(context);
  current[milestoneId] = evaluation;
  await writeTargetArtifact(context, "milestone-evaluations.json", current);
}

function casesForMilestone(cases: ExternalTargetCase[], milestoneId: string) {
  return cases.filter((item) => caseMilestoneId(item) === milestoneId);
}

function completedCaseStatuses(status: ExternalTargetCase["status"]) {
  return ["verified", "done"].includes(status);
}

function caseStatusCounts(cases: ExternalTargetCase[]) {
  return {
    ready: cases.filter((item) => item.status === "ready").length,
    backlog: cases.filter((item) => item.status === "backlog").length,
    inProgress: cases.filter((item) => item.status === "in_progress").length,
    blocked: cases.filter((item) => item.status === "blocked").length,
    review: cases.filter((item) => item.status === "review").length,
    parked: cases.filter((item) => item.status === "parked").length,
    verified: cases.filter((item) => item.status === "verified").length,
    done: cases.filter((item) => item.status === "done").length,
  };
}

function runSummariesForCaseIds(contextPacket: ExternalPlannerContextPacket, caseIds: string[]) {
  const wanted = new Set(caseIds);
  return contextPacket.recentRuns
    .filter((item) => item.caseId && wanted.has(item.caseId))
    .slice(0, 5)
    .map((item) => `${item.caseId}: ${item.summary ?? "No handoff summary recorded."}`);
}

async function writeDeterministicEvaluationArtifacts(
  context: HarnessContext,
  relativeArtifactDir: string,
  prompt: string,
  contextPacket: ExternalPlannerContextPacket,
  evaluation: ExternalPlanningEvaluation,
) {
  await context.artifactStore.writeText(`${relativeArtifactDir}/evaluation.prompt.md`, prompt);
  await context.artifactStore.writeJson(`${relativeArtifactDir}/evaluation.context.json`, contextPacket);
  await context.artifactStore.writeJson(`${relativeArtifactDir}/evaluation.context-budget.json`, contextPacket.budgetReport);
  await context.artifactStore.writeText(
    `${relativeArtifactDir}/evaluation.stdout.log`,
    `[Harness] Deterministic external-target evaluator completed without launching a Codex sub-run.\n`,
  );
  await context.artifactStore.writeText(`${relativeArtifactDir}/evaluation.stderr.log`, "");
  await context.artifactStore.writeText(
    `${relativeArtifactDir}/evaluation.output.raw.txt`,
    `${JSON.stringify(evaluation, null, 2)}\n`,
  );
}

function evaluateMilestoneLocally(
  context: HarnessContext,
  planning: NormalizedExternalPlanningConfig,
  contextPacket: ExternalPlannerContextPacket,
  strategy: ExternalTargetStrategy,
  milestone: ExternalTargetMilestone,
): ExternalPlanningEvaluation {
  const linkedCases = casesForMilestone(contextPacket.currentCases, milestone.id);
  const counts = caseStatusCounts(linkedCases);
  const unfinished = linkedCases.filter((item) => unfinishedCaseStatuses(item.status));
  const completed = linkedCases.filter((item) => completedCaseStatuses(item.status));
  const recentVerifiedSummaries = runSummariesForCaseIds(
    contextPacket,
    completed.map((item) => item.id),
  );

  let decision: ExternalPlanningEvaluation["decision"] = "active";
  let summary = `Keep ${milestone.id} active. It still has open work or not enough proof to close.`;

  if (milestone.status === "blocked") {
    decision = "blocked";
    summary = `Mark ${milestone.id} blocked because the milestone itself is already marked blocked.`;
  } else if (counts.blocked > 0 && counts.ready === 0 && counts.inProgress === 0 && counts.review === 0 && counts.backlog === 0) {
    decision = "blocked";
    summary = `Mark ${milestone.id} blocked because only blocked cases remain and there is no runnable or backlog work left on the milestone.`;
  } else if (unfinished.length === 0 && completed.length > 0) {
    decision = "completed";
    summary = `Complete ${milestone.id}. No unfinished cases remain and verified work exists for this milestone.`;
  } else if (unfinished.length === 0 && linkedCases.length === 0) {
    summary = `Keep ${milestone.id} active. The milestone has no linked cases yet, so closure evidence is too weak.`;
  } else if (counts.backlog > 0) {
    summary = `Keep ${milestone.id} active. It still has ${counts.backlog} backlog case(s) to promote and finish.`;
  } else if (counts.ready > 0 || counts.inProgress > 0 || counts.review > 0) {
    summary = `Keep ${milestone.id} active. It still has runnable case work in the queue.`;
  }

  const evidence = [
    `Milestone ${milestone.id} is on strategy ${strategy.id} and track ${milestone.track ?? "untracked"}.`,
    `Case counts for ${milestone.id}: ready=${counts.ready}, backlog=${counts.backlog}, in_progress=${counts.inProgress}, review=${counts.review}, blocked=${counts.blocked}, verified=${counts.verified}, done=${counts.done}, parked=${counts.parked}.`,
    `Linked cases: ${linkedCases.length === 0 ? "none" : linkedCases.map((item) => `${item.id}:${item.status}`).join(", ")}.`,
    ...(recentVerifiedSummaries.length > 0 ? recentVerifiedSummaries : ["No recent verified handoff summaries are linked to this milestone yet."]),
  ];

  const matchedExitCriteria = decision === "completed" ? milestone.exitCriteria : [];
  const missingExitCriteria = decision === "completed"
    ? []
    : milestone.exitCriteria;
  const recommendedNextAction = decision === "completed"
    ? "Promote the next backlog milestone on the same track, or plan the next milestone batch if none exists."
    : decision === "blocked"
      ? "Surface the blocking case or dependency in the dashboard and wait for an operator or planner intervention."
      : counts.ready > 0 || counts.inProgress > 0 || counts.review > 0
        ? "Keep executing the active milestone's runnable cases."
        : counts.backlog > 0
          ? "Promote one backlog case to ready and continue execution."
          : "Generate or refine the next case batch for the active milestone.";

  return {
    layer: "milestone",
    targetId: context.target.id,
    strategyId: strategy.id,
    milestoneId: milestone.id,
    agentId: planning.milestoneEvaluator.agentId,
    agentLabel: planning.milestoneEvaluator.label,
    evaluatedAt: nowIso(),
    sourceRunId: context.runSpec.runId,
    status: decision,
    decision,
    summary,
    evidence,
    matchedExitCriteria,
    missingExitCriteria,
    recommendedNextAction,
  };
}

function evaluateStrategyLocally(
  context: HarnessContext,
  planning: NormalizedExternalPlanningConfig,
  contextPacket: ExternalPlannerContextPacket,
  strategy: ExternalTargetStrategy,
  milestones: ExternalTargetMilestone[],
  activeTrack: string | null,
): ExternalPlanningEvaluation {
  const strategyMilestones = milestones.filter((item) => item.strategyId === strategy.id);
  const activeMilestones = strategyMilestones.filter((item) => item.status === "active");
  const backlogMilestones = strategyMilestones.filter((item) => item.status === "backlog");
  const blockedMilestones = strategyMilestones.filter((item) => item.status === "blocked");
  const completedMilestones = strategyMilestones.filter((item) => item.status === "completed");
  const linkedCases = contextPacket.currentCases.filter((item) => caseStrategyId(item) === strategy.id);
  const verifiedLinkedCases = linkedCases.filter((item) => item.status === "verified" || item.status === "done");

  let decision: ExternalPlanningEvaluation["decision"] = "active";
  let summary = `Keep ${strategy.id} active while milestone work is still in progress.`;

  if (strategy.track !== activeTrack) {
    decision = "superseded";
    summary = `Mark ${strategy.id} superseded because the active operator track is now ${activeTrack ?? "none"}.`;
  } else if (blockedMilestones.length > 0 && activeMilestones.length === 0 && backlogMilestones.length === 0) {
    decision = "blocked";
    summary = `Mark ${strategy.id} blocked because only blocked milestones remain on the active track.`;
  } else if (strategyMilestones.length > 0 && activeMilestones.length === 0 && backlogMilestones.length === 0 && blockedMilestones.length === 0) {
    decision = "completed";
    summary = `Complete ${strategy.id}. Its milestones are finished and no further milestone work remains queued on this track.`;
  } else if (strategyMilestones.length === 0) {
    summary = `Keep ${strategy.id} active. It does not have any milestones yet, so closure evidence is too weak.`;
  } else if (activeMilestones.length > 0) {
    summary = `Keep ${strategy.id} active. It still has ${activeMilestones.length} active milestone(s) on the track.`;
  } else if (backlogMilestones.length > 0) {
    summary = `Keep ${strategy.id} active. It still has ${backlogMilestones.length} backlog milestone(s) to promote.`;
  }

  const evidence = [
    `Strategy ${strategy.id} status=${strategy.status}, track=${strategy.track ?? "untracked"}, activeTrack=${activeTrack ?? "none"}.`,
    `Milestone counts: active=${activeMilestones.length}, backlog=${backlogMilestones.length}, completed=${completedMilestones.length}, blocked=${blockedMilestones.length}.`,
    `Linked case counts: total=${linkedCases.length}, verified_or_done=${verifiedLinkedCases.length}.`,
    ...(contextPacket.recentRuns.slice(0, 5).map((item) => `${item.runId} ${item.caseId ?? "no-case"}: ${item.summary ?? "No summary."}`)),
  ];

  const matchedExitCriteria = decision === "completed" ? strategy.successSignals : [];
  const missingExitCriteria = decision === "completed"
    ? []
    : strategy.successSignals;
  const recommendedNextAction = decision === "completed"
    ? "Generate the next strategy for the active track."
    : decision === "superseded"
      ? "Plan and promote the replacement strategy for the new active track."
      : decision === "blocked"
        ? "Surface the blocked milestone set and wait for an operator or planning intervention."
        : activeMilestones.length > 0
          ? "Keep advancing the active milestone and re-evaluate the strategy after milestone closure."
          : backlogMilestones.length > 0
            ? "Promote the next backlog milestone and continue execution."
            : "Generate the next milestone batch for this strategy.";

  return {
    layer: "strategy",
    targetId: context.target.id,
    strategyId: strategy.id,
    milestoneId: null,
    agentId: planning.strategyEvaluator.agentId,
    agentLabel: planning.strategyEvaluator.label,
    evaluatedAt: nowIso(),
    sourceRunId: context.runSpec.runId,
    status: decision,
    decision,
    summary,
    evidence,
    matchedExitCriteria,
    missingExitCriteria,
    recommendedNextAction,
  };
}

async function runStrategyEvaluator(
  context: HarnessContext,
  config: ExternalTargetConfig,
  planning: NormalizedExternalPlanningConfig,
  cases: ExternalTargetCase[],
  strategy: ExternalTargetStrategy,
  milestones: ExternalTargetMilestone[],
) {
  const contextPacket = await buildPlannerContext(
    context,
    config,
    cases,
    planning,
    strategy,
    milestones,
    selectActiveMilestone(milestones, activeTrackForConfig(config), strategy.id),
    planning.strategy.maxRecentHandoffs,
  );
  const evaluation = evaluateStrategyLocally(
    context,
    planning,
    contextPacket,
    strategy,
    milestones,
    activeTrackForConfig(config),
  );
  await writeDeterministicEvaluationArtifacts(
    context,
    "planner/strategy",
    buildStrategyEvaluatorPrompt(config, planning),
    contextPacket,
    evaluation,
  );
  await writeStrategyEvaluation(context, evaluation);
  return evaluation;
}

async function runMilestoneEvaluator(
  context: HarnessContext,
  config: ExternalTargetConfig,
  planning: NormalizedExternalPlanningConfig,
  cases: ExternalTargetCase[],
  strategy: ExternalTargetStrategy,
  milestones: ExternalTargetMilestone[],
  milestone: ExternalTargetMilestone,
) {
  const contextPacket = await buildPlannerContext(
    context,
    config,
    cases,
    planning,
    strategy,
    milestones,
    milestone,
    planning.strategy.maxRecentHandoffs,
  );
  const evaluation = evaluateMilestoneLocally(
    context,
    planning,
    contextPacket,
    strategy,
    milestone,
  );
  await writeDeterministicEvaluationArtifacts(
    context,
    `planner/milestones/${milestone.id}`,
    buildMilestoneEvaluatorPrompt(config, planning),
    contextPacket,
    evaluation,
  );
  await writeMilestoneEvaluation(context, milestone.id, evaluation);
  return evaluation;
}

async function runStrategyPlanner(
  context: HarnessContext,
  config: ExternalTargetConfig,
  planning: NormalizedExternalPlanningConfig,
  cases: ExternalTargetCase[],
  existingStrategy: ExternalTargetStrategy | null,
  milestones: ExternalTargetMilestone[],
): Promise<ExternalPlannerPublishResult> {
  const contextPacket = await buildPlannerContext(
    context,
    config,
    cases,
    planning,
    existingStrategy,
    milestones,
    selectActiveMilestone(milestones, activeTrackForConfig(config), existingStrategy?.id),
    planning.strategy.maxRecentHandoffs,
  );
  const { rawOutput } = await runPlannerLayer(
    context,
    planning,
    config,
    "strategy",
    buildStrategyPlannerPrompt(config, planning),
    contextPacket,
    planning.strategy.model,
  );
  const parsed = extractJsonObject(rawOutput);
  const draft = normalizePlannerDraftStrategy(parsed);
  if (!draft) {
    throw new Error("Strategy planner output did not contain a valid JSON object.");
  }

  const strategy = createGeneratedStrategy(draft, existingStrategy, cases, config, planning, context.runSpec.runId);
  const strategyPath = strategyPathForConfig(context, config, planning);
  await writeStrategy(strategyPath, strategy);
  await context.artifactStore.writeJson("planner/strategy/generated-strategy.json", strategy);
  const result: ExternalPlannerPublishResult = {
    layer: "strategy",
    source: "generated",
    generatedCount: 1,
    publishedCount: 1,
    firstReadyCaseId: null,
    summary: `Strategy planner refreshed ${strategy.id}.`,
    outputPath: strategyPath,
    strategy,
  };
  await context.artifactStore.writeJson("planner/strategy/publish-result.json", result);
  return result;
}

async function runMilestonePlanner(
  context: HarnessContext,
  config: ExternalTargetConfig,
  planning: NormalizedExternalPlanningConfig,
  cases: ExternalTargetCase[],
  strategy: ExternalTargetStrategy,
  milestones: ExternalTargetMilestone[],
): Promise<ExternalPlannerPublishResult> {
  const contextPacket = await buildPlannerContext(
    context,
    config,
    cases,
    planning,
    strategy,
    milestones,
    selectActiveMilestone(milestones, activeTrackForConfig(config), strategy.id),
    planning.strategy.maxRecentHandoffs,
  );
  const { rawOutput } = await runPlannerLayer(
    context,
    planning,
    config,
    "milestones",
    buildMilestonePlannerPrompt(config, planning),
    contextPacket,
    planning.milestones.model,
  );
  const parsed = extractJsonArray(rawOutput);
  if (!parsed) {
    throw new Error("Milestone planner output did not contain a valid JSON array.");
  }

  const drafts = parsed
    .map((item) => normalizePlannerDraftMilestone(item))
    .filter((item): item is ExternalPlannerDraftMilestone => !!item)
    .slice(0, planning.milestones.batchSize);
  const dedupedDrafts = filterMilestoneDrafts(drafts, sameTrackMilestones(milestones, activeTrackForConfig(config)))
    .slice(0, planning.milestones.batchSize);
  const generatedMilestones = createGeneratedMilestones(dedupedDrafts, milestones, strategy, config, planning);
  await context.artifactStore.writeJson("planner/milestones/generated-milestones.json", generatedMilestones);

  const milestonesPath = milestonesPathForConfig(context, config, planning);
  if (generatedMilestones.length === 0) {
    const emptyResult: ExternalPlannerPublishResult = {
      layer: "milestones",
      source: "generated",
      generatedCount: 0,
      publishedCount: 0,
      firstReadyCaseId: null,
      summary: `Milestone planner found no new milestones for ${context.target.id}.`,
      outputPath: milestonesPath,
      generatedMilestones: [],
    };
    await context.artifactStore.writeJson("planner/milestones/publish-result.json", emptyResult);
    return emptyResult;
  }

  const updatedMilestones = [...milestones, ...generatedMilestones];
  await writeMilestones(milestonesPath, updatedMilestones);
  const result: ExternalPlannerPublishResult = {
    layer: "milestones",
    source: "generated",
    generatedCount: generatedMilestones.length,
    publishedCount: generatedMilestones.length,
    firstReadyCaseId: null,
    summary: `Milestone planner generated ${generatedMilestones.length} milestones. Active milestone: ${generatedMilestones[0]?.id ?? "n/a"}.`,
    outputPath: milestonesPath,
    generatedMilestones,
  };
  await context.artifactStore.writeJson("planner/milestones/publish-result.json", result);
  return result;
}

async function runCasePlannerReplenishment(
  context: HarnessContext,
  config: ExternalTargetConfig,
  planning: NormalizedExternalPlanningConfig,
  cases: ExternalTargetCase[],
  strategy: ExternalTargetStrategy,
  milestones: ExternalTargetMilestone[],
  activeMilestone: ExternalTargetMilestone,
): Promise<ExternalPlannerPublishResult> {
  const contextPacket = await buildPlannerContext(
    context,
    config,
    cases,
    planning,
    strategy,
    milestones,
    activeMilestone,
    planning.cases.maxRecentHandoffs,
  );
  const { rawOutput } = await runPlannerLayer(
    context,
    planning,
    config,
    "cases",
    buildCasePlannerPrompt(config, planning),
    contextPacket,
    planning.cases.model,
  );

  const parsed = extractJsonArray(rawOutput);
  if (!parsed) {
    throw new Error("Case planner output did not contain a valid JSON array.");
  }

  const normalizedDrafts = parsed
    .map((item) => normalizePlannerDraftCase(item, config))
    .filter((item): item is ExternalPlannerDraftCase => !!item)
    .slice(0, planning.cases.batchSize);
  const dedupedDrafts = filterPlannerDrafts(normalizedDrafts, cases).slice(0, planning.cases.batchSize);

  const generatedCases = createGeneratedCases(
    dedupedDrafts,
    cases,
    config,
    planning,
    context.runSpec.runId,
    strategy,
    activeMilestone,
  );
  await context.artifactStore.writeJson("planner/generated-cases.json", generatedCases);
  await context.artifactStore.writeJson("planner/cases/generated-cases.json", generatedCases);

  const casesPath = casesPathForConfig(context, config);
  if (generatedCases.length === 0) {
    const emptyResult: ExternalPlannerPublishResult = {
      layer: "cases",
      source: "generated",
      generatedCount: 0,
      publishedCount: 0,
      firstReadyCaseId: null,
      summary: `Case planner found no next work for active milestone ${activeMilestone.id}.`,
      outputPath: casesPath,
      generatedCases: [],
    };
    await context.artifactStore.writeJson("planner/publish-result.json", emptyResult);
    await context.artifactStore.writeJson("planner/cases/publish-result.json", emptyResult);
    return emptyResult;
  }

  const updatedCases = [...cases, ...generatedCases];
  await writeCases(casesPath, updatedCases);
  const publishResult: ExternalPlannerPublishResult = {
    layer: "cases",
    source: "generated",
    generatedCount: generatedCases.length,
    publishedCount: generatedCases.length,
    firstReadyCaseId: generatedCases.find((item) => item.status === "ready")?.id ?? null,
    summary: `Planner generated ${generatedCases.length} cases. Continuing with ${generatedCases[0]?.id ?? "the next ready case"}.`,
    outputPath: casesPath,
    generatedCases,
  };
  await context.artifactStore.writeJson("planner/publish-result.json", publishResult);
  await context.artifactStore.writeJson("planner/cases/publish-result.json", publishResult);
  return publishResult;
}

function describePlanningEvaluation(evaluation: ExternalPlanningEvaluation) {
  return `${evaluation.layer === "strategy" ? "Strategy" : "Milestone"} evaluator decided ${evaluation.decision}: ${evaluation.summary}`;
}

function updateStrategyStatus(strategy: ExternalTargetStrategy, status: ExternalTargetStrategy["status"]) {
  return {
    ...strategy,
    status,
    updatedAt: nowIso(),
  } satisfies ExternalTargetStrategy;
}

function updateMilestoneStatus(
  milestones: ExternalTargetMilestone[],
  milestoneId: string,
  status: ExternalTargetMilestone["status"],
) {
  return milestones.map((item) => item.id === milestoneId
    ? {
        ...item,
        status,
        updatedAt: nowIso(),
      }
    : item);
}

function promoteBacklogMilestone(
  milestones: ExternalTargetMilestone[],
  milestoneId: string,
) {
  return milestones.map((item) => item.id === milestoneId
    ? {
        ...item,
        status: "active" as ExternalMilestoneStatus,
        updatedAt: nowIso(),
      }
    : item);
}

async function ensureReadyCase(context: HarnessContext, config: ExternalTargetConfig) {
  const planning = normalizePlanningConfig(config);
  const cases = await loadCases(context, config);
  const selected = selectReadyCase(cases, context.selectedTaskId);
  if (selected) {
    return {
      selected,
      cases,
      publishResult: null as ExternalPlannerPublishResult | null,
    };
  }

  if (context.selectedTaskId || !planning.enabled) {
    return {
      selected: null,
      cases,
      publishResult: null as ExternalPlannerPublishResult | null,
    };
  }

  const planningSummaries: string[] = [];
  let workingCases = cases;
  let strategy = await loadStrategy(context, config, planning);
  let milestones = await loadMilestones(context, config, planning);
  let latestStrategyEvaluation = await loadStrategyEvaluation(context);
  const casesPath = casesPathForConfig(context, config);
  const strategyPath = strategyPathForConfig(context, config, planning);
  const milestonesPath = milestonesPathForConfig(context, config, planning);

  const summaryResult = (layer: ExternalPlanningLayer, outputPath: string, summary: string): {
    selected: ExternalTargetCase | null;
    cases: ExternalTargetCase[];
    publishResult: ExternalPlannerPublishResult;
  } => ({
    selected: null,
    cases: workingCases,
    publishResult: {
      layer,
      source: "generated",
      generatedCount: 0,
      publishedCount: 0,
      firstReadyCaseId: null,
      summary,
      outputPath,
    },
  });

  for (let guard = 0; guard < 12; guard += 1) {
    const activeTrack = activeTrackForConfig(config);

    if (strategy?.status === "blocked" && strategy.track === activeTrack) {
      return summaryResult(
        "strategy",
        strategyPath,
        `${planningSummaries.join(" ")} Strategy ${strategy.id} is blocked. ${latestStrategyEvaluation?.summary ?? ""}`.trim(),
      );
    }

    if (!strategy || shouldRefreshStrategy(strategy, workingCases, milestones, config, planning) || strategyIsTerminal(selectActiveStrategy(strategy, activeTrack))) {
      const strategyResult = await runStrategyPlanner(context, config, planning, workingCases, strategy, milestones);
      planningSummaries.push(strategyResult.summary);
      strategy = strategyResult.strategy ?? strategy;
      if (!strategy) {
        return summaryResult("strategy", strategyPath, `${planningSummaries.join(" ")} Strategy planner found no strategy for ${context.target.id}.`.trim());
      }
    }

    const activeStrategy = selectActiveStrategy(strategy, activeTrack);
    if (!activeStrategy) {
      return summaryResult("strategy", strategyPath, `${planningSummaries.join(" ")} No active strategy is available for ${context.target.id}.`.trim());
    }

    if (shouldRefreshStrategyEvaluation(activeStrategy, latestStrategyEvaluation)) {
      latestStrategyEvaluation = await runStrategyEvaluator(context, config, planning, workingCases, activeStrategy, milestones);
      planningSummaries.push(describePlanningEvaluation(latestStrategyEvaluation));
      if (latestStrategyEvaluation.decision === "blocked") {
        strategy = updateStrategyStatus(activeStrategy, "blocked");
        await writeStrategy(strategyPath, strategy);
        return summaryResult("strategy", strategyPath, `${planningSummaries.join(" ")} Strategy is blocked.`.trim());
      }
      if (latestStrategyEvaluation.decision === "completed" || latestStrategyEvaluation.decision === "superseded") {
        strategy = updateStrategyStatus(activeStrategy, latestStrategyEvaluation.decision);
        await writeStrategy(strategyPath, strategy);
        planningSummaries.push(`Marked strategy ${activeStrategy.id} as ${latestStrategyEvaluation.decision}.`);
        continue;
      }
    }

    let activeMilestone = selectActiveMilestone(milestones, activeTrack, activeStrategy.id);
    if (!activeMilestone) {
      const backlogMilestone = milestoneBacklogForTrack(milestones, activeTrack, activeStrategy.id);
      if (backlogMilestone) {
        milestones = promoteBacklogMilestone(milestones, backlogMilestone.id);
        await writeMilestones(milestonesPath, milestones);
        planningSummaries.push(`Promoted backlog milestone ${backlogMilestone.id} to active.`);
        activeMilestone = selectActiveMilestone(milestones, activeTrack, activeStrategy.id);
      } else {
        const milestoneResult = await runMilestonePlanner(context, config, planning, workingCases, activeStrategy, milestones);
        planningSummaries.push(milestoneResult.summary);
        milestones = await loadMilestones(context, config, planning);
        activeMilestone = selectActiveMilestone(milestones, activeTrack, activeStrategy.id);
        if (!activeMilestone) {
          latestStrategyEvaluation = await runStrategyEvaluator(context, config, planning, workingCases, activeStrategy, milestones);
          planningSummaries.push(describePlanningEvaluation(latestStrategyEvaluation));
          if (latestStrategyEvaluation.decision === "blocked") {
            strategy = updateStrategyStatus(activeStrategy, "blocked");
            await writeStrategy(strategyPath, strategy);
            return summaryResult("strategy", strategyPath, `${planningSummaries.join(" ")} Strategy is blocked.`.trim());
          }
          if (latestStrategyEvaluation.decision === "completed" || latestStrategyEvaluation.decision === "superseded") {
            strategy = updateStrategyStatus(activeStrategy, latestStrategyEvaluation.decision);
            await writeStrategy(strategyPath, strategy);
            planningSummaries.push(`Marked strategy ${activeStrategy.id} as ${latestStrategyEvaluation.decision}.`);
            continue;
          }
          return summaryResult("strategy", strategyPath, `${planningSummaries.join(" ")} No active milestone could be promoted or planned yet.`.trim());
        }
      }
    }

    if (!activeMilestone) {
      return summaryResult("milestones", milestonesPath, `${planningSummaries.join(" ")} No active milestone is available for ${activeStrategy.id}.`.trim());
    }

    const promotedBacklogCase = backlogCaseForMilestone(workingCases, activeMilestone.id, activeTrack);
    if (promotedBacklogCase) {
      const promoted = promoteBacklogCase(workingCases, promotedBacklogCase.id);
      workingCases = promoted.cases;
      await writeCases(casesPath, workingCases);
      planningSummaries.push(`Promoted backlog case ${promotedBacklogCase.id} to ready.`);
      return {
        selected: promoted.promoted,
        cases: workingCases,
        publishResult: {
          layer: "cases",
          source: "generated",
          generatedCount: 0,
          publishedCount: 0,
          firstReadyCaseId: promoted.promoted?.id ?? null,
          summary: planningSummaries.join(" "),
          outputPath: casesPath,
          generatedCases: [],
        },
      };
    }

    const unfinishedForMilestone = unfinishedCasesForMilestone(workingCases, activeMilestone.id);
    const nonRunnable = unfinishedForMilestone.filter((item) => ["in_progress", "review", "blocked"].includes(item.status));
    if (nonRunnable.length > 0) {
      return summaryResult(
        "cases",
        casesPath,
        `${planningSummaries.join(" ")} Active milestone ${activeMilestone.id} still has unfinished non-runnable cases: ${nonRunnable.map((item) => item.id).join(", ")}.`.trim(),
      );
    }

    if (unfinishedForMilestone.length === 0) {
      const milestoneEvaluation = await runMilestoneEvaluator(context, config, planning, workingCases, activeStrategy, milestones, activeMilestone);
      planningSummaries.push(describePlanningEvaluation(milestoneEvaluation));
      if (milestoneEvaluation.decision === "blocked") {
        milestones = updateMilestoneStatus(milestones, activeMilestone.id, "blocked");
        await writeMilestones(milestonesPath, milestones);
        return summaryResult("milestones", milestonesPath, `${planningSummaries.join(" ")} Milestone ${activeMilestone.id} is blocked.`.trim());
      }
      if (milestoneEvaluation.decision === "completed") {
        const advanced = activateNextMilestone(milestones, activeTrack, activeMilestone.id, activeStrategy.id);
        milestones = advanced.milestones;
        await writeMilestones(milestonesPath, milestones);
        planningSummaries.push(
          advanced.promotedMilestoneId
            ? `Completed ${activeMilestone.id} and promoted ${advanced.promotedMilestoneId}.`
            : `Completed ${activeMilestone.id}.`,
        );
        latestStrategyEvaluation = await runStrategyEvaluator(context, config, planning, workingCases, activeStrategy, milestones);
        planningSummaries.push(describePlanningEvaluation(latestStrategyEvaluation));
        if (latestStrategyEvaluation.decision === "blocked") {
          strategy = updateStrategyStatus(activeStrategy, "blocked");
          await writeStrategy(strategyPath, strategy);
          return summaryResult("strategy", strategyPath, `${planningSummaries.join(" ")} Strategy is blocked.`.trim());
        }
        if (latestStrategyEvaluation.decision === "completed" || latestStrategyEvaluation.decision === "superseded") {
          strategy = updateStrategyStatus(activeStrategy, latestStrategyEvaluation.decision);
          await writeStrategy(strategyPath, strategy);
          planningSummaries.push(`Marked strategy ${activeStrategy.id} as ${latestStrategyEvaluation.decision}.`);
        }
        continue;
      }
    }

    const publishResult = await runCasePlannerReplenishment(
      context,
      config,
      planning,
      workingCases,
      activeStrategy,
      milestones,
      activeMilestone,
    );
    planningSummaries.push(publishResult.summary);

    if (publishResult.generatedCases?.length) {
      workingCases = [...workingCases, ...publishResult.generatedCases.map((item) => normalizeCaseLinkage(item))];
    }

    if (publishResult.firstReadyCaseId) {
      const selectedGenerated = workingCases.find((item) => item.id === publishResult.firstReadyCaseId) ?? null;
      return {
        selected: selectedGenerated,
        cases: workingCases,
        publishResult: {
          ...publishResult,
          summary: planningSummaries.join(" "),
        },
      };
    }

    const milestoneEvaluation = await runMilestoneEvaluator(context, config, planning, workingCases, activeStrategy, milestones, activeMilestone);
    planningSummaries.push(describePlanningEvaluation(milestoneEvaluation));

    if (milestoneEvaluation.decision === "blocked") {
      milestones = updateMilestoneStatus(milestones, activeMilestone.id, "blocked");
      await writeMilestones(milestonesPath, milestones);
      return summaryResult("milestones", milestonesPath, `${planningSummaries.join(" ")} Milestone ${activeMilestone.id} is blocked.`.trim());
    }

    if (milestoneEvaluation.decision === "completed") {
      const advanced = activateNextMilestone(milestones, activeTrack, activeMilestone.id, activeStrategy.id);
      milestones = advanced.milestones;
      await writeMilestones(milestonesPath, milestones);
      planningSummaries.push(
        advanced.promotedMilestoneId
          ? `Completed ${activeMilestone.id} and promoted ${advanced.promotedMilestoneId}.`
          : `Completed ${activeMilestone.id}.`,
      );
      latestStrategyEvaluation = await runStrategyEvaluator(context, config, planning, workingCases, activeStrategy, milestones);
      planningSummaries.push(describePlanningEvaluation(latestStrategyEvaluation));
      if (latestStrategyEvaluation.decision === "blocked") {
        strategy = updateStrategyStatus(activeStrategy, "blocked");
        await writeStrategy(strategyPath, strategy);
        return summaryResult("strategy", strategyPath, `${planningSummaries.join(" ")} Strategy is blocked.`.trim());
      }
      if (latestStrategyEvaluation.decision === "completed" || latestStrategyEvaluation.decision === "superseded") {
        strategy = updateStrategyStatus(activeStrategy, latestStrategyEvaluation.decision);
        await writeStrategy(strategyPath, strategy);
        planningSummaries.push(`Marked strategy ${activeStrategy.id} as ${latestStrategyEvaluation.decision}.`);
      }
      continue;
    }

    const remainingUnfinished = unfinishedCasesForMilestone(workingCases, activeMilestone.id);
    if (remainingUnfinished.length > 0) {
      return summaryResult(
        "cases",
        casesPath,
        `${planningSummaries.join(" ")} Active milestone ${activeMilestone.id} still has unfinished cases but none are ready.`.trim(),
      );
    }

    return summaryResult(
      "cases",
      casesPath,
      `${planningSummaries.join(" ")} Planner found no next work for active milestone ${activeMilestone.id}.`.trim(),
    );
  }

  const noWorkResult: ExternalPlannerPublishResult = {
    layer: "cases",
    source: "generated",
    generatedCount: 0,
    publishedCount: 0,
    firstReadyCaseId: null,
    summary: planningSummaries.length > 0
      ? `${planningSummaries.join(" ")} Planner found no next work for ${context.target.id}.`
      : `Planner found no next work for ${context.target.id}.`,
    outputPath: casesPathForConfig(context, config),
  };
  await context.artifactStore.writeJson("planner/publish-result.json", noWorkResult);

  if (!noWorkResult?.firstReadyCaseId) {
    return {
      selected: null,
      cases: workingCases,
      publishResult: noWorkResult,
    };
  }

  return {
    selected: null,
    cases: workingCases,
    publishResult: noWorkResult,
  };
}

export function createExternalTargetAdapter(manifest: ProjectAdapterManifest): HarnessTarget {
  return {
    manifest,
    async peekReadyWork(context: HarnessContext) {
      const config = await loadExternalTargetConfig(context);
      const { selected, publishResult } = await ensureReadyCase(context, config);
      if (!selected) {
        return null;
      }
      return {
        id: selected.id,
        title: selected.title,
        source: publishResult?.publishedCount ? "generated" : "existing",
        generatedCount: publishResult?.publishedCount ?? undefined,
        generationSummary: publishResult?.summary ?? null,
      } satisfies HarnessReadyWorkItem;
    },
    async plan(context: HarnessContext) {
      const config = await loadExternalTargetConfig(context);
      const { selected, publishResult } = await ensureReadyCase(context, config);

      if (!selected) {
        throw new NoReadyWorkError(publishResult?.summary ?? `No ready case is available for target "${context.target.id}".`);
      }

      return createContract(manifest, config, selected);
    },
    async execute(context: HarnessContext & { contract: SprintContract; threadId: string | null; resume: boolean }) {
      const config = await loadExternalTargetConfig(context);
      const prompt = promptForContract(config, context.contract, context.resume);
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
        sandboxMode: config.execution.sandboxMode,
        model: context.runSpec.model ?? config.execution.model,
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
        turnCompleted: result.turnCompleted,
        terminalEventType: result.terminalEventType,
        terminalEventAt: result.terminalEventAt,
        finalizationState: "partial",
      };

      return execution;
    },
    async evaluate(context: HarnessContext & { contract: SprintContract; execution: ExecutionResult }) {
      const config = await loadExternalTargetConfig(context);
      const commands = config.evaluation.commands.map((item) => ({ label: item.label || item.id, command: item.command }));
      const startedAt = nowIso();
      const evidence = await runEvaluationCommands(context.targetRepoRoot, commands, context.artifactStore.runDir);
      const failed = evidence.find((item) => !item.passed) ?? null;

      const result: EvaluationResult = {
        passed: !failed,
        retryable: failed ? failed.retryable : false,
        blocking: failed ? failed.blocking : false,
        failureClass: failed ? failed.failureClass : null,
        failureScope: failed ? failed.failureScope : null,
        failureReason: failed ? `${failed.label} failed: ${failed.normalizedSummary}` : null,
        normalizedSummary: failed ? failed.normalizedSummary : null,
        findings: failed
          ? [
              `${failed.label} failed with exit code ${failed.returnCode ?? "unknown"}.`,
              failed.normalizedSummary,
              ...(failed.matchedRuleId ? [`classification=${failed.matchedRuleId}`] : []),
            ]
          : [],
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
      const completion = await markCaseStatus(context, context.contract, "verified");
      if (!completion) {
        return null;
      }

      const config = await loadExternalTargetConfig(context);
      const planning = normalizePlanningConfig(config);
      if (!planning.enabled) {
        return completion;
      }

      const cases = await loadCases(context, config);
      const strategy = await loadStrategy(context, config, planning);
      const activeTrack = activeTrackForConfig(config);
      const activeStrategy = selectActiveStrategy(strategy, activeTrack);
      if (!activeStrategy) {
        return completion;
      }

      const currentCase = cases.find((item) => item.id === context.contract.caseId) ?? null;
      const milestoneId = currentCase ? caseMilestoneId(currentCase) : null;
      if (!milestoneId) {
        return completion;
      }

      let milestones = await loadMilestones(context, config, planning);
      const milestone = milestones.find((item) => item.id === milestoneId) ?? null;
      if (!milestone || milestone.status !== "active") {
        return completion;
      }

      const strategyPath = strategyPathForConfig(context, config, planning);
      const milestonesPath = milestonesPathForConfig(context, config, planning);
      const summaries = [completion.summary];
      const milestoneEvaluation = await runMilestoneEvaluator(context, config, planning, cases, activeStrategy, milestones, milestone);
      summaries.push(describePlanningEvaluation(milestoneEvaluation));

      if (milestoneEvaluation.decision === "blocked") {
        milestones = updateMilestoneStatus(milestones, milestone.id, "blocked");
        await writeMilestones(milestonesPath, milestones);
        summaries.push(`Marked milestone ${milestone.id} as blocked.`);
      } else if (milestoneEvaluation.decision === "completed") {
        const advanced = activateNextMilestone(milestones, activeTrack, milestone.id, activeStrategy.id);
        milestones = advanced.milestones;
        await writeMilestones(milestonesPath, milestones);
        summaries.push(
          advanced.promotedMilestoneId
            ? `Completed ${milestone.id} and promoted ${advanced.promotedMilestoneId}.`
            : `Completed ${milestone.id}.`,
        );
        const strategyEvaluation = await runStrategyEvaluator(context, config, planning, cases, activeStrategy, milestones);
        summaries.push(describePlanningEvaluation(strategyEvaluation));
        if (strategyEvaluation.decision === "blocked") {
          await writeStrategy(strategyPath, updateStrategyStatus(activeStrategy, "blocked"));
          summaries.push(`Marked strategy ${activeStrategy.id} as blocked.`);
        } else if (strategyEvaluation.decision === "completed" || strategyEvaluation.decision === "superseded") {
          await writeStrategy(strategyPath, updateStrategyStatus(activeStrategy, strategyEvaluation.decision));
          summaries.push(`Marked strategy ${activeStrategy.id} as ${strategyEvaluation.decision}.`);
        }
      }

      return {
        ...completion,
        summary: summaries.join(" "),
      };
    },
    async doctor(context: HarnessContext) {
      const config = await loadExternalTargetConfig(context);
      const checks: DoctorCheck[] = [
        {
          label: "target-repo",
          passed: existsSync(context.targetRepoRoot),
          detail: context.targetRepoRoot,
        },
      ];

      const gitResult = existsSync(context.targetRepoRoot)
        ? await runShellCommand("git rev-parse --is-inside-work-tree", context.targetRepoRoot)
        : null;
      checks.push({
        label: "git-repo",
        passed: gitResult?.exitCode === 0,
        detail: gitResult?.exitCode === 0 ? "available" : (gitResult?.stderr || gitResult?.stdout || "missing git repository").trim(),
      });

      for (const relativePath of config.doctor.requiredFiles) {
        checks.push({
          label: `required-file:${relativePath}`,
          passed: existsSync(path.join(context.targetRepoRoot, relativePath)),
          detail: relativePath,
        });
      }

      for (const command of config.doctor.requiredCommands) {
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
