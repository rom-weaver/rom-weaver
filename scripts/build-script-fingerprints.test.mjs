import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url).pathname;

// bindgen's CargoCallbacks emits rerun-if-changed for every header it reads, including the staged
// copies a build script rewrites in OUT_DIR on each run. Cargo then sees its own output as a changed
// input and recompiles the crate and its dependents on every invocation. In the fuzz job that
// recompiled rom-weaver-containers, rom-weaver-cli, and the fuzz crate twice per target (39 minutes
// across six targets) until the callbacks were replaced.
test("no build script tracks bindgen's own headers through CargoCallbacks", () => {
  const scripts = globSync("crates/**/build.rs", { cwd: root, exclude: (name) => name === "target" || name === "node_modules" });
  assert.ok(scripts.length > 0, "found no build scripts");
  const offenders = scripts.filter((script) => /bindgen::CargoCallbacks|CargoCallbacks::new/u.test(readFileSync(`${root}${script}`, "utf8")));
  assert.deepEqual(offenders, []);
});
