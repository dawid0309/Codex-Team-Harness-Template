import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { elapsedSeconds } from "./time";
import type { CodexTerminalEventType } from "./types";

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
  skipGitRepoCheck?: boolean;
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
  turnCompleted: boolean;
  terminalEventType: CodexTerminalEventType;
  terminalEventAt: string | null;
};

type CodexFailureAnalysis = {
  message: string | null;
  retryable: boolean;
};

function detectCodexFailure(stdoutLog: string, stderrLog: string, lastMessage: string | null): CodexFailureAnalysis {
  const combined = `${stdoutLog}\n${stderrLog}\n${lastMessage ?? ""}`;
  const logonMatch = combined.match(/CreateProcessWithLogonW failed:\s*(\d+)/i);
  if (logonMatch) {
    return {
      message: `Codex shell access failed inside the Windows sandbox: CreateProcessWithLogonW failed: ${logonMatch[1]}.`,
      retryable: false,
    };
  }

  const sandboxMatch = combined.match(/windows sandbox:[^\r\n"]+/i);
  if (sandboxMatch) {
    return {
      message: `Codex shell access failed inside the Windows sandbox: ${sandboxMatch[0].trim()}.`,
      retryable: false,
    };
  }

  const gatewayMatch = combined.match(
    /unexpected status\s+(\d{3})\s+([^\r\n]*?)\s+url:\s*(http:\/\/127\.0\.0\.1:15721\/v1\/responses)/i,
  );
  if (gatewayMatch) {
    const [, statusCode, detail, url] = gatewayMatch;
    const retryable = statusCode === "401" || statusCode === "429" || statusCode.startsWith("5");
    return {
      message: `Codex local responses gateway returned ${statusCode}${detail ? ` ${detail.trim()}` : ""} (${url}).`,
      retryable,
    };
  }

  return {
    message: null,
    retryable: false,
  };
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

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function buildArgs(input: CodexRunInput) {
  const args: string[] = [];
  if (!input.threadId) {
    args.push("exec", "--json", "-C", input.repoRoot, "-s", input.sandboxMode);
    if (input.skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }
    if (input.model) {
      args.push("-m", input.model);
    }
    args.push("-o", input.lastMessageFile, "-");
    return args;
  }

  args.push("exec", "resume", input.threadId, "--json", "-o", input.lastMessageFile);
  if (input.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
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
  let terminalEventType: CodexTerminalEventType = null;
  let terminalEventAt: string | null = null;

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
        if (event.type === "turn.completed" || event.type === "turn.failed") {
          terminalEventType = event.type;
          terminalEventAt = new Date().toISOString();
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
  const failure = detectCodexFailure(attemptStdout, attemptStderr, lastMessage);

  return {
    exitCode,
    threadId: currentThreadId,
    lastMessage,
    failureReason: failure.message,
    retryableFailure: failure.retryable,
    terminalEventType,
    terminalEventAt,
  };
}

export async function runCodex(input: CodexRunInput): Promise<CodexRunOutput> {
  const gatewayRetryBackoffMs = [5_000, 10_000, 20_000];
  const start = Date.now();
  await mkdir(path.dirname(input.promptFile), { recursive: true });
  await mkdir(path.dirname(input.stdoutLog), { recursive: true });
  await mkdir(path.dirname(input.stderrLog), { recursive: true });
  await mkdir(path.dirname(input.lastMessageFile), { recursive: true });
  await writeFile(input.promptFile, input.prompt, "utf8");
  await writeFile(input.stdoutLog, "", "utf8");
  await writeFile(input.stderrLog, "", "utf8");
  await writeFile(input.lastMessageFile, "", "utf8");
  let result = await runCodexAttempt(input);
  let sandboxModeUsed = input.sandboxMode;
  let fallbackApplied = false;
  const fallbackSandboxMode = !input.threadId ? fallbackSandboxModeFor(input.sandboxMode) : null;

  if (
    fallbackSandboxMode &&
    fallbackSandboxMode !== input.sandboxMode &&
    isWindowsSandboxLogonFailure(result.failureReason)
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

  for (let index = 0; index < gatewayRetryBackoffMs.length; index += 1) {
    if (result.exitCode === 0 || !result.retryableFailure) {
      break;
    }

    const delayMs = gatewayRetryBackoffMs[index];
    await writeFile(
      input.stderrLog,
      `\n[Harness] Retrying Codex after retryable gateway failure in ${Math.floor(delayMs / 1000)}s.\n`,
      { encoding: "utf8", flag: "a" },
    );
    await sleep(delayMs);
    await writeFile(input.lastMessageFile, "", "utf8");
    result = await runCodexAttempt({
      ...input,
      sandboxMode: sandboxModeUsed,
      threadId: result.threadId,
    });
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
    turnCompleted: result.terminalEventType === "turn.completed",
    terminalEventType: result.terminalEventType ?? (result.exitCode === 0 ? "process_exit_only" : null),
    terminalEventAt: result.terminalEventAt,
  };
}
