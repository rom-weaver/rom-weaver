// Synchronous WASM-thread client for the handle-owning OPFS proxy. It claims a
// slot, publishes a request, and blocks on Atomics.wait until DONE, allowing
// spawned WASI threads that cannot path_open OPFS files to perform I/O. Large
// payloads are chunked to the shared slot buffer.

import {
  OPFS_PROXY_GLOBAL_DOORBELL_INDEX,
  OPFS_PROXY_GLOBAL_POISONED_INDEX,
  type OpfsProxyChannel,
  type OpfsProxyChannelSlot,
  opfsProxyVersionIndex,
} from "./browser-opfs-proxy-channel.ts";
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
  OPFS_PROXY_STATE_CONSUMER_LOCKED,
  OPFS_PROXY_STATE_DONE,
  OPFS_PROXY_STATE_IDLE,
  OPFS_PROXY_STATE_REQUESTED,
  OPFS_PROXY_STATUS_EIO,
  OPFS_PROXY_STATUS_OK,
} from "./browser-opfs-proxy-protocol.ts";
import { createWaitDeadline, waitForAtomicsStateChange } from "./browser-wasi-thread-protocol.ts";

const SLOT_ACQUIRE_TIMEOUT_MS = 30_000;
const OP_TIMEOUT_MS = 60_000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Encoded into AUX_LOW alongside oflags: the open should create the file when absent. */
export const CREATE_FLAG = 1 << 28;
/** Encoded into AUX_LOW alongside oflags: the file is writable (selects the proxy sync-access mode). */
export const WRITABLE_FLAG = 1 << 29;

/** Error carrying the WASI errno the proxy reported, so the WASI layer can map it back faithfully. */
export class OpfsProxyError extends Error {
  readonly errno: number;
  constructor(message: string, errno: number) {
    super(message);
    this.name = "OpfsProxyError";
    this.errno = errno;
  }
}

export interface OpfsProxyOpenOptions {
  /** WASI oflags forwarded to the proxy (carried in AUX_LOW). */
  oflags?: number;
  /** Non-zero when the open should create the file if absent. */
  create?: boolean;
  /** Non-zero when the file is writable (selects the proxy's sync-access mode). */
  writable?: boolean;
}

export class OpfsProxyClient {
  private readonly channel: OpfsProxyChannel;
  private readonly trace?: (line: string) => void;

  constructor(channel: OpfsProxyChannel, options: { trace?: (line: string) => void } = {}) {
    this.channel = channel;
    this.trace = options.trace;
  }

  /** True once the proxy has marked itself dead; every further op fails fast with EIO. */
  isPoisoned(): boolean {
    return Atomics.load(this.channel.global, OPFS_PROXY_GLOBAL_POISONED_INDEX) !== 0;
  }

  /** Current per-handle version stamp (bumped by the proxy on every write/truncate). */
  handleVersion(handleId: number): number {
    return Atomics.load(this.channel.global, opfsProxyVersionIndex(handleId));
  }

  /**
   * Open (optionally creating) a file by guest path. Returns the proxy-global handle id. Multiple
   * opens of the same path across threads share one underlying SyncAccessHandle (the proxy refcounts).
   */
  open(path: string, options: OpfsProxyOpenOptions = {}): number {
    const { slot, index } = this.acquireSlot();
    try {
      const pathLength = this.writePath(slot, path, 0);
      const auxLow =
        (options.oflags ?? 0) | (options.create ? CREATE_FLAG : 0) | (options.writable ? WRITABLE_FLAG : 0);
      const { result } = this.submit(slot, index, {
        auxLow,
        handle: OPFS_PROXY_HANDLE_BY_PATH,
        length: pathLength,
        opcode: OPFS_PROXY_OP_OPEN,
      });
      return result;
    } finally {
      this.releaseSlot(slot);
    }
  }

  /** Read up to dst.byteLength bytes at offset; returns bytes read. Chunks over the data buffer. */
  readInto(handleId: number, offset: number, dst: Uint8Array): number {
    if (dst.byteLength <= 0) return 0;
    let copied = 0;
    while (copied < dst.byteLength) {
      const { slot, index } = this.acquireSlot();
      try {
        const chunk = Math.min(dst.byteLength - copied, OPFS_PROXY_DATA_BUFFER_BYTES);
        const { result, lastChunk } = this.submitOffset(
          slot,
          index,
          OPFS_PROXY_OP_READ,
          handleId,
          offset + copied,
          chunk,
        );
        if (result <= 0) break;
        dst.set(lastChunk.subarray(0, result), copied);
        copied += result;
        if (result < chunk) break;
      } finally {
        this.releaseSlot(slot);
      }
    }
    return copied;
  }

