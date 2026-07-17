import { expect, test } from "vitest";
import { formatBytes } from "../../src/presentation/formatting/index.ts";
import { createOutputSizeSummary, formatByteSize } from "../../src/presentation/workflow-presentation.ts";
import {
  formatBrowserStorageEstimateState,
  formatByteCount,
} from "../../src/storage/browser/browser-storage-estimate.ts";

test("human byte display uses standard byte units", () => {
  expect(formatBytes(999, "en")).toBe("999 B");
  expect(formatBytes(1000, "en")).toBe("1.0 KB");
  expect(formatBytes(1_500_000, "en")).toBe("1.5 MB");
  expect(formatBytes(1_558_821_365, "en")).toBe("1.56 GB");
  expect(formatBytes(2_500_000_000, "en")).toBe("2.5 GB");
  expect(formatBytes(3_500_000_000_000, "en")).toBe("3.5 TB");

  expect(formatByteSize(1000)).toBe("1.0 KB");
  expect(formatByteSize(12_345_678)).toBe("12.35 MB");
  expect(createOutputSizeSummary({ inputBytes: 4096, outputBytes: 8192 }).inputLabel).toBe("4.1 KB");
});

test("browser storage estimates use standard byte units", () => {
  expect(formatByteCount(999)).toBe("999 B");
  expect(formatByteCount(1000)).toBe("1.00 KB");
  expect(formatByteCount(12_345)).toBe("12.3 KB");
  expect(formatByteCount(12_345_678)).toBe("12.3 MB");
  expect(
    formatBrowserStorageEstimateState({
      availableBytes: 1_500_000,
      persisted: true,
      quotaBytes: 2_000_000,
      usageBytes: 500_000,
    }),
  ).toBe("persisted=true usage=500.0 KB quota=2.00 MB available=1.50 MB");
});
