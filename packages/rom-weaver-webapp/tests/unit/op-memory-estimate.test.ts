import { describe, expect, it } from "vitest";
import {
  estimateOpWorkingSetBytes,
  estimateScheduledThreads,
  resolveAppleMobileSharedMemoryMaximumPages,
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

  it("keeps metadata scans (probe) light", () => {
    expect(estimateOpWorkingSetBytes(topLevel("probe"), 100 * MIB)).toBe(BASE + 25 * MIB);
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

  it("caps mobile runtimes at 1 GiB regardless of reported/absent device memory", () => {
    // iOS Safari: no deviceMemory exposed, so the 1.5 GiB fallback is capped down to the mobile ceiling.
    const iosSafari =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
    expect(resolveMemoryCeilingBytes({ navigator: { userAgent: iosSafari } })).toBe(1 * GIB);
    // iPadOS desktop mode masquerades as MacIntel with touch - still mobile, still capped.
    expect(
      resolveMemoryCeilingBytes({ navigator: { maxTouchPoints: 5, platform: "MacIntel", userAgent: "Macintosh" } }),
    ).toBe(1 * GIB);
    // Android Chrome reports a generous deviceMemory; the mobile cap lowers the 2 GiB clamp to 1 GiB.
    const androidChrome =
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36";
    expect(resolveMemoryCeilingBytes({ navigator: { deviceMemory: 8, userAgent: androidChrome } })).toBe(1 * GIB);
  });

  it("never raises a smaller mobile ceiling up to the cap", () => {
    const lowAndroid =
      "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36";
    expect(resolveMemoryCeilingBytes({ navigator: { deviceMemory: 0.5, userAgent: lowAndroid } })).toBe(512 * MIB);
  });

  it("leaves desktop runtimes uncapped by the mobile ceiling", () => {
    const desktopSafari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";
    expect(resolveMemoryCeilingBytes({ navigator: { deviceMemory: 8, userAgent: desktopSafari } })).toBe(2 * GIB);
  });
});

describe("resolveAppleMobileSharedMemoryMaximumPages", () => {
  it("caps Apple mobile shared WASM memory without changing Android or desktop allocation", () => {
    const iosSafari =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
    const androidChrome = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";
    expect(resolveAppleMobileSharedMemoryMaximumPages({ navigator: { userAgent: iosSafari } })).toBe(16384);
    expect(resolveAppleMobileSharedMemoryMaximumPages({ navigator: { userAgent: androidChrome } })).toBeUndefined();
    expect(
      resolveAppleMobileSharedMemoryMaximumPages({ navigator: { userAgent: "Mozilla/5.0 (Macintosh)" } }),
    ).toBeUndefined();
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

  it("keeps compress heavy: full requested thread count regardless of size", () => {
    expect(estimateScheduledThreads(topLevel("compress"), 0, 8)).toBe(8);
    expect(estimateScheduledThreads(topLevel("compress"), 2 * MIB, 8)).toBe(8);
    expect(estimateScheduledThreads(topLevel("compress"), 1024 * MIB, 8)).toBe(8);
    expect(estimateScheduledThreads(topLevel("compress"), 48 * MIB, 8)).toBe(8);
  });

  it("never exceeds the requested thread count", () => {
    expect(estimateScheduledThreads(topLevel("compress"), 1024 * MIB, 2)).toBe(2);
  });
});