  /** Write src at offset; returns bytes written. Chunks over the data buffer. */
  write(handleId: number, offset: number, src: Uint8Array): number {
    if (src.byteLength <= 0) return 0;
    let written = 0;
    while (written < src.byteLength) {
      const { slot, index } = this.acquireSlot();
      try {
        const chunk = Math.min(src.byteLength - written, OPFS_PROXY_DATA_BUFFER_BYTES);
        slot.data.set(src.subarray(written, written + chunk), 0);
        const { result } = this.submitOffset(slot, index, OPFS_PROXY_OP_WRITE, handleId, offset + written, chunk);
        if (result <= 0) break;
        written += result;
        if (result < chunk) break;
      } finally {
        this.releaseSlot(slot);
      }
    }
    return written;
  }

  truncate(handleId: number, size: number): void {
    const { slot, index } = this.acquireSlot();
    try {
      this.submit(slot, index, {
        auxHigh: Math.floor(size / 2 ** 32) >>> 0,
        auxLow: size >>> 0,
        handle: handleId,
        opcode: OPFS_PROXY_OP_TRUNCATE,
      });
    } finally {
      this.releaseSlot(slot);
    }
  }

  flush(handleId: number): void {
    this.simpleOp(OPFS_PROXY_OP_FLUSH, handleId);
  }

  close(handleId: number): void {
    this.simpleOp(OPFS_PROXY_OP_CLOSE, handleId);
  }

  size(handleId: number): number {
    const { slot, index } = this.acquireSlot();
    try {
      const { result } = this.submit(slot, index, { handle: handleId, opcode: OPFS_PROXY_OP_SIZE });
      return result;
    } finally {
      this.releaseSlot(slot);
    }
  }

  unlink(path: string): void {
    this.pathOp(OPFS_PROXY_OP_UNLINK, path);
  }

  mkdir(path: string): void {
    this.pathOp(OPFS_PROXY_OP_MKDIR, path);
  }

  private simpleOp(opcode: number, handleId: number): void {
    const { slot, index } = this.acquireSlot();
    try {
      this.submit(slot, index, { handle: handleId, opcode });
    } finally {
      this.releaseSlot(slot);
    }
  }

  private pathOp(opcode: number, path: string): void {
    const { slot, index } = this.acquireSlot();
    try {
      const pathLength = this.writePath(slot, path, 0);
      this.submit(slot, index, { handle: OPFS_PROXY_HANDLE_BY_PATH, length: pathLength, opcode });
    } finally {
      this.releaseSlot(slot);
    }
  }

  private writePath(slot: OpfsProxyChannelSlot, path: string, offset: number): number {
    const encoded = textEncoder.encode(path);
    if (offset + encoded.byteLength > slot.data.byteLength) {
      throw new OpfsProxyError(`guest path too long for proxy data buffer: ${path}`, OPFS_PROXY_STATUS_EIO);
    }
    slot.data.set(encoded, offset);
    return encoded.byteLength;
  }

  private submitOffset(
    slot: OpfsProxyChannelSlot,
    index: number,
    opcode: number,
    handleId: number,
    offset: number,
    length: number,
  ): { result: number; lastChunk: Uint8Array } {
    const { result } = this.submit(slot, index, {
      handle: handleId,
      length,
      offsetHigh: Math.floor(offset / 2 ** 32) >>> 0,
      offsetLow: offset >>> 0,
      opcode,
    });
    return { lastChunk: slot.data, result };
  }

