import { describe, expect, it } from "vitest";
import { cachedFileSizeLabel, cachedFileTotals } from "../../src/webapp/components/log-dialog.tsx";

const localizer = { formatBytes: (bytes: number) => `${bytes}B` } as never;

const file = (overrides: Partial<{ compressedBytes: number | null; sizeBytes: number | null }>) => ({
  cache: "precache",
  compressedBytes: 10,
  sizeBytes: 40,
  url: "https://example.test/assets/app.js",
  ...overrides,
});

describe("cached file sizes", () => {
  it("totals transferred and stored bytes, filling a missing measurement from the other", () => {
    expect(
      cachedFileTotals([
        file({}),
        file({ compressedBytes: null, sizeBytes: 7 }),
        file({ compressedBytes: 3, sizeBytes: null }),
        file({ compressedBytes: null, sizeBytes: null }),
      ]),
    ).toEqual({ compressedBytes: 10 + 7 + 3, sizeBytes: 40 + 7 + 3 });
  });

  it("labels a row with one figure when it is stored unencoded", () => {
    expect(cachedFileSizeLabel(localizer, file({ compressedBytes: 40 }))).toBe("40B");
    expect(cachedFileSizeLabel(localizer, file({ compressedBytes: null }))).toBe("40B");
    expect(cachedFileSizeLabel(localizer, file({}))).toBe("10B / 40B");
    expect(cachedFileSizeLabel(localizer, file({ compressedBytes: null, sizeBytes: null }))).toBe("—");
  });
});
