import {
  VIRTUAL_FILE_CONTROL_BYTES_READ_INDEX as CONTROL_BYTES_READ_INDEX,
  VIRTUAL_FILE_CONTROL_WORD_COUNT as CONTROL_LENGTH,
  VIRTUAL_FILE_CONTROL_LENGTH_INDEX as CONTROL_LENGTH_INDEX,
  VIRTUAL_FILE_CONTROL_OFFSET_HIGH_INDEX as CONTROL_OFFSET_HIGH_INDEX,
  VIRTUAL_FILE_CONTROL_OFFSET_LOW_INDEX as CONTROL_OFFSET_LOW_INDEX,
  VIRTUAL_FILE_STATE_DONE as CONTROL_STATE_DONE,
  VIRTUAL_FILE_CONTROL_STATE_INDEX as CONTROL_STATE_INDEX,
  VIRTUAL_FILE_STATE_PRODUCER_READING as CONTROL_STATE_READING,
  VIRTUAL_FILE_STATE_REQUESTED as CONTROL_STATE_REQUESTED,
  VIRTUAL_FILE_STATUS_ERROR as CONTROL_STATUS_ERROR,
  VIRTUAL_FILE_CONTROL_STATUS_INDEX as CONTROL_STATUS_INDEX,
  VIRTUAL_FILE_STATUS_OK as CONTROL_STATUS_OK,
} from "rom-weaver-wasm/browser-virtual-file-protocol";

type BrowserVirtualFileSource = Blob | Uint8Array | ArrayBuffer;

type BrowserVirtualFileSlot = {
  controlBuffer: SharedArrayBuffer;
  dataBuffer: SharedArrayBuffer;
};

type BrowserVirtualFileProxy = {
  id: string;
  maxChunkSize: number;
  size: number;
  slots: BrowserVirtualFileSlot[];
};

type BrowserVirtualFile = {
  path: string;
  proxy?: BrowserVirtualFileProxy;
  source?: BrowserVirtualFileSource;
};
type AtomicsWaitAsyncResult = {
  async: boolean;
  value: "not-equal" | "timed-out" | Promise<"ok" | "not-equal" | "timed-out">;
};
type AtomicsWithWaitAsync = typeof Atomics & {
  waitAsync?: (typedArray: Int32Array, index: number, value: number, timeout?: number) => AtomicsWaitAsyncResult;
};
type AtomicsWaitAsync = NonNullable<AtomicsWithWaitAsync["waitAsync"]>;

const activeVirtualFiles = new Map<string, BrowserVirtualFile>();
const VIRTUAL_FILE_MIN_CHUNK_SIZE = 256 * 1024;
// Safari pays a high fixed per-call cost on Blob.slice().arrayBuffer(), so fewer/larger reads win.
// The chunk ceiling caps a single transfer; the per-file SAB budget caps total in-flight bytes and
// therefore the slot count. At a 16 MiB budget a large input gets the full 4 slots even at the 4 MiB
// ceiling (4 x 4 MiB), versus the old 4 MiB budget which throttled large inputs to 2 x 2 MiB and
// halved read pipelining. SAB is standalone (not wasm linear memory); 16 MiB/file stays well clear
// of the wasm memory cap for the typical one-or-two concurrent inputs.
const VIRTUAL_FILE_MAX_CHUNK_SIZE = 4 * 1024 * 1024;
const VIRTUAL_FILE_MAX_SLOT_COUNT = 4;
const VIRTUAL_FILE_MAX_TOTAL_SAB_BYTES_PER_FILE = 16 * 1024 * 1024;
// Control-word layout and slot states are imported from rom-weaver-wasm/browser-virtual-file-protocol
// (aliased above to this file's CONTROL_* vocabulary) so the producer and the WASM consumer can never
// disagree on the wire format. CONTROL_STATE_READING (the producer's in-flight marker) is deliberately
// a distinct value from the consumer's LOCKED slot-acquire marker; both are defined in that one module
// so the no-alias invariant is enforced in a single place. See docs/browser-concurrency.md.
let virtualFileId = 0;

const getVirtualSourceSize = (source: BrowserVirtualFileSource) =>
  source instanceof Uint8Array || source instanceof ArrayBuffer ? source.byteLength : source.size;

const getVirtualSourceKind = (source: BrowserVirtualFileSource) => {
  if (typeof File !== "undefined" && source instanceof File) return "file";
  if (typeof Blob !== "undefined" && source instanceof Blob) return "blob";
  if (source instanceof Uint8Array) return "uint8array";
  if (source instanceof ArrayBuffer) return "arraybuffer";
  return typeof source;
};

