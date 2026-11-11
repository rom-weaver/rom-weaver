import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildFlagEnv, remapPathArgs } from "./build-app.mjs";
import { createCargoConfigSnapshot } from "./wasm-source-fingerprint.mjs";
import {
  pruneWasmArtifacts,
  restoreWasmArtifacts,
  storeWasmArtifacts,
  wasmArtifactCacheKey,
  wasmArtifactCacheRoot,
} from "./wasm-artifact-cache.mjs";

const FILES = ["rom-weaver-app.wasm", "rom-weaver-app.wasm.br"];

const withDir = (run) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver wasm cache ")));
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

test("an existing entry is kept and an incomplete one is rebuilt", () => {
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

    // The build that follows the miss stores the complete entry again.
    storeWasmArtifacts({ root, key: "k", files: FILES, sourceDir: path.join(dir, "a") });
    assert.equal(restoreWasmArtifacts({ root, key: "k", files: FILES, outDir: out }), true);
    assert.equal(fs.readFileSync(path.join(out, FILES[1]), "utf8"), `${FILES[1]}:one`);
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

test("storing preserves foreign hash and staging directories in a shared root", () => {
  withDir((dir) => {
    const root = path.join(dir, "cache");
    const built = path.join(dir, "built");
    writeArtifacts(built, "one");
    const foreign = ["f".repeat(64), `.tmp-${"e".repeat(64)}-123`];
    for (const name of foreign) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, "sentinel"), "keep");
      fs.utimesSync(path.join(root, name), new Date(0), new Date(0));
    }
    fs.writeFileSync(path.join(root, foreign[0], ".rom-weaver-wasm-cache-entry"), "invalid marker");
    fs.utimesSync(path.join(root, foreign[0]), new Date(0), new Date(0));
    const linked = "d".repeat(64);
    fs.symlinkSync(path.join(root, foreign[0]), path.join(root, linked), "junction");
    for (let index = 0; index < 9; index++) {
      storeWasmArtifacts({ root, key: wasmArtifactCacheKey({ index }), files: FILES, sourceDir: built });
    }
    for (const name of foreign) assert.equal(fs.readFileSync(path.join(root, name, "sentinel"), "utf8"), "keep");
    assert.equal(fs.lstatSync(path.join(root, linked)).isSymbolicLink(), true);
    assert.equal(fs.readdirSync(root).length, 11);
  });
});

test("a store never replaces a foreign directory at its key, even when forced", () => {
  withDir((dir) => {
    const root = path.join(dir, "cache");
    writeArtifacts(path.join(dir, "built"), "one");
    for (const sentinel of [false, true]) {
      const key = (sentinel ? "f" : "e").repeat(64);
      fs.mkdirSync(path.join(root, key), { recursive: true });
      if (sentinel) fs.writeFileSync(path.join(root, key, "sentinel"), "keep");
      for (const replace of [false, true]) {
        assert.throws(() => storeWasmArtifacts({ root, key, files: FILES, sourceDir: path.join(dir, "built"), replace }), /refusing to replace unowned WASM cache entry/);
        assert.deepEqual(fs.readdirSync(path.join(root, key)), sentinel ? ["sentinel"] : []);
      }
    }
  });
});

test("empty artifacts and directories in owned entries are rebuilt", () => {
  withDir((dir) => {
    const root = path.join(dir, "cache");
    const built = path.join(dir, "built");
    const outDir = path.join(dir, "out");
    writeArtifacts(built, "one");
    fs.mkdirSync(outDir);
    storeWasmArtifacts({ root, key: "k", files: FILES, sourceDir: built });
    for (const directory of [false, true]) {
      const artifact = path.join(root, "k", FILES[0]);
      fs.rmSync(artifact, { recursive: true });
      if (directory) fs.mkdirSync(artifact);
      else fs.writeFileSync(artifact, "");
      assert.equal(restoreWasmArtifacts({ root, key: "k", files: FILES, outDir }), false);
      storeWasmArtifacts({ root, key: "k", files: FILES, sourceDir: built });
      assert.equal(restoreWasmArtifacts({ root, key: "k", files: FILES, outDir }), true);
      assert.equal(fs.readFileSync(path.join(outDir, FILES[0]), "utf8"), `${FILES[0]}:one`);
    }
  });
});

