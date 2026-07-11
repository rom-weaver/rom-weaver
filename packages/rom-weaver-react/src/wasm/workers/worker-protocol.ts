import type {
  RomWeaverBrowserOpfsOptions,
  RomWeaverBrowserOpfsRunOptions,
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverWorkerSerializedError,
} from "../rom-weaver-types.d.ts";

interface RomWeaverWorkerStreamChannelOptions {
  __streamBroadcastChannelName?: string;
  __streamRequestId?: number;
}

export type RomWeaverWorkerInitOptions = RomWeaverBrowserOpfsOptions;

export type RomWeaverWorkerRunOptions = RomWeaverBrowserOpfsRunOptions & RomWeaverWorkerStreamChannelOptions;

interface RomWeaverWorkerInitRequest {
  type: "init";
  requestId?: number;
  mode?: "browser-opfs";
  options?: RomWeaverWorkerInitOptions;
}

export type RomWeaverWorkerRunJsonOptions<TEvent = RomWeaverRunJsonEvent, TTraceEvent = unknown> = Omit<
  RomWeaverRunJsonOptions<TEvent, TTraceEvent>,
  "onEvent" | "onNonJsonLine" | "onTraceEvent" | "onTraceNonJsonLine"
> &
  RomWeaverBrowserOpfsRunOptions &
  RomWeaverWorkerStreamChannelOptions;

interface RomWeaverWorkerRunJsonRequest {
  type: "runJson";
  requestId?: number;
  request: RomWeaverRunInput;
  options?: RomWeaverWorkerRunJsonOptions<unknown, unknown>;
}

interface RomWeaverWorkerDisposeRequest {
  type: "dispose";
  requestId?: number;
}

export type RomWeaverWorkerRequest =
  | RomWeaverWorkerInitRequest
  | RomWeaverWorkerRunJsonRequest
  | RomWeaverWorkerDisposeRequest;

interface RomWeaverWorkerReadyMessage {
  type: "ready";
  requestId: number | null;
  mode: string;
  threaded: boolean;
  wasmUrl: string | null;
}

interface RomWeaverWorkerResultMessage {
  type: "result";
  requestId: number | null;
  operation: "runJson";
  result: RomWeaverRunJsonResult<unknown, unknown>;
}

interface RomWeaverWorkerProgressEventMessage {
  type: "event";
  requestId: number | null;
  event: RomWeaverRunJsonEvent;
}

interface RomWeaverWorkerNonJsonLineMessage {
  type: "nonJsonLine";
  requestId: number | null;
  line: string;
}

interface RomWeaverWorkerTraceEventMessage {
  type: "traceEvent";
  requestId: number | null;
  event: unknown;
}

interface RomWeaverWorkerTraceNonJsonLineMessage {
  type: "traceNonJsonLine";
  requestId: number | null;
  line: string;
}

interface RomWeaverWorkerDisposedMessage {
  type: "disposed";
  requestId: number | null;
}

interface RomWeaverWorkerErrorMessage {
  type: "error";
  requestId: number | null;
  error: RomWeaverWorkerSerializedError;
}

/**
 * Mid-run interactive selection request. The runner worker posts this when the wasm app needs the
 * user to pick one or more candidates, then blocks on `control` (a SharedArrayBuffer-backed
 * Int32Array) until the main thread writes the result and wakes it with `Atomics.notify`. The same
 * message serves single- and multi-select prompts; the embedded `request` JSON carries a
 * `mode: "single" | "many"` discriminant that the UI routes on. `request` is the UTF-8 JSON the
 * wasm prompter emitted (`{mode, heading, candidates:[{value,label,size}]}`).
 */
interface RomWeaverWorkerSelectRequestMessage {
  type: "selectRequest";
  requestId: number | null;
  request: string;
  control: ArrayBufferLike;
}

/**
 * Layout of the `control` Int32Array backing a {@link RomWeaverWorkerSelectRequestMessage} handshake.
 * It is a 2-slot header followed by a variable-length payload region of selected indices:
 *
 * ```
 *   slot 0                       : readiness flag (PENDING -> READY)
 *   slot 1                       : selected count (>= 0), or SELECT_REQUEST_CANCEL_COUNT (-1) to cancel
 *   slots 2 .. 2 + count         : the chosen 0-based indices (only `count` slots are meaningful)
 * ```
 *
 * The runner sizes the buffer to {@link SELECT_REQUEST_HEADER_LENGTH} + (candidate count) so a
 * multi-select reply can carry at most one index per candidate. It stores
 * {@link SELECT_REQUEST_PENDING} at the flag and {@link SELECT_REQUEST_CANCEL_COUNT} at the count,
 * then waits. The main thread writes the indices into the payload region (which begins at
 * {@link SELECT_REQUEST_HEADER_LENGTH}), sets the count, flips the flag to
 * {@link SELECT_REQUEST_READY}, and calls `Atomics.notify`. Single-select prompts use the same
 * protocol with a count of 1 (or cancel).
 */
export const SELECT_REQUEST_HEADER_LENGTH = 2;
export const SELECT_REQUEST_READY_INDEX = 0;
export const SELECT_REQUEST_COUNT_INDEX = 1;
export const SELECT_REQUEST_PENDING = 0;
export const SELECT_REQUEST_READY = 1;
/** Sentinel count meaning "no selection" - cancelled or no handler registered. */
export const SELECT_REQUEST_CANCEL_COUNT = -1;

export type RomWeaverWorkerResponse =
  | RomWeaverWorkerReadyMessage
  | RomWeaverWorkerResultMessage
  | RomWeaverWorkerProgressEventMessage
  | RomWeaverWorkerNonJsonLineMessage
  | RomWeaverWorkerTraceEventMessage
  | RomWeaverWorkerTraceNonJsonLineMessage
  | RomWeaverWorkerDisposedMessage
  | RomWeaverWorkerSelectRequestMessage
  | RomWeaverWorkerErrorMessage;

export type RomWeaverWorkerStreamMessage =
  | RomWeaverWorkerProgressEventMessage
  | RomWeaverWorkerNonJsonLineMessage
  | RomWeaverWorkerTraceEventMessage
  | RomWeaverWorkerTraceNonJsonLineMessage;
