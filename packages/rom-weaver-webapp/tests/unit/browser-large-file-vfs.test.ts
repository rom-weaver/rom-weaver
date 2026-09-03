import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  downloadCalls: [] as Array<{ fileName: string; interactive: boolean; size: number }>,
  files: new Map<string, Uint8Array>(),
  requests: [] as Array<Record<string, unknown>>,
  writeFileCalls: [] as Array<{ fileName?: string; size: number }>,
}));

vi.mock("../../src/platform/browser/browser-download.ts", () => ({
  triggerBrowserDownload: vi.fn(async (blob: Blob, fileName: string, options: { interactive?: boolean }) => {
    state.downloadCalls.push({ fileName, interactive: options.interactive === true, size: blob.size });
  }),
}));
vi.mock("../../src/workers/protocol/browser-opfs-worker-client.ts", () => ({
  requestBrowserOpfsStorage: vi.fn(async (request: Record<string, unknown>) => {
    state.requests.push(request);
    const path = String(request.filePath || "");
    if (request.action === "truncate") {
      const size = Number(request.size) || 0;
      const next = new Uint8Array(Math.max(0, size));
      next.set(state.files.get(path)?.subarray(0, next.byteLength) || []);
      state.files.set(path, next);
    }
    if (request.action === "write") {
      const bytes = request.bytes as Uint8Array;
      const position = Number(request.position) || 0;
      const current = state.files.get(path) || new Uint8Array(0);
      const next = new Uint8Array(Math.max(current.byteLength, position + bytes.byteLength));
      next.set(current);
      next.set(bytes, position);
      state.files.set(path, next);
    }
    return { success: true };
  }),
}));
vi.mock("../../src/storage/browser/file-handle-write.ts", () => ({
  writeBlobToFileHandle: vi.fn(
    async (
      handle: { createWritable: () => Promise<{ write: (blob: Blob) => Promise<void>; close: () => Promise<void> }> },
      file: File,
    ) => {
      state.writeFileCalls.push({ fileName: file.name, size: file.size });
      const writable = await handle.createWritable();
      await writable.write(file);
      await writable.close();
    },
  ),
}));

const { createBrowserLargeFileVfs } = await import("../../src/storage/browser/browser-large-file-vfs.ts");

class FakeDirectory {
  readonly directories = new Map<string, FakeDirectory>();
  readonly files = new Map<string, FakeFileHandle>();

  constructor(readonly path = "/work") {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (options?.create) {
      const created = new FakeDirectory(`${this.path}/${name}`);
      this.directories.set(name, created);
      return created;
    }
    throw new DOMException("missing", "NotFoundError");
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (options?.create) {
      const created = new FakeFileHandle(name, this.path);
      this.files.set(name, created);
      return created;
    }
    throw new DOMException("missing", "NotFoundError");
  }

  async removeEntry(name: string) {
    if (!(this.files.delete(name) || this.directories.delete(name))) throw new DOMException("missing", "NotFoundError");
  }
}

class FakeFileHandle {
  constructor(
    readonly name: string,
    readonly parentPath = "/work",
  ) {}
  async getFile() {
    const bytes = state.files.get(this.path) || new Uint8Array(0);
    return new File([bytes], this.name, { type: "application/octet-stream" });
  }
  get path() {
    return `${this.parentPath}/${this.name}`;
  }
  async createWritable() {
    return {
      close: async () => undefined,
      write: async (file: Blob) => {
        state.files.set(this.path, new Uint8Array(await file.arrayBuffer()));
      },
    };
  }
}

let root: FakeDirectory;
let vfs: ReturnType<typeof createBrowserLargeFileVfs>;

const ensureFile = async (path: string) => {
  const segments = path.slice("/work/".length).split("/");
  const fileName = segments.pop();
  if (!fileName) throw new Error(`Invalid test file path: ${path}`);
  let directory = root;
  for (const segment of segments) directory = await directory.getDirectoryHandle(segment, { create: true });
  return directory.getFileHandle(fileName, { create: true });
};

