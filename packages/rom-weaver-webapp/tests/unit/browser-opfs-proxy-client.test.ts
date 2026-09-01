import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createOpfsProxyChannel,
  OPFS_PROXY_GLOBAL_DOORBELL_INDEX,
  OPFS_PROXY_GLOBAL_OPEN_HANDLES_INDEX,
  OPFS_PROXY_GLOBAL_PEAK_HANDLES_INDEX,
  OPFS_PROXY_GLOBAL_POISONED_INDEX,
  OPFS_PROXY_GLOBAL_TOTAL_OPENS_INDEX,
  type OpfsProxyChannel,
  type OpfsProxyChannelSlot,
  opfsProxyVersionIndex,
} from "../../src/wasm/browser-opfs-proxy-channel.ts";
import {
  CREATE_FLAG,
  OpfsProxyClient,
  OpfsProxyError,
  WRITABLE_FLAG,
} from "../../src/wasm/browser-opfs-proxy-client.ts";
import {
  OPFS_PROXY_CONTROL_AUX_HIGH_INDEX,
  OPFS_PROXY_CONTROL_AUX_LOW_INDEX,
  OPFS_PROXY_CONTROL_HANDLE_INDEX,
  OPFS_PROXY_CONTROL_LENGTH_INDEX,
  OPFS_PROXY_CONTROL_OFFSET_HIGH_INDEX,
  OPFS_PROXY_CONTROL_OFFSET_LOW_INDEX,
  OPFS_PROXY_CONTROL_OPCODE_INDEX,
  OPFS_PROXY_CONTROL_RESULT_INDEX,
  OPFS_PROXY_CONTROL_STATE_INDEX,
  OPFS_PROXY_CONTROL_STATUS_INDEX,
  OPFS_PROXY_DATA_BUFFER_BYTES,
  OPFS_PROXY_HANDLE_BY_PATH,
  OPFS_PROXY_OP_CLOSE,
  OPFS_PROXY_OP_FLUSH,
  OPFS_PROXY_OP_MKDIR,
  OPFS_PROXY_OP_OPEN,
  OPFS_PROXY_OP_READ,
  OPFS_PROXY_OP_SIZE,
  OPFS_PROXY_OP_TRUNCATE,
  OPFS_PROXY_OP_UNLINK,
  OPFS_PROXY_OP_WRITE,
  OPFS_PROXY_STATE_DONE,
  OPFS_PROXY_STATE_IDLE,
  OPFS_PROXY_STATE_REQUESTED,
  OPFS_PROXY_STATUS_EIO,
  OPFS_PROXY_STATUS_OK,
} from "../../src/wasm/browser-opfs-proxy-protocol.ts";

type ServicedRequest = {
  auxHigh: number;
  auxLow: number;
  handle: number;
  length: number;
  offset: number;
  opcode: number;
};

type ServerReply = { detail?: string; result?: number; status?: number };

/**
 * Stands in for the OPFS proxy worker. The client blocks on `Atomics.wait` until the proxy marks the
 * slot DONE, so the reply is written from inside a `wait` hook: nothing in the node test environment
 * can flip the shared word from another thread.
 */
