import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("../../src/wasm/browser-opfs-mount.ts", () => ({
  BrowserOpfsMount: { create: state.create },
  cleanupBrowserOpfsMounts: vi.fn(),
}));

const { createBrowserOpfsMountCache } = await import("../../src/wasm/browser-opfs-mounts.ts");

const makeDirectory = (name: string, sameEntry?: boolean) => ({
  isSameEntry: vi.fn(async () => sameEntry ?? false),
  name,
});

const options = (mountPath: string, directoryHandle: object, overrides: Record<string, unknown> = {}) => ({
  directoryHandle,
  mountPath,
  proxyClient: null,
  syncAccessMode: "auto",
  virtualOnly: false,
  writableRoots: ["/work"],
  ...overrides,
});

const disposeMock = (mount: object) => Reflect.get(mount, "dispose") as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  state.create.mockImplementation(async (input: Record<string, unknown>) => ({
    ...input,
    dispose: vi.fn(async () => undefined),
    writableRootsKey: (input.writableRoots as string[]).join("\0"),
  }));
});

describe("browser OPFS mount cache", () => {
  it("reuses a matching mount and replaces it when options change", async () => {
    const cache = createBrowserOpfsMountCache();
    const firstHandle = makeDirectory("first");
    const first = await cache.acquire(options("/work", firstHandle));
    const same = await cache.acquire(options("/work", firstHandle));
    expect(same).toBe(first);
    expect(state.create).toHaveBeenCalledTimes(1);

    const replacement = await cache.acquire(options("/work", makeDirectory("replacement"), { virtualOnly: true }));
    expect(replacement).not.toBe(first);
    expect(disposeMock(first)).toHaveBeenCalledTimes(1);
    expect(state.create).toHaveBeenCalledTimes(2);
  });

  it("matches distinct handles with isSameEntry and falls back after comparison errors", async () => {
    const cache = createBrowserOpfsMountCache();
    const first = makeDirectory("first", true);
    await cache.acquire(options("/work", first));
    const equivalent = makeDirectory("equivalent");
    expect(await cache.acquire(options("/work", equivalent))).toEqual(expect.anything());
    expect(state.create).toHaveBeenCalledTimes(1);

    const throwing = {
      isSameEntry: vi.fn(async () => {
        throw new Error("comparison unavailable");
      }),
    };
    const errorCache = createBrowserOpfsMountCache();
    await errorCache.acquire(options("/work", throwing));
    const changed = await errorCache.acquire(options("/work", makeDirectory("changed")));
    expect(changed).toEqual(expect.anything());
    expect(state.create).toHaveBeenCalledTimes(3);
  });

  it("invalidates selected paths and exact mount identities", async () => {
    const cache = createBrowserOpfsMountCache();
    const first = await cache.acquire(options("/first", makeDirectory("first")));
    const second = await cache.acquire(options("/second", makeDirectory("second")));
    await cache.invalidateMountPaths(["/first", "/missing"]);
    expect(disposeMock(first)).toHaveBeenCalledTimes(1);
    expect(disposeMock(second)).not.toHaveBeenCalled();
    await cache.invalidateMounts([first, { mountPath: "/second" } as never]);
    expect(disposeMock(second)).not.toHaveBeenCalled();
    await cache.invalidateMounts([second]);
    expect(disposeMock(second)).toHaveBeenCalledTimes(1);
  });

  it("disposes all mounts and rejects future acquisition", async () => {
    const cache = createBrowserOpfsMountCache();
    const first = await cache.acquire(options("/first", makeDirectory("first")));
    const second = await cache.acquire(options("/second", makeDirectory("second")));
    await cache.dispose();
    expect(disposeMock(first)).toHaveBeenCalledTimes(1);
    expect(disposeMock(second)).toHaveBeenCalledTimes(1);
    await expect(cache.acquire(options("/third", makeDirectory("third")))).rejects.toThrow("cache is disposed");
    await cache.invalidateMounts([null, undefined] as never);
  });
});
