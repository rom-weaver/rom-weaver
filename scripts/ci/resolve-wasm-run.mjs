#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const gh = (args, env) => execFileSync("gh", args, { encoding: "utf8", env }).trim();

export function resolveWasmRun({ repository, targetSha, preferredRunId = "", env = process.env, runGh = (args) => gh(args, env) }) {
  let runId = preferredRunId;
  if (runId) {
    const runSha = runGh(["api", `repos/${repository}/actions/runs/${runId}`, "--jq", ".head_sha"]);
    if (runSha !== targetSha) {
      process.stdout.write(`run ${runId} is for ${runSha}, not ${targetSha} - searching by commit\n`);
      runId = "";
    }
  }
  if (!runId) runId = runGh(["run", "list", "--repo", repository, "--workflow", "ci.yml", "--commit", targetSha, "--status", "success", "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId"]);
  let available = false;
  if (runId) available = Number(runGh(["api", `repos/${repository}/actions/runs/${runId}/artifacts`, "--jq", '[.artifacts[] | select(.name == "wasm-prod" and .expired == false)] | length'])) > 0;
  return { runId, available };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env.GITHUB_REPOSITORY || !process.env.TARGET_SHA) throw new Error("GITHUB_REPOSITORY and TARGET_SHA are required");
    const { runId, available } = resolveWasmRun({ repository: process.env.GITHUB_REPOSITORY, targetSha: process.env.TARGET_SHA, preferredRunId: process.env.PREFERRED_RUN_ID });
    const line = `run_id=${runId} available=${available} (sha ${process.env.TARGET_SHA})\n`;
    process.stdout.write(line);
    appendFileSync(process.env.GITHUB_OUTPUT || "/dev/stdout", `run_id=${runId}\navailable=${available}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
