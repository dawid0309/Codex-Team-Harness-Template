# Issue #7: Add background harness worker controls for Codex CLI

- Batch: batch2
- Status: landed
- Linked issues: [#10](https://github.com/dawid0309/Codex-Harness-Foundry/issues/10)

## Summary

Provide start, status, stop, and resume commands for a background harness worker so longer runs can be supervised through the generic harness kernel.

## Repo Evidence

- The harness kernel already defines run specs, contracts, evaluation artifacts, and live state.
- Codex CLI supports non-interactive exec and resume flows that can be wrapped by a worker process without reviving repo-native execution logic.

## Implementation Notes

- Add a worker controller around harness run and harness resume.
- Persist worker status in ignored files under data/harness/.
- Report run id, thread id, process handles, latest checkpoint, and latest result summary.

## Closure Condition

- Background harness worker commands land and worker state can be queried and controlled from the repo.
