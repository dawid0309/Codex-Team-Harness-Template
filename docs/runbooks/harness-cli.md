# Harness CLI Runbook

Use this runbook when you want to drive the repository through the pure harness kernel instead of repo-specific helper scripts.

## Commands

```powershell
pnpm harness:doctor -- --target foundry
pnpm harness:run -- --target poword
pnpm harness:eval -- --target poword --run-id <run-id>
pnpm harness:resume -- --target poword --run-id <run-id>
pnpm harness:worker:start -- --target poword
pnpm harness:worker:status -- --target poword
pnpm harness:worker:stop -- --target poword
pnpm harness:worker:resume -- --target poword
pnpm harness:dashboard
```

## Model

The harness kernel stays generic and does not know any product-specific workflow.

- `harness.manifest.json` selects an adapter and declares planner, execution, evaluator, and doctor behavior.
- `harness.targets.json` registers target repositories, artifact roots, and target-side adapter config files.
- `data/harness/targets/<target-id>/live-state.json` stores the active run status for a target.
- `data/harness/targets/<target-id>/worker-status.json` stores the active background worker state for a target.
- `data/harness/targets/<target-id>/runs/<run-id>/` stores contracts, execution logs, evaluation artifacts, and checkpoints.

The background worker now runs in continuous mode by default:

- after one run reaches `handoff` with a passing evaluation, the adapter marks that work item as `verified`
- the worker immediately starts the next ready work item for the same target
- the worker stops only when there is no ready work remaining, or when a cycle fails or is interrupted
- `harness:worker:resume` resumes an interrupted run when possible, but if the selected run is already complete it starts the next ready work item instead of replaying the finished one

## Foundry Adapter

This repository ships one built-in adapter, `foundry`, which:

- plans from `planning/task-board.json` and `planning/milestones.json`
- executes a Codex sprint from a structured contract
- evaluates with enabled commands from `project.config.json.verification.stages`

Any future project should add or replace adapters through `harness.manifest.json`, then register target repos through `harness.targets.json`, rather than changing the kernel.
