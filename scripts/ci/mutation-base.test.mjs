import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { findMutationBaseSha, MUTATION_JOB } from "./mutation-base.mjs";

const repo = "owner/repo";
const sha = (id) => String(id).padStart(40, "a");
const job = (name, conclusion) => ({ name, conclusion });
const nightly = (id, jobs, extra = {}) => ({
  id,
  head_sha: sha(id),
  event: "schedule",
  head_branch: "main",
  status: "completed",
  jobs,
  ...extra,
});

// The runs and jobs endpoints over `runs`, newest first, honouring the filters the API applies.
function actionsApi(runs) {
  return async (path) => {
    const url = new URL(path, "https://api.invalid");
    if (url.pathname === `/repos/${repo}/actions/workflows/ci.yml/runs`) {
      const query = url.searchParams;
      const listed = runs.filter(
        (run) =>
          run.event === query.get("event") &&
          run.head_branch === query.get("branch") &&
          run.status === query.get("status"),
      );
      return { total_count: listed.length, workflow_runs: listed.slice(0, Number(query.get("per_page"))) };
    }
    const runId = url.pathname.match(/^\/repos\/owner\/repo\/actions\/runs\/(\d+)\/jobs$/u)?.[1];
    if (runId) {
      const { jobs } = runs.find((run) => run.id === Number(runId));
      return { total_count: jobs.length, jobs };
    }
    throw new Error(`unexpected request: ${path}`);
  };
}

const find = (runs) => findMutationBaseSha({ api: actionsApi(runs), repo, branch: "main" });

test("the newest completed nightly whose mutation job ran is the baseline, whatever its conclusion", async () => {
  for (const conclusion of ["success", "failure", "cancelled"]) {
    const runs = [
      nightly(5, [job(MUTATION_JOB, null)], { status: "in_progress" }),
      nightly(4, [job(MUTATION_JOB, "success")], { head_branch: "feature" }),
      nightly(3, [job(MUTATION_JOB, "success")], { event: "push" }),
      nightly(2, [job("Rust (host)", "success"), job(MUTATION_JOB, conclusion)]),
      nightly(1, [job(MUTATION_JOB, "success")]),
    ];
    assert.equal(await find(runs), sha(2), conclusion);
  }
});

test("a nightly that skipped the mutation job or never selected it keeps the older baseline", async () => {
  const runs = [
    nightly(4, [job("Rust (host)", "failure"), job(MUTATION_JOB, "skipped")]),
    nightly(3, [job("Rust (host)", "success"), job("Quality signal (fuzz)", "success")]),
    nightly(2, [job("Quality signal (${{ matrix.signal }})", "cancelled")]),
    nightly(1, [job(MUTATION_JOB, "failure")]),
  ];
  assert.equal(await find(runs), sha(1));
});

test("no baseline when no nightly in range ran the mutation job", async () => {
  assert.equal(await find([]), "");
  const unselected = Array.from({ length: 10 }, (_, index) => nightly(20 - index, [job("Rust (host)", "success")]));
  assert.equal(await find([...unselected, nightly(1, [job(MUTATION_JOB, "success")])]), "", "past the look-back");
});

test("the workflow runs the lookup and names the job it looks for", () => {
  const { load } = createRequire(import.meta.url)("js-yaml");
  const ci = load(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const step = ci.jobs.changes.steps.find((candidate) => candidate.id === "last-nightly");
  assert.ok(step.run.includes("node scripts/ci/mutation-base.mjs"));
  assert.equal(step.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(ci.jobs["quality-analysis"].name.replace("${{ matrix.signal }}", "mutation"), MUTATION_JOB);
});

test("the script writes the baseline to the step output, and an empty one with a warning on a failed lookup", async (t) => {
  const runs = [nightly(3, [job(MUTATION_JOB, "skipped")]), nightly(2, [job(MUTATION_JOB, "success")])];
  const api = actionsApi(runs);
  const actions = createServer(async (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(await api(request.url)));
  });
  const badGateway = createServer((_request, response) => {
    response.writeHead(502);
    response.end("bad gateway");
  });
  for (const server of [actions, badGateway]) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
  }
  const scratch = mkdtempSync(join(tmpdir(), "mutation-base-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  for (const { server, output, stdout } of [
    { server: actions, output: `mutation_sha=${sha(2)}\n`, stdout: new RegExp(`^mutation baseline: ${sha(2)}\n$`, "u") },
    { server: badGateway, output: "mutation_sha=\n", stdout: /^::warning::finding the mutation baseline failed; .*502: bad gateway\n$/u },
  ]) {
    const outputFile = join(scratch, `output-${server.address().port}`);
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./mutation-base.mjs", import.meta.url))], {
      env: {
        ...process.env,
        GH_TOKEN: "token",
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        GITHUB_REPOSITORY: repo,
        GITHUB_OUTPUT: outputFile,
      },
    });
    assert.match(result.stdout, stdout);
    assert.equal(readFileSync(outputFile, "utf8"), output);
  }
});
