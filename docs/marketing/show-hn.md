# Show HN: Codex Harness Foundry

## Suggested Title

`Show HN: Codex Harness Foundry - a repo-native Codex workbench for long-running projects`

## Post Body

I built Codex Harness Foundry because I kept running into the same problem with AI coding workflows:

they start strong, but once a project becomes multi-step and long-running, too much state lives in chat instead of the repository.

Codex Harness Foundry is an open-source template that turns a repo into a Codex workbench with:

- repo-native context
- milestone planning
- task orchestration
- planner / builder / verifier role boundaries
- a shared verification path

The goal is not to create a generic agent platform. The goal is to make Codex behave more like a small product team working from repo truth.

The workflow is intentionally simple:

```text
pnpm init:project
pnpm verify
pnpm planner:next
```

Under the hood, the repo keeps project identity, architecture, milestones, task board state, and generated `AGENTS.md` instructions in versioned files. Verification is a first-class step, not an optional cleanup pass.

I wrote it for cases where you want Codex to keep pushing through a real project over days or weeks, with handoffs and verification preserved in the repo.

If that problem sounds familiar, I would love feedback on:

1. whether the planner / builder / verifier split feels useful
2. what parts of the workflow still feel too manual
3. where this breaks down for your own projects

Repo:

`https://github.com/dawid0309/Codex-Harness-Foundry`

Template:

`https://github.com/dawid0309/Codex-Harness-Foundry/generate`

## Optional Shorter Variant

Built an open-source Codex workbench for long-running projects.

Instead of keeping AI workflow state in chat, it keeps project context, milestones, task board state, and verification in the repo itself.

It is opinionated around:

- repo-native context
- planner / builder / verifier roles
- milestone-driven progression
- a shared verify path

Would love feedback from people using Codex beyond one-off prompting.
