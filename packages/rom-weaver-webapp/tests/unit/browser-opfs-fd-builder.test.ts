import * as wasiShim from "@bjorn3/browser_wasi_shim";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildBrowserOpfsWasiFds } from "../../src/wasm/browser-opfs-fd-builder.ts";
import { BrowserOpfsMount } from "../../src/wasm/browser-opfs-mount.ts";
import type { OpfsProxyClient } from "../../src/wasm/browser-opfs-proxy-client.ts";
import type { BrowserOpfsMountCache } from "../../src/wasm/browser-opfs-mounts.ts";
import type { FileSystemDirectoryHandleLike, RomWeaverRunInput } from "../../src/wasm/browser-opfs-runtime-types.ts";
import { WasiRandomAccessFileInode } from "../../src/wasm/browser-opfs-wasi-file-inode.ts";

const wasi = wasiShim.wasi;

type PreopenLike = wasiShim.Fd & {
  path_create_directory(pathStr: string): number;
  path_link(pathStr: string, inode: wasiShim.Inode, allowDir: boolean): number;
  path_open(
    dirflags: number,
    pathStr: string,
    oflags: number,
    fsRightsBase: bigint,
    fsRightsInheriting: bigint,
    fdFlags: number,
  ): { fd_obj: wasiShim.Fd | null; ret: number };
  path_remove_directory(pathStr: string): number;
  path_unlink(pathStr: string): { inode_obj: wasiShim.Inode | null; ret: number };
  path_unlink_file(pathStr: string): number;
};

/** Minimal OpfsProxyClient stand-in: an in-memory byte store keyed by handle id. */
function makeProxyClient() {
  const files = new Map<string, Uint8Array>();
  const handles = new Map<number, string>();
  const unlinked: string[] = [];
  let nextHandle = 1;
  let unlinkError: Error | null = null;
  const client = {
    close: vi.fn((handleId: number) => handles.delete(handleId)),
    flush: vi.fn(),
    handleVersion: vi.fn(() => 1),
    open: vi.fn((guestPath: string, options: { create?: boolean } = {}) => {
      if (!files.has(guestPath)) {
        if (!options.create) throw new Error(`missing ${guestPath}`);
        files.set(guestPath, new Uint8Array(0));
      }
      const id = nextHandle;
      nextHandle += 1;
      handles.set(id, guestPath);
      return id;
    }),
    readInto: vi.fn((handleId: number, offset: number, dst: Uint8Array) => {
      const bytes = files.get(handles.get(handleId) ?? "") ?? new Uint8Array(0);
      const length = Math.max(0, Math.min(dst.byteLength, bytes.byteLength - offset));
      if (length <= 0) return 0;
      dst.set(bytes.subarray(offset, offset + length));
      return length;
    }),
    size: vi.fn((handleId: number) => (files.get(handles.get(handleId) ?? "") ?? new Uint8Array(0)).byteLength),
    truncate: vi.fn((handleId: number, size: number) => {
      const path = handles.get(handleId) ?? "";
      const next = new Uint8Array(size);
      next.set((files.get(path) ?? new Uint8Array(0)).subarray(0, size));
      files.set(path, next);
    }),
    unlink: vi.fn((guestPath: string) => {
      if (unlinkError) throw unlinkError;
      unlinked.push(guestPath);
      files.delete(guestPath);
    }),
    write: vi.fn((handleId: number, offset: number, data: Uint8Array) => {
      const path = handles.get(handleId) ?? "";
      const current = files.get(path) ?? new Uint8Array(0);
      const next =
        offset + data.byteLength > current.byteLength ? new Uint8Array(offset + data.byteLength) : current.slice();
      next.set(current.subarray(0, Math.min(current.byteLength, next.byteLength)));
      next.set(data, offset);
      files.set(path, next);
      return data.byteLength;
    }),
  };
  return {
    client: client as unknown as OpfsProxyClient,
    files,
    setUnlinkError(error: Error | null) {
      unlinkError = error;
    },
    unlinked,
  };
}

const directoryHandle = { kind: "directory" } as unknown as FileSystemDirectoryHandleLike;

function makeMount(options: {
  contents?: Map<string, wasiShim.Inode>;
  mountPath?: string;
  proxyClient: OpfsProxyClient;
  writableRoots?: string[];
}) {
  const mountPath = options.mountPath ?? "/work";
  return new BrowserOpfsMount({
    contents: options.contents ?? new Map<string, wasiShim.Inode>(),
    directoryHandle,
    mountPath,
    ownedFiles: [],
    proxyClient: options.proxyClient,
    virtualOnly: false,
    writableRoots: options.writableRoots ?? [mountPath],
  });
}

