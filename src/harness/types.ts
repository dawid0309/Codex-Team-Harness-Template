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

export type HarnessLaneId = "planner" | "executor" | "evaluator" | "handoff" | "subagents";

export type HarnessNodeStatus = "pending" | "running" | "completed" | "failed" | "interrupted";

export type HarnessPlanStepStatus = "pending" | "running" | "completed" | "failed";

export type HarnessPlanStepSource = "planner_output" | "contract" | "agent_message" | "inferred" | "mixed";

export type HarnessRunEventKind =
  | "lifecycle"
  | "agent_message"
  | "command_execution"
  | "file_change"
  | "session"
  | "error"
  | "item";

export type HarnessRunSpec = {
  targetId: string;
  adapterId: string;
  artifactRoot: string;
  manifestPath: string;
  targetRegistryPath: string;
  controlRepoRoot: string;
  targetRepoRoot: string;
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
  failureReason: string | null;
  sandboxModeRequested: string;
  sandboxModeUsed: string;
  fallbackApplied: boolean;
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
  targetId: string;
  adapterId: string;
  phase: HarnessPhase;
  caseId: string | null;
  title: string | null;
  contractFile: string | null;
  executionFile: string | null;
  evaluationFile: string | null;
  threadId: string | null;
  updatedAt: string;
  summary: string | null;
};

export type HarnessLiveState = {
  status: HarnessRunStatus;
  phase: HarnessPhase | null;
  runId: string | null;
  targetId: string | null;
  adapterId: string | null;
  caseId: string | null;
  title: string | null;
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
  targetId: string | null;
  adapterId: string | null;
  phase: HarnessPhase | null;
  activeLane: HarnessLaneId | null;
  activeTaskId: string | null;
  activeTaskTitle: string | null;
  activeSubagentCount: number;
  caseId: string | null;
  title: string | null;
  threadId: string | null;
  startedAt: string | null;
  updatedAt: string;
  latestSummary: string | null;
  latestCheckpoint: string | null;
  stdoutLog: string;
  stderrLog: string;
};

export type HarnessRunEvent = {
  id: string;
  runId: string;
  targetId: string;
  ts: string;
  kind: HarnessRunEventKind;
  phase: HarnessPhase;
  lane: HarnessLaneId;
  status: HarnessNodeStatus;
  title: string;
  summary: string | null;
  itemId: string | null;
  parentItemId: string | null;
  raw: Record<string, unknown>;
};

export type HarnessTaskNode = {
  id: string;
  runId: string;
  lane: HarnessLaneId;
  kind: HarnessRunEventKind;
  title: string;
  status: HarnessNodeStatus;
  startedAt: string | null;
  finishedAt: string | null;
  summary: string | null;
  filePaths: string[];
  command: string | null;
  children: string[];
  parentId: string | null;
  rawEventIds: string[];
};

export type HarnessLaneBoard = {
  lane: HarnessLaneId;
  label: string;
  status: HarnessNodeStatus | "idle";
  activeTaskId: string | null;
  activeTaskTitle: string | null;
  totalTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
  taskIds: string[];
};

export type HarnessRunBoard = {
  runId: string;
  targetId: string;
  phase: HarnessPhase | null;
  activeLane: HarnessLaneId | null;
  activeNodeId: string | null;
  latestSummary: string | null;
  updatedAt: string;
  lanes: Record<HarnessLaneId, HarnessLaneBoard>;
  tasks: HarnessTaskNode[];
};

