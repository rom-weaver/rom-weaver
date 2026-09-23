import { describe, expect, it } from "vitest";
import type { RomWeaverRunInput } from "../../src/wasm/browser-opfs-runtime-types.ts";
import { browserThreadRequestOptions } from "../../src/wasm/browser-wasi-thread-sizing.ts";
import { readRomWeaverRequestedThreadCount } from "../../src/wasm/rom-weaver-command.ts";
import { normalizeDefaultThreads, resolveBrowserDefaultThreads } from "../../src/wasm/workers/browser-thread-budget.ts";

const rootWithCores = (hardwareConcurrency: unknown): typeof globalThis =>
  ({ navigator: { hardwareConcurrency } }) as unknown as typeof globalThis;

const checksumCommand = (threads: unknown): RomWeaverRunInput =>
  ({ args: { input: "rom.bin", threads }, type: "checksum" }) as unknown as RomWeaverRunInput;

describe("resolveBrowserDefaultThreads", () => {
  it("scales the implicit default to the reported core count (floor 4, ceiling 64)", () => {
    // The default follows hardwareConcurrency within the four-to-64-thread bounds.
    expect(resolveBrowserDefaultThreads(rootWithCores(12))).toBe(12);
    expect(resolveBrowserDefaultThreads(rootWithCores(2))).toBe(4);
    expect(resolveBrowserDefaultThreads(rootWithCores(128))).toBe(64);
    expect(resolveBrowserDefaultThreads(rootWithCores(undefined))).toBe(4);
    expect(resolveBrowserDefaultThreads({} as typeof globalThis)).toBe(4);
    expect(resolveBrowserDefaultThreads(rootWithCores(Number.NaN))).toBe(4);
    expect(resolveBrowserDefaultThreads(rootWithCores(Number.POSITIVE_INFINITY))).toBe(4);
    expect(resolveBrowserDefaultThreads(rootWithCores(-1))).toBe(4);
    expect(resolveBrowserDefaultThreads(rootWithCores("invalid"))).toBe(4);
    expect(resolveBrowserDefaultThreads(rootWithCores(7.9))).toBe(7);
    expect(resolveBrowserDefaultThreads(rootWithCores("12"))).toBe(12);
  });
});

describe("normalizeDefaultThreads", () => {
  it("keeps disabled and configured thread values distinct from the browser default", () => {
    expect(normalizeDefaultThreads(undefined)).toBeNull();
    expect(normalizeDefaultThreads(null)).toBeNull();
    expect(normalizeDefaultThreads(false)).toBeNull();
    expect(normalizeDefaultThreads(0)).toBeNull();
    expect(normalizeDefaultThreads("0")).toBeNull();
    expect(normalizeDefaultThreads("off")).toBeNull();
    expect(normalizeDefaultThreads(1)).toBe(1);
    expect(normalizeDefaultThreads("8")).toBe(8);
    expect(normalizeDefaultThreads("128")).toBe(64);
  });
});

describe("execution-path auto thread resolution", () => {
  it("resolves a command's `auto` threads to the host core count, not a flat 4", () => {
    // Use the same request options as browser-opfs-runner so Auto retains the resolved host budget.
    const options = browserThreadRequestOptions(resolveBrowserDefaultThreads(rootWithCores(12)));
    expect(readRomWeaverRequestedThreadCount(checksumCommand("auto"), options)).toBe(12);
  });

  it("still clamps an explicit oversized request to the pool maximum", () => {
    const options = browserThreadRequestOptions(resolveBrowserDefaultThreads(rootWithCores(12)));
    expect(readRomWeaverRequestedThreadCount(checksumCommand(999), options)).toBe(64);
  });
});
