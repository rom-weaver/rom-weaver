import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { elf } from "./binary-fixtures.mjs";
import { artifactName, pack } from "./cli-release-binary.mjs";
import { RELEASE_PR_BRANCH_PREFIX } from "./release-pr.mjs";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml");
const workflow = (name) => load(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8"));
const ciJobs = workflow("ci.yml").jobs;
const ci = ciJobs["cli-platforms"];
const attest = ciJobs["cli-release-attest"];
const build = workflow("npm-build.yml");
const REPOSITORY = "rom-weaver/rom-weaver";
const TREE = "a".repeat(40);
const SOURCE = "b".repeat(40);
const RELEASE = `${RELEASE_PR_BRANCH_PREFIX}cli`;

const evaluate = (expression, { event, headRef = "", headRepository = REPOSITORY, baseRef = "main", platforms = "success" }) =>
  // GitHub expressions are JavaScript here once the hyphenated job name is quoted.
  runInNewContext(expression.replace(/^\$\{\{|\}\}$/gu, "").replaceAll("needs.cli-platforms", 'needs["cli-platforms"]'), {
    github: {
      event_name: event,
      head_ref: headRef,
      base_ref: event === "pull_request" ? baseRef : "",
      repository: REPOSITORY,
      event: event === "pull_request" ? { pull_request: { head: { repo: { full_name: headRepository } } } } : {},
    },
    needs: { "cli-platforms": { result: platforms } },
    startsWith: (value, prefix) => value.startsWith(prefix),
  });

// The producer side: which runs upload a binary, and which job may sign one.
const releaseCases = [
  [{ event: "pull_request", headRef: RELEASE }, true],
  [{ event: "pull_request", headRef: RELEASE, headRepository: "someone/rom-weaver" }, false, "a fork that copies the branch name"],
  [{ event: "pull_request", headRef: RELEASE, baseRef: "evil-base" }, false, "a release head opened into another base"],
  [{ event: "pull_request", headRef: "feature/perf" }, false, "an ordinary pull request"],
  ...["push", "schedule", "workflow_dispatch"].map((event) => [{ event, headRef: RELEASE }, false, event]),
];

test("CI exposes CLI binaries only for this repository's release pull request into main", () => {
  for (const [context, expected, label] of releaseCases)
    assert.equal(evaluate(ci.env.RELEASE_PR_BINARIES, context), expected, label ?? "release pull request");
});

test("the release pull request run compiles the binaries it signs with no cache", () => {
  const compile = ci.steps.find((step) => step.uses === "./.github/actions/build-cli-platform");
  assert.equal(compile.with["cache-restore"], "${{ env.RELEASE_PR_BINARIES != 'true' }}");
  const action = load(readFileSync(new URL("../../.github/actions/build-cli-platform/action.yml", import.meta.url), "utf8"));
  assert.equal(action.inputs["cache-restore"].default, "true");
  // Every step that restores a cache, or wires one into the compiler, is off without cache-restore:
  // matched on what it uses, its inputs, its environment, and its script.
  const CACHING = /cache|RUSTC_WRAPPER|COMPILER_LAUNCHER|jdx\/mise-action/iu;
  const caching = (steps) => steps.filter((step) => CACHING.test(JSON.stringify({ uses: step.uses, with: step.with, env: step.env, run: step.run })));
  const gated = new Set(["Cache cargo artifacts", "Set up Rust compiler cache", "Configure Rust compiler cache"]);
  for (const step of caching(action.runs.steps)) {
    if (gated.has(step.name)) assert.match(step.if, /^inputs\.build != 'cross' && inputs\.cache-restore == 'true'$|^inputs\.cache-restore == 'true'$/u, step.name);
    else if (String(step.uses).startsWith("actions/setup-node@")) assert.equal(step.with["package-manager-cache"], false, step.name);
    else assert.fail(`${step.name ?? step.uses} may use a cache without cache-restore`);
  }
  // A local action can cache with no telltale in the step itself: only identify data is allowed,
  // and only in the mode CI does not use.
  const local = action.runs.steps.filter((step) => String(step.uses ?? "").startsWith("./"));
  assert.deepEqual(local.map((step) => step.uses), ["./.github/actions/download-identify-data", "./.github/actions/identify-data"]);
  assert.equal(local[1].if, "inputs.identify-data-source == 'cache'", "identify data is cached only in that mode");
  assert.deepEqual(caching(action.runs.steps).filter((step) => gated.has(step.name)).map((step) => step.name), [...gated]);
  // CI takes identify data from this run's own artifact, which the binary does not embed.
  assert.equal(compile.with["identify-data-source"], "artifact");
  assert.deepEqual(caching(ci.steps).map((step) => step.name ?? step.uses), ["./.github/actions/build-cli-platform"], "the job itself adds no cache");
});

test("the platform builds hold no OIDC token; only the attest job can sign, and only for the release pull request", () => {
  assert.deepEqual(ci.permissions, { contents: "read" }, "build scripts and third-party actions run in cli-platforms");
  const steps = ci.steps.filter((step) => /release-binary|release-cli-/u.test(JSON.stringify(step)));
  assert.deepEqual(steps.map((step) => step.name), ["Pack the release binary", "Upload the release binary", "Record the release binary"]);
  for (const step of steps) assert.equal(step.if, "env.RELEASE_PR_BINARIES == 'true'", step.name);
  assert.equal(steps[1].with.name, artifactName("${{ matrix.package }}"));
  assert.equal(steps[2].env.ARTIFACT_ID, `\${{ steps.${steps[1].id}.outputs.artifact-id }}`);
  assert.ok(!JSON.stringify(ci.steps).includes("attest"), "cli-platforms attests nothing");

  assert.deepEqual(attest.permissions, { contents: "read", attestations: "write", "artifact-metadata": "write", "id-token": "write" });
  assert.deepEqual(attest.needs, ["changes", "cli-platforms"]);
  assert.equal(attest["continue-on-error"], true, "an attestation outage must not fail CI");
  for (const [context, expected, label] of releaseCases)
    assert.equal(evaluate(attest.if, context), expected, label ?? "release pull request");
  assert.equal(evaluate(attest.if, { event: "pull_request", headRef: RELEASE, platforms: "failure" }), false, "a failed build is not signed");
  const scripts = attest.steps.filter((step) => step.run);
  assert.deepEqual(scripts.map((step) => step.name), ["Select the release binaries"], "the attest job runs no build or repository code");
  assert.doesNotMatch(scripts[0].run, /node|npm|cargo|scripts\//u);
  const download = attest.steps.find((step) => step.name === "Download the release binaries");
  assert.equal(download.with.pattern, undefined, "never by name: any job in the run can replace or add an artifact by name");
  assert.equal(download.with.name, undefined);
  assert.equal(download.with["artifact-ids"], "${{ steps.binaries.outputs.ids }}");
  const sign = attest.steps.find((step) => step.uses === "./.github/actions/attest-retry");
  assert.equal(sign.with["subject-path"], "release-binaries/**/package/bin/*", "one artifact found extracts into the path itself");
  const select = attest.steps.find((step) => step.id === "binaries");
  assert.deepEqual(select.env, { PLATFORMS: "${{ needs.changes.outputs.cli_platforms }}", ARTIFACTS: "${{ toJSON(needs.cli-platforms.outputs) }}" });
  assert.equal(download.with.path, "release-binaries");
});

test("cli-platforms reports each leg's upload id under its own output, for every platform", () => {
  const packages = JSON.parse(readFileSync(new URL("../../.github/cli-platforms.json", import.meta.url), "utf8")).map((platform) => platform.package);
  assert.deepEqual(
    ciJobs["cli-platforms"].outputs,
    Object.fromEntries(packages.map((name) => [`artifact-${name}`, `\${{ steps.release-binary-id.outputs.artifact-${name} }}`])),
  );
  const record = ci.steps.find((step) => step.id === "release-binary-id");
  assert.equal(record.env.PACKAGE, "${{ matrix.package }}");
  assert.equal(record.run, 'echo "artifact-$PACKAGE=$ARTIFACT_ID" >> "$GITHUB_OUTPUT"');
});

// Runs the attest job's real selection step.
function selectBinaries(platforms, artifacts) {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-select-"));
  try {
    const output = join(directory, "output");
    writeFileSync(output, "");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    const step = attest.steps.find((candidate) => candidate.id === "binaries");
    const result = spawnSync("bash", ["-c", step.run], {
      encoding: "utf8",
      env: { ...env, GITHUB_OUTPUT: output, PLATFORMS: JSON.stringify(platforms.map((name) => ({ package: name }))), ARTIFACTS: JSON.stringify(artifacts) },
    });
    return { status: result.status, outputs: Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split(/=(.*)/su).slice(0, 2))) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the attest job signs exactly the uploads every leg reported, or nothing", () => {
  assert.deepEqual(selectBinaries(["linux-x64-gnu", "darwin-x64"], { "artifact-linux-x64-gnu": "11", "artifact-darwin-x64": "22", "artifact-win32-x64-msvc": "" }), {
    status: 0,
    outputs: { ids: "11,22" },
  });
  assert.deepEqual(selectBinaries(["linux-x64-gnu"], { "artifact-linux-x64-gnu": "11" }).outputs, { ids: "11" });
  assert.notEqual(selectBinaries([], { "artifact-linux-x64-gnu": "11" }).status, 0, "empty ids would download every artifact in the run");
  for (const artifacts of [{ "artifact-linux-x64-gnu": "11" }, { "artifact-linux-x64-gnu": "11", "artifact-darwin-x64": "1,2" }, { "artifact-linux-x64-gnu": "11", "artifact-darwin-x64": "0" }])
    assert.notEqual(selectBinaries(["linux-x64-gnu", "darwin-x64"], artifacts).status, 0, JSON.stringify(artifacts));
});

test("the release builds from source unless the CI binary is pinned to the release pull request and its tree", () => {
  const steps = build.jobs["platform-build"].steps;
  const names = steps.map((step) => step.name ?? step.uses);
  const download = steps.find((step) => step.id === "ci-binary");
  assert.equal(download.with.name, artifactName("${{ matrix.package }}"));
  assert.equal(download["continue-on-error"], true);
  assert.equal(download.if, "matrix.ci_run_id != ''");
  const reuse = steps.find((step) => step.id === "reuse");
  assert.equal(reuse.env.ARTIFACT_PR, "${{ inputs.artifact-pr }}");
  const order = [
    "cli-release-binary.mjs verify",
    'gh api "repos/$GITHUB_REPOSITORY/git/commits/$source" --jq .tree.sha',
    "gh attestation verify",
    "scripts/prepare-npm-platform-package.mjs",
  ];
  for (let index = 1; index < order.length; index += 1)
    assert.ok(reuse.run.indexOf(order[index - 1]) < reuse.run.indexOf(order[index]), `${order[index - 1]} before ${order[index]}`);
  for (const required of [
    '--cert-identity "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/.github/workflows/ci.yml@$ref"',
    "--cert-oidc-issuer https://token.actions.githubusercontent.com",
    '--source-ref "$ref"',
    '--source-digest "$source"',
    '--signer-digest "$source"',
    "--deny-self-hosted-runners",
    'ref="refs/pull/$ARTIFACT_PR/merge"',
  ])
    assert.ok(reuse.run.includes(required), required);
  assert.ok(!reuse.run.includes("--signer-workflow"), "a signer-workflow prefix accepts any ref");
  assert.ok(!reuse.run.includes("cli-release-binary.mjs install"), "only the binary comes from the artifact");
  const compile = steps.find((step) => step.uses === "./.github/actions/build-cli-platform");
  assert.equal(compile.if, "steps.reuse.outputs.reused != 'true'");
  assert.ok(names.indexOf(reuse.name) < names.indexOf(compile.name ?? compile.uses));
  assert.deepEqual(build.jobs["platform-build"].permissions, { contents: "read", actions: "read", attestations: "read" });
});

test("the platform plan marks reusable runs without failing the release", () => {
  const plan = build.jobs.plan;
  assert.deepEqual(plan.permissions, { contents: "read", actions: "read", "pull-requests": "read" }, "the merged pull request is read");
  assert.equal(plan.outputs.platforms, "${{ steps.reuse.outputs.matrix }}");
  const step = plan.steps.find((candidate) => candidate.id === "reuse");
  assert.equal(step.run, "node scripts/ci/resolve-cli-binary-run.mjs");
  assert.equal(step.env.ARTIFACT_SHA, "${{ inputs.artifact-sha }}");
  assert.equal(step.env.ARTIFACT_PR, "${{ inputs.artifact-pr }}");
});

test("release.yml passes the merged release pull request into main, and the grants the download needs", () => {
  const release = workflow("release.yml").jobs;
  const job = release["npm-build"];
  assert.equal(job.with["artifact-sha"], "${{ needs.release.outputs.artifact_sha }}");
  assert.equal(job.with["artifact-pr"], "${{ needs.release.outputs.artifact_pr }}");
  assert.equal(job.permissions.actions, "read");
  assert.equal(job.permissions.attestations, "write");
  const step = release.release.steps.find((candidate) => candidate.id === "artifact-sha");
  assert.equal(step.env.PR_NUMBER, "${{ github.event.pull_request.number }}");
  assert.equal(step.env.PR_BASE, "${{ github.event.pull_request.base.ref }}");
  assert.match(step.run, /if \[\[ "\$PR_BASE" == main && "\$PR_NUMBER" =~ \^\[1-9\]\[0-9\]\*\$ \]\]; then artifact_pr="\$PR_NUMBER"; fi/u);
});

// Runs the workflow's own decision step against a real artifact, with `gh`, `git`, and the package
// staging script stubbed, in a scratch directory so nothing touches this checkout. The stubs record
// their arguments so the exact attestation policy is checked, not just that `gh` was called.
function runReuseStep({ attestExit = 0, tree = TREE, apiTree = TREE, pr = "1661" }) {
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
    const log = join(root, "calls.log");
    writeFileSync(
      join(releaseRoot, "scripts", "prepare-npm-platform-package.mjs"),
      `import { appendFileSync, copyFileSync, mkdirSync } from "node:fs";\n` +
        `appendFileSync(${JSON.stringify(log)}, "prepare " + process.argv.slice(2).join(" ") + "\\n");\n` +
        `mkdirSync("packages/rom-weaver-cli-platforms/" + process.argv[2] + "/bin", { recursive: true });\n` +
        `copyFileSync(process.argv[3], "packages/rom-weaver-cli-platforms/" + process.argv[2] + "/bin/rom-weaver");\n`,
    );

    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nprintf 'gh %s\\n' "$*" >> ${JSON.stringify(log)}\n` +
        `case "$1" in api) echo ${apiTree} ;; attestation) exit ${attestExit} ;; esac\n`,
    );
    writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf 'git %s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$1" in rev-parse) echo ${tree} ;; esac\n`);
    chmodSync(join(bin, "gh"), 0o755);
    chmodSync(join(bin, "git"), 0o755);

    const script = build.jobs["platform-build"].steps.find((step) => step.id === "reuse").run;
    const output = join(root, "output");
    const summary = join(root, "summary");
    writeFileSync(output, "");
    writeFileSync(summary, "");
    writeFileSync(log, "");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    const result = spawnSync("bash", ["-c", script], {
      cwd: releaseRoot,
      encoding: "utf8",
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, GITHUB_REPOSITORY: REPOSITORY, GITHUB_SERVER_URL: "https://github.com", CI_BINARY: artifact, PACKAGE: name, TARGET: "x86_64-unknown-linux-gnu", BINARY: "rom-weaver", CI_RUN_ID: "7", ARTIFACT_PR: pr },
    });
    return {
      status: result.status,
      output: readFileSync(output, "utf8").trim(),
      summary: readFileSync(summary, "utf8"),
      calls: readFileSync(log, "utf8").trim().split("\n"),
      installed: existsSync(join(releaseRoot, "packages", "rom-weaver-cli-platforms", name, "bin", "rom-weaver")),
      stderr: result.stdout + result.stderr,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the reuse step stages a binary pinned to the release pull request and its tree", () => {
  const result = runReuseStep({});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "reused=true");
  assert.equal(result.installed, true);
  assert.match(result.summary, /actions\/runs\/7/);
  assert.ok(result.calls.includes(`gh api repos/${REPOSITORY}/git/commits/${SOURCE} --jq .tree.sha`), result.calls.join("\n"));
  const attestation = result.calls.find((call) => call.startsWith("gh attestation verify"));
  assert.equal(
    attestation,
    `gh attestation verify ${attestation.split(" ")[3]} --repo ${REPOSITORY} ` +
      `--cert-identity https://github.com/${REPOSITORY}/.github/workflows/ci.yml@refs/pull/1661/merge ` +
      "--cert-oidc-issuer https://token.actions.githubusercontent.com --source-ref refs/pull/1661/merge " +
      `--source-digest ${SOURCE} --signer-digest ${SOURCE} --deny-self-hosted-runners`,
  );
  assert.ok(result.calls.some((call) => /^prepare linux-x64-gnu \S+\/package\/bin\/rom-weaver$/u.test(call)), result.calls.join("\n"));
});

test("the reuse step falls back to a clean build when any check fails", () => {
  for (const [label, options] of [
    ["the release checkout has another tree", { tree: "c".repeat(40) }],
    ["the recorded commit has another tree", { apiTree: "d".repeat(40) }],
    ["a failed attestation", { attestExit: 1 }],
    ["no release pull request number", { pr: "" }],
    ["a malformed pull request number", { pr: "1/merge --cert-identity x" }],
  ]) {
    const result = runReuseStep(options);
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.equal(result.output, "reused=false", label);
    assert.equal(result.installed, false, label);
    assert.match(result.stderr, /building from source/, label);
    assert.ok(!result.calls.some((call) => call.startsWith("prepare")), `${label}: nothing is staged`);
    assert.ok(result.calls.includes("git checkout -- packages/rom-weaver-cli-platforms/linux-x64-gnu"), `${label}: the package is restored`);
    assert.ok(result.calls.includes("git clean -fdxq -- packages/rom-weaver-cli-platforms/linux-x64-gnu"), `${label}: and cleaned`);
  }
});
