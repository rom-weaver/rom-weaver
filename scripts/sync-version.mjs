#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const rootDir = process.cwd();
const packageJsonPath = join(rootDir, "package.json");
const workspaceCargoTomlPath = join(rootDir, "Cargo.toml");
const syncedPackageJsonPaths = [
  "packages/rom-weaver-webapp/package.json",
  "packages/rom-weaver-alias/package.json",
  "packages/rom-weaver-cli-platforms/darwin-arm64/package.json",
  "packages/rom-weaver-cli-platforms/darwin-x64/package.json",
  "packages/rom-weaver-cli-platforms/linux-x64-gnu/package.json",
  "packages/rom-weaver-cli-platforms/win32-x64-msvc/package.json",
];
// Manifests carrying exact-pinned @rom-weaver/* deps. These pins are separate
// from the package's own version and would otherwise go stale on a bump,
// shipping a launcher that resolves last release's binaries.
const pinnedDependencyPackageJsonPaths = ["package.json", "packages/rom-weaver-alias/package.json"];
const syncedPackageDirs = [".", "packages/rom-weaver-webapp"];

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

async function readRootPackageVersion() {
  const content = await readFile(packageJsonPath, "utf8");
  const pkg = JSON.parse(content);
  if (typeof pkg.version !== "string" || !pkg.version) {
    throw new Error("No version found in package.json");
  }
  return pkg.version;
}

async function readWorkspaceCargoTomlPaths() {
  const content = await readFile(workspaceCargoTomlPath, "utf8");
  const membersBlock = content.match(/members\s*=\s*\[([\s\S]*?)\]/m)?.[1];
  if (!membersBlock) {
    throw new Error("Could not find workspace members in Cargo.toml");
  }

  const members = Array.from(membersBlock.matchAll(/"([^"]+)"/g), (match) => match[1]);
  const cargoTomlPaths = [workspaceCargoTomlPath];
  for (const member of members) {
    const cargoTomlPath = join(rootDir, member, "Cargo.toml");
    if (await fileExists(cargoTomlPath)) {
      cargoTomlPaths.push(cargoTomlPath);
    }
  }

  return cargoTomlPaths;
}

async function updateWorkspacePackageVersion(version) {
  let content = await readFile(workspaceCargoTomlPath, "utf8");
  const match = content.match(/(\[workspace\.package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m);
  if (!match) {
    throw new Error("Could not find [workspace.package] version in Cargo.toml");
  }

  const currentVersion = match[2];
  if (currentVersion === version) {
    console.log(`${workspaceCargoTomlPath} workspace package is already at version ${version}`);
    return false;
  }

  content = content.replace(match[0], `${match[1]}${version}${match[3]}`);
  await writeFile(workspaceCargoTomlPath, content, "utf8");
  console.log(`Updated ${workspaceCargoTomlPath}: ${currentVersion} -> ${version}`);
  return true;
}

async function updateInternalCargoDependencyVersions(cargoTomlPaths, version) {
  const dependencyRegex = /^(?=\s*(?:rom-weaver-[A-Za-z0-9_-]+\s*=|[A-Za-z0-9_-]+\s*=\s*\{[^}\n]*\bpackage\s*=\s*"rom-weaver-[^"]+"))(\s*[A-Za-z0-9_-]+\s*=\s*\{[^}\n]*\bversion\s*=\s*")([^"]+)("[^}\n]*\}\s*)$/gm;
  let changed = false;

  for (const cargoTomlPath of cargoTomlPaths) {
    let content = await readFile(cargoTomlPath, "utf8");
    const nextContent = content.replace(dependencyRegex, (line, prefix, currentVersion, suffix) => {
      if (currentVersion === version) return line;
      changed = true;
      console.log(`Updated ${cargoTomlPath}: internal dependency ${currentVersion} -> ${version}`);
      return `${prefix}${version}${suffix}`;
    });

    if (nextContent !== content) {
      await writeFile(cargoTomlPath, nextContent, "utf8");
    }
  }

  return changed;
}

async function updatePackageJsonVersion(packageJsonRelativePath, version) {
  const packageJsonFilePath = join(rootDir, packageJsonRelativePath);
  if (!(await fileExists(packageJsonFilePath))) {
    console.warn(`Skipped ${packageJsonRelativePath}: not found`);
    return false;
  }

  let content = await readFile(packageJsonFilePath, "utf8");
  const pkg = JSON.parse(content);
  if (pkg.version === version) {
    console.log(`${packageJsonFilePath} is already at version ${version}`);
    return false;
  }

  const currentVersion = pkg.version;
  pkg.version = version;
  content = `${JSON.stringify(pkg, null, 2)}\n`;
  await writeFile(packageJsonFilePath, content, "utf8");
  console.log(`Updated ${packageJsonFilePath}: ${currentVersion} -> ${version}`);
  return true;
}

async function updatePinnedDependencyVersions(packageJsonRelativePath, version) {
  const packageJsonFilePath = join(rootDir, packageJsonRelativePath);
  if (!(await fileExists(packageJsonFilePath))) {
    console.warn(`Skipped ${packageJsonRelativePath}: not found`);
    return false;
  }

  const pkg = JSON.parse(await readFile(packageJsonFilePath, "utf8"));
  let changed = false;

  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (!name.startsWith("@rom-weaver/")) continue;
      const currentVersion = pkg[field][name];
      if (currentVersion === version) continue;
      pkg[field][name] = version;
      changed = true;
      console.log(
        `Updated ${packageJsonFilePath}: ${field}.${name} ${currentVersion} -> ${version}`,
      );
    }
  }

  if (changed) {
    await writeFile(packageJsonFilePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  }
  return changed;
}

