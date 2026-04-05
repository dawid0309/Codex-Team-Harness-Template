import { readProjectConfig, syncProjectFiles } from "./project-config";

async function main() {
  const config = await readProjectConfig();
  await syncProjectFiles(config);
  console.log(`Synchronized project metadata for ${config.name}.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
