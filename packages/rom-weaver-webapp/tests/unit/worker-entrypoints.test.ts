import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachOpfsProxyChannel: vi.fn(),
  createRomWeaverBrowserOpfs: vi.fn(),
  createRunnerWorkerMessageQueue: vi.fn(),
  startOpfsProxyServer: vi.fn(),
  runnerOptions: null as null | {
    initRunner: (input: { mode?: string; options: Record<string, unknown> }) => Promise<unknown>;
    postMessage: (message: unknown) => void;
  },
}));

vi.mock("../../src/wasm/browser-opfs-proxy-channel.ts", () => ({
  attachOpfsProxyChannel: mocks.attachOpfsProxyChannel,
}));

vi.mock("../../src/wasm/browser-opfs-proxy-server.ts", () => ({
  startOpfsProxyServer: mocks.startOpfsProxyServer,
}));

vi.mock("../../src/wasm/rom-weaver-browser-opfs-api.ts", () => ({
  createRomWeaverBrowserOpfs: mocks.createRomWeaverBrowserOpfs,
}));

vi.mock("../../src/wasm/workers/runner-worker-core.ts", () => ({
  createRunnerWorkerMessageQueue: mocks.createRunnerWorkerMessageQueue,
}));

type WorkerScope = {
  addEventListener: (type: string, listener: (event: { data?: unknown }) => void) => void;
  onmessage?: (event: { data?: unknown }) => void;
  postMessage: (message: unknown) => void;
};

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

let scope: WorkerScope;
let posted: unknown[];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  posted = [];
  scope = {
    addEventListener: vi.fn(),
    postMessage: (message) => posted.push(message),
  };
  vi.stubGlobal("self", scope);
  vi.stubGlobal("navigator", {
    storage: {
      getDirectory: vi.fn(),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OPFS proxy worker entrypoint", () => {
  it("handles control messages before bootstrap and reports a successful bootstrap", async () => {
    const root = {
      getDirectoryHandle: vi.fn(),
    };
    root.getDirectoryHandle.mockResolvedValue(root);
    const server = {
      done: Promise.resolve(),
      registerBlobSource: vi.fn(),
      stop: vi.fn(),
      unregisterBlobSource: vi.fn(),
    };
    mocks.attachOpfsProxyChannel.mockReturnValue({ channel: true });
    mocks.startOpfsProxyServer.mockReturnValue(server);
    vi.spyOn(navigator.storage, "getDirectory").mockResolvedValue(root as never);

    await import("../../src/wasm/workers/browser-opfs-proxy-worker.ts");
    const send = (data: unknown) => scope.onmessage?.({ data });
    send(null);
    send({ type: "register-blob-source", path: "/work/input.bin", blob: new Blob(["rom"]) });
    send({ type: "unregister-blob-source", path: "/work/input.bin" });
    send({ type: "stop" });
    expect(posted).toEqual([{ type: "stopped" }]);

    send({
      channel: { globalControl: new SharedArrayBuffer(4), slotControls: [], slotData: [] },
      mounts: [{ mountPath: "/work", rootRelativeParts: ["roms", "work"], writableRoots: ["/work"] }],
      syncAccessMode: "readwrite",
      type: "bootstrap",
    });
    await flush();
    expect(root.getDirectoryHandle).toHaveBeenNthCalledWith(1, "roms", { create: false });
    expect(root.getDirectoryHandle).toHaveBeenNthCalledWith(2, "work", { create: false });
    expect(mocks.startOpfsProxyServer).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: { channel: true },
        mounts: [{ directoryHandle: root, mountPath: "/work", writableRoots: ["/work"] }],
        syncAccessMode: "readwrite",
        trace: expect.any(Function),
      }),
    );
    expect(posted).toContainEqual({ type: "ready" });
    server.registerBlobSource.mockClear();
    server.unregisterBlobSource.mockClear();
    send({ type: "register-blob-source", path: "/work/input.bin", blob: new Blob(["rom"]) });
    send({ type: "unregister-blob-source", path: "/work/input.bin" });
    expect(server.registerBlobSource).toHaveBeenCalled();
    expect(server.unregisterBlobSource).toHaveBeenCalledWith("/work/input.bin");
    send({ type: "stop" });
    await flush();
    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(posted).toContainEqual({ type: "stopped" });
  });

  it("reports bootstrap failures with a stable worker error message", async () => {
    mocks.attachOpfsProxyChannel.mockImplementation(() => {
      throw new Error("bad channel");
    });
    vi.spyOn(navigator.storage, "getDirectory").mockRejectedValue(new Error("storage unavailable"));
    await import("../../src/wasm/workers/browser-opfs-proxy-worker.ts");
    scope.onmessage?.({
      data: {
        channel: { globalControl: new SharedArrayBuffer(4), slotControls: [], slotData: [] },
        mounts: [],
        type: "bootstrap",
      },
    });
    await flush();
    expect(posted).toEqual([{ message: "OPFS proxy bootstrap failed: Error: bad channel", type: "error" }]);
  });
});

describe("browser runner worker entrypoint", () => {
  it("queues messages, posts message errors, and initializes supported runners", async () => {
    const enqueue = vi.fn();
    mocks.createRunnerWorkerMessageQueue.mockImplementation((options) => {
      mocks.runnerOptions = options;
      return { enqueue };
    });
    const runner = { threaded: true, wasmUrl: "/rom-weaver.wasm" };
    mocks.createRomWeaverBrowserOpfs.mockResolvedValue(runner);
    await import("../../src/wasm/workers/browser-runner-worker.ts");

    const listeners = vi.mocked(scope.addEventListener).mock.calls;
    const onMessage = listeners.find(([type]) => type === "message")?.[1];
    const onMessageError = listeners.find(([type]) => type === "messageerror")?.[1];
    expect(onMessage).toBeDefined();
    expect(onMessageError).toBeDefined();
    const request = { requestId: 7, options: { defaultThreads: 2 }, type: "init" };
    onMessage?.({ data: request });
    expect(enqueue).toHaveBeenCalledWith(request);
    onMessageError?.({ data: undefined });
    expect(posted).toContainEqual({
      error: {
        context: { stage: "worker.messageerror" },
        kind: "worker",
        message: "browser runner worker could not deserialize a posted message",
        name: "DataCloneError",
      },
      requestId: null,
      type: "error",
    });

    const options = mocks.runnerOptions;
    if (!options) throw new Error("runner worker did not configure its queue");
    await expect(options.initRunner({ mode: undefined, options: { defaultThreads: 2 } })).resolves.toEqual({
      mode: "browser-opfs",
      runner,
    });
    expect(mocks.createRomWeaverBrowserOpfs).toHaveBeenCalledWith({ defaultThreads: 2 });
    await expect(options.initRunner({ mode: "unsupported", options: {} })).rejects.toThrow(
      "unsupported browser worker mode: unsupported",
    );
    options.postMessage({ type: "trace" });
    expect(posted).toContainEqual({ type: "trace" });
  });
});