test("pruning keeps the most recently used entries and drops stale staging", () => {
  withDir((dir) => {
    const root = path.join(dir, "cache");
    const built = path.join(dir, "built");
    writeArtifacts(built, "one");
    const now = Date.now();
    const key = (char) => char.repeat(64);
    const make = (name, ageMs, owned = true) => {
      if (owned) {
        const entryKey = name.startsWith(".tmp-") ? name.split("-")[1] : name;
        storeWasmArtifacts({ root, key: entryKey, files: FILES, sourceDir: built });
        if (name !== entryKey) fs.renameSync(path.join(root, entryKey), path.join(root, name));
      } else fs.mkdirSync(path.join(root, name));
      const time = new Date(now - ageMs);
      fs.utimesSync(path.join(root, name), time, time);
    };
    make(key("a"), 3000);
    make(key("b"), 2000);
    make(key("c"), 1000);
    make(`.tmp-${key("d")}-1`, 2 * 60 * 60 * 1000);
    make(`.tmp-${key("e")}-2`, 1000);
    // A cache root moved into a shared directory keeps what this module did not write.
    make("unrelated", 4000, false);
    make(".tmp-unrelated", 2 * 60 * 60 * 1000, false);
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

test("compiler flag overrides always change the artifact key", () => {
  const inputs = { source: "same", env: buildFlagEnv({}) };
  const original = wasmArtifactCacheKey(inputs);
  for (const name of ["TARGET_CFLAGS", "TARGET_CXXFLAGS", "HOST_CFLAGS", "HOST_CXXFLAGS", "CC_SHELL_ESCAPED_FLAGS", "CRATE_CC_NO_DEFAULTS"]) {
    assert.notEqual(wasmArtifactCacheKey({ ...inputs, env: buildFlagEnv({ [name]: "1" }) }), original, name);
  }
});

test("Cargo home and ancestor config contents invalidate artifact keys", () => {
  withDir((dir) => {
    const root = path.join(dir, "checkout");
    const cargoHome = path.join(dir, "home");
    fs.mkdirSync(root);
    fs.mkdirSync(cargoHome);
    const options = { root, cwd: root, cargoHome };
    const key = () => wasmArtifactCacheKey({ configuration: createCargoConfigSnapshot(options).fingerprint });
    for (const directory of [cargoHome, path.join(dir, ".cargo")]) {
      fs.mkdirSync(directory, { recursive: true });
      for (const name of ["config", "config.toml"]) {
        const file = path.join(directory, name);
        const absent = key();
        fs.writeFileSync(file, "[profile.wasm-release]\nopt-level = 3\n");
        const initial = key();
        assert.notEqual(initial, absent);
        fs.writeFileSync(file, "[profile.wasm-release]\nopt-level = 1\n");
        assert.notEqual(key(), initial);
        fs.writeFileSync(file, Buffer.from([0xff]));
        const invalidBytes = key();
        fs.writeFileSync(file, Buffer.from([0xfe]));
        assert.notEqual(key(), invalidBytes);
        fs.rmSync(file);
        assert.equal(key(), absent);
      }
    }
  });
});

test("Cargo config snapshots retain writes reverted during a build", () => {
  withDir((dir) => {
    const cargoHome = path.join(dir, "home");
    fs.mkdirSync(cargoHome);
    const file = path.join(cargoHome, "config.toml");
    fs.writeFileSync(file, "one");
    const options = { root: dir, cwd: dir, cargoHome, sinceMs: Date.now() };
    const initial = createCargoConfigSnapshot(options);
    assert.equal(createCargoConfigSnapshot({ ...options, sinceMs: Date.now() + 60_000 }).modified, false);
    fs.writeFileSync(file, "two");
    fs.writeFileSync(file, "one");
    const reverted = createCargoConfigSnapshot(options);
    assert.equal(reverted.fingerprint, initial.fingerprint);
    assert.equal(reverted.modified, true);
    fs.rmSync(file);
    const absent = createCargoConfigSnapshot(options);
    assert.equal(absent.modified, false);
  });
});

test("Cargo config snapshots ignore timestamp changes on directories around the config files", () => {
  withDir((dir) => {
    const cargoHome = path.join(dir, "home");
    const outer = path.join(dir, "external", "outer");
    fs.mkdirSync(cargoHome);
    fs.mkdirSync(path.join(outer, "inner"), { recursive: true });
    fs.writeFileSync(path.join(cargoHome, "config.toml"), 'include = ["../external/outer/inner/profile.toml"]\n');
    fs.writeFileSync(path.join(outer, "inner", "profile.toml"), "[profile.wasm-release]\nopt-level = 3\n");
    const options = { root: dir, cwd: dir, cargoHome, sinceMs: Date.now() + 60_000 };
    const initial = createCargoConfigSnapshot(options);
    assert.equal(initial.modified, false);
    // Cargo's own tracker in CARGO_HOME and unrelated writes in the checkout or its parents move these timestamps during every build.
    const changedAt = new Date(options.sinceMs + 60_000);
    for (const directory of [outer, path.join(outer, "inner"), cargoHome, dir]) fs.utimesSync(directory, changedAt, changedAt);
    const changed = createCargoConfigSnapshot(options);
    assert.equal(changed.fingerprint, initial.fingerprint);
    assert.equal(changed.modified, false);
    assert.equal(changed.state, initial.state);
  });
});

test("Cargo home parent traversal disables the shared cache", () => {
  withDir((dir) => {
    const cargoHome = path.join(dir, "home");
    fs.mkdirSync(cargoHome);
    fs.writeFileSync(path.join(cargoHome, "config.toml"), "[profile.wasm-release]\nopt-level = 3\n");
    const options = { root: dir, cwd: dir, cargoHome };
    assert.equal(createCargoConfigSnapshot(options).usable, true);
    for (const home of ["home" + path.sep + ".." + path.sep + "home", cargoHome + path.sep + ".." + path.sep + "home"]) {
      assert.throws(() => createCargoConfigSnapshot({ ...options, cargoHome: home }), /CARGO_HOME parent components/);
    }
  });
});

test("Cargo configuration directory links disable the shared cache", () => {
  withDir((dir) => {
    const cargoHome = path.join(dir, "home");
    const target = path.join(dir, "target");
    const alias = path.join(dir, "alias");
    fs.mkdirSync(cargoHome);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "profile.toml"), "[profile.wasm-release]\nopt-level = 3\n");
    fs.symlinkSync(target, alias, "junction");
    fs.writeFileSync(path.join(cargoHome, "config.toml"), 'include = ["../target/profile.toml"]\n');
    const options = { root: dir, cwd: dir, cargoHome };
    assert.equal(createCargoConfigSnapshot(options).usable, true);
    fs.writeFileSync(path.join(cargoHome, "config.toml"), 'include = ["../alias/profile.toml"]\n');
    assert.equal(createCargoConfigSnapshot(options).usable, false);
  });
});

test("matching checkout configuration shares a path-independent fingerprint", () => {
  withDir((dir) => {
    const cargoHome = path.join(dir, "home");
    fs.mkdirSync(cargoHome);
    fs.writeFileSync(path.join(cargoHome, "config.toml"), "[profile.wasm-release]\nopt-level = 3\n");
    const fingerprints = ["aaa", "zzz"].map((name) => {
      const root = path.join(dir, name);
      fs.mkdirSync(path.join(root, ".cargo", "profiles"), { recursive: true });
      fs.writeFileSync(path.join(root, ".cargo", "config.toml"), 'include = ["profiles/build.toml"]\n');
      fs.writeFileSync(path.join(root, ".cargo", "profiles", "build.toml"), "[build]\njobs = 2\n");
      return createCargoConfigSnapshot({ root, cwd: root, cargoHome }).fingerprint;
    });
    assert.equal(fingerprints[0], fingerprints[1]);
  });
});

test("recursive and optional Cargo includes enter the cache fingerprint", () => {
  withDir((dir) => {
    const cargoHome = path.join(dir, "home");
    fs.mkdirSync(cargoHome);
    const options = { root: dir, cwd: dir, cargoHome };
    const snapshot = () => createCargoConfigSnapshot(options);
    const root = path.join(cargoHome, "config.toml");
    const profile = path.join(cargoHome, "profile.toml");
    const nested = path.join(cargoHome, "nested.toml");
    fs.writeFileSync(root, 'include = ["profile.toml"]\n');
    fs.writeFileSync(profile, 'include = [{ path = "nested.toml", optional = true }]\n[profile.wasm-release]\nopt-level = 3\n');
    const absent = snapshot();
    assert.equal(absent.usable, true);
    fs.writeFileSync(nested, "[profile.wasm-release]\ndebug = false\n");
    const initial = snapshot();
    assert.equal(initial.usable, true);
    assert.notEqual(initial.fingerprint, absent.fingerprint);
    fs.writeFileSync(nested, "[profile.wasm-release]\ndebug = true\n");
    assert.notEqual(snapshot().fingerprint, initial.fingerprint);
    fs.writeFileSync(profile, "[profile.wasm-release]\nopt-level = 1\n");
    assert.notEqual(snapshot().fingerprint, initial.fingerprint);
    fs.writeFileSync(profile, 'include = ["config.toml"]\n');
    assert.equal(snapshot().usable, false);
    fs.writeFileSync(profile, 'include = ["required.toml"]\n');
    assert.equal(snapshot().usable, false);
    fs.writeFileSync(profile, 'include = [{ path = "required.toml", optional = true }, "required.toml"]\n');
    assert.equal(snapshot().usable, false);
  });
});

test("Cargo legacy configuration takes precedence and unsupported input disables caching", () => {
  withDir((dir) => {
    const cargoHome = path.join(dir, "home");
    fs.mkdirSync(cargoHome);
    const options = { root: dir, cwd: dir, cargoHome };
    const legacy = path.join(cargoHome, "config");
    const modern = path.join(cargoHome, "config.toml");
    fs.writeFileSync(legacy, "[profile.wasm-release]\nopt-level = 3\n");
    fs.writeFileSync(modern, 'include = ["missing.toml"]\n');
    assert.equal(createCargoConfigSnapshot(options).usable, true);
    fs.rmSync(legacy);
    assert.equal(createCargoConfigSnapshot(options).usable, false);
    fs.writeFileSync(modern, 'include = "unsupported.toml"\n');
    assert.equal(createCargoConfigSnapshot(options).usable, false);
    fs.writeFileSync(modern, 'include = [{ path = "profile.toml", optional = "true" }]\n');
    assert.equal(createCargoConfigSnapshot(options).usable, false);
    fs.writeFileSync(modern, "not valid TOML\n");
    assert.equal(createCargoConfigSnapshot(options).usable, false);
  });
});
