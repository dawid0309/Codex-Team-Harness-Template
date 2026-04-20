# Harness CLI Runbook

Use this runbook when you want to drive the repository through the pure harness kernel instead of repo-specific helper scripts.

## Commands

```powershell
pnpm harness:doctor
pnpm harness:run
pnpm harness:eval -- --run-id <run-id>
pnpm harness:resume -- --run-id <run-id>
pnpm harness:worker:start
pnpm harness:worker:status
pnpm harness:worker:stop
pnpm harness:worker:resume
```

## Model

The harness kernel stays generic and does not know any product-specific workflow.

- `harness.manifest.json` selects an adapter and declares planner, execution, evaluator, and doctor behavior.
- `data/harness/live-state.json` stores the active run status.
- `data/harness/worker-status.json` stores the active background worker state.
- `data/harness/runs/<run-id>/` stores contracts, execution logs, evaluation artifacts, and checkpoints.

## Foundry Adapter

This repository ships one built-in adapter, `foundry`, which:

- plans from `planning/task-board.json` and `planning/milestones.json`
- executes a Codex sprint from a structured contract
- evaluates with enabled commands from `project.config.json.verification.stages`

Any future project should add or replace adapters through `harness.manifest.json` rather than changing the kernel.
