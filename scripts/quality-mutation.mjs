#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runMain } from "./run-main.mjs";

export function mutationSummary(report) {
  if (!Array.isArray(report.outcomes)) throw new Error("Missing mutation outcomes");
  const counts = { caught: 0, surviving: 0, timeouts: 0, unviable: 0, baselineFailures: 0 };
  const survivors = [];
  // Unviable mutants never compiled (cargo-mutants mutates by syntax, e.g. `Default::default()`
  // for a type without `Default`), so they are neither catches nor findings.
  const categories = {
    CaughtMutant: "caught",
    MissedMutant: "surviving",
    Timeout: "timeouts",
    Unviable: "unviable",
  };
  for (const outcome of report.outcomes) {
    if (outcome.scenario === "Baseline") {
      if (outcome.summary !== "Success") counts.baselineFailures++;
      continue;
    }
    if (!outcome.scenario?.Mutant || !categories[outcome.summary]) {
      throw new Error(`Unknown mutation outcome: ${outcome.summary}`);
    }
    counts[categories[outcome.summary]]++;
    if (outcome.summary !== "CaughtMutant" && outcome.summary !== "Unviable") {
      survivors.push({
        outcome: outcome.summary,
        mutant: outcome.scenario.Mutant,
        log: outcome.log_path,
        diff: outcome.diff_path,
      });
    }
  }
  return {
    tool: report.cargo_mutants_version,
    ...counts,
    equivalent: 0,
    explicitlyExcluded: [
      {
        path: "crates/rom-weaver-patches/src/test_support.rs",
        reason: "Assertion and fixture helpers are not shipped behavior",
      },
    ],
    exclusions: ".config/mutants.toml (scope and test-helper exclusion; no equivalent claims)",
    survivors,
  };
}

export function mutationArgs({ diff, output, list = false, shard }) {
  const args = [
    "mutants",
    "--config",
    ".config/mutants.toml",
    "--output",
    output,
    "--jobs",
    "2",
    "--timeout",
    "120",
    "--build-timeout",
    "600",
  ];
  if (diff) args.push("--in-diff", diff);
  if (shard) {
    if (!/^(?:0|[1-9]\d*)\/[1-9]\d*$/u.test(shard)) throw new Error("Mutation shard must be i/n");
    const [index, count] = shard.split("/").map(Number);
    if (index >= count) throw new Error("Mutation shard index exceeds shard count");
    args.push("--shard", shard);
  }
  if (list) args.push("--list", "--json");
  return args;
}

export function runMutation(
  argv,
  run = spawnSync,
  output = path.resolve(".agent/quality-mutation"),
) {
  const [mode = "broad", base = "origin/main"] = argv;
  if (!["broad", "diff", "list"].includes(mode))
    throw new Error("Usage: quality-mutation.mjs [broad|diff|list] [base]");
  fs.mkdirSync(output, { recursive: true });
  const report = path.join(output, "mutants.out", "outcomes.json");
  // Stale results MUST never provide evidence for a failed new invocation.
  fs.rmSync(report, { force: true });
  fs.rmSync(path.join(output, "summary.json"), { force: true });
  let diff;
  if (mode === "diff") {
    const merge = run("git", ["merge-base", base, "HEAD"], { encoding: "utf8" });
    if (merge.status !== 0) throw new Error("Cannot resolve mutation merge base");
    const changes = run(
      "git",
      // Pin a/ b/ prefixes: cargo-mutants matches only those, and diff.mnemonicPrefix or
      // diff.noprefix would otherwise make every diff select zero mutants.
      [
        "diff",
        "--no-ext-diff",
        "--unified=0",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        merge.stdout.trim(),
        "--",
        "crates",
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    if (changes.status !== 0) throw new Error("Cannot obtain mutation diff");
    diff = path.join(output, "changes.diff");
    fs.writeFileSync(diff, changes.stdout);
  }
  const result = run(
    "cargo",
    mutationArgs({
      diff,
      output,
      list: mode === "list",
      shard: mode === "broad" && argv[1] ? argv[1] : undefined,
    }),
    {
      stdio: "inherit",
      env: {
        ...process.env,
        CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "4",
        TMPDIR: output,
        TMP: output,
        TEMP: output,
      },
      timeout: 3 * 60 * 60 * 1000,
    },
  );
  if (result.error || result.signal || result.status === null) {
    throw new Error(
      `Mutation subprocess failed: ${result.error?.message ?? result.signal ?? "no exit status"}`,
    );
  }
  if (mode !== "list") {
    if (!fs.existsSync(report) && mode === "diff" && result.status === 0) {
      const summary = mutationSummary({ outcomes: [] });
      summary.noSelectedMutants = true;
      fs.writeFileSync(path.join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
      console.log("No selected mutants; this diff provides no mutation evidence.");
      return 0;
    }
    if (!fs.existsSync(report))
      throw new Error(
        "Mutation run produced no outcomes; setup/build failure is not a caught mutation",
      );
    const summary = mutationSummary(JSON.parse(fs.readFileSync(report, "utf8")));
    fs.writeFileSync(path.join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    if (summary.baselineFailures || summary.timeouts || summary.surviving) return 1;
    if (result.status !== 0) return result.status;
    // Every selected mutant failing to build points at the scratch build, not the code.
    if (summary.caught === 0 && summary.unviable) {
      console.log(
        `All ${summary.unviable} selected mutants were unviable; check the scratch build before trusting this run.`,
      );
      return 1;
    }
    if (summary.caught === 0) {
      console.log("No selected mutants; this run provides no mutation evidence.");
      return mode === "diff" ? 0 : 1;
    }
  }
  return result.status ?? 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMain(() => runMutation(process.argv.slice(2)));
