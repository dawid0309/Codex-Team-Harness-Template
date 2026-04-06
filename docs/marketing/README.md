# Launch Kit

This folder contains copy-ready launch materials for Codex Harness Foundry.

## Included Assets

- `show-hn.md`: a launch post for Hacker News
- `x-thread.md`: an English-first thread for X / Twitter
- `launch-post-zh.md`: a Chinese launch post for developer communities

## Positioning Anchor

Use this core framing consistently:

- Codex usually works from chat memory. Codex Harness Foundry makes it work from repository truth.
- Work moves through milestones, task cards, role boundaries, and verification instead of ad hoc prompting.
- It is built for medium- to long-running projects, not just one-off code generation.

## Proof Points To Reuse

Ground outward-facing copy in repo-visible facts:

- `project.config.json` is the project identity source of truth
- `agents-md` composes repo-aware `AGENTS.md`
- `planning/milestones.json` and `planning/task-board.json` persist execution state
- `pnpm verify` runs sync, compose, planner refresh, typecheck, and smoke
- `pnpm planner:next` recommends the next ready task from repo state

## Posting Guidance

- Lead with the problem before the feature list.
- Keep the first paragraph concrete and easy to quote.
- Link directly to the README and template URL.
- If the audience is technical, mention the `pnpm init:project -> pnpm verify -> pnpm planner:next` flow.
- Do not position the project as a hosted product or autonomous agent platform.