function makeMountCache(mounts: Record<string, BrowserOpfsMount>, onAcquire?: (mountPath: string) => void) {
  return {
    acquire: vi.fn(async ({ mountPath }: { mountPath: string }) => {
      onAcquire?.(mountPath);
      const mount = mounts[mountPath];
      if (!mount) throw new Error(`no fixture mount for ${mountPath}`);
      return mount;
    }),
    dispose: vi.fn(async () => undefined),
    invalidateMountPaths: vi.fn(async () => undefined),
    invalidateMounts: vi.fn(async () => undefined),
  } as unknown as BrowserOpfsMountCache;
}

const probeRequest: RomWeaverRunInput = { args: {}, type: "probe" };

let proxy: ReturnType<typeof makeProxyClient>;
let trace: string[];

beforeEach(() => {
  proxy = makeProxyClient();
  trace = [];
});

async function build(overrides: Partial<Parameters<typeof buildBrowserOpfsWasiFds>[0]> = {}) {
  const mount = makeMount({ proxyClient: proxy.client });
  return {
    mount,
    result: await buildBrowserOpfsWasiFds({
      cwdMountPath: "/work",
      mountCache: makeMountCache({ "/work": mount }),
      mountHandles: { "/work": directoryHandle },
      proxyClient: proxy.client,
      request: probeRequest,
      runCloseables: [],
      runtimeMounts: ["/work"],
      trace: (line) => trace.push(line),
      writableRoots: ["/work"],
      ...overrides,
    }),
  };
}

describe("buildBrowserOpfsWasiFds", () => {
  it("returns stdio plus one preopen per mount and a cwd preopen", async () => {
    const { result } = await build();

    // stdin, stdout, stderr, /work preopen, "." preopen
    expect(result.fds).toHaveLength(5);
    expect(result.mounts).toHaveLength(1);
    expect(trace.some((line) => line.includes("build fds leave fds=5 mounts=1"))).toBe(true);
  });

  it("omits the cwd preopen when no mount matches the guest cwd", async () => {
    const { result } = await build({ cwdMountPath: "/other" });
    expect(result.fds).toHaveLength(4);
  });

  it("feeds the request to the guest through the stdin fd", async () => {
    const { result } = await build({ stdin: "hello stdin\n" });

    const stdinFd = result.fds[0] as wasiShim.OpenFile;
    expect(new TextDecoder().decode(stdinFd.fd_read(64).data)).toBe("hello stdin\n");
  });

  it("rejects an unsupported stdin type", async () => {
    await expect(build({ stdin: 42 })).rejects.toThrow("stdin must be a string, Uint8Array, ArrayBuffer, or undefined");
  });

  it("routes guest stdout and stderr through the line collectors", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const { result } = await build({
      stderrLineHandler: (line) => stderr.push(line),
      stdoutLineHandler: (line) => stdout.push(line),
    });

    result.fds[1]?.fd_write(new TextEncoder().encode("out line\n"));
    result.fds[2]?.fd_write(new TextEncoder().encode("err line\n"));

    expect(stdout).toEqual(["out line"]);
    expect(stderr).toEqual(["err line"]);
    expect(result.stdoutChunks).toHaveLength(1);
    expect(result.stderrChunks).toHaveLength(1);
  });

  it("fails with a pointed message when a runtime mount has no directory handle", async () => {
    await expect(build({ mountHandles: {} })).rejects.toThrow("No directory handle provided for runtime mount /work");
    expect(trace.some((line) => line.includes("build fds failed"))).toBe(true);
  });

  it("cleans up the mounts it already acquired when a later one fails", async () => {
    const first = makeMount({ mountPath: "/work", proxyClient: proxy.client });
    const finishRun = vi.spyOn(first, "finishRun");
    const cache = makeMountCache({ "/work": first });

    await expect(
      buildBrowserOpfsWasiFds({
        mountCache: cache,
        mountHandles: { "/cache": directoryHandle, "/work": directoryHandle },
        proxyClient: proxy.client,
        request: probeRequest,
        runCloseables: [],
        runtimeMounts: ["/work", "/cache"],
        trace: (line) => trace.push(line),
        writableRoots: ["/work"],
      }),
    ).rejects.toThrow("no fixture mount for /cache");

    // startRun calls finishRun once; the failure path adds the cleanup call.
    expect(finishRun).toHaveBeenCalledTimes(2);
  });

  it("traces the virtual-only hydration summary", async () => {
    await build({ virtualOnlyMounts: true });

    expect(trace.some((line) => line.includes("sync mounted input paths start for virtual-only mount"))).toBe(true);
    expect(trace.some((line) => line.includes("sync mounted input paths done for virtual-only mount paths=0"))).toBe(
      true,
    );
  });
});

