import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { makeTempDir } from "../test-temp-dirs.mjs";
import { RELEASE_PR_BRANCH_PREFIX } from "./release-pr.mjs";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml");
const read = (name) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
const ci = load(read("ci.yml"));
const release = load(read("release.yml"));
const step = (job, name) => {
  const found = job.steps.find((candidate) => candidate.name === name);
  assert.ok(found, `step "${name}" exists`);
  return found;
};

// GitHub expressions in these conditions are also valid JavaScript.
const evaluate = (expression, { event, ref = "", headRef = "", fork = false, base = "main", wasm = "success", wasmId = "42" }) =>
  // Hyphenated names are JavaScript once quoted.
  runInNewContext(expression.replaceAll("outputs.wasm-artifact-id", 'outputs["wasm-artifact-id"]'), {
    github: {
      event_name: event,
      ref,
      head_ref: headRef,
      repository: "octo/rom-weaver",
      event: { pull_request: { head: { repo: { full_name: fork ? "attacker/rom-weaver" : "octo/rom-weaver" } }, base: { ref: base } } },
    },
    needs: { wasm: { result: wasm, outputs: { "wasm-artifact-id": wasmId } } },
    startsWith: (value, prefix) => value.startsWith(prefix),
  });

const releaseBranch = `${RELEASE_PR_BRANCH_PREFIX}cli`;

test("ci.yml signs the WASM manifest only for runs of main and this repository's release pull request", () => {
  const { if: condition } = ci.jobs["wasm-attest"];
  const signs = (overrides) => evaluate(condition, overrides);
  assert.equal(signs({ event: "push", ref: "refs/heads/main" }), true);
  assert.equal(signs({ event: "workflow_dispatch", ref: "refs/heads/main" }), true, "a manual run of main");
  assert.equal(signs({ event: "pull_request", headRef: releaseBranch }), true);
  for (const [name, overrides] of Object.entries({
    "a push to another branch": { event: "push", ref: "refs/heads/feature" },
    "a tag push": { event: "push", ref: "refs/tags/v1.0.0" },
    "a feature pull request": { event: "pull_request", headRef: "feature/wasm" },
    "a pull request into another base": { event: "pull_request", headRef: releaseBranch, base: "attacker/base" },
    "a fork's release-named branch": { event: "pull_request", headRef: releaseBranch, fork: true },
    "a manual run of another branch": { event: "workflow_dispatch", ref: "refs/heads/feature" },
    "the nightly": { event: "schedule", ref: "refs/heads/main" },
    "a build that did not succeed": { event: "push", ref: "refs/heads/main", wasm: "failure" },
    "a skipped build": { event: "push", ref: "refs/heads/main", wasm: "skipped" },
    "a build that reported no artifact id": { event: "push", ref: "refs/heads/main", wasmId: "" },
  }))
    assert.equal(signs(overrides), false, name);
});

test("the signing job is separate: only it can mint tokens or attest, and it never builds", () => {
  const writes = (job) => Object.entries(job.permissions ?? {}).filter(([, level]) => level === "write").map(([scope]) => scope);
  assert.deepEqual(writes(ci.jobs["wasm-attest"]).sort(), ["artifact-metadata", "attestations", "id-token"]);
  assert.equal(ci.jobs["wasm-attest"].permissions.contents, "read");
  assert.equal(ci.jobs["wasm-attest"].needs, "wasm");
  // The build job may only read: a release tag reads the release pull request's signed artifact.
  assert.deepEqual(writes(ci.jobs.wasm), [], "the build job keeps a read-only token");
  assert.equal(ci.jobs.wasm.permissions["id-token"], undefined, "the build job cannot mint tokens");
  assert.deepEqual(ci.permissions, { contents: "read" });
  for (const { run = "", uses = "" } of ci.jobs["wasm-attest"].steps) {
    assert.doesNotMatch(run, /mise run|cargo |npm /u);
    assert.doesNotMatch(uses, /setup-build-env|cache/u);
  }
});

