import { readFile } from "node:fs/promises";
import path from "node:path";

import type { HarnessManifestFile, ProjectAdapterManifest } from "./types";

export async function loadHarnessManifest(repoRoot: string, manifestPath = "harness.manifest.json") {
  const absolutePath = path.join(repoRoot, manifestPath);
  return JSON.parse(await readFile(absolutePath, "utf8")) as HarnessManifestFile;
}

export function resolveAdapterManifest(
  manifestFile: HarnessManifestFile,
  adapterId: string | null,
): ProjectAdapterManifest {
  const resolvedId = adapterId ?? manifestFile.defaultAdapter;
  const manifest = manifestFile.adapters[resolvedId];
  if (!manifest) {
    throw new Error(`Adapter "${resolvedId}" was not found in harness.manifest.json.`);
  }
  return manifest;
}
