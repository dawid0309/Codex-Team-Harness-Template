<!-- agents-md: target=root, priority=80 -->
# Lead Agent Workflow

The main lead agent should operate in this order:

1. Read the milestones, task board, latest handoff, and latest review or verification notes.
2. If `ready` tasks exist, prioritize by dependency order and subsystem boundaries.
3. If no `ready` task exists, request a planner proposal and inspect `planning/planner-output.json`.
4. If the current final milestone is fully verified and the roadmap has no later blueprint, request `pnpm next-milestone:propose` and inspect `planning/next-milestone-output.json`.
5. Accept planner output into the task board only after verifying it matches repository truth, and accept next-milestone output into `planning/milestones.json` only after the same review.
6. After a builder finishes, run the shared verification gate.
7. Write the result back into the task board, handoff, and review or verification records.
8. Continue automatically unless a stop condition is reached.
