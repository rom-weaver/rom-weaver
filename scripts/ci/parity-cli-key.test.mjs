import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import { KEY_PATHS, keyHash, normalizeCargoLock, normalizeCargoToml } from "./parity-cli-key.mjs";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml");
const repoFile = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const tree = (version = "0.23.0") => ({
  "Cargo.toml": `[workspace.package]
edition = "2024"
rust-version = "1.95"
version = "${version}"

[workspace.dependencies]
clap = { version = "4.5.51", features = ["derive"] }
`,
  "crates/rom-weaver-core/Cargo.toml": `[package]
name = "rom-weaver-core"
version.workspace = true

[dependencies]
serde = { version = "1.0", features = ["derive"] }
`,
  "crates/rom-weaver-cli/Cargo.toml": `[package]
name = "rom-weaver-cli"
version.workspace = true

[dependencies]
rom-weaver-core = { path = "../rom-weaver-core", version = "${version}" }
clap.workspace = true

[dependencies.rom-weaver-extra]
path = "../rom-weaver-extra"
version = "${version}"
`,
  "Cargo.lock": `version = 4

[[package]]
name = "rom-weaver-cli"
version = "${version}"
dependencies = [
 "rom-weaver-core",
]

[[package]]
name = "rom-weaver-core"
version = "${version}"

[[package]]
name = "serde"
version = "1.0.228"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "abc"
`,
  "crates/rom-weaver-core/src/lib.rs": "pub fn core() {}\n",
});

const oidOf = (text) => createHash("sha1").update(text).digest("hex");
const keyOf = (files) => {
  const blobs = new Map();
  const entries = Object.entries(files)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([path, text]) => {
      const oid = oidOf(text);
      blobs.set(oid, text);
      return `100644 blob ${oid}\t${path}`;
    });
  return keyHash(entries, (oid) => blobs.get(oid));
};
const edited = (path, change) => {
  const files = tree();
  files[path] = change(files[path]);
  return files;
};

test("a version-only release bump hits the cache", () => {
  assert.equal(keyOf(tree("0.24.0")), keyOf(tree("0.23.0")));
  assert.equal(keyOf(tree("1.0.0-alpha.1")), keyOf(tree("0.23.0")));
});

test("source, dependency, and build input changes miss the cache", () => {
  const base = keyOf(tree());
  const misses = {
    "a source file": edited("crates/rom-weaver-core/src/lib.rs", (text) => `${text}// edit\n`),
    "a third-party Cargo.toml version": edited("Cargo.toml", (text) =>
      text.replace('clap = { version = "4.5.51"', 'clap = { version = "4.6.0"'),
    ),
    "a crate's third-party Cargo.toml version": edited("crates/rom-weaver-core/Cargo.toml", (text) =>
      text.replace('serde = { version = "1.0"', 'serde = { version = "2.0"'),
    ),
    "a feature list": edited("crates/rom-weaver-core/Cargo.toml", (text) =>
      text.replace('features = ["derive"]', 'features = ["derive", "rc"]'),
    ),
    "a path dependency's path": edited("crates/rom-weaver-cli/Cargo.toml", (text) =>
      text.replace("../rom-weaver-core", "../rom-weaver-other"),
    ),
    "the rust-version": edited("Cargo.toml", (text) => text.replace('"1.95"', '"1.96"')),
    "the edition": edited("Cargo.toml", (text) => text.replace('"2024"', '"2021"')),
    "a locked third-party version": edited("Cargo.lock", (text) =>
      text.replace('version = "1.0.228"', 'version = "1.0.229"'),
    ),
    "a locked third-party checksum": edited("Cargo.lock", (text) =>
      text.replace('checksum = "abc"', 'checksum = "abd"'),
    ),
    "a new locked package": edited(
      "Cargo.lock",
      (text) => `${text}\n[[package]]\nname = "new"\nversion = "0.23.0"\n`,
    ),
    "a git-sourced package": edited("Cargo.lock", (text) =>
      text.replace(
        'name = "rom-weaver-core"\nversion = "0.23.0"',
        'name = "rom-weaver-core"\nversion = "0.23.0"\nsource = "git+https://example.com/x"',
      ),
    ),
    "a new source file": { ...tree(), "crates/rom-weaver-core/src/new.rs": "" },
    "a removed source file": Object.fromEntries(
      Object.entries(tree()).filter(([path]) => !path.endsWith("src/lib.rs")),
    ),
  };
  for (const [what, files] of Object.entries(misses)) {
    assert.notEqual(keyOf(files), base, `${what} must change the key`);
  }
});

test("a version bump alongside a real change still misses", () => {
  const files = tree("0.24.0");
  files["crates/rom-weaver-core/src/lib.rs"] += "// edit\n";
  assert.notEqual(keyOf(files), keyOf(tree("0.23.0")));
});

