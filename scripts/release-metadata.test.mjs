import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const requiredReleaseKeywords = ["rvz", "chd", "z3ds", "rom", "patch"];

test("npm alias package exposes a runnable bin", () => {
  const pkg = readJson("packages/rom-weaver-alias/package.json");
  assert.equal(pkg.bin?.["rom-weaver"], "bin/rom-weaver.mjs");
  assert.ok(pkg.files.includes("bin/rom-weaver.mjs"));
  assert.ok(existsSync("packages/rom-weaver-alias/bin/rom-weaver.mjs"));
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
      (name) => `packages/rom-weaver-cli-platforms/${name.replace("@rom-weaver/", "")}/package.json`,
    ),
  ];

  for (const packagePath of packagePaths) {
    const pkg = readJson(packagePath);
    for (const keyword of requiredReleaseKeywords) {
      assert.ok(pkg.keywords?.includes(keyword), `${pkg.name} is missing npm keyword ${keyword}`);
    }
  }
});

test("published Cargo crates stay within crates.io keyword limits", () => {
  const cargoToml = readFileSync("crates/rom-weaver-cli/Cargo.toml", "utf8");
  const keywords = cargoToml.match(/^keywords = \[(.*)\]$/m)?.[1]?.match(/"[^"]+"/g) ?? [];
  assert.deepEqual(
    keywords.map((keyword) => keyword.slice(1, -1)),
    requiredReleaseKeywords,
  );
});
