import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const ACTIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "actions");

// Every action that can build identify data MUST install the build dependencies.
const actionsRunningTheBuild = () =>
  readdirSync(ACTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(ACTIONS_DIR, entry.name, "action.yml") }))
    .flatMap((action) => {
      let body;
      try {
        body = readFileSync(action.path, "utf8");
      } catch {
        return [];
      }
      return body.includes("node scripts/ensure-identify-data.mjs") ? [{ ...action, body }] : [];
    });

test("every action that builds identify data installs its npm dependencies", () => {
  const actions = actionsRunningTheBuild();
  // If this ever reads zero, the check has stopped checking anything.
  assert.ok(actions.length > 0, "no action runs the identify build; the matcher is stale");
  const missing = actions
    .filter((action) => !action.body.includes("npm ci --ignore-scripts"))
    .map((action) => action.name);
  assert.deepEqual(missing, [], `these run the identify build without installing first: ${missing}`);
});

test("the identify build install is gated on a cache miss", () => {
  // A cache hit makes the build a no-op. Installing unconditionally would put
  // an npm ci on every job that only wants the prebuilt packs, including the
  // slow Windows runner.
  for (const action of actionsRunningTheBuild()) {
    const lines = action.body.split("\n");
    const install = lines.findIndex((line) => line.includes("npm ci --ignore-scripts"));
    assert.notEqual(install, -1, `${action.name} has no identify install step`);
    // The step's `if:` sits between its `- name:` and its `run:`.
    const start = lines.slice(0, install).findLastIndex((line) => line.trimStart().startsWith("- name:"));
    const condition = lines.slice(start, install).find((line) => line.trimStart().startsWith("if:"));
    assert.ok(condition, `${action.name}: the identify install step has no condition`);
    assert.match(condition, /cache-hit != 'true'/u, `${action.name}: ${condition.trim()}`);
  }
});

// Rust test jobs can request identify data without calling a composite action.
const WORKFLOW = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".github",
  "workflows",
  "ci.yml",
);

test("every job that runs the Rust tests downloads the run's identify data", () => {
  const body = readFileSync(WORKFLOW, "utf8");
  // Job blocks start at a two-space-indented `<name>:` key.
  const jobs = body.split(/\n(?=  [\w-]+:\n)/u).filter((job) => job.includes("mise run test-rust"));
  assert.ok(jobs.length > 0, "no job runs the Rust tests; the matcher is stale");
  const missing = jobs
    .filter(
      (job) =>
        !(
          job.includes("identify-data") &&
          job.includes("./.github/actions/download-identify-data") &&
          /tools:.*\bnode\b/u.test(job)
        ),
    )
    .map((job) => job.trimStart().split(":", 1)[0]);
  assert.deepEqual(missing, [], `these run the Rust tests without node + run identify data: ${missing}`);
});

test("CI prepares identify data once and shares the artifact with every consumer", () => {
  const body = readFileSync(WORKFLOW, "utf8");
  const jobFor = (name) => {
    const start = body.indexOf(`  ${name}:\n`);
    if (start === -1) return undefined;
    const next = body.slice(start + 1).search(/\n  [\w-]+:\n/u);
    return next === -1 ? body.slice(start) : body.slice(start, start + 1 + next);
  };
  const producer = jobFor("identify-data");
  assert.ok(producer, "CI has no identify data producer job");
  assert.match(producer, /uses: \.\/\.github\/actions\/identify-data/u);
  assert.match(producer, /name: identify-data/u);
  assert.match(producer, /path: crates\/rom-weaver-cli\/data\/identify/u);
  assert.match(producer, /compression-level: 0/u);
  const downloader = readFileSync(join(ACTIONS_DIR, "download-identify-data", "action.yml"), "utf8");
  // Uploading `identify` makes `v1` the artifact's top-level entry; download
  // into that same directory restores the path every data consumer reads.
  assert.match(downloader, /name: identify-data/u);
  assert.match(downloader, /path: crates\/rom-weaver-cli\/data\/identify/u);

  const consumers = [
    "docker",
    "wasm",
    "rust-lint",
    "rust-host",
    "cli-platforms",
    "rust-macos",
    "rust-windows",
    "webapp-static",
    "webapp-e2e",
    "webapp-webkit-e2e",
    "deploy-preview-fast",
    "deploy",
  ];
  for (const name of consumers) {
    const job = jobFor(name);
    assert.ok(job, `CI has no ${name} job`);
    assert.match(job, /needs:.*identify-data/u, `${name} does not wait for identify data`);
  }

  for (const name of ["docker", "wasm", "rust-lint", "rust-host", "rust-macos", "rust-windows", "webapp-static", "webapp-e2e", "webapp-webkit-e2e"]) {
    const job = jobFor(name);
    assert.match(job, /uses: \.\/\.github\/actions\/download-identify-data/u, `${name} does not download identify data`);
  }
  const cliPlatforms = jobFor("cli-platforms");
  assert.match(cliPlatforms, /identify-data-source: artifact/u);
  for (const name of ["deploy-preview-fast", "deploy"]) {
    const job = jobFor(name);
    assert.match(job, /identify-data-source: artifact/u, `${name} does not use the identify artifact`);
  }
});

test("identify Brotli cache is main-only and has a stable producer directory", () => {
  const action = readFileSync(join(ACTIONS_DIR, "identify-data", "action.yml"), "utf8");
  assert.match(action, /ROM_WEAVER_IDENTIFY_CACHE_DIR: \$\{\{ github\.workspace \}\}\/.cache\/identify/u);
  assert.match(action, /key: identify-brotli-\$\{\{ runner\.os \}\}-epoch1-/u);
  const save = action.match(/- name: Save identify Brotli cache\n([\s\S]*?)(?=\n    - name:|\s*$)/u)?.[0];
  assert.ok(save, "identify Brotli cache has no save step");
  assert.match(save, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(save, /steps\.cache\.outputs\.cache-hit != 'true'/u);
  assert.match(action, /Restore identify Brotli cache\n      if: steps\.cache\.outputs\.cache-hit != 'true'/u);
  assert.match(action, /key: identify-brotli-\$\{\{ runner\.os \}\}-epoch1-\$\{\{ hashFiles\('scripts\/ensure-identify-data\.mjs'/u);
});

test("identify producer runs for every selected consumer and skips fork documentation runs", () => {
  const body = readFileSync(WORKFLOW, "utf8");
  const identify = body.match(/^  identify-data:\n([\s\S]*?)^    steps:/mu)?.[0];
  assert.ok(identify, "CI has no identify producer condition");
  const condition = identify.match(/    if: >-\n([\s\S]*?)\n    steps:/u)?.[1].trim();
  assert.ok(condition, "identify producer has no condition");
  const selected = ({ eventName, rust = "false", webapp = "false", docker = "[]", deploy = "", firstParty = false }) =>
    runInNewContext(condition, {
      github: {
        event_name: eventName,
        repository: "owner/repo",
        event: {
          pull_request: {
            head: { repo: { full_name: firstParty ? "owner/repo" : "fork/repo" } },
            user: { login: "contributor" },
          },
        },
      },
      needs: { changes: { outputs: { deploy_targets: deploy, docker_matrix: docker, rust, webapp } } },
    });

  assert.equal(selected({ eventName: "push", webapp: "true" }), true, "tag deploy can build WASM");
  assert.equal(selected({ eventName: "workflow_dispatch" }), true, "manual runs can select consumers");
  assert.equal(selected({ eventName: "pull_request", firstParty: true }), true, "first-party previews need data");
  assert.equal(selected({ eventName: "pull_request" }), false, "fork documentation runs do not build data");
});
