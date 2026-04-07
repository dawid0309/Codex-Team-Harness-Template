import { execSync } from "node:child_process";

import { defaultVerificationConfig, readProjectConfig, type VerificationStage } from "./project-config";

function validateStages(stages: VerificationStage[]) {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error("project.config.json verification.stages must contain at least one stage.");
  }

  const seen = new Set<string>();
  for (const stage of stages) {
    if (!stage.id.trim()) {
      throw new Error("Each verification stage must include a non-empty id.");
    }
    if (!stage.label.trim()) {
      throw new Error(`Verification stage "${stage.id}" must include a non-empty label.`);
    }
    if (!stage.command.trim()) {
      throw new Error(`Verification stage "${stage.id}" must include a non-empty command.`);
    }
    if (seen.has(stage.id)) {
      throw new Error(`Duplicate verification stage id "${stage.id}" found in project.config.json.`);
    }
    seen.add(stage.id);
  }
}

async function main() {
  const config = await readProjectConfig();
  const stages = config.verification?.stages ?? defaultVerificationConfig().stages;

  validateStages(stages);

  for (const stage of stages) {
    if (!stage.enabled) {
      console.log(`==> Skip ${stage.label}`);
      continue;
    }

    console.log(`==> ${stage.label}`);
    execSync(stage.command, {
      stdio: "inherit",
      shell: process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh",
    });
  }

  console.log("Verification complete.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
