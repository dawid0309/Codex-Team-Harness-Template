import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  LangfuseOtelSpanAttributes,
  type LangfuseSpan,
  startObservation,
} from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";

import { nowIso } from "./time";
import type {
  EvaluationResult,
  HarnessArtifactStore,
  HarnessPhase,
  HarnessRunEvent,
  HarnessRunSpec,
  SprintContract,
} from "./types";

const EXPORT_VERSION = 1;
const MAX_TEXT_LENGTH = 700;
const PHASES: HarnessPhase[] = ["plan", "execute", "evaluate", "handoff"];

type LangfuseConfig = {
  enabled: boolean;
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  environment: string;
};

type ExportMarker = {
  version: number;
  mode: "live" | "historical";
  runId: string;
  traceId: string;
  rootObservationId: string;
  traceUrl: string | null;
  startedAt: string;
  completedAt: string | null;
  exportedAt: string;
};

type ExportRunOptions = {
  controlRepoRoot: string;
  runDir: string;
  force?: boolean;
  mode?: "historical" | "live";
};

type ExportRunResult = {
  skipped: boolean;
  runId: string | null;
  traceId: string | null;
  traceUrl: string | null;
  markerPath: string | null;
};

let sdk: NodeSDK | null = null;
let client: LangfuseClient | null = null;
let initialized = false;
let initFailed = false;

