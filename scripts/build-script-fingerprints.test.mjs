import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url).pathname;

// Build scripts MUST NOT use bindgen's CargoCallbacks. It tracks staged headers that a build
// script rewrites, so Cargo rebuilds on every run.
test("no build script tracks bindgen's own headers through CargoCallbacks", () => {
  const scripts = globSync("crates/**/build.rs", { cwd: root, exclude: (name) => name === "target" || name === "node_modules" });
  assert.ok(scripts.length > 0, "found no build scripts");
  const offenders = scripts.filter((script) => /bindgen::CargoCallbacks|CargoCallbacks::new/u.test(readFileSync(`${root}${script}`, "utf8")));
  assert.deepEqual(offenders, []);
});
