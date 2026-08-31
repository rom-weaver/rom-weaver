import { describe, expect, it } from "vitest";
import { cachedFileBytesLabel, cachedFileTotals, sortCachedFiles } from "../../src/webapp/components/log-dialog.tsx";

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

  it("labels each size cell on its own, with a dash for an unmeasured one", () => {
    expect(cachedFileBytesLabel(localizer, 40)).toBe("40B");
    expect(cachedFileBytesLabel(localizer, 0)).toBe("0B");
    expect(cachedFileBytesLabel(localizer, null)).toBe("—");
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

  it("orders each size column on its own figures", () => {
    // Transferred: a.js 90, b.js 5; c.js has none and sits last either way.
    expect(paths(sortCachedFiles(files, { column: "compressed", direction: "desc" }))).toEqual([
      "/a.js",
      "/b.js",
      "/c.js",
    ]);
    expect(paths(sortCachedFiles(files, { column: "compressed", direction: "asc" }))).toEqual([
      "/b.js",
      "/a.js",
      "/c.js",
    ]);
    // Stored: b.js and c.js tie at 30 and break on the path; a.js has none.
    expect(paths(sortCachedFiles(files, { column: "stored", direction: "desc" }))).toEqual(["/b.js", "/c.js", "/a.js"]);
  });

  it("does not mutate the input", () => {
    const original = [...files];
    sortCachedFiles(files, { column: "compressed", direction: "desc" });
    expect(files).toEqual(original);
  });
});
