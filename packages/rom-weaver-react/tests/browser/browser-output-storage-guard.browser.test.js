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
  expect(storage.estimate).not.toHaveBeenCalled();
});

test("ensureBrowserStorageAvailableForOutput ignores quota estimates when storage is too small", async () => {
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

  expect(storage.persist).not.toHaveBeenCalled();
  expect(estimate).not.toHaveBeenCalled();
});

test("ensureBrowserStorageAvailableForOutput is a no-op when required bytes are missing", async () => {
  const storage = {
    estimate: vi.fn(async () => ({ quota: 1024, usage: 900 })),
    persist: vi.fn(async () => false),
    persisted: vi.fn(async () => false),
  };

  await expect(
    ensureBrowserStorageAvailableForOutput({
      operationLabel: "extract `game.bin`",
      storage,
    }),
  ).resolves.toBeUndefined();

  expect(storage.persist).not.toHaveBeenCalled();
  expect(storage.estimate).not.toHaveBeenCalled();
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
      operationLabel: "extract output",
    },
  });
  expect(error instanceof Error ? error.message : "").toContain("No space left on device");
});

test("withBrowserOutputStorageFailureContext does not duplicate storage context", async () => {
  const original = new Error("OUTPUT_WRITE_FAILED: No space left on device [storage: usage=1 quota=2 available=1]");

  await expect(
    withBrowserOutputStorageFailureContext(original, {
      operationLabel: "extract output",
    }),
  ).resolves.toBe(original);
});
