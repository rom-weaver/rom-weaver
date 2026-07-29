import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireNestedThreadWorkerList,
  disposeNestedThreadWorkerLists,
  type NestedThreadWorkerOptions,
} from "../../src/wasm/browser-wasi-nested-thread-workers.ts";
import { createBrowserWasiThreadSpawner } from "../../src/wasm/browser-wasi-thread-spawner.ts";
import {
  THREAD_SLOT_STATE_IDLE,
  THREAD_SLOT_STATE_INDEX,
  THREAD_SLOT_STATE_RUNNING,
} from "../../src/wasm/browser-wasi-thread-protocol.ts";

class FakeWorker {
  static created: FakeWorker[] = [];

  readonly listeners = new Map<string, Array<(event: { data?: unknown; preventDefault?: () => void }) => void>>();
  readonly messages: unknown[] = [];
  terminated = false;

  constructor() {
    FakeWorker.created.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: unknown; preventDefault?: () => void }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
    if ((message as { mode?: unknown })?.mode !== "shutdown") return;
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: { commandId: 0, type: "command-done" } });
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

const WASI_THREAD_IMPORTS: WebAssembly.ModuleImportDescriptor[] = [
  { kind: "function", module: "wasi", name: "thread-spawn" },
];

const createOptions = (): NestedThreadWorkerOptions => ({
  debugWasi: false,
  envList: [],
  runtime: {},
  threadIdState: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
  threadWorkerUrl: "https://example.test/thread-worker.js",
  wasiArgs: [],
  wasmMemory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }),
  wasmModule: {} as WebAssembly.Module,
});

afterEach(async () => {
  await disposeNestedThreadWorkerLists();
  FakeWorker.created = [];
  vi.unstubAllGlobals();
});

describe("nested thread worker ownership", () => {
  it("reuses one parked worker across spawn rounds", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const list = acquireNestedThreadWorkerList(createOptions());

    const first = list.acquire(43, 1);
    Atomics.store(first.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_IDLE);
    list.release(first);
    const second = list.acquire(44, 2);

    expect(second).toBe(first);
    expect(FakeWorker.created).toHaveLength(1);
  });

  it("terminates a retired worker that is still running", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const list = acquireNestedThreadWorkerList(createOptions());
    const slot = list.acquire(43, 1);
    Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_RUNNING);

    list.retire(slot);

    expect(FakeWorker.created[0]?.terminated).toBe(true);
  });

  it("drains workers owned by a top-level no-pool fallback", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const options = createOptions();
    const list = acquireNestedThreadWorkerList(options);
    const slot = list.acquire(43, 1);
    Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_IDLE);
    list.release(slot);
    const spawner = createBrowserWasiThreadSpawner({
      ...options,
      allowWorkerPool: true,
      moduleImports: WASI_THREAD_IMPORTS,
      threadWorkerPool: null,
    });

    await spawner.waitForWorkers();

    expect(FakeWorker.created[0]?.terminated).toBe(true);
  });

  it("keeps realm-owned nested workers parked between parent spawners", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const options = createOptions();
    const list = acquireNestedThreadWorkerList(options);
    const slot = list.acquire(43, 1);
    Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_IDLE);
    list.release(slot);
    const spawner = createBrowserWasiThreadSpawner({
      ...options,
      allowWorkerPool: false,
      moduleImports: WASI_THREAD_IMPORTS,
      threadWorkerPool: null,
    });

    await spawner.waitForWorkers();

    expect(FakeWorker.created[0]?.terminated).toBe(false);
  });

  it("forwards the runner's full-mount mode to nested workers", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const options = {
      ...createOptions(),
      runtime: { invalidateMountCacheBeforeRun: true, virtualOnlyMounts: false },
    };
    const list = acquireNestedThreadWorkerList(options);

    list.acquire(43, 1);

    const payload = FakeWorker.created[0]?.messages[0] as {
      runtime?: { invalidateMountCacheBeforeRun?: boolean; virtualOnlyMounts?: boolean };
    };
    expect(payload.runtime?.invalidateMountCacheBeforeRun).toBe(true);
    expect(payload.runtime?.virtualOnlyMounts).toBe(false);
  });
});
