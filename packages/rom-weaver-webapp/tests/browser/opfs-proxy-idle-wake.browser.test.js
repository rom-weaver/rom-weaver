import { expect, test, vi } from "vitest";
import {
  createOpfsProxyChannel,
  OPFS_PROXY_GLOBAL_DOORBELL_INDEX,
  OPFS_PROXY_GLOBAL_OPEN_HANDLES_INDEX,
} from "../../src/wasm/browser-opfs-proxy-channel.ts";
import { CREATE_FLAG, WRITABLE_FLAG } from "../../src/wasm/browser-opfs-proxy-client.ts";
import {
  OPFS_PROXY_CONTROL_AUX_LOW_INDEX,
  OPFS_PROXY_CONTROL_HANDLE_INDEX,
  OPFS_PROXY_CONTROL_LENGTH_INDEX,
  OPFS_PROXY_CONTROL_OPCODE_INDEX,
  OPFS_PROXY_CONTROL_RESULT_INDEX,
  OPFS_PROXY_CONTROL_STATE_INDEX,
  OPFS_PROXY_CONTROL_STATUS_INDEX,
  OPFS_PROXY_OP_CLOSE,
  OPFS_PROXY_OP_OPEN,
  OPFS_PROXY_OP_READ,
  OPFS_PROXY_OP_UNLINK,
  OPFS_PROXY_OP_WRITE,
  OPFS_PROXY_STATE_DONE,
  OPFS_PROXY_STATE_IDLE,
  OPFS_PROXY_STATE_REQUESTED,
  OPFS_PROXY_STATUS_OK,
} from "../../src/wasm/browser-opfs-proxy-protocol.ts";
import proxyWorkerUrl from "../../src/wasm/workers/browser-opfs-proxy-worker.ts?worker&url";

test("serves real OPFS requests and stops after its doorbell has been idle", async () => {
  const channel = createOpfsProxyChannel(1);
  const slot = channel.slots[0];
  const worker = new Worker(proxyWorkerUrl, { type: "module" });
  const messages = [];
  worker.onmessage = (event) => messages.push(event.data);
  const path = `/work/idle-wake-${crypto.randomUUID()}.bin`;
  const expected = new Uint8Array([3, 1, 4, 1, 5, 9]);

  // Only the production Dedicated Worker accesses OPFS. The page publishes asynchronously
  // so it can assert acknowledgements without blocking its own event loop.
  const request = async (opcode, { handle = 0, path, bytes } = {}) => {
    slot.control.fill(0);
    const data = path === undefined ? bytes : new TextEncoder().encode(path);
    if (data) slot.data.set(data);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_OPCODE_INDEX, opcode);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_HANDLE_INDEX, handle);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_LENGTH_INDEX, data?.byteLength ?? expected.byteLength);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_AUX_LOW_INDEX, CREATE_FLAG | WRITABLE_FLAG);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_REQUESTED);
    Atomics.add(channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX, 1);
    Atomics.notify(channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX);
    await vi.waitFor(() =>
      expect(Atomics.load(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX)).toBe(OPFS_PROXY_STATE_DONE),
    );
    expect(Atomics.load(slot.control, OPFS_PROXY_CONTROL_STATUS_INDEX)).toBe(OPFS_PROXY_STATUS_OK);
    const result = Atomics.load(slot.control, OPFS_PROXY_CONTROL_RESULT_INDEX);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_IDLE);
    return result;
  };

  try {
    worker.postMessage({
      channel: channel.transfer,
      mounts: [{ mountPath: "/work", rootRelativeParts: [], writableRoots: ["/work"] }],
      syncAccessMode: "readwrite-unsafe",
      type: "bootstrap",
    });
    await vi.waitFor(() => expect(messages.some((message) => message.type === "ready")).toBe(true));
    // Exceed the former 250 ms timed wait: its promise can remain unresolved in WebKit
    // after later notifications, preventing subsequent requests from reaching the proxy.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const handle = await request(OPFS_PROXY_OP_OPEN, { path });
    expect(await request(OPFS_PROXY_OP_WRITE, { bytes: expected, handle })).toBe(expected.byteLength);
    expect(await request(OPFS_PROXY_OP_READ, { handle })).toBe(expected.byteLength);
    expect([...slot.data.subarray(0, expected.byteLength)]).toEqual([...expected]);
    await request(OPFS_PROXY_OP_CLOSE, { handle });
    await request(OPFS_PROXY_OP_UNLINK, { path });
    expect(Atomics.load(channel.global, OPFS_PROXY_GLOBAL_OPEN_HANDLES_INDEX)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 350));
    worker.postMessage({ type: "stop" });
    await vi.waitFor(() => expect(messages.some((message) => message.type === "stopped")).toBe(true));
  } finally {
    worker.terminate();
  }
});
