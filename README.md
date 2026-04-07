# Codex Harness Foundry

[![CI](https://github.com/dawid0309/Codex-Harness-Foundry/actions/workflows/ci.yml/badge.svg)](https://github.com/dawid0309/Codex-Harness-Foundry/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Template Repository](https://img.shields.io/badge/template-ready-blue.svg)](https://github.com/dawid0309/Codex-Harness-Foundry/generate)

**An open-source Codex workbench that helps AI code like a small product team, with repo-native context, milestone planning, task orchestration, and verification built in.**

Chinese assist: a repo-native Codex workbench for long-running projects, with context, milestones, task orchestration, and verification built into the repository.

- Codex usually works from chat memory. Codex Harness Foundry makes it work from repository truth.
- Work moves through milestones, task cards, role boundaries, and verification instead of ad hoc prompting.
- Use it when you need Codex to keep shipping across a real project, not just generate one-off code.

[Use this template](https://github.com/dawid0309/Codex-Harness-Foundry/generate) | [Quick Start](#quick-start) | [Fork and Initialize](./docs/runbooks/fork-and-init.md)

## Problem And Why It Exists

Typical AI coding workflows keep critical context in chat, not in the repository.

- Context lives in chat history and ad hoc prompts.
- Task state is implicit, fragile, or manually reconstructed.
- Handoffs disappear once the conversation moves on.
- Verification is optional, so "done" is hard to trust or replay.

Codex Harness Foundry fixes that by storing context in repo files, advancing work through milestones and task cards, and enforcing a shared verify path.

- Repo-native context from `project.config.json`, `AGENTS.md`, architecture docs, milestones, and the task board.
- A planner -> builder -> verifier operating model with explicit ownership boundaries.
- Persistent execution state through milestone blueprints, task cards, and next-task recommendation.
- Verification as a first-class gate instead of a best-effort afterthought.

## How It Works

```mermaid
flowchart LR
    config["project.config.json"] --> init["pnpm init:project"]
    init --> agents["agents-md -> AGENTS.md"]
    init --> arch["docs/architecture/system.md"]
    arch --> milestones["planning/milestones.json"]
    milestones --> planner["planner proposal"]
    planner --> output["planning/planner-output.json"]
    output --> board["planning/task-board.json"]
    agents --> verify["pnpm verify"]
    board --> choose["planner / tasks scripts"]
    choose --> verify
    verify --> next["next task loop"]
    next --> planner
```

Codex Harness Foundry turns a repo into an operating surface for Codex: configure the project, generate repo-aware instructions, refresh task state, verify the workflow, and keep moving from the next recommended task.

## 30-Second Demo

![Codex Harness Foundry terminal demo](./docs/assets/readme/codex-harness-foundry-demo.gif)

Initialize a project, run verification, and get the next task from repo state. This is a repo-native workflow, not a chat screenshot.

```powershell
pnpm install
pnpm init:project -- --name "Demo Product" --slug "demo-product" --goal "Ship a verifiable Codex workflow" --stack "Next.js, TypeScript, pnpm" --owner "your-github-user" --repoName "demo-product"
pnpm verify
pnpm planner:next
```

The asset is stored in [`docs/assets/readme/`](./docs/assets/readme/). Regeneration notes live in [docs/runbooks/readme-demo.md](./docs/runbooks/readme-demo.md).

## Quick Start

1. Use [this template](https://github.com/dawid0309/Codex-Harness-Foundry/generate) or fork the repository.
2. Install dependencies:

```powershell
pnpm install
```

3. Initialize your project metadata:

```powershell
pnpm init:project
```

4. Run the standard workflow bootstrap:

```powershell
pnpm verify
pnpm planner:next
```

5. Export tracked issue drafts when you want repo-reviewed GitHub issue replies:

```powershell
pnpm issues:export
```

6. For deeper setup, follow the [fork and initialize runbook](./docs/runbooks/fork-and-init.md).

## Concrete Use Case

Imagine a solo builder or small team using Codex to push a 2-6 week product effort.

Before Foundry:

- Codex starts from chat memory instead of repository truth.
- Planner, builder, and reviewer behavior blend together in one long thread.
- Milestones, handoffs, and verification results are hard to preserve or replay.

With Foundry:

- The project identity, architecture, milestones, and task board live in the repo.
- Codex can operate with planner / builder / verifier boundaries instead of one undifferentiated loop.
- Verification, next-task recommendation, and role ownership stay visible across the whole project.

This is for teams who want Codex to keep progressing through a real software project, not just produce isolated code snippets.

## Who It's For / Not For

### It's For

- Teams or solo builders using Codex on medium- to long-running projects.
- People who want planner / builder / verifier separation instead of one mixed chat loop.
- Builders who want AI workflow state, decisions, and verification evidence to live in the repository.
- Anyone maintaining a reusable Codex operating template across multiple downstream repos.

### It's Not For

- One-off prompt coding or quick debugging sessions.
- Users who do not want repo-level process, milestones, or task tracking.
- Projects without a meaningful verification path.
- Teams looking for a generic autonomous agent platform rather than a Codex-centered delivery workflow.

## Compared With Typical AI Coding Workflows

| Dimension | Typical AI Coding Workflow | Codex Harness Foundry |
| --- | --- | --- |
| Source of context | Chat history and ad hoc prompts | Repo-native context from project config, `AGENTS.md`, architecture docs, milestones, and task board |
| Task tracking | Implicit or manual | Milestones, task blueprints, live task-board state, and next-task recommendation |
| Role boundaries | Single mixed workflow | Planner / builder / verifier operating model with explicit ownership |
| Verification | Optional and inconsistent | Standard verify flow: sync, compose `AGENTS.md`, refresh planner, typecheck, smoke |
| Handoff persistence | Mostly lost in chat | Designed to preserve context, handoffs, decisions, and review artifacts in the repo |
| Fit for long-running work | Weak once context grows | Built for repeatable, milestone-driven project progression |

## Commands

Start here:

- `pnpm init:project`
- `pnpm verify`
- `pnpm planner:next`
- `pnpm tasks:status`

Full reference:

| Command | Purpose |
| --- | --- |
| `pnpm init:project` | Interactively initialize a fork with its own project metadata and reset the task board |
| `pnpm sync:project` | Reapply `project.config.json` to the package metadata and core docs |
| `pnpm compose:agents` | Generate repo-local `AGENTS.md` files from `agents-md/` fragments |
| `pnpm planner:propose` | Generate a planner proposal artifact in `planning/planner-output.json` |
| `pnpm planner:publish` | Accept planner output into `planning/task-board.json` as leader/orchestrator |
| `pnpm planner:refresh` | Compatibility shortcut that runs `planner:propose` and `planner:publish` together |
| `pnpm planner:next` | Print the next recommended ready tasks |
| `pnpm tasks:plan` | Show the current actionable task plan |
| `pnpm tasks:status` | Show the task board summary and task list |
| `pnpm tasks:update -- <task-id> <status>` | Update a task status in `planning/task-board.json` |
| `pnpm issues:export` | Generate deterministic issue-response drafts into `docs/issues/harness/` |
| `pnpm smoke` | Validate that planning files are structurally usable |
| `pnpm typecheck` | Type-check the automation scripts |
| `pnpm verify` | Run the config-backed verification gate from `project.config.json.verification` |
| `pnpm runtime:start` | Start a Codex-CLI-specific background runtime |
| `pnpm runtime:status` | Inspect runtime state from `data/runtime/` |
| `pnpm runtime:stop` | Stop the background runtime and clear active process handles |
| `pnpm runtime:resume` | Resume a stopped, interrupted, failed, or blocked runtime session |

## Repository Layout

```text
agents/          Role briefs for planner, builders, and verifier
agents-md/       Source fragments used to compose repo-aware AGENTS.md files
docs/            Architecture notes, runbooks, templates, and experiment logs
planning/        Milestone definitions and live task-board state
scripts/         Planner, task, smoke, and verification scripts
src/             Product code for the real project built from this template
tests/           Automated tests and regression coverage
```

`planning/planner-output.json` is the planner-owned proposal artifact. `planning/task-board.json` remains the leader-approved execution state.

## FAQ

**Is this a framework?**

Not in the usual sense. It is a repo-native Codex operating template for context, planning, orchestration, and verification.

**Is this only for Codex?**

The repo is opinionated around Codex-style workflows and prompts, but the core ideas are portable if you want repo-native AI collaboration.

**Do I need multiple agents to use it?**

No. A solo builder can still use the planner / builder / verifier model as a disciplined workflow inside one project.

## Customizing the Template

At minimum, initialize the project and then review these files before using the template for a real product:

- `project.config.json`
- `docs/architecture/system.md`
- `planning/milestones.json`
- `agents-md/00-project.agents.md`
- `agents-md/30-product.agents.md`
- `agents/` role briefs if your team split differs from planner / UI / engine / content / verifier

If you derive a new product from this template, treat `src/` and `tests/` as the places for product code. Keep the planning and documentation structure intact so Codex can continue to operate from stable repo state.

## Verification Philosophy

`pnpm verify` is the baseline quality gate for every meaningful change. It is configured from `project.config.json.verification.stages`, where each stage defines:

- `id`
- `label`
- `command`
- `enabled`

The default template stages still:

1. syncs project metadata from `project.config.json`
2. recomposes `AGENTS.md`
3. refreshes the task board
4. type-checks the automation scripts
5. runs a smoke validation of the planning files

If you extend the template into a real product, add your app-specific checks to the same verification path rather than creating separate hidden gates.

## Issue Export Workflow

Issue planning notes can live in the repo and still export cleanly to GitHub-facing Markdown.

- Track observations in `docs/issues/harness-observations.json`
- Generate drafts with `pnpm issues:export`
- Review generated files in `docs/issues/harness/`
- Follow the [issue export runbook](./docs/runbooks/issues-export.md) when mapping drafts to GitHub issues

The template intentionally owns one source schema, one renderer, and one default export path so issue replies do not drift across multiple scripts.

## Runtime Control

For longer Codex CLI runs, the template can supervise a background session with structural stop conditions.

- Configure runtime behavior in `project.config.json.autonomy`
- Detached runs use a repo-scoped Codex home under `data/runtime/codex-home/` to avoid inheriting workstation-global Codex state
- Start with `pnpm runtime:start`
- Check state with `pnpm runtime:status`
- Stop or resume with `pnpm runtime:stop` and `pnpm runtime:resume`
- Set `autonomy.maxConsecutiveTerminalBlockers` if you want repeated policy or sandbox blockers to stop in `blocked` instead of looping
- Read the [runtime control runbook](./docs/runbooks/runtime-control.md) for the status file and stop-condition details

## Planner Publication Model

Foundry now separates planner publication from leader orchestration in repo-visible steps.

- The planner proposes task publication in `planning/planner-output.json`
- The leader/orchestrator reviews that artifact and accepts it into `planning/task-board.json`
- Builders consume published tasks only after leader acceptance
- `pnpm planner:refresh` remains as a compatibility shortcut for `planner:propose` plus `planner:publish`

## Maintenance

This repository includes the usual GitHub maintenance files for an open template repository:

- `LICENSE`
- `.github/workflows/ci.yml`
- issue and pull request templates
- `CONTRIBUTING.md`
- `SECURITY.md`
- `CHANGELOG.md`
- `.editorconfig` and `.gitattributes`

That means a forked project starts with a clearer collaboration baseline instead of having to add all of that later.
