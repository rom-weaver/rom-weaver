import OPFS_PROXY_WORKER_URL from "../../src/wasm/workers/browser-opfs-proxy-worker.ts?worker&url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly posted: Array<{ message: unknown; transfer: readonly Transferable[] }> = [];
  terminated = false;

  constructor(
    readonly url: unknown,
    readonly options: unknown,
  ) {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown, transfer: readonly Transferable[] = []) {
    this.posted.push({ message, transfer });
  }

  terminate() {
    this.terminated = true;
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

let readBrowserOpfsPrefix: typeof import("../../src/workers/protocol/browser-opfs-worker-client.ts").readBrowserOpfsPrefix;

let requestBrowserOpfsStorage: typeof import("../../src/workers/protocol/browser-opfs-worker-client.ts").requestBrowserOpfsStorage;

beforeEach(async () => {
  vi.resetModules();
  FakeWorker.instances.length = 0;
  vi.stubGlobal("Worker", FakeWorker);
  ({ requestBrowserOpfsStorage, readBrowserOpfsPrefix } =
    await import("../../src/workers/protocol/browser-opfs-worker-client.ts"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("browser OPFS storage worker client", () => {
  it("posts requests, ignores unrelated messages, and resolves matching replies", async () => {
    const pending = requestBrowserOpfsStorage({ action: "list", requestId: "list-1" });
    const worker = FakeWorker.instances[0];
    expect(worker?.posted[0]).toEqual({ message: { action: "list", requestId: "list-1" }, transfer: [] });
    worker?.emit("message", { data: { requestId: "other", success: true } });
    worker?.emit("message", { data: { entries: [], requestId: "list-1", success: true } });
    await expect(pending).resolves.toEqual({ entries: [], requestId: "list-1", success: true });
    expect(worker?.listeners.get("message")?.size).toBe(0);
  });

  it("transfers standalone write buffers and rejects fatal worker errors", async () => {
    const bytes = new Uint8Array([1, 2]);
    const pending = requestBrowserOpfsStorage({ action: "write", bytes, filePath: "/work/file.bin", position: 4 });
    const worker = FakeWorker.instances[0];
    expect(worker?.posted[0]?.message).toMatchObject({ action: "write", filePath: "/work/file.bin", position: 4 });
    expect(worker?.posted[0]?.transfer).toEqual([bytes.buffer]);
    worker?.emit("error", { message: "worker crashed" });
    await expect(pending).rejects.toThrow("worker crashed");
    expect(worker?.terminated).toBe(true);
  });

  it("rejects when Worker support is unavailable", async () => {
    vi.stubGlobal("Worker", undefined);
    await expect(requestBrowserOpfsStorage({ action: "remove", filePath: "/work/file.bin" })).rejects.toThrow(
      "Browser OPFS storage requires Worker support",
    );
  });
});

describe("one-shot OPFS prefix worker", () => {
  const getStartedWorker = () => {
    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error("prefix read did not start a worker");
    return worker;
  };
  const getRequest = (worker: FakeWorker) => {
    const request = worker.posted[0]?.message as { requestId: string } | undefined;
    if (!request) throw new Error("prefix read did not post a request");
    return request;
  };
  const assertClosed = (worker: FakeWorker) => {
    expect(worker.terminated).toBe(true);
    for (const listeners of worker.listeners.values()) expect(listeners.size).toBe(0);
  };

  it("resolves only the matching bounded read and terminates its worker", async () => {
    const pending = readBrowserOpfsPrefix("/work/result.bin", 37654);
    const worker = getStartedWorker();
    const request = getRequest(worker);
    expect(request).toMatchObject({ type: "read-prefix", filePath: "/work/result.bin", length: 37654 });
    worker.emit("message", { data: { requestId: "another", type: "read-prefix-complete", bytes: new Uint8Array(1) } });
    expect(worker.terminated).toBe(false);
    const bytes = new Uint8Array([0, 255]);
    worker.emit("message", { data: { requestId: request.requestId, type: "read-prefix-complete", bytes } });
    await expect(pending).resolves.toBe(bytes);
    assertClosed(worker);
  });

  it.each(["error", "messageerror", "read-prefix-error", "oversize", "post-throw", "abort", "timeout"])(
    "cleans up on %s",
    async (kind) => {
      vi.useFakeTimers();
      if (kind === "post-throw")
        vi.spyOn(FakeWorker.prototype, "postMessage").mockImplementation(() => {
          throw new Error("post failed");
        });
      const controller = new AbortController();
      const pending = readBrowserOpfsPrefix("/work/result.bin", 12, controller.signal);
      const rejected = expect(pending).rejects.toBeInstanceOf(Error);
      const worker = getStartedWorker();
      const request = worker.posted[0]?.message as { requestId: string } | undefined;
      if (kind === "error") worker.emit("error", { message: "worker failed" });
      if (kind === "messageerror") worker.emit("messageerror", {});
      if (kind === "read-prefix-error")
        worker.emit("message", { data: { requestId: request?.requestId, type: kind, message: "missing file" } });
      if (kind === "oversize")
        worker.emit("message", {
          data: { requestId: request?.requestId, type: "read-prefix-complete", bytes: new Uint8Array(13) },
        });
      if (kind === "abort") controller.abort(new Error("cancelled"));
      if (kind === "timeout") await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      assertClosed(worker);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not spawn for an already aborted read or an invalid bound", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(readBrowserOpfsPrefix("/work/result.bin", 12, controller.signal)).rejects.toThrow("cancelled");
    for (const length of [-1, 65537, NaN, 1.5])
      await expect(readBrowserOpfsPrefix("/work/result.bin", length)).rejects.toThrow("prefix length");
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("rejects worker construction failures before installing a timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("worker blocked");
        }
      },
    );
    await expect(readBrowserOpfsPrefix("/work/result.bin", 12)).rejects.toThrow("worker blocked");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["https://example.test/", "https://example.test/nested/", "invalid base URL"])(
    "uses the bundled proxy worker when asset base is %s",
    async (baseUrl) => {
      vi.stubGlobal("__romWeaverWorkerBaseUrl", baseUrl);
      const pending = readBrowserOpfsPrefix("/work/result.bin", 0);
      const worker = getStartedWorker();
      const request = getRequest(worker);
      worker.emit("message", {
        data: { requestId: request.requestId, type: "read-prefix-complete", bytes: new Uint8Array() },
      });
      await pending;
      assertClosed(worker);
      expect(worker.url).toBe(OPFS_PROXY_WORKER_URL);
    },
  );
});
