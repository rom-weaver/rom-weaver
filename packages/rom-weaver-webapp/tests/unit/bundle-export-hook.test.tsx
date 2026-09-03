// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBundleExport } from "../../src/public/react/bundle-export.tsx";

const { bundleCreate, compressionCreate, saveAs } = vi.hoisted(() => ({
  bundleCreate: vi.fn(),
  compressionCreate: vi.fn(),
  saveAs: vi.fn(),
}));

vi.mock("../../src/platform/browser/workflow-runtime.ts", () => ({
  browserRuntime: {
    bundle: { create: bundleCreate },
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
  getName: () => "My Bundle",
  getOutputHeader: () => "keep" as const,
  disabledPatchIds: new Set<string>(),
  bundleMetaById: new Map([
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

describe("useBundleExport", () => {
  beforeEach(() => {
    bundleCreate.mockReset();
    compressionCreate.mockReset();
    saveAs.mockReset();
    saveAs.mockResolvedValue(undefined);
    bundleCreate.mockResolvedValue({
      result: { bundleFileName: "my-bundle.7z" },
      bundleOutput: output("my-bundle.7z"),
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("reports missing staged inputs before trying to create a bundle", async () => {
    const { result } = renderHook(() =>
      useBundleExport(
        hookOptions({
          getSessionSources: () => ({ rom: null, patches: [] }),
        }),
      ),
    );

    await act(async () => result.current.runExport());

    expect(result.current.error).toBe("A staged ROM is required to export a bundle");
    expect(bundleCreate).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("builds, downloads, and then invalidates an export when its options change", async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useBundleExport(hookOptions({ onComplete, initialFormat: "7z" })));

    await act(async () => result.current.runExport());

    expect(bundleCreate).toHaveBeenCalledOnce();
    expect(bundleCreate.mock.calls[0]?.[0]).toMatchObject({
      bundleFileName: "My-Bundle.7z",
      noBundleRom: true,
      outputHeader: "keep",
      outputName: "My Bundle",
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
    expect(saveAs).toHaveBeenCalledWith(expect.objectContaining({ fileName: "my-bundle.7z" }));
    expect(onComplete).toHaveBeenCalledWith({ bundleFileName: "my-bundle.7z" });
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
      useBundleExport(
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
    expect(bundleCreate).not.toHaveBeenCalled();
    expect(result.current.progress).toBeNull();
  });

  it("compresses a bundled ROM and disposes the intermediate output", async () => {
    const compressed = output("source.rvz");
    compressionCreate.mockResolvedValue({
      output: { ...compressed, vfs: { normalizePath: (value: string) => value } },
    });
    bundleCreate.mockResolvedValue({ result: { ok: true }, bundleOutput: output("bundle.zip") });
    const { result } = renderHook(() =>
      useBundleExport(
        hookOptions({
          initialBundleRom: true,
          getSessionSources: () => ({ rom: rom({ recommendedFormat: "rvz" }), patches: [patch()] }),
        }),
      ),
    );

    await act(async () => result.current.runExport());

    expect(compressionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "source.iso", format: "rvz", outputName: "source.rvz" }),
    );
    expect(bundleCreate.mock.calls[0]?.[0]).toMatchObject({
      bundleRom: { fileName: "source.rvz" },
    });
    expect(compressed.dispose).toHaveBeenCalledOnce();
    expect(result.current.downloadable).toBe(true);
  });

  it("does not surface an abort as an export error", async () => {
    let release: ((value: unknown) => void) | undefined;
    bundleCreate.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(() => useBundleExport(hookOptions()));

    let running: Promise<void> | undefined;
    await act(async () => {
      running = result.current.runExport();
      await Promise.resolve();
    });
    act(() => result.current.cancelExport());
    release?.({ result: {}, bundleOutput: output("bundle.zip") });
    await act(async () => running);

    expect(result.current.error).toBe("");
    expect(result.current.busy).toBe(false);
    expect(result.current.progress).toBeNull();
  });
});