function installProxyServer(
  channel: OpfsProxyChannel,
  respond: (request: ServicedRequest, slot: OpfsProxyChannelSlot) => ServerReply | void,
) {
  const serviced: ServicedRequest[] = [];
  const spy = vi.spyOn(Atomics, "wait").mockImplementation(((array: Int32Array, index: number) => {
    const slot = channel.slots.find((candidate) => candidate.control === array);
    if (!slot || index !== OPFS_PROXY_CONTROL_STATE_INDEX) return "not-equal";
    if (Atomics.load(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX) !== OPFS_PROXY_STATE_REQUESTED) return "not-equal";
    const request: ServicedRequest = {
      auxHigh: Atomics.load(slot.control, OPFS_PROXY_CONTROL_AUX_HIGH_INDEX),
      auxLow: Atomics.load(slot.control, OPFS_PROXY_CONTROL_AUX_LOW_INDEX),
      handle: Atomics.load(slot.control, OPFS_PROXY_CONTROL_HANDLE_INDEX),
      length: Atomics.load(slot.control, OPFS_PROXY_CONTROL_LENGTH_INDEX),
      offset:
        (Atomics.load(slot.control, OPFS_PROXY_CONTROL_OFFSET_HIGH_INDEX) >>> 0) * 2 ** 32 +
        (Atomics.load(slot.control, OPFS_PROXY_CONTROL_OFFSET_LOW_INDEX) >>> 0),
      opcode: Atomics.load(slot.control, OPFS_PROXY_CONTROL_OPCODE_INDEX),
    };
    serviced.push(request);
    const reply = respond(request, slot) ?? {};
    const status = reply.status ?? OPFS_PROXY_STATUS_OK;
    let result = reply.result ?? 0;
    if (reply.detail !== undefined) {
      const encoded = new TextEncoder().encode(reply.detail);
      slot.data.set(encoded, 0);
      result = encoded.byteLength;
    }
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_RESULT_INDEX, result >>> 0);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_AUX_HIGH_INDEX, Math.floor(result / 2 ** 32) >>> 0);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATUS_INDEX, status);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_DONE);
    return "ok";
  }) as unknown as typeof Atomics.wait);
  return { serviced, spy };
}

/** Makes Date.now leap far past every deadline so the timeout branches resolve without waiting. */
function installLeapingClock(skipCalls: number) {
  const base = 1_000_000;
  let calls = 0;
  vi.spyOn(Date, "now").mockImplementation(() => {
    calls += 1;
    return calls <= skipCalls ? base : base + calls * 1_000_000;
  });
}

const readPath = (slot: OpfsProxyChannelSlot, length: number) =>
  new TextDecoder().decode(new Uint8Array(slot.data.subarray(0, length)));

let channel: OpfsProxyChannel;
let trace: string[];
let client: OpfsProxyClient;

beforeEach(() => {
  channel = createOpfsProxyChannel(2);
  trace = [];
  client = new OpfsProxyClient(channel, { trace: (line) => trace.push(line) });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpfsProxyClient shared-state readers", () => {
  it("reads the poison flag, handle gauges and per-handle version stamps", () => {
    expect(client.isPoisoned()).toBe(false);
    expect(client.handleStats()).toEqual({ live: 0, opened: 0, peak: 0 });
    expect(client.handleVersion(3)).toBe(0);

    Atomics.store(channel.global, OPFS_PROXY_GLOBAL_POISONED_INDEX, 1);
    Atomics.store(channel.global, OPFS_PROXY_GLOBAL_OPEN_HANDLES_INDEX, 2);
    Atomics.store(channel.global, OPFS_PROXY_GLOBAL_PEAK_HANDLES_INDEX, 9);
    Atomics.store(channel.global, OPFS_PROXY_GLOBAL_TOTAL_OPENS_INDEX, 41);
    Atomics.store(channel.global, opfsProxyVersionIndex(3), 7);

    expect(client.isPoisoned()).toBe(true);
    expect(client.handleStats()).toEqual({ live: 2, opened: 41, peak: 9 });
    expect(client.handleVersion(3)).toBe(7);
  });
});