test("the signing job attests the manifest of the downloaded artifact, then publishes it", () => {
  const job = ci.jobs["wasm-attest"];
  const download = step(job, "Download WASM artifact");
  assert.equal(download.with.name, undefined, "never by name: any job in the run can replace an artifact by name");
  assert.equal(download.with["artifact-ids"], "${{ needs.wasm.outputs.wasm-artifact-id }}");
  assert.equal(download.with["merge-multiple"], true, "the files land in the path itself, not a per-artifact directory");
  assert.equal(ci.jobs.wasm.outputs["wasm-artifact-id"], "${{ steps.wasm-artifact.outputs.artifact-id }}");
  const built = step(ci.jobs.wasm, "Upload WASM artifact");
  assert.equal(built.id, "wasm-artifact");
  assert.equal(built.with.name, "wasm-prod");
  const manifest = step(job, "Write the checksum manifest");
  assert.match(manifest.run, /node scripts\/ci\/wasm-manifest\.mjs "\$RUNNER_TEMP\/wasm-prod" "\$RUNNER_TEMP\/wasm-manifest\/wasm-prod\.sha256"/u);
  const sign = step(job, "Sign build provenance");
  assert.equal(sign.uses, "./.github/actions/attest-retry");
  assert.equal(sign.with["subject-path"], "${{ runner.temp }}/wasm-manifest/wasm-prod.sha256");
  const upload = step(job, "Upload the checksum manifest");
  assert.equal(upload.with.name, "wasm-prod-manifest");
  assert.equal(upload.with.path, sign.with["subject-path"]);
  const names = job.steps.map((candidate) => candidate.name);
  assert.ok(names.indexOf(sign.name) < names.indexOf(upload.name), "the artifact exists only once signed");
});

test("the signing job is not a gate input: a missing signature only costs the release a rebuild", () => {
  assert.ok(!ci.jobs.gate.needs.includes("wasm-attest"));
});

const releaseJob = release.jobs.release;
const staticWebapp = release.jobs["static-webapp"];

test("release.yml never downloads wasm-prod directly; every reuse goes through the verifier", () => {
  const jobs = structuredClone(release.jobs);
  const runtimeJob = jobs["publish-emulator-runtime"];
  const runtimeDownload = step(runtimeJob, "Download emulator runtime");
  assert.match(runtimeDownload.uses, /^actions\/download-artifact@/u);
  assert.equal(runtimeDownload.with.pattern, "emulator-runtime-*");
  assert.equal(runtimeDownload.with.name, undefined);
  assert.equal(runtimeDownload.with["artifact-ids"], undefined);
  assert.equal(runtimeDownload.run, undefined);
  runtimeJob.steps = runtimeJob.steps.filter((candidate) => candidate !== runtimeDownload);
  assert.doesNotMatch(JSON.stringify({ ...release, jobs }), /gh run download|download-artifact/u);
  assert.doesNotMatch(read("release.yml"), /--name wasm-prod/u);
  const fetches = [releaseJob, staticWebapp].flatMap((job) => job.steps.filter((candidate) => candidate.run === "node scripts/ci/fetch-verified-wasm.mjs"));
  assert.equal(fetches.length, 2);
});

test("the jobs that reuse the artifact can read attestations, runs, commits, and pull requests", () => {
  for (const job of [releaseJob, staticWebapp]) {
    assert.equal(job.permissions.actions, "read");
    assert.ok(["read", "write"].includes(job.permissions.attestations));
    assert.ok(["read", "write"].includes(job.permissions.contents));
    assert.ok(["read", "write"].includes(job.permissions["pull-requests"]), "the release pull request is read to check it was merged");
  }
  assert.equal(releaseJob.permissions.attestations, "read");
});

test("the screenshot job verifies main's push run against the dispatch commit", () => {
  const resolve = step(releaseJob, "Resolve tested WASM artifact for screenshots");
  assert.equal(resolve.env.TARGET_SHA, "${{ github.sha }}");
  assert.equal(resolve.env.PR_NUMBER, undefined, "no pull request number: runs of main only");
  const fetch = step(releaseJob, "Verify and install tested WASM artifact for screenshots");
  assert.equal(fetch.env.EXPECTED_SHA, "${{ github.sha }}");
  assert.equal(fetch.env.RUN_IDS, "${{ steps.screenshot-ci.outputs.run_ids }}", "every candidate, newest first");
  assert.equal(fetch.id, "screenshot-wasm");
});

test("the release package verifies against the released commit and the release pull request", () => {
  const resolve = step(staticWebapp, "Resolve tested WASM artifact");
  assert.equal(resolve.env.TARGET_SHA, "${{ needs.release.outputs.artifact_sha }}");
  assert.equal(resolve.env.PR_NUMBER, "${{ needs.release.outputs.artifact_pr }}");
  const fetch = step(staticWebapp, "Verify and install tested WASM artifact");
  assert.equal(fetch.env.EXPECTED_SHA, "${{ needs.release.outputs.sha }}");
  assert.equal(fetch.env.PR_NUMBER, "${{ needs.release.outputs.artifact_pr }}");
  assert.equal(fetch.env.RUN_IDS, "${{ steps.ci.outputs.run_ids }}", "every candidate, newest first");
  assert.equal(fetch.id, "wasm");
});

