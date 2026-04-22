import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { HarnessArtifactStore, HarnessRunSpec } from "./types";

function stringify(payload: unknown) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export class FileArtifactStore implements HarnessArtifactStore {
  readonly rootDir: string;
  readonly runDir: string;

  constructor(spec: HarnessRunSpec) {
    this.rootDir = path.join(spec.controlRepoRoot, spec.artifactRoot);
    this.runDir = path.join(this.rootDir, "runs", spec.runId);
  }

  resolve(relativePath: string) {
    return path.join(this.runDir, relativePath);
  }

  async ensure() {
    await mkdir(this.runDir, { recursive: true });
  }

  async writeJson(relativePath: string, payload: unknown) {
    const target = this.resolve(relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, stringify(payload), "utf8");
    return target;
  }

  async appendJsonLine(relativePath: string, payload: unknown) {
    const target = this.resolve(relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    const current = await readFile(target, "utf8").catch(() => "");
    await writeFile(target, `${current}${JSON.stringify(payload)}\n`, "utf8");
    return target;
  }

  async writeText(relativePath: string, content: string) {
    const target = this.resolve(relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return target;
  }

  async readJson<T>(relativePath: string) {
    return JSON.parse(await readFile(this.resolve(relativePath), "utf8")) as T;
  }
}
