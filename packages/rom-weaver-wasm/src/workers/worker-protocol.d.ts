import type {
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunOptions,
  RomWeaverRunResult,
  RomWeaverWorkerSerializedError,
} from '../rom-weaver-types.d.ts';

export const WORKER_REQUEST_TYPES: readonly ['init', 'run', 'runJson', 'dispose'];
export const WORKER_RESPONSE_TYPES: readonly ['ready', 'result', 'event', 'nonJsonLine', 'traceEvent', 'traceNonJsonLine', 'disposed', 'error'];

export interface RomWeaverWorkerInitRequest {
  type: 'init';
  requestId: number;
  mode?: 'browser-opfs';
  options?: Record<string, unknown>;
}

export interface RomWeaverWorkerRunRequest {
  type: 'run';
  requestId: number;
  request: RomWeaverRunInput;
  options?: RomWeaverRunOptions & Record<string, unknown>;
}

export interface RomWeaverWorkerRunJsonRequest {
  type: 'runJson';
  requestId: number;
  request: RomWeaverRunInput;
  options?: Omit<RomWeaverRunJsonOptions<unknown, unknown>, 'onEvent' | 'onNonJsonLine' | 'onTraceEvent' | 'onTraceNonJsonLine'> & Record<string, unknown>;
}

export interface RomWeaverWorkerDisposeRequest {
  type: 'dispose';
  requestId: number;
}

export type RomWeaverWorkerRequest =
  | RomWeaverWorkerInitRequest
  | RomWeaverWorkerRunRequest
  | RomWeaverWorkerRunJsonRequest
  | RomWeaverWorkerDisposeRequest;

export interface RomWeaverWorkerReadyMessage {
  type: 'ready';
  requestId: number;
  mode: string;
}

export interface RomWeaverWorkerResultMessage {
  type: 'result';
  requestId: number;
  operation: 'run' | 'runJson';
  result: RomWeaverRunResult | RomWeaverRunJsonResult<unknown, unknown>;
}

export interface RomWeaverWorkerProgressEventMessage {
  type: 'event';
  requestId: number;
  event: RomWeaverRunJsonEvent;
}

export interface RomWeaverWorkerNonJsonLineMessage {
  type: 'nonJsonLine';
  requestId: number;
  line: string;
}

export interface RomWeaverWorkerTraceEventMessage {
  type: 'traceEvent';
  requestId: number;
  event: unknown;
}

export interface RomWeaverWorkerTraceNonJsonLineMessage {
  type: 'traceNonJsonLine';
  requestId: number;
  line: string;
}

export interface RomWeaverWorkerDisposedMessage {
  type: 'disposed';
  requestId: number;
}

export interface RomWeaverWorkerErrorMessage {
  type: 'error';
  requestId: number | null;
  error: RomWeaverWorkerSerializedError;
}

export type RomWeaverWorkerResponse =
  | RomWeaverWorkerReadyMessage
  | RomWeaverWorkerResultMessage
  | RomWeaverWorkerProgressEventMessage
  | RomWeaverWorkerNonJsonLineMessage
  | RomWeaverWorkerTraceEventMessage
  | RomWeaverWorkerTraceNonJsonLineMessage
  | RomWeaverWorkerDisposedMessage
  | RomWeaverWorkerErrorMessage;
