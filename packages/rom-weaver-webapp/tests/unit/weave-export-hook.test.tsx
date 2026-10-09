// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWeaveExport } from "../../src/public/react/weave-export.tsx";

const { weaveCreate, compressionCreate, saveAs } = vi.hoisted(() => ({
  weaveCreate: vi.fn(),
  compressionCreate: vi.fn(),
  saveAs: vi.fn(),
}));

vi.mock("../../src/platform/browser/workflow-runtime.ts", () => ({
  browserRuntime: {
    weave: { create: weaveCreate },
    compression: { create: compressionCreate },
    publicOutput: { saveAs },
  },
}));

const output = (fileName: string) => ({
  fileName,
  path: `/output/${fileName}`,
  size: 42,
  vfs: {},
  dispose: vi.fn().mockResolvedValue(undefined),
});

const rom = (overrides: Record<string, unknown> = {}) => ({
  fileName: "source.iso",
  originalSource: { name: "source.iso" },
  source: { name: "source.iso" },
  checksums: { crc32: "1234abcd" },
  size: 2048,
  ...overrides,
});

const patch = (fileName = "update.ips") => ({
  fileName,
  originalSource: { name: fileName },
  source: { name: fileName },
});

const hookOptions = (overrides: Record<string, unknown> = {}) => ({
  getSessionSources: () => ({ rom: rom(), patches: [patch()] }),
  getStackItems: () => [
    {
      fileName: "leaf.ips",
      archiveFileName: "patches.zip",
      headerChoice: "strip",
      validationValues: [],
    },
  ],
  getPatchIds: () => ["patch-1"],
  getName: () => "My Weave",
  getOutputHeader: () => "keep" as const,
  disabledPatchIds: new Set<string>(),
  weaveMetaById: new Map([
    [
      "patch-1",
      {
        id: "patch-1",
        name: "Update",
        version: " 1.2 ",
        author: "Author",
        label: "optional label",
        description: "  A patch  ",
        inputChecks: { checksums: { crc32: "1234abcd" } },
        outputChecks: { checksums: { md5: "0123456789abcdef0123456789abcdef" } },
        basis: "base",
      },
    ],
  ]),
  ready: true,
  ...overrides,
});

describe("useWeaveExport", () => {
  beforeEach(() => {
    weaveCreate.mockReset();
    compressionCreate.mockReset();
    saveAs.mockReset();
    saveAs.mockResolvedValue(undefined);
    weaveCreate.mockResolvedValue({
      result: { weaveFileName: "my-weave.7z" },
      weaveOutput: output("my-weave.7z"),
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("reports missing staged inputs before trying to create a weave", async () => {
    const { result } = renderHook(() =>
      useWeaveExport(
        hookOptions({
          getSessionSources: () => ({ rom: null, patches: [] }),
        }),
      ),
    );

    await act(async () => result.current.runExport());

    expect(result.current.error).toBe("A staged ROM is required to export a weave");
    expect(weaveCreate).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("builds, downloads, and then invalidates an export when its options change", async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useWeaveExport(hookOptions({ onComplete, initialFormat: "7z" })));

    await act(async () => result.current.runExport());

    expect(weaveCreate).toHaveBeenCalledOnce();
    expect(weaveCreate.mock.calls[0]?.[0]).toMatchObject({
      weaveFileName: "My-Weave.7z",
      noWeaveRom: true,
      outputHeader: "keep",
      outputName: "My Weave",
      rom: { fileName: "source.iso" },
      romChecksums: "crc32=1234abcd",
      romSize: 2048,
      patches: [
        {
          fileName: "update.ips",
          id: "patch-1",
          name: "Update",
          version: "1.2",
          author: "Author",
          label: "optional label",
          description: "A patch",
          inputChecks: "crc32=1234abcd",
          outputChecks: "md5=0123456789abcdef0123456789abcdef",
          basis: "base",
        },
      ],
    });
    expect(saveAs).toHaveBeenCalledWith(expect.objectContaining({ fileName: "my-weave.7z" }));
    expect(onComplete).toHaveBeenCalledWith({ weaveFileName: "my-weave.7z" });
    expect(result.current.downloadable).toBe(true);
    expect(result.current.progress).toBeNull();

    await act(async () => result.current.runExport());
    expect(saveAs).toHaveBeenCalledTimes(2);

    act(() => result.current.setFormat("zip"));
    await waitFor(() => expect(result.current.downloadable).toBe(false));
    expect(result.current.format).toBe("zip");
    expect(result.current.error).toBe("");
  });

  it("rejects a checksum that conflicts with checks embedded in a patch", async () => {
    const { result } = renderHook(() =>
      useWeaveExport(
        hookOptions({
          getStackItems: () => [
            {
              fileName: "leaf.ips",
              validationValues: ["in crc32=deadbeef"],
            },
          ],
        }),
      ),
    );

    await act(async () => result.current.runExport());

    expect(result.current.error).toBe("Patch 1 input CRC32 conflicts with the checksum built into the patch");
    expect(weaveCreate).not.toHaveBeenCalled();
    expect(result.current.progress).toBeNull();
  });

  it("compresses a bundled ROM and disposes the intermediate output", async () => {
    const compressed = output("source.rvz");
    compressionCreate.mockResolvedValue({
      output: { ...compressed, vfs: { normalizePath: (value: string) => value } },
    });
    weaveCreate.mockResolvedValue({ result: { ok: true }, weaveOutput: output("weave.zip") });
    const { result } = renderHook(() =>
      useWeaveExport(
        hookOptions({
          initialWeaveRom: true,
          getSessionSources: () => ({ rom: rom({ recommendedFormat: "rvz" }), patches: [patch()] }),
        }),
      ),
    );

    await act(async () => result.current.runExport());

    expect(compressionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "source.iso", format: "rvz", outputName: "source.rvz" }),
    );
    expect(weaveCreate.mock.calls[0]?.[0]).toMatchObject({
      weaveRom: { fileName: "source.rvz" },
    });
    expect(compressed.dispose).toHaveBeenCalledOnce();
    expect(result.current.downloadable).toBe(true);
  });

  it("does not surface an abort as an export error", async () => {
    let release: ((value: unknown) => void) | undefined;
    weaveCreate.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(() => useWeaveExport(hookOptions()));

    let running: Promise<void> | undefined;
    await act(async () => {
      running = result.current.runExport();
      await Promise.resolve();
    });
    act(() => result.current.cancelExport());
    release?.({ result: {}, weaveOutput: output("weave.zip") });
    await act(async () => running);

    expect(result.current.error).toBe("");
    expect(result.current.busy).toBe(false);
    expect(result.current.progress).toBeNull();
  });
});
