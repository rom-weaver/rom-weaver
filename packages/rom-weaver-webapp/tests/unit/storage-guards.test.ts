import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/presentation/formatting/index.ts", () => ({ getByteUnitSystem: () => "binary" }));

const { formatBrowserStorageEstimateState, formatByteCount, getBrowserStorageEstimateState } =
  await import("../../src/storage/browser/browser-storage-estimate.ts");
const { ensureBrowserStorageAvailableForOutput, withBrowserOutputStorageFailureContext } =
  await import("../../src/storage/browser/browser-output-storage-guard.ts");

describe("browser storage estimate and output guard", () => {
  it("handles unavailable storage and clamps estimates", async () => {
    await expect(getBrowserStorageEstimateState(null)).resolves.toEqual({});
    const storage = {
      estimate: vi.fn(async () => ({ quota: 1024, usage: -5 })),
      persist: vi.fn(),
      persisted: vi.fn(async () => true),
    };
    await expect(getBrowserStorageEstimateState(storage)).resolves.toEqual({
      availableBytes: 1024,
      persisted: true,
      quotaBytes: 1024,
      usageBytes: 0,
    });
    const partial = { estimate: vi.fn(async () => ({ quota: "bad" })) };
    await expect(getBrowserStorageEstimateState(partial as never)).resolves.toMatchObject({
      availableBytes: undefined,
      quotaBytes: undefined,
      usageBytes: undefined,
    });
  });

  it("returns readable values and records estimate failures", async () => {
    const errorStorage = {
      estimate: vi.fn(async () => {
        throw new Error("estimate failed");
      }),
    };
    await expect(getBrowserStorageEstimateState(errorStorage as never)).resolves.toMatchObject({
      error: "estimate failed",
    });
    const unknownStorage = {
      persisted: vi.fn(async () => {
        throw "no storage";
      }),
    };
    await expect(getBrowserStorageEstimateState(unknownStorage as never)).resolves.toMatchObject({
      error: "no storage",
    });
    expect(formatByteCount(undefined)).toBe("unknown");
    expect(formatByteCount(0)).toBe("0 B");
    expect(formatByteCount(1024)).toBe("1.00 KiB");
    expect(formatByteCount(20 * 1024 * 1024)).toBe("20.0 MiB");
    expect(
      formatBrowserStorageEstimateState({ persisted: true, usageBytes: 1, quotaBytes: 2, availableBytes: 1 }),
    ).toBe("persisted=true usage=1 B quota=2 B available=1 B");
    expect(formatBrowserStorageEstimateState({ error: "offline" })).toContain("error=offline");
  });

  it("wraps quota failures with operation details and preserves other failures", async () => {
    await expect(
      ensureBrowserStorageAvailableForOutput({ operationLabel: "extract", requiredBytes: 3 }),
    ).resolves.toBeUndefined();
    const quota = new Error("No space left on device");
    const wrapped = await withBrowserOutputStorageFailureContext(quota, {
      operationLabel: "extract",
      requiredBytes: -2.9,
    });
    expect(wrapped).toMatchObject({
      cause: quota,
      code: "OUTPUT_WRITE_FAILED",
      details: { operationLabel: "extract", requiredBytes: 0 },
      name: "OutputStorageError",
    });
    expect(await withBrowserOutputStorageFailureContext("quota", { operationLabel: "save" })).toMatchObject({
      code: "OUTPUT_WRITE_FAILED",
      details: { operationLabel: "save" },
    });
    expect(
      await withBrowserOutputStorageFailureContext(new Error("already [storage: guarded]"), { operationLabel: "save" }),
    ).toEqual(expect.objectContaining({ message: "already [storage: guarded]" }));
    const regular = new Error("network failed");
    await expect(withBrowserOutputStorageFailureContext(regular, { operationLabel: "save" })).resolves.toBe(regular);
  });
});
