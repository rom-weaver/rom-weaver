import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const requiredReleaseKeywords = ["rvz", "chd", "z3ds", "rom", "patch"];
// crates.io rejects a publish over these limits: https://doc.rust-lang.org/cargo/reference/manifest.html#the-keywords-field
const CRATES_IO_MAX_KEYWORDS = 5;
const CRATES_IO_KEYWORD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_+-]{0,19}$/;

test("npm alias package exposes a runnable bin", (t) => {
  const pkg = readJson("packages/rom-weaver-alias/package.json");
  assert.equal(pkg.bin?.["rom-weaver"], "bin/rom-weaver.mjs");
  assert.ok(pkg.files.includes("bin/rom-weaver.mjs"));
  assert.ok(existsSync("packages/rom-weaver-alias/bin/rom-weaver.mjs"));

  const installRoot = mkdtempSync(join(tmpdir(), "rom-weaver-alias-"));
  t.after(() => rmSync(installRoot, { recursive: true, force: true }));
  const aliasBin = join(installRoot, "node_modules/rom-weaver/bin/rom-weaver.mjs");
  const cliDir = join(installRoot, "node_modules/@rom-weaver/cli");
  const cliBin = join(cliDir, "bin/rom-weaver.mjs");
  mkdirSync(join(installRoot, "node_modules/rom-weaver/bin"), { recursive: true });
  mkdirSync(join(cliDir, "bin"), { recursive: true });
  copyFileSync("packages/rom-weaver-alias/bin/rom-weaver.mjs", aliasBin);
  writeFileSync(join(cliDir, "package.json"), '{"name":"@rom-weaver/cli","type":"module"}\n');
  writeFileSync(cliBin, 'console.log("hoisted CLI loaded");\n');

  const result = spawnSync(process.execPath, [aliasBin], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "hoisted CLI loaded\n");
});

test("root lockfile mirrors local optional platform package manifests", () => {
  const rootPackage = readJson("package.json");
  const lock = readJson("package-lock.json");

  for (const [name, version] of Object.entries(rootPackage.optionalDependencies)) {
    const packagePath = `packages/rom-weaver-cli-platforms/${name.replace("@rom-weaver/", "")}/package.json`;
    const platformPackage = readJson(packagePath);
    const lockEntry = lock.packages[`node_modules/${name}`];
    assert.equal(lock.packages[""].optionalDependencies[name], version);
    assert.equal(lockEntry.version, version);
    assert.equal(lockEntry.optional, true);
    assert.deepEqual(lockEntry.os, platformPackage.os);
    assert.deepEqual(lockEntry.cpu, platformPackage.cpu);
    assert.deepEqual(lockEntry.libc, platformPackage.libc);
    assert.deepEqual(lockEntry.bin, platformPackage.bin);
    assert.equal(lockEntry.resolved, undefined);
    assert.equal(lockEntry.integrity, undefined);
  }
});

test("published npm package manifests include release discovery keywords", () => {
  const rootPackage = readJson("package.json");
  const packagePaths = [
    "package.json",
    "packages/rom-weaver-alias/package.json",
    ...Object.keys(rootPackage.optionalDependencies).map(
      (name) =>
        `packages/rom-weaver-cli-platforms/${name.replace("@rom-weaver/", "")}/package.json`,
    ),
  ];

  for (const packagePath of packagePaths) {
    const pkg = readJson(packagePath);
    for (const keyword of requiredReleaseKeywords) {
      assert.ok(pkg.keywords?.includes(keyword), `${pkg.name} is missing npm keyword ${keyword}`);
    }
  }
});

test("platform npm packages include the external identify data", () => {
  const rootPackage = readJson("package.json");

  for (const name of Object.keys(rootPackage.optionalDependencies)) {
    const packagePath = `packages/rom-weaver-cli-platforms/${name.replace("@rom-weaver/", "")}/package.json`;
    const platformPackage = readJson(packagePath);
    assert.ok(
      platformPackage.files.includes("share/rom-weaver/identify/v1/**"),
      `${name} does not include the identify data`,
    );
  }
});

test("published Cargo crates stay within crates.io keyword limits", () => {
  for (const crate of readdirSync("crates")) {
    const cargoToml = readFileSync(join("crates", crate, "Cargo.toml"), "utf8");
    if (!/^publish\.workspace = true$/m.test(cargoToml)) continue;
    const keywords = (cargoToml.match(/^keywords = \[([^\]]*)\]/m)?.[1]?.match(/"[^"]+"/g) ?? []).map((keyword) =>
      keyword.slice(1, -1),
    );
    assert.ok(keywords.length <= CRATES_IO_MAX_KEYWORDS, `${crate} has ${keywords.length} keywords`);
    for (const keyword of keywords) {
      assert.match(keyword, CRATES_IO_KEYWORD_PATTERN, `${crate} keyword ${keyword} breaks crates.io rules`);
    }
  }
});
