import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  attachChannel: vi.fn(() => ({ channel: true })),
  buildFds: vi.fn(async () => ({ fds: [], mounts: [{ mountPath: "/work" }] })),
  cache: {
    dispose: vi.fn(async () => undefined),
    invalidateMountPaths: vi.fn(async () => undefined),
    invalidateMounts: vi.fn(async () => undefined),
  },
  census: vi.fn(),
  cleanupMounts: vi.fn(async () => undefined),
  closeSyncFiles: vi.fn(),
  directImports: vi.fn(),
  disposeNested: vi.fn(async () => undefined),
  formatArgs: vi.fn((args: unknown[]) => args.join(",")),
  formatError: vi.fn((error: unknown) => String(error)),
  lineTrace: vi.fn(() => vi.fn()),
  mountHandles: vi.fn(({ mountHandles }: { mountHandles?: Record<string, unknown> }) => mountHandles || {}),
  needsSpawnImport: vi.fn(() => false),
  normalizeMounts: vi.fn((mounts: unknown) => (Array.isArray(mounts) ? mounts : [])),
  proxyClient: vi.fn(),
  signalState: vi.fn(),
  spawner: vi.fn(() => ({ spawn: vi.fn(), waitForWorkers: vi.fn(async () => undefined) })),
  summarizeFiles: vi.fn(() => "none"),
  traceDirect: vi.fn(),
  traceFlush: vi.fn(),
  traceRandom: vi.fn(),
  wasmEnv: vi.fn(() => ({ memory: true })),
}));

vi.mock("@bjorn3/browser_wasi_shim", () => ({
  WASI: class {
    fds: unknown[];
    wasiImport = { fd_write: vi.fn() };
    inst: unknown;
    constructor(_args: string[], _env: string[], fds: unknown[]) {
      this.fds = fds;
    }
  },
}));
vi.mock("../../src/wasm/browser-opfs-mounts.ts", () => ({
  buildBrowserOpfsWasiFds: state.buildFds,
  cleanupBrowserOpfsMounts: state.cleanupMounts,
  createBrowserOpfsMountCache: () => state.cache,
  normalizeMountHandleMap: state.mountHandles,
}));
vi.mock("../../src/wasm/browser-opfs-proxy-channel.ts", () => ({ attachOpfsProxyChannel: state.attachChannel }));
vi.mock("../../src/wasm/browser-opfs-proxy-client.ts", () => ({
  OpfsProxyClient: class {
    constructor(...args: unknown[]) {
      state.proxyClient(...args);
    }
  },
}));
vi.mock("../../src/wasm/browser-opfs-runtime-env.ts", () => ({
  assertDedicatedWorkerRuntime: vi.fn(),
  assertDirectoryHandle: vi.fn(),
  normalizeRuntimeMounts: state.normalizeMounts,
}));
vi.mock("../../src/wasm/browser-opfs-stdio-events.ts", () => ({
  createLineTrace: state.lineTrace,
  formatArgsForTrace: state.formatArgs,
  formatErrorForTrace: state.formatError,
  installDirectWasiFileIoImports: state.directImports,
  summarizeRawVirtualFiles: state.summarizeFiles,
  traceDirectWasiFileIoStats: state.traceDirect,
  traceFlushOpenWasiFileDescriptors: state.traceFlush,
  traceRandomAccessFileIoStats: state.traceRandom,
}));
vi.mock("../../src/wasm/browser-opfs-sync-access.ts", () => ({ closeSyncFiles: state.closeSyncFiles }));
vi.mock("../../src/wasm/browser-wasi-nested-thread-workers.ts", () => ({
  disposeNestedThreadWorkerLists: state.disposeNested,
}));
vi.mock("../../src/wasm/browser-wasi-thread-census.ts", () => ({ attachThreadWorkerCensus: state.census }));
vi.mock("../../src/wasm/browser-wasi-thread-pool.ts", () => ({
  createBrowserWasiThreadSpawner: state.spawner,
  needsWasiThreadSpawnImport: state.needsSpawnImport,
}));
vi.mock("../../src/wasm/browser-wasi-thread-protocol.ts", () => ({
  signalThreadStartState: state.signalState,
  THREAD_SLOT_STATE_FAILED: 3,
  THREAD_SLOT_STATE_RUNNING: 2,
  THREAD_SLOT_STATE_STARTING: 1,
  threadStartControlFromBuffer: vi.fn(() => ({ control: true })),
}));
vi.mock("../../src/wasm/rom-weaver-runtime-utils.ts", () => ({ createWasmEnvImports: state.wasmEnv }));

const {
  __disposeRomWeaverBrowserNestedThreadWorkers,
  __disposeRomWeaverBrowserThreadRuntime,
  __primeRomWeaverBrowserThreadRuntime,
  __runRomWeaverBrowserWasiThread,
} = await import("../../src/wasm/browser-opfs-wasi-thread-runtime.ts");

const wasmModule = new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));

const makeSharedMemory = () => new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });

const installWorkerSelf = () => {
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: { location: { href: "https://example.test/worker.js" } },
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  installWorkerSelf();
  state.buildFds.mockResolvedValue({ fds: [], mounts: [{ mountPath: "/work" }] });
  state.cleanupMounts.mockResolvedValue(undefined);
  state.spawner.mockReturnValue({ spawn: vi.fn(), waitForWorkers: vi.fn(async () => undefined) });
  vi.spyOn(WebAssembly, "instantiate").mockResolvedValue({
    exports: { wasi_thread_start: vi.fn() },
  } as never);
});

