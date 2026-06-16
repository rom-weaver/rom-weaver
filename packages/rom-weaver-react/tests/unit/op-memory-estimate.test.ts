import { describe, expect, it } from "vitest";
import {
  estimateOpWorkingSetBytes,
  estimateScheduledThreads,
  resolveMemoryCeilingBytes,
} from "../../src/lib/runtime/op-memory-estimate.ts";
import type { RomWeaverCommand } from "../../src/wasm/index.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;
const BASE = 16 * MIB;

const topLevel = (type: string): RomWeaverCommand => ({ args: {}, type }) as unknown as RomWeaverCommand;
const patch = (patchType: string): RomWeaverCommand =>
  ({ args: { args: {}, type: patchType }, type: "patch" }) as unknown as RomWeaverCommand;

describe("estimateOpWorkingSetBytes", () => {
  it("returns the base estimate when the input size is unknown", () => {
    expect(estimateOpWorkingSetBytes(topLevel("compress"), 0)).toBe(BASE);
    expect(estimateOpWorkingSetBytes(topLevel("compress"), Number.NaN)).toBe(BASE);
    expect(estimateOpWorkingSetBytes(topLevel("extract"), -5)).toBe(BASE);
  });

  it("scales compress by 1.5x over the input", () => {
    expect(estimateOpWorkingSetBytes(topLevel("compress"), 100 * MIB)).toBe(BASE + 150 * MIB);
  });

  it("scales extract and patch-apply by 2x for the decoded payload", () => {
    expect(estimateOpWorkingSetBytes(topLevel("extract"), 100 * MIB)).toBe(BASE + 200 * MIB);
    expect(estimateOpWorkingSetBytes(patch("apply"), 100 * MIB)).toBe(BASE + 200 * MIB);
  });

  it("keeps metadata scans (probe/list) light", () => {
    expect(estimateOpWorkingSetBytes(topLevel("probe"), 100 * MIB)).toBe(BASE + 25 * MIB);
    expect(estimateOpWorkingSetBytes(topLevel("list"), 100 * MIB)).toBe(BASE + 25 * MIB);
  });

  it("treats checksum/trim as a single streamed copy", () => {
    expect(estimateOpWorkingSetBytes(topLevel("checksum"), 100 * MIB)).toBe(BASE + 100 * MIB);
    expect(estimateOpWorkingSetBytes(topLevel("trim"), 100 * MIB)).toBe(BASE + 100 * MIB);
  });
});

describe("resolveMemoryCeilingBytes", () => {
  it("derives half of device memory, clamped to the maximum", () => {
    expect(resolveMemoryCeilingBytes({ navigator: { deviceMemory: 8 } })).toBe(2 * GIB);
    expect(resolveMemoryCeilingBytes({ navigator: { deviceMemory: 4 } })).toBe(2 * GIB);
    expect(resolveMemoryCeilingBytes({ navigator: { deviceMemory: 2 } })).toBe(1 * GIB);
  });

  it("clamps tiny device memory up to the minimum", () => {
    expect(resolveMemoryCeilingBytes({ navigator: { deviceMemory: 0.5 } })).toBe(512 * MIB);
  });

  it("falls back when device memory is unavailable", () => {
    expect(resolveMemoryCeilingBytes({})).toBe(Math.floor(1.5 * GIB));
    expect(resolveMemoryCeilingBytes(null)).toBe(Math.floor(1.5 * GIB));
  });
});

describe("estimateScheduledThreads", () => {
  it("reserves a single thread for sequential operations regardless of size", () => {
    expect(estimateScheduledThreads(patch("apply"), 500 * MIB, 8)).toBe(1);
    expect(estimateScheduledThreads(patch("validate"), 500 * MIB, 8)).toBe(1);
    expect(estimateScheduledThreads(topLevel("trim"), 500 * MIB, 8)).toBe(1);
  });

  it("returns 0 for thread-less operations", () => {
    expect(estimateScheduledThreads(topLevel("probe"), 100 * MIB, 0)).toBe(0);
    expect(estimateScheduledThreads(topLevel("list"), 100 * MIB, 0)).toBe(0);
  });

  it("keeps compress heavy: full request when size is unknown, size-scaled when known", () => {
    expect(estimateScheduledThreads(topLevel("compress"), 0, 8)).toBe(8);
    expect(estimateScheduledThreads(topLevel("compress"), 2 * MIB, 8)).toBe(1);
    expect(estimateScheduledThreads(topLevel("compress"), 1024 * MIB, 8)).toBe(8);
    expect(estimateScheduledThreads(topLevel("compress"), 48 * MIB, 8)).toBe(3);
  });

  it("keeps other operations light: one thread unless the input is large", () => {
    expect(estimateScheduledThreads(topLevel("extract"), 0, 8)).toBe(1);
    expect(estimateScheduledThreads(topLevel("extract"), 10 * MIB, 8)).toBe(1);
    expect(estimateScheduledThreads(topLevel("extract"), 200 * MIB, 8)).toBe(4);
    expect(estimateScheduledThreads(topLevel("checksum"), 0, 8)).toBe(1);
  });

  it("never exceeds the requested thread count", () => {
    expect(estimateScheduledThreads(topLevel("compress"), 1024 * MIB, 2)).toBe(2);
  });
});
