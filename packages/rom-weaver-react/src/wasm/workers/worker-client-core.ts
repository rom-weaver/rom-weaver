import type {
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunResult,
  RomWeaverWorkerError,
  RomWeaverWorkerErrorKind,
  RomWeaverWorkerSerializedError,
} from "../rom-weaver-types.d.ts";
import { readWorkerErrorContext, resolveWorkerErrorKind } from "./worker-error-utils.ts";
import type {
  RomWeaverWorkerRequest,
  RomWeaverWorkerResponse,
  RomWeaverWorkerRunJsonOptions,
  RomWeaverWorkerRunOptions,
  RomWeaverWorkerStreamMessage,
} from "./worker-protocol.ts";
import {
  SELECT_REQUEST_CANCEL_INDEX,
  SELECT_REQUEST_READY,
  SELECT_REQUEST_READY_INDEX,
  SELECT_REQUEST_RESULT_INDEX,
} from "./worker-protocol.ts";

type WorkerStreamHandlers<TEvent = RomWeaverRunJsonEvent, TTraceEvent = unknown> = Pick<
  RomWeaverRunJsonOptions<TEvent, TTraceEvent>,
  "onEvent" | "onNonJsonLine" | "onTraceEvent" | "onTraceNonJsonLine"
>;

type PendingRequest = {
  onEvent: ((event: RomWeaverRunJsonEvent) => void) | null;
  onNonJsonLine: ((line: string) => void) | null;
  onTraceEvent: ((event: unknown) => void) | null;
  onTraceNonJsonLine: ((line: string) => void) | null;
  reject: (error: unknown) => void;
  resolve: (value: unknown) => void;
};

type TraceRecord = Record<string, unknown>;

type WorkerTransport = {
  offError: (worker: Worker, listener: EventListener) => void;
  offExit?: (worker: Worker, listener: (code: unknown) => void) => void;
  offMessage: (worker: Worker, listener: EventListener) => void;
  offMessageError?: (worker: Worker, listener: EventListener) => void;
  onError: (worker: Worker, listener: EventListener) => void;
  onExit?: (worker: Worker, listener: (code: unknown) => void) => void;
  onMessage: (worker: Worker, listener: EventListener) => void;
  onMessageError?: (worker: Worker, listener: EventListener) => void;
  postMessage: (worker: Worker, message: unknown) => void;
  readMessage: (event: unknown) => unknown;
  terminate: (worker: Worker) => void;
  toError: (event: unknown) => Error;
  toExitError?: (code: unknown) => Error | undefined;
  toMessageError?: (event: unknown) => Error;
};

export class RomWeaverWorkerClientCore {
  protected worker: Worker;
  protected _transport: WorkerTransport;
  protected _nextRequestId: number;
  protected _pending: Map<number, PendingRequest>;
  protected _disposed: boolean;
  protected _onSelect?: (request: string) => Promise<number> | number;

  constructor(worker: Worker, transport: WorkerTransport) {
    this.worker = worker;
    this._transport = transport;
    this._nextRequestId = 1;
    this._pending = new Map();
    this._disposed = false;

    this._onMessage = this._onMessage.bind(this);
    this._onError = this._onError.bind(this);
    this._onMessageError = this._onMessageError.bind(this);
    this._onExit = this._onExit.bind(this);

    this._transport.onMessage(this.worker, this._onMessage);
    this._transport.onError(this.worker, this._onError);
    this._transport.onMessageError?.(this.worker, this._onMessageError);
    this._transport.onExit?.(this.worker, this._onExit);
  }

  /**
   * Register the interactive selection handler invoked when the worker requests a candidate pick.
   * It receives the JSON request (`{heading, candidates:[{value,label}]}`) and returns the chosen
   * 0-based index (or a negative value / rejection to cancel). Without a handler, prompts cancel.
   */
  setSelectionHandler(handler?: (request: string) => Promise<number> | number) {
    this._onSelect = handler;
  }

  run(request: RomWeaverRunInput, options: RomWeaverWorkerRunOptions = {}) {
    return this._send<RomWeaverRunResult>({ options, request, type: "run" });
  }

