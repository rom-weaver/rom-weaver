import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { boundIdentifyWait } from "../../src/platform/browser/bounded-identify-wait.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test("passes through a result and a rejection that arrive within the bound", async () => {
  await expect(boundIdentifyWait(Promise.resolve(1), "x", () => 2, 100)).resolves.toBe(1);
  await expect(boundIdentifyWait(Promise.reject(new Error("boom")), "x", () => 2, 100)).rejects.toThrow("boom");
});

test("resolves the fallback with the reason on timeout and swallows a late rejection", async () => {
  let rejectWork: (error: Error) => void = () => undefined;
  const work = new Promise<number>((_resolve, reject) => {
    rejectWork = reject;
  });
  const waited = boundIdentifyWait(work, "pack", (reason) => reason, 100);
  await vi.advanceTimersByTimeAsync(100);
  await expect(waited).resolves.toBe("pack did not finish within 100 ms");
  rejectWork(new Error("late"));
  await vi.advanceTimersByTimeAsync(1);
});

test("a late success after the timeout does not change the outcome", async () => {
  let resolveWork: (value: number) => void = () => undefined;
  const work = new Promise<number>((resolve) => {
    resolveWork = resolve;
  });
  const waited = boundIdentifyWait(work, "pack", () => -1, 100);
  await vi.advanceTimersByTimeAsync(100);
  resolveWork(5);
  await expect(waited).resolves.toBe(-1);
});
