import { spawn } from "node:child_process";

import { elapsedSeconds } from "./time";

export type CommandResult = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  elapsedSeconds: number;
};

export async function runShellCommand(command: string, cwd: string): Promise<CommandResult> {
  const start = Date.now();
  const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
  const child = spawn(shell, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  return {
    command,
    exitCode,
    stdout,
    stderr,
    elapsedSeconds: elapsedSeconds(start),
  };
}
