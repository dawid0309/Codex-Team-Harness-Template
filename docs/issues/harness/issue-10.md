# Issue #10: Replace repo-native stop loops with one-cycle harness worker policy

- Batch: batch2
- Status: landed
- Linked issues: [#7](https://github.com/dawid0309/Codex-Harness-Foundry/issues/7)

## Summary

Replace repo-native autonomous stop predicates with a single-cycle worker policy so the harness kernel stays generic.

## Repo Evidence

- The harness kernel already persists checkpoints and live state for each run.
- Repo-native stop predicates are specific to Foundry and should not be embedded in a generic harness worker.

## Implementation Notes

- Remove selected stop-condition fields from project.config.json.autonomy.
- Make each background worker run own one coherent harness cycle.
- Keep future continuation policy as an explicit harness feature rather than an implicit background loop.

## Closure Condition

- The background worker exits after one coherent harness cycle without any repo-native stop-condition configuration.
