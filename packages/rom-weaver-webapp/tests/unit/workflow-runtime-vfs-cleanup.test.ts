import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const vfs = {
    read: vi.fn(async (_path: string, buffer: Uint8Array) => {
      buffer.set(new TextEncoder().encode("cue"));
      return 3;
    }),
    stat: vi.fn(async () => ({ size: 3 })),
    truncate: vi.fn(async () => undefined),
    write: vi.fn(async () => 3),
  };
  return { vfs };
});

vi.mock("../../src/lib/path-utils.ts", () => ({
  getPathBaseName: (path: string, fallback = "") =>
    String(path || fallback)
      .split(/[\\/]/u)
      .pop() || fallback,
}));
vi.mock("../../src/storage/browser/browser-large-file-vfs.ts", () => ({
  createBrowserLargeFileVfs: () => state.vfs,
}));
vi.mock("../../src/workers/shared/worker-storage/storage-layout.ts", () => ({ WORKER_OPFS_MOUNTPOINT: "/work" }));
vi.mock("../../src/platform/browser/workflow-runtime-helpers.ts", () => ({
  emitBrowserWorkflowTrace: vi.fn(),
  findExtractedFile: (entries: Array<{ fileName: string; path: string }>, name: string) =>
    entries.find((entry) => entry.fileName === name || entry.path.endsWith(`/${name}`)) || null,
  joinPath: (...parts: string[]) => parts.join("/").replace(/\/+/gu, "/"),
  normalizeEntryPath: (path: string) => path.replace(/\\/gu, "/"),
}));

const {
  browserVfs,
  filterOutputCandidatesAwayFromSource,
  getBrowserExtractOutputPathCandidates,
  readTextFromBrowserVfs,
  selectPreferredExtractedFile,
  sumBrowserVfsPathBytes,
  waitForBrowserVfsPath,
  writeTextToBrowserVfs,
} = await import("../../src/platform/browser/workflow-runtime-vfs-cleanup.ts");

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.vfs.stat.mockResolvedValue({ size: 3 });
  state.vfs.read.mockImplementation(async (_path: string, buffer: Uint8Array) => {
    buffer.set(new TextEncoder().encode("cue"));
    return 3;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("browser workflow VFS cleanup helpers", () => {
  it("waits for a staged path and handles blank or missing paths", async () => {
    await expect(waitForBrowserVfsPath("/work/ready.bin")).resolves.toEqual({ size: 3 });
    await expect(waitForBrowserVfsPath("  ")).resolves.toBeNull();
    state.vfs.stat.mockResolvedValue(null);
    const pending = waitForBrowserVfsPath("/work/missing.bin");
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeNull();
  });

  it("selects preferred non-empty files, fills unknown sizes, and deduplicates paths", async () => {
    state.vfs.stat.mockImplementation(async (path: string) => (path.endsWith("empty.bin") ? { size: 0 } : { size: 8 }));
    const emitted = [
      { fileName: "empty.bin", path: "/work/empty.bin" },
      { fileName: "game.bin", path: "/work/game.bin" },
      { fileName: "other.bin", path: "/work/other.bin", sizeBytes: 2 },
    ];
    const selected = await selectPreferredExtractedFile({
      emittedFiles: emitted,
      logLevel: "trace",
      preferredEntryNames: ["empty.bin", "game.bin", "game.bin", "missing.bin"],
      traceLabel: "archive",
    });
    expect(selected).toMatchObject({ fileName: "game.bin", path: "/work/game.bin", sizeBytes: 8 });
  });

  it("returns fallbacks and output candidates while excluding the source", async () => {
    const empty = await selectPreferredExtractedFile({
      emittedFiles: [{ fileName: "empty.bin", path: "/work/empty.bin", sizeBytes: 0 }],
      preferredEntryNames: ["missing.bin"],
      traceLabel: "empty",
    });
    expect(empty?.fileName).toBe("empty.bin");
    expect(filterOutputCandidatesAwayFromSource(["/work/a", "/work/source"], "/work/source")).toEqual(["/work/a"]);
    expect(filterOutputCandidatesAwayFromSource(["/work/a"], "")).toEqual(["/work/a"]);
    expect(getBrowserExtractOutputPathCandidates("/work/out", "folder/game.bin")).toEqual([
      "/work/out/folder/game.bin",
      "/work/out/game.bin",
    ]);
    expect(getBrowserExtractOutputPathCandidates("/work/out", "")).toEqual([]);
  });

  it("reads and writes text through the browser VFS and sums available paths", async () => {
    await expect(readTextFromBrowserVfs("/work/game.cue")).resolves.toBe("cue");
    await writeTextToBrowserVfs("/work/out.cue", 'FILE "track.bin" BINARY');
    expect(state.vfs.truncate).toHaveBeenCalledWith("/work/out.cue", 0);
    expect(state.vfs.write).toHaveBeenCalledWith("/work/out.cue", expect.any(Uint8Array), { fileOffset: 0 });
    state.vfs.stat.mockImplementation(async (path: string) => {
      if (path.endsWith("missing")) throw new Error("gone");
      return path.endsWith("zero") ? { size: -1 } : { size: 4.9 };
    });
    await expect(sumBrowserVfsPathBytes(["/work/a", "/work/missing", "/work/zero"])).resolves.toBe(4);
    expect(browserVfs).toBe(state.vfs);
  });
});