export type HarnessPlanStep = {
  id: string;
  runId: string;
  targetId: string;
  index: number;
  title: string;
  description: string;
  status: HarnessPlanStepStatus;
  source: HarnessPlanStepSource;
  matchedTaskId: string | null;
  matchedTaskTitle: string | null;
  matchedTaskLane: HarnessLaneId | null;
  matchedTaskStatus: HarnessNodeStatus | null;
  evidenceTaskIds: string[];
  evidenceEventIds: string[];
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  isActive: boolean;
  activeSubtaskId: string | null;
  activeSubtaskTitle: string | null;
  totalSubtasks: number;
  runningSubtasks: number;
  completedSubtasks: number;
  failedSubtasks: number;
  subtasks: Array<{
    id: string;
    title: string;
    kind: string;
    lane: HarnessLaneId;
    status: HarnessNodeStatus;
    summary: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    filePaths: string[];
    command: string | null;
    isActive: boolean;
  }>;
};

export type HarnessPlanView = {
  runId: string;
  targetId: string;
  title: string | null;
  summary: string | null;
  source: HarnessPlanStepSource | "none";
  activeStepId: string | null;
  activeStepIndex: number | null;
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  currentTaskLane: HarnessLaneId | null;
  steps: HarnessPlanStep[];
};

export type HarnessManifestFile = {
  version: number;
  defaultAdapter: string;
  artifactRoot: string;
  adapters: Record<string, ProjectAdapterManifest>;
};

export type HarnessTargetRegistration = {
  id: string;
  label: string;
  repoRoot: string;
  adapterId: string;
  adapterConfigPath: string;
  artifactRoot: string;
};

export type HarnessTargetRegistryFile = {
  version: number;
  defaultTarget: string;
  targets: Record<string, HarnessTargetRegistration>;
};

export type TaskBoardPlannerConfig = {
  kind: "task-board";
  refreshCommand: string | null;
  taskBoardPath: string;
  milestonesPath: string;
};

export type ExternalCasesPlannerConfig = {
  kind: "external-cases";
};

export type PlannerConfig = TaskBoardPlannerConfig | ExternalCasesPlannerConfig;

export type FoundryExecutionConfig = {
  kind: "codex-cli";
  sandboxModeSource: "project.config.autonomy.sandboxMode";
  basePromptSource: "project.config.autonomy.basePrompt";
  resumePromptSource: "project.config.autonomy.resumePrompt";
  modelSource: "project.config.autonomy.model";
  defaultWriteScope: string[];
};

export type ExternalExecutionConfig = {
  kind: "external-codex-cli";
};

export type ExecutionConfig = FoundryExecutionConfig | ExternalExecutionConfig;

export type FoundryEvaluationConfig = {
  kind: "verification-stages";
  projectConfigPath: string;
};

export type ExternalEvaluationConfig = {
  kind: "external-commands";
};

export type EvaluationConfig = FoundryEvaluationConfig | ExternalEvaluationConfig;

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

export type HarnessReadyWorkItem = {
  id: string;
  title: string;
  source?: "existing" | "generated";
  generatedCount?: number;
  generationSummary?: string | null;
};

export type HarnessCompletionUpdate = {
  itemId: string;
  title: string;
  fromStatus: string | null;
  toStatus: string;
  sourcePath: string;
  summary: string;
};

export type HarnessTarget = {
  manifest: ProjectAdapterManifest;
  peekReadyWork?(context: HarnessContext): Promise<HarnessReadyWorkItem | null>;
  plan(context: HarnessContext): Promise<SprintContract>;
  execute(context: HarnessContext & { contract: SprintContract; threadId: string | null; resume: boolean }): Promise<ExecutionResult>;
  evaluate(context: HarnessContext & { contract: SprintContract; execution: ExecutionResult }): Promise<EvaluationResult>;
  completeWork?(context: HarnessContext & {
    contract: SprintContract;
    execution: ExecutionResult;
    evaluation: EvaluationResult;
  }): Promise<HarnessCompletionUpdate | null>;
  doctor(context: HarnessContext): Promise<DoctorCheck[]>;
};