describe("PreparedWasiPreopenDirectory path_open", () => {
  async function preopen(overrides: Partial<Parameters<typeof buildBrowserOpfsWasiFds>[0]> = {}) {
    const { mount, result } = await build(overrides);
    const fd = result.fds[3];
    if (!fd) throw new Error("build must return a mount preopen");
    return { fd: fd as PreopenLike, mount };
  }

  it("rejects an absolute or NUL-bearing path", async () => {
    const { fd } = await preopen();

    expect(fd.path_open(0, "/abs", 0, 0n, 0n, 0)).toEqual({ fd_obj: null, ret: wasi.ERRNO_NOTCAPABLE });
    expect(fd.path_open(0, "a\0b", 0, 0n, 0n, 0)).toEqual({ fd_obj: null, ret: wasi.ERRNO_INVAL });
  });

  it("returns ENOENT for a missing path and caps the miss trace", async () => {
    const { fd } = await preopen();

    expect(fd.path_open(0, "missing.bin", 0, 0n, 0n, 0)).toEqual({ fd_obj: null, ret: wasi.ERRNO_NOENT });
    const misses = () => trace.filter((line) => line.includes("path open missing")).length;
    expect(misses()).toBe(1);

    for (let index = 0; index < 30; index += 1) fd.path_open(0, `missing-${index}.bin`, 0, 0n, 0n, 0);
    expect(misses()).toBe(20);
  });

  it("creates a proxy-backed output file on OFLAGS_CREAT", async () => {
    const { fd, mount } = await preopen();

    const opened = fd.path_open(0, "out.bin", wasi.OFLAGS_CREAT, wasi.RIGHTS_FD_WRITE, 0n, 0);
    expect(opened.ret).toBe(wasi.ERRNO_SUCCESS);
    expect(mount.contents.get("out.bin")).toBeInstanceOf(WasiRandomAccessFileInode);
    expect(mount.ownedFiles).toHaveLength(1);

    // The proxy handle is opened lazily, on the first write.
    expect(proxy.files.has("/work/out.bin")).toBe(false);
    opened.fd_obj?.fd_write(new Uint8Array([1, 2, 3]));
    // The adapter coalesces writes, so the bytes only reach the proxy on fd_sync.
    opened.fd_obj?.fd_sync();
    expect(proxy.files.get("/work/out.bin")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("refuses to create outside the writable roots", async () => {
    const mount = makeMount({ proxyClient: proxy.client, writableRoots: ["/work/out"] });
    const { result } = await build({
      mountCache: makeMountCache({ "/work": mount }),
    });
    const fd = result.fds[3] as PreopenLike;

    expect(fd.path_open(0, "blocked.bin", wasi.OFLAGS_CREAT, 0n, 0n, 0)).toEqual({
      fd_obj: null,
      ret: wasi.ERRNO_ROFS,
    });
  });

  it("reports the create errno when the parent directory is missing", async () => {
    const { fd } = await preopen();

    expect(fd.path_open(0, "nope/out.bin", wasi.OFLAGS_CREAT, 0n, 0n, 0)).toEqual({
      fd_obj: null,
      ret: wasi.ERRNO_NOENT,
    });
    expect(trace.some((line) => line.includes("path create failed"))).toBe(true);
  });

  it("returns EEXIST when OFLAGS_EXCL meets an existing entry", async () => {
    const { fd } = await preopen();
    fd.path_open(0, "out.bin", wasi.OFLAGS_CREAT, wasi.RIGHTS_FD_WRITE, 0n, 0);

    expect(fd.path_open(0, "out.bin", wasi.OFLAGS_CREAT | wasi.OFLAGS_EXCL, 0n, 0n, 0)).toEqual({
      fd_obj: null,
      ret: wasi.ERRNO_EXIST,
    });
  });

  it("returns EPERM for write rights on a read-only path", async () => {
    const contents = new Map<string, wasiShim.Inode>([["rom.bin", new wasiShim.File(new Uint8Array([1]))]]);
    const mount = makeMount({ contents, proxyClient: proxy.client, writableRoots: [] });
    const { result } = await build({ mountCache: makeMountCache({ "/work": mount }) });
    const fd = result.fds[3] as PreopenLike;

    expect(fd.path_open(0, "rom.bin", 0, wasi.RIGHTS_FD_WRITE, 0n, 0)).toEqual({
      fd_obj: null,
      ret: wasi.ERRNO_PERM,
    });
  });

  it("returns ENOTDIR when a directory open lands on a file", async () => {
    const contents = new Map<string, wasiShim.Inode>([["rom.bin", new wasiShim.File(new Uint8Array([1]))]]);
    const mount = makeMount({ contents, proxyClient: proxy.client });
    const { result } = await build({ mountCache: makeMountCache({ "/work": mount }) });
    const fd = result.fds[3] as PreopenLike;

    expect(fd.path_open(0, "rom.bin", wasi.OFLAGS_DIRECTORY, 0n, 0n, 0)).toEqual({
      fd_obj: null,
      ret: wasi.ERRNO_NOTDIR,
    });
  });

  it("traces the errno when the inode itself refuses the open", async () => {
    const contents = new Map<string, wasiShim.Inode>();
    const mount = makeMount({ contents, proxyClient: proxy.client });
    contents.set(
      "ro.bin",
      new WasiRandomAccessFileInode(
        {
          flush: () => undefined,
          readAt: () => 0,
          size: () => 0,
          truncate: () => undefined,
          writeAt: () => 0,
        },
        { readonly: true },
      ),
    );
    const { result } = await build({ mountCache: makeMountCache({ "/work": mount }) });
    const fd = result.fds[3] as PreopenLike;

    expect(fd.path_open(0, "ro.bin", 0, wasi.RIGHTS_FD_WRITE, 0n, 0).ret).toBe(wasi.ERRNO_PERM);
    expect(trace.some((line) => line.includes("path open failed path=ro.bin"))).toBe(true);
  });
});

describe("PreparedWasiPreopenDirectory namespace operations", () => {
  async function preopen(mount: BrowserOpfsMount) {
    const { result } = await build({ mountCache: makeMountCache({ "/work": mount }) });
    const fd = result.fds[3];
    if (!fd) throw new Error("build must return a mount preopen");
    return fd as PreopenLike;
  }

  it("creates directories, treats an existing one as success and refuses read-only roots", async () => {
    const mount = makeMount({ proxyClient: proxy.client });
    const fd = await preopen(mount);

    expect(fd.path_create_directory("nested")).toBe(wasi.ERRNO_SUCCESS);
    expect(mount.contents.get("nested")).toBeInstanceOf(wasiShim.Directory);
    expect(fd.path_create_directory("nested")).toBe(wasi.ERRNO_SUCCESS);
    expect(fd.path_create_directory("/abs")).toBe(wasi.ERRNO_NOTCAPABLE);

    const readOnly = makeMount({ proxyClient: proxy.client, writableRoots: [] });
    expect((await preopen(readOnly)).path_create_directory("nested")).toBe(wasi.ERRNO_ROFS);
  });

  it("links an inode into the mount and refuses read-only roots", async () => {
    const mount = makeMount({ proxyClient: proxy.client });
    const fd = await preopen(mount);
    const inode = new wasiShim.File(new Uint8Array([7]));

    expect(fd.path_link("linked.bin", inode, false)).toBe(wasi.ERRNO_SUCCESS);
    expect(mount.contents.get("linked.bin")).toBe(inode);
    expect(fd.path_link("/abs", inode, false)).toBe(wasi.ERRNO_NOTCAPABLE);

    const readOnly = makeMount({ proxyClient: proxy.client, writableRoots: [] });
    expect((await preopen(readOnly)).path_link("linked.bin", inode, false)).toBe(wasi.ERRNO_ROFS);
  });

  it("copies bytes into an existing random-access inode instead of replacing it", async () => {
    const mount = makeMount({ proxyClient: proxy.client });
    const fd = await preopen(mount);
    fd.path_open(0, "out.bin", wasi.OFLAGS_CREAT, wasi.RIGHTS_FD_WRITE, 0n, 0);
    const target = mount.contents.get("out.bin");

    expect(fd.path_link("out.bin", new wasiShim.File(new Uint8Array([1, 2, 3])), false)).toBe(wasi.ERRNO_SUCCESS);
    expect(mount.contents.get("out.bin")).toBe(target);
    expect(proxy.files.get("/work/out.bin")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("copies between two random-access inodes", async () => {
    const mount = makeMount({ proxyClient: proxy.client });
    const fd = await preopen(mount);
    fd.path_open(0, "src.bin", wasi.OFLAGS_CREAT, wasi.RIGHTS_FD_WRITE, 0n, 0);
    fd.path_open(0, "dst.bin", wasi.OFLAGS_CREAT, wasi.RIGHTS_FD_WRITE, 0n, 0);
    proxy.files.set("/work/src.bin", new Uint8Array([4, 5, 6, 7]));

    const source = mount.contents.get("src.bin");
    if (!source) throw new Error("source inode must exist");
    expect(fd.path_link("dst.bin", source, false)).toBe(wasi.ERRNO_SUCCESS);
    expect(proxy.files.get("/work/dst.bin")).toEqual(new Uint8Array([4, 5, 6, 7]));
  });

  it("replaces an existing inode when the source carries no bytes to copy", async () => {
    const mount = makeMount({ proxyClient: proxy.client });
    const fd = await preopen(mount);
    fd.path_open(0, "out.bin", wasi.OFLAGS_CREAT, wasi.RIGHTS_FD_WRITE, 0n, 0);
    const replacement = new wasiShim.Directory(new Map());

    expect(fd.path_link("out.bin", replacement, true)).toBe(wasi.ERRNO_SUCCESS);
    expect(mount.contents.get("out.bin")).toBe(replacement);
  });

  it("unlinks a file from both the inode tree and OPFS", async () => {
    const mount = makeMount({ proxyClient: proxy.client });
    const fd = await preopen(mount);
    fd.path_open(0, "out.bin", wasi.OFLAGS_CREAT, wasi.RIGHTS_FD_WRITE, 0n, 0);

    expect(fd.path_unlink_file("out.bin")).toBe(wasi.ERRNO_SUCCESS);
    expect(mount.contents.has("out.bin")).toBe(false);
    expect(proxy.unlinked).toEqual(["/work/out.bin"]);
  });

  it("survives a proxy unlink failure", async () => {
    const mount = makeMount({ proxyClient: proxy.client });
    const fd = await preopen(mount);
    fd.path_open(0, "out.bin", wasi.OFLAGS_CREAT, wasi.RIGHTS_FD_WRITE, 0n, 0);
    proxy.setUnlinkError(new Error("already gone"));

    expect(fd.path_unlink("out.bin").ret).toBe(wasi.ERRNO_SUCCESS);
    expect(mount.contents.has("out.bin")).toBe(false);
  });

  it("reports the right errno for unlink edge cases", async () => {
    const mount = makeMount({ proxyClient: proxy.client });
    const fd = await preopen(mount);
    fd.path_create_directory("dir");

    expect(fd.path_unlink_file("/abs")).toBe(wasi.ERRNO_NOTCAPABLE);
    expect(fd.path_unlink_file("gone.bin")).toBe(wasi.ERRNO_NOENT);
    expect(fd.path_unlink_file("dir")).toBe(wasi.ERRNO_ISDIR);
    expect(fd.path_unlink("/abs")).toEqual({ inode_obj: null, ret: wasi.ERRNO_NOTCAPABLE });

    const readOnly = makeMount({ proxyClient: proxy.client, writableRoots: [] });
    expect((await preopen(readOnly)).path_unlink("x.bin")).toEqual({ inode_obj: null, ret: wasi.ERRNO_ROFS });
  });

  it("removes only empty directories", async () => {
    const mount = makeMount({ proxyClient: proxy.client });
    const fd = await preopen(mount);
    fd.path_create_directory("empty");
    fd.path_create_directory("full");
    fd.path_open(0, "full/out.bin", wasi.OFLAGS_CREAT, wasi.RIGHTS_FD_WRITE, 0n, 0);

    expect(fd.path_remove_directory("/abs")).toBe(wasi.ERRNO_NOTCAPABLE);
    expect(fd.path_remove_directory("missing")).toBe(wasi.ERRNO_NOTDIR);
    expect(fd.path_remove_directory("full")).toBe(wasi.ERRNO_NOTEMPTY);
    expect(fd.path_remove_directory("empty")).toBe(wasi.ERRNO_SUCCESS);
    expect(mount.contents.has("empty")).toBe(false);
  });
});
