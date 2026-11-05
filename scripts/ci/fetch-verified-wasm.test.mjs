import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";

import { makeTempDir } from "../test-temp-dirs.mjs";
import { certIdentityFor, certificateDigestArgs, fetchVerifiedWasm, sourceRefFor, verifyArgs } from "./fetch-verified-wasm.mjs";
import { RELEASE_PR_BRANCH_PREFIX } from "./release-pr.mjs";
import { WORKFLOW_PATH } from "./resolve-wasm-run.mjs";
import { buildManifest, MANIFEST_NAME } from "./wasm-manifest.mjs";

const REPO = "octo/rom-weaver";
const HEAD = "a".repeat(40); // a pull request head, or the main commit of a push run
const MERGE = "b".repeat(40); // refs/pull/7/merge, the commit a pull request run builds
const RELEASE = "c".repeat(40); // the squash-merged release commit
const TREE = "1".repeat(40);
const OTHER_TREE = "2".repeat(40);

const write = (root, files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};
const FILES = { "rom-weaver-app.wasm": "module", NOTICE: "notice", "third_party/licenses/a-1.0.0/LICENSE": "license" };
const manifestFor = (files) => buildManifest(write(makeTempDir("wasm-source-"), files));

const pushRun = (overrides = {}) => ({
  id: 100,
  path: WORKFLOW_PATH,
  event: "push",
  head_branch: "main",
  head_sha: HEAD,
  status: "completed",
  conclusion: "success",
  repository: { full_name: REPO },
  head_repository: { full_name: REPO },
  pull_requests: [],
  ...overrides,
});
const prRun = (overrides = {}) =>
  pushRun({ event: "pull_request", head_branch: `${RELEASE_PR_BRANCH_PREFIX}cli`, pull_requests: [{ number: 7, base: { ref: "main" } }], ...overrides });

