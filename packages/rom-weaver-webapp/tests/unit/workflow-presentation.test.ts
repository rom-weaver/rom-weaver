import { describe, expect, it } from "vitest";
import {
  clampProgressPercent,
  createCompressionProgressLabel,
  createProgressEvent,
  createProgressViewModel,
  createProgressViewModelFromEvent,
  formatByteSize,
  formatPercentFixed,
  getProgressEventPercent,
  getProgressEventThreadCount,
  isCompressionWriteTelemetryProgress,
  normalizeProgressDisplayPercent,
} from "../../src/presentation/workflow-presentation.ts";

describe("workflow progress presentation", () => {
  it("normalizes numeric strings and bounds display values", () => {
    expect(normalizeProgressDisplayPercent("42.6%")).toBe(43);
    expect(normalizeProgressDisplayPercent(-3)).toBe(0);
    expect(normalizeProgressDisplayPercent(103)).toBe(100);
    expect(normalizeProgressDisplayPercent("bad")).toBeNull();
    expect(clampProgressPercent("50.25")).toBe(50.25);
    expect(clampProgressPercent(Number.NaN)).toBeNull();
    expect(getProgressEventPercent({ percent: "12.5" })).toBe(12.5);
    expect(getProgressEventPercent([])).toBeNull();
  });

  it("formats byte counts and fixed percentages", () => {
    expect(formatByteSize("1500.9")).toBe("1.5 KB");
    expect(formatByteSize(-1)).toBe("");
    expect(formatByteSize("bad")).toBe("");
    expect(formatPercentFixed("12.345", 2)).toBe("12.35%");
    expect(formatPercentFixed("bad")).toBe("");
  });

  it("builds progress text from explicit timing and thread data", () => {
    expect(
      createProgressViewModel({
        label: "Compressing",
        percent: "33.4",
        separator: " · ",
        stage: "compress",
        threads: "2 workers",
        throughputText: "1 MB/s",
        timing: 1500,
      }),
    ).toMatchObject({
      dedupeKey: "compress:Compressing:30",
      message: "Compressing · 1.50s · 33%",
      percent: 33,
      threadsText: "2 threads",
      throughputText: "1 MB/s",
      timingText: "1.50s",
      visualPercent: 33.4,
    });
    expect(createProgressViewModel({ hasProgress: false, label: "Waiting", timing: {} })).toMatchObject({
      dedupeKey: "progress:Waiting:status",
      message: "Waiting",
      percent: null,
    });
  });

  it("uses nested telemetry for visual progress and throughput", () => {
    expect(
      createProgressViewModelFromEvent({
        details: { elapsed_ms: "1000", loaded: "100", total: "200", visualPercent: "52.5" },
        label: "Writing",
        loaded: null,
      }),
    ).toMatchObject({
      indeterminate: false,
      label: "Writing",
      percent: 53,
      throughputText: "100 B / 200 B · 100 B/s",
      visualPercent: 52.5,
    });
  });

  it("finds thread counts in nested compression and extraction details", () => {
    expect(getProgressEventThreadCount({ details: { compression: { effectiveThreads: "3" } } })).toBe("3");
    expect(getProgressEventThreadCount({ details: { extraction: { effective_threads: 4 } } })).toBe(4);
    expect(getProgressEventThreadCount(null)).toBeNull();
  });

  it("creates serializable progress events", () => {
    expect(
      createProgressEvent({ details: { entry: "game.sfc" }, fallbackLabel: "Working", percent: 25, stage: "read" }),
    ).toEqual({
      details: { entry: "game.sfc" },
      indeterminate: false,
      label: "Working",
      message: "Working 25%",
      percent: 25,
      stage: "read",
      timingText: "",
    });
  });

  it("adds format and thread context without duplicating either", () => {
    expect(createCompressionProgressLabel()).toBe("Compressing to");
    expect(createCompressionProgressLabel({ formatLabel: "zip", label: "Packing...", threads: 4 })).toBe(
      "Packing zip - 4 threads",
    );
    expect(createCompressionProgressLabel({ formatLabel: "zip", label: "Packing ZIP...", threads: 1 })).toBe(
      "Packing ZIP - 1 thread",
    );
    expect(createCompressionProgressLabel({ formatLabel: "archive", label: "Packing archive..." })).toBe(
      "Packing archive",
    );
    expect(createCompressionProgressLabel({ formatLabel: "7z", label: "Packing 8 threads" })).toBe(
      "Packing 8 threads 7z",
    );
  });

  it("identifies write telemetry only when percent is absent", () => {
    expect(isCompressionWriteTelemetryProgress({ details: { compressedBytesWritten: "1024" }, stage: "write" })).toBe(
      true,
    );
    expect(
      isCompressionWriteTelemetryProgress({ details: { compressedBytesWritten: 1024 }, percent: 10, stage: "write" }),
    ).toBe(false);
    expect(isCompressionWriteTelemetryProgress("write")).toBe(false);
  });
});