  runJson<TEvent = RomWeaverRunJsonEvent, TTraceEvent = unknown>(
    request: RomWeaverRunInput,
    options: RomWeaverRunJsonOptions<TEvent, TTraceEvent> & RomWeaverWorkerRunOptions = {},
  ) {
    const { onEvent, onNonJsonLine, onTraceEvent, onTraceNonJsonLine, ...runOptions } = options ?? {};
    const workerOptions: RomWeaverWorkerRunJsonOptions<unknown, unknown> = runOptions;
    return this._send(
      { options: workerOptions, request, type: "runJson" },
      {
        // The worker protocol carries RomWeaverRunJsonEvent payloads on the wire; TEvent and
        // TTraceEvent are caller-level refinements, so erase them at the transport boundary.
        onEvent: onEvent as WorkerStreamHandlers["onEvent"],
        onNonJsonLine,
        onTraceEvent: onTraceEvent as WorkerStreamHandlers["onTraceEvent"],
        onTraceNonJsonLine,
      },
    ) as Promise<RomWeaverRunJsonResult<TEvent, TTraceEvent>>;
  }

  dispose() {
    return this._send<{ disposed: true }>({ type: "dispose" });
  }

  protected _send<TResponse = unknown>(
    payload: RomWeaverWorkerRequest,
    handlers: WorkerStreamHandlers = {},
  ): Promise<TResponse> {
    if (this._disposed) {
      // The worker was terminated; its listeners are gone and postMessage is a silent no-op, so a
      // new request would never settle. Reject eagerly instead of leaking a pending promise.
      return Promise.reject(toWorkerError(new Error("worker client has been terminated"), "worker"));
    }
    const requestId = this._nextRequestId;
    this._nextRequestId += 1;
    const streamChannel = createWorkerStreamChannel({
      handlers,
      payload,
      requestId,
    });

    return new Promise((resolve, reject) => {
      this._pending.set(requestId, {
        onEvent: typeof handlers.onEvent === "function" ? handlers.onEvent : null,
        onNonJsonLine: typeof handlers.onNonJsonLine === "function" ? handlers.onNonJsonLine : null,
        onTraceEvent: typeof handlers.onTraceEvent === "function" ? handlers.onTraceEvent : null,
        onTraceNonJsonLine: typeof handlers.onTraceNonJsonLine === "function" ? handlers.onTraceNonJsonLine : null,
        reject: (error: unknown) => {
          streamChannel?.close();
          reject(error);
        },
        resolve: (value: unknown) => {
          streamChannel?.close();
          resolve(value as TResponse);
        },
      });

      try {
        emitClientTrace(handlers, `[worker-client] send requestId=${requestId} ${summarizeRequestPayload(payload)}`);
        this._transport.postMessage(this.worker, { ...payload, requestId });
        emitClientTrace(handlers, `[worker-client] postMessage returned requestId=${requestId}`);
      } catch (error) {
        this._pending.delete(requestId);
        streamChannel?.close();
        emitClientTrace(
          handlers,
          `[worker-client] postMessage failed requestId=${requestId} error=${formatErrorForTrace(error)}`,
        );
        reject(toWorkerError(error, "worker"));
      }
    });
  }

