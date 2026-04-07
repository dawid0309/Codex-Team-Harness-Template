# Issue #17: Propose the next milestone when the final milestone is fully verified

- Batch: followup
- Status: landed
- Linked issues: [#12](https://github.com/dawid0309/Codex-Harness-Foundry/issues/12)

## Summary

Add a separate repo-native next-milestone proposal flow so the roadmap can extend itself once the current final milestone is fully verified, without expanding the ordinary planner's task-publication authority.

## Repo Evidence

- The ordinary planner only publishes tasks from milestone blueprints that already exist in planning/milestones.json.
- When the final milestone is fully complete, planner-output can become empty even though the repository still needs a structured way to propose the next iteration.

## Implementation Notes

- Add planning/next-milestone-output.json plus pnpm next-milestone:propose and pnpm next-milestone:publish.
- Allow proposals only when the active final milestone is fully verified and there is no later milestone blueprint.
- Keep leader acceptance explicit by writing the proposed milestone into planning/milestones.json only after publish, then let the ordinary planner publish the new milestone's tasks.

## Closure Condition

- The repo can generate and accept a next milestone proposal after the current final milestone is fully verified, and the workflow is documented for orchestrator use.

