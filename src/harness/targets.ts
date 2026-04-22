import path from "node:path";
import { readFile } from "node:fs/promises";

import type { HarnessRunSpec, HarnessTargetRegistration, HarnessTargetRegistryFile } from "./types";

function normalizePath(root: string, candidate: string) {
  return path.isAbsolute(candidate) ? path.normalize(candidate) : path.normalize(path.join(root, candidate));
}

export async function loadTargetRegistry(controlRepoRoot: string, targetRegistryPath = "harness.targets.json") {
  const absolutePath = normalizePath(controlRepoRoot, targetRegistryPath);
  return JSON.parse(await readFile(absolutePath, "utf8")) as HarnessTargetRegistryFile;
}

export function resolveTargetRegistration(
  controlRepoRoot: string,
  registry: HarnessTargetRegistryFile,
  targetId: string | null,
): HarnessTargetRegistration {
  const resolvedId = targetId ?? registry.defaultTarget;
  const target = registry.targets[resolvedId];
  if (!target) {
    throw new Error(`Target "${resolvedId}" was not found in harness target registry.`);
  }

  return {
    ...target,
    repoRoot: normalizePath(controlRepoRoot, target.repoRoot),
    adapterConfigPath: normalizePath(controlRepoRoot, target.adapterConfigPath),
    artifactRoot: target.artifactRoot.replaceAll("\\", "/"),
  };
}

export async function resolveTargetForSpec(input: {
  controlRepoRoot: string;
  targetRegistryPath?: string;
  targetId?: string | null;
}) {
  const registryPath = input.targetRegistryPath ?? "harness.targets.json";
  const registry = await loadTargetRegistry(input.controlRepoRoot, registryPath);
  const target = resolveTargetRegistration(input.controlRepoRoot, registry, input.targetId ?? null);
  return {
    registryPath,
    registry,
    target,
  };
}

export async function createRunSpec(input: {
  controlRepoRoot: string;
  manifestPath?: string;
  targetRegistryPath?: string;
  targetId?: string | null;
  adapterId?: string | null;
  runId: string;
  model?: string | null;
  taskId?: string | null;
}) {
  const resolved = await resolveTargetForSpec({
    controlRepoRoot: input.controlRepoRoot,
    targetRegistryPath: input.targetRegistryPath,
    targetId: input.targetId ?? null,
  });

  const spec: HarnessRunSpec = {
    targetId: resolved.target.id,
    adapterId: input.adapterId ?? resolved.target.adapterId,
    artifactRoot: resolved.target.artifactRoot,
    manifestPath: input.manifestPath ?? "harness.manifest.json",
    targetRegistryPath: resolved.registryPath,
    controlRepoRoot: input.controlRepoRoot,
    targetRepoRoot: resolved.target.repoRoot,
    runId: input.runId,
    model: input.model ?? null,
    taskId: input.taskId ?? null,
  };

  return {
    spec,
    target: resolved.target,
  };
}