  _onMessage(rawMessage: Event) {
    const message = this._transport.readMessage(rawMessage);
    if (!isWorkerResponseMessage(message)) {
      return;
    }

    const requestId = message.requestId;
    const pending = typeof requestId === "number" ? this._pending.get(requestId) : undefined;
    const deletePending = () => {
      if (typeof requestId === "number") this._pending.delete(requestId);
    };

    switch (message.type) {
      case "event":
        pending?.onEvent?.(message.event);
        return;
      case "nonJsonLine":
        pending?.onNonJsonLine?.(message.line);
        return;
      case "traceEvent":
        pending?.onTraceEvent?.(message.event);
        return;
      case "traceNonJsonLine":
        pending?.onTraceNonJsonLine?.(message.line);
        return;
      case "ready":
        deletePending();
        emitPendingTrace(
          pending,
          `[worker-client] ready requestId=${requestId} mode=${message.mode ?? ""} threaded=${Boolean(message.threaded)}`,
        );
        pending?.resolve({
          mode: message.mode,
          threaded: Boolean(message.threaded),
          wasmUrl: message.wasmUrl ?? null,
        });
        return;
      case "disposed":
        deletePending();
        emitPendingTrace(pending, `[worker-client] disposed requestId=${requestId}`);
        pending?.resolve({ disposed: true });
        return;
      case "result":
        deletePending();
        emitPendingTrace(
          pending,
          `[worker-client] result requestId=${requestId} operation=${message.operation ?? ""} ${summarizeWorkerResult(message.result)}`,
        );
        pending?.resolve(message.result);
        return;
      case "selectRequest": {
        // The runner worker is blocked on `control` waiting for the chosen index; resolve via the
        // registered selection handler (or cancel) and wake it with Atomics.notify.
        const control = new Int32Array(message.control as ArrayBufferLike);
        const respond = (index: number) => {
          const resolvedIndex = Number.isInteger(index) ? index : SELECT_REQUEST_CANCEL_INDEX;
          emitPendingTrace(
            pending,
            `[worker-client] selectRequest responding requestId=${requestId} selectedIndex=${resolvedIndex}${resolvedIndex < 0 ? " (cancelled)" : ""}`,
          );
          Atomics.store(control, SELECT_REQUEST_RESULT_INDEX, resolvedIndex);
          Atomics.store(control, SELECT_REQUEST_READY_INDEX, SELECT_REQUEST_READY);
          Atomics.notify(control, SELECT_REQUEST_READY_INDEX);
        };
        const handler = this._onSelect;
        emitPendingTrace(
          pending,
          `[worker-client] selectRequest received requestId=${requestId} ${summarizeSelectRequest(message.request)} handler=${typeof handler === "function" ? "present" : "missing"}`,
        );
        if (typeof handler !== "function") {
          respond(SELECT_REQUEST_CANCEL_INDEX);
          return;
        }
        Promise.resolve()
          .then(() => handler(message.request))
          .then((index) => respond(typeof index === "number" ? index : SELECT_REQUEST_CANCEL_INDEX))
          .catch(() => {
            emitPendingTrace(
              pending,
              `[worker-client] selectRequest handler rejected requestId=${requestId} — cancelling`,
            );
            respond(SELECT_REQUEST_CANCEL_INDEX);
          });
        return;
      }
      case "error":
        deletePending();
        if (!pending && (requestId === null || requestId === undefined)) {
          this._rejectAllPending(deserializeError(message.error), "worker unscoped error");
          return;
        }
        emitPendingTrace(
          pending,
          `[worker-client] error requestId=${requestId} ${summarizeSerializedError(message.error)}`,
        );
        pending?.reject(deserializeError(message.error));
        return;
      default:
        return;
    }
  }

  _onError(rawError: Event) {
    this._rejectAllPending(this._transport.toError(rawError), "worker error");
  }

  _onMessageError(rawError: Event) {
    const error = this._transport.toMessageError?.(rawError) ?? new Error("worker messageerror");
    this._rejectAllPending(error, "worker messageerror");
  }

  _onExit(code: unknown) {
    if (this._pending.size === 0) {
      return;
    }

    const error = this._transport.toExitError?.(code);
    if (error) {
      this._rejectAllPending(error, "worker exit");
    }
  }

  _rejectAllPending(error: unknown, reason = "worker rejected pending requests") {
    const normalizedError = toWorkerError(error, "worker");
    for (const pending of this._pending.values()) {
      emitPendingTrace(pending, `[worker-client] ${reason} ${formatErrorForTrace(normalizedError)}`);
      pending.reject(normalizedError);
    }
    this._pending.clear();
  }

  _shutdown(reason = "worker terminated") {
    this._disposed = true;
    this._detachListeners();
    this._rejectAllPending(new Error(reason));
  }

  _detachListeners() {
    this._transport.offMessage(this.worker, this._onMessage);
    this._transport.offError(this.worker, this._onError);
    this._transport.offMessageError?.(this.worker, this._onMessageError);
    this._transport.offExit?.(this.worker, this._onExit);
  }

  _terminateWorker() {
    return this._transport.terminate(this.worker);
  }
}

