<!-- agents-md: target=root, priority=80 -->
# Orchestrator Loop

- Keep one main thread as the orchestrator.
- After any high-level user goal, read `planning/task-board.json` first.
- Request planner output with `pnpm planner:propose`, inspect `planning/planner-output.json`, then accept it with `pnpm planner:publish`.
- If the active final milestone is fully verified and there is no later blueprint, request `pnpm next-milestone:propose`, inspect `planning/next-milestone-output.json`, then accept it with `pnpm next-milestone:publish`.
- Use `pnpm planner:next` to choose the next published task.
- Every completed task must pass `pnpm verify` before it counts as done.
