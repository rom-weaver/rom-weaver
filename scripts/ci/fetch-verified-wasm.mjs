#!/usr/bin/env node

// Downloads a CI run's `wasm-prod` artifact and installs it only if it provably came from
// trusted code building the expected tree; otherwise installs nothing and reports
// `verified=false`, and the release builds the module from source instead. Nothing here may
// fail the job: a failed check costs build time, never correctness.
//
// What "provably" means, in order:
//   1. The run is a successful push or dispatch run of main, or a release pull request run, of this repository's own
//      ci.yml (the same predicate the resolver applies; it is re-checked here).
//   2. `gh attestation verify` accepts the checksum manifest that ci.yml's `wasm-attest` job
//      signed, pinned to this repository, the exact ci.yml signer identity at the run's ref, that
//      ref, the source commit, and a GitHub-hosted runner.
//   3. The signed source commit has the same tree as the commit the release packages. Equal
//      trees mean the signing workflow file is the one on the release commit, and so are the
//      sources it built.
//   4. Every downloaded file matches the manifest, with no file missing or added.
// A pull request run builds `refs/pull/<N>/merge`, a commit the run API does not report, so its
// digest comes from the verified certificate of this run's own attestation (its run invocation
// URI), and is then pinned by a second verification. Several runs can sign byte-identical
// manifests, and anyone with that identity can attest the public manifest again, so the first
// attestation is not necessarily this run's.
//
// The resolver can list several candidate runs (RUN_IDS, newest first); the first that verifies
// is installed. A newer run of another pull request from the same head then costs nothing.

import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { DEFAULT_BRANCH, isTrustedRun, MAIN_EVENTS, normalizePrNumber, readPull, WORKFLOW_PATH } from "./resolve-wasm-run.mjs";
import { checkManifest, MANIFEST_NAME } from "./wasm-manifest.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const gh = (args, env) => execFileSync("gh", args, { encoding: "utf8", env }).trim();

export const sourceRefFor = ({ event, prNumber }) => (MAIN_EVENTS.has(event) ? `refs/heads/${DEFAULT_BRANCH}` : `refs/pull/${prNumber}/merge`);

export const certIdentityFor = ({ serverUrl = "https://github.com", repository, event, prNumber }) =>
  `${serverUrl}/${repository}/${WORKFLOW_PATH}@${sourceRefFor({ event, prNumber })}`;

// Every flag is load-bearing: --cert-identity and --source-ref pin the workflow and ref that
// signed, --source-digest the commit it ran on, --repo the repository, and the last flag keeps
// a runner an attacker controls out.
// gh fetches 30 attestations of a digest by default; more keeps extra copies from hiding this run's.
export const ATTESTATION_LIMIT = "1000";

export const verifyArgs = ({ file, repository, identity, sourceRef: ref, sourceDigest }) => [
  "attestation", "verify", file,
  "--repo", repository,
  "--cert-identity", identity,
  "--source-ref", ref,
  "--source-digest", sourceDigest,
  "--deny-self-hosted-runners",
  "--limit", ATTESTATION_LIMIT,
];

// Every attempt of the run: a rerun signs again under the same run id.
export const runInvocationPrefix = ({ serverUrl = "https://github.com", repository, runId }) => `${serverUrl}/${repository}/actions/runs/${runId}/attempts/`;

// The source digests of this run's verified attestations, one per line (several only if its
// attempts built different commits, which the caller rejects).
export const certificateDigestArgs = ({ file, repository, identity, sourceRef: ref, runPrefix }) => [
  "attestation", "verify", file,
  "--repo", repository,
  "--cert-identity", identity,
  "--source-ref", ref,
  "--deny-self-hosted-runners",
  "--limit", ATTESTATION_LIMIT,
  "--format", "json",
  "--jq", `[.[].verificationResult.signature.certificate | select((.runInvocationURI // "") | startswith(${JSON.stringify(runPrefix)})) | .sourceRepositoryDigest] | unique | .[]`,
];

const requireMatch = (value, pattern, what) => {
  if (!pattern.test(value ?? "")) throw new Error(`${what} is not valid: ${JSON.stringify(value)}`);
  return value;
};