export function createBrowserWorkerTransport(): WorkerTransport {
  return {
    offError(worker, listener) {
      worker.removeEventListener("error", listener);
    },
    offMessage(worker, listener) {
      worker.removeEventListener("message", listener);
    },
    offMessageError(worker, listener) {
      worker.removeEventListener("messageerror", listener);
    },
    onError(worker, listener) {
      worker.addEventListener("error", listener);
    },
    onMessage(worker, listener) {
      worker.addEventListener("message", listener);
    },
    onMessageError(worker, listener) {
      worker.addEventListener("messageerror", listener);
    },
    postMessage(worker, message) {
      worker.postMessage(message);
    },
    readMessage(event) {
      return (event as MessageEvent).data;
    },
    terminate(worker) {
      worker.terminate();
    },
    toError(event) {
      const errorEvent = event as ErrorEvent | null | undefined;
      if (errorEvent?.error instanceof Error) {
        return errorEvent.error;
      }
      const messageParts = [];
      if (typeof errorEvent?.message === "string" && errorEvent.message.trim().length > 0) {
        messageParts.push(errorEvent.message.trim());
      }
      if (typeof errorEvent?.filename === "string" && errorEvent.filename.trim().length > 0) {
        const location = [
          errorEvent.filename,
          Number.isFinite(errorEvent?.lineno) ? String(errorEvent.lineno) : null,
          Number.isFinite(errorEvent?.colno) ? String(errorEvent.colno) : null,
        ]
          .filter(Boolean)
          .join(":");
        if (location.length > 0) {
          messageParts.push(`at ${location}`);
        }
      }
      return new Error(messageParts.join(" ") || "worker error");
    },
    toMessageError(event) {
      const errorEvent = event as MessageEvent | ErrorEvent | null | undefined;
      const message =
        errorEvent &&
        "message" in errorEvent &&
        typeof errorEvent.message === "string" &&
        errorEvent.message.trim().length > 0
          ? errorEvent.message.trim()
          : "worker messageerror";
      return new Error(message);
    },
  };
}

function isWorkerResponseMessage(value: unknown): value is RomWeaverWorkerResponse {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string";
}

function isWorkerStreamMessage(value: unknown): value is RomWeaverWorkerStreamMessage {
  if (!isWorkerResponseMessage(value)) return false;
  return (
    value.type === "event" ||
    value.type === "nonJsonLine" ||
    value.type === "traceEvent" ||
    value.type === "traceNonJsonLine"
  );
}

function createWorkerStreamChannel({
  handlers,
  payload,
  requestId,
}: {
  handlers: WorkerStreamHandlers;
  payload: RomWeaverWorkerRequest;
  requestId: number;
}) {
  if (payload?.type !== "runJson" || typeof BroadcastChannel !== "function" || !hasAnyStreamHandler(handlers)) {
    return null;
  }

  const name = `rom-weaver-wasm-stream:${Date.now()}:${Math.random().toString(16).slice(2)}:${requestId}`;
  const channel = new BroadcastChannel(name);
  channel.onmessage = (event) => {
    const message = event?.data;
    if (!isWorkerStreamMessage(message) || message.requestId !== requestId) return;
    try {
      dispatchStreamMessage(handlers, message);
    } catch {
      // A throwing user stream callback must not break the channel; the authoritative result
      // still arrives on the worker's result message.
    }
  };
  payload.options = {
    ...(payload.options ?? {}),
    __streamBroadcastChannelName: name,
    __streamRequestId: requestId,
  };

  return {
    close() {
      channel.close();
    },
  };
}

function hasAnyStreamHandler(handlers: WorkerStreamHandlers | null | undefined): boolean {
  return Boolean(
    typeof handlers?.onEvent === "function" ||
      typeof handlers?.onNonJsonLine === "function" ||
      typeof handlers?.onTraceEvent === "function" ||
      typeof handlers?.onTraceNonJsonLine === "function",
  );
}

function dispatchStreamMessage(handlers: WorkerStreamHandlers, message: RomWeaverWorkerStreamMessage) {
  switch (message.type) {
    case "event":
      handlers.onEvent?.(message.event);
      return;
    case "nonJsonLine":
      handlers.onNonJsonLine?.(message.line);
      return;
    case "traceEvent":
      handlers.onTraceEvent?.(message.event);
      return;
    case "traceNonJsonLine":
      handlers.onTraceNonJsonLine?.(message.line);
      return;
    default:
      return;
  }
}

