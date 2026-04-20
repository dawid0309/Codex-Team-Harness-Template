import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { elapsedSeconds } from "./time";

export type CodexRunInput = {
  repoRoot: string;
  prompt: string;
  promptFile: string;
  stdoutLog: string;
  stderrLog: string;
  lastMessageFile: string;
  sandboxMode: string;
  model: string | null;
  threadId: string | null;
};

export type CodexRunOutput = {
  exitCode: number;
  threadId: string | null;
  elapsedSeconds: number;
  lastMessage: string | null;
};

function codexCommand() {
  if (process.platform !== "win32") {
    return "codex";
  }

  try {
    const resolved = execFileSync("where.exe", ["codex.cmd"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (resolved) {
      return resolved;
    }
  } catch {
    // fall through
  }

  return "codex.cmd";
}

function buildArgs(input: CodexRunInput) {
  const args: string[] = [];
  if (!input.threadId) {
    args.push("exec", "--json", "-C", input.repoRoot, "-s", input.sandboxMode);
    if (input.model) {
      args.push("-m", input.model);
    }
    args.push("-o", input.lastMessageFile, "-");
    return args;
  }

  args.push("exec", "resume", input.threadId, "--json", "-o", input.lastMessageFile);
  if (input.model) {
    args.push("-m", input.model);
  }
  args.push("-");
  return args;
}

export async function runCodex(input: CodexRunInput): Promise<CodexRunOutput> {
  const start = Date.now();
  await mkdir(path.dirname(input.promptFile), { recursive: true });
  await mkdir(path.dirname(input.stdoutLog), { recursive: true });
  await mkdir(path.dirname(input.stderrLog), { recursive: true });
  await mkdir(path.dirname(input.lastMessageFile), { recursive: true });
  await writeFile(input.promptFile, input.prompt, "utf8");
  await writeFile(input.stdoutLog, "", "utf8");
  await writeFile(input.stderrLog, "", "utf8");
  await writeFile(input.lastMessageFile, "", "utf8");

  const child = spawn(codexCommand(), buildArgs(input), {
    cwd: input.repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : false,
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdin.end(input.prompt);

  let currentThreadId = input.threadId;
  let stdoutBuffer = "";

  child.stdout.on("data", async (chunk: string) => {
    stdoutBuffer += chunk;
    await writeFile(input.stdoutLog, chunk, { encoding: "utf8", flag: "a" });
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const event = JSON.parse(trimmed) as { type?: string; thread_id?: string };
        if (event.type === "thread.started" && event.thread_id) {
          currentThreadId = event.thread_id;
        }
      } catch {
        // plain-text line; ignore
      }
    }
  });

  child.stderr.on("data", async (chunk: string) => {
    await writeFile(input.stderrLog, chunk, { encoding: "utf8", flag: "a" });
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

  const lastMessage = existsSync(input.lastMessageFile)
    ? (await readFile(input.lastMessageFile, "utf8")).trim() || null
    : null;

  return {
    exitCode,
    threadId: currentThreadId,
    elapsedSeconds: elapsedSeconds(start),
    lastMessage,
  };
}
