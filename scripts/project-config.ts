import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type VerificationStage = {
  id: string;
  label: string;
  command: string;
  enabled: boolean;
};

export type VerificationConfig = {
  stages: VerificationStage[];
};

export type AutonomyConfig = {
  basePrompt: string;
  resumePrompt: string;
  sandboxMode: string;
  model: string | null;
};

export type RepoTruthConfig = {
  requiredRecords: string[];
};

export type IntentConfig = {
  canonicalFiles: string[];
};

export type FeedbackConfig = {
  observationsPath: string;
  issueDraftDirectory: string;
  verificationArtifactDirectory: string;
};

export type AgentsConfig = {
  mode: "index";
  maxLines: number;
};

export type ProjectConfig = {
  name: string;
  slug: string;
  goal: string;
  stack: string;
  description: string;
  targetUsers: string;
  successMetric: string;
  mvpBoundary: string;
  owner: string;
  repoName: string;
  licenseHolder: string;
  verification?: VerificationConfig;
  autonomy?: AutonomyConfig;
  repoTruth?: RepoTruthConfig;
  intent?: IntentConfig;
  feedback?: FeedbackConfig;
  agents?: AgentsConfig;
};

export const root = process.cwd();
const projectConfigPath = path.join(root, "project.config.json");

function normalizeRemoteUrl(remoteUrl: string): string | null {
  const sshMatch = remoteUrl.match(/^git@github\.com:(.+?)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;
  }

  const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/(.+?)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  return null;
}

function tryReadOriginUrl(): string | null {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return normalizeRemoteUrl(remoteUrl);
  } catch {
    return null;
  }
}

