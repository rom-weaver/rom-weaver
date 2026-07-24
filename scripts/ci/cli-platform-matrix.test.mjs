import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const script = join(here, "cli-platform-matrix.sh");
const platforms = JSON.parse(
  readFileSync(join(repoRoot, ".github/cli-platforms.json"), "utf8"),
);

test("emits the platform list as a single-line matrix", () => {
  const stdout = execFileSync(script, { encoding: "utf8" });
  assert.equal(stdout.trimEnd().includes("\n"), false, "a matrix output must be one line");
  assert.deepEqual(JSON.parse(stdout), platforms);
});

// An empty matrix is a "matrix contains no values" hard error in Actions, but a
// truncated one is worse: the run stays green having built nothing.
test("rejects an empty list rather than emitting a matrix with no legs", () => {
  const emptyList = join(mkdtempSync(join(tmpdir(), "cli-platforms-")), "empty.json");
  writeFileSync(emptyList, "[]\n");
  assert.throws(() => execFileSync(script, [emptyList], { encoding: "utf8", stdio: "pipe" }));
});

test("every platform declares the fields the matrices consume", () => {
  for (const platform of platforms) {
    for (const field of ["package", "runner", "native_runner", "target", "build", "binary"]) {
      assert.equal(typeof platform[field], "string", `${platform.package} is missing ${field}`);
    }
    assert.ok(["build", "cross"].includes(platform.build), `${platform.package} build mode`);
    assert.equal(typeof platform.bootstrap, "boolean", `${platform.package} bootstrap`);
    const windows = platform.package.startsWith("win32-");
    assert.equal(
      platform.binary.endsWith(".exe"),
      windows,
      `${platform.package} binary extension`,
    );
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
  const packagesDir = join(repoRoot, "packages/rom-weaver-cli-platforms");
  const published = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(
    platforms.map((platform) => platform.package).sort(),
    published,
  );
});
