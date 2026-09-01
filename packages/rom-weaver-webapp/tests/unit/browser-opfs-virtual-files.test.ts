import * as wasiShim from "@bjorn3/browser_wasi_shim";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserOpfsMount } from "../../src/wasm/browser-opfs-mount.ts";
import type { OpfsProxyClient } from "../../src/wasm/browser-opfs-proxy-client.ts";
import { BrowserProxyRandomAccessFile } from "../../src/wasm/browser-opfs-proxy-file.ts";
import type { FileSystemDirectoryHandleLike, RomWeaverRunInput } from "../../src/wasm/browser-opfs-runtime-types.ts";
import {
  addVirtualFilesToMount,
  type NormalizedVirtualFile,
  normalizeVirtualFiles,
  restoreVirtualFiles,
  syncMountedInputPathsFromOpfs,
} from "../../src/wasm/browser-opfs-virtual-files.ts";
import { WasiRandomAccessFileInode } from "../../src/wasm/browser-opfs-wasi-file-inode.ts";

/** The virtual-Blob adapter constructs one per file; it is a worker-only global in the browser. */
class FakeFileReaderSync {
  readAsArrayBuffer(blob: Blob): ArrayBuffer {
    void blob;
    return new ArrayBuffer(0);
  }
}

const proxyClient = {} as unknown as OpfsProxyClient;
const directoryHandle = { kind: "directory" } as unknown as FileSystemDirectoryHandleLike;

function makeMount(options: { contents?: Map<string, wasiShim.Inode>; mountPath?: string; writableRoots?: string[] }) {
  const mountPath = options.mountPath ?? "/work";
  return new BrowserOpfsMount({
    contents: options.contents ?? new Map<string, wasiShim.Inode>(),
    directoryHandle,
    mountPath,
    ownedFiles: [],
    proxyClient,
    virtualOnly: false,
    writableRoots: options.writableRoots ?? [mountPath],
  });
}

/** OPFS directory stand-in: `files`/`dirs` name what exists at this level. */
function makeDirectory(tree: { dirs?: Record<string, ReturnType<typeof makeDirectory>>; files?: string[] }) {
  const handle = {
    entries: async function* entries() {
      yield* [];
    },
    getDirectoryHandle: async (name: string) => {
      const child = tree.dirs?.[name];
      if (!child) throw new Error(`no directory ${name}`);
      return child;
    },
    getFileHandle: async (name: string) => {
      if (!tree.files?.includes(name)) throw new Error(`no file ${name}`);
      return { name };
    },
    kind: "directory",
  };
  return handle as unknown as FileSystemDirectoryHandleLike;
}

beforeEach(() => {
  vi.stubGlobal("FileReaderSync", FakeFileReaderSync);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizeVirtualFiles", () => {
  it("accepts a missing list and rejects a non-array", () => {
    expect(normalizeVirtualFiles(null)).toEqual([]);
    expect(normalizeVirtualFiles(undefined)).toEqual([]);
    expect(() => normalizeVirtualFiles("nope")).toThrow("virtualFiles must be an array");
  });

  it("reads the source from any of the accepted keys, in precedence order", () => {
    const bytes = new Uint8Array([1]);
    const buffer = new ArrayBuffer(2);
    expect(normalizeVirtualFiles([{ path: "/work/a", source: bytes }])[0]?.source).toBe(bytes);
    expect(normalizeVirtualFiles([{ file: new Blob([bytes]), path: "/work/b" }])[0]?.source).toBeInstanceOf(Blob);
    expect(normalizeVirtualFiles([{ blob: new Blob([bytes]), path: "/work/c" }])[0]?.source).toBeInstanceOf(Blob);
    expect(normalizeVirtualFiles([{ bytes, path: "/work/d" }])[0]?.source).toBe(bytes);
    expect(normalizeVirtualFiles([{ data: buffer, path: "/work/e" }])[0]?.source).toBe(buffer);
    expect(normalizeVirtualFiles([{ bytes: new Uint8Array(1), path: "/work/f", source: bytes }])[0]?.source).toBe(
      bytes,
    );
  });

  it("normalizes the guest path and carries useProxyHandle only for Blob sources", () => {
    const [direct] = normalizeVirtualFiles([{ path: " work/rom.iso/ ", source: new Uint8Array(1) }]);
    expect(direct?.path).toBe("/work/rom.iso");
    expect(direct?.useProxyHandle).toBeUndefined();

    const [proxied] = normalizeVirtualFiles([
      { path: "/work/rom.iso", source: new Blob([new Uint8Array(1)]), useProxyHandle: true },
    ]);
    expect(proxied?.useProxyHandle).toBe(true);
  });

  it("requires FileReaderSync only for a directly-read Blob", () => {
    const entry = { path: "/work/rom.iso", source: new Blob([new Uint8Array(1)]) };
    vi.unstubAllGlobals();

    expect(() => normalizeVirtualFiles([entry])).toThrow(
      "Blob virtual files require FileReaderSync in a dedicated worker",
    );
    expect(normalizeVirtualFiles([{ ...entry, useProxyHandle: true }])[0]?.useProxyHandle).toBe(true);
  });

  it("rejects a non-object entry and an unsupported source", () => {
    expect(() => normalizeVirtualFiles([null])).toThrow("virtualFiles[0] must be an object");
    expect(() => normalizeVirtualFiles([{ path: "/work/a", source: 42 }])).toThrow(
      "virtualFiles[0].source must be a Blob, File, Uint8Array, or ArrayBuffer",
    );
    expect(() => normalizeVirtualFiles([{ path: "/work/a", source: new Uint8Array(1) }, { path: "/work/b" }])).toThrow(
      "virtualFiles[1].source must be a Blob, File, Uint8Array, or ArrayBuffer",
    );
  });
});