// A stubbed `gh` that serves one run, two artifacts, and a tree per commit.
function stub({ run = pushRun(), artifact = FILES, manifest = manifestFor(FILES), trees = {}, verifyError = null, probe = MERGE }) {
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    if (args[0] === "api" && /actions\/runs\/\d+$/u.test(args[1])) return JSON.stringify(run);
    if (args[0] === "run" && args[1] === "download") {
      const dir = args[args.indexOf("--dir") + 1];
      if (args[args.indexOf("--name") + 1] === "wasm-prod") write(dir, artifact);
      else write(dir, { [MANIFEST_NAME]: manifest });
      return "";
    }
    if (args[0] === "attestation") {
      if (verifyError) throw new Error(verifyError);
      return args.includes("--format") ? probe : "";
    }
    const commit = /git\/commits\/([0-9a-f]+)$/u.exec(args[1] ?? "");
    if (args[0] === "api" && commit) {
      if (!(commit[1] in trees)) throw new Error(`no such commit ${commit[1]}`);
      return trees[commit[1]];
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { calls, runGh };
}
const fetchWith = (gh, overrides = {}) => {
  const destination = makeTempDir("wasm-destination-");
  const workDir = makeTempDir("wasm-work-");
  const options = { repository: REPO, runId: "100", expectedSha: HEAD, destination, workDir, runGh: gh.runGh, ...overrides };
  return { destination, run: () => fetchVerifiedWasm(options) };
};
const installed = (destination) =>
  readdirSync(destination, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length;
const attestationCalls = (gh) => gh.calls.filter((args) => args[0] === "attestation");

test("the signer identity and ref are exact for a main push and for the release pull request", () => {
  assert.equal(certIdentityFor({ repository: REPO, event: "push", prNumber: "" }), `https://github.com/${REPO}/.github/workflows/ci.yml@refs/heads/main`);
  assert.equal(certIdentityFor({ repository: REPO, event: "pull_request", prNumber: "7" }), `https://github.com/${REPO}/.github/workflows/ci.yml@refs/pull/7/merge`);
  assert.equal(sourceRefFor({ event: "push" }), "refs/heads/main");
  assert.equal(sourceRefFor({ event: "pull_request", prNumber: "7" }), "refs/pull/7/merge");
});

test("gh attestation verify pins repo, signer identity, ref, source commit, and hosted runners", () => {
  assert.deepEqual(
    verifyArgs({ file: "m.sha256", repository: REPO, identity: "ID", sourceRef: "REF", sourceDigest: HEAD }),
    ["attestation", "verify", "m.sha256", "--repo", REPO, "--cert-identity", "ID", "--source-ref", "REF", "--source-digest", HEAD, "--deny-self-hosted-runners"],
  );
  const probe = certificateDigestArgs({ file: "m.sha256", repository: REPO, identity: "ID", sourceRef: "REF" });
  for (const flag of ["--repo", "--cert-identity", "--source-ref", "--deny-self-hosted-runners"]) assert.ok(probe.includes(flag), flag);
  assert.ok(!probe.includes("--cert-identity-regex") && !probe.includes("-i"));
});

test("a push-to-main artifact is verified against the run's commit and installed", () => {
  const gh = stub({ trees: { [HEAD]: TREE } });
  const { destination, run } = fetchWith(gh);
  assert.equal(run().files, 3);
  assert.equal(readFileSync(join(destination, "third_party/licenses/a-1.0.0/LICENSE"), "utf8"), "license");
  const [verify, ...rest] = attestationCalls(gh);
  assert.equal(rest.length, 0);
  assert.deepEqual(verify.slice(3), [
    "--repo", REPO,
    "--cert-identity", `https://github.com/${REPO}/.github/workflows/ci.yml@refs/heads/main`,
    "--source-ref", "refs/heads/main",
    "--source-digest", HEAD,
    "--deny-self-hosted-runners",
  ]);
});

test("a release pull request artifact is verified at its merge commit, whose tree must equal the release tree", () => {
  const gh = stub({ run: prRun(), trees: { [MERGE]: TREE, [RELEASE]: TREE } });
  const { destination, run } = fetchWith(gh, { prNumber: "7", expectedSha: RELEASE });
  assert.equal(run().sourceDigest, MERGE);
  assert.equal(installed(destination), 3);
  const [probe, verify] = attestationCalls(gh);
  assert.ok(probe.includes("--format") && !probe.includes("--source-digest"));
  assert.equal(probe[probe.indexOf("--cert-identity") + 1], `https://github.com/${REPO}/.github/workflows/ci.yml@refs/pull/7/merge`);
  assert.equal(verify[verify.indexOf("--source-digest") + 1], MERGE, "the digest read from the certificate is then pinned");
  assert.equal(verify[verify.indexOf("--source-ref") + 1], "refs/pull/7/merge");
  assert.ok(verify.includes("--deny-self-hosted-runners"));
});

test("a signed tree that differs from the release tree installs nothing", () => {
  const gh = stub({ run: prRun(), trees: { [MERGE]: OTHER_TREE, [RELEASE]: TREE } });
  const { destination, run } = fetchWith(gh, { prNumber: "7", expectedSha: RELEASE });
  assert.throws(run, /differs from the release tree/u);
  assert.equal(installed(destination), 0);
});

test("an unreadable source commit installs nothing", () => {
  const gh = stub({ trees: { [RELEASE]: TREE } });
  const { destination, run } = fetchWith(gh, { expectedSha: RELEASE });
  assert.throws(run, /no such commit/u);
  assert.equal(installed(destination), 0);
});

test("a failed attestation verification installs nothing", () => {
  for (const prNumber of ["", "7"]) {
    const gh = stub({ run: prNumber ? prRun() : pushRun(), verifyError: "no matching attestations", trees: { [HEAD]: TREE, [MERGE]: TREE } });
    const { destination, run } = fetchWith(gh, { prNumber });
    assert.throws(run, /no matching attestations/u);
    assert.equal(installed(destination), 0);
  }
});

test("a certificate digest that is not a commit is refused before it is pinned", () => {
  for (const probe of ["", "main", "b".repeat(39), `${MERGE}\n${MERGE}`]) {
    const gh = stub({ run: prRun(), probe, trees: { [MERGE]: TREE } });
    const { destination, run } = fetchWith(gh, { prNumber: "7" });
    assert.throws(run, /signed source digest is not valid/u, JSON.stringify(probe));
    assert.equal(installed(destination), 0);
  }
});

test("an artifact that is not what the manifest signed installs nothing", () => {
  const tampered = { ...FILES, "rom-weaver-app.wasm": "evil" };
  const extra = { ...FILES, "injected.js": "x" };
  const missing = { "rom-weaver-app.wasm": "module" };
  for (const artifact of [tampered, extra, missing]) {
    const gh = stub({ artifact, trees: { [HEAD]: TREE } });
    const { destination, run } = fetchWith(gh);
    assert.throws(run);
    assert.equal(installed(destination), 0);
  }
});

test("runs the resolver would not pick are refused before anything is downloaded", () => {
  const attackerPr = prRun({ head_branch: "attacker", pull_requests: [{ number: 99, base: { ref: "attacker/base" } }] });
  const cases = [
    [attackerPr, "99"],
    [prRun(), "8"],
    [prRun(), ""],
    [pushRun({ event: "workflow_dispatch" }), ""],
    [pushRun({ head_branch: "attacker" }), ""],
    [pushRun({ path: ".github/workflows/evil/.github/workflows/ci.yml" }), ""],
    [pushRun({ head_repository: { full_name: "attacker/rom-weaver" } }), ""],
    [pushRun({ id: 101 }), ""],
  ];
  for (const [run, prNumber] of cases) {
    const gh = stub({ run, trees: { [HEAD]: TREE, [MERGE]: TREE } });
    const { destination, run: attempt } = fetchWith(gh, { prNumber });
    assert.throws(attempt, /not a trusted ci\.yml run/u, JSON.stringify([run.event, run.head_branch, prNumber]));
    assert.ok(!gh.calls.some((args) => args[0] === "run"), "nothing is downloaded");
    assert.equal(installed(destination), 0);
  }
});

test("malformed inputs are refused", () => {
  const gh = stub({ trees: { [HEAD]: TREE } });
  for (const overrides of [{ runId: "1; rm" }, { runId: "" }, { expectedSha: "main" }, { expectedSha: "" }, { repository: "no-slash" }])
    assert.throws(fetchWith(gh, overrides).run, /is not valid/u, JSON.stringify(overrides));
});

// The script's fallback: whatever fails, it exits 0 and reports verified=false, so the release
// builds from source. A fake `gh` on PATH stands in for the real one.
function fakeGh(directory) {
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const script = join(bin, "gh");
  writeFileSync(
    script,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
if (args[0] === "api" && /actions\\/runs\\/\\d+$/.test(args[1])) process.stdout.write(JSON.stringify(state.run));
else if (args[0] === "run") {
  const dir = args[args.indexOf("--dir") + 1];
  const files = state.files[args[args.indexOf("--name") + 1]];
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
} else if (args[0] === "attestation") {
  if (state.verifyFails) { process.stderr.write("no matching attestations\\n"); process.exit(1); }
} else if (args[0] === "api") process.stdout.write(state.tree);
`,
  );
  chmodSync(script, 0o755);
  return bin;
}
function runScript({ verifyFails }) {
  const directory = makeTempDir("fetch-wasm-cli-");
  const state = join(directory, "state.json");
  writeFileSync(state, JSON.stringify({ run: pushRun(), tree: TREE, verifyFails, files: { "wasm-prod": FILES, "wasm-prod-manifest": { [MANIFEST_NAME]: manifestFor(FILES) } } }));
  const destination = join(directory, "installed");
  const output = join(directory, "output");
  // Git hooks export GIT_DIR and friends; nothing here spawns git, but keep them out regardless.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = spawnSync(process.execPath, [new URL("./fetch-verified-wasm.mjs", import.meta.url).pathname], {
    encoding: "utf8",
    env: {
      ...env,
      PATH: `${fakeGh(directory)}:${process.env.PATH}`,
      FAKE_GH_STATE: state,
      GITHUB_REPOSITORY: REPO,
      RUN_ID: "100",
      EXPECTED_SHA: HEAD,
      DESTINATION: destination,
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: directory,
    },
  });
  return { result, destination, outputs: readFileSync(output, "utf8") };
}

test("the script reports verified=true and installs the files when everything checks out", () => {
  const { result, destination, outputs } = runScript({ verifyFails: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(outputs, "verified=true\n");
  assert.equal(readFileSync(join(destination, "rom-weaver-app.wasm"), "utf8"), "module");
});

test("the script falls back to a source build, without failing the job, when verification fails", () => {
  const { result, destination, outputs } = runScript({ verifyFails: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(outputs, "verified=false\n");
  assert.match(result.stdout, /::warning title=WASM artifact not reused::/u);
  assert.equal(existsSync(destination), false);
});
