# Issue #10: Use structural stop conditions for autonomy

- Batch: batch2
- Status: planned
- Linked issues: [#7](https://github.com/dawid0309/Codex-Harness-Foundry/issues/7)

## Summary

Make autonomous stopping decisions from repository state instead of free-form text heuristics.

## Repo Evidence

- planning/task-board.json already exposes milestone and task states that can drive stop predicates.
- Issue export artifacts can be verified structurally by checking the generated directory.

## Implementation Notes

- Add project.config.json.autonomy with the selected stop condition.
- Evaluate stop predicates against planning/task-board.json and docs/issues/harness/.
- Implement stop logic together with the Codex CLI runtime controller.

## Closure Condition

- The runtime can stop from configured repo-state predicates without relying on natural-language completion detection.

