$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

pnpm exec tsx scripts/run-verify.ts
