import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchRemoteFiles, parse } = vi.hoisted(() => ({
  fetchRemoteFiles: vi.fn(),
  parse: vi.fn(),
}));

vi.mock("../../src/lib/remote/remote-file-fetch.ts", () => ({ fetchRemoteFiles }));
vi.mock("../../src/platform/browser/workflow-runtime.ts", () => ({
  browserRuntime: { bundle: { parse } },
}));

const { loadBundleUrlSession } = await import("../../src/webapp/url-session/bundle-url-session.ts");

const cleanup = () => vi.fn(async () => undefined);
const remote = (name: string, finalUrl = "https://cdn.example/" + name) => ({
  cleanup: cleanup(),
  file: new File([name], name, { type: "application/octet-stream" }),
  filePath: `/remote/${name}`,
  finalUrl,
});

const parsedResult = (overrides: Record<string, unknown> = {}) => ({
  bundle: {
    output: { header: "strip", name: "Example release" },
    patches: [
      { author: "A", id: "p1", name: "Translation", optional: false },
      { id: "p2", label: "optional fix", name: "Fix", optional: true },
    ],
    rom: { checks: { checksums: { crc32: "deadbeef" }, size: 4 }, name: "Example ROM" },
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

describe("loadBundleUrlSession", () => {
  beforeEach(() => {
    fetchRemoteFiles.mockReset();
    parse.mockReset();
  });

  it("parses the bundle, acquires URL and extracted sources, and preserves order", async () => {
    const bundleFetch = remote("bundle.zip", "https://host.example/releases/bundle.zip");
    const romFetch = remote("example.bin");
    const patchFetch = remote("translation.ips");
    const extractedPatch = new File(["fix"], "fix.ips");
    const parsedCleanup = cleanup();
    fetchRemoteFiles
      .mockImplementationOnce(async (entries: Array<{ onProgress?: (value: unknown) => void }>) => {
        entries[0]?.onProgress?.({ loadedBytes: 4, totalBytes: 4 });
        return [bundleFetch];
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
    const onBundleName = vi.fn();
    const onProgress = vi.fn();

    const loaded = await loadBundleUrlSession("https://host.example/releases/bundle.zip", {
      onBundleName,
      onProgress,
    });

    expect(parse).toHaveBeenCalledWith(expect.objectContaining({ fileName: "bundle.zip", source: bundleFetch.file }));
    expect(onBundleName).toHaveBeenCalledWith("Example release");
    expect(onProgress).toHaveBeenCalledWith("bundle", { loadedBytes: 4, totalBytes: 4 });
    expect(onProgress).toHaveBeenCalledWith("rom", { loadedBytes: 4, totalBytes: 4 });
    expect(onProgress).toHaveBeenCalledWith("patch-0", { loadedBytes: 3, totalBytes: null });
    expect(loaded.files.map((file) => file.name)).toEqual(["example.bin", "translation.ips", "fix.ips"]);
    expect(loaded.session).toMatchObject({
      key: "https://host.example/releases/bundle.zip",
      name: "Example release",
      outputDefaults: { header: "strip", name: "Example release" },
      romFileName: "example.bin",
      warnings: ["optional patch has no output check"],
    });
    expect(loaded.session.entries.map((entry) => entry.fileName)).toEqual(["translation.ips", "fix.ips"]);

    await loaded.cleanup();
    await loaded.cleanup();
    expect(parsedCleanup).toHaveBeenCalledOnce();
    expect(bundleFetch.cleanup).toHaveBeenCalledOnce();
    expect(romFetch.cleanup).toHaveBeenCalledOnce();
    expect(patchFetch.cleanup).toHaveBeenCalledOnce();
  });

  it("surfaces a missing extracted patch and cleans every acquired resource", async () => {
    const bundleFetch = remote("bundle.json");
    const parsedCleanup = cleanup();
    fetchRemoteFiles.mockResolvedValueOnce([bundleFetch]).mockResolvedValueOnce([]);
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

    await expect(loadBundleUrlSession("https://host.example/bundle.json")).rejects.toThrow(
      "Bundle patch 1 was not extracted: missing.ips",
    );
    expect(parsedCleanup).toHaveBeenCalledOnce();
    expect(bundleFetch.cleanup).toHaveBeenCalledOnce();
  });

  it("reports unavailable parsing and releases the bundle download", async () => {
    const bundleFetch = remote("bundle.json");
    fetchRemoteFiles.mockResolvedValueOnce([bundleFetch]);
    const runtime = await import("../../src/platform/browser/workflow-runtime.ts");
    const originalBundle = runtime.browserRuntime.bundle;
    runtime.browserRuntime.bundle = undefined;
    try {
      await expect(loadBundleUrlSession("https://host.example/bundle.json")).rejects.toThrow(
        "Bundle parsing is not available in this runtime",
      );
      expect(bundleFetch.cleanup).toHaveBeenCalledOnce();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      runtime.browserRuntime.bundle = originalBundle;
    }
  });

  it("cleans the fetched bundle when parsing throws", async () => {
    const bundleFetch = remote("bundle.json");
    fetchRemoteFiles.mockResolvedValueOnce([bundleFetch]);
    parse.mockRejectedValue(new Error("invalid bundle"));
    await expect(loadBundleUrlSession("https://host.example/bundle.json")).rejects.toThrow("invalid bundle");
    expect(bundleFetch.cleanup).toHaveBeenCalledOnce();
  });
});
