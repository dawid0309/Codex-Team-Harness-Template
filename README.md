# Codex Team Harness Template

`Codex-Team-Harness-Template` is a reusable repository scaffold for running Codex like a small product team instead of a single chat thread. It gives a new project shared agent context, a milestone-driven task board, branch conventions, and a repeatable verification gate.

## What This Template Includes

- `agents-md/` sources for composing repo-aware `AGENTS.md` instructions
- `planning/milestones.json` and `planning/task-board.json` for milestone and task orchestration
- `scripts/lead-planner.ts` for refreshing and recommending the next ready task
- `scripts/verify.ps1` as the standard verification gate
- `docs/` templates for architecture notes, handoffs, reviews, and experiment logs
- Git and branch conventions for milestone work and experiments

## Who This Is For

Use this template when you want Codex to:

- start from repository truth instead of ad hoc chat memory
- coordinate multiple roles such as planner, builder, and verifier
- keep long-running work visible through milestones and task cards
- preserve decisions, handoffs, and verification evidence inside the repo

## Quick Start

1. Copy or fork this repository for your new project.
2. Replace the placeholders in the documentation:
   - `__PROJECT_NAME__`
   - `__PROJECT_GOAL__`
   - `__STACK__`
3. Install dependencies:

```powershell
pnpm install
```

4. Compose the generated agent instructions:

```powershell
pnpm compose:agents
```

5. Refresh the task board and inspect the next ready tasks:

```powershell
pnpm planner:refresh
pnpm planner:next
```

6. Use Codex against the repo with high-level prompts such as:
   - `Continue the current milestone`
   - `Open an experiment branch for this approach`
   - `Summarize the verified tasks and propose the next slice`

## Daily Working Loop

The intended operating loop is:

`read AGENTS -> refresh task board -> pick highest-value ready task -> implement -> verify -> update handoff/task board -> continue`

The template is intentionally opinionated: it favors small verified slices, clear ownership boundaries, and a written trail of decisions.

## Repository Layout

```text
agents/          Role briefs for planner, builders, and verifier
agents-md/       Source fragments used to compose AGENTS.md files
docs/            Architecture notes, runbooks, templates, and experiment logs
planning/        Milestone definitions and live task board state
scripts/         Planner, task, smoke, and verification scripts
src/             Product code for the real project built from this template
tests/           Automated tests and regression coverage
```

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm compose:agents` | Generate repo-local `AGENTS.md` files from `agents-md/` fragments |
| `pnpm planner:refresh` | Rebuild the active milestone view and unlock ready tasks |
| `pnpm planner:next` | Print the next recommended ready tasks |
| `pnpm tasks:plan` | Show the current actionable task plan |
| `pnpm tasks:status` | Show the task board summary and task list |
| `pnpm tasks:update -- <task-id> <status>` | Update a task status in `planning/task-board.json` |
| `pnpm smoke` | Validate that planning files are structurally usable |
| `pnpm typecheck` | Type-check the TypeScript automation scripts |
| `pnpm verify` | Run the standard verification gate |

## Customizing the Template

At minimum, update these files before using the template for a real product:

- `docs/architecture/system.md`
- `planning/milestones.json`
- `agents-md/00-project.agents.md`
- `agents-md/30-product.agents.md`
- `agents/` role briefs if your team split differs from planner / UI / engine / content / verifier

If you derive a new product from this template, treat `src/` and `tests/` as the places for product code. Keep the planning and documentation structure intact so Codex can continue to operate from stable repo state.

## Verification Philosophy

`pnpm verify` is the baseline quality gate for every meaningful change. In this template it:

1. recomposes `AGENTS.md`
2. refreshes the task board
3. type-checks the automation scripts
4. runs a smoke validation of the planning files

If you extend the template into a real product, add your app-specific checks to the same verification path rather than creating separate hidden gates.

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