  private submit(
    slot: OpfsProxyChannelSlot,
    index: number,
    request: {
      opcode: number;
      handle: number;
      offsetLow?: number;
      offsetHigh?: number;
      length?: number;
      auxLow?: number;
      auxHigh?: number;
    },
  ): { result: number } {
    if (this.isPoisoned()) throw new OpfsProxyError("OPFS proxy is poisoned", OPFS_PROXY_STATUS_EIO);
    const { control } = slot;
    Atomics.store(control, OPFS_PROXY_CONTROL_OPCODE_INDEX, request.opcode);
    Atomics.store(control, OPFS_PROXY_CONTROL_HANDLE_INDEX, request.handle);
    Atomics.store(control, OPFS_PROXY_CONTROL_OFFSET_LOW_INDEX, request.offsetLow ?? 0);
    Atomics.store(control, OPFS_PROXY_CONTROL_OFFSET_HIGH_INDEX, request.offsetHigh ?? 0);
    Atomics.store(control, OPFS_PROXY_CONTROL_LENGTH_INDEX, request.length ?? 0);
    Atomics.store(control, OPFS_PROXY_CONTROL_AUX_LOW_INDEX, request.auxLow ?? 0);
    Atomics.store(control, OPFS_PROXY_CONTROL_AUX_HIGH_INDEX, request.auxHigh ?? 0);
    Atomics.store(control, OPFS_PROXY_CONTROL_RESULT_INDEX, 0);
    Atomics.store(control, OPFS_PROXY_CONTROL_STATUS_INDEX, OPFS_PROXY_STATUS_OK);
    Atomics.store(control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_REQUESTED);
    Atomics.notify(control, OPFS_PROXY_CONTROL_STATE_INDEX, 1);
    this.ringDoorbell();

    const deadline = createWaitDeadline(OP_TIMEOUT_MS);
    const shouldAbort = () => this.isPoisoned();
    while (true) {
      const state = Atomics.load(control, OPFS_PROXY_CONTROL_STATE_INDEX);
      if (state === OPFS_PROXY_STATE_DONE) break;
      if (this.isPoisoned()) throw new OpfsProxyError("OPFS proxy died mid-request", OPFS_PROXY_STATUS_EIO);
      // shouldAbort re-checks the poison flag every slice so a proxy that dies (and wakes us via its
      // per-slot notify, or even with a lost wakeup) fails fast instead of waiting out OP_TIMEOUT_MS.
      const result = waitForAtomicsStateChange(control, OPFS_PROXY_CONTROL_STATE_INDEX, state, {
        deadline,
        shouldAbort,
      });
      if (result === "aborted") {
        throw new OpfsProxyError("OPFS proxy died mid-request", OPFS_PROXY_STATUS_EIO);
      }
      if (result === "timed-out") {
        Atomics.store(this.channel.global, OPFS_PROXY_GLOBAL_POISONED_INDEX, 1);
        this.trace?.(`[browser-opfs] proxy op timed out opcode=${request.opcode} slot=${index}`);
        throw new OpfsProxyError("OPFS proxy request timed out", OPFS_PROXY_STATUS_EIO);
      }
    }
    const status = Atomics.load(control, OPFS_PROXY_CONTROL_STATUS_INDEX);
    // The result is encoded across two words (RESULT low, AUX_HIGH high), mirroring the read/write
    // offset encoding, so 64-bit values such as SIZE for >= 2 GiB files do not truncate to 32 bits.
    const resultLow = Atomics.load(control, OPFS_PROXY_CONTROL_RESULT_INDEX) >>> 0;
    const resultHigh = Atomics.load(control, OPFS_PROXY_CONTROL_AUX_HIGH_INDEX) >>> 0;
    const result = resultHigh * 2 ** 32 + resultLow;
    if (status !== OPFS_PROXY_STATUS_OK) {
      // On failure the proxy stashes a human-readable detail in the data buffer (RESULT = its length).
      const detailLength = Math.max(0, Math.min(result, slot.data.byteLength));
      // TextDecoder rejects SharedArrayBuffer views; copy into a plain buffer first.
      const detail = detailLength > 0 ? textDecoder.decode(new Uint8Array(slot.data.subarray(0, detailLength))) : "";
      throw new OpfsProxyError(`OPFS proxy op ${request.opcode} failed errno=${status} (${detail})`, status);
    }
    return { result };
  }

  private ringDoorbell(): void {
    Atomics.add(this.channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX, 1);
    Atomics.notify(this.channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX);
  }

  private acquireSlot(): { slot: OpfsProxyChannelSlot; index: number } {
    if (this.isPoisoned()) throw new OpfsProxyError("OPFS proxy is poisoned", OPFS_PROXY_STATUS_EIO);
    const deadline = createWaitDeadline(SLOT_ACQUIRE_TIMEOUT_MS);
    const shouldAbort = () => this.isPoisoned();
    const slots = this.channel.slots;
    while (true) {
      // Re-check on every scan so a proxy that dies while we are parked here fails fast rather than
      // looping until SLOT_ACQUIRE_TIMEOUT_MS.
      if (this.isPoisoned()) throw new OpfsProxyError("OPFS proxy is poisoned", OPFS_PROXY_STATUS_EIO);
      for (let i = 0; i < slots.length; i += 1) {
        const slot = slots[i];
        if (!slot) continue;
        if (
          Atomics.compareExchange(
            slot.control,
            OPFS_PROXY_CONTROL_STATE_INDEX,
            OPFS_PROXY_STATE_IDLE,
            OPFS_PROXY_STATE_CONSUMER_LOCKED,
          ) === OPFS_PROXY_STATE_IDLE
        ) {
          return { index: i, slot };
        }
      }
      const first = slots[0];
      if (!first) throw new OpfsProxyError("OPFS proxy channel has no slots", OPFS_PROXY_STATUS_EIO);
      const state = Atomics.load(first.control, OPFS_PROXY_CONTROL_STATE_INDEX);
      const waitResult = waitForAtomicsStateChange(first.control, OPFS_PROXY_CONTROL_STATE_INDEX, state, {
        deadline,
        shouldAbort,
      });
      if (waitResult === "aborted") {
        throw new OpfsProxyError("OPFS proxy is poisoned", OPFS_PROXY_STATUS_EIO);
      }
      if (waitResult === "timed-out") {
        throw new OpfsProxyError("OPFS proxy slot acquisition timed out", OPFS_PROXY_STATUS_EIO);
      }
    }
  }

  private releaseSlot(slot: OpfsProxyChannelSlot): void {
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_IDLE);
    Atomics.notify(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, 1);
  }
}
