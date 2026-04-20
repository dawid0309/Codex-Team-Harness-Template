export type HarnessRunStatus =
  | "idle"
  | "planning"
  | "planned"
  | "executing"
  | "executed"
  | "evaluating"
  | "completed"
  | "failed"
  | "interrupted";

export type HarnessPhase = "plan" | "execute" | "evaluate" | "handoff";

export type HarnessRunSpec = {
  adapterId: string;
  artifactRoot: string;
  manifestPath: string;
  repoRoot: string;
  runId: string;
  model: string | null;
  taskId: string | null;
};

export type SprintContract = {
  id: string;
  adapterId: string;
  caseId: string;
  title: string;
  goal: string;
  instructions: string[];
  inputs: string[];
  allowedWriteScope: string[];
  acceptanceChecks: string[];
  expectedArtifacts: string[];
  nextConsumer: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type ExecutionResult = {
  exitCode: number;
  passed: boolean;
  resume: boolean;
  threadId: string | null;
  startedAt: string;
  finishedAt: string;
  elapsedSeconds: number;
  stdoutLog: string;
  stderrLog: string;
  promptFile: string;
  lastMessageFile: string;
  lastMessage: string | null;
};

export type EvaluationEvidence = {
  label: string;
  command: string;
  passed: boolean;
  returnCode: number | null;
  stdoutLog: string;
  stderrLog: string;
  elapsedSeconds: number;
};

export type EvaluationResult = {
  passed: boolean;
  retryable: boolean;
  failureReason: string | null;
  findings: string[];
  evidence: EvaluationEvidence[];
  startedAt: string;
  finishedAt: string;
  elapsedSeconds: number;
};

export type HarnessCheckpoint = {
  runId: string;
  adapterId: string;
  phase: HarnessPhase;
  contractFile: string | null;
  executionFile: string | null;
  evaluationFile: string | null;
  threadId: string | null;
  updatedAt: string;
  summary: string | null;
};

export type HarnessLiveState = {
  status: HarnessRunStatus;
  runId: string | null;
  adapterId: string | null;
  threadId: string | null;
  startedAt: string | null;
  updatedAt: string;
  latestCheckpoint: string | null;
  latestSummary: string | null;
  failureReason: string | null;
};

export type HarnessWorkerState =
  | "idle"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export type HarnessWorkerStatus = {
  state: HarnessWorkerState;
  workerPid: number | null;
  runId: string | null;
  adapterId: string | null;
  threadId: string | null;
  startedAt: string | null;
  updatedAt: string;
  latestSummary: string | null;
  latestCheckpoint: string | null;
  stdoutLog: string;
  stderrLog: string;
};

export type HarnessManifestFile = {
  version: number;
  defaultAdapter: string;
  artifactRoot: string;
  adapters: Record<string, ProjectAdapterManifest>;
};

export type PlannerConfig = {
  kind: "task-board";
  refreshCommand: string | null;
  taskBoardPath: string;
  milestonesPath: string;
};

export type ExecutionConfig = {
  kind: "codex-cli";
  sandboxModeSource: "project.config.autonomy.sandboxMode";
  basePromptSource: "project.config.autonomy.basePrompt";
  resumePromptSource: "project.config.autonomy.resumePrompt";
  modelSource: "project.config.autonomy.model";
  defaultWriteScope: string[];
};

export type EvaluationConfig = {
  kind: "verification-stages";
  projectConfigPath: string;
};

export type DoctorConfig = {
  requiredFiles: string[];
  requiredCommands: string[];
};

export type ProjectAdapterManifest = {
  id: string;
  label: string;
  description: string;
  planner: PlannerConfig;
  execution: ExecutionConfig;
  evaluation: EvaluationConfig;
  doctor: DoctorConfig;
};

export type DoctorCheck = {
  label: string;
  passed: boolean;
  detail: string;
};

export type HarnessTarget = {
  manifest: ProjectAdapterManifest;
  plan(context: HarnessContext): Promise<SprintContract>;
  execute(context: HarnessContext & { contract: SprintContract; threadId: string | null; resume: boolean }): Promise<ExecutionResult>;
  evaluate(context: HarnessContext & { contract: SprintContract; execution: ExecutionResult }): Promise<EvaluationResult>;
  doctor(context: HarnessContext): Promise<DoctorCheck[]>;
};

export type HarnessContext = {
  repoRoot: string;
  runSpec: HarnessRunSpec;
  manifest: ProjectAdapterManifest;
  artifactStore: HarnessArtifactStore;
  selectedTaskId: string | null;
};

export type HarnessArtifactStore = {
  rootDir: string;
  runDir: string;
  resolve(relativePath: string): string;
  writeJson(relativePath: string, payload: unknown): Promise<string>;
  writeText(relativePath: string, content: string): Promise<string>;
  readJson<T>(relativePath: string): Promise<T>;
};
