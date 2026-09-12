#!/usr/bin/env node
// Publication retries MUST accept an existing version, including a concurrent
// publication; prerelease routing MUST use the version, since package names contain hyphens.
//
// Usage: npm-publish-package.mjs [--dry-run] [package-dir]   (default: repository root)
import { chmodSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Actions artifacts lose executable permissions, which npm preserves when packing.
// Non-Windows executables MUST regain those permissions before publication.
const restoreExecutableMode = (dir, manifest) => {
  const targets =
    typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
  for (const target of targets) {
    if (!target.endsWith(".exe")) chmodSync(join(dir, target), 0o755);
  }
};

const main = async () => {
  const dryRun = process.argv.includes("--dry-run");
  const packageDir = process.argv.slice(2).find((argument) => argument !== "--dry-run");
  const dir = resolve(packageDir ?? ".");
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const spec = `${manifest.name}@${manifest.version}`;
  const tag = manifest.version.includes("-") ? "beta" : "latest";
  restoreExecutableMode(dir, manifest);
  const { default: crossSpawn } = await import("cross-spawn");

  const runNpm = (args, options) => {
    const result = crossSpawn.sync("npm", args, options);
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
    return;
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
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export { restoreExecutableMode };
