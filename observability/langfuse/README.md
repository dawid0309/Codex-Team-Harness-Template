# Local Langfuse

This directory holds the local Langfuse stack used by the harness observability exporter.

```powershell
pnpm langfuse:init
pnpm langfuse:up
pnpm langfuse:status
pnpm langfuse:open
```

The generated `.env` file is intentionally ignored. It contains:

- Langfuse init organization, project, and user credentials
- local service secrets for Postgres, ClickHouse, Redis, and MinIO
- harness exporter variables: `HARNESS_LANGFUSE_ENABLED`, `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`

After startup, open `http://127.0.0.1:3000` and sign in with the generated admin user printed by `pnpm langfuse:init`.
