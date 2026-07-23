#!/usr/bin/env node
// Generate a build-time third-party attribution bundle from the resolved Cargo
// dependency graph.
//
// Scope: every non-workspace package reachable from the workspace members over
// normal + build dependency edges (dev-only edges are excluded). This mirrors
// `cargo tree --workspace --edges normal,build`.
//
// Uses ONLY Node built-ins + `cargo metadata`. No npm or cargo plugins, no
// network. Output is fully deterministic (sorted, no timestamps).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const CRATES_IO_SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
// License text file name prefixes (matched case-insensitively, files only).
const LICENSE_FILE_RE = /^(licen[sc]e|copying|unlicense|notice)/i;
const NO_ATTRIBUTION_FILE_RE = /(0bsd|cc0|mit[-_ ]?0|unlicense|wtfpl|public[-_ ]?domain)/i;
// These licenses do not require retaining copyright or attribution notices.
// Expressions containing any other identifier are kept conservatively.
const NO_ATTRIBUTION_LICENSES = new Set(["0BSD", "CC0-1.0", "MIT-0", "Unlicense", "WTFPL"]);

const [outputDirInput] = process.argv.slice(2);
if (!outputDirInput) {
  throw new Error("usage: node scripts/gen-third-party-licenses.mjs <output-dir>");
}

const OUTPUT_DIR = path.resolve(process.cwd(), outputDirInput);
const NOTICE_FILE = path.join(OUTPUT_DIR, "NOTICE");
const LICENSES_DIR = path.join(OUTPUT_DIR, "third_party", "licenses");

/**
 * Run `cargo metadata` and parse the JSON document.
 *
 * Deliberately not `--offline`: metadata resolves the graph for every platform,
 * so it needs manifests a single-target build never downloads (e.g. the
 * `cfg(windows)`-gated `anstyle-wincon` when building wasm on Linux CI).
 * `Cargo.lock` still pins versions, so this only permits the fetch.
 */
function loadCargoMetadata() {
  const raw = execFileSync("cargo", ["metadata", "--format-version", "1"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

/**
 * Walk the resolve graph from the workspace members over normal + build edges,
 * skipping dev-only edges. Returns the set of reachable package ids, excluding
 * all first-party workspace members.
 */
function resolveThirdPartyIds(metadata) {
  const workspaceIds = new Set(metadata.workspace_members);
  const nodesById = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));

  const reached = new Set();
  const queue = [...metadata.workspace_members];
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined) {
      continue;
    }
    const node = nodesById.get(id);
    if (node === undefined) {
      continue;
    }
    for (const dep of node.deps ?? []) {
      const kinds = (dep.dep_kinds ?? []).map((k) => k.kind);
      // Keep an edge if it is a normal (kind === null) or build dependency.
      const isNonDev = kinds.some((kind) => kind === null || kind === "build");
      if (!isNonDev) {
        continue;
      }
      if (!reached.has(dep.pkg)) {
        reached.add(dep.pkg);
        queue.push(dep.pkg);
      }
    }
  }

  for (const id of workspaceIds) reached.delete(id);
  return reached;
}

/** Human-facing Source column value for a package. */
function sourceLabel(pkg) {
  if (!pkg.source) {
    return "local";
  }
  if (pkg.source === CRATES_IO_SOURCE) {
    return "crates.io";
  }
  if (pkg.source.startsWith("git+")) {
    return pkg.source.slice("git+".length);
  }
  if (pkg.source.startsWith("registry+")) {
    return pkg.source.slice("registry+".length);
  }
  return pkg.source;
}

function licenseIds(expression) {
  return (expression ?? "UNKNOWN")
    .split(/\s+(?:OR|AND)\s+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

function requiresAttribution(expression) {
  return licenseIds(expression).some((id) => !NO_ATTRIBUTION_LICENSES.has(id));
}

/** Candidate directories to scan for a package's license text files. */
function licenseSearchDirs(pkg) {
  const manifestDir = path.dirname(pkg.manifest_path);
  const dirs = [manifestDir];
  // Path/local crates (vendored submodules) sometimes keep their license one
  // level up from the crate manifest (e.g. a sub-crate inside a vendored repo).
  if (!pkg.source) {
    dirs.push(path.dirname(manifestDir));
  }
  return dirs;
}

/**
 * Find license text files for a package. Returns a sorted, de-duplicated list
 * of absolute file paths (first matching directory wins per file name).
 */
function findLicenseFiles(pkg) {
  const seenNames = new Set();
  const found = [];
  for (const dir of licenseSearchDirs(pkg)) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !LICENSE_FILE_RE.test(entry.name) ||
        NO_ATTRIBUTION_FILE_RE.test(entry.name)
      ) {
        continue;
      }
      if (seenNames.has(entry.name)) {
        continue;
      }
      seenNames.add(entry.name);
      found.push(path.join(dir, entry.name));
    }
    if (found.length > 0) {
      // Stop at the first directory that yielded matches so a parent-dir
      // fallback never shadows the crate's own files.
      break;
    }
  }
  found.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return found;
}

