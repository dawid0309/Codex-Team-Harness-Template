# Issue #15: Runtime keeps looping after repeated unrecoverable blockers

- Batch: followup
- Status: landed
- Linked issues: [#14](https://github.com/dawid0309/Codex-Harness-Foundry/issues/14)

## Summary

Detect terminal blockers from runtime event output and stop background sessions in a blocked state after the configured retry budget instead of letting them spin indefinitely.

## Repo Evidence

- Codex CLI emits policy and sandbox failures inside stdout JSON event payloads, not just in the last assistant message.
- Without structural blocker tracking, the runtime can repeat the same unrecoverable failure across multiple cycles.

## Implementation Notes

- Inspect command_execution event output from the runtime stdout stream when classifying blockers.
- Track consecutive blocker signatures in runtime status and expose the configured retry budget in project.config.json.autonomy.maxConsecutiveTerminalBlockers.
- Move the runtime to blocked after the same terminal blocker repeats for the configured number of cycles, then allow resume once the operator fixes the constraint.

## Closure Condition

- Repeated unrecoverable blockers are detected from runtime event output and transition the runtime to blocked instead of looping.

