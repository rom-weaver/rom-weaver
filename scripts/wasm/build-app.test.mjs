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
  const tools = { cargo: '[ "$1" = "--version" ] && exit 0\necho "$@" >> "$FAKE_CARGO_LOG"\nexit 1', rustc: "echo /fake-sysroot", strip: "echo strip 1", clang: "echo clang 1" };
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
  return { dir, wasmDir, run, installModule, cargoCalls, fingerprint: () => createWasmSourceFingerprint(root) };
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
    assert.equal(project.cargoCalls().length, 1);

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
