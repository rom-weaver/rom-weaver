import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildFlagEnv, remapPathArgs } from "./build-app.mjs";
import {
  pruneWasmArtifacts,
  restoreWasmArtifacts,
  storeWasmArtifacts,
  wasmArtifactCacheKey,
  wasmArtifactCacheRoot,
} from "./wasm-artifact-cache.mjs";

const FILES = ["rom-weaver-app.wasm", "rom-weaver-app.wasm.br"];

const withDir = (run) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver wasm cache "));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const writeArtifacts = (dir, content) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const file of FILES) fs.writeFileSync(path.join(dir, file), `${file}:${content}`);
};

test("cache root honors the override, then XDG_CACHE_HOME", () => {
  assert.equal(wasmArtifactCacheRoot({ ROM_WEAVER_WASM_CACHE_DIR: "/c", XDG_CACHE_HOME: "/x" }), "/c");
  assert.equal(wasmArtifactCacheRoot({ XDG_CACHE_HOME: "/x" }), path.join("/x", "rom-weaver", "wasm"));
  assert.equal(wasmArtifactCacheRoot({}), path.join(os.homedir(), ".cache", "rom-weaver", "wasm"));
});

test("cache key changes with every input and ignores their order", () => {
  const inputs = { mode: "prod", source: "abc", rustc: "1.97.1", env: "[]" };
  const key = wasmArtifactCacheKey(inputs);
  assert.equal(wasmArtifactCacheKey({ env: "[]", rustc: "1.97.1", source: "abc", mode: "prod" }), key);
  for (const name of Object.keys(inputs)) assert.notEqual(wasmArtifactCacheKey({ ...inputs, [name]: `${inputs[name]}x` }), key, name);
  // Labels are separated from values, so moving text between them changes the key.
  assert.notEqual(wasmArtifactCacheKey({ ab: "c" }), wasmArtifactCacheKey({ a: "bc" }));
});

test("a stored entry restores into another checkout", () => {
  withDir((dir) => {
    const root = path.join(dir, "cache");
    const built = path.join(dir, "a");
    const other = path.join(dir, "b");
    writeArtifacts(built, "one");
    fs.mkdirSync(other);
    assert.equal(restoreWasmArtifacts({ root, key: "k", files: FILES, outDir: other }), false);

    storeWasmArtifacts({ root, key: "k", files: FILES, sourceDir: built });
    assert.equal(restoreWasmArtifacts({ root, key: "k", files: FILES, outDir: other }), true);
    for (const file of FILES) assert.equal(fs.readFileSync(path.join(other, file), "utf8"), `${file}:one`);
    assert.deepEqual(fs.readdirSync(root), ["k"]);
  });
});

test("an existing entry is kept and an incomplete one does not restore", () => {
  withDir((dir) => {
    const root = path.join(dir, "cache");
    writeArtifacts(path.join(dir, "a"), "one");
    writeArtifacts(path.join(dir, "b"), "two");
    storeWasmArtifacts({ root, key: "k", files: FILES, sourceDir: path.join(dir, "a") });
    storeWasmArtifacts({ root, key: "k", files: FILES, sourceDir: path.join(dir, "b") });
    assert.equal(fs.readFileSync(path.join(root, "k", FILES[0]), "utf8"), `${FILES[0]}:one`);
    // A forced rebuild evicts an entry built from an input the key missed.
    storeWasmArtifacts({ root, key: "k", files: FILES, sourceDir: path.join(dir, "b"), replace: true });
    assert.equal(fs.readFileSync(path.join(root, "k", FILES[0]), "utf8"), `${FILES[0]}:two`);

    fs.rmSync(path.join(root, "k", FILES[1]));
    const out = path.join(dir, "out");
    fs.mkdirSync(out);
    assert.equal(restoreWasmArtifacts({ root, key: "k", files: FILES, outDir: out }), false);
    assert.deepEqual(fs.readdirSync(out), []);
  });
});

test("a failed store leaves no entry or staging directory", () => {
  withDir((dir) => {
    const root = path.join(dir, "cache");
    const built = path.join(dir, "a");
    fs.mkdirSync(built);
    fs.writeFileSync(path.join(built, FILES[0]), "wasm");
    assert.throws(() => storeWasmArtifacts({ root, key: "k", files: FILES, sourceDir: built }), /ENOENT/);
    assert.deepEqual(fs.readdirSync(root), []);
  });
});

test("pruning keeps the most recently used entries and drops stale staging", () => {
  withDir((root) => {
    const now = Date.now();
    const key = (char) => char.repeat(64);
    const make = (name, ageMs) => {
      fs.mkdirSync(path.join(root, name));
      const time = new Date(now - ageMs);
      fs.utimesSync(path.join(root, name), time, time);
    };
    make(key("a"), 3000);
    make(key("b"), 2000);
    make(key("c"), 1000);
    make(`.tmp-${key("d")}-1`, 2 * 60 * 60 * 1000);
    make(`.tmp-${key("e")}-2`, 1000);
    // A cache root moved into a shared directory keeps what this module did not write.
    make("unrelated", 4000);
    make(".tmp-unrelated", 2 * 60 * 60 * 1000);
    fs.writeFileSync(path.join(root, "stray-file"), "");
    pruneWasmArtifacts(root, 2, now);
    assert.deepEqual(fs.readdirSync(root).sort(), [`.tmp-${key("e")}-2`, ".tmp-unrelated", key("b"), key("c"), "stray-file", "unrelated"].sort());
  });
});

test("restoring refreshes an entry's recency", () => {
  withDir((dir) => {
    const root = path.join(dir, "cache");
    writeArtifacts(path.join(dir, "a"), "one");
    const [first, second] = ["1".repeat(64), "2".repeat(64)];
    for (const key of [first, second]) storeWasmArtifacts({ root, key, files: FILES, sourceDir: path.join(dir, "a") });
    const past = new Date(Date.now() - 10_000);
    fs.utimesSync(path.join(root, first), past, past);
    fs.utimesSync(path.join(root, second), new Date(Date.now() - 5000), new Date(Date.now() - 5000));
    restoreWasmArtifacts({ root, key: first, files: FILES, outDir: path.join(dir, "a") });
    pruneWasmArtifacts(root, 1);
    assert.deepEqual(fs.readdirSync(root), [first]);
  });
});

test("path remapping appends to the target rustflags as a TOML array", () => {
  const args = remapPathArgs({ cargoHome: "/h/my cargo", sysroot: "/h/.rustup/tc", target: "wasm32-wasip1-threads" });
  assert.deepEqual(args, [
    "--config",
    'target.wasm32-wasip1-threads.rustflags=["--remap-path-prefix=/h/my cargo=/cargo","--remap-path-prefix=/h/.rustup/tc=/rustc-sysroot"]',
  ]);
});

test("build flag environment keys flags but not checkout-specific compiler paths", () => {
  const flags = buildFlagEnv({
    CFLAGS_wasm32_wasip1_threads: "-O3",
    RUSTFLAGS: "-Cfoo",
    CARGO_PROFILE_WASM_RELEASE_DEBUG: "true",
    CC_wasm32_wasip1_threads: "/checkout/scripts/wasm/cc.sh",
    CARGO_TARGET_DIR: "/checkout/target",
    MISE_PROJECT_ROOT: "/checkout",
  });
  assert.deepEqual(JSON.parse(flags), [
    ["CARGO_PROFILE_WASM_RELEASE_DEBUG", "true"],
    ["CFLAGS_wasm32_wasip1_threads", "-O3"],
    ["RUSTFLAGS", "-Cfoo"],
  ]);
});