function emitClientTrace(handlers: WorkerStreamHandlers | null | undefined, line: string): void {
  const onTraceNonJsonLine = typeof handlers?.onTraceNonJsonLine === "function" ? handlers.onTraceNonJsonLine : null;
  if (!onTraceNonJsonLine) return;
  try {
    onTraceNonJsonLine(line);
  } catch {
    // Trace callbacks are diagnostic only and must not affect worker execution.
  }
}

function emitPendingTrace(pending: PendingRequest | undefined, line: string): void {
  const onTraceNonJsonLine = typeof pending?.onTraceNonJsonLine === "function" ? pending.onTraceNonJsonLine : null;
  if (!onTraceNonJsonLine) return;
  try {
    onTraceNonJsonLine(line);
  } catch {
    // Trace callbacks are diagnostic only and must not affect worker execution.
  }
}

function summarizeRequestPayload(payload: RomWeaverWorkerRequest): string {
  const type = String(payload?.type ?? "unknown");
  const options = readPayloadOptions(payload);
  const stream = typeof options.__streamBroadcastChannelName === "string";
  const virtualFiles = summarizeVirtualFiles(options.virtualFiles);
  return [
    `type=${type}`,
    `command=${formatCommandForTrace(readPayloadCommand(payload))}`,
    `stream=${stream}`,
    `virtualFiles=${virtualFiles}`,
  ].join(" ");
}

function readPayloadOptions(payload: RomWeaverWorkerRequest): TraceRecord {
  if (!("options" in payload && payload.options) || typeof payload.options !== "object") return {};
  return payload.options as TraceRecord;
}

function readPayloadCommand(payload: RomWeaverWorkerRequest): unknown {
  if (!("request" in payload)) return null;
  const request = payload.request;
  if (!request || typeof request !== "object") return null;
  const record = request as TraceRecord;
  return record.command && typeof record.command === "object" ? record.command : request;
}

function summarizeWorkerResult(result: unknown): string {
  if (!result || typeof result !== "object") return "result=unknown";
  const record = result as TraceRecord;
  const parts = [];
  if (Object.hasOwn(record, "ok")) parts.push(`ok=${Boolean(record.ok)}`);
  if (Object.hasOwn(record, "exitCode")) parts.push(`exitCode=${String(record.exitCode)}`);
  if (Array.isArray(record.events)) parts.push(`events=${record.events.length}`);
  if (Array.isArray(record.nonJsonLines)) parts.push(`nonJsonLines=${record.nonJsonLines.length}`);
  if (Array.isArray(record.traceEvents)) parts.push(`traceEvents=${record.traceEvents.length}`);
  if (Array.isArray(record.traceNonJsonLines)) {
    parts.push(`traceNonJsonLines=${record.traceNonJsonLines.length}`);
  }
  return parts.length > 0 ? parts.join(" ") : "result=object";
}

function summarizeSelectRequest(request: unknown): string {
  if (typeof request !== "string") return "request=invalid";
  try {
    const parsed = JSON.parse(request) as TraceRecord;
    const heading = typeof parsed?.heading === "string" ? parsed.heading : "";
    const candidateCount = Array.isArray(parsed?.candidates) ? parsed.candidates.length : 0;
    return `heading="${heading}" candidates=${candidateCount}`;
  } catch {
    return `request=unparsable bytes=${request.length}`;
  }
}

function summarizeSerializedError(error: unknown): string {
  if (!error || typeof error !== "object") return `error=${String(error)}`;
  const record = error as Partial<RomWeaverWorkerSerializedError>;
  return [
    `name=${String(record.name ?? "Error")}`,
    `kind=${String(record.kind ?? "")}`,
    `message=${truncateForTrace(record.message ?? "")}`,
  ].join(" ");
}

