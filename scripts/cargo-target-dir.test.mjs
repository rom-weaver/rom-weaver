import assert from "node:assert/strict";
import test from "node:test";

import { cargoTargetDir } from "./cargo-target-dir.mjs";

test("falls back to <root>/target when nothing is configured", () => {
  assert.equal(cargoTargetDir("/repo", {}, "/elsewhere"), "/repo/target");
});

test("honors CARGO_TARGET_DIR, including one outside the checkout", () => {
  assert.equal(cargoTargetDir("/repo/.worktrees/w", { CARGO_TARGET_DIR: "/repo/target" }, "/repo/.worktrees/w"), "/repo/target");
});

// Cargo resolves a relative CARGO_TARGET_DIR against the current directory, so
// the lefthook commands that set `target/hook-typegen` must land in the
// checkout they run from, not in the script's own root.
test("resolves a relative value against the current directory", () => {
  assert.equal(cargoTargetDir("/repo", { CARGO_TARGET_DIR: "target/hook-wasm" }, "/repo/.worktrees/w"), "/repo/.worktrees/w/target/hook-wasm");
});

test("CARGO_TARGET_DIR wins over CARGO_BUILD_TARGET_DIR, as in Cargo", () => {
  const env = { CARGO_TARGET_DIR: "/a", CARGO_BUILD_TARGET_DIR: "/b" };
  assert.equal(cargoTargetDir("/repo", env, "/repo"), "/a");
  assert.equal(cargoTargetDir("/repo", { CARGO_BUILD_TARGET_DIR: "/b" }, "/repo"), "/b");
});
