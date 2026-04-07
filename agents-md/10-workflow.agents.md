<!-- agents-md: target=root, priority=90 -->
# Lead Agent Workflow

Every substantial request follows the same loop:

1. Read `planning/milestones.json` and `planning/task-board.json`.
2. If no `ready` task exists, ask the planner for a proposal with `pnpm planner:propose`.
3. If the final milestone is fully verified and `planning/planner-output.json` has nothing left to publish, request `pnpm next-milestone:propose`.
4. Review `planning/planner-output.json` or `planning/next-milestone-output.json`, then accept the proposal with the matching publish command if it matches repository truth.
5. Select the highest-value `ready` task.
6. Implement only within the task's subsystem boundary.
7. Run `pnpm verify`.
8. Update task status, handoff notes, and decision log.
9. Continue unless a stop condition is hit.