describe("OpfsProxyClient open", () => {
  it("sends the path by value and returns the handle the proxy minted", () => {
    const { serviced } = installProxyServer(channel, () => ({ result: 12 }));

    expect(client.open("/work/rom.iso")).toBe(12);
    expect(serviced[0]).toMatchObject({
      auxLow: 0,
      handle: OPFS_PROXY_HANDLE_BY_PATH,
      length: "/work/rom.iso".length,
      opcode: OPFS_PROXY_OP_OPEN,
    });
  });

  it("encodes oflags plus the create and writable flags into AUX_LOW", () => {
    let seenPath = "";
    const { serviced } = installProxyServer(channel, (request, slot) => {
      seenPath = readPath(slot, request.length);
      return { result: 1 };
    });

    client.open("/work/out.bin", { create: true, oflags: 5, writable: true });

    expect(seenPath).toBe("/work/out.bin");
    expect(serviced[0]?.auxLow).toBe(5 | CREATE_FLAG | WRITABLE_FLAG);
  });

  it("refuses a path that cannot fit the shared data buffer", () => {
    installProxyServer(channel, () => ({ result: 1 }));
    const huge = `/${"a".repeat(OPFS_PROXY_DATA_BUFFER_BYTES)}`;

    expect(() => client.open(huge)).toThrow(OpfsProxyError);
    expect(() => client.open(huge)).toThrow(/guest path too long for proxy data buffer/);
  });

  it("rings the doorbell and returns the slot to idle", () => {
    installProxyServer(channel, () => ({ result: 1 }));
    client.open("/work/rom.iso");

    expect(Atomics.load(channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX)).toBe(1);
    expect(Atomics.load(channel.slots[0]?.control as Int32Array, OPFS_PROXY_CONTROL_STATE_INDEX)).toBe(
      OPFS_PROXY_STATE_IDLE,
    );
  });
});

