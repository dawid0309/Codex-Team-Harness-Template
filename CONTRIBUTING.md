# Contributing

Thanks for improving the template.

## Before You Change Anything

1. Read `README.md` and `AGENTS.md`.
2. Check `planning/milestones.json` and `planning/task-board.json`.
3. Prefer the smallest verified change that improves the template.

## Local Setup

```powershell
pnpm install
pnpm verify
```

## Change Guidelines

- Keep the template opinionated, but not over-engineered.
- Preserve the planner -> builder -> verifier operating model.
- Update `agents-md/` fragments instead of hand-editing generated `AGENTS.md` files.
- If you change planning or workflow behavior, update the docs in the same pull request.
- If you expose a script in `package.json`, make sure it actually works and is documented.

## Verification

Run this before opening a pull request:

```powershell
pnpm verify
```

If your change affects the TypeScript scripts, also confirm:

```powershell
pnpm tasks:status
pnpm tasks:plan
```

## Pull Requests

Please include:

- a short summary of the problem and the chosen fix
- verification commands you ran
- any follow-up work that should happen in a later milestone
