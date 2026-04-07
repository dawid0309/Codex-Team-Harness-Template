# Runtime Control Runbook

Use this runbook when you want Codex Harness Foundry to supervise a longer Codex CLI run from repository state.

## Commands

```powershell
pnpm runtime:start
pnpm runtime:status
pnpm runtime:stop
pnpm runtime:resume
```

These commands are intentionally Codex-CLI specific. The template uses `codex exec` for the first cycle and `codex exec resume` for follow-up cycles.

When the runtime needs new work published, the leader/orchestrator should request planner output with `pnpm planner:propose`, inspect `planning/planner-output.json`, and accept it with `pnpm planner:publish` instead of publishing tasks inline.

## Runtime State

Runtime state is stored in ignored files under `data/runtime/`.

- `data/runtime/codex-runtime-status.json`
- `data/runtime/codex-runtime-stdout.log`
- `data/runtime/codex-runtime-stderr.log`
- `data/runtime/codex-runtime-last-message.txt`

The status file records the runtime state, worker and child process ids, thread id, heartbeat, selected stop condition, runtime home, terminal blocker streak, and latest result summary.

Detached runs use a repo-scoped Codex home under `data/runtime/codex-home/`. This keeps the runtime from inheriting workstation-global Codex state, shell profiles, or unrelated local noise when it starts in the background.

## Structural Stop Conditions

Configure stop behavior in `project.config.json.autonomy.selectedStopCondition`.

Supported predicates:

- `active_milestone_no_ready_or_in_progress`
- `active_milestone_all_done`
- `issue_exports_present`
- `milestone_complete_and_issue_exports_present`

The runtime evaluates those predicates from repository state only:

- `planning/task-board.json`
- the configured issue export directory, which defaults to `docs/issues/harness/`
- the runtime status file in `data/runtime/`

This avoids relying on free-form completion text from the model.

## Terminal Blockers

Configure the blocker budget in `project.config.json.autonomy.maxConsecutiveTerminalBlockers`.

The runtime treats repeated unrecoverable conditions as terminal blockers, including:

- read-only workspace or sandbox restrictions
- approval or policy rejections
- required repo commands that are not executable

When the same blocker repeats for the configured number of cycles, the runtime moves to `blocked` instead of looping indefinitely. Use `pnpm runtime:resume` after fixing the underlying repo or policy constraint.
