$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

Write-Host "==> Compose AGENTS"
pnpm run compose:agents

Write-Host "==> Refresh task board"
pnpm run planner:refresh

Write-Host "==> Typecheck"
pnpm run typecheck

Write-Host "==> Smoke"
pnpm run smoke

Write-Host "Verification complete."
