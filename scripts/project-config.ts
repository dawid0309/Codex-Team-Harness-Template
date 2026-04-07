import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
};

export type VerificationStage = {
  id: string;
  label: string;
  command: string;
  enabled: boolean;
};

export type VerificationConfig = {
  stages: VerificationStage[];
};

export type StopConditionId =
  | "active_milestone_no_ready_or_in_progress"
  | "active_milestone_all_done"
  | "issue_exports_present"
  | "milestone_complete_and_issue_exports_present";

export type AutonomyConfig = {
  basePrompt: string;
  resumePrompt: string;
  sandboxMode: string;
  selectedStopCondition: StopConditionId;
  issueExportDirectory: string;
  model: string | null;
  maxConsecutiveTerminalBlockers: number;
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

export async function readProjectConfig(): Promise<ProjectConfig> {
  return JSON.parse(await readFile(projectConfigPath, "utf8")) as ProjectConfig;
}

export async function writeProjectConfig(config: ProjectConfig): Promise<void> {
  await writeFile(projectConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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
    selectedStopCondition: "milestone_complete_and_issue_exports_present",
    issueExportDirectory: "docs/issues/harness",
    model: null,
    maxConsecutiveTerminalBlockers: 3,
  };
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

function projectMission(config: ProjectConfig) {
  return `<!-- agents-md: target=root, priority=100 -->
# Project Mission

- Project: \`${config.name}\`
- Product goal: \`${config.goal}\`
- Current phase: \`m1-foundation\`
- North star: every Codex session should start from repo truth, not ad-hoc chat memory.

Primary references:

- \`docs/architecture/system.md\`
- \`planning/milestones.json\`
- \`planning/task-board.json\`
- \`planning/planner-output.json\`
- \`planning/next-milestone-output.json\`
`;
}

function rootProjectContext(config: ProjectConfig) {
  return `<!-- agents-md: target=root, priority=100 -->
# ${config.name} Codex Workbench

This is the root operating context for the project.

Before doing substantial work, read:

1. \`docs/architecture/system.md\`
2. \`planning/milestones.json\`
3. \`planning/task-board.json\`
4. \`planning/planner-output.json\`
5. \`planning/next-milestone-output.json\`
6. the nearest role-specific \`AGENTS.md\`

Default working assumptions:

- Stack: \`${config.stack}\`
- Collaboration mode: one main orchestrator thread plus on-demand subagents
`;
}

function architectureDoc(config: ProjectConfig) {
  return `# System Architecture

Use this document as the canonical product brief for Codex. Before asking multiple agents to build in parallel, write down the smallest useful version of the system here.

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
  const repo = deriveRepositoryMetadata(config);

  await writeFile(path.join(root, "agents-md", "00-project.agents.md"), projectMission(config), "utf8");
  await writeFile(path.join(root, "agents-md", "root", "00-project.agents.md"), rootProjectContext(config), "utf8");
  await writeFile(path.join(root, "docs", "architecture", "system.md"), architectureDoc(config), "utf8");
  await writeFile(path.join(root, "LICENSE"), mitLicense(config.licenseHolder), "utf8");
  await writeFile(path.join(root, ".github", "CODEOWNERS"), `* @${repo.owner}\n`, "utf8");

  const packageJsonPath = path.join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  packageJson.name = config.slug;
  packageJson.description = config.description;
  packageJson.repository = {
    type: "git",
    url: `git+${repo.repositoryUrl}.git`,
  };
  packageJson.bugs = { url: repo.bugsUrl };
  packageJson.homepage = repo.homepageUrl;
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

export function normalizeConfig(input: Partial<ProjectConfig>, existing: ProjectConfig): ProjectConfig {
  const slug = (input.slug ?? existing.slug).trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-");
  const repoName = (input.repoName ?? existing.repoName).trim() || slug;
  const owner = (input.owner ?? existing.owner).trim() || existing.owner;

  return {
    name: (input.name ?? existing.name).trim() || titleFromSlug(slug),
    slug,
    goal: (input.goal ?? existing.goal).trim(),
    stack: (input.stack ?? existing.stack).trim(),
    description: (input.description ?? existing.description).trim(),
    targetUsers: (input.targetUsers ?? existing.targetUsers).trim(),
    successMetric: (input.successMetric ?? existing.successMetric).trim(),
    mvpBoundary: (input.mvpBoundary ?? existing.mvpBoundary).trim(),
    owner,
    repoName,
    licenseHolder: (input.licenseHolder ?? existing.licenseHolder ?? owner).trim() || owner,
    verification: input.verification ?? existing.verification ?? defaultVerificationConfig(),
    autonomy: input.autonomy ?? existing.autonomy ?? defaultAutonomyConfig(),
  };
}
