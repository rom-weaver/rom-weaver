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
// digest comes from the verified certificate and is then pinned by a second verification.

import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { DEFAULT_BRANCH, isTrustedRun, MAIN_EVENTS, normalizePrNumber, WORKFLOW_PATH } from "./resolve-wasm-run.mjs";
import { checkManifest, MANIFEST_NAME } from "./wasm-manifest.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const gh = (args, env) => execFileSync("gh", args, { encoding: "utf8", env }).trim();

export const sourceRefFor = ({ event, prNumber }) => (MAIN_EVENTS.has(event) ? `refs/heads/${DEFAULT_BRANCH}` : `refs/pull/${prNumber}/merge`);

export const certIdentityFor = ({ serverUrl = "https://github.com", repository, event, prNumber }) =>
  `${serverUrl}/${repository}/${WORKFLOW_PATH}@${sourceRefFor({ event, prNumber })}`;

// Every flag is load-bearing: --cert-identity and --source-ref pin the workflow and ref that
// signed, --source-digest the commit it ran on, --repo the repository, and the last flag keeps
// a runner an attacker controls out.
export const verifyArgs = ({ file, repository, identity, sourceRef: ref, sourceDigest }) => [
  "attestation", "verify", file,
  "--repo", repository,
  "--cert-identity", identity,
  "--source-ref", ref,
  "--source-digest", sourceDigest,
  "--deny-self-hosted-runners",
];

export const certificateDigestArgs = ({ file, repository, identity, sourceRef: ref }) => [
  "attestation", "verify", file,
  "--repo", repository,
  "--cert-identity", identity,
  "--source-ref", ref,
  "--deny-self-hosted-runners",
  "--format", "json",
  "--jq", ".[0].verificationResult.signature.certificate.sourceRepositoryDigest",
];

const requireMatch = (value, pattern, what) => {
  if (!pattern.test(value ?? "")) throw new Error(`${what} is not valid: ${JSON.stringify(value)}`);
  return value;
};

export function fetchVerifiedWasm({ repository, runId, prNumber = "", expectedSha, destination, workDir, serverUrl = "https://github.com", env = process.env, runGh = (args) => gh(args, env) }) {
  requireMatch(repository, /^[\w.-]+\/[\w.-]+$/u, "repository");
  requireMatch(runId, /^[1-9][0-9]*$/u, "run id");
  requireMatch(expectedSha, SHA, "expected commit");
  const number = normalizePrNumber(prNumber);

  const run = JSON.parse(runGh(["api", `repos/${repository}/actions/runs/${runId}`]));
  if (String(run.id) !== runId || !isTrustedRun(run, { repository, prNumber: number })) throw new Error(`run ${runId} is not a trusted ci.yml run`);
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
    sourceDigest = requireMatch(runGh(certificateDigestArgs({ file: manifestFile, repository, identity, sourceRef: ref })), SHA, "signed source digest");
  }
  requireMatch(sourceDigest, SHA, "source digest");
  runGh(verifyArgs({ file: manifestFile, repository, identity, sourceRef: ref, sourceDigest }));

  const treeOf = (sha) => requireMatch(runGh(["api", `repos/${repository}/git/commits/${sha}`, "--jq", ".tree.sha"]), SHA, `tree of ${sha}`);
  const sourceTree = treeOf(sourceDigest);
  const expectedTree = treeOf(expectedSha);
  if (sourceTree !== expectedTree) throw new Error(`the signed source tree ${sourceTree} (commit ${sourceDigest}) differs from the release tree ${expectedTree} (commit ${expectedSha})`);

  const files = checkManifest(artifact, readFileSync(manifestFile, "utf8"));
  for (const path of files) {
    mkdirSync(dirname(join(destination, path)), { recursive: true });
    copyFileSync(join(artifact, path), join(destination, path));
  }
  return { files: files.length, sourceDigest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const workDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "wasm-prod-"));
  let verified = false;
  try {
    const { GITHUB_REPOSITORY: repository, RUN_ID: runId, PR_NUMBER: prNumber, EXPECTED_SHA: expectedSha, DESTINATION: destination = "packages/rom-weaver-webapp/src/wasm", GITHUB_SERVER_URL: serverUrl } = process.env;
    const result = fetchVerifiedWasm({ repository, runId, prNumber, expectedSha, destination, workDir, serverUrl: serverUrl || undefined });
    process.stdout.write(`verified ${result.files} WASM files from run ${runId} (signed source ${result.sourceDigest})\n`);
    verified = true;
  } catch (error) {
    // The release falls back to building the module from source.
    process.stdout.write(`::warning title=WASM artifact not reused::${String(error.message).split("\n")[0]} - building from source\n`);
  } finally { rmSync(workDir, { recursive: true, force: true }); }
  const outputs = `verified=${verified}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs);
  else process.stdout.write(outputs);
}
