# Runtime Control Runbook

Use this runbook when you want Codex Harness Foundry to supervise a longer Codex CLI run from repository state.

## Commands

```powershell
pnpm runtime:start
pnpm runtime:status
pnpm runtime:stop
pnpm runtime:resume
pnpm runtime:supervise
pnpm runtime:supervise:status
pnpm runtime:supervise:stop
pnpm runtime:watch
```

These commands are intentionally Codex-CLI specific. The template uses `codex exec` for the first cycle and `codex exec resume` for follow-up cycles.

- `runtime:start` and `runtime:resume` control the inner detached runtime worker.
- `runtime:supervise` adds an outer watchdog that can relaunch interrupted or failed runtime workers.
- `runtime:watch` renders both status layers and optional downstream project status output.

When the runtime needs new work published, the leader/orchestrator should request planner output with `pnpm planner:propose`, inspect `planning/planner-output.json`, and accept it with `pnpm planner:publish` instead of publishing tasks inline.

If the active final milestone is fully verified and no later milestone blueprint exists, the orchestrator should switch to `pnpm next-milestone:propose`, inspect `planning/next-milestone-output.json`, and accept it with `pnpm next-milestone:publish` before asking the ordinary planner to publish tasks from the new milestone.

## Runtime State

Runtime state is stored in ignored files under `data/runtime/`.

- `data/runtime/codex-runtime-status.json`
- `data/runtime/codex-runtime-stdout.log`
- `data/runtime/codex-runtime-stderr.log`
- `data/runtime/codex-runtime-last-message.txt`
- `data/runtime/supervisor-status.json`

The runtime status file records the runtime state, worker and child process ids, thread id, heartbeat, selected stop condition, runtime home, terminal blocker streak, effective detached sandbox mode, whether the last cycle executed a repo-local command, the last post-iteration hook result, and the latest result summary.

The supervisor status file records the outer watchdog state, restart counters, next launch time, last launch command, and the latest observed runtime pid/thread.

Detached runs use a repo-scoped Codex home under `data/runtime/codex-home/`. This keeps the runtime from inheriting workstation-global Codex state, shell profiles, or unrelated local noise when it starts in the background.

On Windows, detached runtime sessions keep the real profile directories intact. When the configured detached sandbox is `workspace-write`, the runtime falls back to `danger-full-access` for the detached Codex process so shell startup can reach repo commands reliably.

## Harness Config

Generic watchdog and hook behavior lives in `harness.config.json`.

```json
{
  "supervisor": {
    "childCommand": null,
    "workdir": ".",
    "pollIntervalSeconds": 5,
    "restartBackoffSeconds": 10,
    "maxRestartsPerHour": 12
  },
  "hooks": {
    "postIterationCommand": null,
    "projectStatusCommand": null
  }
}
```

- `supervisor.childCommand`: optional override if a downstream repo wants the watchdog to launch a custom command instead of the default `runtime:start` / `runtime:resume` decision.
- `supervisor.workdir`: working directory for the launched child command.
- `supervisor.pollIntervalSeconds`: how often the watchdog refreshes status and checks runtime liveness.
- `supervisor.restartBackoffSeconds`: wait time before retrying a failed launch.
- `supervisor.maxRestartsPerHour`: hard cap that stops the watchdog instead of looping forever on repeated failures.
- `hooks.postIterationCommand`: optional command that runs after each completed runtime cycle. Use this for downstream planner/status refresh logic.
- `hooks.projectStatusCommand`: optional command whose stdout is shown in `pnpm runtime:watch`.

## Downstream Hooks

Keep project-specific behavior in downstream repos, not in the template core.

Recommended pattern:

1. Keep project-specific planner/status logic in repo-local scripts or package commands.
2. Point `hooks.postIterationCommand` at the downstream planner/status refresh sequence.
3. Point `hooks.projectStatusCommand` at the downstream status command that prints exactly the fields operators should watch.

That gives downstream repos richer visibility without hardcoding milestone schemas, product names, or repo paths into Foundry.

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

- shell startup failures before any repo-local command can run
- read-only workspace or sandbox restrictions
- approval or policy rejections
- required repo commands that are not executable

Classification is precedence-aware: explicit policy rejection and helper-launch failures are reported before generic read-only or write-capability wording so runtime status reflects the upstream blocker more accurately.

The runtime also refuses to report `completed` when a cycle exits before any repo-local command executes, even if the structural stop predicate already evaluates true.

When the same blocker repeats for the configured number of cycles, the runtime moves to `blocked` instead of looping indefinitely. Use `pnpm runtime:resume` after fixing the underlying repo or policy constraint.
