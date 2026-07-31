import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { readPlatformMatrix, selectPlatformMatrix } from "./cli-platform-matrix.mjs";
import { RELEASE_PR_BRANCH_PREFIX } from "./release-pr.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const platforms = JSON.parse(readFileSync(join(repoRoot, ".github/cli-platforms.json"), "utf8"));

test("emits the platform list as a single-line matrix", () => {
  const matrix = JSON.stringify(readPlatformMatrix());
  // `matrix=<json>` is one line of $GITHUB_OUTPUT; a newline in it silently
  // truncates the matrix rather than failing.
  assert.equal(matrix.includes("\n"), false, "a matrix output must be one line");
  assert.deepEqual(JSON.parse(matrix), platforms);
});

// An empty matrix is a "matrix contains no values" hard error in Actions, but a
// truncated one is worse: the run stays green having built nothing.
test("rejects an empty list rather than emitting a matrix with no legs", () => {
  const file = join(mkdtempSync(join(tmpdir(), "cli-platforms-")), "empty.json");
  writeFileSync(file, "[]\n");
  assert.throws(() => readPlatformMatrix(file), /lists no CLI platforms/);
});

// The release fan-out's `plan` job passes no EVENT_NAME. If the default ever
// became the subset, a release would publish one of the nine platform packages
// and the other eight would resolve to a version that does not exist.
test("defaults to the full matrix when no event is given", () => {
  assert.deepEqual(selectPlatformMatrix(platforms, undefined), platforms);
  assert.deepEqual(selectPlatformMatrix(platforms, ""), platforms);
});

test("keeps the full matrix on push and workflow_dispatch", () => {
  for (const event of ["push", "workflow_dispatch", "schedule"]) {
    assert.deepEqual(selectPlatformMatrix(platforms, event), platforms, event);
  }
});

test("narrows to the pr-marked subset on pull_request", () => {
  const subset = selectPlatformMatrix(platforms, "pull_request");
  assert.deepEqual(
    subset.map((platform) => platform.package),
    ["linux-x64-gnu"],
  );
  assert.ok(subset.length < platforms.length, "the subset must actually be smaller");
});

// Merging the release pull request is what publishes these nine packages, so it
// builds all nine rather than the one leg a review needs.
test("keeps the full matrix on the release pull request", () => {
  assert.deepEqual(
    selectPlatformMatrix(platforms, "pull_request", `${RELEASE_PR_BRANCH_PREFIX}cli`),
    platforms,
  );
  assert.deepEqual(
    selectPlatformMatrix(platforms, "pull_request", "feature/whatever").map(
      (platform) => platform.package,
    ),
    ["linux-x64-gnu"],
  );
});

test("refuses to emit an empty matrix when nothing is marked for pull requests", () => {
  const unmarked = platforms.map(({ pr, ...rest }) => ({ ...rest, pr: false }));
  assert.throws(
    () => selectPlatformMatrix(unmarked, "pull_request"),
    /refusing to emit an empty matrix/,
  );
});

test("every platform declares the fields the matrices consume", () => {
  for (const platform of platforms) {
    for (const field of ["package", "runner", "native_runner", "target", "build", "binary"]) {
      assert.equal(typeof platform[field], "string", `${platform.package} is missing ${field}`);
    }
    assert.ok(["build", "cross"].includes(platform.build), `${platform.package} build mode`);
    assert.equal(typeof platform.bootstrap, "boolean", `${platform.package} bootstrap`);
    assert.equal(typeof platform.pr, "boolean", `${platform.package} pr`);
    const windows = platform.package.startsWith("win32-");
    assert.equal(platform.binary.endsWith(".exe"), windows, `${platform.package} binary extension`);
    // VsDevCmd.bat puts the cross-arch MSVC toolchain on PATH; without both
    // arguments the Windows legs build for the wrong architecture or not at all.
    assert.equal(
      typeof platform.msvc_arch === "string" && typeof platform.msvc_host === "string",
      windows,
      `${platform.package} MSVC arguments`,
    );
  }
});

// The list and the packages are edited independently - one names the targets CI
// and the release fan-out build, the other is what npm actually publishes. A
// target present in only one of them is a release that silently ships eight
// platforms, or a package nothing ever fills with a binary.
test("the platform list matches the published platform packages", () => {
  const published = readdirSync(join(repoRoot, "packages/rom-weaver-cli-platforms"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(platforms.map((platform) => platform.package).sort(), published);
});
