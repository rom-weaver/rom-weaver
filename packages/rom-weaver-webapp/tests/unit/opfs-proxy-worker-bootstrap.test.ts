import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpfsProxyServerOptions } from "../../src/wasm/browser-opfs-proxy-server.ts";

const mocks = vi.hoisted(() => ({ attach: vi.fn(), start: vi.fn() }));
vi.mock("../../src/wasm/browser-opfs-proxy-channel.ts", () => ({ attachOpfsProxyChannel: mocks.attach }));
vi.mock("../../src/wasm/browser-opfs-proxy-server.ts", () => ({ startOpfsProxyServer: mocks.start }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

let scope: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: ReturnType<typeof vi.fn> };
let getDirectory: ReturnType<typeof vi.fn>;
let getDirectoryHandle: ReturnType<typeof vi.fn>;
let control: Int32Array<SharedArrayBuffer>;

function bootstrap() {
  scope.onmessage?.({
    data: {
      type: "bootstrap",
      channel: { globalControl: new SharedArrayBuffer(4), slotControls: [], slotData: [] },
      shutdownControl: control.buffer,
      mounts: [{ mountPath: "/work", rootRelativeParts: ["session"], writableRoots: ["/work/output"] }],
    },
  });
}

beforeEach(async () => {
  vi.resetModules();
  mocks.attach.mockReset().mockReturnValue({ slots: [] });
  mocks.start.mockReset();
  control = new Int32Array(new SharedArrayBuffer(4));
  getDirectoryHandle = vi.fn().mockResolvedValue({});
  getDirectory = vi.fn().mockResolvedValue({ getDirectoryHandle });
  vi.stubGlobal("navigator", { storage: { getDirectory } });
  scope = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal("self", scope);
  await import("../../src/wasm/workers/browser-opfs-proxy-worker.ts");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OPFS proxy worker bootstrap shutdown", () => {
  it.each(["channel", "root", "mount", "server"])(
    "acknowledges shutdown and preserves the original %s bootstrap failure before server ownership",
    async (phase) => {
      const error = new Error(`${phase} unavailable`);
      if (phase === "channel")
        mocks.attach.mockImplementation(() => {
          throw error;
        });
      if (phase === "root") getDirectory.mockRejectedValue(error);
      if (phase === "mount") getDirectoryHandle.mockRejectedValue(error);
      if (phase === "server")
        mocks.start.mockImplementation(() => {
          throw error;
        });
      Atomics.store(control, 0, 1);
      const posted = deferred<unknown>();
      let stateAtErrorPost: number | undefined;
      scope.postMessage.mockImplementation((message) => {
        stateAtErrorPost = Atomics.load(control, 0);
        posted.resolve(message);
      });
      bootstrap();
      await expect(posted.promise).resolves.toEqual({
        type: "error",
        message: `OPFS proxy bootstrap failed: ${String(error)}`,
      });
      expect(stateAtErrorPost).toBe(2);
    },
  );

  it.each([2, 3])(
    "awaits server closure before posting a ready failure and preserves shutdown state %s",
    async (state) => {
      const closed = deferred<void>();
      const stopped = deferred<void>();
      const posted = deferred<unknown>();
      const stop = vi.fn(() => stopped.resolve());
      mocks.start.mockReturnValue({ stop, done: closed.promise });
      const error = new Error("ready delivery failed");
      scope.postMessage.mockImplementation((message: { type: string }) => {
        if (message.type === "ready") throw error;
        posted.resolve(message);
      });
      bootstrap();
      await stopped.promise;
      expect(stop).toHaveBeenCalledTimes(1);
      expect(scope.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "ready" });
      expect(Atomics.load(control, 0)).toBe(0);
      Atomics.store(control, 0, state);
      closed.resolve();
      await expect(posted.promise).resolves.toEqual({
        type: "error",
        message: `OPFS proxy bootstrap failed: ${String(error)}`,
      });
      expect(Atomics.load(control, 0)).toBe(state);
    },
  );

  it("hands a shutdown requested during delayed mount resolution to the resource-owning server", async () => {
    const directory = deferred<object>();
    const ready = deferred<void>();
    getDirectoryHandle.mockReturnValue(directory.promise);
    mocks.start.mockImplementation((options: OpfsProxyServerOptions) => {
      expect(options.shutdownControl?.buffer).toBe(control.buffer);
      expect(Atomics.load(control, 0)).toBe(1);
      return { stop: vi.fn(), done: Promise.resolve() };
    });
    scope.postMessage.mockImplementation(() => ready.resolve());
    bootstrap();
    await vi.waitFor(() => expect(getDirectoryHandle).toHaveBeenCalledExactlyOnceWith("session", { create: false }));
    Atomics.store(control, 0, 1);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(scope.postMessage).not.toHaveBeenCalled();
    directory.resolve({});
    await ready.promise;
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(scope.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "ready" });
    expect(Atomics.load(control, 0)).toBe(1);
  });
});
