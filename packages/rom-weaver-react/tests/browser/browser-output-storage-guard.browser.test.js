import { expect, test, vi } from "vitest";
import {
  ensureBrowserStorageAvailableForOutput,
  withBrowserOutputStorageFailureContext,
} from "../../src/storage/browser/browser-output-storage-guard.ts";

test("ensureBrowserStorageAvailableForOutput skips persistence when quota can fit the output", async () => {
  const storage = {
    estimate: vi.fn(async () => ({ quota: 2048, usage: 256 })),
    persist: vi.fn(async () => true),
    persisted: vi.fn(async () => false),
  };

  await expect(
    ensureBrowserStorageAvailableForOutput({
      operationLabel: "extract `game.bin`",
      requiredBytes: 512,
      storage,
    }),
  ).resolves.toBeUndefined();

  expect(storage.persist).not.toHaveBeenCalled();
});

test("ensureBrowserStorageAvailableForOutput retries after requesting persistent storage", async () => {
  const estimate = vi
    .fn()
    .mockResolvedValueOnce({ quota: 1024, usage: 900 })
    .mockResolvedValueOnce({ quota: 4096, usage: 900 });
  const storage = {
    estimate,
    persist: vi.fn(async () => true),
    persisted: vi.fn(async () => false),
  };

  await expect(
    ensureBrowserStorageAvailableForOutput({
      operationLabel: "extract `game.bin`",
      requiredBytes: 2048,
      storage,
    }),
  ).resolves.toBeUndefined();

  expect(storage.persist).toHaveBeenCalledTimes(1);
  expect(estimate).toHaveBeenCalledTimes(2);
});

test("ensureBrowserStorageAvailableForOutput throws a coded error when storage is still too small", async () => {
  const storage = {
    estimate: vi.fn(async () => ({ quota: 1024, usage: 900 })),
    persist: vi.fn(async () => false),
    persisted: vi.fn(async () => false),
  };

  await expect(
    ensureBrowserStorageAvailableForOutput({
      operationLabel: "extract `game.bin`",
      requiredBytes: 2048,
      storage,
    }),
  ).rejects.toMatchObject({
    code: "OUTPUT_WRITE_FAILED",
    details: {
      availableBytes: 124,
      persistenceGranted: false,
      requiredBytes: 2048,
    },
  });
});

test("withBrowserOutputStorageFailureContext annotates output write errors", async () => {
  const storage = {
    estimate: vi.fn(async () => ({ quota: 1024, usage: 900 })),
    persist: vi.fn(async () => false),
    persisted: vi.fn(async () => false),
  };

  const error = await withBrowserOutputStorageFailureContext(
    new Error("OUTPUT_WRITE_FAILED: No space left on device"),
    {
      operationLabel: "extract output",
      storage,
    },
  );

  expect(error).toMatchObject({
    code: "OUTPUT_WRITE_FAILED",
    details: {
      availableBytes: 124,
      operationLabel: "extract output",
    },
  });
  expect(error instanceof Error ? error.message : "").toContain("[storage:");
});

test("withBrowserOutputStorageFailureContext does not duplicate storage context", async () => {
  const original = new Error("OUTPUT_WRITE_FAILED: No space left on device [storage: usage=1 quota=2 available=1]");

  await expect(
    withBrowserOutputStorageFailureContext(original, {
      operationLabel: "extract output",
    }),
  ).resolves.toBe(original);
});
