#!/usr/bin/env node
// Publication retries MUST accept an existing version, including a concurrent
// publication; prerelease routing MUST use the version, since package names contain hyphens.
//
// Usage: npm-publish-package.mjs [--dry-run] [package-dir]   (default: repository root)
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Finds npm's own script so it can be run with this node. `npm` is `npm.cmd` on Windows, which node
// refuses to spawn without a shell (CVE-2024-27980) and which a shell would need escaped arguments
// for; `npm.cmd` only runs `node npm-cli.js` anyway. Mirrors the layouts actions/setup-node
// installs: `<dir>/npm` symlinked into `lib/node_modules/npm` on Linux and macOS, and
// `<dir>/node_modules/npm` beside `npm.cmd` on Windows. Running from `npm run` or `npx` is covered
// by `npm_execpath`.
const resolveNpmCli = ({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  realpath = realpathSync,
} = {}) => {
  const fromNpm = env.npm_execpath;
  if (fromNpm && /npm-cli\.c?js$/u.test(fromNpm) && exists(fromNpm)) return fromNpm;
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (platform === "win32") {
      const cli = join(directory, "node_modules", "npm", "bin", "npm-cli.js");
      if (exists(join(directory, "npm.cmd")) && exists(cli)) return cli;
    } else if (exists(join(directory, "npm"))) {
      const cli = realpath(join(directory, "npm"));
      if (/npm-cli\.c?js$/u.test(cli)) return cli;
    }
  }
  throw new Error("cannot find npm-cli.js next to npm on PATH");
};

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
  const npmCli = resolveNpmCli();

  const runNpm = (args, options) => {
    const result = spawnSync(process.execPath, [npmCli, ...args], options);
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

export { resolveNpmCli, restoreExecutableMode };
