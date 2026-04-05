<!-- agents-md: target=root, priority=80 -->
# Orchestrator Loop

- Keep one main thread as the orchestrator.
- After any high-level user goal, read `planning/task-board.json` first.
- Run `pnpm planner:refresh`, then use `pnpm planner:next` to choose the next task.
- Every completed task must pass `pnpm verify` before it counts as done.
