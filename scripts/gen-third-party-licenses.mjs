#!/usr/bin/env node
// Generate a build-time third-party attribution bundle from the resolved Cargo
// and npm dependency graphs.
//
// CLI scope: every non-workspace Cargo package reachable from the workspace
// members over normal + build dependency edges, plus the source trees that are
// deliberately inlined into rom-weaver-containers.
// Webapp scope: CLI scope plus the webapp package's production dependency graph.
//
// Uses ONLY Node built-ins + `cargo metadata`. No npm or cargo plugins, no
// network. npm's lockfile supplies the resolved webapp graph; npm install is
// still required when license text files need to be copied. Output is fully
// deterministic (sorted, no timestamps).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const CRATES_IO_SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
const WEBAPP_ROOT = path.join(REPO_ROOT, "packages", "rom-weaver-webapp");
const WEBAPP_LOCKFILE = path.join(WEBAPP_ROOT, "package-lock.json");
const TARGETS = new Set(["all", "cli", "webapp"]);
const NOTICE_FILES = { combined: "NOTICE", cli: "CLI_NOTICE", webapp: "WEBAPP_NOTICE" };
const PROJECT_NOTICE = [
  "rom-weaver",
  "Copyright (C) 2026 Brandon Casey and rom-weaver contributors",
  "",
  "First-party rom-weaver code is available under either:",
  "",
  "1. GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)",
  "2. Separate commercial terms available from Brandon Casey",
  "",
  "You may use first-party rom-weaver code under the terms of either license. See",
  "LICENSE and COMMERCIAL.md.",
  "",
  "Bundled third-party components remain subject to their own licenses. Release",
  "artifacts include the applicable third-party attribution and license inventory.",
].join("\n");
const WEBAPP_NOTICES_PAGE = `# Notices

rom-weaver is free and open-source, and it is built from other people's
open-source work. This page says where to find the license for both.

<!-- START doctoc -->
## Table of contents

- [The project license](#the-project-license)
- [Other people's code](#other-peoples-code)
- [The full lists](#the-full-lists)
- [Something looks wrong](#something-looks-wrong)

<!-- END doctoc -->

## The project license

rom-weaver is licensed under the
[GNU Affero General Public License version 3 or later](https://github.com/rom-weaver/rom-weaver/blob/main/LICENSE).
The source code, the full history, the build setup, and the released files all
live in the
[rom-weaver repository](https://github.com/rom-weaver/rom-weaver).

The license text is what actually governs your rights and obligations. This
page is a signpost to it and changes nothing about it.

## Other people's code

The browser app and the command-line tool are built on open-source components:
React, marked, nod, libarchive, chd-rs, several compression libraries, and
everything those depend on in turn. Each of those keeps its own license and
copyright notice.

Those notices are generated from the dependencies that actually go into a
build, rather than typed up by hand. A hand-kept list drifts out of date the
first time somebody adds a dependency and forgets. A generated one cannot.

## The full lists

The [webapp notice file](/WEBAPP_NOTICE) lists everything shipped in this
browser build. The [combined notice file](/NOTICE) adds the components used by
the command-line tool and the shared engine underneath both.

Each entry names the component, its version, its license, where the project
lives, and the license or notice files that came with it. They are plain text,
so release tooling, package managers, and automated license checks read
exactly what you are reading.

## Something looks wrong

The generator and the dependency policy are both in the public repository. If
a component, a copyright line, a source link, or a license looks wrong, please
[open an issue](https://github.com/rom-weaver/rom-weaver/issues) and say which
release version and which entry.

Back to the [guide index](../usage/README.md).
`;
// License text file name prefixes (matched case-insensitively, files only).
const LICENSE_FILE_RE = /^(licen[sc]e|copying|unlicense|notice)/i;
const NO_ATTRIBUTION_FILE_RE = /(0bsd|cc0|mit[-_ ]?0|unlicense|wtfpl|public[-_ ]?domain)/i;
// These licenses do not require retaining copyright or attribution notices.
// Expressions containing any other identifier are kept conservatively.
const NO_ATTRIBUTION_LICENSES = new Set(["0BSD", "CC0-1.0", "MIT-0", "Unlicense", "WTFPL"]);

const [outputDirInput, targetArg, targetValue] = process.argv.slice(2);
const target = targetArg === "--target" ? targetValue : (targetArg ?? "all");
if (!outputDirInput || !TARGETS.has(target)) {
  throw new Error(
    "usage: node scripts/gen-third-party-licenses.mjs <output-dir> [--target cli|webapp|all]",
  );
}

