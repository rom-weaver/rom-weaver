import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { makeTempDir } from "./test-temp-dirs.mjs";
const release = readFileSync(process.env.RELEASE_FILE || ".github/workflows/release.yml", "utf8");
// Commit hooks export GIT_DIR and friends; a child that inherited them would act on the real repository.
const withoutGitEnv = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
const jobBody = (name) => release.split(`  ${name}:\n`)[1].split(/\n  [a-z][a-z-]*:/)[0];
const flatten = (text) => text.replace(/\s+/g, " ");
// semver-check is passed when it succeeded, or when semver-plan itself succeeded and skipped it
// because every crate's bump allows breaking changes. A failed semver-plan skips semver-check too,
// and must not read as that deliberate skip.
const SEMVER_GATE = flatten(`(
  needs.semver-check.result == 'success' ||
  (
    needs.semver-check.result == 'skipped' &&
    needs.semver-plan.result == 'success' &&
    needs.semver-plan.outputs.skipped == 'true'
  )
)`);
for (const name of ["publish-npm", "publish-containers", "publish-release"]) {
  test(`${name} requires successful or deliberately skipped semver checks`, () => {
    const job = jobBody(name);
    assert.match(job, /needs:[^\n]*semver-check|needs:\s+\[[^\]]*semver-check/);
    assert.match(job, /needs:[^\n]*semver-plan|needs:\s+\[[^\]]*semver-plan/);
    assert.ok(flatten(job).includes(SEMVER_GATE), `${name} lacks the semver gate`);
    assert.doesNotMatch(job, /needs\.semver-check\.result == 'success' &&/);
  });
}
test("semver-check is skipped only when semver-plan succeeded and said so", () => {
  const job = flatten(jobBody("semver-check"));
  assert.match(job, /needs\.semver-plan\.result == 'success'/);
  assert.match(job, /needs\.semver-plan\.outputs\.skipped != 'true'/);
  assert.match(flatten(jobBody("semver-plan")), /skipped: \$\{\{ steps\.plan\.outputs\.skipped \}\}/);
});
test("per-crate semver checks hold at most two runners", () => {
  const job = release.split("  semver-check:\n")[1].split(/\n  [a-z][a-z-]*:\n/)[0];
  assert.match(job, /\n      max-parallel: 2\n/);
});
const workflow = (name) => readFileSync(`.github/workflows/${name}`, "utf8");
// Splits a workflow's `jobs:` section into `{ name: body }`.
const jobsOf = (text) =>
  Object.fromEntries(
    text
      .split("\njobs:\n")[1]
      .split(/\n(?=  [a-z][a-z-]*:\n)/)
      .map((body) => [/^  ([a-z][a-z-]*):$/m.exec(body)?.[1], body])
      .filter(([name]) => name),
  );
