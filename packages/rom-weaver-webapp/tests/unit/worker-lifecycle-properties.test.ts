import { describe, expect, it } from "vitest";
import { createBrowserWorkerTransport, RomWeaverWorkerClientCore } from "../../src/wasm/workers/worker-client-core.ts";

class ControlledWorker extends EventTarget {
  messages: { requestId: number; type: string }[] = [];
  listeners = new Set<EventListenerOrEventListenerObject>();
  terminated = false;

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener) this.listeners.add(listener);
    super.addEventListener(type, listener);
  }

  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener) this.listeners.delete(listener);
    super.removeEventListener(type, listener);
  }

  postMessage(message: { requestId: number; type: string }) {
    this.messages.push(message);
  }

  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  terminate() {
    this.terminated = true;
  }
}

class MeasuredClient extends RomWeaverWorkerClientCore {
  constructor(worker: ControlledWorker) {
    super(worker as unknown as Worker, createBrowserWorkerTransport());
  }

  get outstanding() {
    return this._pending.size;
  }

  terminate() {
    this._shutdown();
    this._terminateWorker();
  }
}

const request = { command: { type: "probe" as const, args: { input: "/work/input.bin" } } };

function random(seed: number) {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

describe("worker lifecycle model", () => {
  for (const seed of [1, 7, 42, 0xcafe]) {
    it(`isolates retries, stale responses and cleanup (seed=${seed})`, async () => {
      const next = random(seed);
      const worker = new ControlledWorker();
      const client = new MeasuredClient(worker);
      const pending = new Map<number, Promise<unknown>>();
      const completed: number[] = [];
      for (let step = 0; step < 100; step += 1) {
        const action = next() % 4;
        if (action === 0 || pending.size === 0) {
          const promise = client.runJson(request).then(
            (value) => ({ status: "success", value }),
            (error: Error) => ({ status: "failure", message: error.message }),
          );
          const id = worker.messages.at(-1)?.requestId;
          expect(id).toBeDefined();
          pending.set(id as number, promise);
        } else if (action === 1 && completed.length > 0) {
          worker.emit({ type: "result", requestId: completed[next() % completed.length], result: { stale: true } });
        } else {
          const id = [...pending.keys()][next() % pending.size];
          const cancelled = action === 2;
          worker.emit(
            cancelled
              ? {
                  type: "error",
                  requestId: id,
                  error: { name: "AbortError", kind: "cancelled", message: "operation cancelled" },
                }
              : { type: "result", requestId: id, result: { id } },
          );
          expect(await pending.get(id)).toEqual(
            cancelled ? { status: "failure", message: "operation cancelled" } : { status: "success", value: { id } },
          );
          pending.delete(id);
          completed.push(id);
        }
        expect(client.outstanding, `seed=${seed}, step=${step}`).toBe(pending.size);
      }
      client.terminate();
      for (const promise of pending.values()) {
        expect(await promise).toEqual({ status: "failure", message: "worker terminated" });
      }
      expect(client.outstanding).toBe(0);
      expect(worker.listeners.size).toBe(0);
      expect(worker.terminated).toBe(true);
      client.terminate();
      expect(client.outstanding).toBe(0);
      await expect(client.runJson(request)).rejects.toThrow("terminated");
      for (const id of pending.keys()) worker.emit({ type: "result", requestId: id, result: { stale: true } });
      expect(client.outstanding).toBe(0);
    });
  }

  it("dispose acknowledgement is isolated from a newer request", async () => {
    const worker = new ControlledWorker();
    const client = new MeasuredClient(worker);
    const disposal = client.dispose();
    const disposeId = worker.messages.at(-1)?.requestId;
    worker.emit({ type: "disposed", requestId: disposeId });
    await expect(disposal).resolves.toEqual({ disposed: true });
    const retry = client.runJson(request);
    const retryId = worker.messages.at(-1)?.requestId;
    worker.emit({ type: "disposed", requestId: disposeId });
    worker.emit({ type: "result", requestId: disposeId, result: { stale: true } });
    expect(client.outstanding).toBe(1);
    worker.emit({ type: "result", requestId: retryId, result: { retry: true } });
    await expect(retry).resolves.toEqual({ retry: true });
    expect(client.outstanding).toBe(0);
    client.terminate();
    expect(worker.listeners.size).toBe(0);
  });
});
