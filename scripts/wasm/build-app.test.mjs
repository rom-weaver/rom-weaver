import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWasmSourceFingerprint } from "./wasm-source-fingerprint.mjs";

const BUILD_APP = fileURLToPath(new URL("./build-app.mjs", import.meta.url));
const skip = process.platform === "win32" && "the fake toolchain is POSIX shell scripts";

// Creates a project root with a fake toolchain. The fake cargo logs its arguments and fails, so a run that reaches it errors.
function createProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-build-app-"));
  const root = path.join(dir, "root");
  const bin = path.join(dir, "bin");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  for (const [file, text] of [["Cargo.lock", "lock"], ["Cargo.toml", "manifest"], [".cargo/config.toml", "config"], [".config/mise.toml", "mise"], ["crates/example/lib.rs", "one"], ["scripts/gen-third-party-licenses.mjs", ""]])
    write(path.join(root, file), text);
  // The fake cargo fails unless FAKE_CARGO_MODULE names a module to write. FAKE_CARGO_EDIT also makes it rewrite that file mid-build, and FAKE_CARGO_REVERT restores the original text.
  const cargo = [
    '[ "$1" = "--version" ] && exit 0',
    'echo "$@" >> "$FAKE_CARGO_LOG"',
    '[ -n "$FAKE_CARGO_MODULE" ] || exit 1',
    '[ -z "$FAKE_CARGO_EDIT" ] || echo edited > "$FAKE_CARGO_EDIT"',
    '[ -z "$FAKE_CARGO_REVERT" ] || printf one > "$FAKE_CARGO_EDIT"',
    'mkdir -p "$(dirname "$FAKE_CARGO_MODULE")"',
    'echo built-module > "$FAKE_CARGO_MODULE"',
  ].join("\n");
  const tools = { cargo, rustc: "echo /fake-sysroot", strip: "echo strip 1", clang: "echo clang 1" };
  for (const [name, body] of Object.entries(tools)) {
    write(path.join(bin, name), `#!/bin/sh\n${body}\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  fs.mkdirSync(path.join(dir, "sysroot"));
  const wasmDir = path.join(root, "packages/rom-weaver-webapp/src/wasm");
  fs.mkdirSync(wasmDir, { recursive: true });
  const cargoLog = path.join(dir, "cargo.log");
  const run = (mode, extraEnv = {}) =>
    spawnSync(process.execPath, [BUILD_APP, mode], {
      encoding: "utf8",
      env: {
        PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
        HOME: dir,
        XDG_CACHE_HOME: dir,
        MISE_PROJECT_ROOT: root,
        WASI_CLANG: path.join(bin, "clang"),
        WASI_STRIP: path.join(bin, "strip"),
        WASI_SYSROOT: path.join(dir, "sysroot"),
        ROM_WEAVER_WASM_CACHE: "0",
        ROM_WEAVER_BROTLI_CACHE: "0",
        FAKE_CARGO_LOG: cargoLog,
        ...extraEnv,
      },
    });
  const installModule = (recordedFingerprint) => {
    fs.writeFileSync(path.join(wasmDir, "rom-weaver-app.wasm"), "production-module");
    fs.writeFileSync(path.join(wasmDir, "rom-weaver-app.wasm.source.sha256"), `${recordedFingerprint}\n`);
  };
  const cargoCalls = () => (fs.existsSync(cargoLog) ? fs.readFileSync(cargoLog, "utf8").trim().split("\n") : []);
  const builtModule = path.join(root, "target/wasm32-wasip1-threads/wasm-release/examples/rom-weaver-app.wasm");
  return { dir, root, wasmDir, builtModule, run, installModule, cargoCalls, fingerprint: () => createWasmSourceFingerprint(root) };
}

test("a fast build keeps a module already built from the current inputs", { skip }, () => {
  const project = createProject();
  try {
    project.installModule(project.fingerprint());
    const result = project.run("fast");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /kept .*already built from the current inputs/);
    assert.equal(fs.readFileSync(path.join(project.wasmDir, "rom-weaver-app.wasm"), "utf8"), "production-module");
    assert.deepEqual(project.cargoCalls(), []);
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

test("a fast build rebuilds a module built from other inputs, or when forced", { skip }, () => {
  const project = createProject();
  try {
    project.installModule("stale");
    assert.notEqual(project.run("fast").status, 0);
    assert.match(project.cargoCalls().join("\n"), /^build /);
    assert.match(project.cargoCalls()[0], /linker-plugin-lto=no/);
    assert.equal(project.cargoCalls().length, 1);
    assert.ok(!fs.existsSync(path.join(project.wasmDir, "rom-weaver-app.wasm.source.sha256")), "a failed rebuild leaves no record of the old inputs");

    project.installModule(project.fingerprint());
    assert.notEqual(project.run("fast", { ROM_WEAVER_WASM_FORCE: "1" }).status, 0);
    assert.equal(project.cargoCalls().length, 2);
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

test("a kept module gets a quick sidecar unless a production build made it", { skip }, () => {
  const project = createProject();
  try {
    project.installModule(project.fingerprint());
    const sidecar = path.join(project.wasmDir, "rom-weaver-app.wasm.br");
    assert.equal(project.run("fast").status, 0);
    assert.ok(fs.existsSync(sidecar), "a module without a sidecar gets one");

    fs.rmSync(sidecar);
    fs.writeFileSync(path.join(project.wasmDir, "rom-weaver-app.wasm.prod.sha256"), "production\n");
    assert.equal(project.run("fast").status, 0);
    assert.ok(!fs.existsSync(sidecar), "a production module keeps its own sidecar state");
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

test("only a fast build keeps a module built from the current inputs", { skip }, () => {
  const project = createProject();
  try {
    project.installModule(project.fingerprint());
    assert.notEqual(project.run("dev").status, 0);
    assert.equal(project.cargoCalls().length, 1);
    assert.doesNotMatch(project.cargoCalls()[0], /linker-plugin-lto/);
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

for (const [name, revert] of [["still edited after the build", ""], ["reverted before the build ended", "1"]]) {
  test(`a module built while its sources were edited is never kept: ${name}`, { skip }, () => {
    const project = createProject();
    try {
      const source = path.join(project.root, "crates/example/lib.rs");
      const edit = { FAKE_CARGO_EDIT: source, FAKE_CARGO_REVERT: revert, FAKE_CARGO_MODULE: project.builtModule };
      assert.equal(project.run("fast", edit).status, 0);
      fs.writeFileSync(source, "one");
      assert.notEqual(project.run("fast").status, 0);
      assert.equal(project.cargoCalls().length, 2, "the second run rebuilds instead of keeping the module");
    } finally {
      fs.rmSync(project.dir, { recursive: true, force: true });
    }
  });
}

test("a module built from untouched sources is kept by the next fast build", { skip }, () => {
  const project = createProject();
  try {
    // ctime cannot be backdated. Wait past the one-second slack that counts fresh files as edited.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    assert.equal(project.run("fast", { FAKE_CARGO_MODULE: project.builtModule }).status, 0);
    assert.equal(project.run("fast").status, 0);
    assert.equal(project.cargoCalls().length, 1, "the second run keeps the module");
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});
