import { describe, expect, it } from "vitest";
import { getManagedOpfsFileHandle, removeManagedOpfsPath } from "../../src/workers/protocol/opfs-path.ts";

type FakeFileHandle = { kind: "file"; name: string };

const notFoundError = () => {
  const error = new Error("entry not found");
  error.name = "NotFoundError";
  return error;
};

class FakeDirectoryHandle {
  readonly kind = "directory";
  readonly directories = new Map<string, FakeDirectoryHandle>();
  readonly files = new Map<string, FakeFileHandle>();
  readonly directoryCalls: Array<{ create: boolean; name: string }> = [];
  readonly fileCalls: Array<{ create: boolean; name: string }> = [];
  readonly removeCalls: Array<{ name: string; recursive: boolean | undefined }> = [];
  fileError: Error | undefined;
  removeError: Error | undefined;

  getDirectoryHandle(name: string, options: { create?: boolean } = {}) {
    this.directoryCalls.push({ create: options.create === true, name });
    const existing = this.directories.get(name);
    if (existing) return Promise.resolve(existing);
    if (!options.create) return Promise.reject(notFoundError());
    const directory = new FakeDirectoryHandle();
    this.directories.set(name, directory);
    return Promise.resolve(directory);
  }

  getFileHandle(name: string, options: { create?: boolean } = {}) {
    this.fileCalls.push({ create: options.create === true, name });
    if (this.fileError) return Promise.reject(this.fileError);
    const existing = this.files.get(name);
    if (existing) return Promise.resolve(existing);
    if (!options.create) return Promise.reject(notFoundError());
    const file = { kind: "file" as const, name };
    this.files.set(name, file);
    return Promise.resolve(file);
  }

  removeEntry(name: string, options: { recursive?: boolean } = {}) {
    this.removeCalls.push({ name, recursive: options.recursive });
    if (this.removeError) return Promise.reject(this.removeError);
    if (this.files.delete(name) || this.directories.delete(name)) return Promise.resolve();
    return Promise.reject(notFoundError());
  }
}

class FakeStorage {
  getDirectoryCalls = 0;
  private readonly roots: Array<FakeDirectoryHandle | Error>;

  constructor(...roots: Array<FakeDirectoryHandle | Error>) {
    this.roots = roots;
  }

  getDirectory() {
    this.getDirectoryCalls += 1;
    const next = this.roots.length > 1 ? this.roots.shift() : this.roots[0];
    if (next instanceof Error) return Promise.reject(next);
    if (!next) return Promise.reject(new Error("fake storage has no root"));
    return Promise.resolve(next);
  }
}

const navigatorFor = (storage: FakeStorage) => ({ storage }) as never;

