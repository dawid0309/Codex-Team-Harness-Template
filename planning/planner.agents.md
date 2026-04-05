<!-- agents-md: target=nearest, priority=80 -->
# Planning Rules

- `planning/milestones.json` is the blueprint for staged delivery.
- `planning/task-board.json` is the live execution state.
- The lead planner should unblock blockers first, then dependencies, then the core path.
- When `ready` is empty, generate the next task batch from the milestone blueprint instead of waiting for a user prompt.
