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
  onThreadStarted?: (threadId: string) => Promise<void> | void;
  onEvent?: (event: Record<string, unknown>) => Promise<void> | void;
};

export type CodexRunOutput = {
  exitCode: number;
  threadId: string | null;
  elapsedSeconds: number;
  lastMessage: string | null;
  failureReason: string | null;
  sandboxModeRequested: string;
  sandboxModeUsed: string;
  fallbackApplied: boolean;
};

function detectCodexFailure(stdoutLog: string, stderrLog: string, lastMessage: string | null) {
  const combined = `${stdoutLog}\n${stderrLog}\n${lastMessage ?? ""}`;
  const logonMatch = combined.match(/CreateProcessWithLogonW failed:\s*(\d+)/i);
  if (logonMatch) {
    return `Codex shell access failed inside the Windows sandbox: CreateProcessWithLogonW failed: ${logonMatch[1]}.`;
  }

  const sandboxMatch = combined.match(/windows sandbox:[^\r\n"]+/i);
  if (sandboxMatch) {
    return `Codex shell access failed inside the Windows sandbox: ${sandboxMatch[0].trim()}.`;
  }

  return null;
}

function isWindowsSandboxLogonFailure(failureReason: string | null) {
  return !!failureReason && /CreateProcessWithLogonW failed:\s*1326/i.test(failureReason);
}

function fallbackSandboxModeFor(mode: string) {
  if (process.platform === "win32" && mode === "workspace-write") {
    return "danger-full-access";
  }
  return null;
}

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

async function runCodexAttempt(input: CodexRunInput) {
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
  let attemptStdout = "";
  let attemptStderr = "";

  child.stdout.on("data", async (chunk: string) => {
    attemptStdout += chunk;
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
        void input.onEvent?.(event);
        if (event.type === "thread.started" && event.thread_id) {
          currentThreadId = event.thread_id;
          void input.onThreadStarted?.(event.thread_id);
        }
      } catch {
        // plain-text line; ignore
      }
    }
  });

  child.stderr.on("data", async (chunk: string) => {
    attemptStderr += chunk;
    await writeFile(input.stderrLog, chunk, { encoding: "utf8", flag: "a" });
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

  const lastMessage = existsSync(input.lastMessageFile)
    ? (await readFile(input.lastMessageFile, "utf8")).trim() || null
    : null;
  const failureReason = detectCodexFailure(attemptStdout, attemptStderr, lastMessage);

  return {
    exitCode,
    threadId: currentThreadId,
    lastMessage,
    failureReason,
  };
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
  const initialResult = await runCodexAttempt(input);
  let result = initialResult;
  let sandboxModeUsed = input.sandboxMode;
  let fallbackApplied = false;
  const fallbackSandboxMode = !input.threadId ? fallbackSandboxModeFor(input.sandboxMode) : null;

  if (
    fallbackSandboxMode &&
    fallbackSandboxMode !== input.sandboxMode &&
    isWindowsSandboxLogonFailure(initialResult.failureReason)
  ) {
    fallbackApplied = true;
    await writeFile(
      input.stderrLog,
      `\n[Harness] Retrying Codex with sandbox "${fallbackSandboxMode}" after Windows sandbox logon failure in "${input.sandboxMode}".\n`,
      { encoding: "utf8", flag: "a" },
    );
    await writeFile(input.lastMessageFile, "", "utf8");
    result = await runCodexAttempt({
      ...input,
      sandboxMode: fallbackSandboxMode,
    });
    sandboxModeUsed = fallbackSandboxMode;
  }

  return {
    exitCode: result.exitCode,
    threadId: result.threadId,
    elapsedSeconds: elapsedSeconds(start),
    lastMessage: result.lastMessage,
    failureReason: result.failureReason,
    sandboxModeRequested: input.sandboxMode,
    sandboxModeUsed,
    fallbackApplied,
  };
}