describe("OpfsProxyClient reads", () => {
  it("copies the proxy's bytes into the destination", () => {
    installProxyServer(channel, (request, slot) => {
      slot.data.set(new Uint8Array([1, 2, 3, 4]).subarray(0, request.length), 0);
      return { result: Math.min(4, request.length) };
    });

    const dst = new Uint8Array(4);
    expect(client.readInto(9, 16, dst)).toBe(4);
    expect(dst).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("forwards a 64-bit offset split across the two offset words", () => {
    const { serviced } = installProxyServer(channel, () => ({ result: 1 }));
    const offset = 5 * 2 ** 32 + 17;

    client.readInto(3, offset, new Uint8Array(1));
    expect(serviced[0]).toMatchObject({ handle: 3, offset, opcode: OPFS_PROXY_OP_READ });
  });

  it("chunks a request larger than the shared data buffer", () => {
    const { serviced } = installProxyServer(channel, (request, slot) => {
      slot.data.fill(0xaa, 0, request.length);
      return { result: request.length };
    });

    const dst = new Uint8Array(OPFS_PROXY_DATA_BUFFER_BYTES + 32);
    expect(client.readInto(1, 0, dst)).toBe(dst.byteLength);
    expect(serviced.map((request) => request.length)).toEqual([OPFS_PROXY_DATA_BUFFER_BYTES, 32]);
    expect(serviced.map((request) => request.offset)).toEqual([0, OPFS_PROXY_DATA_BUFFER_BYTES]);
    expect(dst[dst.byteLength - 1]).toBe(0xaa);
  });

  it("stops at a short read and at end of file", () => {
    const short = installProxyServer(channel, () => ({ result: 2 }));
    expect(client.readInto(1, 0, new Uint8Array(8))).toBe(2);
    expect(short.serviced).toHaveLength(1);
    short.spy.mockRestore();

    const empty = installProxyServer(channel, () => ({ result: 0 }));
    expect(client.readInto(1, 0, new Uint8Array(8))).toBe(0);
    expect(empty.serviced).toHaveLength(1);
  });

  it("never touches the proxy for an empty destination", () => {
    const { serviced } = installProxyServer(channel, () => ({ result: 0 }));
    expect(client.readInto(1, 0, new Uint8Array(0))).toBe(0);
    expect(serviced).toEqual([]);
  });
});

describe("OpfsProxyClient writes", () => {
  it("publishes the payload and reports the bytes the proxy accepted", () => {
    let received = new Uint8Array(0);
    const { serviced } = installProxyServer(channel, (request, slot) => {
      received = new Uint8Array(slot.data.subarray(0, request.length));
      return { result: request.length };
    });

    expect(client.write(4, 64, new Uint8Array([9, 8, 7]))).toBe(3);
    expect(received).toEqual(new Uint8Array([9, 8, 7]));
    expect(serviced[0]).toMatchObject({ handle: 4, offset: 64, opcode: OPFS_PROXY_OP_WRITE });
  });

  it("chunks a payload larger than the shared data buffer", () => {
    const { serviced } = installProxyServer(channel, (request) => ({ result: request.length }));
    const src = new Uint8Array(OPFS_PROXY_DATA_BUFFER_BYTES + 8);

    expect(client.write(1, 0, src)).toBe(src.byteLength);
    expect(serviced.map((request) => request.length)).toEqual([OPFS_PROXY_DATA_BUFFER_BYTES, 8]);
  });

  it("stops at a short write and skips an empty payload", () => {
    const short = installProxyServer(channel, () => ({ result: 1 }));
    expect(client.write(1, 0, new Uint8Array([1, 2, 3]))).toBe(1);
    short.spy.mockRestore();

    const refused = installProxyServer(channel, () => ({ result: 0 }));
    expect(client.write(1, 0, new Uint8Array([1, 2, 3]))).toBe(0);
    expect(refused.serviced).toHaveLength(1);
    refused.spy.mockRestore();

    const untouched = installProxyServer(channel, () => ({ result: 0 }));
    expect(client.write(1, 0, new Uint8Array(0))).toBe(0);
    expect(untouched.serviced).toEqual([]);
  });
});

describe("OpfsProxyClient metadata operations", () => {
  it("splits a truncate size across the two aux words", () => {
    const { serviced } = installProxyServer(channel, () => ({}));
    const size = 3 * 2 ** 32 + 11;

    client.truncate(6, size);
    expect(serviced[0]).toMatchObject({ auxHigh: 3, auxLow: 11, handle: 6, opcode: OPFS_PROXY_OP_TRUNCATE });
  });

  it("reassembles a 64-bit size from the result words", () => {
    const size = 6 * 2 ** 32 + 123;
    installProxyServer(channel, () => ({ result: size }));

    expect(client.size(2)).toBe(size);
  });

  it("sends flush and close as bare handle operations", () => {
    const { serviced } = installProxyServer(channel, () => ({}));

    client.flush(5);
    client.close(5);
    expect(serviced.map((request) => request.opcode)).toEqual([OPFS_PROXY_OP_FLUSH, OPFS_PROXY_OP_CLOSE]);
    expect(serviced.every((request) => request.handle === 5)).toBe(true);
  });

  it("sends unlink and mkdir by path", () => {
    const paths: string[] = [];
    const { serviced } = installProxyServer(channel, (request, slot) => {
      paths.push(readPath(slot, request.length));
      return {};
    });

    client.unlink("/work/out.bin");
    client.mkdir("/work/sub");
    expect(paths).toEqual(["/work/out.bin", "/work/sub"]);
    expect(serviced.map((request) => request.opcode)).toEqual([OPFS_PROXY_OP_UNLINK, OPFS_PROXY_OP_MKDIR]);
    expect(serviced.every((request) => request.handle === OPFS_PROXY_HANDLE_BY_PATH)).toBe(true);
  });
});

describe("OpfsProxyClient failure handling", () => {
  it("raises the proxy's errno with the detail it stashed in the data buffer", () => {
    installProxyServer(channel, () => ({ detail: "no such file", status: 44 }));

    expect(() => client.open("/work/gone.iso")).toThrow("OPFS proxy op 1 failed errno=44 (no such file)");
    try {
      client.open("/work/gone.iso");
    } catch (error) {
      expect((error as OpfsProxyError).errno).toBe(44);
      expect((error as OpfsProxyError).name).toBe("OpfsProxyError");
    }
  });

  it("reports a failure with no detail as an empty parenthetical", () => {
    installProxyServer(channel, () => ({ result: 0, status: OPFS_PROXY_STATUS_EIO }));

    expect(() => client.size(1)).toThrow(
      `OPFS proxy op ${OPFS_PROXY_OP_SIZE} failed errno=${OPFS_PROXY_STATUS_EIO} ()`,
    );
  });

  it("fails fast on every operation once the proxy is poisoned", () => {
    Atomics.store(channel.global, OPFS_PROXY_GLOBAL_POISONED_INDEX, 1);

    expect(() => client.size(1)).toThrow("OPFS proxy is poisoned");
    expect(() => client.flush(1)).toThrow("OPFS proxy is poisoned");
    expect(() => client.unlink("/work/a")).toThrow("OPFS proxy is poisoned");
  });

  it("aborts a request as soon as the proxy dies mid-flight", () => {
    vi.spyOn(Atomics, "wait").mockImplementation((() => {
      Atomics.store(channel.global, OPFS_PROXY_GLOBAL_POISONED_INDEX, 1);
      return "timed-out";
    }) as unknown as typeof Atomics.wait);

    expect(() => client.size(1)).toThrow("OPFS proxy died mid-request");
  });

  it("notices a proxy that died before the first state read", () => {
    let submitted = false;
    vi.spyOn(Atomics, "notify").mockImplementation(((array: Int32Array, index: number) => {
      if (!submitted && index === OPFS_PROXY_CONTROL_STATE_INDEX && array !== channel.global) {
        submitted = true;
        Atomics.store(channel.global, OPFS_PROXY_GLOBAL_POISONED_INDEX, 1);
      }
      return 0;
    }) as unknown as typeof Atomics.notify);

    expect(() => client.size(1)).toThrow("OPFS proxy died mid-request");
  });

  it("poisons the channel and traces when a request outlives its deadline", () => {
    installLeapingClock(1);

    expect(() => client.size(1)).toThrow("OPFS proxy request timed out");
    expect(client.isPoisoned()).toBe(true);
    expect(trace).toEqual([`[browser-opfs] proxy op timed out opcode=${OPFS_PROXY_OP_SIZE} slot=0`]);
  });
});

describe("OpfsProxyClient slot acquisition", () => {
  it("waits for a busy slot and claims it once the proxy frees it", () => {
    for (const slot of channel.slots) {
      Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_REQUESTED);
    }
    let freed = false;
    const server = installProxyServer(channel, () => ({ result: 77 }));
    const waitSpy = server.spy.getMockImplementation();
    server.spy.mockImplementation(((array: Int32Array, index: number, value: number, timeout?: number) => {
      if (!freed) {
        freed = true;
        for (const slot of channel.slots) {
          Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_IDLE);
        }
        return "ok";
      }
      return waitSpy?.(array, index, value, timeout) ?? "not-equal";
    }) as unknown as typeof Atomics.wait);

    expect(client.size(1)).toBe(77);
    expect(freed).toBe(true);
  });

  it("gives up when no slot frees before the acquisition deadline", () => {
    for (const slot of channel.slots) {
      Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_REQUESTED);
    }
    installLeapingClock(1);

    expect(() => client.size(1)).toThrow("OPFS proxy slot acquisition timed out");
  });

  it("aborts slot acquisition when the proxy dies while parked", () => {
    for (const slot of channel.slots) {
      Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_REQUESTED);
    }
    vi.spyOn(Atomics, "wait").mockImplementation((() => {
      Atomics.store(channel.global, OPFS_PROXY_GLOBAL_POISONED_INDEX, 1);
      return "timed-out";
    }) as unknown as typeof Atomics.wait);

    expect(() => client.size(1)).toThrow("OPFS proxy is poisoned");
  });

  it("fails immediately on a channel with no slots", () => {
    const empty = new OpfsProxyClient({ ...channel, slots: [] });

    expect(() => empty.size(1)).toThrow("OPFS proxy channel has no slots");
  });
});