const canUseDirectVirtualFileSource = (source: BrowserVirtualFileSource) =>
  typeof Blob !== "undefined" && source instanceof Blob;

const emitVirtualFileTrace = (message: string, details?: Record<string, unknown>) => {
  if (typeof console === "undefined") return;
  const log = typeof console.debug === "function" ? console.debug : console.log;
  log.call(console, `${new Date().toISOString()} [rom-weaver trace] browser-virtual-files: ${message}`, details || {});
};

const clampInteger = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, Math.trunc(value)));

const resolveVirtualFileLayout = (sourceSize: number) => {
  const normalizedSize = Number.isFinite(sourceSize) && sourceSize > 0 ? Math.floor(sourceSize) : 1;
  const chunkSize = clampInteger(
    Math.ceil(normalizedSize / VIRTUAL_FILE_MAX_SLOT_COUNT),
    VIRTUAL_FILE_MIN_CHUNK_SIZE,
    VIRTUAL_FILE_MAX_CHUNK_SIZE,
  );
  const maxSlotsByBudget = Math.max(1, Math.floor(VIRTUAL_FILE_MAX_TOTAL_SAB_BYTES_PER_FILE / chunkSize));
  const slotCount = clampInteger(
    Math.ceil(normalizedSize / chunkSize),
    1,
    Math.min(VIRTUAL_FILE_MAX_SLOT_COUNT, maxSlotsByBudget),
  );
  return { chunkSize, slotCount };
};

const getAtomicsWaitAsync = (): AtomicsWaitAsync => {
  const waitAsync = (Atomics as AtomicsWithWaitAsync).waitAsync;
  if (typeof waitAsync !== "function") {
    throw new Error("Direct browser file inputs require Atomics.waitAsync support");
  }
  return waitAsync;
};

const registerBrowserVirtualFile = ({
  path,
  source,
}: {
  path: string;
  source: BrowserVirtualFileSource;
}): (() => void) => {
  const sourceSize = getVirtualSourceSize(source);
  const sourceKind = getVirtualSourceKind(source);
  emitVirtualFileTrace("register requested", {
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    hasAtomicsWaitAsync: typeof (Atomics as AtomicsWithWaitAsync).waitAsync === "function",
    hasSharedArrayBuffer: typeof SharedArrayBuffer === "function",
    path,
    sourceKind,
    sourceSize,
  });
  if (canUseDirectVirtualFileSource(source)) {
    const file: BrowserVirtualFile = {
      path,
      source,
    };
    activeVirtualFiles.set(path, file);
    emitVirtualFileTrace("registered direct virtual file", {
      path,
      sourceKind,
      sourceSize,
    });
    return () => {
      emitVirtualFileTrace("unregistered direct virtual file", {
        path,
        sourceKind,
        sourceSize,
      });
      if (activeVirtualFiles.get(path) === file) activeVirtualFiles.delete(path);
    };
  }
  if (typeof SharedArrayBuffer !== "function") {
    emitVirtualFileTrace("virtual input registration failed", {
      path,
      reason: "missing-sharedarraybuffer",
      sourceKind,
      sourceSize,
    });
    throw new Error("Direct browser file inputs require SharedArrayBuffer support");
  }
  let waitAsync: AtomicsWaitAsync;
  try {
    waitAsync = getAtomicsWaitAsync();
  } catch (error) {
    emitVirtualFileTrace("virtual input registration failed", {
      path,
      reason: "missing-atomics-waitasync",
      sourceKind,
      sourceSize,
    });
    throw error;
  }
  const { chunkSize, slotCount } = resolveVirtualFileLayout(sourceSize);
  const id = `virtual-file-${++virtualFileId}-${Math.random().toString(16).slice(2)}`;
  const slots = Array.from({ length: slotCount }, () => ({
    controlBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * CONTROL_LENGTH),
    dataBuffer: new SharedArrayBuffer(chunkSize),
  }));
  const file: BrowserVirtualFile = {
    path,
    proxy: {
      id,
      maxChunkSize: chunkSize,
      size: sourceSize,
      slots,
    },
  };
  emitVirtualFileTrace("registering shared proxy virtual file", {
    chunkSize,
    id,
    path,
    slotCount,
    sourceKind,
    sourceSize,
  });
  let closed = false;
  for (const slot of slots)
    void runVirtualFileSlotPump(source, slot, waitAsync, () => closed).catch(() => {
      failVirtualFileSlot(slot);
    });
  activeVirtualFiles.set(path, file);
  return () => {
    closed = true;
    for (const slot of slots) {
      const control = new Int32Array(slot.controlBuffer);
      Atomics.notify(control, CONTROL_STATE_INDEX, 1);
    }
    emitVirtualFileTrace("unregistered shared proxy virtual file", {
      id,
      path,
      sourceKind,
      sourceSize,
    });
    if (activeVirtualFiles.get(path) === file) activeVirtualFiles.delete(path);
  };
};

