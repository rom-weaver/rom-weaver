import { afterEach, expect, test } from "vitest";
import {
  getRomWeaverRunnerMetadata,
  resetRomWeaverRunner,
  warmupRomWeaverRunner,
} from "../../src/workers/rom-weaver/rom-weaver-runner.ts";

afterEach(async () => {
  await resetRomWeaverRunner();
});

test("rom-weaver runner ready metadata exposes the loaded browser wasm runtime", async () => {
  const canUseSharedMemory = typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated === true;
  const ready = await warmupRomWeaverRunner();
  const metadata = await getRomWeaverRunnerMetadata();

  expect(ready).toEqual(metadata);
  expect(ready.threaded).toBe(canUseSharedMemory);
  expect(ready.wasmUrl).toContain(canUseSharedMemory ? "rom-weaver-cli-threaded" : "rom-weaver-cli.wasm");
});