describe("addVirtualFilesToMount", () => {
  const entry = (overrides: Partial<NormalizedVirtualFile> = {}): NormalizedVirtualFile => ({
    path: "/work/rom.iso",
    source: new Uint8Array([1, 2, 3]),
    ...overrides,
  });

  it("mounts a direct file as a closeOnLastFdClose inode", () => {
    const contents = new Map<string, wasiShim.Inode>();
    const trace: string[] = [];

    const restores = addVirtualFilesToMount({
      contents,
      mountPath: "/work",
      proxyClient,
      trace: (line) => trace.push(line),
      virtualFiles: [entry()],
    });

    const inode = contents.get("rom.iso");
    expect(inode).toBeInstanceOf(WasiRandomAccessFileInode);
    expect((inode as WasiRandomAccessFileInode).closeOnLastFdClose).toBe(true);
    expect((inode as WasiRandomAccessFileInode).readonly).toBe(true);
    expect(restores).toEqual([{ entries: contents, hadExisting: false, name: "rom.iso", value: null }]);
    expect(trace).toContain("[browser-opfs] virtual file mounted name=rom.iso proxyHandle=false");
  });

  it("mounts a proxy-handle file as a held-open proxy adapter", () => {
    const contents = new Map<string, wasiShim.Inode>();

    addVirtualFilesToMount({
      contents,
      mountPath: "/work",
      proxyClient,
      virtualFiles: [entry({ source: new Blob([new Uint8Array(1)]), useProxyHandle: true })],
    });

    const inode = contents.get("rom.iso") as WasiRandomAccessFileInode;
    expect(inode.file).toBeInstanceOf(BrowserProxyRandomAccessFile);
    expect(inode.closeOnLastFdClose).toBe(false);
  });

  it("creates the intermediate directories a nested path needs", () => {
    const contents = new Map<string, wasiShim.Inode>();

    addVirtualFilesToMount({
      contents,
      mountPath: "/work",
      proxyClient,
      virtualFiles: [entry({ path: "/work/sub/deep/rom.iso" })],
    });

    const sub = contents.get("sub") as wasiShim.Directory;
    const deep = sub.contents.get("deep") as wasiShim.Directory;
    expect(deep.contents.get("rom.iso")).toBeInstanceOf(WasiRandomAccessFileInode);
  });

  it("reuses an existing directory on the path", () => {
    const existing = new wasiShim.Directory(new Map());
    const contents = new Map<string, wasiShim.Inode>([["sub", existing]]);

    addVirtualFilesToMount({
      contents,
      mountPath: "/work",
      proxyClient,
      virtualFiles: [entry({ path: "/work/sub/rom.iso" })],
    });

    expect(existing.contents.has("rom.iso")).toBe(true);
    expect(contents.get("sub")).toBe(existing);
  });

  it("records the entry it displaced so it can be put back", () => {
    const previous = new wasiShim.File(new Uint8Array([9]));
    const contents = new Map<string, wasiShim.Inode>([["rom.iso", previous]]);

    const restores = addVirtualFilesToMount({ contents, mountPath: "/work", proxyClient, virtualFiles: [entry()] });

    expect(restores[0]).toMatchObject({ hadExisting: true, name: "rom.iso", value: previous });
  });

  it("skips a file that is not inside the mount", () => {
    const contents = new Map<string, wasiShim.Inode>();
    const trace: string[] = [];

    const restores = addVirtualFilesToMount({
      contents,
      mountPath: "/work",
      proxyClient,
      trace: (line) => trace.push(line),
      virtualFiles: [entry({ path: "/other/rom.iso" })],
    });

    expect(restores).toEqual([]);
    expect(contents.size).toBe(0);
    expect(trace).toContain("[browser-opfs] virtual file skipped outside mount path=rom.iso mount=/work");
  });

  it("rejects a path that resolves to the mount root", () => {
    expect(() =>
      addVirtualFilesToMount({
        contents: new Map(),
        mountPath: "/work",
        proxyClient,
        virtualFiles: [entry({ path: "/work" })],
      }),
    ).toThrow("virtual file path must be inside a mounted directory");
  });

  it("rejects a parent path that is not a directory", () => {
    const contents = new Map<string, wasiShim.Inode>([["sub", new wasiShim.File(new Uint8Array(1))]]);

    expect(() =>
      addVirtualFilesToMount({
        contents,
        mountPath: "/work",
        proxyClient,
        virtualFiles: [entry({ path: "/work/sub/rom.iso" })],
      }),
    ).toThrow("virtual file parent path is not a directory: sub/rom.iso");
  });

  it("mounts nothing for an empty or missing list", () => {
    const contents = new Map<string, wasiShim.Inode>();
    expect(addVirtualFilesToMount({ contents, mountPath: "/work", proxyClient })).toEqual([]);
    expect(addVirtualFilesToMount({ contents, mountPath: "/work", proxyClient, virtualFiles: [] })).toEqual([]);
  });
});

