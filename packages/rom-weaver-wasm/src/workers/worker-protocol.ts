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
 * Mid-run selection request. The worker blocks on `control` until the main
 * thread writes indices and notifies it. JSON `mode` routes single vs multi UI.
 */
interface RomWeaverWorkerSelectRequestMessage {
  type: "selectRequest";
  requestId: number | null;
  request: string;
  control: ArrayBufferLike;
}

/**
 * Shared selection-control layout: two header slots, then selected indices.
 *
 * ```
 *   slot 0                       : readiness flag (PENDING -> READY)
 *   slot 1                       : selected count (>= 0), or SELECT_REQUEST_CANCEL_COUNT (-1) to cancel
 *   slots 2 .. 2 + count         : the chosen 0-based indices (only `count` slots are meaningful)
 * ```
 *
 * The runner initializes PENDING/cancel, the main thread writes payload and
 * count, flips READY, then notifies. Single-select uses count 1.
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