const getActiveBrowserVirtualFiles = (): BrowserVirtualFile[] =>
  Array.from(activeVirtualFiles.values()).map((file) => ({ ...file }));

const runVirtualFileSlotPump = async (
  source: BrowserVirtualFileSource,
  slot: BrowserVirtualFileSlot,
  waitAsync: AtomicsWaitAsync,
  isClosed: () => boolean,
): Promise<void> => {
  const control = new Int32Array(slot.controlBuffer);
  const data = new Uint8Array(slot.dataBuffer);
  while (!isClosed()) {
    const state = Atomics.load(control, CONTROL_STATE_INDEX);
    if (state !== CONTROL_STATE_REQUESTED) {
      await waitForVirtualFileSlotChange(control, state, waitAsync);
      continue;
    }
    if (
      Atomics.compareExchange(control, CONTROL_STATE_INDEX, CONTROL_STATE_REQUESTED, CONTROL_STATE_READING) !==
      CONTROL_STATE_REQUESTED
    )
      continue;
    await respondToVirtualFileRead(source, control, data);
  }
};

const waitForVirtualFileSlotChange = async (
  control: Int32Array,
  state: number,
  waitAsync: AtomicsWaitAsync,
): Promise<void> => {
  const result = waitAsync(control, CONTROL_STATE_INDEX, state, 1000);
  if (result.async) await result.value;
};

const failVirtualFileSlot = (slot: BrowserVirtualFileSlot) => {
  const control = new Int32Array(slot.controlBuffer);
  Atomics.store(control, CONTROL_BYTES_READ_INDEX, 0);
  Atomics.store(control, CONTROL_STATUS_INDEX, CONTROL_STATUS_ERROR);
  Atomics.store(control, CONTROL_STATE_INDEX, CONTROL_STATE_DONE);
  Atomics.notify(control, CONTROL_STATE_INDEX, 1);
};

const respondToVirtualFileRead = async (
  source: BrowserVirtualFileSource,
  control: Int32Array,
  data: Uint8Array,
): Promise<void> => {
  let bytes: Uint8Array | null = null;
  let bytesRead = 0;
  let status = CONTROL_STATUS_OK;
  try {
    const offset =
      (Atomics.load(control, CONTROL_OFFSET_LOW_INDEX) >>> 0) +
      (Atomics.load(control, CONTROL_OFFSET_HIGH_INDEX) >>> 0) * 2 ** 32;
    const length = Math.max(0, Math.min(Atomics.load(control, CONTROL_LENGTH_INDEX), data.byteLength));
    bytes = await readVirtualSource(source, offset, length);
    bytesRead = Math.min(bytes.byteLength, length);
  } catch (_error) {
    status = CONTROL_STATUS_ERROR;
    bytes = null;
    bytesRead = 0;
  }
  // Only publish if this pump still owns the slot (state READING). If the consumer abandoned the
  // request (read timeout) the slot is no longer READING, so discard rather than copy stale bytes
  // into the shared buffer where a later request that reused the slot could read them.
  if (Atomics.load(control, CONTROL_STATE_INDEX) !== CONTROL_STATE_READING) return;
  if (bytes && bytesRead > 0) data.set(bytes.subarray(0, bytesRead));
  Atomics.store(control, CONTROL_BYTES_READ_INDEX, bytesRead);
  Atomics.store(control, CONTROL_STATUS_INDEX, status);
  Atomics.store(control, CONTROL_STATE_INDEX, CONTROL_STATE_DONE);
  Atomics.notify(control, CONTROL_STATE_INDEX, 1);
};

const readVirtualSource = async (
  source: BrowserVirtualFileSource,
  offset: number,
  length: number,
): Promise<Uint8Array> => {
  if (length <= 0) return new Uint8Array();
  if (source instanceof Uint8Array) return source.subarray(offset, offset + length);
  if (source instanceof ArrayBuffer)
    return new Uint8Array(source, offset, Math.min(length, source.byteLength - offset));
  return new Uint8Array(await source.slice(offset, offset + length).arrayBuffer());
};

export type { BrowserVirtualFile };
export { getActiveBrowserVirtualFiles, registerBrowserVirtualFile };
