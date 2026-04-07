# Issue Export Runbook

Use this runbook when you want to turn tracked issue observations into reviewable Markdown drafts before posting or updating GitHub issues.

## Source Of Truth

- Source observations live in `docs/issues/harness-observations.json`.
- Generated issue drafts live in `docs/issues/harness/`.
- The canonical export command is `pnpm issues:export`.

This keeps issue planning notes versioned in the repository while making the generated GitHub-facing output deterministic.

## Recommended Flow

1. Update `docs/issues/harness-observations.json`.
2. Run:

```powershell
pnpm issues:export
```

3. Review the generated Markdown files in `docs/issues/harness/`.
4. Copy the relevant draft into the corresponding GitHub issue or PR comment.

## Output Convention

- `docs/issues/harness/README.md` provides the generated index.
- `docs/issues/harness/issue-<number>.md` provides one draft per issue.

Treat `docs/issues/harness/` as the default location for generated issue-response artifacts in this template.