const OUTPUT_DIR = path.resolve(process.cwd(), outputDirInput);
const LICENSES_DIR = path.join(OUTPUT_DIR, "third_party", "licenses");

const IN_SOURCE_DEPENDENCIES = [
  {
    name: "libarchive",
    versionFile: path.join(
      REPO_ROOT,
      "crates",
      "rom-weaver-containers",
      "libarchive",
      "vendor",
      "LIBARCHIVE_VERSION",
    ),
    versionKey: "ref",
    sourceKey: "source",
    license: "Apache-2.0 and per-file terms",
    licenseFiles: [
      path.join(
        REPO_ROOT,
        "crates",
        "rom-weaver-containers",
        "libarchive",
        "vendor",
        "libarchive",
        "COPYING",
      ),
    ],
  },
  {
    name: "nod",
    versionFile: path.join(
      REPO_ROOT,
      "crates",
      "rom-weaver-containers",
      "src",
      "nod",
      "NOD_VERSION",
    ),
    versionKey: "commit",
    sourceKey: "source",
    license: "MIT OR Apache-2.0",
    licenseFiles: [
      path.join(REPO_ROOT, "crates", "rom-weaver-containers", "src", "nod", "LICENSE-APACHE"),
      path.join(REPO_ROOT, "crates", "rom-weaver-containers", "src", "nod", "LICENSE-MIT"),
    ],
  },
  {
    name: "xdvdfs",
    versionFile: path.join(
      REPO_ROOT,
      "crates",
      "rom-weaver-containers",
      "src",
      "xdvdfs",
      "XDVDFS_VERSION",
    ),
    versionKey: "version",
    sourceKey: "source",
    license: "MIT",
    licenseFiles: [
      path.join(REPO_ROOT, "crates", "rom-weaver-containers", "src", "xdvdfs", "LICENSE"),
    ],
  },
];

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

