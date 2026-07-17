import { afterEach, expect, test } from "vitest";

// Exercises the directory-handle cache added to opfs-path.ts: handles must stay correct across a
// delete/recreate of a cached bucket directory, and a stale cached handle (external removal) must
// fall back to a fresh root resolution rather than returning a detached subtree.

const createdRoots = new Set();

const uniqueRoot = (label) => {
  const name = `opfs-path-cache-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  createdRoots.add(name);
  return name;
};

const writeText = async (handle, text) => {
  const writable = await handle.createWritable({ keepExistingData: false });
  await writable.write(new TextEncoder().encode(text));
  await writable.close();
};

const readText = async (handle) => {
  const file = await handle.getFile();
  return new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()));
};

afterEach(async () => {
  const root = await navigator.storage.getDirectory();
  for (const name of createdRoots) {
    await root.removeEntry(name, { recursive: true }).catch(() => undefined);
  }
  createdRoots.clear();
});

test("resolves a working file handle and serves repeated lookups from cache", async () => {
  const { getManagedOpfsFileHandle } = await import("../../src/workers/protocol/opfs-path.ts");
  // The leading "/work" mount segment is stripped by normalizeOpfsPathParts, so `base` is the
  // first real OPFS-root entry below it.
  const base = uniqueRoot("reuse");
  const path = `/work/${base}/input/a.bin`;

  const created = await getManagedOpfsFileHandle(path, { create: true, navigatorObject: navigator });
  expect(created).toBeTruthy();
  await writeText(created, "hello");

  const reused = await getManagedOpfsFileHandle(path, { navigatorObject: navigator });
  expect(reused).toBeTruthy();
  expect(await readText(reused)).toBe("hello");
});

test("recreates files under a bucket that was removed via removeManagedOpfsPath", async () => {
  const { getManagedOpfsFileHandle, removeManagedOpfsPath } = await import("../../src/workers/protocol/opfs-path.ts");
  const base = uniqueRoot("recreate");
  const dirPath = `/work/${base}/input`;
  const fileA = `${dirPath}/a.bin`;

  // Warm the directory cache for `${base}/input`.
  const handleA = await getManagedOpfsFileHandle(fileA, { create: true, navigatorObject: navigator });
  await writeText(handleA, "first");

  // Remove the whole bucket directory; the cache for it must be invalidated.
  await removeManagedOpfsPath(dirPath, navigator);

  const fileB = `${dirPath}/b.bin`;
  const handleB = await getManagedOpfsFileHandle(fileB, { create: true, navigatorObject: navigator });
  expect(handleB).toBeTruthy();
  await writeText(handleB, "recreated");
  expect(await readText(handleB)).toBe("recreated");

  // The removed file must not reappear through a stale cached directory handle.
  expect(await getManagedOpfsFileHandle(fileA, { navigatorObject: navigator })).toBeNull();
});

test("falls back to a fresh root when a cached directory handle goes stale", async () => {
  const { getManagedOpfsFileHandle } = await import("../../src/workers/protocol/opfs-path.ts");
  const base = uniqueRoot("stale");
  const dirPath = `/work/${base}/input`;
  const fileA = `${dirPath}/a.bin`;

  // Warm the cache, then remove the subtree directly through the root, bypassing our invalidation.
  await getManagedOpfsFileHandle(fileA, { create: true, navigatorObject: navigator });
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(base, { recursive: true });

  // A non-create lookup against the stale cache must retry from a fresh root and report the miss.
  expect(await getManagedOpfsFileHandle(fileA, { navigatorObject: navigator })).toBeNull();

  // A create lookup must succeed by rebuilding the directory chain.
  const recreated = await getManagedOpfsFileHandle(fileA, { create: true, navigatorObject: navigator });
  expect(recreated).toBeTruthy();
  await writeText(recreated, "back");
  expect(await readText(recreated)).toBe("back");
});
