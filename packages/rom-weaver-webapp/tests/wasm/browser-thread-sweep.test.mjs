import { describe, expect, it } from "vitest";
import { BROWSER_THREAD_SWEEP_COUNTS, runBrowserThreadSweep } from "../../src/wasm/browser-thread-sweep.ts";

const SWEEP_TIMEOUT_MS = 600_000;
// Below the measured floor for `extract` to split work at all - see the second test.
const SUB_PARALLEL_ENTRY_BYTES = 256 * 1024;

describe("browser thread sweep", () => {
  it(
    "scales 1:1 and round trips byte-exactly at every thread count from 1 to 16",
    async () => {
      const summary = await runBrowserThreadSweep({ prefix: "rom-weaver-thread-sweep-test-" });

      expect(BROWSER_THREAD_SWEEP_COUNTS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      expect(summary.failedSteps).toBe(0);
      expect(summary.passedSteps).toBe(BROWSER_THREAD_SWEEP_COUNTS.length);

      for (const command of ["compress", "extract"]) {
        const observed = summary.observations.filter((observation) => observation.command === command);
        expect(observed.map((observation) => observation.threads)).toEqual([...BROWSER_THREAD_SWEEP_COUNTS]);

        // A desktop engine has the cores to honour the request outright, so anything short of it is
        // a thread-plumbing regression rather than a device limit. Compared as paired strings so a
        // failure names the count that stopped scaling.
        expect(
          observed.map((observation) => `${observation.threads}:${observation.effectiveThreads}`),
          `${command} should use every thread it was asked for`,
        ).toEqual(observed.map((observation) => `${observation.threads}:${observation.threads}`));

        for (const observation of observed) {
          expect(observation.requestedThreads).toBe(observation.threads);
          expect(observation.usedParallelism).toBe(observation.threads > 1);
          expect(observation.threadFallback).toBe(false);
        }
      }
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    "keeps extract single-threaded below the per-entry work floor while compress still scales",
    async () => {
      const summary = await runBrowserThreadSweep({
        entryByteLength: SUB_PARALLEL_ENTRY_BYTES,
        prefix: "rom-weaver-thread-sweep-floor-",
        threadCounts: [1, 16],
      });

      expect(summary.failedSteps).toBe(0);
      const byCommand = (command) =>
        summary.observations
          .filter((observation) => observation.command === command)
          .map((observation) => `${observation.threads}:${observation.effectiveThreads}`);

      // Compress sizes its pool to the request whatever the entry size is.
      expect(byCommand("compress")).toEqual(["1:1", "16:16"]);
      // Extract declines to split 256 KiB entries. This is the behaviour the default 1 MiB entry
      // size works around - if extract starts splitting smaller entries, that default can shrink.
      expect(byCommand("extract")).toEqual(["1:1", "16:1"]);
    },
    SWEEP_TIMEOUT_MS,
  );
});
