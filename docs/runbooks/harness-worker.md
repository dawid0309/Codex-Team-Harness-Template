# Harness Worker Runbook

Use this runbook when you want Codex Harness Foundry to supervise a longer Codex CLI run through the pure harness kernel.

## Commands

```powershell
pnpm harness:worker:start -- --target poword
pnpm harness:worker:status -- --target poword
pnpm harness:worker:stop -- --target poword
pnpm harness:worker:resume -- --target poword
```

These commands are background wrappers around the harness kernel. They do not contain repo-native planning logic on their own.

## Worker State

Worker state is stored in ignored files under target-scoped directories in `data/harness/targets/<target-id>/`.

- `data/harness/targets/<target-id>/worker-status.json`
- `data/harness/targets/<target-id>/worker-stdout.log`
- `data/harness/targets/<target-id>/worker-stderr.log`
- `data/harness/targets/<target-id>/live-state.json`
- `data/harness/targets/<target-id>/runs/<run-id>/`

The worker status file records the worker state, target id, run id, adapter id, phase, case id, worker pid, thread id, latest checkpoint, and latest summary.

## Operating Model

- `harness.manifest.json` selects the available adapters.
- `harness.targets.json` registers target repositories and their artifact roots.
- `targets/<target-id>/` holds external target config such as cases, prompts, evaluator commands, and doctor checks.
- `pnpm harness:worker:start -- --target <target-id>` launches a continuous background harness worker for the target.
- `pnpm harness:worker:resume -- --target <target-id>` resumes an interrupted run from its checkpoint. If the selected run already reached handoff, it skips straight to the next ready work item.
- `pnpm harness:worker:stop -- --target <target-id>` interrupts the worker and marks the harness state as interrupted.

By default, the worker now keeps moving through consecutive ready work items:

- after a successful cycle, the adapter marks the completed work item as `verified`
- the worker immediately looks for the next ready case or task
- the worker exits only when there is no ready work left, or when a cycle fails or is interrupted

If you start the worker with `--task <task-id>`, it stays one-shot and only runs that specific item.
