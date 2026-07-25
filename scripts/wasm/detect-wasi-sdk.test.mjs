import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveWasiSdk } from "./detect-wasi-sdk.mjs";

test("prefers an explicit SDK path, then the newest local toolchain", () => {
  const home = mkdtempSync(join(os.tmpdir(), "wasi-sdk-test-"));
  const toolchains = join(home, ".local", "toolchains");
  mkdirSync(join(toolchains, "wasi-sdk-22"), { recursive: true });
  mkdirSync(join(toolchains, "wasi-sdk-24"), { recursive: true });
  assert.equal(resolveWasiSdk({ home, env: { WASI_SDK_PATH: "" }, candidates: [] }), join(toolchains, "wasi-sdk-24"));
  const explicit = join(home, "explicit");
  mkdirSync(explicit);
  assert.equal(resolveWasiSdk({ home, env: { WASI_SDK_PATH: explicit }, candidates: [] }), explicit);
});

test("reports no SDK rather than a directory that is not one", () => {
  const home = mkdtempSync(join(os.tmpdir(), "wasi-sdk-test-"));
  assert.equal(resolveWasiSdk({ home, env: {}, candidates: [] }), "", "no toolchains directory at all");
  mkdirSync(join(home, ".local", "toolchains", "unrelated-tool"), { recursive: true });
  assert.equal(resolveWasiSdk({ home, env: {}, candidates: [] }), "", "toolchains directory holds no wasi-sdk-*");
  assert.equal(resolveWasiSdk({ home, env: { WASI_SDK_PATH: join(home, "missing") }, candidates: [] }), "", "WASI_SDK_PATH points at nothing");
});
