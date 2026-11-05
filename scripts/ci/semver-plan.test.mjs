import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bumpAllowsBreaking,
  fetchCratesIo,
  latestBaseline,
  listPublishedCrates,
  main,
  parseVersion,
  planSemver,
  summaryMarkdown,
} from "./semver-plan.mjs";

const live = (...nums) => nums.map((num) => ({ num, yanked: false }));
const found = (...nums) => ({ status: 200, versions: live(...nums) });
const plan = (crates, baselines) =>
  planSemver(
    crates.map(([name, version]) => ({ name, version })),
    (name) => {
      const result = baselines[name];
      if (result instanceof Error) throw result;
      return result;
    },
  );

test("a 0.x minor bump on every crate skips the check", () => {
  const result = plan(
    [
      ["a", "0.23.0"],
      ["b", "0.23.0"],
    ],
    { a: found("0.22.2", "0.22.1"), b: found("0.22.0") },
  );
  assert.equal(result.skipped, true);
  assert.deepEqual(result.crates, []);
  assert.match(summaryMarkdown(result), /Semver check skipped: breaking bump allowed/);
});

test("a 0.x patch bump runs the check", () => {
  const result = plan([["a", "0.22.3"]], { a: found("0.22.2") });
  assert.equal(result.skipped, false);
  assert.deepEqual(result.crates, ["a"]);
});

test("a major bump skips the check, including 0.x to 1.0", () => {
  for (const [current, baseline] of [
    ["2.0.0", "1.9.9"],
    ["1.0.0", "0.23.4"],
  ]) {
    const result = plan([["a", current]], { a: found(baseline) });
    assert.equal(result.skipped, true, `${baseline} -> ${current}`);
    assert.deepEqual(result.crates, []);
  }
});

test("a minor or patch bump from 1.0 on runs the check", () => {
  for (const [current, baseline] of [
    ["1.3.0", "1.2.9"],
    ["1.2.4", "1.2.3"],
  ]) {
    assert.equal(plan([["a", current]], { a: found(baseline) }).skipped, false, current);
  }
});

test("a baseline lookup failure runs the check instead of skipping", () => {
  for (const baseline of [
    { status: 500 },
    { status: 429 },
    { status: 0 },
    { status: 200 },
    new Error("curl exploded"),
  ]) {
    const result = plan([["a", "0.23.0"]], { a: baseline });
    assert.equal(result.skipped, false, JSON.stringify(baseline));
    assert.deepEqual(result.crates, ["a"]);
    assert.match(result.decisions[0].reason, /lookup/);
  }
});

test("a crate with no published baseline runs the check", () => {
  const result = plan([["a", "0.1.0"]], { a: { status: 404 } });
  assert.equal(result.skipped, false);
  assert.equal(result.decisions[0].reason, "no published baseline");
});

test("mixed crates run the check for every crate", () => {
  const result = plan(
    [
      ["minor", "0.23.0"],
      ["patch", "1.2.4"],
      ["fresh", "0.1.0"],
    ],
    { minor: found("0.22.2"), patch: found("1.2.3"), fresh: { status: 404 } },
  );
  assert.equal(result.skipped, false);
  assert.doesNotMatch(summaryMarkdown(result), /\| skip:/u, "every row runs, so no row says skip");
  assert.deepEqual(result.crates, ["minor", "patch", "fresh"]);
  assert.deepEqual(
    result.decisions.map((decision) => decision.skip),
    [true, false, false],
  );
});

test("a version that is not greater than the baseline runs the check", () => {
  for (const [current, baseline] of [
    ["0.22.2", "0.22.2"],
    ["0.22.0", "0.22.2"],
    ["0.21.0", "0.22.2"],
  ]) {
    assert.equal(plan([["a", current]], { a: found(baseline) }).skipped, false, current);
  }
});

test("prereleases and 0.0.x versions are ambiguous and run the check", () => {
  assert.equal(plan([["a", "0.24.0-alpha.1"]], { a: found("0.23.0") }).skipped, false);
  assert.equal(plan([["a", "0.0.4"]], { a: found("0.0.3") }).skipped, false);
  assert.equal(plan([["a", "not-a-version"]], { a: found("0.23.0") }).skipped, false);
});

