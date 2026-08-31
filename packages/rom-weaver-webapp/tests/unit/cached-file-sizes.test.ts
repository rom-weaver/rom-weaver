import { describe, expect, it } from "vitest";
import { cachedFileSizeLabel, cachedFileTotals, sortCachedFiles } from "../../src/webapp/components/log-dialog.tsx";

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

describe("cached file sorting", () => {
  const files = [
    { cache: "precache", compressedBytes: 5, sizeBytes: 30, url: "https://example.test/b.js" },
    { cache: "precache", compressedBytes: 90, sizeBytes: null, url: "https://example.test/a.js" },
    { cache: "precache", compressedBytes: null, sizeBytes: 30, url: "https://example.test/c.js" },
  ];
  const paths = (sorted: typeof files) => sorted.map((file) => new URL(file.url).pathname);

  it("orders by path in both directions", () => {
    expect(paths(sortCachedFiles(files, { column: "path", direction: "asc" }))).toEqual(["/a.js", "/b.js", "/c.js"]);
    expect(paths(sortCachedFiles(files, { column: "path", direction: "desc" }))).toEqual(["/c.js", "/b.js", "/a.js"]);
  });

  it("orders by size, breaking ties on the path in a stable way", () => {
    // a.js measures 90 from its transferred size; b.js and c.js tie at 30.
    expect(paths(sortCachedFiles(files, { column: "size", direction: "desc" }))).toEqual(["/a.js", "/b.js", "/c.js"]);
    expect(paths(sortCachedFiles(files, { column: "size", direction: "asc" }))).toEqual(["/b.js", "/c.js", "/a.js"]);
  });

  it("does not mutate the input", () => {
    const original = [...files];
    sortCachedFiles(files, { column: "size", direction: "desc" });
    expect(files).toEqual(original);
  });
});
