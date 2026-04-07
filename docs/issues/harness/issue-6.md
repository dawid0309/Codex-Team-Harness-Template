# Issue #6: Make verification stages configurable from project config

- Batch: batch1
- Status: planned
- Linked issues: [#8](https://github.com/dawid0309/Codex-Harness-Foundry/issues/8), [#9](https://github.com/dawid0309/Codex-Harness-Foundry/issues/9)

## Summary

Move the fixed verify pipeline into project.config.json so downstream repos can keep one canonical verify command while tailoring stages.

## Repo Evidence

- scripts/verify.ps1 currently hardcodes the stage order and commands.
- project.config.json already acts as the template's main repo-native source of truth.

## Implementation Notes

- Add project.config.json.verification.stages with id, label, command, and enabled.
- Replace the PowerShell implementation with a thin entrypoint that calls a TypeScript runner.
- Keep the current five stages as defaults so the existing template flow stays intact.

## Closure Condition

- Config-backed verification stages land and pnpm verify reproduces the current default behavior.

