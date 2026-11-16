import { expect, test, vi } from "vitest";
import { isStaleDirectoryHandleError, OpfsDirectoryCache } from "../../src/wasm/opfs-directory-cache.ts";

interface FakeDirectory {
  name: string;
  getDirectoryHandle: ReturnType<typeof vi.fn>;
}

const makeDirectory = (name: string): FakeDirectory => ({
  getDirectoryHandle: vi.fn(async (child: string) => makeDirectory(`${name}/${child}`)),
  name,
});

test("walks each folder once and serves repeats from the cache", async () => {
  const cache = new OpfsDirectoryCache<FakeDirectory>();
  const root = makeDirectory("root");
  const onCachedDirectory = vi.fn();
  const first = await cache.resolve(root, ["a", "b"], { create: true });
  const second = await cache.resolve(root, ["a", "b"], { create: true, onCachedDirectory });
  expect(second).toBe(first);
  expect(root.getDirectoryHandle).toHaveBeenCalledTimes(1);
  expect(onCachedDirectory).toHaveBeenCalledTimes(2);
});

test("a deeper path reuses the folders it shares with an earlier one", async () => {
  const cache = new OpfsDirectoryCache<FakeDirectory>();
  const root = makeDirectory("root");
  const a = await cache.resolve(root, ["a"], { create: true });
  await cache.resolve(root, ["a", "b"], { create: true });
  expect(root.getDirectoryHandle).toHaveBeenCalledTimes(1);
  expect(a.getDirectoryHandle).toHaveBeenCalledWith("b", { create: true });
});

test("concurrent walks of one path share a single lookup", async () => {
  const cache = new OpfsDirectoryCache<FakeDirectory>();
  const root = makeDirectory("root");
  await Promise.all([cache.resolve(root, ["a"], { create: true }), cache.resolve(root, ["a"], { create: true })]);
  expect(root.getDirectoryHandle).toHaveBeenCalledTimes(1);
});

test("a failed lookup is not cached", async () => {
  const cache = new OpfsDirectoryCache<FakeDirectory>();
  const root = makeDirectory("root");
  root.getDirectoryHandle.mockRejectedValueOnce(new Error("missing"));
  await expect(cache.resolve(root, ["a"], { create: false })).rejects.toThrow("missing");
  await cache.resolve(root, ["a"], { create: false });
  expect(root.getDirectoryHandle).toHaveBeenCalledTimes(2);
});

test("keeps separate roots apart with a key prefix", async () => {
  const cache = new OpfsDirectoryCache<FakeDirectory>();
  const one = makeDirectory("one");
  const two = makeDirectory("two");
  const first = await cache.resolve(one, ["a"], { create: true, keyPrefix: "/one" });
  const second = await cache.resolve(two, ["a"], { create: true, keyPrefix: "/two" });
  expect(second).not.toBe(first);
});

test("forget drops a folder and everything under it, and nothing beside it", async () => {
  const cache = new OpfsDirectoryCache<FakeDirectory>();
  const root = makeDirectory("root");
  await cache.resolve(root, ["a", "b"], { create: true });
  await cache.resolve(root, ["ab"], { create: true });
  cache.forget(["a"]);
  const onCachedDirectory = vi.fn();
  await cache.resolve(root, ["ab"], { create: true, onCachedDirectory });
  expect(onCachedDirectory).toHaveBeenCalledTimes(1);
  await cache.resolve(root, ["a", "b"], { create: true, onCachedDirectory });
  expect(onCachedDirectory).toHaveBeenCalledTimes(1);
});

test("evicts the oldest folder past its limit", async () => {
  const cache = new OpfsDirectoryCache<FakeDirectory>(2);
  const root = makeDirectory("root");
  for (const name of ["a", "b", "c"]) await cache.resolve(root, [name], { create: true });
  const onCachedDirectory = vi.fn();
  await cache.resolve(root, ["c"], { create: true, onCachedDirectory });
  await cache.resolve(root, ["a"], { create: true, onCachedDirectory });
  expect(onCachedDirectory).toHaveBeenCalledTimes(1);
});

test.each([
  ["NotFoundError", true],
  ["InvalidStateError", true],
  ["UnknownError", true],
  ["NoModificationAllowedError", false],
])("treats %s as a stale handle error: %s", (name, expected) => {
  expect(isStaleDirectoryHandleError(Object.assign(new Error("x"), { name }))).toBe(expected);
});