function updateCargoLock() {
  // `cargo metadata --no-deps` skips dependency resolution and never writes
  // Cargo.lock; only a resolving command syncs the lock to the bumped
  // manifests. A stale committed lock makes every CI build report a dirty
  // version, so failure here must abort the bump rather than warn.
  try {
    execFileSync("cargo", ["update", "--workspace"], {
      cwd: rootDir,
      stdio: "pipe",
    });
    console.log("Updated Cargo.lock");
  } catch (error) {
    throw new Error(`Could not update Cargo.lock: ${error.message}`);
  }
}

function updatePackageLock(packageDir) {
  try {
    execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
      cwd: join(rootDir, packageDir),
      stdio: "pipe",
    });
    const lockfileName = packageDir === "." ? "package-lock.json" : `${packageDir}/package-lock.json`;
    console.log(`Updated ${lockfileName}`);
  } catch (_error) {
    const lockfileName = packageDir === "." ? "package-lock.json" : `${packageDir}/package-lock.json`;
    console.warn(`Warning: Could not update ${lockfileName} (npm may not be available)`);
  }
}

function stageAllChanges() {
  // Stage everything the bump touched so nothing is left out of the version
  // commit. npm requires a clean tree to start `npm version`, so the only
  // changes present here are the ones this bump produced.
  try {
    execFileSync("git", ["add", "-A"], {
      cwd: rootDir,
      stdio: "inherit",
    });
  } catch (_error) {
    console.warn("Warning: Could not stage changes (git may not be available)");
  }
}

async function main() {
  const [bumpType] = process.argv.slice(2);

  if (bumpType) {
    console.log(`Running npm version ${bumpType}...`);
    try {
      execFileSync("npm", ["version", bumpType], {
        cwd: rootDir,
        stdio: "inherit",
      });
    } catch (_error) {
      throw new Error(`npm version ${bumpType} failed`);
    }
  }

  const version = await readRootPackageVersion();
  const cargoTomlPaths = await readWorkspaceCargoTomlPaths();
  let changed = false;

  changed = (await updateWorkspacePackageVersion(version)) || changed;
  changed = (await updateInternalCargoDependencyVersions(cargoTomlPaths, version)) || changed;
  for (const packageJsonRelativePath of syncedPackageJsonPaths) {
    changed = (await updatePackageJsonVersion(packageJsonRelativePath, version)) || changed;
  }
  for (const packageJsonRelativePath of pinnedDependencyPackageJsonPaths) {
    changed = (await updatePinnedDependencyVersions(packageJsonRelativePath, version)) || changed;
  }

  if (changed) {
    updateCargoLock();
    for (const packageDir of syncedPackageDirs) {
      updatePackageLock(packageDir);
    }
  }

  if (changed || bumpType) {
    stageAllChanges();
  }

  if (bumpType) {
    console.log(`\nVersion sync complete: ${version}`);
  }
}

main().catch((error) => {
  console.error("Version sync failed:", error);
  process.exit(1);
});