describe("restoreVirtualFiles", () => {
  it("closes the mounted adapter and puts the previous entry back", () => {
    const previous = new wasiShim.File(new Uint8Array([9]));
    const contents = new Map<string, wasiShim.Inode>([["rom.iso", previous]]);
    const restores = addVirtualFilesToMount({
      contents,
      mountPath: "/work",
      proxyClient,
      virtualFiles: [{ path: "/work/rom.iso", source: new Uint8Array([1]) }],
    });
    const mounted = contents.get("rom.iso") as WasiRandomAccessFileInode;
    const close = vi.spyOn(mounted.file, "close");

    restoreVirtualFiles(restores);

    expect(close).toHaveBeenCalledTimes(1);
    expect(contents.get("rom.iso")).toBe(previous);
  });

  it("removes an entry that did not exist before the run", () => {
    const contents = new Map<string, wasiShim.Inode>();
    const restores = addVirtualFilesToMount({
      contents,
      mountPath: "/work",
      proxyClient,
      virtualFiles: [{ path: "/work/rom.iso", source: new Uint8Array([1]) }],
    });

    restoreVirtualFiles(restores);
    expect(contents.has("rom.iso")).toBe(false);
  });

  it("survives an adapter whose close throws and tolerates a hole in the list", () => {
    const contents = new Map<string, wasiShim.Inode>();
    const restores = addVirtualFilesToMount({
      contents,
      mountPath: "/work",
      proxyClient,
      virtualFiles: [{ path: "/work/rom.iso", source: new Uint8Array([1]) }],
    });
    const mounted = contents.get("rom.iso") as WasiRandomAccessFileInode;
    vi.spyOn(mounted.file, "close").mockImplementation(() => {
      throw new Error("handle already gone");
    });

    restoreVirtualFiles([...restores, undefined as never]);
    expect(contents.has("rom.iso")).toBe(false);
  });

  it("leaves an entry that is no longer the mounted inode alone", () => {
    const contents = new Map<string, wasiShim.Inode>();
    const restores = addVirtualFilesToMount({
      contents,
      mountPath: "/work",
      proxyClient,
      virtualFiles: [{ path: "/work/rom.iso", source: new Uint8Array([1]) }],
    });
    const replacement = new wasiShim.File(new Uint8Array([7]));
    contents.set("rom.iso", replacement);

    restoreVirtualFiles(restores);
    expect(contents.has("rom.iso")).toBe(false);
  });
});

