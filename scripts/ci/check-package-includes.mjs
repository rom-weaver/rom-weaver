#!/usr/bin/env node
// Guards the class of failure that broke the v0.14.0 cargo publish: a file
// pulled in by include_str!/include_bytes! from outside src/ that the crate's
// Cargo.toml `include` list omits. The publish dry-run runs with --no-verify
// (it cannot resolve same-version workspace dependencies from crates.io), so
// nothing else compiles the packaged tarball before the real publish.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, relative, dirname } from "node:path";

const INCLUDE_MACRO = /include_(?:str|bytes)!\s*\(\s*"([^"]+)"\s*\)/g;

function rustFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...rustFiles(path));
    else if (entry.endsWith(".rs")) out.push(path);
  }
  return out;
}

function packagedFiles(crate) {
  const listed = execFileSync(
    "cargo",
    ["package", "--list", "--allow-dirty", "-p", crate],
    { encoding: "utf8" },
  );
  // Entries are printed relative to the crate root, one per line.
  return new Set(listed.split("\n").map((line) => line.trim()).filter(Boolean));
}

const crates = readdirSync("crates").filter((name) =>
  statSync(join("crates", name)).isDirectory()
);
const failures = [];

for (const crate of crates) {
  const root = join("crates", crate);
  const manifest = readFileSync(join(root, "Cargo.toml"), "utf8");
  if (/^\s*publish\s*=\s*false/m.test(manifest)) continue;

  const needed = new Map();
  for (const file of rustFiles(join(root, "src"))) {
    for (const [, target] of readFileSync(file, "utf8").matchAll(INCLUDE_MACRO)) {
      const resolved = normalize(join(dirname(file), target));
      const withinCrate = relative(root, resolved);
      // Only paths that climb out of src/ can miss the include list; anything
      // under src/** is already covered by every crate's glob.
      if (withinCrate.startsWith("src/") || withinCrate.startsWith("..")) continue;
      needed.set(withinCrate, file);
    }
  }
  if (needed.size === 0) continue;

  const packaged = packagedFiles(crate);
  for (const [target, source] of needed) {
    if (!packaged.has(target)) {
      failures.push(
        `${source}: includes ${target}, which ${crate}'s Cargo.toml \`include\` omits`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Packaged crates are missing included files:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log("All include_str!/include_bytes! targets are packaged.");
