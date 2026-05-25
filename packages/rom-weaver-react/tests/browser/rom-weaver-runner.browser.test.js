import { afterEach, expect, test } from "vitest";
import {
  getRomWeaverRunnerMetadata,
  resetRomWeaverRunner,
  selectRomWeaverBrowserWasmAsset,
  warmupRomWeaverRunner,
} from "../../src/workers/rom-weaver/rom-weaver-runner.ts";

afterEach(async () => {
  await resetRomWeaverRunner();
});

test("rom-weaver runner selects threaded wasm when shared memory is supported", () => {
  const selected = selectRomWeaverBrowserWasmAsset({
    threadedSupported: true,
    threadedWasmUrl: "/assets/rom-weaver-cli-threaded.wasm",
    wasmUrl: "/assets/rom-weaver-cli.wasm",
  });

  expect(selected.threaded).toBe(true);
  expect(selected.selectedWasmUrl).toBe("/assets/rom-weaver-cli-threaded.wasm");
});

test("rom-weaver runner keeps non-threaded wasm when shared memory is unavailable", () => {
  const selected = selectRomWeaverBrowserWasmAsset({
    threadedSupported: false,
    threadedWasmUrl: "/assets/rom-weaver-cli-threaded.wasm",
    wasmUrl: "/assets/rom-weaver-cli.wasm",
  });

  expect(selected.threaded).toBe(false);
  expect(selected.selectedWasmUrl).toBe("/assets/rom-weaver-cli.wasm");
});

test("rom-weaver runner ready metadata exposes the loaded browser wasm runtime", async () => {
  const canUseSharedMemory = typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated === true;
  const ready = await warmupRomWeaverRunner();
  const metadata = await getRomWeaverRunnerMetadata();

  expect(ready).toEqual(metadata);
  expect(ready.threaded).toBe(canUseSharedMemory);
  expect(ready.wasmUrl).toContain(canUseSharedMemory ? "rom-weaver-cli-threaded" : "rom-weaver-cli.wasm");
});
