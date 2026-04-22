# Harness Dashboard

Use this runbook when you want a local monitoring and control surface for registered harness targets.

## Command

```powershell
pnpm harness:dashboard
```

Optional flags:

```powershell
pnpm harness:dashboard -- --port 4784
pnpm harness:dashboard -- --manifest harness.manifest.json --targets-file harness.targets.json
```

## What It Shows

- registered targets from `harness.targets.json`
- target-scoped worker state, live state, and current phase
- current run id, case id, title, checkpoint, and summary
- worker stdout and stderr tail
- recent run history
- contract, execution, evaluation, and handoff artifacts for the selected run

## What It Can Control

- `start`
- `stop`
- `resume`
- `eval`

These actions reuse the same harness worker and engine entry points as the CLI commands. The dashboard is a local control surface, not a second orchestration path.