/** Recursively remove a directory if it exists. */
function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Build one notice containing the project terms and third-party inventory. */
function renderNotice(rows) {
  const lines = [fs.readFileSync(path.join(REPO_ROOT, "NOTICE"), "utf8").trimEnd()];
  lines.push("");
  lines.push("Third-party components");
  lines.push("");
  lines.push("This build includes the following third-party Rust crates whose declared");
  lines.push("licenses require retaining attribution or license notices.");
  lines.push("Public-domain and no-attribution-only expressions are omitted.");
  lines.push("");
  lines.push("License texts or SPDX metadata are stored under");
  lines.push("third_party/licenses/<name>-<version>/.");
  lines.push("");
  lines.push("Crate | Version | License expression | Source");
  lines.push("----- | ------- | ------------------ | ------");
  for (const row of rows) {
    const license = row.license ?? "UNKNOWN";
    lines.push(`${row.name} | ${row.version} | ${license} | ${row.source}`);
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const metadata = loadCargoMetadata();
  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const thirdPartyIds = resolveThirdPartyIds(metadata);

  const rows = [];
  const expectedDirs = new Set();
  const missingLicense = [];
  let copiedDirCount = 0;
  let omittedCount = 0;

  for (const id of thirdPartyIds) {
    const pkg = packagesById.get(id);
    if (pkg === undefined) {
      continue;
    }
    const row = {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      source: sourceLabel(pkg),
      pkg,
    };
    if (requiresAttribution(row.license)) {
      rows.push(row);
    } else {
      omittedCount += 1;
    }
  }

  rows.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.version.localeCompare(b.version);
  });

  // Copy license files into deterministic per-crate directories.
  for (const row of rows) {
    const dirName = `${row.name}-${row.version}`;
    const targetDir = path.join(LICENSES_DIR, dirName);
    expectedDirs.add(dirName);

    const licenseFiles = findLicenseFiles(row.pkg);
    if (licenseFiles.length === 0) {
      missingLicense.push(dirName);
      removeDir(targetDir);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, "LICENSE-SPDX-NOTICE.txt"),
        [
          `Package: ${row.name}`,
          `Version: ${row.version}`,
          `License expression: ${row.license ?? "UNKNOWN"}`,
          `Source: ${row.source}`,
          "",
          "The published package did not include a top-level license file.",
          "The SPDX expression above is retained as the package license metadata.",
          "",
        ].join("\n"),
      );
      copiedDirCount += 1;
      continue;
    }

    // Rewrite the dir from scratch so removed upstream files do not linger.
    removeDir(targetDir);
    fs.mkdirSync(targetDir, { recursive: true });
    for (const src of licenseFiles) {
      // Copy the upstream text but strip per-line trailing whitespace and
      // collapse trailing blank lines. Some crates ship license files with
      // trailing spaces (legally insignificant); the repo's whitespace hook
      // (`git diff --check`) rejects them and the existing tree is clean.
      const text = fs.readFileSync(src, "utf8");
      const cleaned = `${text
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+$/gm, "")
        .replace(/\n+$/, "")}\n`;
      fs.writeFileSync(path.join(targetDir, path.basename(src)), cleaned);
    }
    copiedDirCount += 1;
  }

  // Prune phantom directories no longer in the graph.
  const pruned = [];
  if (fs.existsSync(LICENSES_DIR)) {
    for (const entry of fs.readdirSync(LICENSES_DIR, { withFileTypes: true })) {
      if (entry.isDirectory() && !expectedDirs.has(entry.name)) {
        removeDir(path.join(LICENSES_DIR, entry.name));
        pruned.push(entry.name);
      }
    }
  } else {
    fs.mkdirSync(LICENSES_DIR, { recursive: true });
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(NOTICE_FILE, renderNotice(rows));
  fs.rmSync(path.join(OUTPUT_DIR, "THIRD_PARTY_LICENSES.md"), { force: true });

  // Deliberately NOT deduped here: this bundle also lands inside the npm
  // platform packages, and `npm pack` deadlocks on a hardlinked tree. Callers
  // that ship the bundle to a browser collapse it themselves - see
  // scripts/dedupe-tree.mjs.

  pruned.sort();
  missingLicense.sort();
  process.stdout.write(
    [
      `Inventory crates: ${rows.length}`,
      `Omitted no-attribution crates: ${omittedCount}`,
      `License dirs written: ${copiedDirCount}`,
      `Crates without a findable license file: ${missingLicense.length}`,
      missingLicense.length > 0 ? `  ${missingLicense.join(", ")}` : "",
      `Pruned stale dirs: ${pruned.length}`,
      pruned.length > 0 ? `  ${pruned.join(", ")}` : "",
    ]
      .filter((line) => line !== "")
      .join("\n") + "\n",
  );
}

main();