beforeEach(() => {
  vi.useFakeTimers();
  state.downloadCalls.length = 0;
  state.files.clear();
  state.requests.length = 0;
  state.writeFileCalls.length = 0;
  root = new FakeDirectory();
  vfs = createBrowserLargeFileVfs({
    navigatorObject: { storage: { getDirectory: async () => root } },
    rootPath: "/work",
  });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("browser large-file VFS paths and protocol", () => {
  it("normalizes paths, writes and truncates through the OPFS worker, then reads bytes", async () => {
    expect(vfs.normalizePath("/work/relative.bin")).toBe("/work/relative.bin");
    await vfs.truncate("/work/nested/data.bin", 3);
    const input = new Uint8Array([1, 2, 3]);
    expect(await vfs.write("/work/nested/data.bin", input, { fileOffset: 2 })).toBe(3);
    input[0] = 9;
    expect(state.requests.map((request) => request.action)).toEqual(["truncate", "write"]);
    expect(state.requests[1]?.position).toBe(2);

    await ensureFile("/work/nested/data.bin");
    state.files.set("/work/nested/data.bin", new Uint8Array([0, 0, 1, 2, 3]));
    const destination = new Uint8Array(5);
    expect(await vfs.read("/work/nested/data.bin", destination)).toBe(5);
    expect(destination).toEqual(new Uint8Array([0, 0, 1, 2, 3]));
  });

  it("returns zero for empty or missing reads and reports stats and files", async () => {
    expect(await vfs.read("/work/missing.bin", new Uint8Array(3))).toBe(0);
    expect(await vfs.read("/work/missing.bin", new Uint8Array(0))).toBe(0);
    expect(await vfs.stat("/work/missing.bin")).toBeNull();
    expect(await vfs.getFile?.("/work/missing.bin")).toBeNull();

    await ensureFile("/work/game.bin");
    state.files.set("/work/game.bin", new Uint8Array([4, 5]));
    const stat = await vfs.stat("/work/game.bin");
    expect(stat).toEqual({ path: "/work/game.bin", size: 2 });
    expect((await vfs.getFile?.("/work/game.bin"))?.size).toBe(2);
  });

  it("clamps read ranges and invalidates cached snapshots after remove and writes", async () => {
    await ensureFile("/work/cache.bin");
    state.files.set("/work/cache.bin", new Uint8Array([1, 2, 3, 4]));
    const first = new Uint8Array(3);
    expect(await vfs.read("/work/cache.bin", first, { bufferOffset: 1, fileOffset: 1, length: 20 })).toBe(2);
    expect(first).toEqual(new Uint8Array([0, 2, 3]));

    state.files.set("/work/cache.bin", new Uint8Array([9, 8, 7, 6]));
    const cached = new Uint8Array(1);
    await vfs.read("/work/cache.bin", cached, { fileOffset: 0 });
    expect(cached[0]).toBe(1);
    await vfs.remove("/work/cache.bin");
    await ensureFile("/work/cache.bin");
    state.files.set("/work/cache.bin", new Uint8Array([9, 8, 7, 6]));
    const refreshed = new Uint8Array(1);
    await vfs.read("/work/cache.bin", refreshed);
    expect(refreshed[0]).toBe(9);
  });

  it("returns explicit protocol errors from truncate and write", async () => {
    const storage = await import("../../src/workers/protocol/browser-opfs-worker-client.ts");
    vi.mocked(storage.requestBrowserOpfsStorage)
      .mockResolvedValueOnce({ error: { message: "quota" }, success: false })
      .mockResolvedValueOnce({ success: false });
    await expect(vfs.truncate("/work/bad.bin", 1)).rejects.toThrow("quota");
    await expect(vfs.write("/work/bad.bin", new Uint8Array([1]))).rejects.toThrow(
      "Browser VFS write failed: /work/bad.bin",
    );
  });

  it("removes a busy file after retry delays and ignores a missing parent", async () => {
    const directory = await root.getDirectoryHandle("busy", { create: true });
    const file = await directory.getFileHandle("file.bin", { create: true });
    state.files.set(file.path, new Uint8Array([1]));
    let attempts = 0;
    directory.removeEntry = async () => {
      attempts += 1;
      if (attempts < 3) throw new DOMException("busy", "NoModificationAllowedError");
      directory.files.delete("file.bin");
    };
    const promise = vfs.remove("/work/busy/file.bin");
    await vi.runAllTimersAsync();
    await promise;
    expect(attempts).toBe(3);
    await expect(vfs.remove("/work/gone/file.bin")).resolves.toBeUndefined();
  });
});

describe("browser large-file VFS outputs", () => {
  it("creates output refs, prepares downloads, and saves to a picked file handle", async () => {
    await ensureFile("/work/output.bin");
    state.files.set("/work/output.bin", new Uint8Array([1, 2, 3]));
    const output = await vfs.createOutputRef("/work/output.bin", "saved.bin", {
      size: 3,
      mediaType: "application/test",
    });
    expect(output).toMatchObject({ fileName: "saved.bin", path: "/work/output.bin", size: 3, timing: undefined });
    await output.prepareDownload?.();
    const picked = {
      async createWritable() {
        return {
          close: async () => undefined,
          write: async () => undefined,
        };
      },
    };
    await output.saveAs(picked);
    expect(state.writeFileCalls).toEqual([{ fileName: "output.bin", size: 3 }]);
  });

  it("uses the download path when no handle is supplied and honors interactive names", async () => {
    await ensureFile("/work/output.bin");
    state.files.set("/work/output.bin", new Uint8Array([1, 2]));
    const output = await vfs.createOutputRef("/work/output.bin", "default.bin");
    await output.saveAs({ interactive: true, fileName: "download.bin" });
    expect(state.downloadCalls).toEqual([{ fileName: "download.bin", interactive: true, size: 2 }]);
    await vfs.saveAs("/work/output.bin", { interactive: false }, "fallback.bin");
    expect(state.downloadCalls.at(-1)).toMatchObject({ fileName: "fallback.bin", interactive: false });
  });

  it("waits for a delayed output handle and rejects when the OPFS root is unavailable", async () => {
    let visible = false;
    const delayedRoot = new FakeDirectory();
    delayedRoot.getFileHandle = async (name: string, options?: { create?: boolean }) => {
      if (!(visible || options?.create)) throw new DOMException("missing", "NotFoundError");
      return FakeDirectory.prototype.getFileHandle.call(delayedRoot, name, { create: visible || options?.create });
    };
    const delayed = createBrowserLargeFileVfs({
      navigatorObject: { storage: { getDirectory: async () => delayedRoot } },
      rootPath: "/work",
    });
    const pending = delayed.createOutputRef("/work/late.bin", "late.bin", { size: 0 });
    visible = true;
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ fileName: "late.bin" });

    const unavailable = createBrowserLargeFileVfs({ navigatorObject: null, rootPath: "/work" });
    await expect(unavailable.stat("/work/x.bin")).rejects.toThrow("Browser OPFS is not available");
  });
});