test("baseline selection ignores yanked and older prerelease versions only", () => {
  const baseline = (versions) => latestBaseline(versions)?.text ?? null;
  assert.equal(
    baseline([
      { num: "0.23.0", yanked: true },
      { num: "0.22.2", yanked: false },
      { num: "0.22.0", yanked: false },
    ]),
    "0.22.2",
  );
  assert.equal(baseline(live("0.22.0-alpha.1", "0.22.0")), null);
  assert.equal(baseline(live("0.21.0-alpha.2", "0.22.0")), "0.22.0");
  assert.equal(baseline(live("0.23.0-alpha.1", "0.22.0")), null);
  assert.equal(baseline([{ num: "0.22.0", yanked: true }]), null);
  assert.equal(baseline(live("0.22.0", "nonsense")), null);
  assert.equal(bumpAllowsBreaking(parseVersion("0.23.0"), latestBaseline(live("0.22.0-alpha.1", "0.22.0"))), false);
});

test("lists published workspace crates and refuses an empty list", () => {
  const metadata = (packages) => ({
    workspace_members: packages.map(({ id }) => id),
    packages: [...packages, { id: "outside", name: "outside", version: "1.0.0", publish: null }],
  });
  assert.deepEqual(
    listPublishedCrates(
      metadata([
        { id: "a", name: "rom-weaver-a", version: "1.0.0", publish: null },
        { id: "b", name: "rom-weaver-b", version: "1.0.0", publish: [] },
        { id: "c", name: "rom-weaver-c", version: "2.0.0", publish: ["crates-io"] },
      ]),
    ),
    [
      { name: "rom-weaver-a", version: "1.0.0" },
      { name: "rom-weaver-c", version: "2.0.0" },
    ],
  );
  assert.throws(() => listPublishedCrates(metadata([{ id: "b", name: "rom-weaver-b", version: "1.0.0", publish: [] }])));
});

test("main writes the matrix, the skipped flag, and the summary", () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-semver-plan-"));
  try {
    const run = (version, baseline) => {
      const output = join(directory, "output");
      const summary = join(directory, "summary");
      writeFileSync(output, "");
      writeFileSync(summary, "");
      const sleeps = [];
      main(
        { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, CRATES_IO_USER_AGENT: "test", CRATES_IO_LOOKUP_DELAY_MS: "7" },
        {
          metadata: () => ({
            workspace_members: ["a", "b"],
            packages: [
              { id: "a", name: "rom-weaver-a", version, publish: null },
              { id: "b", name: "rom-weaver-b", version, publish: null },
            ],
          }),
          lookup: () => baseline,
          sleep: (ms) => sleeps.push(ms),
        },
      );
      return { output: readFileSync(output, "utf8"), summary: readFileSync(summary, "utf8"), sleeps };
    };
    const skipped = run("0.23.0", found("0.22.2"));
    assert.equal(skipped.output, "crates=[]\nskipped=true\n");
    assert.match(skipped.summary, /skipped: breaking bump allowed/);
    assert.deepEqual(skipped.sleeps, [7]);
    const patch = run("0.22.3", found("0.22.2"));
    assert.equal(patch.output, 'crates=["rom-weaver-a","rom-weaver-b"]\nskipped=false\n');
    assert.doesNotMatch(patch.summary, /skipped: breaking bump allowed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the crates.io lookup treats only HTTP 200 with a body as a baseline", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-semver-plan-curl-"));
  const originalPath = process.env.PATH;
  try {
    writeFileSync(
      join(directory, "curl"),
      [
        "#!/bin/sh",
        'while [ "$#" -gt 0 ]; do [ "$1" = --output ] && out="$2"; shift; done',
        'if [ "$STATUS" = 200 ]; then printf \'{"versions":[{"num":"0.22.2","yanked":false}]}\' > "$out"; fi',
        'printf "%s" "$STATUS"',
        'exit "$CURL_EXIT"',
        "",
      ].join("\n"),
    );
    chmodSync(join(directory, "curl"), 0o755);
    process.env.PATH = `${directory}:${originalPath}`;
    for (const [status, code, expected] of [
      ["200", "0", { status: 200, versions: live("0.22.2") }],
      ["404", "22", { status: 404 }],
      ["500", "22", { status: 500 }],
      ["000", "6", { status: 0 }],
    ]) {
      process.env.STATUS = status;
      process.env.CURL_EXIT = code;
      assert.deepEqual(fetchCratesIo("rom-weaver-test", "test"), expected, status);
    }
  } finally {
    process.env.PATH = originalPath;
    delete process.env.STATUS;
    delete process.env.CURL_EXIT;
    rmSync(directory, { recursive: true, force: true });
  }
});
