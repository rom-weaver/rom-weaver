import { describe, expect, it, vi } from "vitest";

const trace = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/logging.ts", () => ({ emitTraceLog: trace }));
vi.mock("../../src/lib/path-utils.ts", () => ({
  getFileNameWithoutExtension: (name: string) => name.replace(/\.[^.]+$/u, ""),
  getPathBaseName: (path: string, fallback = "") =>
    String(path || fallback)
      .split(/[\\/]/u)
      .pop() || fallback,
  isCompressionLevelProfile: (value: string) => ["fast", "balanced", "maximum"].includes(value),
  joinPath: (...parts: string[]) => parts.join("/").replace(/\/+/gu, "/"),
}));

const {
  getActiveBrowserVirtualFiles,
  getBrowserVirtualFileSource,
  registerBrowserVirtualFile,
  updateBrowserVirtualFileSource,
} = await import("../../src/workers/protocol/browser-virtual-files.ts");
const {
  emitBrowserWorkflowTrace,
  findExtractedFile,
  getFileStem,
  getPathDerivedFileName,
  getPathDirectory,
  isCueEntryName,
  joinPath,
  normalizeEntryPath,
  normalizeRomSpecificEntryNameForSource,
  replaceProgressSourceLabel,
  toLevelProfile,
  uniqueNonEmptyStrings,
  withCodecLevel,
} = await import("../../src/platform/browser/workflow-runtime-helpers.ts");

describe("browser virtual file registry", () => {
  it("registers source metadata, updates it, and removes only the original registration", () => {
    const source = new Uint8Array([1, 2, 3]);
    const release = registerBrowserVirtualFile({ path: "/work/game.bin", source, useProxyHandle: true });
    expect(getBrowserVirtualFileSource("/work/game.bin")).toBe(source);
    expect(getActiveBrowserVirtualFiles()).toEqual([{ path: "/work/game.bin", source, useProxyHandle: true }]);
    const replacement = new Blob(["new"]);
    expect(updateBrowserVirtualFileSource("/work/game.bin", replacement)).toBe(true);
    expect(getBrowserVirtualFileSource("/work/game.bin")).toBe(replacement);
    const replacementRelease = registerBrowserVirtualFile({ path: "/work/game.bin", source: "invalid" as never });
    release();
    expect(getBrowserVirtualFileSource("/work/game.bin")).toBe("invalid");
    replacementRelease();
    expect(getBrowserVirtualFileSource("/work/game.bin")).toBeUndefined();
    expect(updateBrowserVirtualFileSource("/work/missing.bin", source)).toBe(false);
  });

  it("reports source kinds and sizes for direct and proxy registrations", () => {
    const onLog = vi.fn();
    const traceContext = { logLevel: "trace", onLog };
    const file = new File(["file"], "game.bin");
    const entries = [
      { path: "/work/file", source: file },
      { path: "/work/blob", source: new Blob(["blob"]) },
      { path: "/work/array", source: new Uint8Array([1, 2]) },
      { path: "/work/buffer", source: new ArrayBuffer(4), useProxyHandle: true },
    ];
    const releases = entries.map((entry) => registerBrowserVirtualFile({ ...entry, trace: traceContext }));
    expect(getActiveBrowserVirtualFiles()).toHaveLength(4);
    expect(trace).toHaveBeenCalledTimes(8);
    for (const release of releases) release();
    expect(getActiveBrowserVirtualFiles()).toEqual([]);
  });
});

describe("browser workflow runtime helpers", () => {
  it("normalizes names, paths, levels, and codec options", () => {
    expect(getFileStem("folder/game.bin")).toBe("folder/game");
    expect(getPathDirectory("/work/folder/game.bin")).toBe("/work/folder/");
    expect(getPathDerivedFileName("/work/game.bin", "fallback.bin")).toBe("game.bin");
    expect(isCueEntryName("folder/GAME.CUE")).toBe(true);
    expect(isCueEntryName("game.bin")).toBe(false);
    expect(normalizeEntryPath("\\folder\\game.bin")).toBe("folder/game.bin");
    expect(joinPath("/work/", "/folder", "game.bin")).toBe("/work/folder/game.bin");
    expect(uniqueNonEmptyStrings([" a ", "", "a", "b"])).toEqual(["a", "b"]);
    expect(toLevelProfile(" FAST ")).toBe("fast");
    expect(toLevelProfile("unknown")).toBeNull();
    expect(toLevelProfile(4)).toBeNull();
    expect(withCodecLevel("lzma", " 3 ")).toEqual(["lzma:3"]);
    expect(withCodecLevel("lzma:9", 2)).toEqual(["lzma:9"]);
    expect(withCodecLevel("", 2)).toEqual([]);
    expect(normalizeRomSpecificEntryNameForSource("staged.track.bin", "staged.cue", "game.chd")).toBe("game.track.bin");
  });

  it("finds emitted files by each supported path or name form", () => {
    const entries = [
      { fileName: "exact.bin", path: "/work/other.bin" },
      { fileName: "folder/base.bin", path: "/work/other.bin" },
      { fileName: "other.bin", path: "/work/by-name.bin" },
      { fileName: "nested.bin", path: "/work/folder/path.bin" },
    ];
    expect(findExtractedFile(entries, "exact.bin")).toBe(entries[0]);
    expect(findExtractedFile(entries, "base.bin")).toBe(entries[1]);
    expect(findExtractedFile(entries, "by-name.bin")).toBe(entries[2]);
    expect(findExtractedFile(entries, "path.bin")).toBe(entries[3]);
    expect(findExtractedFile(entries, "missing.bin")).toBeNull();
  });

  it("rewrites progress labels and emits trace records only at trace level", () => {
    const progress = replaceProgressSourceLabel(
      { label: "/work/source.bin is reading", message: "source.bin done", value: 1 },
      "/work/source.bin",
      "display.bin",
    );
    expect(progress).toEqual({ label: "display.bin is reading", message: "display.bin done", value: 1 });
    const unchanged = replaceProgressSourceLabel({ label: "waiting" }, "/work/source.bin", "");
    expect(unchanged).toEqual({ label: "waiting" });
    emitBrowserWorkflowTrace({ logLevel: "info" }, "ignored");
    emitBrowserWorkflowTrace({ logLevel: "trace" }, "reported", { count: 2 });
    expect(trace).toHaveBeenCalledWith(expect.objectContaining({ namespace: "runtime:browser-workflow" }), "reported", {
      count: 2,
    });
  });
});
