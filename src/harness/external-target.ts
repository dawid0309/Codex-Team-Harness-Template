import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCodex } from "./codex";
import { NoReadyWorkError } from "./errors";
import { runShellCommand } from "./process";
import { nowIso } from "./time";
import type {
  DoctorCheck,
  EvaluationEvidence,
  EvaluationResult,
  ExecutionResult,
  ExternalPlannerContextPacket,
  ExternalPlannerDraftCase,
  ExternalPlannerPublishResult,
  ExternalTargetCase,
  ExternalTargetConfig,
  HarnessCompletionUpdate,
  HarnessContext,
  HarnessReadyWorkItem,
  HarnessTarget,
  ProjectAdapterManifest,
  SprintContract,
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
  return JSON.parse(await readFile(casesPathForConfig(context, config), "utf8")) as ExternalTargetCase[];
}

function casesPathForConfig(context: HarnessContext, config: ExternalTargetConfig) {
  return resolveConfigRelativePath(context.target.adapterConfigPath, config.casesPath);
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
  await writeFile(casesPath, `${JSON.stringify(cases, null, 2)}\n`, "utf8");
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
  const base = resume ? config.execution.resumePrompt : config.execution.basePrompt;
  return [
    base,
    "",
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
    return {
      path: relativePath.replaceAll("\\", "/"),
      content: truncateText(await readFile(absolutePath, "utf8")),
    };
  }

  if (!stats.isDirectory()) {
    return null;
  }

  const listing = (await collectDirectoryListing(absolutePath)).slice(0, DIRECTORY_LISTING_LIMIT);
  return {
    path: relativePath.replaceAll("\\", "/"),
    content: truncateText(`Directory listing:\n${listing.join("\n")}`),
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

async function buildPlannerContext(
  context: HarnessContext,
  config: ExternalTargetConfig,
  cases: ExternalTargetCase[],
): Promise<ExternalPlannerContextPacket> {
  const recentRuns = await loadRecentRunSummaries(context, config.planning?.maxRecentHandoffs ?? 5);
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

  return {
    targetId: context.target.id,
    targetLabel: config.label,
    targetRepoRoot: context.targetRepoRoot,
    generatedAt: nowIso(),
    currentCases: cases,
    recentRuns,
    gitStatus: (gitStatus.stdout || gitStatus.stderr).trim(),
    entrySnapshots,
    latestVerifiedCase: latestVerifiedCase
      ? {
          id: latestVerifiedCase.id,
          title: latestVerifiedCase.title,
          goal: latestVerifiedCase.goal,
          summary: latestVerifiedRun?.summary ?? null,
          metadata: latestVerifiedCase.metadata ?? {},
        }
      : null,
    latestVerifiedInputSnapshots,
  };
}

function plannerPaths(context: HarnessContext) {
  const plannerDir = context.artifactStore.resolve("planner");
  const workspaceDir = path.join(context.artifactStore.runDir, "planner-workspace");
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

function buildPlannerPrompt(config: ExternalTargetConfig) {
  const batchSize = config.planning?.batchSize ?? 3;
  return [
    config.planning?.basePrompt ?? `Plan the next development cases for ${config.label}.`,
    "",
    "You are operating as an external harness planner.",
    "Read the file `context.json` in the current working directory before deciding anything.",
    `Generate exactly up to ${batchSize} next cases for the target repository.`,
    "",
    "Rules:",
    "- Propose only the next most valuable product work after the currently verified work.",
    "- Do not repeat any verified or existing backlog item.",
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

function createGeneratedCases(
  drafts: ExternalPlannerDraftCase[],
  cases: ExternalTargetCase[],
  config: ExternalTargetConfig,
  runId: string,
) {
  const prefix = deriveCasePrefix(cases, config);
  let nextNumber = nextCaseNumber(cases);

  return drafts.map((draft, index) => ({
    id: `${prefix}-${String(nextNumber++).padStart(3, "0")}`,
    title: draft.title,
    status: index === 0
      ? config.planning?.firstGeneratedStatus ?? "ready"
      : config.planning?.remainingGeneratedStatus ?? "backlog",
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
    nextConsumer: draft.nextConsumer ?? "poword-maintainer",
    metadata: {
      ...draft.metadata,
      generatedByPlanner: true,
      plannerRunId: runId,
      generatedAt: nowIso(),
      generationMode: "auto-replenishment",
    },
  } satisfies ExternalTargetCase));
}

async function runPlannerReplenishment(
  context: HarnessContext,
  config: ExternalTargetConfig,
  cases: ExternalTargetCase[],
): Promise<ExternalPlannerPublishResult | null> {
  if (!config.planning?.enabled) {
    return null;
  }

  const paths = plannerPaths(context);
  await mkdir(paths.plannerDir, { recursive: true });
  await mkdir(paths.workspaceDir, { recursive: true });

  const contextPacket = await buildPlannerContext(context, config, cases);
  const prompt = buildPlannerPrompt(config);

  await context.artifactStore.writeJson("planner/context.json", contextPacket);
  await writeFile(paths.workspaceContext, `${JSON.stringify(contextPacket, null, 2)}\n`, "utf8");
  await context.artifactStore.writeText("planner/prompt.md", prompt);

  const plannerResult = await runCodex({
    repoRoot: paths.workspaceDir,
    prompt,
    promptFile: paths.promptArtifact,
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
    lastMessageFile: paths.outputRawArtifact,
    sandboxMode: config.execution.sandboxMode,
    model: config.planning.model ?? context.runSpec.model ?? config.execution.model,
    threadId: null,
  });

  const rawOutput = plannerResult.lastMessage ?? (await readTextIfExists(paths.outputRawArtifact)) ?? "";
  if (plannerResult.failureReason || plannerResult.exitCode !== 0) {
    throw new Error(plannerResult.failureReason ?? `Planner run failed with exit code ${plannerResult.exitCode}.`);
  }

  const parsed = extractJsonArray(rawOutput);
  if (!parsed) {
    throw new Error("Planner output did not contain a valid JSON array.");
  }

  const normalizedDrafts = parsed
    .map((item) => normalizePlannerDraftCase(item, config))
    .filter((item): item is ExternalPlannerDraftCase => !!item)
    .slice(0, config.planning.batchSize);

  const generatedCases = createGeneratedCases(normalizedDrafts, cases, config, context.runSpec.runId);
  await context.artifactStore.writeJson("planner/generated-cases.json", generatedCases);

  const casesPath = casesPathForConfig(context, config);
  if (generatedCases.length === 0) {
    const emptyResult: ExternalPlannerPublishResult = {
      source: "generated",
      generatedCount: 0,
      publishedCount: 0,
      firstReadyCaseId: null,
      summary: `Planner found no next work for ${context.target.id}.`,
      casesPath,
      generatedCases: [],
    };
    await context.artifactStore.writeJson("planner/publish-result.json", emptyResult);
    return emptyResult;
  }

  const updatedCases = [...cases, ...generatedCases];
  await writeCases(casesPath, updatedCases);
  const publishResult: ExternalPlannerPublishResult = {
    source: "generated",
    generatedCount: generatedCases.length,
    publishedCount: generatedCases.length,
    firstReadyCaseId: generatedCases.find((item) => item.status === "ready")?.id ?? null,
    summary: `Planner generated ${generatedCases.length} cases. Continuing with ${generatedCases[0]?.id ?? "the next ready case"}.`,
    casesPath,
    generatedCases,
  };
  await context.artifactStore.writeJson("planner/publish-result.json", publishResult);
  return publishResult;
}

async function ensureReadyCase(context: HarnessContext, config: ExternalTargetConfig) {
  const cases = await loadCases(context, config);
  const selected = selectReadyCase(cases, context.selectedTaskId);
  if (selected) {
    return {
      selected,
      cases,
      publishResult: null as ExternalPlannerPublishResult | null,
    };
  }

  if (context.selectedTaskId || !config.planning?.enabled) {
    return {
      selected: null,
      cases,
      publishResult: null as ExternalPlannerPublishResult | null,
    };
  }

  const publishResult = await runPlannerReplenishment(context, config, cases);
  if (!publishResult?.firstReadyCaseId) {
    return {
      selected: null,
      cases,
      publishResult,
    };
  }

  const selectedGenerated = publishResult.generatedCases.find((item) => item.id === publishResult.firstReadyCaseId) ?? null;
  return {
    selected: selectedGenerated,
    cases: [...cases, ...publishResult.generatedCases],
    publishResult,
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
      return markCaseStatus(context, context.contract, "verified");
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
