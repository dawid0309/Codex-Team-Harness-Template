import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const langfuseDir = path.join(root, "observability", "langfuse");
const composeFile = path.join(langfuseDir, "docker-compose.yml");
const envFile = path.join(langfuseDir, ".env");

function randomHex(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

function randomKey(prefix: "pk" | "sk") {
  return `${prefix}-lf-${randomHex(24)}`;
}

function randomPassword() {
  return randomBytes(18).toString("base64url");
}

function dockerComposeArgs(...args: string[]) {
  return ["compose", "--env-file", envFile, "-f", composeFile, "-p", "codex-harness-langfuse", ...args];
}

function runDocker(...args: string[]) {
  const result = spawnSync("docker", args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`Docker command failed with exit code ${result.status ?? "unknown"}.`);
  }
}

async function init() {
  await mkdir(langfuseDir, { recursive: true });
  if (existsSync(envFile)) {
    console.log(`Langfuse env already exists: ${path.relative(root, envFile)}`);
    console.log(await readFile(envFile, "utf8"));
    return;
  }

  const postgresPassword = randomPassword();
  const clickhousePassword = randomPassword();
  const redisAuth = randomPassword();
  const minioPassword = randomPassword();
  const publicKey = randomKey("pk");
  const secretKey = randomKey("sk");
  const userPassword = randomPassword();
  const content = [
    "NEXTAUTH_URL=http://localhost:3000",
    `NEXTAUTH_SECRET=${randomHex(32)}`,
    `SALT=${randomHex(16)}`,
    `ENCRYPTION_KEY=${randomHex(32)}`,
    "TELEMETRY_ENABLED=false",
    "",
    "POSTGRES_USER=postgres",
    `POSTGRES_PASSWORD=${postgresPassword}`,
    "POSTGRES_DB=postgres",
    `DATABASE_URL=postgresql://postgres:${postgresPassword}@postgres:5432/postgres`,
    "",
    "CLICKHOUSE_USER=clickhouse",
    `CLICKHOUSE_PASSWORD=${clickhousePassword}`,
    `LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY=${minioPassword}`,
    `LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY=${minioPassword}`,
    `LANGFUSE_S3_BATCH_EXPORT_SECRET_ACCESS_KEY=${minioPassword}`,
    "MINIO_ROOT_USER=minio",
    `MINIO_ROOT_PASSWORD=${minioPassword}`,
    `REDIS_AUTH=${redisAuth}`,
    "",
    "LANGFUSE_INIT_ORG_ID=codex-harness",
    "LANGFUSE_INIT_ORG_NAME=Codex Harness",
    "LANGFUSE_INIT_PROJECT_ID=codex-harness-foundry",
    "LANGFUSE_INIT_PROJECT_NAME=Codex Harness Foundry",
    `LANGFUSE_INIT_PROJECT_PUBLIC_KEY=${publicKey}`,
    `LANGFUSE_INIT_PROJECT_SECRET_KEY=${secretKey}`,
    "LANGFUSE_INIT_USER_EMAIL=admin@codex-harness.local",
    "LANGFUSE_INIT_USER_NAME=Codex Harness Admin",
    `LANGFUSE_INIT_USER_PASSWORD=${userPassword}`,
    "",
    "HARNESS_LANGFUSE_ENABLED=true",
    "LANGFUSE_BASE_URL=http://localhost:3000",
    `LANGFUSE_PUBLIC_KEY=${publicKey}`,
    `LANGFUSE_SECRET_KEY=${secretKey}`,
    "LANGFUSE_TRACING_ENVIRONMENT=local",
    "",
  ].join("\n");

  await writeFile(envFile, content, "utf8");
  console.log(`Created ${path.relative(root, envFile)}`);
  console.log("Langfuse UI: http://127.0.0.1:3000");
  console.log("Admin email: admin@codex-harness.local");
  console.log(`Admin password: ${userPassword}`);
  console.log(`Public key: ${publicKey}`);
}

async function status() {
  if (!existsSync(envFile)) {
    console.log("Langfuse is not initialized. Run `pnpm langfuse:init` first.");
    return;
  }
  runDocker(...dockerComposeArgs("ps"));
}

function openUi() {
  const url = "http://127.0.0.1:3000";
  if (process.platform === "win32") {
    execFileSync("powershell", ["-NoProfile", "-Command", `Start-Process '${url}'`]);
    return;
  }
  runDocker("compose", "version");
  console.log(url);
}

async function main() {
  const command = process.argv[2] ?? "status";
  if (command === "init") {
    await init();
    return;
  }
  if (!existsSync(envFile)) {
    throw new Error("Langfuse env is missing. Run `pnpm langfuse:init` first.");
  }
  switch (command) {
    case "up":
      runDocker(...dockerComposeArgs("up", "-d"));
      return;
    case "down":
      runDocker(...dockerComposeArgs("down"));
      return;
    case "logs":
      runDocker(...dockerComposeArgs("logs", "-f", "--tail", "120"));
      return;
    case "status":
      await status();
      return;
    case "open":
      openUi();
      return;
    default:
      throw new Error("Unknown command. Expected init, up, down, logs, status, or open.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