function parseEnv(content: string) {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex < 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim().replace(/^["']|["']$/g, "");
    parsed[key] = value;
  }
  return parsed;
}

function loadLocalLangfuseEnv(controlRepoRoot: string) {
  const envPath = path.join(controlRepoRoot, "observability", "langfuse", ".env");
  if (!existsSync(envPath)) {
    return {};
  }
  return parseEnv(readFileSync(envPath, "utf8"));
}

function langfuseConfig(controlRepoRoot: string): LangfuseConfig | null {
  const local = loadLocalLangfuseEnv(controlRepoRoot);
  const value = (name: string) => process.env[name] ?? local[name] ?? "";
  const enabled = value("HARNESS_LANGFUSE_ENABLED").toLowerCase() === "true";
  const baseUrl = value("LANGFUSE_BASE_URL") || "http://localhost:3000";
  const publicKey = value("LANGFUSE_PUBLIC_KEY");
  const secretKey = value("LANGFUSE_SECRET_KEY");
  const environment = value("LANGFUSE_TRACING_ENVIRONMENT") || "local";

  if (!enabled || !publicKey || !secretKey) {
    return null;
  }
  return { enabled, baseUrl, publicKey, secretKey, environment };
}

function ensureLangfuse(controlRepoRoot: string) {
  if (initFailed) {
    return null;
  }
  const config = langfuseConfig(controlRepoRoot);
  if (!config) {
    return null;
  }
  if (!initialized) {
    try {
      sdk = new NodeSDK({
        spanProcessors: [
          new LangfuseSpanProcessor({
            publicKey: config.publicKey,
            secretKey: config.secretKey,
            baseUrl: config.baseUrl,
            environment: config.environment,
            exportMode: "immediate",
            shouldExportSpan: () => true,
          }),
        ],
      });
      sdk.start();
      client = new LangfuseClient({
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
      });
      initialized = true;
    } catch (error) {
      initFailed = true;
      console.warn(`[Langfuse] Observability disabled: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
  return { config, client: client as LangfuseClient };
}

function truncateText(value: string | null | undefined, max = MAX_TEXT_LENGTH) {
  if (!value) {
    return null;
  }
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) {
    return collapsed;
  }
  return `${collapsed.slice(0, max - 3)}...`;
}

function safeDate(value: string | null | undefined) {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function markerPath(runDir: string) {
  return path.join(runDir, "langfuse-export.json");
}

function runRelativePath(spec: HarnessRunSpec, absoluteOrRelative: string | null | undefined) {
  if (!absoluteOrRelative) {
    return null;
  }
  const absolute = path.isAbsolute(absoluteOrRelative)
    ? absoluteOrRelative
    : path.join(spec.controlRepoRoot, absoluteOrRelative);
  return path.relative(spec.controlRepoRoot, absolute).replaceAll("\\", "/");
}

function eventLevel(event: HarnessRunEvent) {
  if (event.status === "failed") {
    return "ERROR" as const;
  }
  if (event.status === "interrupted") {
    return "WARNING" as const;
  }
  return "DEFAULT" as const;
}

function rawItem(event: HarnessRunEvent) {
  const item = event.raw.item;
  return item && typeof item === "object" && !Array.isArray(item)
    ? item as Record<string, unknown>
    : {};
}

function eventInput(event: HarnessRunEvent) {
  const item = rawItem(event);
  if (event.kind === "command_execution") {
    return typeof item.command === "string" ? { command: truncateText(item.command, 500) } : undefined;
  }
  if (event.kind === "file_change") {
    return { files: event.summary ? event.summary.split(",").map((item) => item.trim()).filter(Boolean) : [] };
  }
  if (event.kind === "agent_message") {
    return { message: truncateText(event.summary, 500) };
  }
  return undefined;
}

function eventOutput(event: HarnessRunEvent) {
  if (event.kind === "command_execution") {
    return {
      status: event.status,
      summary: truncateText(event.summary, 500),
    };
  }
  return event.summary ? { summary: truncateText(event.summary, 500) } : undefined;
}

function eventMetadata(event: HarnessRunEvent) {
  const item = rawItem(event);
  const changes = Array.isArray(item.changes)
    ? item.changes
        .map((change) => change && typeof change === "object" ? (change as Record<string, unknown>).path : null)
        .filter((value): value is string => typeof value === "string")
    : [];
  return {
    eventId: event.id,
    itemId: event.itemId,
    parentItemId: event.parentItemId,
    kind: event.kind,
    phase: event.phase,
    lane: event.lane,
    status: event.status,
    filePaths: changes,
    command: typeof item.command === "string" ? truncateText(item.command, 500) : null,
  };
}

function traceMetadata(spec: HarnessRunSpec, contract: SprintContract | null) {
  return {
    targetId: spec.targetId,
    adapterId: spec.adapterId,
    runId: spec.runId,
    caseId: contract?.caseId ?? null,
    title: contract?.title ?? null,
    taskId: spec.taskId,
    model: spec.model,
    targetRepoRoot: spec.targetRepoRoot,
    artifactRoot: spec.artifactRoot,
    runArtifacts: runRelativePath(spec, path.join(spec.controlRepoRoot, spec.artifactRoot, "runs", spec.runId)),
  };
}

function setTraceAttributes(root: LangfuseSpan, spec: HarnessRunSpec, contract: SprintContract | null) {
  root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_NAME, `Harness ${spec.targetId} ${contract?.caseId ?? spec.runId}`);
  root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, spec.runId);
  root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, JSON.stringify(["harness", spec.targetId, spec.adapterId]));
  root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_METADATA, JSON.stringify(traceMetadata(spec, contract)));
}

async function upsertTraceSummary(
  langfuseClient: LangfuseClient,
  spec: HarnessRunSpec,
  traceId: string,
  contract: SprintContract | null,
  fields: {
    timestamp?: Date;
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
  } = {},
) {
  await langfuseClient.api.ingestion.batch({
    batch: [
      {
        id: `harness-trace-${traceId}-${Date.now()}`,
        type: "trace-create",
        timestamp: nowIso(),
        body: {
          id: traceId,
          timestamp: fields.timestamp?.toISOString(),
          name: `Harness ${spec.targetId} ${contract?.caseId ?? spec.runId}`,
          sessionId: spec.runId,
          metadata: {
            ...traceMetadata(spec, contract),
            ...fields.metadata,
          },
          tags: ["harness", spec.targetId, spec.adapterId],
          input: fields.input,
          output: fields.output,
          environment: langfuseConfig(spec.controlRepoRoot)?.environment ?? "local",
        },
      },
    ],
  });
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

async function readEvents(runDir: string) {
  const filePath = path.join(runDir, "events.jsonl");
  if (!existsSync(filePath)) {
    return [] as HarnessRunEvent[];
  }
  const content = await readFile(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HarnessRunEvent);
}

async function readRunTraceSummary(controlRepoRoot: string, runDir: string) {
  const spec = await readJsonIfExists<HarnessRunSpec>(path.join(runDir, "run-spec.json"));
  if (!spec) {
    return null;
  }
  const [
    contract,
    executionPrimary,
    executionResume,
    evaluationPrimary,
    evaluationResume,
    checkpoint,
    handoff,
    events,
  ] = await Promise.all([
    readJsonIfExists<SprintContract>(path.join(runDir, "contract.json")),
    readJsonIfExists<{ lastMessage?: string | null; threadId?: string | null }>(path.join(runDir, "execution.json")),
    readJsonIfExists<{ lastMessage?: string | null; threadId?: string | null }>(path.join(runDir, "execution.resume.json")),
    readJsonIfExists<EvaluationResult>(path.join(runDir, "evaluation.json")),
    readJsonIfExists<EvaluationResult>(path.join(runDir, "evaluation.resume.json")),
    readJsonIfExists<{ summary?: string | null; updatedAt?: string | null }>(path.join(runDir, "checkpoint.json")),
    readTextIfExists(path.join(runDir, "handoff.md"))
      .then((value) => value ?? readTextIfExists(path.join(runDir, "handoff.resume.md"))),
    readEvents(runDir),
  ]);
  const execution = executionPrimary ?? executionResume;
  const evaluation = evaluationPrimary ?? evaluationResume;
  const startedAt = safeDate(events[0]?.ts ?? contract?.createdAt) ?? new Date();
  return {
    spec,
    contract,
    startedAt,
    input: contract ? {
      caseId: contract.caseId,
      title: contract.title,
      goal: contract.goal,
      acceptanceChecks: contract.acceptanceChecks,
    } : undefined,
    output: {
      summary: truncateText(handoff ?? execution?.lastMessage ?? checkpoint?.summary ?? null, 1200),
      evaluationPassed: evaluation?.passed ?? null,
    },
    metadata: {
      threadId: execution?.threadId ?? null,
      contractFile: "contract.json",
      runBoardFile: "run-board.json",
      handoffFile: existsSync(path.join(runDir, "handoff.md")) ? "handoff.md" : null,
      refreshedFromMarker: true,
      controlRepoRoot,
    },
  };
}

async function writeMarker(runDir: string, marker: ExportMarker) {
  await writeFile(markerPath(runDir), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

async function updateMarker(runDir: string, update: Partial<ExportMarker>) {
  const current = await readJsonIfExists<ExportMarker>(markerPath(runDir));
  if (!current) {
    return;
  }
  await writeMarker(runDir, { ...current, ...update, exportedAt: nowIso() });
}

async function writeLiveMarker(spec: HarnessRunSpec, root: LangfuseSpan, traceUrl: string | null) {
  const runDir = path.join(spec.controlRepoRoot, spec.artifactRoot, "runs", spec.runId);
  await mkdir(runDir, { recursive: true });
  await writeMarker(runDir, {
    version: EXPORT_VERSION,
    mode: "live",
    runId: spec.runId,
    traceId: root.traceId,
    rootObservationId: root.id,
    traceUrl,
    startedAt: nowIso(),
    completedAt: null,
    exportedAt: nowIso(),
  });
}

async function scoreEvaluation(controlRepoRoot: string, runDir: string, traceId: string, evaluation: EvaluationResult) {
  const langfuse = ensureLangfuse(controlRepoRoot);
  if (!langfuse) {
    return;
  }
  langfuse.client.score.create({
    traceId,
    name: "evaluation_passed",
    value: evaluation.passed ? 1 : 0,
    comment: evaluation.failureReason ?? undefined,
    dataType: "BOOLEAN",
    metadata: {
      retryable: evaluation.retryable,
      elapsedSeconds: evaluation.elapsedSeconds,
      findings: evaluation.findings,
    },
  });
  for (const evidence of evaluation.evidence) {
    langfuse.client.score.create({
      traceId,
      name: `eval:${evidence.label}`,
      value: evidence.passed ? 1 : 0,
      comment: evidence.passed ? "passed" : `failed with exit code ${evidence.returnCode ?? "unknown"}`,
      dataType: "BOOLEAN",
      metadata: {
        command: truncateText(evidence.command, 500),
        elapsedSeconds: evidence.elapsedSeconds,
        stdoutLog: runRelativePath({
          targetId: "",
          adapterId: "",
          artifactRoot: "",
          manifestPath: "",
          targetRegistryPath: "",
          controlRepoRoot,
          targetRepoRoot: "",
          runId: "",
          model: null,
          taskId: null,
        }, evidence.stdoutLog),
        stderrLog: runRelativePath({
          targetId: "",
          adapterId: "",
          artifactRoot: "",
          manifestPath: "",
          targetRegistryPath: "",
          controlRepoRoot,
          targetRepoRoot: "",
          runId: "",
          model: null,
          taskId: null,
        }, evidence.stderrLog),
      },
    });
  }
  await langfuse.client.flush();
  await updateMarker(runDir, { exportedAt: nowIso() });
}

export async function scoreHarnessEvaluation(spec: HarnessRunSpec, store: HarnessArtifactStore, evaluation: EvaluationResult) {
  const marker = await readJsonIfExists<ExportMarker>(store.resolve("langfuse-export.json"));
  if (!marker?.traceId) {
    return;
  }
  try {
    await scoreEvaluation(spec.controlRepoRoot, store.runDir, marker.traceId, evaluation);
  } catch (error) {
    console.warn(`[Langfuse] Failed to score run ${spec.runId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class LangfuseLiveRunObserver {
  private root: LangfuseSpan | null = null;
  private phases = new Map<HarnessPhase, LangfuseSpan>();
  private traceUrl: string | null = null;

  constructor(private readonly spec: HarnessRunSpec) {}

  get enabled() {
    return !!langfuseConfig(this.spec.controlRepoRoot);
  }

  async initialize() {
    const langfuse = ensureLangfuse(this.spec.controlRepoRoot);
    if (!langfuse) {
      return;
    }
    this.root = startObservation(`harness:${this.spec.targetId}:${this.spec.runId}`, {
      metadata: traceMetadata(this.spec, null),
      level: "DEFAULT",
    });
    setTraceAttributes(this.root, this.spec, null);
    await upsertTraceSummary(langfuse.client, this.spec, this.root.traceId, null);
    this.traceUrl = await langfuse.client.getTraceUrl(this.root.traceId).catch(() => null);
    await writeLiveMarker(this.spec, this.root, this.traceUrl);
  }

  async recordLifecycle(event: HarnessRunEvent) {
    if (!this.root) {
      return;
    }
    const existing = this.phases.get(event.phase);
    if (event.status === "running" && !existing) {
      const phase = this.root.startObservation(`phase:${event.phase}`, {
        input: { phase: event.phase, title: event.title },
        metadata: eventMetadata(event),
        level: eventLevel(event),
        statusMessage: event.summary ?? undefined,
      }, { asType: "span" });
      this.phases.set(event.phase, phase);
      return;
    }

    const phase = existing ?? this.root.startObservation(`phase:${event.phase}`, {
      input: { phase: event.phase, title: event.title },
      metadata: eventMetadata(event),
      level: eventLevel(event),
      statusMessage: event.summary ?? undefined,
    }, { asType: "span" });
    phase.update({
      output: { status: event.status, summary: truncateText(event.summary) },
      level: eventLevel(event),
      statusMessage: event.summary ?? undefined,
    });
    if (event.status === "completed" || event.status === "failed" || event.status === "interrupted") {
      phase.end(safeDate(event.ts));
    }
    this.phases.set(event.phase, phase);

    if (
      event.status === "failed"
      || event.status === "interrupted"
      || (event.phase === "handoff" && event.status === "completed")
    ) {
      await this.finish(event);
    }
  }

  async recordEvent(event: HarnessRunEvent) {
    if (!this.root) {
      return;
    }
    const parent = this.phases.get(event.phase) ?? this.root;
    const attributes = {
      input: eventInput(event),
      output: eventOutput(event),
      metadata: eventMetadata(event),
      level: eventLevel(event),
      statusMessage: event.summary ?? undefined,
    };
    const child = event.kind === "command_execution"
      ? parent.startObservation(event.title, attributes, { asType: "tool" })
      : parent.startObservation(event.title, attributes, { asType: "event" });
    child.end(safeDate(event.ts));
  }

  async updateContract(contract: SprintContract) {
    if (!this.root) {
      return;
    }
    this.root.update({
      metadata: traceMetadata(this.spec, contract),
      input: {
        caseId: contract.caseId,
        title: contract.title,
        goal: contract.goal,
        acceptanceChecks: contract.acceptanceChecks,
      },
    });
    setTraceAttributes(this.root, this.spec, contract);
    const langfuse = ensureLangfuse(this.spec.controlRepoRoot);
    if (langfuse) {
      await upsertTraceSummary(langfuse.client, this.spec, this.root.traceId, contract, {
        input: {
          caseId: contract.caseId,
          title: contract.title,
          goal: contract.goal,
          acceptanceChecks: contract.acceptanceChecks,
        },
      });
    }
  }

  async finish(event?: HarnessRunEvent) {
    if (!this.root) {
      return;
    }
    for (const phase of this.phases.values()) {
      phase.end();
    }
    this.root.update({
      output: event ? { status: event.status, summary: truncateText(event.summary) } : undefined,
      level: event ? eventLevel(event) : "DEFAULT",
      statusMessage: event?.summary ?? undefined,
    });
    const langfuse = ensureLangfuse(this.spec.controlRepoRoot);
    if (langfuse) {
      await upsertTraceSummary(langfuse.client, this.spec, this.root.traceId, null, {
        output: event ? { status: event.status, summary: truncateText(event.summary) } : undefined,
      });
    }
    this.root.end(event ? safeDate(event.ts) : undefined);
    await updateMarker(path.join(this.spec.controlRepoRoot, this.spec.artifactRoot, "runs", this.spec.runId), {
      completedAt: nowIso(),
      traceId: this.root.traceId,
      rootObservationId: this.root.id,
      traceUrl: this.traceUrl,
    });
  }
}

export function createLangfuseLiveRunObserver(spec: HarnessRunSpec) {
  return new LangfuseLiveRunObserver(spec);
}

export async function exportHarnessRunToLangfuse(options: ExportRunOptions): Promise<ExportRunResult> {
  const langfuse = ensureLangfuse(options.controlRepoRoot);
  if (!langfuse) {
    return { skipped: true, runId: null, traceId: null, traceUrl: null, markerPath: null };
  }
  const marker = await readJsonIfExists<ExportMarker>(markerPath(options.runDir));
  if (marker?.completedAt && !options.force) {
    const summary = await readRunTraceSummary(options.controlRepoRoot, options.runDir);
    if (summary) {
      await upsertTraceSummary(langfuse.client, summary.spec, marker.traceId, summary.contract, {
        timestamp: summary.startedAt,
        input: summary.input,
        output: summary.output,
        metadata: summary.metadata,
      });
    }
    return {
      skipped: true,
      runId: marker.runId,
      traceId: marker.traceId,
      traceUrl: marker.traceUrl,
      markerPath: markerPath(options.runDir),
    };
  }

  const spec = await readJsonIfExists<HarnessRunSpec>(path.join(options.runDir, "run-spec.json"));
  if (!spec) {
    return { skipped: true, runId: null, traceId: null, traceUrl: null, markerPath: null };
  }
  const [
    contract,
    executionPrimary,
    executionResume,
    evaluationPrimary,
    evaluationResume,
    checkpoint,
    handoff,
    events,
  ] = await Promise.all([
    readJsonIfExists<SprintContract>(path.join(options.runDir, "contract.json")),
    readJsonIfExists<{ lastMessage?: string | null; threadId?: string | null }>(path.join(options.runDir, "execution.json")),
    readJsonIfExists<{ lastMessage?: string | null; threadId?: string | null }>(path.join(options.runDir, "execution.resume.json")),
    readJsonIfExists<EvaluationResult>(path.join(options.runDir, "evaluation.json")),
    readJsonIfExists<EvaluationResult>(path.join(options.runDir, "evaluation.resume.json")),
    readJsonIfExists<{ summary?: string | null; updatedAt?: string | null }>(path.join(options.runDir, "checkpoint.json")),
    readTextIfExists(path.join(options.runDir, "handoff.md"))
      .then((value) => value ?? readTextIfExists(path.join(options.runDir, "handoff.resume.md"))),
    readEvents(options.runDir),
  ]);
  const execution = executionPrimary ?? executionResume;
  const evaluation = evaluationPrimary ?? evaluationResume;

  const startedAt = safeDate(events[0]?.ts ?? contract?.createdAt) ?? new Date();
  const finishedAt = safeDate(events[events.length - 1]?.ts ?? checkpoint?.updatedAt) ?? new Date();
  const root = startObservation(`harness:${spec.targetId}:${contract?.caseId ?? spec.runId}`, {
    input: contract ? {
      caseId: contract.caseId,
      title: contract.title,
      goal: contract.goal,
      acceptanceChecks: contract.acceptanceChecks,
    } : undefined,
    output: {
      summary: truncateText(handoff ?? execution?.lastMessage ?? checkpoint?.summary ?? null, 1200),
      evaluationPassed: evaluation?.passed ?? null,
    },
    metadata: {
      ...traceMetadata(spec, contract),
      threadId: execution?.threadId ?? null,
      contractFile: "contract.json",
      runBoardFile: "run-board.json",
      handoffFile: existsSync(path.join(options.runDir, "handoff.md")) ? "handoff.md" : null,
    },
    level: evaluation?.passed === false ? "ERROR" : "DEFAULT",
    statusMessage: evaluation?.failureReason ?? checkpoint?.summary ?? undefined,
  }, { startTime: startedAt });
  setTraceAttributes(root, spec, contract);
  await upsertTraceSummary(langfuse.client, spec, root.traceId, contract, {
    timestamp: startedAt,
    input: contract ? {
      caseId: contract.caseId,
      title: contract.title,
      goal: contract.goal,
      acceptanceChecks: contract.acceptanceChecks,
    } : undefined,
    output: {
      summary: truncateText(handoff ?? execution?.lastMessage ?? checkpoint?.summary ?? null, 1200),
      evaluationPassed: evaluation?.passed ?? null,
    },
    metadata: {
      threadId: execution?.threadId ?? null,
      contractFile: "contract.json",
      runBoardFile: "run-board.json",
      handoffFile: existsSync(path.join(options.runDir, "handoff.md")) ? "handoff.md" : null,
    },
  });

  for (const phase of PHASES) {
    const phaseEvents = events.filter((event) => event.phase === phase);
    if (phaseEvents.length === 0) {
      continue;
    }
    const phaseStart = safeDate(phaseEvents[0]?.ts) ?? startedAt;
    const phaseEnd = safeDate(phaseEvents[phaseEvents.length - 1]?.ts) ?? phaseStart;
    const failed = phaseEvents.some((event) => event.status === "failed");
    const phaseSpan = root.startObservation(`phase:${phase}`, {
      input: { phase },
      output: {
        events: phaseEvents.length,
        failed,
      },
      metadata: {
        phase,
        eventCount: phaseEvents.length,
      },
      level: failed ? "ERROR" : "DEFAULT",
      statusMessage: phaseEvents[phaseEvents.length - 1]?.summary ?? undefined,
    }, { asType: "span" });

    for (const event of phaseEvents) {
      if (event.kind === "lifecycle") {
        continue;
      }
      const attributes = {
        input: eventInput(event),
        output: eventOutput(event),
        metadata: eventMetadata(event),
        level: eventLevel(event),
        statusMessage: event.summary ?? undefined,
      };
      const child = event.kind === "command_execution"
        ? phaseSpan.startObservation(event.title, attributes, { asType: "tool" })
        : phaseSpan.startObservation(event.title, attributes, { asType: "event" });
      child.end(safeDate(event.ts) ?? phaseEnd);
    }
    phaseSpan.end(phaseEnd);
  }

  root.end(finishedAt);
  const traceUrl = await langfuse.client.getTraceUrl(root.traceId).catch(() => null);
  const nextMarker: ExportMarker = {
    version: EXPORT_VERSION,
    mode: options.mode ?? "historical",
    runId: spec.runId,
    traceId: root.traceId,
    rootObservationId: root.id,
    traceUrl,
    startedAt: startedAt.toISOString(),
    completedAt: nowIso(),
    exportedAt: nowIso(),
  };
  await writeMarker(options.runDir, nextMarker);
  if (evaluation) {
    await scoreEvaluation(options.controlRepoRoot, options.runDir, root.traceId, evaluation);
  }
  return {
    skipped: false,
    runId: spec.runId,
    traceId: root.traceId,
    traceUrl,
    markerPath: markerPath(options.runDir),
  };
}

export async function listHarnessRunDirs(controlRepoRoot: string, artifactRoot: string) {
  const runsRoot = path.join(controlRepoRoot, artifactRoot, "runs");
  if (!existsSync(runsRoot)) {
    return [];
  }
  const entries = await readdir(runsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsRoot, entry.name))
    .sort();
}

export async function shutdownLangfuse() {
  await client?.flush().catch(() => undefined);
  await sdk?.shutdown().catch(() => undefined);
  sdk = null;
  client = null;
  initialized = false;
}