describe("syncMountedInputPathsFromOpfs", () => {
  const probeFor = (input: string): RomWeaverRunInput => ({ args: { input }, type: "probe" });

  it("reports nothing to do when the request names no input paths", async () => {
    const summary = await syncMountedInputPathsFromOpfs({
      mountHandles: {},
      mounts: [],
      request: { args: {}, type: "probe" },
      runtimeMounts: ["/work"],
    });

    expect(summary).toEqual({ hydrated: 0, missing: 0, paths: 0 });
  });

  it("hydrates a top-level input file as a proxy-backed inode", async () => {
    const mount = makeMount({});
    const handle = makeDirectory({ files: ["rom.iso"] });

    const summary = await syncMountedInputPathsFromOpfs({
      mountHandles: { "/work": handle },
      mounts: [mount],
      request: probeFor("/work/rom.iso"),
      runtimeMounts: ["/work"],
    });

    expect(summary).toEqual({ hydrated: 1, missing: 0, paths: 1 });
    const inode = mount.contents.get("rom.iso") as WasiRandomAccessFileInode;
    expect(inode.file).toBeInstanceOf(BrowserProxyRandomAccessFile);
    expect(inode.readonly).toBe(false);
    expect(mount.ownedFiles).toHaveLength(1);
  });

  it("marks a hydrated file read-only when it sits outside the writable roots", async () => {
    const mount = makeMount({ writableRoots: [] });

    await syncMountedInputPathsFromOpfs({
      mountHandles: { "/work": makeDirectory({ files: ["rom.iso"] }) },
      mounts: [mount],
      request: probeFor("/work/rom.iso"),
      runtimeMounts: ["/work"],
    });

    expect((mount.contents.get("rom.iso") as WasiRandomAccessFileInode).readonly).toBe(true);
  });

  it("walks into nested directories, creating the inodes it passes through", async () => {
    const mount = makeMount({});
    const handle = makeDirectory({ dirs: { sub: makeDirectory({ files: ["rom.iso"] }) } });

    const summary = await syncMountedInputPathsFromOpfs({
      mountHandles: { "/work": handle },
      mounts: [mount],
      request: probeFor("/work/sub/rom.iso"),
      runtimeMounts: ["/work"],
    });

    expect(summary.hydrated).toBe(1);
    const sub = mount.contents.get("sub") as wasiShim.Directory;
    expect(sub.contents.get("rom.iso")).toBeInstanceOf(WasiRandomAccessFileInode);
  });

  it("hydrates a directory input as an empty directory inode", async () => {
    const mount = makeMount({});
    const handle = makeDirectory({ dirs: { assets: makeDirectory({}) } });

    const summary = await syncMountedInputPathsFromOpfs({
      mountHandles: { "/work": handle },
      mounts: [mount],
      request: probeFor("/work/assets"),
      runtimeMounts: ["/work"],
    });

    expect(summary.hydrated).toBe(1);
    expect(mount.contents.get("assets")).toBeInstanceOf(wasiShim.Directory);
  });

  it("counts and traces a path OPFS does not have", async () => {
    const mount = makeMount({});
    const trace: string[] = [];

    const summary = await syncMountedInputPathsFromOpfs({
      mountHandles: { "/work": makeDirectory({}) },
      mounts: [mount],
      request: probeFor("/work/gone.iso"),
      runtimeMounts: ["/work"],
      trace: (line) => trace.push(line),
    });

    expect(summary).toEqual({ hydrated: 0, missing: 1, paths: 1 });
    expect(trace).toContain("[browser-opfs] sync mounted input path missing path=gone.iso");
  });

  it("counts a missing intermediate directory as missing", async () => {
    const mount = makeMount({});

    const summary = await syncMountedInputPathsFromOpfs({
      mountHandles: { "/work": makeDirectory({}) },
      mounts: [mount],
      request: probeFor("/work/sub/rom.iso"),
      runtimeMounts: ["/work"],
    });

    expect(summary).toEqual({ hydrated: 0, missing: 1, paths: 1 });
  });

  it("fails the walk when a path segment is already a file inode", async () => {
    const contents = new Map<string, wasiShim.Inode>([["sub", new wasiShim.File(new Uint8Array(1))]]);
    const mount = makeMount({ contents });
    const handle = makeDirectory({ dirs: { sub: makeDirectory({ files: ["rom.iso"] }) } });

    const summary = await syncMountedInputPathsFromOpfs({
      mountHandles: { "/work": handle },
      mounts: [mount],
      request: probeFor("/work/sub/rom.iso"),
      runtimeMounts: ["/work"],
    });

    expect(summary.missing).toBe(1);
  });

  it("treats an already-present entry as hydrated without touching OPFS", async () => {
    const contents = new Map<string, wasiShim.Inode>([["rom.iso", new wasiShim.File(new Uint8Array(1))]]);
    const mount = makeMount({ contents });
    const handle = makeDirectory({});
    const getFileHandle = vi.spyOn(handle, "getFileHandle");

    const summary = await syncMountedInputPathsFromOpfs({
      mountHandles: { "/work": handle },
      mounts: [mount],
      request: probeFor("/work/rom.iso"),
      runtimeMounts: ["/work"],
    });

    expect(summary).toEqual({ hydrated: 0, missing: 0, paths: 1 });
    expect(getFileHandle).not.toHaveBeenCalled();
  });

  it("resolves a bare relative path against the guest cwd mount", async () => {
    const mount = makeMount({});

    const summary = await syncMountedInputPathsFromOpfs({
      cwdMountPath: "/work",
      mountHandles: { "/work": makeDirectory({ files: ["rom.iso"] }) },
      mounts: [mount],
      request: probeFor("rom.iso"),
      runtimeMounts: ["/work"],
    });

    expect(summary.hydrated).toBe(1);
  });

  it("prefers the longest matching mount", async () => {
    const work = makeMount({ mountPath: "/work" });
    const cache = makeMount({ mountPath: "/work/cache" });

    await syncMountedInputPathsFromOpfs({
      mountHandles: {
        "/work": makeDirectory({}),
        "/work/cache": makeDirectory({ files: ["rom.iso"] }),
      },
      mounts: [work, cache],
      request: probeFor("/work/cache/rom.iso"),
      runtimeMounts: ["/work", "/work/cache"],
    });

    expect(cache.contents.has("rom.iso")).toBe(true);
    expect(work.contents.size).toBe(0);
  });

  it("skips a path with no mount, no handle, or no acquired mount", async () => {
    const mount = makeMount({});

    const unmounted = await syncMountedInputPathsFromOpfs({
      mountHandles: { "/work": makeDirectory({ files: ["rom.iso"] }) },
      mounts: [mount],
      request: probeFor("/elsewhere/rom.iso"),
      runtimeMounts: ["/work"],
    });
    expect(unmounted).toEqual({ hydrated: 0, missing: 0, paths: 1 });

    const noHandle = await syncMountedInputPathsFromOpfs({
      mountHandles: {},
      mounts: [mount],
      request: probeFor("/work/rom.iso"),
      runtimeMounts: ["/work"],
    });
    expect(noHandle).toEqual({ hydrated: 0, missing: 0, paths: 1 });

    const noMount = await syncMountedInputPathsFromOpfs({
      mountHandles: { "/work": makeDirectory({ files: ["rom.iso"] }) },
      mounts: [],
      request: probeFor("/work/rom.iso"),
      runtimeMounts: ["/work"],
    });
    expect(noMount).toEqual({ hydrated: 0, missing: 0, paths: 1 });
  });

  it("ignores a path that resolves to the mount root itself", async () => {
    const mount = makeMount({});

    const summary = await syncMountedInputPathsFromOpfs({
      mountHandles: { "/work": makeDirectory({}) },
      mounts: [mount],
      request: probeFor("/work"),
      runtimeMounts: ["/work"],
    });

    expect(summary).toEqual({ hydrated: 0, missing: 0, paths: 1 });
  });

  it("adds the extra known input paths to the ones the request names", async () => {
    const mount = makeMount({});

    const summary = await syncMountedInputPathsFromOpfs({
      knownInputPaths: ["/work/extra.bin"],
      mountHandles: { "/work": makeDirectory({ files: ["rom.iso", "extra.bin"] }) },
      mounts: [mount],
      request: probeFor("/work/rom.iso"),
      runtimeMounts: ["/work"],
    });

    expect(summary).toEqual({ hydrated: 2, missing: 0, paths: 2 });
  });
});
