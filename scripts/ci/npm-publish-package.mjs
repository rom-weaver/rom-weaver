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
// Usage: npm-publish-package.mjs [package-dir]   (default: repository root)
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const restoreExecutableMode = (dir, manifest) => {
  const binary = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["rom-weaver"];
  if (binary && !binary.endsWith(".exe")) chmodSync(join(dir, binary), 0o755);
};

const main = () => {
  const dir = resolve(process.argv[2] ?? ".");
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const spec = `${manifest.name}@${manifest.version}`;
  const tag = manifest.version.includes("-") ? "beta" : "latest";
  restoreExecutableMode(dir, manifest);

  const runNpm = (args, options) => {
    const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, options);
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

  if (isPublished()) {
    console.log(`${spec} is already published`);
    return;
  }

  console.log(`publishing ${spec} with dist-tag ${tag}`);
  try {
    runNpm(
      [
        "publish",
        dir,
        "--ignore-scripts",
        "--access",
        "public",
        "--provenance",
        "--tag",
        tag,
      ],
      { stdio: "inherit" },
    );
  } catch (error) {
    if (!isPublished()) {
      throw new Error(`failed to publish ${spec}: ${error.message}`);
    }
    console.log(`${spec} was published by another run`);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { restoreExecutableMode };
