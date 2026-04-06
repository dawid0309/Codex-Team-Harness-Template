# X Thread

## Thread Draft

### Post 1

I built **Codex Harness Foundry** because most AI coding workflows break down the moment a project stops being a one-off task.

Codex starts from chat memory.
Projects need repository truth.

Repo: https://github.com/dawid0309/Codex-Harness-Foundry

### Post 2

Codex Harness Foundry is an open-source Codex workbench with:

- repo-native context
- milestone planning
- task orchestration
- planner / builder / verifier boundaries
- a shared verification path

The goal is simple: make Codex behave more like a small product team.

### Post 3

Instead of relying on a long chat thread, the workflow state lives in files like:

- `project.config.json`
- `AGENTS.md`
- `planning/milestones.json`
- `planning/task-board.json`

That means the project can keep moving from repo state, not just conversation history.

### Post 4

The shortest demo flow is:

```text
pnpm init:project
pnpm verify
pnpm planner:next
```

That gets you from a fresh template to repo-aware instructions, a verified workflow, and a concrete next task.

### Post 5

What I wanted to avoid:

- ad hoc prompting
- disappearing handoffs
- no role boundaries
- "done" with no consistent verification path

Foundry is built for medium- to long-running projects where those problems start to matter.

### Post 6

It is probably a fit if you:

- use Codex across days or weeks, not just minutes
- want planner / builder / verifier separation
- want AI workflow state and verification evidence to live in the repo

It is probably *not* a fit if you only want one-off prompt coding.

### Post 7

If you want to try it:

- README: https://github.com/dawid0309/Codex-Harness-Foundry
- Use this template: https://github.com/dawid0309/Codex-Harness-Foundry/generate

Would especially love feedback from people running real projects with Codex.

## Short Thread Variant

I built **Codex Harness Foundry** to solve a problem I kept hitting with AI coding workflows:

they work from chat memory, but real projects need repository truth.

So this repo gives Codex:

- repo-native context
- milestone planning
- task orchestration
- planner / builder / verifier roles
- a real verify step

Shortest flow:

```text
pnpm init:project
pnpm verify
pnpm planner:next
```

Repo: https://github.com/dawid0309/Codex-Harness-Foundry