test("normalizing replaces only the workspace's own versions", () => {
  const cargo = normalizeCargoToml(tree()["crates/rom-weaver-cli/Cargo.toml"]);
  assert.match(cargo, /rom-weaver-core = \{ path = "\.\.\/rom-weaver-core", version = "0\.0\.0" \}/u);
  assert.match(cargo, /path = "\.\.\/rom-weaver-extra"\nversion = "0\.0\.0"/u);
  const workspace = normalizeCargoToml(tree()["Cargo.toml"]);
  assert.match(workspace, /\nversion = "0\.0\.0"\n/u);
  assert.match(workspace, /rust-version = "1\.95"/u);
  assert.match(workspace, /clap = \{ version = "4\.5\.51"/u);
  const lock = normalizeCargoLock(tree()["Cargo.lock"]);
  assert.equal(lock.match(/version = "0\.0\.0"/gu).length, 2);
  assert.match(lock, /version = "1\.0\.228"/u);
});

// The repository's own manifests, with the version moved the way release-please moves it. The
// bump below is written without the normalizer so it can disagree with it.
test("the real manifests ignore a release bump", () => {
  const workspaceVersion = repoFile("Cargo.toml").match(/^version = "([^"]+)"$/mu)[1];
  const bump = (path, text) => {
    if (path === "Cargo.lock") {
      return text
        .split("\n[[package]]\n")
        .map((block) =>
          block.includes("\nsource = ") ? block : block.replace(/^version = ".*"$/mu, 'version = "9.9.9"'),
        )
        .join("\n[[package]]\n");
    }
    return text
      .split("\n")
      .map((line) =>
        line === `version = "${workspaceVersion}"` || /\bpath = ".*", version = "/u.test(line)
          ? line.replace(/version = "[^"]*"/u, 'version = "9.9.9"')
          : line,
      )
      .join("\n");
  };
  const files = {};
  for (const path of ["Cargo.toml", "Cargo.lock", ...workspaceCrateManifests()]) files[path] = repoFile(path);
  const bumped = Object.fromEntries(Object.entries(files).map(([path, text]) => [path, bump(path, text)]));
  assert.notEqual(bumped["Cargo.lock"], files["Cargo.lock"], "the simulated bump changed nothing");
  assert.notEqual(bumped["Cargo.toml"], files["Cargo.toml"]);
  assert.equal(keyOf(bumped), keyOf(files));
});

function workspaceCrateManifests() {
  const members = repoFile("Cargo.toml").match(/members\s*=\s*\[([^\]]*)\]/u)?.[1] ?? "";
  const crates = [...members.matchAll(/"crates\/([^"*]+)"/gu)].map(([, name]) => `crates/${name}/Cargo.toml`);
  assert.ok(crates.length > 0, "workspace members were not found");
  return crates;
}

test("the key covers the build inputs and its own definition", () => {
  for (const path of [
    "crates",
    "Cargo.lock",
    "Cargo.toml",
    ".cargo",
    ".config/mise.toml",
    ".github/actions/setup-build-env",
    ".github/workflows/parity.yml",
    "scripts/install-jwasm.sh",
    "scripts/ci/parity-cli-key.mjs",
  ]) {
    assert.ok(KEY_PATHS.includes(path), `${path} is part of the parity CLI key`);
  }
});

test("every script setup-build-env runs is part of the key", () => {
  const action = repoFile(".github/actions/setup-build-env/action.yml");
  const scripts = [...new Set(action.match(/scripts\/[\w./-]+\.(?:mjs|sh)/gu))];
  assert.ok(scripts.length > 0, "setup-build-env references no scripts");
  for (const script of scripts) {
    assert.ok(
      KEY_PATHS.some((path) => script === path || script.startsWith(`${path}/`)),
      `${script} is run by setup-build-env but not keyed`,
    );
  }
});

test("a table-form third-party version misses the cache", () => {
  const files = tree();
  files["crates/rom-weaver-core/Cargo.toml"] += '\n[dependencies.extra]\nversion = "1.0"\n';
  const bumped = { ...files };
  bumped["crates/rom-weaver-core/Cargo.toml"] = files["crates/rom-weaver-core/Cargo.toml"].replace(
    '[dependencies.extra]\nversion = "1.0"',
    '[dependencies.extra]\nversion = "2.0"',
  );
  assert.notEqual(keyOf(bumped), keyOf(files));
});

// A cache hit restores a CLI that reports the previous release's version. These checks must never
// compare a version-dependent output (`--version`, the xdelta application header, SARIF, identify
// setup), or the cache would hide a regression or fail a healthy release.
test("parity and performance checks compare nothing version-dependent", () => {
  for (const path of ["scripts/parity-check.mjs", "scripts/bench-compare.py"]) {
    assert.doesNotMatch(repoFile(path), /version/iu, `${path} must not read a version`);
  }
});

test("parity and perf share one cached CLI and fixture writer", () => {
  const { jobs } = load(repoFile(".github/workflows/parity.yml"));
  const key = jobs.parity.steps.find((s) => s.id === "cli-key");
  assert.match(key.run, /node scripts\/ci\/parity-cli-key\.mjs/u);
  const restore = jobs.parity.steps.find((s) => s.id === "cli-cache");
  const save = jobs.parity.steps.find((s) => s.name === "Save native CLI");
  const paths = ["target/release/rom-weaver", "target/release/nkit_fixture"];
  for (const step of [restore, save]) {
    assert.equal(step.with.key, "${{ steps.cli-key.outputs.key }}");
    assert.deepEqual(step.with.path.trim().split("\n").map((p) => p.trim()), paths);
  }
  const upload = jobs.parity.steps.find((s) => s.name === "Upload rom-weaver CLI");
  assert.deepEqual(upload.with.path.trim().split("\n").map((p) => p.trim()), paths);

  const build = jobs.parity.steps.find((s) => s.name === "Build rom-weaver CLI and NKit fixture writer");
  assert.match(build.run, /cargo build --locked --release -p rom-weaver-containers --example nkit_fixture &\n/u);
  assert.match(build.run, /cargo build --locked --release -p rom-weaver-cli\n/u);
  assert.match(build.run, /wait "\$fixture_build"/u, "a failed fixture build must fail the job");
  assert.ok(build.run.includes("set -euo pipefail"));

  const setup = jobs.perf.steps.filter((s) => s.uses?.includes("setup-build-env"));
  assert.deepEqual(setup, [], "the perf job needs no toolchain");
  const fixtures = jobs.perf.steps.find((s) => s.name === "Write NKit fixtures");
  assert.match(fixtures.run, /candidate\/nkit_fixture" "\$PERF_DIR\/fixtures"/u);
  assert.equal(jobs.perf.needs, "parity");
});
