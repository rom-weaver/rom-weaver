import { afterEach, describe, expect, it } from "vitest";
import { configureLogger } from "../../src/lib/logging.ts";
import { reportProgress } from "../../src/lib/progress/progress-reporting.ts";
import type { LogRecord } from "../../src/types/logging.ts";
import type { ProgressEvent } from "../../src/types/workflow-runtime-types.ts";

/**
 * `progress-reporting` keeps a per-`stage:label` dedupe cache so an unchanged progress event is
 * logged once. The cache is bounded (LRU-capped) so a long-lived page emitting an open-ended stream
 * of per-file/per-op labels cannot grow it for the page lifetime.
 */

const captureProgressLogs = (): LogRecord[] => {
  const records: LogRecord[] = [];
  configureLogger({ level: "debug", sink: (record) => records.push(record) });
  return records;
};

const countLogsForLabel = (records: LogRecord[], label: string): number =>
  records.filter((record) => record.message === "Progress" && record.details?.label === label).length;

const progressEvent = (label: string, percent: number | null): ProgressEvent => ({ label, percent, stage: "apply" });

describe("progress-reporting dedupe cache", () => {
  afterEach(() => configureLogger({ level: "warn", sink: null }));

  it("logs an unchanged stage:label:percent event only once", () => {
    const records = captureProgressLogs();
    const label = "dedupe-unchanged-luigi.rvz";
    reportProgress(undefined, progressEvent(label, 10));
    reportProgress(undefined, progressEvent(label, 10));
    expect(countLogsForLabel(records, label)).toBe(1);
  });

  it("re-logs when the percent for a label changes", () => {
    const records = captureProgressLogs();
    const label = "dedupe-changed-mario.chd";
    reportProgress(undefined, progressEvent(label, 10));
    reportProgress(undefined, progressEvent(label, 11));
    expect(countLogsForLabel(records, label)).toBe(2);
  });

  it("evicts old keys so the cache stays bounded, re-logging an evicted key", () => {
    const records = captureProgressLogs();
    const target = "evict-target-zelda.iso";
    // Seen once, then deduped while it is still resident.
    reportProgress(undefined, progressEvent(target, 0));
    reportProgress(undefined, progressEvent(target, 0));
    expect(countLogsForLabel(records, target)).toBe(1);

    // Flood the cache with far more distinct keys than any reasonable cap, evicting the target.
    for (let index = 0; index < 1000; index += 1) {
      reportProgress(undefined, progressEvent(`evict-flood-${index}.bin`, 0));
    }

    // The target was evicted, so the identical event is treated as new and logs again.
    reportProgress(undefined, progressEvent(target, 0));
    expect(countLogsForLabel(records, target)).toBe(2);
  });
});
