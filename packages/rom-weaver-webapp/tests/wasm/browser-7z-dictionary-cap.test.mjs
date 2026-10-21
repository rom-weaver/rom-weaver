// A 7z folder may declare a dictionary far larger than its output; 7-Zip writes the preset's size
// whatever the input. Each decoder MUST size its dictionary from the folder's output so such an
// archive extracts within Apple mobile WebKit's 1 GiB shared-memory cap.

import { expect, it } from "vitest";
import { buildLzma2FoldersSevenZip } from "./lzma2-7z-fixture.mjs";
import {
  assertRunJsonSucceeded,
  joinGuestPath,
  readGuestFile,
  withTempFixture,
  writeGuestFile,
} from "./test-helpers.mjs";

const APPLE_MOBILE_MAXIMUM_PAGES = 16_384;
const WASM_PAGE_BYTES = 65_536;
// LZMA2 property 40 declares a 4 GiB - 1 dictionary.
const LARGEST_LZMA2_DICTIONARY_PROP = 40;

it("extracts 7z folders declaring a 4 GiB dictionary within a 1 GiB memory", async () => {
  const files = [0, 1].map((index) => ({
    data: Uint8Array.from({ length: 300_000 + index }, (_, offset) => (offset * 31 + index * 7) % 251),
    name: `payload-${index}.bin`,
  }));

  await withTempFixture(
    async ({ dir, opfsHandle, worker }) => {
      const input = joinGuestPath(dir, "large-dictionary.7z");
      const output = joinGuestPath(dir, "out");
      await writeGuestFile(opfsHandle, input, buildLzma2FoldersSevenZip(files, LARGEST_LZMA2_DICTIONARY_PROP));

      const traceLines = [];
      const result = await worker.runJson(["extract", "--input", input, "--out-dir", output, "--threads", "2"], {
        onTraceNonJsonLine: (line) => traceLines.push(line),
      });
      assertRunJsonSucceeded(result, { command: "extract" });
      for (const { data, name } of files) {
        expect(await readGuestFile(opfsHandle, joinGuestPath(output, name))).toEqual(data);
      }

      const gauge = traceLines.findLast((line) => line.includes("[perf] wasm memory"));
      const matched = /peakBytes=(\d+) maximumBytes=(\d+)/.exec(gauge ?? "");
      expect(matched, `no wasm memory gauge in ${traceLines.length} trace lines`).not.toBeNull();
      expect(Number(matched[2])).toBe(APPLE_MOBILE_MAXIMUM_PAGES * WASM_PAGE_BYTES);
      expect(Number(matched[1])).toBeLessThanOrEqual(Number(matched[2]));
    },
    { initOptions: { sharedMemoryMaximumPages: APPLE_MOBILE_MAXIMUM_PAGES } },
  );
});
