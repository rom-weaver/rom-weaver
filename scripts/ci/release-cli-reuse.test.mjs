import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { elf } from "./binary-fixtures.mjs";
import { artifactName, pack } from "./cli-release-binary.mjs";
import { RELEASE_PR_BRANCH_PREFIX } from "./release-pr.mjs";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml");
const workflow = (name) => load(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8"));
const ci = workflow("ci.yml").jobs["cli-platforms"];
const build = workflow("npm-build.yml");
const REPOSITORY = "rom-weaver/rom-weaver";
const TREE = "a".repeat(40);
const SOURCE = "b".repeat(40);

const evaluate = (expression, { event, headRef = "", headRepository = REPOSITORY }) =>
  runInNewContext(expression.replace(/^\$\{\{|\}\}$/gu, ""), {
    github: { event_name: event, head_ref: headRef, repository: REPOSITORY, event: event === "pull_request" ? { pull_request: { head: { repo: { full_name: headRepository } } } } : {} },
    startsWith: (value, prefix) => value.startsWith(prefix),
  });

test("CI exposes CLI binaries only for this repository's release pull request", () => {
  const expression = ci.env.RELEASE_PR_BINARIES;
  const release = `${RELEASE_PR_BRANCH_PREFIX}cli`;
  assert.equal(evaluate(expression, { event: "pull_request", headRef: release }), true);
  assert.equal(evaluate(expression, { event: "pull_request", headRef: release, headRepository: "someone/rom-weaver" }), false, "a fork that copies the branch name");
  assert.equal(evaluate(expression, { event: "pull_request", headRef: "feature/perf" }), false);
  for (const event of ["push", "schedule", "workflow_dispatch"]) assert.equal(evaluate(expression, { event, headRef: release }), false, event);
});

test("every step that packs, attests, or uploads the release binary is gated on that condition", () => {
  const steps = ci.steps.filter((step) => /release-binary|release-cli-/u.test(JSON.stringify(step)));
  assert.deepEqual(
    steps.map((step) => step.name),
    ["Pack the release binary", "Attest the release binary", "Upload the release binary"],
  );
  for (const step of steps) assert.equal(step.if, "env.RELEASE_PR_BINARIES == 'true'", step.name);
  const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact"));
  assert.equal(upload.with.name, artifactName("${{ matrix.package }}"));
  assert.ok(steps.find((step) => step.name === "Attest the release binary")["continue-on-error"], "an attestation outage must not fail CI");
});

test("the release builds from source unless the CI binary verified", () => {
  const steps = build.jobs["platform-build"].steps;
  const names = steps.map((step) => step.name ?? step.uses);
  const download = steps.find((step) => step.id === "ci-binary");
  assert.equal(download.with.name, artifactName("${{ matrix.package }}"));
  assert.equal(download["continue-on-error"], true);
  assert.equal(download.if, "matrix.ci_run_id != ''");
  const reuse = steps.find((step) => step.id === "reuse");
  for (const required of ["cli-release-binary.mjs verify", "gh attestation verify", "--signer-workflow", ".github/workflows/ci.yml", "--source-digest", "cli-release-binary.mjs install"])
    assert.ok(reuse.run.includes(required), required);
  assert.ok(reuse.run.indexOf("cli-release-binary.mjs verify") < reuse.run.indexOf("gh attestation verify"));
  assert.ok(reuse.run.indexOf("gh attestation verify") < reuse.run.indexOf("cli-release-binary.mjs install"));
  const compile = steps.find((step) => step.uses === "./.github/actions/build-cli-platform");
  assert.equal(compile.if, "steps.reuse.outputs.reused != 'true'");
  assert.ok(names.indexOf(reuse.name) < names.indexOf(compile.name ?? compile.uses));
  assert.deepEqual(build.jobs["platform-build"].permissions, { contents: "read", actions: "read", attestations: "read" });
});

test("the platform plan marks reusable runs without failing the release", () => {
  const plan = build.jobs.plan;
  assert.equal(plan.outputs.platforms, "${{ steps.reuse.outputs.matrix }}");
  const step = plan.steps.find((candidate) => candidate.id === "reuse");
  assert.equal(step.run, "node scripts/ci/resolve-cli-binary-run.mjs");
  assert.equal(step.env.ARTIFACT_SHA, "${{ inputs.artifact-sha }}");
});

test("release.yml passes the release pull request head commit and the grants the download needs", () => {
  const job = workflow("release.yml").jobs["npm-build"];
  assert.equal(job.with["artifact-sha"], "${{ needs.release.outputs.artifact_sha }}");
  assert.equal(job.permissions.actions, "read");
  assert.equal(job.permissions.attestations, "write");
});

// Runs the workflow's own decision step against a real artifact, with `gh` and `git` stubbed, in a
// scratch copy of the two scripts it calls so that `install` cannot touch this checkout. No real
// git or network is used, so inherited GIT_* variables have nothing to act on.
function runReuseStep({ ghExit = 0, tree = TREE }) {
  const root = mkdtempSync(join(tmpdir(), "rom-weaver-reuse-step-"));
  try {
    const name = "linux-x64-gnu";
    const stage = join(root, "ci", "packages", "rom-weaver-cli-platforms", name);
    mkdirSync(join(stage, "bin"), { recursive: true });
    writeFileSync(join(stage, "bin", "rom-weaver"), elf({ arch: "x86_64", interpreter: "/lib64/ld-linux-x86-64.so.2" }));
    writeFileSync(join(stage, "package.json"), "{}\n");
    const artifact = join(root, "artifact");
    pack({ root: join(root, "ci"), name, target: "x86_64-unknown-linux-gnu", binary: "rom-weaver", tree: TREE, sourceSha: SOURCE, repository: REPOSITORY, runId: "7", runAttempt: "1", out: artifact });

    const releaseRoot = join(root, "release");
    mkdirSync(join(releaseRoot, "scripts", "ci"), { recursive: true });
    for (const file of ["cli-release-binary.mjs", "binary-target.mjs"])
      copyFileSync(new URL(`./${file}`, import.meta.url), join(releaseRoot, "scripts", "ci", file));
    mkdirSync(join(releaseRoot, "target", "identify-release", "share"), { recursive: true });
    writeFileSync(join(releaseRoot, "target", "identify-release", "share", "index"), "tree\n");
    mkdirSync(join(releaseRoot, "packages", "rom-weaver-cli-platforms", name), { recursive: true });

    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nexit ${ghExit}\n`);
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho ${tree}\n`);
    chmodSync(join(bin, "gh"), 0o755);
    chmodSync(join(bin, "git"), 0o755);

    const script = workflow("npm-build.yml").jobs["platform-build"].steps.find((step) => step.id === "reuse").run;
    const output = join(root, "output");
    const summary = join(root, "summary");
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    const result = spawnSync("bash", ["-c", script], {
      cwd: releaseRoot,
      encoding: "utf8",
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, GITHUB_REPOSITORY: REPOSITORY, GITHUB_SERVER_URL: "https://github.com", CI_BINARY: artifact, PACKAGE: name, TARGET: "x86_64-unknown-linux-gnu", BINARY: "rom-weaver", CI_RUN_ID: "7" },
    });
    return {
      status: result.status,
      output: readFileSync(output, "utf8").trim(),
      summary: readFileSync(summary, "utf8"),
      installed: existsSync(join(releaseRoot, "packages", "rom-weaver-cli-platforms", name, "bin", "rom-weaver")),
      stderr: result.stdout + result.stderr,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the reuse step installs a verified binary and records where it came from", () => {
  const result = runReuseStep({});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "reused=true");
  assert.equal(result.installed, true);
  assert.match(result.summary, /actions\/runs\/7/);
});

test("the reuse step falls back to a build when the tree or the attestation does not verify", () => {
  for (const [label, options] of [["another tree", { tree: "c".repeat(40) }], ["a failed attestation", { ghExit: 1 }]]) {
    const result = runReuseStep(options);
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.equal(result.output, "reused=false", label);
    assert.equal(result.installed, false, label);
    assert.match(result.stderr, /building from source/, label);
  }
});