export function fetchVerifiedWasm({ repository, runId, prNumber = "", expectedSha, destination, workDir, serverUrl = "https://github.com", env = process.env, runGh = (args) => gh(args, env) }) {
  requireMatch(repository, /^[\w.-]+\/[\w.-]+$/u, "repository");
  requireMatch(runId, /^[1-9][0-9]*$/u, "run id");
  requireMatch(expectedSha, SHA, "expected commit");
  requireMatch(serverUrl, /^https:\/\/[\w.-]+(:[0-9]+)?$/u, "server URL");
  const number = normalizePrNumber(prNumber);

  const run = JSON.parse(runGh(["api", `repos/${repository}/actions/runs/${runId}`]));
  const pull = run.event === "pull_request" ? readPull({ repository, prNumber: number, runGh }) : null;
  if (String(run.id) !== runId || !isTrustedRun(run, { repository, prNumber: number, pull })) throw new Error(`run ${runId} is not a trusted ci.yml run`);
  const event = run.event;
  const ref = sourceRefFor({ event, prNumber: number });
  const identity = certIdentityFor({ serverUrl, repository, event, prNumber: number });

  const artifact = join(workDir, "wasm-prod");
  const manifestDir = join(workDir, "manifest");
  runGh(["run", "download", runId, "--repo", repository, "--name", "wasm-prod", "--dir", artifact]);
  runGh(["run", "download", runId, "--repo", repository, "--name", "wasm-prod-manifest", "--dir", manifestDir]);
  const manifestFile = join(manifestDir, MANIFEST_NAME);

  let sourceDigest = run.head_sha;
  if (event === "pull_request") {
    const runPrefix = runInvocationPrefix({ serverUrl, repository, runId });
    sourceDigest = requireMatch(runGh(certificateDigestArgs({ file: manifestFile, repository, identity, sourceRef: ref, runPrefix })), SHA, "signed source digest");
  }
  requireMatch(sourceDigest, SHA, "source digest");
  runGh(verifyArgs({ file: manifestFile, repository, identity, sourceRef: ref, sourceDigest }));

  const treeOf = (sha) => requireMatch(runGh(["api", `repos/${repository}/git/commits/${sha}`, "--jq", ".tree.sha"]), SHA, `tree of ${sha}`);
  const sourceTree = treeOf(sourceDigest);
  const expectedTree = treeOf(expectedSha);
  if (sourceTree !== expectedTree) throw new Error(`the signed source tree ${sourceTree} (commit ${sourceDigest}) differs from the release tree ${expectedTree} (commit ${expectedSha})`);

  const files = checkManifest(artifact, readFileSync(manifestFile, "utf8"));
  // All or nothing: a copy that fails partway removes what it installed, so the fallback build
  // starts from the checkout alone.
  const installed = [];
  try {
    for (const path of files) {
      mkdirSync(dirname(join(destination, path)), { recursive: true });
      copyFileSync(join(artifact, path), join(destination, path));
      installed.push(path);
    }
  } catch (error) {
    for (const path of installed) rmSync(join(destination, path), { force: true });
    throw error;
  }
  return { files: files.length, sourceDigest };
}

// Tries each candidate run, newest first, until one verifies; throws every failure otherwise.
export function fetchFirstVerifiedWasm({ runIds, workDir, ...options }) {
  const failures = [];
  for (const [index, runId] of runIds.entries()) {
    try {
      return { runId, ...fetchVerifiedWasm({ ...options, runId, workDir: join(workDir, String(index)) }) };
    } catch (error) {
      failures.push(`run ${runId}: ${String(error.message).split("\n")[0]}`);
    }
  }
  throw new Error(failures.length ? failures.join("; ") : "no candidate run");
}

export const parseRunIds = (value) => String(value ?? "").split(/\s+/u).filter(Boolean);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const workDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "wasm-prod-"));
  let verified = false;
  try {
    const { GITHUB_REPOSITORY: repository, RUN_IDS: runIds, RUN_ID: runId, PR_NUMBER: prNumber, EXPECTED_SHA: expectedSha, DESTINATION: destination = "packages/rom-weaver-webapp/src/wasm", GITHUB_SERVER_URL: serverUrl } = process.env;
    const result = fetchFirstVerifiedWasm({ runIds: parseRunIds(runIds || runId), repository, prNumber, expectedSha, destination, workDir, serverUrl: serverUrl || undefined });
    process.stdout.write(`verified ${result.files} WASM files from run ${result.runId} (signed source ${result.sourceDigest})\n`);
    verified = true;
  } catch (error) {
    // The release falls back to building the module from source.
    process.stdout.write(`::warning title=WASM artifact not reused::${String(error.message).replace(/[\r\n]+/gu, " ")} - building from source\n`);
  } finally { rmSync(workDir, { recursive: true, force: true }); }
  const outputs = `verified=${verified}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs);
  else process.stdout.write(outputs);
}
