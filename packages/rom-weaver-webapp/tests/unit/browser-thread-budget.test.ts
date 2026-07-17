import { describe, expect, it } from "vitest";
import type { RomWeaverRunInput } from "../../src/wasm/browser-opfs-runtime-types.ts";
import { browserThreadRequestOptions } from "../../src/wasm/browser-wasi-thread-sizing.ts";
import { readRomWeaverRequestedThreadCount } from "../../src/wasm/rom-weaver-command.ts";
import { resolveBrowserDefaultThreads } from "../../src/wasm/workers/browser-thread-budget.ts";

const rootWithCores = (hardwareConcurrency: number | undefined): typeof globalThis =>
  ({ navigator: { hardwareConcurrency } }) as unknown as typeof globalThis;

const checksumCommand = (threads: unknown): RomWeaverRunInput =>
  ({ args: { source: "rom.bin", threads }, type: "checksum" }) as unknown as RomWeaverRunInput;

describe("resolveBrowserDefaultThreads", () => {
  it("scales the implicit default to the reported core count (floor 4, ceiling 64)", () => {
    // Regression guard: the UI advertises "auto = browser-reported core count" (settings.threadsHint),
    // so the engine default must scale with hardwareConcurrency rather than capping every host at 4.
    expect(resolveBrowserDefaultThreads(rootWithCores(12))).toBe(12);
    expect(resolveBrowserDefaultThreads(rootWithCores(2))).toBe(4);
    expect(resolveBrowserDefaultThreads(rootWithCores(128))).toBe(64);
    expect(resolveBrowserDefaultThreads(rootWithCores(undefined))).toBe(4);
  });
});

describe("execution-path auto thread resolution", () => {
  it("resolves a command's `auto` threads to the host core count, not a flat 4", () => {
    // Mirrors browser-opfs-runner.ts: it clamps/parses the request with the options the runner builds
    // from resolveBrowserDefaultThreads(). Before the fix this collapsed to 4 on every multi-core host.
    const options = browserThreadRequestOptions(resolveBrowserDefaultThreads(rootWithCores(12)));
    expect(readRomWeaverRequestedThreadCount(checksumCommand("auto"), options)).toBe(12);
  });

  it("still clamps an explicit oversized request to the pool maximum", () => {
    const options = browserThreadRequestOptions(resolveBrowserDefaultThreads(rootWithCores(12)));
    expect(readRomWeaverRequestedThreadCount(checksumCommand(999), options)).toBe(64);
  });
});
