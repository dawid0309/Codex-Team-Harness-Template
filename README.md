# Codex Harness Foundry

`Codex-Harness-Foundry` is a reusable repository scaffold for running Codex like a small product team instead of a single chat thread. It gives a new project shared agent context, a milestone-driven task board, branch conventions, and a repeatable verification gate.

For this repository itself, the source of truth for project identity lives in [`project.config.json`](./project.config.json). Forked projects can initialize their own name, goal, stack, and repository metadata with one command.

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

1. Use GitHub's `Use this template` button or fork this repository.
2. Install dependencies:

```powershell
pnpm install
```

3. Initialize the fork with your own project identity:

```powershell
pnpm init:project
```

Or provide values directly:

```powershell
pnpm init:project -- --name "My Product" --slug "my-product" --goal "Ship a verifiable Codex workflow" --stack "Next.js, TypeScript, pnpm" --owner "your-github-user" --repoName "my-product"
```

4. Run the standard verification and bootstrap flow:

```powershell
pnpm verify
```

5. Use Codex against the repo with high-level prompts such as:
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
| `pnpm init:project` | Interactively initialize a fork with its own project metadata and reset the task board |
| `pnpm sync:project` | Reapply `project.config.json` to the package metadata and core docs |
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

At minimum, initialize the project and then review these files before using the template for a real product:

- `project.config.json`
- `docs/architecture/system.md`
- `planning/milestones.json`
- `agents-md/00-project.agents.md`
- `agents-md/30-product.agents.md`
- `agents/` role briefs if your team split differs from planner / UI / engine / content / verifier

If you derive a new product from this template, treat `src/` and `tests/` as the places for product code. Keep the planning and documentation structure intact so Codex can continue to operate from stable repo state.

## Verification Philosophy

`pnpm verify` is the baseline quality gate for every meaningful change. In this template it:

1. syncs project metadata from `project.config.json`
2. recomposes `AGENTS.md`
3. refreshes the task board
4. type-checks the automation scripts
5. runs a smoke validation of the planning files

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

## Fork Workflow

The recommended downstream workflow is:

1. create a repo from this template
2. run `pnpm init:project`
3. review the generated `docs/architecture/system.md`
4. rewrite `planning/milestones.json` for your actual product
5. run `pnpm verify`
6. start your first Codex milestone
