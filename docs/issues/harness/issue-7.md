# Issue #7: Add background runtime controls for Codex CLI

- Batch: batch2
- Status: planned
- Linked issues: [#10](https://github.com/dawid0309/Codex-Harness-Foundry/issues/10)

## Summary

Provide start, status, stop, and resume commands for a Codex-CLI-specific background runtime so longer runs can be supervised from repo state.

## Repo Evidence

- The template already encodes planning state in planning/task-board.json and project.config.json.
- Codex CLI supports non-interactive exec and resume flows that can be wrapped by the template.

## Implementation Notes

- Add a runtime controller specific to codex exec and codex exec resume.
- Persist runtime status in ignored files under data/runtime/.
- Report thread id, process handles, heartbeats, stop condition, and latest result summary.

## Closure Condition

- Background runtime commands land and runtime state can be queried and controlled from the repo.

