# Issue #14: Detached runtime inherits global shell and Codex state noise

- Batch: followup
- Status: landed
- Linked issues: [#15](https://github.com/dawid0309/Codex-Harness-Foundry/issues/15)

## Summary

Isolate detached Codex runtime sessions inside a repo-scoped Codex home so background runs do not inherit workstation-global shell state, Codex config noise, or unrelated local integrations.

## Repo Evidence

- Detached runtime sessions previously inherited the operator's global shell and Codex environment.
- Background runs should be reproducible from repository state instead of depending on machine-specific profiles or global Codex state.

## Implementation Notes

- Create a repo-scoped runtime home under data/runtime/codex-home and write a filtered config.toml for detached runs.
- Sanitize inherited environment variables so CODEX_HOME, HOME, and USERPROFILE point at the runtime home.
- Force detached Codex exec runs to use shell_environment_policy.inherit=none so background cycles start from repo-scoped state.

## Closure Condition

- Detached runtime sessions run from a repo-scoped Codex home and stop inheriting workstation-global shell or Codex state noise.