function titleFromSlug(value: string): string {
  return value
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizePathList(values: string[] | undefined, fallback: string[]) {
  const seen = new Set<string>();
  const normalized = (values ?? fallback)
    .map((value) => value.trim().replaceAll("\\", "/"))
    .filter(Boolean)
    .filter((value) => {
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    });

  return normalized.length > 0 ? normalized : fallback;
}

function renderList(items: string[]) {
  return items.map((item) => `- \`${item}\``).join("\n");
}

async function ensureTextFile(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (!existsSync(filePath)) {
    await writeFile(filePath, content, "utf8");
  }
}

export function defaultVerificationConfig(): VerificationConfig {
  return {
    stages: [
      {
        id: "sync-project",
        label: "Sync project metadata",
        command: "pnpm run sync:project",
        enabled: true,
      },
      {
        id: "compose-agents",
        label: "Compose AGENTS",
        command: "pnpm run compose:agents",
        enabled: true,
      },
      {
        id: "refresh-planner",
        label: "Refresh task board",
        command: "pnpm run planner:refresh",
        enabled: true,
      },
      {
        id: "issues-export",
        label: "Export issue drafts",
        command: "pnpm run issues:export",
        enabled: true,
      },
      {
        id: "typecheck",
        label: "Typecheck",
        command: "pnpm run typecheck",
        enabled: true,
      },
      {
        id: "smoke",
        label: "Smoke",
        command: "pnpm run smoke",
        enabled: true,
      },
    ],
  };
}

export function defaultAutonomyConfig(): AutonomyConfig {
  return {
    basePrompt:
      "Act as the leader/orchestrator. Read repository truth, request planner publication with `pnpm planner:propose` when no ready tasks exist, inspect `planning/planner-output.json`, and accept it with `pnpm planner:publish` when appropriate. If the active final milestone is fully verified and there is no later milestone blueprint, request `pnpm next-milestone:propose`, inspect `planning/next-milestone-output.json`, and accept it with `pnpm next-milestone:publish` when appropriate. Then advance the highest-leverage published task and leave the repo in a verifiable state.",
    resumePrompt:
      "Resume as the leader/orchestrator from repository state and the previous Codex thread. If no ready tasks exist, request planner output with `pnpm planner:propose`, inspect `planning/planner-output.json`, and publish only after accepting the proposal. If the active final milestone is fully verified and there is no later milestone blueprint, request `pnpm next-milestone:propose`, inspect `planning/next-milestone-output.json`, and publish only after accepting that proposal. Then advance the next meaningful published task and stop after a coherent, verifiable unit of work.",
    sandboxMode: "workspace-write",
    model: null,
  };
}

export function defaultRepoTruthConfig(): RepoTruthConfig {
  return {
    requiredRecords: [
      "project.config.json",
      "docs/architecture/system.md",
      "docs/intent/current.md",
      "docs/feedback/loop.md",
      "docs/feedback/verification/README.md",
      "planning/milestones.json",
      "planning/task-board.json",
    ],
  };
}

export function defaultIntentConfig(): IntentConfig {
  return {
    canonicalFiles: [
      "docs/intent/current.md",
      "docs/architecture/system.md",
      "planning/milestones.json",
      "planning/task-board.json",
      "planning/planner-output.json",
      "planning/next-milestone-output.json",
    ],
  };
}

export function defaultFeedbackConfig(): FeedbackConfig {
  return {
    observationsPath: "docs/issues/harness-observations.json",
    issueDraftDirectory: "docs/issues/harness",
    verificationArtifactDirectory: "docs/feedback/verification",
  };
}

export function defaultAgentsConfig(): AgentsConfig {
  return {
    mode: "index",
    maxLines: 80,
  };
}

function applyConfigDefaults(input: Partial<ProjectConfig>): ProjectConfig {
  const slug = (input.slug ?? "codex-harness-foundry").trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-");
  const repoName = (input.repoName ?? slug).trim() || slug;
  const owner = (input.owner ?? "your-github-user").trim() || "your-github-user";

  return {
    name: (input.name ?? titleFromSlug(slug)).trim() || titleFromSlug(slug),
    slug,
    goal: (input.goal ?? "Define the product in repo files and let Codex execute from that truth.").trim(),
    stack: (input.stack ?? "Node.js 22, TypeScript, pnpm, PowerShell, and agents-md").trim(),
    description: (input.description ?? `${titleFromSlug(slug)}: ${input.goal ?? ""}`).trim(),
    targetUsers: (input.targetUsers ?? "Builders who want Codex to operate from repository state.").trim(),
    successMetric: (input.successMetric ?? "A new repository can be initialized and verified in minutes.").trim(),
    mvpBoundary: (input.mvpBoundary ?? "Repo-native context, planning, verification, and feedback loops.").trim(),
    owner,
    repoName,
    licenseHolder: (input.licenseHolder ?? owner).trim() || owner,
    verification: input.verification ?? defaultVerificationConfig(),
    autonomy: {
      ...defaultAutonomyConfig(),
      ...input.autonomy,
    },
    repoTruth: {
      requiredRecords: normalizePathList(input.repoTruth?.requiredRecords, defaultRepoTruthConfig().requiredRecords),
    },
    intent: {
      canonicalFiles: normalizePathList(input.intent?.canonicalFiles, defaultIntentConfig().canonicalFiles),
    },
    feedback: {
      ...defaultFeedbackConfig(),
      ...input.feedback,
    },
    agents: {
      ...defaultAgentsConfig(),
      ...input.agents,
      mode: "index",
      maxLines: input.agents?.maxLines && input.agents.maxLines > 0 ? input.agents.maxLines : defaultAgentsConfig().maxLines,
    },
  };
}

export async function readProjectConfig(): Promise<ProjectConfig> {
  return applyConfigDefaults(JSON.parse(await readFile(projectConfigPath, "utf8")) as Partial<ProjectConfig>);
}

export async function writeProjectConfig(config: ProjectConfig): Promise<void> {
  await writeFile(projectConfigPath, `${JSON.stringify(applyConfigDefaults(config), null, 2)}\n`, "utf8");
}

export function deriveRepositoryMetadata(config: ProjectConfig) {
  const originUrl = tryReadOriginUrl();
  const repositoryUrl = originUrl ?? `https://github.com/${config.owner}/${config.repoName}`;
  const repoMatch = repositoryUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
  const owner = repoMatch?.[1] ?? config.owner;
  const repoName = repoMatch?.[2] ?? config.repoName;

  return {
    owner,
    repoName,
    repositoryUrl,
    bugsUrl: `${repositoryUrl}/issues`,
    homepageUrl: `${repositoryUrl}#readme`,
  };
}

export function resolveIssueExportDirectory(config: ProjectConfig) {
  return config.feedback?.issueDraftDirectory ?? defaultFeedbackConfig().issueDraftDirectory;
}

function projectMission(config: ProjectConfig) {
  return `<!-- agents-md: target=root, priority=100 -->
# Project Mission

- Project: \`${config.name}\`
- Product goal: \`${config.goal}\`
- AGENTS mode: \`${config.agents?.mode ?? "index"}\`
- Human role: design the environment, write intent into the repo, and review feedback
- North star: every Codex session should start from repository truth instead of chat memory

Canonical intent files:

${renderList(config.intent?.canonicalFiles ?? defaultIntentConfig().canonicalFiles)}
`;
}

function rootProjectContext(config: ProjectConfig) {
  const canonical = config.intent?.canonicalFiles ?? defaultIntentConfig().canonicalFiles;
  const ordered = canonical.map((file, index) => `${index + 2}. \`${file}\``).join("\n");
  const feedbackPosition = canonical.length + 2;
  const agentsPosition = canonical.length + 3;

  return `<!-- agents-md: target=root, priority=100 -->
# ${config.name} Codex Workbench

AGENTS.md is a directory page, not a handbook. Keep deep detail in the linked source files.

Read in order before substantial work:

1. \`project.config.json\`
${ordered}
${feedbackPosition}. \`docs/feedback/loop.md\`
${agentsPosition}. the nearest role-specific \`AGENTS.md\`

Key commands:

- \`pnpm verify\`
- \`pnpm planner:next\`
- \`pnpm issues:export\`
- \`pnpm harness:worker:status\`
`;
}

function architectureDoc(config: ProjectConfig) {
  return `# System Architecture

Use this document as the canonical product brief for Codex. AGENTS.md should point here instead of duplicating this content.

## Product Goal

- Project name: \`${config.name}\`
- Product goal: \`${config.goal}\`
- Target users: ${config.targetUsers}
- Success metric: ${config.successMetric}
- Current MVP boundary: ${config.mvpBoundary}

## Modules

- UI: pages, flows, dashboards, and user-facing interaction
- Engine: domain logic, orchestration, workflows, and state transitions
- Data: storage, schemas, integrations, and data movement
- Content: prompts, presets, templates, and authored assets
- Verification: tests, smoke checks, observability, and review criteria

## Key Types And Interfaces

List the important entities and contracts here before implementation starts. Good examples:

- core domain types
- request and response shapes
- planner inputs and outputs
- persistence records
- event payloads
- integration boundaries

## Constraints

- stack: \`${config.stack}\`
- non-goals:
- performance expectations:
- security or compliance notes:
- deployment assumptions:

## Open Questions

- What still needs a product or architecture decision?
- What should stay out of scope for the first milestone?
- What needs a manual verification step even after automation exists?
`;
}

function intentDoc(config: ProjectConfig) {
  return `# Current Intent

Use this file to describe the next coherent delivery loop before the builder writes code.

## Environment

- Stack: ${config.stack}
- Entry points: update for the subsystem you are about to change
- Verification command: \`pnpm verify\`

## Target Outcome

- Describe the next smallest useful capability or refactor.
- Name the acceptance signal a verifier can check mechanically.

## Constraints

- What must not change?
- What product bar or compatibility promise must hold?

## Feedback Hooks

- Observation source: \`${config.feedback?.observationsPath ?? defaultFeedbackConfig().observationsPath}\`
- Draft export directory: \`${resolveIssueExportDirectory(config)}\`
- Verification artifacts: \`${config.feedback?.verificationArtifactDirectory ?? defaultFeedbackConfig().verificationArtifactDirectory}\`
`;
}

function feedbackLoopDoc(config: ProjectConfig) {
  return `# Feedback Loop

The repository owns the delivery loop.

1. Engineers design the environment and make the intended outcome explicit in \`docs/intent/current.md\`.
2. Codex reads the canonical repo truth, executes the next task, and leaves evidence in the repo.
3. Verifiers read the output, run \`pnpm verify\`, and write back task, review, or issue records.
4. New problems become repo-first observations in \`${config.feedback?.observationsPath ?? defaultFeedbackConfig().observationsPath}\` before they become GitHub issues.

Use the runbooks in \`docs/runbooks/\` when the loop needs manual help, not AGENTS.md.
`;
}

function verificationArtifactsReadme(config: ProjectConfig) {
  return `# Verification Artifacts

Store tracked verification notes, transcripts, screenshots, and handoff evidence here when a change needs durable review context.

- Canonical verify command: \`pnpm verify\`
- Harness worker status command: \`pnpm harness:worker:status\`
- Issue draft export: \`pnpm issues:export\`

Keep generated caches and temporary logs outside this directory. This directory is for reviewable artifacts that belong in the repository.
`;
}

function engineerLoopRunbook(config: ProjectConfig) {
  return `# Engineer Loop

Codex Harness Foundry is designed so engineers spend less time writing code and more time shaping the system Codex works inside.

## Human Responsibilities

1. Design the environment.
   - Keep the repo structure, commands, and verification path trustworthy.
   - Decide which artifacts are canonical and keep them visible in \`project.config.json\`.
2. Write the intent down.
   - Describe the current goal in \`docs/intent/current.md\`.
   - Keep product detail in \`docs/architecture/system.md\` and planning detail in \`planning/\`.
3. Read feedback and close the loop.
   - Run \`pnpm verify\`.
   - Update the task board, review notes, and issue observations.
   - Export GitHub-facing drafts from \`${config.feedback?.observationsPath ?? defaultFeedbackConfig().observationsPath}\` into \`${resolveIssueExportDirectory(config)}\`.

## Operating Rule

If it is not represented in repository truth, the agent should not rely on it. Add or fix the repo record before asking Codex to continue.
`;
}

function issueDraftReadme(config: ProjectConfig) {
  return `# Harness Issue Drafts

This folder contains repo-reviewed issue drafts exported from \`${config.feedback?.observationsPath ?? defaultFeedbackConfig().observationsPath}\`.

Run \`pnpm issues:export\` after updating the observation source. Copy reviewed drafts to GitHub only after the repository version looks correct.
`;
}

function defaultObservationFile(config: ProjectConfig) {
  return `${JSON.stringify(
    {
      version: 1,
      project: config.name,
      source: "Repo-first issue observations maintained in the repository before GitHub sync.",
      issues: [],
    },
    null,
    2,
  )}\n`;
}

function mitLicense(holder: string) {
  const year = new Date().getFullYear();
  return `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

export async function syncProjectFiles(config: ProjectConfig): Promise<void> {
  const resolved = applyConfigDefaults(config);
  const repo = deriveRepositoryMetadata(resolved);

  await writeFile(path.join(root, "agents-md", "00-project.agents.md"), projectMission(resolved), "utf8");
  await writeFile(path.join(root, "agents-md", "root", "00-project.agents.md"), rootProjectContext(resolved), "utf8");
  await writeFile(path.join(root, "docs", "architecture", "system.md"), architectureDoc(resolved), "utf8");
  await writeFile(path.join(root, "LICENSE"), mitLicense(resolved.licenseHolder), "utf8");
  await writeFile(path.join(root, ".github", "CODEOWNERS"), `* @${repo.owner}\n`, "utf8");

  const packageJsonPath = path.join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  packageJson.name = resolved.slug;
  packageJson.description = resolved.description;
  packageJson.repository = {
    type: "git",
    url: `git+${repo.repositoryUrl}.git`,
  };
  packageJson.bugs = { url: repo.bugsUrl };
  packageJson.homepage = repo.homepageUrl;
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

  const feedback = resolved.feedback ?? defaultFeedbackConfig();
  await ensureTextFile(path.join(root, "docs", "intent", "current.md"), intentDoc(resolved));
  await ensureTextFile(path.join(root, "docs", "feedback", "loop.md"), feedbackLoopDoc(resolved));
  await ensureTextFile(
    path.join(root, feedback.verificationArtifactDirectory, "README.md"),
    verificationArtifactsReadme(resolved),
  );
  await ensureTextFile(path.join(root, "docs", "runbooks", "engineer-loop.md"), engineerLoopRunbook(resolved));
  await ensureTextFile(path.join(root, feedback.observationsPath), defaultObservationFile(resolved));
  await ensureTextFile(path.join(root, resolveIssueExportDirectory(resolved), "README.md"), issueDraftReadme(resolved));
}

export function normalizeConfig(input: Partial<ProjectConfig>, existing: ProjectConfig): ProjectConfig {
  return applyConfigDefaults({
    ...existing,
    ...input,
    verification: input.verification ?? existing.verification,
    autonomy: input.autonomy ?? existing.autonomy,
    repoTruth: input.repoTruth ?? existing.repoTruth,
    intent: input.intent ?? existing.intent,
    feedback: input.feedback ?? existing.feedback,
    agents: input.agents ?? existing.agents,
  });
}