// Anything that writes to npm, a container registry, crates.io, a package-manager repository, or
// flips the draft release. A dry run is not one; an upload to the still-draft release is not either.
const PUBLISHES = [
  /uses: \.\/\.github\/workflows\/(?:npm-publish|docker-publish)\.yml/,
  /npm-publish-package\.mjs(?! --dry-run)/,
  /docker\/login-action/,
  /cargo publish(?!.*--dry-run)/,
  /--draft=false/,
  /git push/,
];
// The container build phase pushes nothing; only `phase: publish` calls docker-publish.yml to push.
const publishes = (body) =>
  PUBLISHES.some((pattern) => pattern.test(body.replace(/^\s*#.*$/gm, ""))) && !/^\s+phase: build$/m.test(body);

test("every publishing release job requires semver success or the deliberate skip", () => {
  const jobs = jobsOf(release);
  const publishing = Object.entries(jobs).filter(([name, body]) => publishes(body) && name !== "release");
  assert.deepEqual(
    publishing.map(([name]) => name).sort(),
    ["publish-containers", "publish-homebrew", "publish-npm", "publish-release", "publish-scoop"],
  );
  for (const [name, body] of publishing) {
    const text = flatten(body);
    if (name === "publish-homebrew" || name === "publish-scoop")
      assert.match(text, /needs\.publish-release\.result == 'success'/, `${name} must follow publish-release`);
    else assert.ok(text.includes(SEMVER_GATE), `${name} lacks the semver gate`);
  }
});

test("the npm build workflow publishes nothing, so it may overlap the semver check", () => {
  const build = workflow("npm-build.yml");
  for (const [name, body] of Object.entries(jobsOf(build)))
    assert.equal(publishes(body), false, `npm-build.yml job ${name} publishes`);
  const npmBuild = jobBody("npm-build");
  assert.match(npmBuild, /uses: \.\/\.github\/workflows\/npm-build\.yml/);
  assert.doesNotMatch(npmBuild, /semver-check/);
  const publish = jobsOf(workflow("npm-publish.yml"));
  assert.deepEqual(Object.keys(publish).sort(), ["alias", "launcher", "platform"]);
  assert.ok(flatten(jobBody("publish-npm")).includes("needs.npm-build.result == 'success'"));
});

test("npm platform builds size themselves for the 20-job cap", () => {
  const job = jobsOf(workflow("npm-build.yml"))["platform-build"];
  assert.match(job, /\n      max-parallel: \$\{\{ inputs\.build-parallel \}\}\n/);
  assert.match(jobBody("npm-build"), /build-parallel: \$\{\{ needs\.semver-plan\.outputs\.skipped == 'true' && 5 \|\| 3 \}\}/);
  assert.match(jobsOf(workflow("npm-build.yml"))["platform-dry-run"], /\n      max-parallel: 3\n/);
});
test("baseline lookup only skips 404 and retries failures", () => {
  assert.match(release, /if \[\[ "\$status" = 404 \]\]/);
  assert.match(release, /--retry 3/);
  assert.match(release, /baseline lookup failed/);
});
test("PowerShell verifies docs outside download catch before extraction", () => {
  const source = readFileSync("install.ps1", "utf8");
  assert.match(source, /if \(\$docsPath\) \{\s+Confirm-Provenance "\$docsPath" \$docsAsset/);
  assert.ok(
    source.indexOf('Confirm-Provenance "$docsPath" $docsAsset') <
      source.indexOf("Expand-Archive -LiteralPath $docsPath"),
  );
});

test("baseline lookup fails unresolved errors and only skips missing crates", () => {
  const scratch = resolve(".agent/release-install");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "baseline-"));
  const write = (name, body) => {
    const path = join(directory, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  try {
    write("cargo", "echo checked");
    write("curl", 'printf "%s" "$STATUS"; exit "$CURL_EXIT"');
    const script = release
      .split("      - name: Check for accidental breaking API changes")[1]
      .split("        run: |\n")[1]
      .split("        env:")[0]
      .replace(/^          /gm, "");
    for (const [status, code, success] of [
      ["200", "0", true],
      ["404", "22", true],
      ["500", "22", false],
      ["429", "22", false],
      ["000", "6", false],
      ["200", "18", false],
    ]) {
      const result = spawnSync("bash", ["-eu", "-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:/usr/bin:/bin`,
          STATUS: status,
          CURL_EXIT: code,
          CRATE: "rom-weaver-test",
          CRATES_IO_USER_AGENT: "test",
        },
      });
      assert.equal(result.status === 0, success, `${status}: ${result.stdout} ${result.stderr}`);
      assert.equal(result.stdout.includes("checked"), status === "200" && code === "0");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the semver plan runs the planning script", () => {
  assert.match(jobBody("semver-plan"), /run: node scripts\/ci\/semver-plan\.mjs/);
});

test("the semver plan lists every published workspace crate and refuses an empty list", () => {
  const directory = makeTempDir("rom-weaver-semver-plan-");
  const run = (packages) => {
    const metadata = join(directory, "metadata.json");
    const output = join(directory, "output");
    const members = packages.map(({ id }) => id);
    writeFileSync(metadata, JSON.stringify({ workspace_members: members, packages: [...packages, { id: "outside", name: "outside", version: "1.0.0", publish: null }] }));
    writeFileSync(output, "");
    writeFileSync(join(directory, "cargo"), `#!/bin/sh\ncat ${metadata}\n`);
    writeFileSync(join(directory, "curl"), '#!/bin/sh\nprintf 404\nexit 22\n');
    chmodSync(join(directory, "cargo"), 0o755);
    chmodSync(join(directory, "curl"), 0o755);
    const result = spawnSync("node", ["scripts/ci/semver-plan.mjs"], {
      encoding: "utf8",
      env: { ...withoutGitEnv(process.env), PATH: `${directory}:${process.env.PATH}`, GITHUB_OUTPUT: output, CRATES_IO_USER_AGENT: "test", CRATES_IO_LOOKUP_DELAY_MS: "0" },
    });
    return { output: readFileSync(output, "utf8").trim(), status: result.status };
  };
  assert.deepEqual(
    run([
      { id: "a", name: "rom-weaver-a", version: "0.2.0", publish: null },
      { id: "b", name: "rom-weaver-b", version: "0.2.0", publish: [] },
      { id: "c", name: "rom-weaver-c", version: "0.2.0", publish: ["crates-io"] },
    ]),
    { output: 'crates=["rom-weaver-a","rom-weaver-c"]\nskipped=false', status: 0 },
  );
  assert.notEqual(run([{ id: "b", name: "rom-weaver-b", version: "0.2.0", publish: [] }]).status, 0);
});

test("the container build overlaps the npm publish but pushes nothing", () => {
  const jobs = jobsOf(release);
  assert.match(jobs["build-containers"], /\n      phase: build\n/);
  assert.match(jobs["publish-containers"], /\n      phase: publish\n/);
  assert.match(jobs["publish-containers"], /needs: \[[^\]]*build-containers/);
  assert.ok(flatten(jobs["publish-containers"]).includes("needs.build-containers.result == 'success'"));
  // The build needs only the artifacts it consumes, never the publish or the semver gate.
  assert.match(jobs["build-containers"], /needs: \[release, static-webapp, npm-build\]/);
  assert.doesNotMatch(jobs["build-containers"].replace(/^\s*#.*$/gm, ""), /publish-npm|semver/);
  assert.match(jobs["build-containers"], /packages: read/);
  assert.doesNotMatch(jobs["build-containers"], /packages: write|id-token|attestations/);

  const docker = workflow("docker-publish.yml");
  const dockerJobs = jobsOf(docker);
  const build = dockerJobs.build.replace(/^\s*#.*$/gm, "");
  assert.match(build, /export-oci: /);
  assert.doesNotMatch(build, /\n\s+push: |push-to-registry|packages: write|id-token|attestations/);
  assert.match(build, /cache-to: \$\{\{ steps\.source\.outputs\.value == 'source' && inputs\.sha == '' \}\}/);
  const pushAt = dockerJobs.publish.indexOf("skopeo copy");
  assert.ok(pushAt > dockerJobs.publish.indexOf("Download the image archives"));
  assert.ok(pushAt < dockerJobs.publish.indexOf("Assemble the manifest list"));
  assert.match(dockerJobs.publish, /packages: write/);
});
