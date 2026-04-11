import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { root } from "./project-config";

export type HarnessSupervisorConfig = {
  childCommand: string | null;
  workdir: string;
  pollIntervalSeconds: number;
  restartBackoffSeconds: number;
  maxRestartsPerHour: number;
};

export type HarnessHooksConfig = {
  postIterationCommand: string | null;
  projectStatusCommand: string | null;
};

export type HarnessConfig = {
  supervisor: HarnessSupervisorConfig;
  hooks: HarnessHooksConfig;
};

export const harnessConfigPath = path.join(root, "harness.config.json");

function normalizeCommand(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSeconds(value: unknown, fallback: number, minimum = 1): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(Math.round(numeric), minimum);
}

export function defaultHarnessConfig(): HarnessConfig {
  return {
    supervisor: {
      childCommand: null,
      workdir: ".",
      pollIntervalSeconds: 5,
      restartBackoffSeconds: 10,
      maxRestartsPerHour: 12,
    },
    hooks: {
      postIterationCommand: null,
      projectStatusCommand: null,
    },
  };
}

function applyHarnessDefaults(input: Partial<HarnessConfig> | null | undefined): HarnessConfig {
  const defaults = defaultHarnessConfig();
  const supervisor: Partial<HarnessSupervisorConfig> = input?.supervisor ?? {};
  const hooks: Partial<HarnessHooksConfig> = input?.hooks ?? {};

  return {
    supervisor: {
      childCommand: normalizeCommand(supervisor.childCommand),
      workdir:
        typeof supervisor.workdir === "string" && supervisor.workdir.trim().length > 0
          ? supervisor.workdir.trim()
          : defaults.supervisor.workdir,
      pollIntervalSeconds: normalizeSeconds(
        supervisor.pollIntervalSeconds,
        defaults.supervisor.pollIntervalSeconds,
      ),
      restartBackoffSeconds: normalizeSeconds(
        supervisor.restartBackoffSeconds,
        defaults.supervisor.restartBackoffSeconds,
      ),
      maxRestartsPerHour: normalizeSeconds(
        supervisor.maxRestartsPerHour,
        defaults.supervisor.maxRestartsPerHour,
      ),
    },
    hooks: {
      postIterationCommand: normalizeCommand(hooks.postIterationCommand),
      projectStatusCommand: normalizeCommand(hooks.projectStatusCommand),
    },
  };
}

export async function readHarnessConfig(): Promise<HarnessConfig> {
  if (!existsSync(harnessConfigPath)) {
    return defaultHarnessConfig();
  }

  const raw = await readFile(harnessConfigPath, "utf8");
  return applyHarnessDefaults(
    JSON.parse(raw.replace(/^\uFEFF/, "")) as Partial<HarnessConfig>,
  );
}

export function resolveHarnessWorkdir(config: HarnessConfig) {
  return path.resolve(root, config.supervisor.workdir);
}
