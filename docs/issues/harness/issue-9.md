# Issue #9: Remove exporter drift with one canonical renderer and path

- Batch: batch1
- Status: planned
- Linked issues: [#8](https://github.com/dawid0309/Codex-Harness-Foundry/issues/8)

## Summary

Resolve exporter inconsistency by making the template own one schema, one renderer, and one output path for issue artifacts.

## Repo Evidence

- Exporter drift usually comes from duplicated formatting logic and multiple destination conventions.
- A template-level canonical renderer is the cleanest way to keep downstream exports aligned.

## Implementation Notes

- Reuse a single markdown renderer inside scripts/issues-export.ts.
- Generate both per-issue drafts and an index from the same source schema.
- Treat this as resolved together with #8 unless a separate downstream integration requirement appears.

## Closure Condition

- The template uses one canonical issue export pipeline with a single renderer and default path.

