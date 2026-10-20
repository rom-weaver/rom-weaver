import { afterEach, expect, test } from "vitest";
import { identifyRom } from "../../src/platform/browser/browser-api.ts";
import { resetRomWeaverRunner, resolveMaxConcurrentRunners } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";

const IPHONE = {
  navigator: {
    maxTouchPoints: 5,
    platform: "iPhone",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  },
};
const DESKTOP = {
  navigator: {
    maxTouchPoints: 0,
    platform: "MacIntel",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  },
};

/* Every identify run holds its own runner (a worker plus a WASM heap). Before the scheduler capped
   concurrent runners, a drop of 14 or more files started one runner per file at once and the page
   died ("Browser connection was closed"); 13 files still passed. */
const FILE_COUNT = 20;

afterEach(async () => {
  await resetRomWeaverRunner();
});

/* Mobile WebKit reserves each runner's full shared-memory maximum up front, so a phone's thread
   budget (4-6) still admits too many runners; mobile caps lower than desktop. */
test("caps concurrent runners lower on mobile than on desktop", () => {
  expect(resolveMaxConcurrentRunners(6, IPHONE)).toBe(2);
  expect(resolveMaxConcurrentRunners(16, DESKTOP)).toBe(8);
  expect(resolveMaxConcurrentRunners(4, DESKTOP)).toBe(4);
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
