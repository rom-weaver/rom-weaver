#!/usr/bin/env node

const conventionalCommit =
  /^(build|chore|ci|docs|dx|feat|fix|perf|refactor|revert|style|test)(\([^()\r\n]+\))?!?: \S.*$/;
process.stdin.setEncoding("utf8");
let input = "";
for await (const chunk of process.stdin) input += chunk;

const subjects = input
  .split(/\r?\n/)
  .map((subject) => subject.trim())
  .filter(Boolean);
const invalid = subjects.filter((subject) => !conventionalCommit.test(subject));

if (invalid.length > 0) {
  console.error("Commit subjects and pull request titles must use Conventional Commits:");
  for (const subject of invalid) console.error(`  ${subject}`);
  console.error("Example: feat(cli): add container output");
  process.exitCode = 1;
}