describe("managed OPFS path resolution", () => {
  it("reuses the storage root and parent directory caches", async () => {
    const root = new FakeDirectoryHandle();
    const storage = new FakeStorage(root);
    const navigatorObject = navigatorFor(storage);
    const filePath = "/guest/cache-parent/file.bin";

    const first = await getManagedOpfsFileHandle(filePath, { create: true, navigatorObject });
    const second = await getManagedOpfsFileHandle(filePath, { create: false, navigatorObject });

    expect(first?.name).toBe("file.bin");
    expect(second).toBe(first);
    expect(storage.getDirectoryCalls).toBe(1);
    expect(root.directoryCalls).toEqual([{ create: true, name: "cache-parent" }]);
    expect(root.directories.get("cache-parent")?.files.get("file.bin")).toBe(first);
    expect(root.directories.get("cache-parent")?.fileCalls).toEqual([
      { create: true, name: "file.bin" },
      { create: false, name: "file.bin" },
    ]);
  });

  it("evicts a stale directory handle and retries from a fresh storage root", async () => {
    const staleRoot = new FakeDirectoryHandle();
    const freshRoot = new FakeDirectoryHandle();
    const freshDirectory = new FakeDirectoryHandle();
    const freshFile = { kind: "file" as const, name: "file.bin" };
    freshDirectory.files.set(freshFile.name, freshFile);
    freshRoot.directories.set("stale-parent", freshDirectory);
    const storage = new FakeStorage(staleRoot, freshRoot);
    const navigatorObject = navigatorFor(storage);
    const filePath = "/guest/stale-parent/file.bin";

    await getManagedOpfsFileHandle(filePath, { create: true, navigatorObject });
    const staleDirectory = staleRoot.directories.get("stale-parent");
    if (!staleDirectory) throw new Error("test setup did not create the stale directory");
    staleDirectory.fileError = notFoundError();

    const retried = await getManagedOpfsFileHandle(filePath, { navigatorObject });

    expect(retried).toBe(freshFile);
    expect(storage.getDirectoryCalls).toBe(2);
    expect(staleDirectory.fileCalls).toHaveLength(2);
    expect(freshRoot.directoryCalls).toEqual([{ create: false, name: "stale-parent" }]);
    expect(freshDirectory.fileCalls).toEqual([{ create: false, name: "file.bin" }]);
  });

  it("returns null when a stale handle still misses after the retry", async () => {
    const staleRoot = new FakeDirectoryHandle();
    const freshRoot = new FakeDirectoryHandle();
    const storage = new FakeStorage(staleRoot, freshRoot);
    const navigatorObject = navigatorFor(storage);
    const filePath = "/guest/missing-after-retry/file.bin";

    await getManagedOpfsFileHandle(filePath, { create: true, navigatorObject });
    const staleDirectory = staleRoot.directories.get("missing-after-retry");
    if (!staleDirectory) throw new Error("test setup did not create the stale directory");
    staleDirectory.fileError = notFoundError();

    await expect(getManagedOpfsFileHandle(filePath, { navigatorObject })).resolves.toBeNull();
    expect(storage.getDirectoryCalls).toBe(2);
  });

  it("drops a rejected root promise so a later lookup can retry", async () => {
    const root = new FakeDirectoryHandle();
    const storage = new FakeStorage(new Error("temporary storage failure"), root);
    const navigatorObject = navigatorFor(storage);
    const filePath = "/guest/root-retry/file.bin";

    await expect(getManagedOpfsFileHandle(filePath, { create: true, navigatorObject })).rejects.toThrow(
      "temporary storage failure",
    );
    const file = await getManagedOpfsFileHandle(filePath, { create: true, navigatorObject });

    expect(file?.name).toBe("file.bin");
    expect(storage.getDirectoryCalls).toBe(2);
  });

  it("invalidates removed subtrees before resolving them again", async () => {
    const root = new FakeDirectoryHandle();
    const storage = new FakeStorage(root);
    const navigatorObject = navigatorFor(storage);
    const filePath = "/guest/subtree-parent/child/file.bin";
    const directoryPath = "/guest/subtree-parent/child";

    await getManagedOpfsFileHandle(filePath, { create: true, navigatorObject });
    const subtreeParent = root.directories.get("subtree-parent");
    if (!subtreeParent) throw new Error("test setup did not create the subtree parent");
    const child = subtreeParent.directories.get("child");
    if (!child) throw new Error("test setup did not create the child directory");

    await removeManagedOpfsPath(directoryPath, navigatorObject);
    expect(subtreeParent.removeCalls).toEqual([{ name: "child", recursive: true }]);

    const childDirectoryCallsAfterRemove = subtreeParent.directoryCalls.length;
    await expect(getManagedOpfsFileHandle(filePath, { create: true, navigatorObject })).resolves.not.toBeNull();
    expect(subtreeParent.directoryCalls.length).toBe(childDirectoryCallsAfterRemove + 1);
  });

  it("ignores removal errors by default but rethrows generic errors when requested", async () => {
    const root = new FakeDirectoryHandle();
    const storage = new FakeStorage(root);
    const navigatorObject = navigatorFor(storage);
    const filePath = "/guest/ignore-errors/file.bin";

    await getManagedOpfsFileHandle(filePath, { create: true, navigatorObject });
    const parent = root.directories.get("ignore-errors");
    if (!parent) throw new Error("test setup did not create the removal parent");

    parent.removeError = notFoundError();
    await expect(removeManagedOpfsPath(filePath, navigatorObject, { ignoreErrors: false })).resolves.toBeUndefined();

    parent.removeError = new Error("permission denied");
    await expect(removeManagedOpfsPath(filePath, navigatorObject)).resolves.toBeUndefined();
    await expect(removeManagedOpfsPath(filePath, navigatorObject, { ignoreErrors: false })).rejects.toThrow(
      "permission denied",
    );
  });
});