test("every source-build fallback runs unless the artifact was verified", () => {
  const fallbacks = [
    [releaseJob, "Set up fallback WASM build for screenshots", "steps.screenshot-wasm.outputs.verified != 'true'"],
    [releaseJob, "Build fallback WASM for screenshots", "steps.screenshot-wasm.outputs.verified != 'true'"],
    [staticWebapp, "Set up fallback WASM build", "steps.wasm.outputs.verified != 'true'"],
    [staticWebapp, "Build fallback WASM artifact", "steps.wasm.outputs.verified != 'true'"],
  ];
  for (const [job, name, condition] of fallbacks) {
    const flat = String(step(job, name).if).replace(/\s+/gu, " ");
    assert.ok(flat.includes(condition), `${name}: ${flat}`);
    assert.doesNotMatch(flat, /available/u, `${name} must not trust the unverified availability`);
  }
});

// Runs the real "Resolve reusable artifact commit" step with a stubbed `gh` that maps commits to trees.
function artifactSha({ eventName, headSha, headTree, releaseTree, prNumber = "7" }) {
  const directory = makeTempDir("artifact-sha-");
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
case "$2" in
  */git/commits/${"c".repeat(40)}) echo ${releaseTree} ;;
  */git/commits/${"a".repeat(40)}) echo ${headTree} ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const output = join(directory, "output");
  writeFileSync(output, "");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = spawnSync("bash", ["-eu", "-c", step(releaseJob, "Resolve reusable artifact commit").run], {
    encoding: "utf8",
    env: {
      ...env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: "octo/rom-weaver",
      GITHUB_EVENT_NAME: eventName,
      RELEASE_SHA: "c".repeat(40),
      PR_HEAD_SHA: headSha,
      PR_NUMBER: prNumber,
      PR_BASE: "main",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => line.split(/=(.*)/su).slice(0, 2)));
}

test("the release pull request's CI run is a candidate only when its head tree is the release tree", () => {
  assert.deepEqual(artifactSha({ eventName: "pull_request", headSha: "a".repeat(40), headTree: "t1", releaseTree: "t1" }), {
    sha: "a".repeat(40),
    pr: "7",
  });
  assert.deepEqual(artifactSha({ eventName: "pull_request", headSha: "a".repeat(40), headTree: "t1", releaseTree: "t2" }), {
    sha: "c".repeat(40),
    pr: "",
  });
  assert.deepEqual(artifactSha({ eventName: "workflow_dispatch", headSha: "", headTree: "t1", releaseTree: "t1" }), {
    sha: "c".repeat(40),
    pr: "",
  });
});

// True when `condition` is `prefix (rest)` and the parentheses wrap all of the rest, so no
// `||` in it can bypass the prefix.
const gatesWhole = (condition, prefix) => {
  if (!condition.startsWith(`${prefix}(`) || !condition.endsWith(")")) return false;
  let depth = 0;
  const rest = condition.slice(prefix.length);
  for (const [index, character] of [...rest].entries()) {
    depth += character === "(" ? 1 : character === ")" ? -1 : 0;
    if (depth === 0 && index < rest.length - 1) return false;
  }
  return depth === 0;
};
const action = (name) => load(readFileSync(new URL(`../../.github/actions/${name}/action.yml`, import.meta.url), "utf8"));
const CACHE_ACTION = /^(actions\/cache(\/restore|\/save)?|Swatinem\/rust-cache)@/u;