function summarizeVirtualFiles(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "count=0";
  let proxyCount = 0;
  let directCount = 0;
  let totalBytes = 0;
  for (const entry of value) {
    const record = entry && typeof entry === "object" ? (entry as TraceRecord) : {};
    const source = record.source ?? record.file ?? record.blob ?? record.bytes ?? record.data ?? record.proxy;
    const proxy = record.proxy ?? (isTraceVirtualFileProxy(source) ? source : null);
    if (isTraceVirtualFileProxy(proxy)) {
      proxyCount += 1;
      totalBytes += Number(proxy.size) || 0;
      continue;
    }
    directCount += 1;
    const sourceRecord = source && typeof source === "object" ? (source as TraceRecord) : {};
    totalBytes += Number(sourceRecord.size ?? sourceRecord.byteLength ?? 0) || 0;
  }
  return `count=${value.length},proxy=${proxyCount},direct=${directCount},bytes=${totalBytes}`;
}

function isTraceVirtualFileProxy(value: unknown): value is { id: string; size: unknown; slots: unknown[] } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as TraceRecord).id === "string" &&
      Array.isArray((value as TraceRecord).slots) &&
      Number.isFinite(Number((value as TraceRecord).size)),
  );
}

function formatCommandForTrace(command: unknown): string {
  if (!command || typeof command !== "object") return "unknown";
  try {
    return truncateForTrace(JSON.stringify(toTraceValue(command)));
  } catch {
    return String((command as TraceRecord).type ?? "unknown");
  }
}

function toTraceValue(value: unknown): unknown {
  if (typeof value === "string") return basenameForTrace(value);
  if (Array.isArray(value)) return value.map((entry) => toTraceValue(entry));
  if (!value || typeof value !== "object") return value;
  const out: TraceRecord = {};
  for (const [key, entry] of Object.entries(value)) out[key] = toTraceValue(entry);
  return out;
}

function basenameForTrace(value: unknown): string {
  const text = String(value ?? "");
  if (!text.includes("/")) return text;
  return text.slice(text.lastIndexOf("/") + 1) || text;
}

function formatErrorForTrace(error: unknown): string {
  if (error instanceof Error) return `${error.name}:${truncateForTrace(error.message)}`;
  return truncateForTrace(String(error));
}

function truncateForTrace(value: unknown, maxLength = 180): string {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}...`;
}

function deserializeError(error: unknown): RomWeaverWorkerError {
  const record = error && typeof error === "object" ? (error as Partial<RomWeaverWorkerSerializedError>) : null;
  const out = new Error(
    record && typeof record.message === "string" ? record.message : "worker request failed",
  ) as RomWeaverWorkerError;

  if (record && typeof record.name === "string") {
    out.name = record.name;
  }
  if (record && typeof record.stack === "string") {
    out.stack = record.stack;
  }
  if (record && record.cause !== undefined) {
    out.cause = deserializeErrorCause(record.cause);
  }

  out.kind = resolveErrorKind(error, out.name, out.message, "unknown");
  const context = readErrorContext(error);
  if (context) {
    out.context = context;
  }

  return out;
}

function deserializeErrorCause(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== "object") return value;
  const record = value as Partial<RomWeaverWorkerSerializedError>;
  const causeError = new Error(typeof record.message === "string" ? record.message : "caused by error");
  if (typeof record.name === "string") causeError.name = record.name;
  if (typeof record.stack === "string") causeError.stack = record.stack;
  return causeError;
}

function toWorkerError(error: unknown, fallbackKind: RomWeaverWorkerErrorKind): RomWeaverWorkerError {
  if (error instanceof Error) {
    const workerError = error as RomWeaverWorkerError;
    workerError.kind = resolveErrorKind(error, error.name, error.message, fallbackKind);
    const context = readErrorContext(error);
    if (context) {
      workerError.context = context;
    }
    return workerError;
  }

  const out = new Error(String(error)) as RomWeaverWorkerError;
  out.kind = resolveErrorKind(error, out.name, out.message, fallbackKind);
  const context = readErrorContext(error);
  if (context) {
    out.context = context;
  }
  return out;
}

function resolveErrorKind(
  error: unknown,
  name: string,
  message: string,
  fallbackKind: RomWeaverWorkerErrorKind,
): RomWeaverWorkerErrorKind {
  return resolveWorkerErrorKind(error, name, message, fallbackKind);
}

function readErrorContext(error: unknown) {
  return readWorkerErrorContext(error);
}
