// Allocates the shared OPFS proxy channel and its global control region. See
// browser-opfs-proxy-protocol.ts for the per-slot wire format.

import { OPFS_PROXY_CONTROL_WORD_COUNT, OPFS_PROXY_DATA_BUFFER_BYTES } from "./browser-opfs-proxy-protocol.ts";

// --- Global control region (indices into the Int32Array view of globalControl) -------------------

/**
 * Consumers increment this doorbell after publishing to close the proxy's lost-wakeup window.
 */
export const OPFS_PROXY_GLOBAL_DOORBELL_INDEX = 0;
/** Poison flag: 0 = proxy alive, 1 = proxy is dead/unusable. Consumers fail fast (EIO) when set. */
export const OPFS_PROXY_GLOBAL_POISONED_INDEX = 1;
/** Handle-id allocator. The proxy increments this on each successful open to mint a fresh handle id. */
export const OPFS_PROXY_GLOBAL_HANDLE_ALLOC_INDEX = 2;
/** First index of the per-handle version-counter block (bumped on every write/truncate). */
const OPFS_PROXY_GLOBAL_VERSION_BASE_INDEX = 8;
/**
 * Number of per-handle version counters. Handle ids are allocated 1..MAX_HANDLES and reused as files
 * close; a ROM workflow opens far fewer than this many files concurrently.
 */
export const OPFS_PROXY_MAX_HANDLES = 1024;

const GLOBAL_CONTROL_WORD_COUNT = OPFS_PROXY_GLOBAL_VERSION_BASE_INDEX + OPFS_PROXY_MAX_HANDLES + 1;

/** Index of a handle's version counter within the global control array. */
export function opfsProxyVersionIndex(handleId: number): number {
  return OPFS_PROXY_GLOBAL_VERSION_BASE_INDEX + (handleId % OPFS_PROXY_MAX_HANDLES);
}

// --- Serializable transfer (postMessage-able; SharedArrayBuffers are shared, not copied) ----------

export interface OpfsProxyChannelTransfer {
  globalControl: SharedArrayBuffer;
  /** Per-slot control buffers; index i pairs with slotData[i]. */
  slotControls: SharedArrayBuffer[];
  /** Per-slot data buffers; index i pairs with slotControls[i]. */
  slotData: SharedArrayBuffer[];
}

/** A live, view-attached channel usable by either side. */
export interface OpfsProxyChannel {
  global: Int32Array<SharedArrayBuffer>;
  slots: OpfsProxyChannelSlot[];
  transfer: OpfsProxyChannelTransfer;
}

export interface OpfsProxyChannelSlot {
  control: Int32Array<SharedArrayBuffer>;
  data: Uint8Array<SharedArrayBuffer>;
}

/**
 * Allocate a fresh channel. `slotCount` should cover the maximum number of WASM threads that may be
 * mid-I/O at once (the main runner plus the spawned thread-pool budget); consumers CAS-acquire an
 * idle slot, so under-provisioning only adds contention, never incorrectness.
 */
export function createOpfsProxyChannel(slotCount: number): OpfsProxyChannel {
  const count = Math.max(1, Math.floor(slotCount));
  const globalControl = new SharedArrayBuffer(GLOBAL_CONTROL_WORD_COUNT * Int32Array.BYTES_PER_ELEMENT);
  const slotControls: SharedArrayBuffer[] = [];
  const slotData: SharedArrayBuffer[] = [];
  for (let i = 0; i < count; i += 1) {
    slotControls.push(new SharedArrayBuffer(OPFS_PROXY_CONTROL_WORD_COUNT * Int32Array.BYTES_PER_ELEMENT));
    slotData.push(new SharedArrayBuffer(OPFS_PROXY_DATA_BUFFER_BYTES));
  }
  const transfer: OpfsProxyChannelTransfer = { globalControl, slotControls, slotData };
  return attachOpfsProxyChannel(transfer);
}

/** Attach typed-array views over a transferred channel (called on the proxy worker and each thread). */
export function attachOpfsProxyChannel(transfer: OpfsProxyChannelTransfer): OpfsProxyChannel {
  const global = new Int32Array(transfer.globalControl);
  const slots: OpfsProxyChannelSlot[] = transfer.slotControls.map((control, index) => {
    const dataBuffer = transfer.slotData[index];
    if (!dataBuffer) {
      throw new Error(`OPFS proxy channel slot ${index} is missing its data buffer`);
    }
    return {
      control: new Int32Array(control),
      data: new Uint8Array(dataBuffer),
    };
  });
  return { global, slots, transfer };
}
