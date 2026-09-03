import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ browserRuntime: { bundle: { parse: vi.fn() } } }));
const remote = vi.hoisted(() => ({ fetchRemoteFiles: vi.fn() }));
vi.mock("../../src/platform/browser/workflow-runtime.ts", () => runtime);
vi.mock("../../src/lib/remote/remote-file-fetch.ts", () => remote);

import { loadLocalBundleSession } from "../../src/lib/bundle/local-bundle-session.ts";

const makeFile = (name: string, contents = "bytes") => new File([contents], name);
const bundleFile = makeFile("rom-weaver-bundle.json", "{}");

beforeEach(() => {
  runtime.browserRuntime.bundle.parse ||= vi.fn();
  runtime.browserRuntime.bundle.parse.mockReset();
  remote.fetchRemoteFiles.mockReset();
});

describe("loadLocalBundleSession acquisition", () => {
  it("loads extracted ROM and patch files, maps declared metadata, and cleans all acquisitions", async () => {
    const rom = makeFile("game.bin");
    const patch = makeFile("fix.ips");
    const parseCleanup = vi.fn(async () => undefined);
    runtime.browserRuntime.bundle.parse.mockResolvedValue({
      cleanup: parseCleanup,
      extractedFiles: new Map([
        ["/work/game.bin", rom],
        ["/work/fix.ips", patch],
      ]),
      result: {
        bundle: {
          output: { header: "strip", name: "Patched Game", checks: { size: 12 } },
          patches: [
            {
              author: "Author",
              basis: "base",
              description: "A fix",
              header: "keep",
              id: "fix-id",
              inputChecks: { checksums: { crc32: "a" } },
              label: "1.0",
              name: "Fix",
              optional: true,
              outputChecks: { checksums: { crc32: "b" } },
              version: "1.0.0",
            },
          ],
          rom: { checks: { checksums: { crc32: "rom" }, size: 10 }, name: "Expected.bin" },
          version: 1,
        },
        patchSources: [
          {
            descriptor: { format: "ips", inputChecks: { checksums: { crc32: "a" } } },
            source: { extractedPath: "/work/fix.ips", kind: "extracted" },
          },
        ],
        romSource: { extractedPath: "/work/game.bin", kind: "extracted" },
        warnings: ["manifest warning"],
      },
    });

    const loaded = await loadLocalBundleSession(bundleFile, [rom, patch]);
    expect(loaded.romFile).toBe(rom);
    expect(loaded.patchFiles).toEqual([patch]);
    expect(loaded.session).toMatchObject({
      chainEndpointChecks: { input: { checksums: { crc32: "a" } }, output: { checksums: { crc32: "b" } } },
      entries: [
        {
          acquisition: { extractedPath: "fix.ips", kind: "extracted" },
          author: "Author",
          basis: "base",
          description: "A fix",
          fileName: "fix.ips",
          header: "keep",
          inputChecks: { checksums: { crc32: "a" } },
          label: "1.0",
          name: "Fix",
          optional: true,
          outputChecks: { checksums: { crc32: "b" } },
          version: "1.0.0",
        },
      ],
      name: "Patched Game",
      outputDefaults: { header: "strip", name: "Patched Game" },
      romFileName: "game.bin",
      warnings: ["manifest warning"],
    });
    expect((patch as File & { __nestedParentCompressions?: unknown[] }).__nestedParentCompressions).toEqual([
      expect.objectContaining({ fileName: bundleFile.name, kind: "archive" }),
    ]);
    await loaded.cleanup();
    await loaded.cleanup();
    expect(parseCleanup).toHaveBeenCalledTimes(1);
  });

  it("resolves path sources by exact relative path and by unique basename", async () => {
    const rom = makeFile("roms/game.bin");
    const patch = makeFile("fix.ips");
    runtime.browserRuntime.bundle.parse.mockResolvedValue({
      cleanup: vi.fn(async () => undefined),
      extractedFiles: new Map(),
      result: {
        bundle: { patches: [{ name: "Fix" }, { name: "Fix 2" }], rom: { name: "game.bin" }, version: 1 },
        patchSources: [
          { source: { kind: "path", path: "fix.ips" } },
          { source: { kind: "path", path: "roms/game.bin" } },
        ],
        romSource: { kind: "path", path: "roms/game.bin" },
        warnings: [],
      },
    });
    const loaded = await loadLocalBundleSession(bundleFile, [rom, patch]);
    expect(loaded.romFile).toBe(rom);
    expect(loaded.patchFiles).toEqual([patch, rom]);
    expect(loaded.session.entries.map((entry) => entry.fileName)).toEqual(["fix.ips", "roms/game.bin"]);
  });

  it("fetches URL sources and releases remote files when the session is cleaned", async () => {
    const remoteRom = makeFile("remote.bin");
    const remotePatch = makeFile("remote.ips");
    const romCleanup = vi.fn(async () => undefined);
    const patchCleanup = vi.fn(async () => undefined);
    remote.fetchRemoteFiles
      .mockResolvedValueOnce([{ cleanup: romCleanup, file: remoteRom }])
      .mockResolvedValueOnce([{ cleanup: patchCleanup, file: remotePatch }])
      .mockResolvedValueOnce([{ cleanup: patchCleanup, file: remotePatch }]);
    runtime.browserRuntime.bundle.parse.mockResolvedValue({
      cleanup: vi.fn(async () => undefined),
      extractedFiles: new Map(),
      result: {
        bundle: { patches: [{}, {}], version: 1 },
        patchSources: [
          { source: { kind: "url", url: "https://cdn.example/remote.ips" } },
          { source: { kind: "url", url: "https://cdn.example/second.ips" } },
        ],
        romSource: { kind: "url", url: "https://cdn.example/remote.bin" },
        warnings: [],
      },
    });
    const loaded = await loadLocalBundleSession(bundleFile, []);
    expect(remote.fetchRemoteFiles).toHaveBeenCalledTimes(3);
    expect(remote.fetchRemoteFiles).toHaveBeenNthCalledWith(
      1,
      [{ url: "https://cdn.example/remote.bin" }],
      expect.any(AbortSignal),
    );
    expect(loaded.patchFiles).toEqual([remotePatch, remotePatch]);
    await loaded.cleanup();
    expect(romCleanup).toHaveBeenCalledTimes(1);
    expect(patchCleanup).toHaveBeenCalledTimes(2);
  });
});