describe("browser OPFS WASI thread runtime", () => {
  it("rejects payloads without a module, shared memory, or proxy channel", async () => {
    await expect(__runRomWeaverBrowserWasiThread()).rejects.toThrow(
      "browser wasi thread payload missing compiled WebAssembly.Module",
    );
    await expect(__runRomWeaverBrowserWasiThread({ wasmModule })).rejects.toThrow(
      "browser wasi thread payload missing shared WebAssembly.Memory",
    );
    await expect(
      __runRomWeaverBrowserWasiThread({ wasmModule, wasmMemory: new WebAssembly.Memory({ initial: 1 }) }),
    ).rejects.toThrow("browser wasi thread payload memory is not shared");
    await expect(
      __runRomWeaverBrowserWasiThread({ wasmModule, wasmMemory: makeSharedMemory(), runtime: {} } as never),
    ).rejects.toThrow("browser OPFS thread runtime requires an opfsProxyTransfer channel");
  });

  it("builds a threaded WASI instance, acknowledges start, and cleans mounts", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const startControlBuffer = new SharedArrayBuffer(16);
    const runtime = {
      cwdMountPath: "/work",
      mountHandles: { "/work": { kind: "directory" } },
      opfsProxyTransfer: { port: true },
      runtimeMounts: ["/work"],
      virtualFiles: { "/work/input.bin": { size: 4 } },
      writableRoots: ["/work"],
    };
    await expect(
      __runRomWeaverBrowserWasiThread({
        __streamBroadcastChannelName: "stream",
        __streamRequestId: 8,
        envList: ["MODE=test"],
        runtime,
        startArg: 11,
        startControlBuffer,
        stderrLineHandler: stderr,
        stdoutLineHandler: stdout,
        tid: 4,
        wasiArgs: ["rom-weaver", "--help"],
        wasmMemory: makeSharedMemory(),
        wasmModule,
      } as never),
    ).resolves.toBeUndefined();
    expect(state.buildFds).toHaveBeenCalledWith(
      expect.objectContaining({
        cwdMountPath: "/work",
        knownInputPaths: undefined,
        mountHandles: runtime.mountHandles,
        proxyClient: expect.anything(),
        runtimeMounts: ["/work"],
        virtualFiles: runtime.virtualFiles,
        writableRoots: ["/work"],
      }),
    );
    expect(state.signalState).toHaveBeenNthCalledWith(1, { control: true }, 1);
    expect(state.signalState).toHaveBeenNthCalledWith(2, { control: true }, 2);
    expect(state.cleanupMounts).toHaveBeenCalledWith([{ mountPath: "/work" }]);
    expect(state.closeSyncFiles).toHaveBeenCalledWith([]);
    expect(state.traceFlush).toHaveBeenCalled();
    expect(state.traceDirect).toHaveBeenCalled();
    expect(state.traceRandom).toHaveBeenCalled();
    expect(state.census).toHaveBeenCalledWith(runtime.opfsProxyTransfer);
    expect(state.wasmEnv).toHaveBeenCalledWith(expect.any(WebAssembly.Memory));
  });

  it("marks a failed start and invalidates the mount cache when instantiation fails", async () => {
    vi.mocked(WebAssembly.instantiate).mockRejectedValueOnce(new Error("compile failed"));
    const runtime = {
      invalidateMountCacheAfterRun: true,
      mountHandles: { "/work": { kind: "directory" } },
      opfsProxyTransfer: { port: true },
      runtimeMounts: ["/work"],
    };
    await expect(
      __runRomWeaverBrowserWasiThread({ runtime, tid: 3, wasmMemory: makeSharedMemory(), wasmModule } as never),
    ).rejects.toThrow("compile failed");
    expect(state.signalState).toHaveBeenLastCalledWith({ control: true }, 3);
    expect(state.cache.invalidateMounts).toHaveBeenCalledWith([{ mountPath: "/work" }]);
    expect(state.cleanupMounts).toHaveBeenCalled();
  });

  it("prewarms missing mount handles and disposes nested and cached workers", async () => {
    const getDirectoryHandle = vi.fn();
    getDirectoryHandle.mockImplementation(async (part: string) => ({
      getDirectoryHandle,
      kind: "directory",
      part,
    }));
    const directory = {
      getDirectoryHandle,
      kind: "directory",
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { storage: { getDirectory: vi.fn(async () => directory) } },
    });
    await __primeRomWeaverBrowserThreadRuntime(
      {
        mountRootRelativeParts: { "/work": ["runs", "one"] },
        runtimeMounts: ["/work"],
      } as never,
      vi.fn(),
    );
    expect(directory.getDirectoryHandle).toHaveBeenNthCalledWith(1, "runs", { create: false });
    expect(directory.getDirectoryHandle).toHaveBeenNthCalledWith(2, "one", { create: false });
    expect(state.mountHandles).toHaveBeenCalledWith({ mountHandles: undefined });
    expect(state.cache.invalidateMountPaths).not.toHaveBeenCalled();
    await __disposeRomWeaverBrowserNestedThreadWorkers();
    await __disposeRomWeaverBrowserThreadRuntime();
    expect(state.disposeNested).toHaveBeenCalledTimes(2);
    expect(state.cache.dispose).toHaveBeenCalledTimes(1);
  });
});
