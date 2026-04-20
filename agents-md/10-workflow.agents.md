<!-- agents-md: target=root, priority=90 -->
# Lead Agent Workflow

Every substantial request follows the same loop:

1. Read `docs/intent/current.md`, `planning/milestones.json`, and `planning/task-board.json`.
2. If no `ready` task exists, ask the planner for a proposal with `pnpm planner:propose`.
3. If the final milestone is fully verified and there is no later milestone blueprint, request `pnpm next-milestone:propose`.
4. Review `planning/planner-output.json` or `planning/next-milestone-output.json`, then accept the proposal with the matching publish command only if it matches repository truth.
5. Select the highest-value published `ready` task.
6. Implement only within the task's subsystem boundary.
7. Run `pnpm verify`.
8. Update task status, handoff notes, decision log, and any repo-first feedback artifacts.
9. Stop after one coherent harness cycle unless a human explicitly starts another worker cycle.
