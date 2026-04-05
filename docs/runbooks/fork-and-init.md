# Fork And Initialize

This runbook is for teams creating a new repository from `Codex-Team-Harness-Template`.

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

## What `pnpm init:project` Does

- updates `project.config.json`
- syncs package metadata and repo URLs
- rewrites the core project identity docs
- refreshes the license holder and `CODEOWNERS`
- resets `planning/task-board.json` to a clean starting point

## Suggested First Prompts For Codex

- `Read AGENTS.md and recommend the first ready task`
- `Rewrite the milestone plan for this product based on docs/architecture/system.md`
- `Create the first verifiable implementation slice for milestone one`
