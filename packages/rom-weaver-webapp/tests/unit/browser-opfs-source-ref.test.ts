import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  appleWebKit: false,
  desktopSafari: false,
  registrations: [] as Array<{ path: string; source: unknown; useProxyHandle?: boolean }>,
  unregisters: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock("../../src/lib/logging.ts", () => ({ emitTraceLog: vi.fn() }));
vi.mock("../../src/platform/shared/webkit-runtime.ts", () => ({
  isAppleMobileWebKit: () => state.appleWebKit,
  isWebKitDesktopSafari: () => state.desktopSafari,
}));
vi.mock("../../src/storage/browser/browser-source-primitives.ts", () => ({
  getBrowserSourceBlob: (source: unknown) => {
    if (source && typeof source === "object" && "blob" in source) return (source as { blob: Blob }).blob;
    return typeof Blob !== "undefined" && source instanceof Blob ? source : null;
  },
  getBrowserSourceHandle: (source: unknown) =>
    source && typeof source === "object" && "handle" in source ? (source as { handle: unknown }).handle : null,
}));
vi.mock("../../src/workers/protocol/browser-virtual-files.ts", () => ({
  registerBrowserVirtualFile: vi.fn((entry: { path: string; source: unknown; useProxyHandle?: boolean }) => {
    state.registrations.push(entry);
    const unregister = vi.fn(() => undefined);
    state.unregisters.push(unregister);
    return unregister;
  }),
}));
vi.mock("../../src/workers/protocol/opfs-path.ts", () => ({
  getManagedOpfsFileHandle: vi.fn(async () => ({ getFile: async () => ({ size: 321 }) })),
}));

const { createBrowserOpfsSourceRef, getStagedInputMs } =
  await import("../../src/workers/protocol/browser-opfs-source-ref.ts");

const options = (overrides: Record<string, unknown> = {}) => ({
  mountPoint: "/work/",
  pathPrefix: "session/input",
  ...overrides,
});

beforeEach(() => {
  state.appleWebKit = false;
  state.desktopSafari = false;
  state.registrations.length = 0;
  state.unregisters.length = 0;
  vi.stubGlobal("navigator", { maxTouchPoints: 0, platform: "Linux", userAgent: "Chrome" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser OPFS source references", () => {
  it("uses an existing OPFS path, records staging time, and consumes it once", async () => {
    const ref = await createBrowserOpfsSourceRef(
      { fileName: "game.bin", filePath: "/work/game.bin" },
      "fallback.bin",
      options(),
    );
    expect(ref).toMatchObject({ fileName: "game.bin", filePath: "/work/game.bin", size: 321, storageKind: "opfs" });
    expect(getStagedInputMs(["/work/game.bin", "/work/missing"])).toBe(0);
    expect(getStagedInputMs(["/work/game.bin"])).toBeUndefined();
    await ref.cleanup();
    expect(state.registrations).toEqual([]);
  });

  it("registers a normalized virtual File and releases its visible path on cleanup", async () => {
    const file = new File(["bytes"], "../bad:name?.bin", { type: "application/octet-stream", lastModified: 17 });
    const ref = await createBrowserOpfsSourceRef(file, "fallback.bin", options({ pathPrefixInPath: true }));
    expect(ref).toMatchObject({ fileName: "bad_name_.bin", virtual: true, size: 5 });
    expect(ref.filePath).toMatch(/\/work\/session_input\/bad_name_.bin$/u);
    expect(state.registrations[0]).toMatchObject({ path: ref.filePath, useProxyHandle: false });
    await ref.cleanup();
    expect(state.unregisters[0]).toHaveBeenCalledTimes(1);

    const reused = await createBrowserOpfsSourceRef(file, "fallback.bin", options({ pathPrefixInPath: true }));
    expect(reused.filePath).toBe(ref.filePath);
    await reused.cleanup();
  });

  it("supports Blob and FileSystemFileHandle sources and preserves inferred names", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "application/octet-stream" });
    const blobRef = await createBrowserOpfsSourceRef({ blob, name: "blob.dat" }, "fallback.bin", options());
    expect(blobRef).toMatchObject({ fileName: "blob.dat", size: 3, virtual: true });
    await blobRef.cleanup();

    const handleFile = new File(["handle"], "handle.rom");
    const handleRef = await createBrowserOpfsSourceRef(
      { handle: { getFile: async () => handleFile }, fileName: "ignored.rom" },
      "fallback.bin",
      options(),
    );
    expect(handleRef).toMatchObject({ fileName: "ignored.rom", size: 6, virtual: true });
    await handleRef.cleanup();
  });

  it("uses the proxy handle for large WebKit inputs but not small inputs", async () => {
    state.appleWebKit = true;
    vi.stubGlobal("navigator", { maxTouchPoints: 5, platform: "iPhone", userAgent: "Mozilla/5.0 Safari" });
    const large = new File([new Uint8Array(64 * 1024 * 1024)], "large.iso");
    const largeRef = await createBrowserOpfsSourceRef(large, "fallback.bin", options());
    expect(state.registrations.at(-1)).toMatchObject({ useProxyHandle: true });
    await largeRef.cleanup();

    const small = new File([new Uint8Array([1])], "small.bin");
    const smallRef = await createBrowserOpfsSourceRef(small, "fallback.bin", options());
    expect(state.registrations.at(-1)).toMatchObject({ useProxyHandle: false });
    await smallRef.cleanup();
  });

  it("supports desktop Safari detection, unique collision names, and unsupported input errors", async () => {
    state.desktopSafari = true;
    const first = await createBrowserOpfsSourceRef(new File(["one"], "same.bin"), "fallback.bin", options());
    const second = await createBrowserOpfsSourceRef(new File(["two"], "same.bin"), "fallback.bin", options());
    expect(second.filePath).not.toBe(first.filePath);
    expect(second.filePath).toMatch(/same-2\.bin$/u);
    await first.cleanup();
    await second.cleanup();

    await expect(createBrowserOpfsSourceRef({ nope: true }, "fallback.bin", options())).rejects.toThrow(
      "Browser worker inputs must be File, Blob, FileSystemFileHandle, or OPFS path values",
    );
  });

  it("reclaims an allocated name if virtual-file registration fails", async () => {
    const virtualFiles = await import("../../src/workers/protocol/browser-virtual-files.ts");
    vi.mocked(virtualFiles.registerBrowserVirtualFile).mockImplementationOnce(() => {
      throw new Error("registry full");
    });
    const file = new File(["data"], "recover.bin");
    await expect(createBrowserOpfsSourceRef(file, "fallback.bin", options())).rejects.toThrow("registry full");
    await expect(createBrowserOpfsSourceRef(file, "fallback.bin", options())).resolves.toMatchObject({
      filePath: expect.stringMatching(/recover\.bin$/u),
    });
  });
});
