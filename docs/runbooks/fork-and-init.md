# Fork And Initialize

This runbook is for teams creating a new repository from `Codex-Harness-Foundry`.

## Recommended Flow

1. Click `Use this template` on GitHub.
2. Clone the new repository.
3. Install dependencies:

```powershell
pnpm install
```

4. Initialize project metadata:

```powershell
pnpm init:project
```

5. Review the generated files:

- `project.config.json`
- `docs/intent/current.md`
- `docs/architecture/system.md`
- `docs/feedback/loop.md`
- `agents-md/00-project.agents.md`
- `agents-md/root/00-project.agents.md`
- `package.json`

6. Rewrite `planning/milestones.json` so the milestones match the actual product.
7. Run:

```powershell
pnpm verify
```

8. If you plan to manage GitHub issue responses from repo state, export the tracked drafts:

```powershell
pnpm issues:export
```

## What `pnpm init:project` Does

- updates `project.config.json`
- syncs package metadata and repo URLs
- rewrites the core project identity docs
- creates the environment / intent / feedback entry points if they do not exist yet
- refreshes the license holder and `CODEOWNERS`
- resets `planning/task-board.json` to a clean starting point

## Follow-On Template Controls

After initialization, the main repo-native control points are:

- `project.config.json.verification` for the ordered verify stages behind `pnpm verify`
- `project.config.json.repoTruth`, `intent`, `feedback`, and `agents` for canonical repo records
- `project.config.json.autonomy` for Codex CLI prompt, sandbox, and model defaults
- `harness.manifest.json` for adapter, evaluator, and worker behavior
- `harness.targets.json` for target registration, target repo paths, and artifact roots
- `targets/<target-id>/` for external case files, prompts, and evaluator commands
- `planning/planner-output.json` for planner proposals that the leader can accept into the task board
- `planning/next-milestone-output.json` for roadmap-extension proposals that the leader can accept into `planning/milestones.json`
- `docs/issues/harness-observations.json` for tracked issue-export source data

Useful commands:

```powershell
pnpm verify
pnpm planner:propose
pnpm planner:publish
pnpm planner:next
pnpm issues:export
pnpm harness:worker:status -- --target foundry
pnpm harness:dashboard
```

## Suggested First Prompts For Codex

- `Read AGENTS.md and recommend the first ready task`
- `Read AGENTS.md, docs/intent/current.md, and propose the next delivery loop`
- `Rewrite the milestone plan for this product based on docs/architecture/system.md`
- `Create the first verifiable implementation slice for milestone one`
