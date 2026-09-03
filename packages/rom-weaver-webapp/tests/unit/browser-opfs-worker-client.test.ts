import { beforeEach, describe, expect, it } from "vitest";

class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly posted: unknown[] = [];
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

  postMessage(message: unknown) {
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

const { requestBrowserOpfsStorage } = await import("../../src/workers/protocol/browser-opfs-worker-client.ts");

beforeEach(() => {
  if (!FakeWorker.instances.length) {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
  }
});

describe("browser OPFS storage worker client", () => {
  it("posts requests, ignores unrelated messages, and resolves matching replies", async () => {
    const pending = requestBrowserOpfsStorage({ action: "list", requestId: "list-1" });
    const worker = FakeWorker.instances[0];
    expect(worker?.posted[0]).toEqual({ action: "list", requestId: "list-1" });
    worker?.emit("message", { data: { requestId: "other", success: true } });
    worker?.emit("message", { data: { entries: [], requestId: "list-1", success: true } });
    await expect(pending).resolves.toEqual({ entries: [], requestId: "list-1", success: true });
    expect(worker?.listeners.get("message")?.size).toBe(0);
  });

  it("transfers standalone write buffers and rejects fatal worker errors", async () => {
    const bytes = new Uint8Array([1, 2]);
    const pending = requestBrowserOpfsStorage({ action: "write", bytes, filePath: "/work/file.bin", position: 4 });
    const worker = FakeWorker.instances[0];
    expect(worker?.posted[1]).toMatchObject({ action: "write", filePath: "/work/file.bin", position: 4 });
    worker?.emit("error", { message: "worker crashed" });
    await expect(pending).rejects.toThrow("worker crashed");
    expect(worker?.terminated).toBe(true);
  });

  it("rejects when Worker support is unavailable", async () => {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined });
    await expect(requestBrowserOpfsStorage({ action: "remove", filePath: "/work/file.bin" })).rejects.toThrow(
      "Browser OPFS storage requires Worker support",
    );
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
  });
});
