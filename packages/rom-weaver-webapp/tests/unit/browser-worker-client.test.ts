import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/wasm/workers/browser-thread-budget.ts", () => ({
  normalizeDefaultThreads: (value: unknown) => (typeof value === "number" ? value : null),
  resolveBrowserDefaultThreads: () => 6,
}));

type Listener = (event: Event) => void;

class FakeWorker {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly posted: unknown[] = [];
  terminated = false;

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) || new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown) {
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(data: unknown) {
    for (const listener of this.listeners.get("message") || []) listener({ data } as MessageEvent);
  }
}

const { BrowserRomWeaverWorkerClient, createBrowserWorkerClient } =
  await import("../../src/wasm/workers/browser-worker-client.ts");

let worker: FakeWorker;

beforeEach(() => {
  worker = new FakeWorker();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("browser worker client", () => {
  it("creates a client with an explicit default and sends init options", async () => {
    const client = createBrowserWorkerClient({ defaultThreads: 4, worker: worker as unknown as Worker });
    expect(client).toBeInstanceOf(BrowserRomWeaverWorkerClient);
    const pending = client.init({ mode: "fast" } as never);
    expect(worker.posted[0]).toMatchObject({
      options: { defaultThreads: 4, mode: "fast" },
      type: "init",
    });
    worker.emit({ requestId: 1, type: "ready", mode: "browser-opfs", threaded: true, wasmUrl: "/app.wasm" });
    await expect(pending).resolves.toEqual({ mode: "browser-opfs", threaded: true, wasmUrl: "/app.wasm" });
    expect(client._createInitOptions({ defaultThreads: 2 })).toEqual({ defaultThreads: 2 });
  });

  it("uses the resolved default when omitted and accepts null option objects", async () => {
    const client = createBrowserWorkerClient({ worker: worker as unknown as Worker });
    const pending = client.init(null as never);
    expect(worker.posted[0]).toMatchObject({ options: { defaultThreads: 6 }, type: "init" });
    worker.emit({ requestId: 1, type: "ready", mode: "browser-opfs", threaded: false });
    await expect(pending).resolves.toEqual({ mode: "browser-opfs", threaded: false, wasmUrl: null });
  });

  it("creates a worker from a URL and terminates it with pending work rejected", async () => {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
    const client = createBrowserWorkerClient({ workerUrl: "/runner.js", workerOptions: { name: "runner" } });
    const created = (client as unknown as { worker: FakeWorker }).worker;
    expect(created).toBeInstanceOf(FakeWorker);
    const pending = client.init();
    client.terminate();
    await expect(pending).rejects.toMatchObject({ message: "worker terminated" });
    expect(created.terminated).toBe(true);
  });
});
