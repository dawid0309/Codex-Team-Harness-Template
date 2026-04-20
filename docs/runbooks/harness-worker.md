# Harness Worker Runbook

Use this runbook when you want Codex Harness Foundry to supervise a longer Codex CLI run through the pure harness kernel.

## Commands

```powershell
pnpm harness:worker:start
pnpm harness:worker:status
pnpm harness:worker:stop
pnpm harness:worker:resume
```

These commands are background wrappers around the harness kernel. They do not contain repo-native planning logic on their own.

## Worker State

Worker state is stored in ignored files under `data/harness/`.

- `data/harness/worker-status.json`
- `data/harness/worker-stdout.log`
- `data/harness/worker-stderr.log`
- `data/harness/live-state.json`
- `data/harness/runs/<run-id>/`

The worker status file records the worker state, run id, adapter id, worker pid, thread id, latest checkpoint, and latest summary.

## Operating Model

- `harness.manifest.json` selects the adapter and execution strategy.
- `project.config.json.autonomy` provides prompt, sandbox, and model defaults.
- `pnpm harness:worker:start` launches one coherent harness cycle in the background.
- `pnpm harness:worker:resume` resumes a previous run from its checkpoint.
- `pnpm harness:worker:stop` interrupts the worker and marks the harness state as interrupted.

This worker intentionally does not loop on repo-specific stop predicates. Each background run owns one coherent cycle and then exits.
