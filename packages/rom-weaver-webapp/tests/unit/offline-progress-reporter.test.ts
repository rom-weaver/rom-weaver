import { describe, expect, it, vi } from "vitest";
import { createOfflineProgressReporter } from "../../src/webapp/pwa/offline-progress-reporter.ts";

const state = (cachedBytes: number, totalBytes = 1000) => ({
  cachedBytes,
  totalBytes,
  cachedFiles: cachedBytes,
  totalFiles: 1000,
  pendingUnits: 1,
  ready: false,
  transferredBytes: 0,
  transferBytesIncomplete: false,
});

describe("offline progress reporter", () => {
  it("reports percentage changes without waiting and suppresses unchanged percentages", async () => {
    let bytes = 30;
    const report = vi.fn();
    const reporter = createOfflineProgressReporter(async () => state(bytes), report, vi.fn());
    await reporter.update();
    bytes = 39;
    await reporter.update();
    bytes = 40;
    await reporter.update();
    bytes = 50;
    await reporter.update();
    expect(report.mock.calls.map(([progress]) => progress.cachedBytes)).toEqual([30, 40, 50]);
  });

  it("coalesces chunks while a read is pending and flushes the latest state", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let bytes = 30;
    const read = vi.fn(async () => {
      await gate;
      return state(bytes);
    });
    const report = vi.fn();
    const reporter = createOfflineProgressReporter(read, report, vi.fn());
    void reporter.update();
    for (bytes = 31; bytes <= 60; bytes += 1) void reporter.update();
    expect(read).toHaveBeenCalledTimes(1);
    release();
    await reporter.flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(state(61));
  });

  it("uses file percentages when byte totals are unavailable", async () => {
    let files = 30;
    const report = vi.fn();
    const reporter = createOfflineProgressReporter(async () => state(files, 0), report, vi.fn());
    await reporter.update();
    files = 39;
    await reporter.update();
    files = 40;
    await reporter.update();
    expect(report.mock.calls.map(([progress]) => progress.cachedFiles)).toEqual([30, 40]);
  });

  it("always delivers a forced phase completion with an unchanged percentage", async () => {
    const report = vi.fn();
    const reporter = createOfflineProgressReporter(async () => state(40), report, vi.fn());
    await reporter.update();
    await reporter.update(true);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("reports a failed read and allows later progress", async () => {
    const error = new Error("cache unavailable");
    const read = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(state(40));
    const report = vi.fn();
    const onError = vi.fn();
    const reporter = createOfflineProgressReporter(read, report, onError);
    await reporter.update();
    expect(onError).toHaveBeenCalledWith(error);
    await reporter.update();
    expect(report).toHaveBeenCalledWith(state(40));
  });
});
