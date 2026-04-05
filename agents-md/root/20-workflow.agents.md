<!-- agents-md: target=root, priority=80 -->
# Lead Agent Workflow

The main lead agent should operate in this order:

1. Read the milestones, task board, latest handoff, and latest review or verification notes.
2. If `ready` tasks exist, prioritize by dependency order and subsystem boundaries.
3. If no `ready` task exists, generate the next batch from the milestone blueprint.
4. After a builder finishes, run the shared verification gate.
5. Write the result back into the task board, handoff, and review or verification records.
6. Continue automatically unless a stop condition is reached.