test("the release pull request's WASM build, which is signed, restores and saves no cache", () => {
  const job = ci.jobs.wasm;
  const flag = job.env.RELEASE_PR_WASM.replace(/^\$\{\{|\}\}$/gu, "");
  const isRelease = (overrides) => evaluate(flag, overrides);
  assert.equal(isRelease({ event: "pull_request", headRef: releaseBranch }), true);
  for (const overrides of [
    { event: "pull_request", headRef: "feature/wasm" },
    { event: "pull_request", headRef: releaseBranch, fork: true },
    { event: "pull_request", headRef: releaseBranch, base: "attacker/base" },
    { event: "push", ref: "refs/heads/main" },
  ])
    assert.equal(isRelease(overrides), false, JSON.stringify(overrides));
  // The flag and the signing job agree on which runs are the release pull request's.
  for (const overrides of [{ event: "pull_request", headRef: releaseBranch }, { event: "pull_request", headRef: releaseBranch, base: "attacker/base" }])
    assert.equal(isRelease(overrides), evaluate(ci.jobs["wasm-attest"].if, overrides));

  const off = "${{ env.RELEASE_PR_WASM != 'true' }}";
  assert.equal(step(job, "Restore built wasm module").with.restore, off);
  for (const name of ["Set up cached WASM environment", "Set up WASM build environment"]) assert.equal(step(job, name).with["cache-restore"], off, name);
  for (const candidate of job.steps.filter((entry) => CACHE_ACTION.test(entry.uses ?? "")))
    assert.match(String(candidate.if), /^[^|]*(^|&& )(env\.RELEASE_PR_WASM != 'true'|github\.ref == 'refs\/heads\/main')( &&[^|]*|)$/u, candidate.name);

  const setup = action("setup-build-env");
  assert.equal(setup.inputs["cache-restore"].default, "true");
  const caching = setup.runs.steps.filter((entry) => CACHE_ACTION.test(entry.uses ?? ""));
  assert.ok(caching.length >= 10, "every cache step is found");
  for (const entry of caching) assert.ok(gatesWhole(String(entry.if), "inputs.cache-restore == 'true' && "), entry.name);
  assert.equal(setup.runs.steps.find((entry) => String(entry.uses).startsWith("jdx/mise-action@")).with.cache, "${{ inputs.cache-restore == 'true' }}", "mise's tool cache too");
  // A local action that caches must be handed the switch and gate its own cache steps on it.
  for (const entry of setup.runs.steps.filter((candidate) => String(candidate.uses ?? "").startsWith("./.github/actions/"))) {
    const nested = action(entry.uses.slice("./.github/actions/".length));
    const nestedCaching = nested.runs.steps.filter((candidate) => CACHE_ACTION.test(candidate.uses ?? ""));
    if (nestedCaching.length === 0) continue;
    assert.equal(entry.with["cache-restore"], "${{ inputs.cache-restore }}", entry.name);
    for (const candidate of nestedCaching) assert.match(String(candidate.if), /^inputs\.cache-restore == 'true'( && [^|]*)?$/u, `${entry.uses}: ${candidate.name}`);
  }

  const module = action("wasm-cache");
  for (const entry of module.runs.steps.filter((candidate) => CACHE_ACTION.test(candidate.uses ?? "")))
    assert.ok(String(entry.if).startsWith("inputs.restore == 'true' && "), entry.name);
});
test("a release tag installs the module only through the verifier, against the tag commit", () => {
  const job = ci.jobs.wasm;
  const lookup = step(job, "Resolve release pull request for the tag");
  assert.equal(lookup.if, "github.ref_type == 'tag' && steps.wasm-cache.outputs.cache-hit != 'true'");
  assert.equal(lookup.run, "node scripts/ci/resolve-tag-release-pull.mjs");
  assert.equal(lookup.env.TARGET_SHA, "${{ github.sha }}");
  const resolve = step(job, "Resolve tested WASM artifact for the tag");
  assert.equal(resolve.env.TARGET_SHA, "${{ steps.tag-release.outputs.sha }}");
  assert.equal(resolve.env.PR_NUMBER, "${{ steps.tag-release.outputs.pr }}");
  const fetch = step(job, "Verify and install tested WASM artifact for the tag");
  assert.equal(fetch.run, "node scripts/ci/fetch-verified-wasm.mjs");
  assert.equal(fetch.env.EXPECTED_SHA, "${{ github.sha }}");
  assert.equal(fetch.env.PR_NUMBER, "${{ steps.tag-release.outputs.pr }}");
  assert.equal(fetch.env.RUN_IDS, "${{ steps.tag-ci.outputs.run_ids }}", "every candidate, newest first");
  assert.equal(fetch.id, "tag-wasm");
  // A failed lookup or verification costs a source build, never the tag's deploys.
  for (const entry of [lookup, resolve, fetch]) assert.equal(entry["continue-on-error"], true, entry.name);
  assert.equal(step(job, "Set up cached WASM environment").if, "steps.wasm-cache.outputs.cache-hit == 'true' || steps.tag-wasm.outputs.verified == 'true'");
  for (const name of ["Set up WASM build environment", "Restore WASM target artifacts", "Build production WASM"])
    assert.ok(String(step(job, name).if).includes("steps.tag-wasm.outputs.verified != 'true'"), name);
  assert.equal(step(job, "Save verified WASM module").if.startsWith("steps.wasm-build.outcome == 'success'"), true, "a downloaded module is not cached");
  assert.equal(job.permissions.actions, "read");
  assert.equal(job.permissions.attestations, "read");
  assert.equal(job.permissions["pull-requests"], "read");
  for (const { run = "", uses = "" } of job.steps) assert.doesNotMatch(`${run} ${uses}`, /--name wasm-prod|download-artifact/u);
});
