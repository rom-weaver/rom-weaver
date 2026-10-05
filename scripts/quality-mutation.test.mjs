import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { mutationArgs, mutationSummary, runMutation } from "./quality-mutation.mjs";
const outcome = (summary) => ({
  scenario: { Mutant: { file: "src/parser.rs", line: 42 } },
  summary,
  log_path: "logs/parser.log",
});
test("mutation report keeps caught, survivors, build failures and timeouts separate", () => {
  const report = mutationSummary({
    cargo_mutants_version: "27.1.0",
    outcomes: [
      outcome("CaughtMutant"),
      outcome("MissedMutant"),
      outcome("Timeout"),
      outcome("Unviable"),
      { scenario: "Baseline", summary: "Failure" },
    ],
  });
  assert.equal(report.caught, 1);
  assert.equal(report.surviving, 1);
  assert.equal(report.timeouts, 1);
  assert.equal(report.buildFailures, 1);
  assert.equal(report.baselineFailures, 1);
  assert.equal(report.survivors[0].mutant.line, 42);
});
test("unknown/absent outcomes cannot silently count as caught", () => {
  assert.throws(() => mutationSummary({}), /Missing/);
  assert.throws(() => mutationSummary({ outcomes: [outcome("Success")] }), /Unknown/);
});
test("diff runs retain config and baseline and broad runs omit diff filter", () => {
  assert.deepEqual(mutationArgs({ diff: "change.diff", output: "out" }), [
    "mutants",
    "--config",
    ".config/mutants.toml",
    "--output",
    "out",
    "--jobs",
    "2",
    "--timeout",
    "120",
    "--build-timeout",
    "600",
    "--in-diff",
    "change.diff",
  ]);
  assert.ok(!mutationArgs({ output: "out" }).includes("--baseline"));
  assert.ok(!mutationArgs({ output: "out" }).includes("--in-diff"));
});

test("broad mutation sharding is explicit and invalid shards fail", () => {
  assert.ok(mutationArgs({ output: "out", shard: "1/16" }).includes("1/16"));
  assert.throws(() => mutationArgs({ output: "out", shard: "16/16" }), /shard/);
  assert.throws(() => mutationArgs({ output: "out", shard: "17/16" }), /exceeds/);
});

for (const result of [
  { status: 7 },
  { status: null, signal: "SIGTERM" },
  { status: null, error: new Error("ETIMEDOUT") },
]) {
  test(`failed mutation subprocess cannot hide behind empty outcomes: ${result.status ?? result.signal ?? result.error.message}`, (context) => {
    const scratch = path.resolve(".agent/quality-mutation-tests");
    fs.mkdirSync(scratch, { recursive: true });
    const output = fs.mkdtempSync(path.join(scratch, "run-"));
    context.after(() => fs.rmSync(output, { recursive: true, force: true }));
    const runner = (command, args) => {
      if (command === "git") return { status: 0, stdout: args[0] === "merge-base" ? "abc\n" : "" };
      fs.mkdirSync(path.join(output, "mutants.out"), { recursive: true });
      fs.writeFileSync(
        path.join(output, "mutants.out/outcomes.json"),
        JSON.stringify({ outcomes: [] }),
      );
      return result;
    };
    if (result.status === 7) assert.equal(runMutation(["diff", "main"], runner, output), 7);
    else assert.throws(() => runMutation(["diff", "main"], runner, output), /subprocess failed/);
  });
}
test("stale outcomes are removed before invoking the tool", (context) => {
  const scratch = path.resolve(".agent/quality-mutation-tests");
  fs.mkdirSync(scratch, { recursive: true });
  const output = fs.mkdtempSync(path.join(scratch, "run-"));
  context.after(() => fs.rmSync(output, { recursive: true, force: true }));
  fs.mkdirSync(path.join(output, "mutants.out"));
  fs.writeFileSync(
    path.join(output, "mutants.out/outcomes.json"),
    JSON.stringify({ outcomes: [] }),
  );
  assert.throws(() => runMutation(["broad"], () => ({ status: 1 }), output), /no outcomes/);
});