function metadataValue(file, key) {
  const line = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${key}:`));
  return line?.slice(key.length + 1).trim() ?? "unknown";
}

function inSourceRows() {
  return IN_SOURCE_DEPENDENCIES.map((dependency) => ({
    kind: "source",
    name: dependency.name,
    version: metadataValue(dependency.versionFile, dependency.versionKey),
    license: dependency.license,
    source: metadataValue(dependency.versionFile, dependency.sourceKey),
    licenseFiles: dependency.licenseFiles,
  }));
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

/** Build rows for resolved Cargo packages that require attribution. */
function cargoRows(metadata) {
  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  return [...resolveThirdPartyIds(metadata)]
    .map((id) => packagesById.get(id))
    .filter((pkg) => pkg !== undefined)
    .map((pkg) => ({
      kind: "crate",
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      source: sourceLabel(pkg),
      pkg,
    }))
    .filter((row) => requiresAttribution(row.license));
}

function packageLockKey(packageName, fromKey, packages) {
  let parent = fromKey;
  while (true) {
    const candidate = path.posix.join(parent, "node_modules", packageName);
    if (packages[candidate]) return candidate;
    const marker = parent.lastIndexOf("/node_modules/");
    parent = marker === -1 ? "" : parent.slice(0, marker);
    if (!parent) {
      const rootCandidate = path.posix.join("node_modules", packageName);
      return packages[rootCandidate] ? rootCandidate : undefined;
    }
  }
}

function npmDependencyNames(pkg) {
  const names = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
  for (const name of Object.keys(pkg.peerDependencies ?? {})) {
    if (pkg.peerDependenciesMeta?.[name]?.optional !== true) names.add(name);
  }
  return names;
}

function loadWebappRows() {
  const lockfile = JSON.parse(fs.readFileSync(WEBAPP_LOCKFILE, "utf8"));
  const packages = lockfile.packages ?? {};
  const reached = new Set();
  const queue = [{ key: "", pkg: packages[""] }];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const name of npmDependencyNames(current.pkg)) {
      const key = packageLockKey(name, current.key, packages);
      if (!key || reached.has(key)) continue;
      reached.add(key);
      queue.push({ key, pkg: packages[key] });
    }
  }

  return [...reached]
    .map((key) => ({ key, pkg: packages[key] }))
    .filter(({ pkg }) => pkg?.version)
    .map(({ key, pkg }) => ({
      kind: "npm",
      name: key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length),
      version: pkg.version,
      license: pkg.license,
      source: pkg.resolved?.startsWith("https://registry.npmjs.org/")
        ? "npmjs.com"
        : (pkg.resolved ?? "npm"),
      licenseDirs: [path.join(WEBAPP_ROOT, ...key.split("/"))],
    }))
    .filter((row) => requiresAttribution(row.license));
}

/** Candidate directories to scan for a Cargo package's license text files. */
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
function findLicenseFiles(row) {
  const seenNames = new Set();
  const found = [];
  for (const dir of row.licenseDirs ?? licenseSearchDirs(row.pkg)) {
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
function renderNotice(rows, scope) {
  const lines = [PROJECT_NOTICE];
  lines.push("");
  lines.push("Third-party components");
  lines.push("");
  lines.push(`This ${scope} build includes third-party components whose declared licenses`);
  lines.push("require retaining attribution or license notices.");
  lines.push("Public-domain and no-attribution-only expressions are omitted.");
  lines.push("");
  lines.push("License texts or SPDX metadata are stored under");
  lines.push("third_party/licenses/.");
  lines.push("");
  const tableRows = [
    ["Component", "Version", "License expression", "Source"],
    ...rows.map((row) => [row.name, row.version, row.license ?? "UNKNOWN", row.source]),
  ];
  const widths = tableRows[0].map((_, column) =>
    Math.max(...tableRows.map((row) => row[column].length)),
  );
  lines.push(`| ${tableRows[0].map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`);
  lines.push(`| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`);
  for (const row of tableRows.slice(1)) {
    lines.push(`| ${row.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function licenseDirName(row) {
  const prefix = row.kind === "crate" ? "" : `${row.kind}-`;
  return `${prefix}${row.name.replaceAll("/", "-")}-${row.version}`;
}

function main() {
  const metadata = loadCargoMetadata();
  const cargo = cargoRows(metadata);
  const source = inSourceRows();
  const npm = target === "cli" ? [] : loadWebappRows();
  const cliRows = [...cargo, ...source];
  const rowsByScope = {
    cli: cliRows,
    webapp: npm,
    combined: [...cliRows, ...npm],
  };
  const scopes =
    target === "all"
      ? ["cli", "webapp", "combined"]
      : target === "webapp"
        ? ["webapp", "combined"]
        : ["cli"];
  const rows = [
    ...new Map(
      scopes.flatMap((scope) => rowsByScope[scope]).map((row) => [licenseDirName(row), row]),
    ).values(),
  ];
  const expectedDirs = new Set();
  const missingLicense = [];
  let copiedDirCount = 0;

  rows.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.version.localeCompare(b.version);
  });

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Copy license files into deterministic per-component directories.
  for (const row of rows) {
    const dirName = licenseDirName(row);
    const targetDir = path.join(LICENSES_DIR, dirName);
    expectedDirs.add(dirName);

    const licenseFiles = row.licenseFiles ?? findLicenseFiles(row);
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

  for (const scope of scopes) {
    fs.writeFileSync(
      path.join(OUTPUT_DIR, NOTICE_FILES[scope]),
      renderNotice(rowsByScope[scope], scope),
    );
  }
  if (target === "cli") {
    fs.rmSync(path.join(OUTPUT_DIR, "notices.md"), { force: true });
  } else {
    fs.writeFileSync(path.join(OUTPUT_DIR, "notices.md"), WEBAPP_NOTICES_PAGE);
  }
  for (const filename of Object.values(NOTICE_FILES)) {
    if (!scopes.some((scope) => NOTICE_FILES[scope] === filename)) {
      fs.rmSync(path.join(OUTPUT_DIR, filename), { force: true });
    }
  }
  fs.rmSync(path.join(OUTPUT_DIR, "THIRD_PARTY_LICENSES.md"), { force: true });

  // Deliberately NOT deduped here: this bundle also lands inside the npm
  // platform packages, and `npm pack` deadlocks on a hardlinked tree. Callers
  // that ship the bundle to a browser collapse it themselves - see
  // scripts/dedupe-tree.mjs.

  pruned.sort();
  missingLicense.sort();
  process.stdout.write(
    [
      `Inventory crates: ${cargo.length}`,
      `Inventory in-source components: ${source.length}`,
      target === "cli" ? "" : `Inventory webapp packages: ${npm.length}`,
      `License dirs written: ${copiedDirCount}`,
      `Components without a findable license file: ${missingLicense.length}`,
      missingLicense.length > 0 ? `  ${missingLicense.join(", ")}` : "",
      `Pruned stale dirs: ${pruned.length}`,
      pruned.length > 0 ? `  ${pruned.join(", ")}` : "",
    ]
      .filter((line) => line !== "")
      .join("\n") + "\n",
  );
}

main();
