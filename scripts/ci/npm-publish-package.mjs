#!/usr/bin/env node
// Publish one package idempotently, choosing its dist-tag from its version.
//
// The release publishes six packages (four platform binaries, the launcher,
// and the unscoped alias) through three jobs that all need the same three
// rules, and a copy of them that drifts either double-publishes or tags a
// prerelease as `latest`:
//
//   1. Never fail because the version is already on the registry. A release
//      job can be re-run, and a publish is irreversible.
//   2. Route prereleases to the `beta` dist-tag, matching the beta web
//      channel and the beta docker tag.
//   3. Treat "publish failed, but the version is now present" as success -
//      that is a concurrent run winning the race, not an error.
//
// Rule 2 keys off the *version*, never the package spec: platform package
// names contain hyphens (@rom-weaver/cli-darwin-arm64), so matching the spec
// would tag every platform package as a prerelease.
//
// Usage: npm-publish-package.mjs [--dry-run] [package-dir]   (default: repository root)
import spawn from "cross-spawn";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const packageDir = process.argv.slice(2).find((argument) => argument !== "--dry-run");
const dir = resolve(packageDir ?? ".");
const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const spec = `${manifest.name}@${manifest.version}`;
const tag = manifest.version.includes("-") ? "beta" : "latest";

const runNpm = (args, options) => {
  const result = spawn.sync("npm", args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm exited with status ${result.status}`);
};

const isPublished = () => {
  try {
    runNpm(["view", spec, "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

if (!dryRun && isPublished()) {
  console.log(`${spec} is already published`);
  process.exit(0);
}

console.log(`${dryRun ? "dry-running" : "publishing"} ${spec} with dist-tag ${tag}`);
try {
  runNpm(
    [
      "publish",
      dir,
      "--ignore-scripts",
      "--access",
      "public",
      ...(dryRun ? ["--dry-run"] : ["--provenance"]),
      "--tag",
      tag,
    ],
    { stdio: "inherit" },
  );
} catch (error) {
  if (dryRun || !isPublished()) {
    throw new Error(`failed to publish ${spec}: ${error.message}`);
  }
  console.log(`${spec} was published by another run`);
}
