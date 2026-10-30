#!/usr/bin/env node
// Native CLI apply-matrix runner. See README.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Fixtures } from "./lib/fixtures.mjs";
import { defineAll, defineContainers } from "./lib/fixture-defs.mjs";
import { allCases, defaultCacheDir, runCases, summarize } from "./lib/harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

const usage = `usage: node scripts/apply-matrix/cli/run.mjs [options]
  --bin PATH            rom-weaver binary (default: $RW_BIN, target/release/rom-weaver, target/debug/rom-weaver)
  --filter A,B,...      run cases whose "<id> <tags>" matches any regex (e.g. --filter bps,container.zip)
  --skip REGEX          drop cases matching this regex
  --list                list case ids and exit
  --gen-fixtures        build every fixture and exit
  --update-manifest     rewrite tests/fixtures/apply-matrix/manifest.json from the built fixtures
  --strict              treat known-bug (xfail) cases as failures
  --fail-fast           stop at the first failure
  --verbose             print each rom-weaver invocation
  --work DIR            scratch directory (default: <repo>/.cache/agents/scratch/apply-matrix-cli/work)
  --keep                keep per-case work dirs of passing cases
  --json FILE           also write results as JSON
Environment: RW_BIN, APPLY_MATRIX_CACHE (large/tool fixtures; default ~/.cache/agents/apply-matrix-fixtures)`;

const args = process.argv.slice(2);
const opt = { filter: [], skip: null, strict: false, verbose: false };
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  const value = () => args[++index];
  if (arg === "--bin") opt.bin = value();
  else if (arg === "--filter") opt.filter.push(...value().split(",").filter(Boolean));
  else if (arg === "--skip") opt.skip = new RegExp(value());
  else if (arg === "--list") opt.list = true;
  else if (arg === "--gen-fixtures") opt.gen = true;
  else if (arg === "--update-manifest") opt.manifest = true;
  else if (arg === "--strict") opt.strict = true;
  else if (arg === "--fail-fast") opt.failFast = true;
  else if (arg === "--verbose") opt.verbose = true;
  else if (arg === "--keep") process.env.APPLY_MATRIX_KEEP = "1";
  else if (arg === "--work") opt.work = value();
  else if (arg === "--json") opt.json = value();
  else if (arg === "-h" || arg === "--help") {
    console.log(usage);
    process.exit(0);
  } else {
    console.error(`unknown argument ${arg}\n${usage}`);
    process.exit(2);
  }
}

const bin = [opt.bin, process.env.RW_BIN, path.join(root, "target/release/rom-weaver"), path.join(root, "target/debug/rom-weaver")].find((candidate) => candidate && fs.existsSync(candidate));
if (!bin && !opt.list) {
  console.error("no rom-weaver binary found; run: cargo build -p rom-weaver-cli --release");
  process.exit(2);
}

const fixtureRun = (runArgs) => {
  const result = spawnSync(bin, runArgs, { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { code: result.status, all: `${result.stdout}\n${result.stderr}` };
};
const fixtures = new Fixtures({
  root,
  repoDir: path.join(root, "tests/fixtures/apply-matrix"),
  cacheDir: defaultCacheDir(),
  manifestPath: path.join(root, "tests/fixtures/apply-matrix/manifest.json"),
  run: fixtureRun,
  quiet: !opt.verbose,
});
defineAll(fixtures);
defineContainers(fixtures, { root });

const { registerAll } = await import("./cases/index.mjs");
await registerAll({ root, bin, fixtures });

let selected = allCases();
if (opt.filter.length) {
  const patterns = opt.filter.map((text) => new RegExp(text, "i"));
  selected = selected.filter((entry) => patterns.some((re) => re.test(`${entry.id} ${entry.tags.join(" ")}`)));
}
if (opt.skip) selected = selected.filter((entry) => !opt.skip.test(entry.id));

if (opt.list) {
  for (const entry of selected) console.log(`${entry.id}${entry.tags.length ? `   [${entry.tags.join(" ")}]` : ""}`);
  console.log(`${selected.length} cases`);
  process.exit(0);
}
if (opt.gen) {
  let failures = 0;
  for (const name of fixtures.names()) {
    try {
      fixtures.path(name);
    } catch (error) {
      failures++;
      console.error(`fixture ${name}: ${error.message}`);
    }
  }
  if (opt.manifest) console.log(`manifest: ${fixtures.writeManifest()} entries`);
  console.log(`fixtures built: ${fixtures.names().length - failures}/${fixtures.names().length}`);
  process.exit(failures ? 1 : 0);
}

const workRoot = path.resolve(opt.work ?? path.join(root, ".cache/agents/scratch/apply-matrix-cli/work"));
fs.mkdirSync(workRoot, { recursive: true });
console.log(`bin: ${bin}\nfixtures: repo=${fixtures.repoDir} cache=${fixtures.cacheDir}\ncases: ${selected.length}`);
const results = await runCases({ selected, bin, workRoot, fixtures, verbose: opt.verbose, strict: opt.strict, failFast: opt.failFast });

if (fixtures.drift.length) {
  for (const drift of fixtures.drift) {
    console.log(`FAIL   fixtures.manifest.${drift.name}  sha256 drift: manifest ${drift.expected.slice(0, 12)} != generated ${drift.actual.slice(0, 12)}`);
    results.push({ id: `fixtures.manifest.${drift.name}`, status: "fail", message: "sha256 drift", ms: 0 });
  }
}
if (opt.manifest) console.log(`manifest: ${fixtures.writeManifest()} entries`);
const { text, totals } = summarize(results);
console.log(`\n${text}`);
const failed = results.filter((entry) => entry.status === "fail");
if (failed.length) {
  console.log("\nFAILURES");
  for (const entry of failed) console.log(`- ${entry.id}: ${entry.message}`);
}
const expected = results.filter((entry) => entry.status === "xfail");
if (expected.length) {
  console.log("\nKNOWN BUGS (xfail; use --strict to fail)");
  for (const entry of expected) console.log(`- ${entry.id}: ${entry.message}`);
}
const observed = results.filter((entry) => entry.notes?.length);
if (observed.length) {
  console.log("\nOBSERVATIONS (do not fail the run)");
  for (const entry of observed) for (const note of entry.notes) console.log(`- ${entry.id}: ${note}`);
}
const skipped = results.filter((entry) => entry.status === "skip");
if (skipped.length) {
  console.log("\nSKIPPED");
  for (const entry of skipped) console.log(`- ${entry.id}: ${entry.message}`);
}
if (opt.json) fs.writeFileSync(opt.json, `${JSON.stringify({ bin, totals, results }, null, 2)}\n`);
process.exit(totals.fail ? 1 : 0);
