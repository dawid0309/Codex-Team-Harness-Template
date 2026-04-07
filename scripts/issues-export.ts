import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { deriveRepositoryMetadata, readProjectConfig, root } from "./project-config";

type IssueObservation = {
  number: number;
  title: string;
  batch: string;
  status: string;
  summary: string;
  linkedIssues: number[];
  repoEvidence: string[];
  implementationNotes: string[];
  closureCondition: string[];
};

type ObservationFile = {
  version: number;
  project: string;
  source: string;
  issues: IssueObservation[];
};

const observationPath = path.join(root, "docs", "issues", "harness-observations.json");
const outputDirectory = path.join(root, "docs", "issues", "harness");

function renderBulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function renderIssue(issue: IssueObservation, issuesUrl: string): string {
  const linkedIssues =
    issue.linkedIssues.length > 0
      ? issue.linkedIssues.map((number) => `[#${number}](${issuesUrl}/${number})`).join(", ")
      : "None";

  return `# Issue #${issue.number}: ${issue.title}

- Batch: ${issue.batch}
- Status: ${issue.status}
- Linked issues: ${linkedIssues}

## Summary

${issue.summary}

## Repo Evidence

${renderBulletList(issue.repoEvidence)}

## Implementation Notes

${renderBulletList(issue.implementationNotes)}

## Closure Condition

${renderBulletList(issue.closureCondition)}
`;
}

function renderIndex(observations: ObservationFile, issuesUrl: string): string {
  const rows = observations.issues
    .sort((left, right) => left.number - right.number)
    .map(
      (issue) =>
        `| [#${issue.number}](${issuesUrl}/${issue.number}) | ${issue.title} | ${issue.batch} | ${issue.status} | [draft](./issue-${issue.number}.md) |`,
    )
    .join("\n");

  return `# ${observations.project} Issue Export

Generated from \`docs/issues/harness-observations.json\`.

| Issue | Title | Batch | Status | Draft |
| --- | --- | --- | --- | --- |
${rows}
`;
}

async function main() {
  const config = await readProjectConfig();
  const repo = deriveRepositoryMetadata(config);
  const observations = JSON.parse(await readFile(observationPath, "utf8")) as ObservationFile;
  const issuesUrl = `${repo.bugsUrl}`;

  await mkdir(outputDirectory, { recursive: true });

  const orderedIssues = [...observations.issues].sort((left, right) => left.number - right.number);
  for (const issue of orderedIssues) {
    const content = renderIssue(issue, issuesUrl);
    await writeFile(path.join(outputDirectory, `issue-${issue.number}.md`), `${content}\n`, "utf8");
  }

  const index = renderIndex({ ...observations, issues: orderedIssues }, issuesUrl);
  await writeFile(path.join(outputDirectory, "README.md"), `${index}\n`, "utf8");

  console.log(`Exported ${orderedIssues.length} issue draft(s) to ${path.relative(root, outputDirectory)}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
