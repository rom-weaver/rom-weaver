import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { makeTempDir } from "../test-temp-dirs.mjs";

const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
const step = workflow.split("\n      - name: ").find((block) => block.startsWith("Find release pull request\n"));
const script = step.split("run: |\n")[1].replace(/^ {10}/gm, "");
const releasePr = "1257\trelease-please--branches--main--components--cli";

// The gh stub prints an empty search row until call number GH_LISTED_FROM, then the release pull request.
const lookup = ({ prsCreated, listedFrom }) => {
  const dir = makeTempDir("release-pr-lookup-");
  const bin = join(dir, "bin");
  const output = join(dir, "output");
  writeFileSync(join(dir, "step.sh"), script);
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
echo call >> "$GH_CALLS"
calls=$(wc -l < "$GH_CALLS")
if [ -n "$GH_LISTED_FROM" ] && [ "$calls" -ge "$GH_LISTED_FROM" ]; then
  printf '%s\\n' "$GH_RELEASE_PR"
else
  printf '\\t\\n'
fi
`);
  writeFileSync(join(bin, "sleep"), '#!/bin/sh\necho "$1" >> "$SLEEP_CALLS"\n');
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "sleep"), 0o755);
  const result = spawnSync("bash", [join(dir, "step.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_CALLS: join(dir, "gh-calls"),
      GH_LISTED_FROM: listedFrom ?? "",
      GH_RELEASE_PR: releasePr,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: "rom-weaver/rom-weaver",
      PRS_CREATED: prsCreated,
      SLEEP_CALLS: join(dir, "sleep-calls"),
    },
  });
  const lines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
  return {
    status: result.status,
    stdout: result.stdout,
    outputs: lines(output),
    ghCalls: lines(join(dir, "gh-calls")).length,
    sleeps: lines(join(dir, "sleep-calls")).length,
  };
};

const found = ["found=true", "number=1257", "branch=release-please--branches--main--components--cli"];

test("a release pull request that search lists late is found by a retry", () => {
  const result = lookup({ prsCreated: "true", listedFrom: "3" });
  assert.equal(result.status, 0);
  assert.deepEqual(result.outputs, found);
  assert.equal(result.ghCalls, 3);
  assert.equal(result.sleeps, 2);
});

test("a reported release pull request that search never lists fails the step", () => {
  const result = lookup({ prsCreated: "true" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::Release Please reported a release pull request/);
  assert.deepEqual(result.outputs, []);
  assert.equal(result.ghCalls, 12);
  assert.equal(result.sleeps, 11);
});

for (const prsCreated of ["", "false"]) {
  test(`prs_created=${JSON.stringify(prsCreated)} looks up once without waiting`, () => {
    const none = lookup({ prsCreated });
    assert.equal(none.status, 0);
    assert.deepEqual(none.outputs, ["found=false"]);
    assert.equal(none.ghCalls, 1);
    assert.equal(none.sleeps, 0);

    const open = lookup({ prsCreated, listedFrom: "1" });
    assert.equal(open.status, 0);
    assert.deepEqual(open.outputs, found);
    assert.equal(open.ghCalls, 1);
  });
}
