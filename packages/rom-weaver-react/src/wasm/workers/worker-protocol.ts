import type {
  RomWeaverBrowserOpfsOptions,
  RomWeaverBrowserOpfsRunOptions,
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunResult,
  RomWeaverWorkerSerializedError,
} from "../rom-weaver-types.d.ts";

export const WORKER_REQUEST_TYPES = ["init", "run", "runJson", "dispose"];

export const WORKER_RESPONSE_TYPES = [
  "ready",
  "result",
  "event",
  "nonJsonLine",
  "traceEvent",
  "traceNonJsonLine",
  "disposed",
  "error",
] as const;

export interface RomWeaverWorkerStreamChannelOptions {
  __streamBroadcastChannelName?: string;
  __streamRequestId?: number;
}

export type RomWeaverWorkerInitOptions = RomWeaverBrowserOpfsOptions;

export type RomWeaverWorkerRunOptions = RomWeaverBrowserOpfsRunOptions & RomWeaverWorkerStreamChannelOptions;

export interface RomWeaverWorkerInitRequest {
  type: "init";
  requestId?: number;
  mode?: "browser-opfs";
  options?: RomWeaverWorkerInitOptions;
}

export interface RomWeaverWorkerRunRequest {
  type: "run";
  requestId?: number;
  request: RomWeaverRunInput;
  options?: RomWeaverWorkerRunOptions;
}

export type RomWeaverWorkerRunJsonOptions<TEvent = RomWeaverRunJsonEvent, TTraceEvent = unknown> = Omit<
  RomWeaverRunJsonOptions<TEvent, TTraceEvent>,
  "onEvent" | "onNonJsonLine" | "onTraceEvent" | "onTraceNonJsonLine"
> &
  RomWeaverBrowserOpfsRunOptions &
  RomWeaverWorkerStreamChannelOptions;

export interface RomWeaverWorkerRunJsonRequest {
  type: "runJson";
  requestId?: number;
  request: RomWeaverRunInput;
  options?: RomWeaverWorkerRunJsonOptions<unknown, unknown>;
}

export interface RomWeaverWorkerDisposeRequest {
  type: "dispose";
  requestId?: number;
}

export type RomWeaverWorkerRequest =
  | RomWeaverWorkerInitRequest
  | RomWeaverWorkerRunRequest
  | RomWeaverWorkerRunJsonRequest
  | RomWeaverWorkerDisposeRequest;

export interface RomWeaverWorkerReadyMessage {
  type: "ready";
  requestId: number | null;
  mode: string;
  threaded: boolean;
  wasmUrl: string | null;
}

export interface RomWeaverWorkerResultMessage {
  type: "result";
  requestId: number | null;
  operation: "run" | "runJson";
  result: RomWeaverRunResult | RomWeaverRunJsonResult<unknown, unknown>;
}

export interface RomWeaverWorkerProgressEventMessage {
  type: "event";
  requestId: number | null;
  event: RomWeaverRunJsonEvent;
}

export interface RomWeaverWorkerNonJsonLineMessage {
  type: "nonJsonLine";
  requestId: number | null;
  line: string;
}

export interface RomWeaverWorkerTraceEventMessage {
  type: "traceEvent";
  requestId: number | null;
  event: unknown;
}

export interface RomWeaverWorkerTraceNonJsonLineMessage {
  type: "traceNonJsonLine";
  requestId: number | null;
  line: string;
}

export interface RomWeaverWorkerDisposedMessage {
  type: "disposed";
  requestId: number | null;
}

export interface RomWeaverWorkerErrorMessage {
  type: "error";
  requestId: number | null;
  error: RomWeaverWorkerSerializedError;
}

/**
 * Mid-run interactive selection request. The runner worker posts this when the wasm app needs the
 * user to pick a candidate, then blocks on `control` (a SharedArrayBuffer-backed Int32Array) until
 * the main thread writes the chosen index at slot 1 and sets slot 0 to 1 with `Atomics.notify`.
 */
export interface RomWeaverWorkerSelectRequestMessage {
  type: "selectRequest";
  requestId: number | null;
  request: string;
  control: ArrayBufferLike;
}

/**
 * Layout of the `control` Int32Array backing a {@link RomWeaverWorkerSelectRequestMessage} handshake.
 * Slot 0 is the readiness flag the runner worker blocks on; slot 1 carries the chosen index. The
 * runner stores {@link SELECT_REQUEST_PENDING} then waits; the main thread writes the index and sets
 * the flag to {@link SELECT_REQUEST_READY} before `Atomics.notify`.
 */
export const SELECT_REQUEST_CONTROL_LENGTH = 2;
export const SELECT_REQUEST_READY_INDEX = 0;
export const SELECT_REQUEST_RESULT_INDEX = 1;
export const SELECT_REQUEST_PENDING = 0;
export const SELECT_REQUEST_READY = 1;
/** Sentinel result index meaning "no selection" — cancelled or no handler registered. */
export const SELECT_REQUEST_CANCEL_INDEX = -1;

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
