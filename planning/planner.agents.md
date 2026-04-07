<!-- agents-md: target=nearest, priority=80 -->
# Planning Rules

- `planning/milestones.json` is the blueprint for staged delivery.
- `planning/task-board.json` is the live execution state.
- `planning/planner-output.json` is the planner artifact proposed for leader review.
- `planning/next-milestone-output.json` is the roadmap-extension artifact proposed for leader review when the final milestone is complete.
- The planner should unblock blockers first, then dependencies, then the core path.
- When `ready` is empty, generate the next publication proposal from the milestone blueprint instead of writing directly to the task board.
- When the active final milestone is fully verified and no later blueprint exists, generate a next-milestone proposal instead of extending the roadmap inline.