describe("loadLocalBundleSession errors and probes", () => {
  it("returns null for a parse failure in probe mode but surfaces it in authoritative mode", async () => {
    const failure = new Error("not a bundle");
    runtime.browserRuntime.bundle.parse.mockRejectedValue(failure);
    await expect(loadLocalBundleSession(makeFile("maybe.json"), [], { probe: true })).resolves.toBeNull();
    await expect(loadLocalBundleSession(bundleFile, [])).rejects.toBe(failure);
  });

  it("does not swallow an aborted probe and rejects when parsing is unavailable", async () => {
    const signalController = new AbortController();
    signalController.abort();
    runtime.browserRuntime.bundle.parse.mockRejectedValue(new Error("aborted parse"));
    await expect(
      loadLocalBundleSession(makeFile("maybe.json"), [], { probe: true, signal: signalController.signal }),
    ).rejects.toThrow("aborted parse");
    runtime.browserRuntime.bundle.parse = undefined;
    await expect(loadLocalBundleSession(bundleFile, [])).rejects.toThrow(
      "Bundle parsing is not available in this runtime",
    );
  });

  it("cleans parsed resources when a bundle member is missing", async () => {
    const cleanup = vi.fn(async () => undefined);
    runtime.browserRuntime.bundle.parse.mockResolvedValue({
      cleanup,
      extractedFiles: new Map(),
      result: {
        bundle: { patches: [{}], version: 1 },
        patchSources: [{ source: { kind: "extracted", extractedPath: "/work/missing.ips" } }],
        warnings: [],
      },
    });
    await expect(loadLocalBundleSession(bundleFile, [])).rejects.toThrow("Bundle patch 1 was not extracted");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("reports ambiguous exact and basename paths", async () => {
    const first = makeFile("fix.ips");
    const second = makeFile("fix.ips");
    runtime.browserRuntime.bundle.parse.mockResolvedValue({
      cleanup: vi.fn(async () => undefined),
      extractedFiles: new Map(),
      result: {
        bundle: { patches: [{}], version: 1 },
        patchSources: [{ source: { kind: "path", path: "fix.ips" } }],
        warnings: [],
      },
    });
    await expect(loadLocalBundleSession(bundleFile, [first, second])).rejects.toThrow("path is ambiguous");
  });
});
