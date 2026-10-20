import { afterEach, expect, test } from "vitest";
import { identifyRom } from "../../src/platform/browser/browser-api.ts";
import { resetRomWeaverRunner } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";

/* Every identify run holds its own runner (a worker plus a WASM heap). Before the scheduler capped
   concurrent runners, a drop of 14 or more files started one runner per file at once and the page
   died ("Browser connection was closed"); 13 files still passed. */
const FILE_COUNT = 20;

afterEach(async () => {
  await resetRomWeaverRunner();
});

test("identifies a large simultaneous drop without exhausting the page", async () => {
  const files = Array.from({ length: FILE_COUNT }, (_, index) => {
    const bytes = new Uint8Array(4096 + index).fill(index + 1);
    return new File([bytes], `rom-${index}.gba`);
  });

  const results = await Promise.all(files.map((file) => identifyRom(file, file.name)));

  expect(results).toHaveLength(FILE_COUNT);
  for (const result of results) expect(result.candidates[0]?.checksums.crc32).toMatch(/^[0-9a-f]{8}$/);
}, 120_000);
