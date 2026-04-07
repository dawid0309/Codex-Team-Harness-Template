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
- `docs/architecture/system.md`
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
- refreshes the license holder and `CODEOWNERS`
- resets `planning/task-board.json` to a clean starting point

## Follow-On Template Controls

After initialization, the main repo-native control points are:

- `project.config.json.verification` for the ordered verify stages behind `pnpm verify`
- `project.config.json.autonomy` for Codex CLI runtime behavior and structural stop conditions
- `docs/issues/harness-observations.json` for tracked issue-export source data

Useful commands:

```powershell
pnpm verify
pnpm planner:next
pnpm issues:export
pnpm runtime:status
```

## Suggested First Prompts For Codex

- `Read AGENTS.md and recommend the first ready task`
- `Rewrite the milestone plan for this product based on docs/architecture/system.md`
- `Create the first verifiable implementation slice for milestone one`
