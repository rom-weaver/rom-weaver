import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchRemoteFiles, parse } = vi.hoisted(() => ({
  fetchRemoteFiles: vi.fn(),
  parse: vi.fn(),
}));

vi.mock("../../src/lib/remote/remote-file-fetch.ts", () => ({ fetchRemoteFiles }));
vi.mock("../../src/platform/browser/workflow-runtime.ts", () => ({
  browserRuntime: { weave: { parse } },
}));

const { loadWeaveUrlSession } = await import("../../src/webapp/url-session/weave-url-session.ts");

const cleanup = () => vi.fn(async () => undefined);
const remote = (name: string, finalUrl = "https://cdn.example/" + name) => ({
  cleanup: cleanup(),
  file: new File([name], name, { type: "application/octet-stream" }),
  filePath: `/remote/${name}`,
  finalUrl,
});

const parsedResult = (overrides: Record<string, unknown> = {}) => ({
  weave: {
    output: { header: "strip", name: "Example release" },
    patches: [
      { author: "A", id: "p1", name: "Translation", optional: false },
      { id: "p2", label: "optional fix", name: "Fix", optional: true },
    ],
    rom: { checks: { checksums: { crc32: "deadbeef" }, size: 4 }, member: "disc/track01.bin", name: "Example ROM" },
    version: 1,
  },
  patchSources: [
    { source: { kind: "url", url: "patches/translation.ips" } },
    { source: { extractedPath: "patches/fix.ips", kind: "extracted" } },
  ],
  romSource: { kind: "url", url: "roms/example.bin" },
  sourceKind: "archive",
  warnings: ["optional patch has no output check"],
  ...overrides,
});

describe("loadWeaveUrlSession", () => {
  beforeEach(() => {
    fetchRemoteFiles.mockReset();
    parse.mockReset();
  });

  it("parses the weave, acquires URL and extracted sources, and preserves order", async () => {
    const weaveFetch = remote("weave.zip", "https://host.example/releases/weave.zip");
    const romFetch = remote("example.bin");
    const patchFetch = remote("translation.ips");
    const extractedPatch = new File(["fix"], "fix.ips");
    const parsedCleanup = cleanup();
    fetchRemoteFiles
      .mockImplementationOnce(async (entries: Array<{ onProgress?: (value: unknown) => void }>) => {
        entries[0]?.onProgress?.({ loadedBytes: 4, totalBytes: 4 });
        return [weaveFetch];
      })
      .mockImplementationOnce(async (entries: Array<{ url: string; onProgress?: (value: unknown) => void }>) => {
        expect(entries.map((entry) => entry.url)).toEqual([
          "https://host.example/releases/roms/example.bin",
          "https://host.example/releases/patches/translation.ips",
        ]);
        entries[0]?.onProgress?.({ loadedBytes: 4, totalBytes: 4 });
        entries[1]?.onProgress?.({ loadedBytes: 3, totalBytes: null });
        return [romFetch, patchFetch];
      });
    parse.mockResolvedValue({
      cleanup: parsedCleanup,
      extractedFiles: new Map([["patches/fix.ips", extractedPatch]]),
      result: parsedResult(),
    });
    const onWeaveName = vi.fn();
    const onProgress = vi.fn();

    const loaded = await loadWeaveUrlSession("https://host.example/releases/weave.zip", {
      onWeaveName,
      onProgress,
    });

    expect(parse).toHaveBeenCalledWith(expect.objectContaining({ fileName: "weave.zip", source: weaveFetch.file }));
    expect(onWeaveName).toHaveBeenCalledWith("Example release");
    expect(onProgress).toHaveBeenCalledWith("weave", { loadedBytes: 4, totalBytes: 4 });
    expect(onProgress).toHaveBeenCalledWith("rom", { loadedBytes: 4, totalBytes: 4 });
    expect(onProgress).toHaveBeenCalledWith("patch-0", { loadedBytes: 3, totalBytes: null });
    expect(loaded.files.map((file) => file.name)).toEqual(["example.bin", "translation.ips", "fix.ips"]);
    expect(loaded.session).toMatchObject({
      key: "https://host.example/releases/weave.zip",
      name: "Example release",
      outputDefaults: { header: "strip", name: "Example release" },
      romFileName: "example.bin",
      romMember: "disc/track01.bin",
      warnings: ["optional patch has no output check"],
    });
    expect(loaded.session.entries.map((entry) => entry.fileName)).toEqual(["translation.ips", "fix.ips"]);

    await loaded.cleanup();
    await loaded.cleanup();
    expect(parsedCleanup).toHaveBeenCalledOnce();
    expect(weaveFetch.cleanup).toHaveBeenCalledOnce();
    expect(romFetch.cleanup).toHaveBeenCalledOnce();
    expect(patchFetch.cleanup).toHaveBeenCalledOnce();
  });

  it("surfaces a missing extracted patch and cleans every acquired resource", async () => {
    const weaveFetch = remote("weave.json");
    const parsedCleanup = cleanup();
    fetchRemoteFiles.mockResolvedValueOnce([weaveFetch]).mockResolvedValueOnce([]);
    parse.mockResolvedValue({
      cleanup: parsedCleanup,
      extractedFiles: new Map(),
      result: parsedResult({
        patchSources: [
          { source: { extractedPath: "missing.ips", kind: "extracted" } },
          { source: { kind: "url", url: "fix.ips" } },
        ],
        romSource: undefined,
      }),
    });

    await expect(loadWeaveUrlSession("https://host.example/weave.json")).rejects.toThrow(
      "Weave patch 1 was not extracted: missing.ips",
    );
    expect(parsedCleanup).toHaveBeenCalledOnce();
    expect(weaveFetch.cleanup).toHaveBeenCalledOnce();
  });

  it("reports unavailable parsing and releases the weave download", async () => {
    const weaveFetch = remote("weave.json");
    fetchRemoteFiles.mockResolvedValueOnce([weaveFetch]);
    const runtime = await import("../../src/platform/browser/workflow-runtime.ts");
    const originalWeave = runtime.browserRuntime.weave;
    runtime.browserRuntime.weave = undefined;
    try {
      await expect(loadWeaveUrlSession("https://host.example/weave.json")).rejects.toThrow(
        "Weave parsing is not available in this runtime",
      );
      expect(weaveFetch.cleanup).toHaveBeenCalledOnce();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      runtime.browserRuntime.weave = originalWeave;
    }
  });

  it("cleans the fetched weave when parsing throws", async () => {
    const weaveFetch = remote("weave.json");
    fetchRemoteFiles.mockResolvedValueOnce([weaveFetch]);
    parse.mockRejectedValue(new Error("invalid weave"));
    await expect(loadWeaveUrlSession("https://host.example/weave.json")).rejects.toThrow("invalid weave");
    expect(weaveFetch.cleanup).toHaveBeenCalledOnce();
  });
});
