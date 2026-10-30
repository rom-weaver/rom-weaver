import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  channel: { slots: [{}, {}], transfer: { globalControl: new SharedArrayBuffer(4), slotControls: [], slotData: [] } },
  client: vi.fn(),
  createChannel: vi.fn(),
}));

vi.mock("../../src/wasm/browser-opfs-proxy-channel.ts", () => ({
  createOpfsProxyChannel: state.createChannel,
}));
vi.mock("../../src/wasm/browser-opfs-proxy-client.ts", () => ({
  OpfsProxyClient: class {
    constructor(...args: unknown[]) {
      state.client(...args);
    }
  },
}));

class FakeWorker {
  static instances: FakeWorker[] = [];
  onerror: ((event: { message?: string }) => void) | null = null;
  onmessage: ((event: MessageEvent<{ line?: string; message?: string; type?: string }>) => void) | null = null;
  readonly messages: unknown[] = [];
  terminated = false;

  constructor(
    readonly url: string | URL,
    readonly options: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown) {
    this.messages.push(message);
    const type = (message as { type?: string }).type;
    if (type === "bootstrap" && FakeWorker.mode === "ready") {
      this.onmessage?.({ data: { line: "booting", type: "trace" } } as MessageEvent);
      queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } } as MessageEvent));
    }
    if (type === "stop" && FakeWorker.mode === "ready")
      queueMicrotask(() => this.onmessage?.({ data: { type: "stopped" } } as MessageEvent));
  }

  terminate() {
    this.terminated = true;
  }

  static mode: "ready" | "error" | "bootstrap-error" | "timeout" = "ready";
}

const { startOpfsProxyRuntime } = await import("../../src/wasm/browser-opfs-proxy-runtime.ts");

beforeEach(() => {
  state.createChannel.mockReturnValue(state.channel);
  state.client.mockClear();
  FakeWorker.instances.length = 0;
  FakeWorker.mode = "ready";
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("OPFS proxy runtime", () => {
  it("starts a proxy worker, forwards traces and blob registration, then stops it", async () => {
    const trace = vi.fn();
    const runtime = await startOpfsProxyRuntime({
      mounts: [{ mountPath: "/work" } as never],
      slotCount: 2,
      syncAccessMode: "auto" as never,
      trace,
      workerUrl: "/custom-worker.js",
    });
    const worker = FakeWorker.instances[0];
    expect(worker?.messages[0]).toMatchObject({ mounts: [{ mountPath: "/work" }], type: "bootstrap" });
    expect(state.createChannel).toHaveBeenCalledWith(2);
    expect(state.client).toHaveBeenCalledWith(state.channel, { trace: expect.any(Function) });
    expect(trace).toHaveBeenCalledWith("booting");
    expect(trace).toHaveBeenCalledWith(expect.stringContaining("proxy runtime ready slots=2 mounts=1"));
    runtime.setTrace(trace);
    runtime.registerBlobSource("/work/input.bin", new Blob(["input"]));
    runtime.unregisterBlobSource("/work/input.bin");
    expect(worker?.messages).toContainEqual({
      blob: expect.any(Blob),
      path: "/work/input.bin",
      type: "register-blob-source",
    });
    expect(worker?.messages).toContainEqual({ path: "/work/input.bin", type: "unregister-blob-source" });
    if (!worker) throw new Error("proxy worker was not created");
    const control = new Int32Array((worker.messages[0] as { shutdownControl: SharedArrayBuffer }).shutdownControl);
    const stopped = runtime.stop();
    expect(runtime.stop()).toBe(stopped);
    expect(Atomics.load(control, 0)).toBe(1);
    expect(worker?.terminated).toBe(false);
    Atomics.store(control, 0, 2);
    Atomics.notify(control, 0);
    await stopped;
    expect(worker?.terminated).toBe(true);
  });

  it("rejects worker bootstrap errors and fatal start errors", async () => {
    FakeWorker.mode = "bootstrap-error";
    const bootstrap = startOpfsProxyRuntime({ mounts: [], slotCount: 1 });
    const bootstrapWorker = FakeWorker.instances[0];
    if (!bootstrapWorker) throw new Error("proxy worker was not created");
    const bootstrapControl = new Int32Array(
      (bootstrapWorker.messages[0] as { shutdownControl: SharedArrayBuffer }).shutdownControl,
    );
    Atomics.store(bootstrapControl, 0, 2);
    bootstrapWorker?.onmessage?.({ data: { message: "bad mounts", type: "error" } } as MessageEvent);
    await expect(bootstrap).rejects.toThrow("bad mounts");
    expect(bootstrapWorker.terminated).toBe(true);
    expect(Atomics.load(bootstrapControl, 0)).toBe(2);
    expect(Atomics.load(bootstrapControl, 1)).toBe(1);

    FakeWorker.mode = "error";
    const failure = startOpfsProxyRuntime({ mounts: [], slotCount: 1 });
    const failureWorker = FakeWorker.instances[1];
    if (!failureWorker) throw new Error("proxy worker was not created");
    failureWorker?.onerror?.({ message: "CSP blocked" });
    await expect(failure).rejects.toThrow("CSP blocked");
    const failedControl = new Int32Array(
      (failureWorker.messages[0] as { shutdownControl: SharedArrayBuffer }).shutdownControl,
    );
    // A proxy that never started owns nothing, so its closure is acknowledged rather than marked failed.
    expect(Atomics.load(failedControl, 0)).toBe(2);
    expect(failureWorker.terminated).toBe(true);
  });

  it("times out a worker that never sends a ready message", async () => {
    vi.useFakeTimers();
    FakeWorker.mode = "timeout";
    const pending = startOpfsProxyRuntime({ mounts: [], slotCount: 1 });
    const failure = expect(pending).rejects.toThrow("did not become ready in time");
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error("proxy worker was not created");
    expect(worker.terminated).toBe(true);
    const control = new Int32Array((worker.messages[0] as { shutdownControl: SharedArrayBuffer }).shutdownControl);
    expect(Atomics.load(control, 0)).toBe(2);
  });

  it("acknowledges closure when bootstrap cannot be posted", async () => {
    const control = new Int32Array(new SharedArrayBuffer(8));
    vi.spyOn(FakeWorker.prototype, "postMessage").mockImplementationOnce(() => {
      throw new DOMException("could not clone bootstrap", "DataCloneError");
    });
    await expect(startOpfsProxyRuntime({ mounts: [], slotCount: 1, shutdownControl: control.buffer })).rejects.toThrow(
      "could not clone bootstrap",
    );
    expect(Atomics.load(control, 0)).toBe(2);
    expect(Atomics.load(control, 1)).toBe(0);
    expect(FakeWorker.instances[0]?.terminated).toBe(true);
    vi.restoreAllMocks();
  });

  it("rejects failed resource closure and still terminates the proxy", async () => {
    const control = new Int32Array(new SharedArrayBuffer(8));
    const runtime = await startOpfsProxyRuntime({ mounts: [], slotCount: 1, shutdownControl: control.buffer });
    const stopped = runtime.stop();
    const rejected = expect(stopped).rejects.toThrow("failed to close its owned resources");
    Atomics.store(control, 0, 3);
    Atomics.notify(control, 0);
    await rejected;
    expect(FakeWorker.instances[0]?.terminated).toBe(true);
  });
});
