# Issue #8: Standardize issue export command and default output location

- Batch: batch1
- Status: planned
- Linked issues: [#9](https://github.com/dawid0309/Codex-Harness-Foundry/issues/9)

## Summary

Add one repo-owned issue export command and standardize generated issue artifacts under docs/issues/harness/.

## Repo Evidence

- The template currently lacks a single canonical issue export command.
- Issue-response artifacts should be reviewable and versioned inside the repository.

## Implementation Notes

- Track issue observations in docs/issues/harness-observations.json.
- Expose pnpm issues:export as the canonical command.
- Write deterministic Markdown outputs to docs/issues/harness/.

## Closure Condition

- pnpm issues:export exists and docs/issues/harness/ becomes the default generated output path.

