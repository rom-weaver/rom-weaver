import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { makeTempDir } from "../test-temp-dirs.mjs";

const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
const step = workflow.split("\n      - name: ").find((block) => block.startsWith("Find release pull request\n"));
const script = step.split("run: |\n")[1].replace(/^ {10}/gm, "");
const branch = "release-please--branches--main--components--cli";
const found = ["found=true", "number=1257", `branch=${branch}`];

// The gh stub stands in for the label search and lists the release pull request only when GH_LISTS_PR is set.
const lookup = ({ reportedNumber = "", reportedBranch = "", listed = false }) => {
  const dir = makeTempDir("release-pr-lookup-");
  const bin = join(dir, "bin");
  const output = join(dir, "output");
  writeFileSync(join(dir, "step.sh"), script);
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
echo call >> "$GH_CALLS"
if [ -n "$GH_LISTS_PR" ]; then
  printf '1257\\t%s\\n' "$GH_LISTS_PR"
else
  printf '\\t\\n'
fi
`);
  chmodSync(join(bin, "gh"), 0o755);
  const result = spawnSync("bash", [join(dir, "step.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_CALLS: join(dir, "gh-calls"),
      GH_LISTS_PR: listed ? branch : "",
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: "rom-weaver/rom-weaver",
      REPORTED_NUMBER: reportedNumber,
      REPORTED_BRANCH: reportedBranch,
    },
  });
  const lines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
  return { status: result.status, outputs: lines(output), ghCalls: lines(join(dir, "gh-calls")).length };
};

test("the step reads the number and branch of the pull request Release Please reports", () => {
  assert.match(step, /REPORTED_NUMBER: \$\{\{ steps\.release\.outputs\.pr && fromJSON\(steps\.release\.outputs\.pr\)\.number \|\| '' \}\}/);
  assert.match(step, /REPORTED_BRANCH: \$\{\{ steps\.release\.outputs\.pr && fromJSON\(steps\.release\.outputs\.pr\)\.headBranchName \|\| '' \}\}/);
});

test("a reported release pull request is used without a search that may not list it yet", () => {
  const result = lookup({ reportedNumber: "1257", reportedBranch: branch });
  assert.equal(result.status, 0);
  assert.deepEqual(result.outputs, found);
  assert.equal(result.ghCalls, 0);
});

test("without a reported pull request the label search finds an open one", () => {
  const result = lookup({ listed: true });
  assert.equal(result.status, 0);
  assert.deepEqual(result.outputs, found);
  assert.equal(result.ghCalls, 1);
});

test("without a reported or listed pull request there is nothing to sync", () => {
  const result = lookup({});
  assert.equal(result.status, 0);
  assert.deepEqual(result.outputs, ["found=false"]);
  assert.equal(result.ghCalls, 1);
});