export type HarnessContext = {
  controlRepoRoot: string;
  targetRepoRoot: string;
  runSpec: HarnessRunSpec;
  target: HarnessTargetRegistration;
  manifest: ProjectAdapterManifest;
  artifactStore: HarnessArtifactStore;
  selectedTaskId: string | null;
  executionObserver?: {
    onThreadStarted?: (threadId: string) => Promise<void> | void;
    onCodexEvent?: (event: Record<string, unknown>) => Promise<void> | void;
  };
};

export type HarnessArtifactStore = {
  rootDir: string;
  runDir: string;
  resolve(relativePath: string): string;
  writeJson(relativePath: string, payload: unknown): Promise<string>;
  appendJsonLine(relativePath: string, payload: unknown): Promise<string>;
  writeText(relativePath: string, content: string): Promise<string>;
  readJson<T>(relativePath: string): Promise<T>;
};

export type ExternalCaseStatus =
  | "backlog"
  | "ready"
  | "in_progress"
  | "blocked"
  | "review"
  | "parked"
  | "verified"
  | "done";

export type ExternalTargetCase = {
  id: string;
  title: string;
  status: ExternalCaseStatus;
  track: string | null;
  goal: string;
  instructions?: string[];
  inputs?: string[];
  allowedWriteScope?: string[];
  acceptanceChecks?: string[];
  expectedArtifacts?: string[];
  nextConsumer?: string | null;
  metadata?: Record<string, unknown>;
};

export type ExternalEvaluationCommand = {
  id: string;
  label: string;
  command: string;
};

export type ExternalPlanningConfig = {
  enabled: boolean;
  batchSize: number;
  basePrompt: string;
  directionNote?: string | null;
  model: string | null;
  maxRecentHandoffs: number;
  firstGeneratedStatus: "ready";
  remainingGeneratedStatus: "backlog";
};

export type ExternalPlannerDraftCase = {
  title: string;
  goal: string;
  instructions?: string[];
  inputs?: string[];
  allowedWriteScope?: string[];
  acceptanceChecks?: string[];
  expectedArtifacts?: string[];
  nextConsumer?: string | null;
  metadata?: Record<string, unknown>;
};

export type ExternalPlannerContextPacket = {
  targetId: string;
  targetLabel: string;
  targetRepoRoot: string;
  generatedAt: string;
  currentCases: ExternalTargetCase[];
  recentRuns: Array<{
    runId: string;
    caseId: string | null;
    title: string | null;
    summary: string | null;
    evaluationPassed: boolean | null;
    failureReason: string | null;
    updatedAt: string | null;
  }>;
  gitStatus: string;
  entrySnapshots: Array<{
    path: string;
    content: string;
  }>;
  latestVerifiedCase: {
    id: string;
    title: string;
    goal: string;
    summary: string | null;
    metadata: Record<string, unknown>;
  } | null;
  latestVerifiedInputSnapshots: Array<{
    path: string;
    content: string;
  }>;
};

export type ExternalPlannerPublishResult = {
  source: "generated";
  generatedCount: number;
  publishedCount: number;
  firstReadyCaseId: string | null;
  summary: string;
  casesPath: string;
  generatedCases: ExternalTargetCase[];
};

export type ExternalDirectionBrief = {
  activeTrack?: string | null;
  productGoal?: string | null;
  userExperience?: string | null;
  platformScope?: string | null;
  implementationPreference?: string | null;
  constraints?: string[];
  avoid?: string[];
  successSignals?: string[];
  notes?: string | null;
};

export type ExternalTargetConfig = {
  id: string;
  label: string;
  description: string;
  casesPath: string;
  directionBrief?: ExternalDirectionBrief;
  execution: {
    basePrompt: string;
    resumePrompt: string;
    directionNote?: string | null;
    sandboxMode: string;
    model: string | null;
    defaultWriteScope: string[];
  };
  evaluation: {
    commands: ExternalEvaluationCommand[];
  };
  planning?: ExternalPlanningConfig;
  doctor: {
    requiredFiles: string[];
    requiredCommands: string[];
  };
};
