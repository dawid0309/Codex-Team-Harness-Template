import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { nowIso } from "./time";
import type { HarnessCheckpoint, HarnessLiveState, HarnessRunSpec, HarnessWorkerStatus } from "./types";

function defaultLiveState(): HarnessLiveState {
  return {
    status: "idle",
    runId: null,
    adapterId: null,
    threadId: null,
    startedAt: null,
    updatedAt: nowIso(),
    latestCheckpoint: null,
    latestSummary: null,
    failureReason: null,
  };
}

export class JsonStateBackend {
  private readonly statePath: string;

  constructor(spec: HarnessRunSpec) {
    this.statePath = path.join(spec.repoRoot, spec.artifactRoot, "live-state.json");
  }

  async ensure() {
    await mkdir(path.dirname(this.statePath), { recursive: true });
  }

  async read() {
    await this.ensure();
    if (!existsSync(this.statePath)) {
      return defaultLiveState();
    }

    return JSON.parse(await readFile(this.statePath, "utf8")) as HarnessLiveState;
  }

  async write(payload: HarnessLiveState) {
    await this.ensure();
    await writeFile(this.statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  async update(updater: (state: HarnessLiveState) => HarnessLiveState | Promise<HarnessLiveState>) {
    const current = await this.read();
    const next = await updater(current);
    await this.write({ ...next, updatedAt: nowIso() });
  }

  path() {
    return this.statePath;
  }
}

export async function writeCheckpoint(checkpointPath: string, checkpoint: HarnessCheckpoint) {
  await mkdir(path.dirname(checkpointPath), { recursive: true });
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}

function defaultWorkerStatus(spec: HarnessRunSpec): HarnessWorkerStatus {
  return {
    state: "idle",
    workerPid: null,
    runId: null,
    adapterId: spec.adapterId,
    threadId: null,
    startedAt: null,
    updatedAt: nowIso(),
    latestSummary: null,
    latestCheckpoint: null,
    stdoutLog: path.join(spec.artifactRoot, "worker-stdout.log").replaceAll("\\", "/"),
    stderrLog: path.join(spec.artifactRoot, "worker-stderr.log").replaceAll("\\", "/"),
  };
}

export class JsonWorkerStatusBackend {
  private readonly statusPath: string;
  private readonly spec: HarnessRunSpec;

  constructor(spec: HarnessRunSpec) {
    this.spec = spec;
    this.statusPath = path.join(spec.repoRoot, spec.artifactRoot, "worker-status.json");
  }

  async ensure() {
    await mkdir(path.dirname(this.statusPath), { recursive: true });
  }

  async read() {
    await this.ensure();
    if (!existsSync(this.statusPath)) {
      return defaultWorkerStatus(this.spec);
    }

    return JSON.parse(await readFile(this.statusPath, "utf8")) as HarnessWorkerStatus;
  }

  async write(payload: HarnessWorkerStatus) {
    await this.ensure();
    await writeFile(this.statusPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  async update(updater: (state: HarnessWorkerStatus) => HarnessWorkerStatus | Promise<HarnessWorkerStatus>) {
    const current = await this.read();
    const next = await updater(current);
    await this.write({ ...next, updatedAt: nowIso() });
  }

  path() {
    return this.statusPath;
  }
}
