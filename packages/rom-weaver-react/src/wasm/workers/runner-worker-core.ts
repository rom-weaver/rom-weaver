import type { BrowserOpfsRunOptions } from "../browser-opfs-runtime-types.ts";
import type { RomWeaverBrowserOpfsRunner } from "../rom-weaver-browser-opfs-api.ts";
import type {
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverWorkerErrorContext,
  RomWeaverWorkerSerializedError,
} from "../rom-weaver-types.d.ts";
import { readWorkerErrorContext, resolveWorkerErrorKind } from "./worker-error-utils.ts";
import type {
  RomWeaverWorkerInitOptions,
  RomWeaverWorkerRequest,
  RomWeaverWorkerResponse,
  RomWeaverWorkerRunJsonOptions,
} from "./worker-protocol.ts";
import {
  SELECT_REQUEST_CANCEL_INDEX,
  SELECT_REQUEST_CONTROL_LENGTH,
  SELECT_REQUEST_PENDING,
  SELECT_REQUEST_READY_INDEX,
  SELECT_REQUEST_RESULT_INDEX,
} from "./worker-protocol.ts";

type RunnerWorkerInitResult = {
  mode: "browser-opfs";
  runner: RomWeaverBrowserOpfsRunner;
};

type RunnerWorkerMessageQueueOptions = {
  initRunner: (input: { mode?: string; options: RomWeaverWorkerInitOptions }) => Promise<RunnerWorkerInitResult>;
  postMessage: (message: RomWeaverWorkerResponse) => void;
};

type RunnerWorkerRunOptions = RomWeaverRunJsonOptions<RomWeaverRunJsonEvent, unknown> &
  RomWeaverWorkerRunJsonOptions<RomWeaverRunJsonEvent, unknown> &
  Pick<BrowserOpfsRunOptions, "hostSelect">;
type UnknownRecord = Record<string, unknown>;

export function createRunnerWorkerMessageQueue({ postMessage, initRunner }: RunnerWorkerMessageQueueOptions) {
  let runner: RomWeaverBrowserOpfsRunner | null = null;
  let queue = Promise.resolve();
  let activeMessage: string | null = null;
  let queuedCount = 0;

  return {
    enqueue(message: RomWeaverWorkerRequest) {
      const queuedMessage = summarizeQueueMessage(message);
      queuedCount += 1;
      postTraceLine(
        readRequestId(message),
        `[runner-worker] message enqueued ${queuedMessage} queued=${queuedCount} active=${activeMessage ?? "none"}`,
      );
      queue = queue
        .then(async () => {
          queuedCount = Math.max(0, queuedCount - 1);
          activeMessage = queuedMessage;
          postTraceLine(
            readRequestId(message),
            `[runner-worker] message handling ${queuedMessage} queued=${queuedCount}`,
          );
          try {
            await handleMessage(message);
            postTraceLine(readRequestId(message), `[runner-worker] message handled ${queuedMessage}`);
          } finally {
            activeMessage = null;
          }
        })
        .catch((error) => {
          postMessage({
            error: serializeError(error, message),
            requestId: readRequestId(message),
            type: "error",
          });
        });
    },
  };

  async function handleMessage(message: RomWeaverWorkerRequest) {
    const type = readType(message);
    const requestId = readRequestId(message);

    switch (message.type) {
      case "init": {
        const { runner: nextRunner, mode } = await initRunner({
          mode: typeof message.mode === "string" ? message.mode : undefined,
          options: message.options ?? {},
        });
        runner = nextRunner;
        postMessage({
          mode: String(mode),
          requestId,
          threaded: Boolean(nextRunner?.threaded),
          type: "ready",
          wasmUrl: nextRunner?.wasmUrl ?? null,
        });
        return;
      }

      case "run": {
        const activeRunner = requireRunner();
        const result = await activeRunner.run(message.request, message.options ?? {});
        postMessage({
          operation: "run",
          requestId,
          result,
          type: "result",
        });
        return;
      }

      case "runJson": {
        postTraceLine(requestId, `[runner-worker] runJson received ${summarizeRunRequest(message)}`);
        const activeRunner = requireRunner();
        const runOptions: RunnerWorkerRunOptions = {
          ...(message.options ?? {}),
          // Synchronous host selection callback. The wasm app calls this (on this worker thread)
          // when it needs the user to pick a candidate; it blocks the worker on a SharedArrayBuffer
          // while the main thread resolves the choice via the worker client's selection handler.
          // Returns the chosen 0-based index, or -1 to cancel (also on timeout / no handler).
          hostSelect(request: string): number {
            postTraceLine(
              requestId,
              `[runner-worker] hostSelect prompting user to pick an entry ${summarizeSelectRequest(request)}`,
            );
            const control = new Int32Array(
              new SharedArrayBuffer(SELECT_REQUEST_CONTROL_LENGTH * Int32Array.BYTES_PER_ELEMENT),
            );
            Atomics.store(control, SELECT_REQUEST_READY_INDEX, SELECT_REQUEST_PENDING);
            Atomics.store(control, SELECT_REQUEST_RESULT_INDEX, SELECT_REQUEST_CANCEL_INDEX);
            postMessage({ control: control.buffer, request, requestId, type: "selectRequest" });
            postTraceLine(
              requestId,
              "[runner-worker] hostSelect posted selectRequest, blocking worker until the user responds",
            );
            // No timeout — block until the main thread resolves the selection. The user may take an
            // arbitrarily long time to pick (or dismiss, which resolves to the cancel index).
            Atomics.wait(control, SELECT_REQUEST_READY_INDEX, SELECT_REQUEST_PENDING);
            const selectedIndex = Atomics.load(control, SELECT_REQUEST_RESULT_INDEX);
            postTraceLine(
              requestId,
              `[runner-worker] hostSelect woke with selectedIndex=${selectedIndex}${selectedIndex < 0 ? " (cancelled)" : ""}`,
            );
            return selectedIndex;
          },
          onEvent(event: RomWeaverRunJsonEvent) {
            postMessage({ event, requestId, type: "event" });
          },
          onNonJsonLine(line: string) {
            postMessage({ line: String(line), requestId, type: "nonJsonLine" });
          },
          onTraceEvent(event: unknown) {
            postMessage({ event, requestId, type: "traceEvent" });
          },
          onTraceNonJsonLine(line: string) {
            postMessage({ line: String(line), requestId, type: "traceNonJsonLine" });
          },
        };
        const request = message.request;
        traceRunOptionLine(
          runOptions,
          `[runner-worker] runJson invoking runner command=${formatCommandForTrace(readPayloadCommand(request))}`,
        );
        let result: RomWeaverRunJsonResult<RomWeaverRunJsonEvent, unknown>;
        try {
          result = await activeRunner.runJson(request, runOptions);
        } catch (error) {
          traceRunOptionLine(runOptions, `[runner-worker] runJson threw ${formatErrorForTrace(error)}`);
          throw error;
        }
        traceRunOptionLine(runOptions, `[runner-worker] runJson runner returned ${summarizeRunResult(result)}`);
        postMessage({
          operation: "runJson",
          requestId,
          result,
          type: "result",
        });
        return;
      }

      case "dispose": {
        postTraceLine(requestId, "[runner-worker] dispose received");
        await runner?.dispose?.();
        runner = null;
        postMessage({ requestId, type: "disposed" });
        return;
      }

      default:
        throw new Error(`unknown worker message type: ${String(type)}`);
    }
  }

  function requireRunner(): RomWeaverBrowserOpfsRunner {
    if (!runner) {
      throw new Error("worker is not initialized. Send an init message first.");
    }
    return runner;
  }

  function postTraceLine(requestId: number | null | undefined, line: string) {
    if (requestId === null || requestId === undefined) return;
    postMessage({ line: String(line), requestId, type: "traceNonJsonLine" });
  }
}

function readType(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    throw new TypeError("worker message must be an object");
  }

  return (message as UnknownRecord).type;
}

function readRequestId(message: unknown): number | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  return (message as { requestId?: number }).requestId ?? null;
}

function summarizeSelectRequest(request: unknown) {
  if (typeof request !== "string") return "request=invalid";
  try {
    const parsed = JSON.parse(request);
    const heading = typeof parsed?.heading === "string" ? parsed.heading : "";
    const candidateCount = Array.isArray(parsed?.candidates) ? parsed.candidates.length : 0;
    return `heading="${heading}" candidates=${candidateCount}`;
  } catch {
    return `request=unparsable bytes=${request.length}`;
  }
}

function summarizeQueueMessage(message: unknown) {
  const type = safeReadType(message);
  const requestId = readRequestId(message);
  return `requestId=${requestId ?? "none"} type=${type}`;
}

function safeReadType(message: unknown) {
  try {
    return String(readType(message) ?? "unknown");
  } catch {
    return "invalid";
  }
}

function traceRunOptionLine(runOptions: RunnerWorkerRunOptions, line: string) {
  const onTraceNonJsonLine =
    typeof runOptions?.onTraceNonJsonLine === "function" ? runOptions.onTraceNonJsonLine : null;
  if (!onTraceNonJsonLine) return;
  try {
    onTraceNonJsonLine(line);
  } catch {
    // Trace callbacks are diagnostic only and must not affect worker execution.
  }
}

function summarizeRunRequest(message: unknown) {
  const record = (message && typeof message === "object" ? message : {}) as UnknownRecord;
  const options = (record.options && typeof record.options === "object" ? record.options : {}) as UnknownRecord;
  return [
    `command=${formatCommandForTrace(readPayloadCommand(record.request))}`,
    `stream=${typeof options.__streamBroadcastChannelName === "string"}`,
    `virtualFiles=${summarizeVirtualFiles(options.virtualFiles)}`,
  ].join(" ");
}

function summarizeRunResult(result: unknown) {
  if (!result || typeof result !== "object") return "result=unknown";
  const record = result as UnknownRecord;
  const parts: string[] = [];
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

function summarizeVirtualFiles(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "count=0";
  let proxyCount = 0;
  let directCount = 0;
  let totalBytes = 0;
  for (const entry of value) {
    const record = entry && typeof entry === "object" ? (entry as UnknownRecord) : {};
    const source = record.source ?? record.file ?? record.blob ?? record.bytes ?? record.data ?? record.proxy;
    const proxy = record.proxy ?? (isTraceVirtualFileProxy(source) ? source : null);
    if (isTraceVirtualFileProxy(proxy)) {
      proxyCount += 1;
      totalBytes += Number(proxy.size) || 0;
      continue;
    }
    directCount += 1;
    const sourceRecord = source && typeof source === "object" ? (source as UnknownRecord) : {};
    totalBytes += Number(sourceRecord.size ?? sourceRecord.byteLength ?? 0) || 0;
  }
  return `count=${value.length},proxy=${proxyCount},direct=${directCount},bytes=${totalBytes}`;
}

function isTraceVirtualFileProxy(value: unknown): value is { id: string; size: unknown; slots: unknown[] } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as UnknownRecord).id === "string" &&
      Array.isArray((value as UnknownRecord).slots) &&
      Number.isFinite(Number((value as UnknownRecord).size)),
  );
}

function formatCommandForTrace(command: unknown): string {
  if (!command || typeof command !== "object") return "unknown";
  try {
    return truncateForTrace(JSON.stringify(toTraceValue(command)));
  } catch {
    return String((command as UnknownRecord).type ?? "unknown");
  }
}

function readPayloadCommand(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as UnknownRecord;
  return record.command && typeof record.command === "object" ? record.command : record;
}

function toTraceValue(value: unknown): unknown {
  if (typeof value === "string") return basenameForTrace(value);
  if (Array.isArray(value)) return value.map((entry) => toTraceValue(entry));
  if (!value || typeof value !== "object") return value;
  const out: UnknownRecord = {};
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

function serializeError(error: unknown, requestMessage: unknown): RomWeaverWorkerSerializedError {
  const record = (error && typeof error === "object" ? error : {}) as UnknownRecord;
  const name = typeof record.name === "string" ? record.name : "Error";
  const message = typeof record.message === "string" ? record.message : stringifyThrownValue(error);
  const stack = typeof record.stack === "string" ? record.stack : undefined;
  const kind = resolveErrorKind(error, name, message);
  const context = resolveErrorContext(error, requestMessage);
  const cause = serializeErrorCause(record.cause);

  return {
    kind,
    message,
    name,
    stack,
    ...(context ? { context } : {}),
    ...(cause === undefined ? {} : { cause }),
  };
}

function serializeErrorCause(value: unknown): RomWeaverWorkerSerializedError | string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Error) {
    return {
      message: typeof value.message === "string" ? value.message : String(value),
      name: typeof value.name === "string" ? value.name : "Error",
      stack: typeof value.stack === "string" ? value.stack : undefined,
    };
  }
  return typeof value === "string" ? value : undefined;
}

function stringifyThrownValue(error: unknown): string {
  if (typeof error === "string") return error;
  if (error === undefined) return "undefined";
  if (error === null) return "null";
  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}") return json;
  } catch {
    // Non-serializable thrown value; fall back to String() below.
  }
  return String(error);
}

function resolveErrorKind(error: unknown, name: string, message: string) {
  return resolveWorkerErrorKind(error, name, message);
}

function resolveErrorContext(error: unknown, requestMessage: unknown): RomWeaverWorkerErrorContext | undefined {
  const explicitContext = readErrorContext(error);
  const requestContext = readRequestContext(requestMessage);
  const context = {
    command: explicitContext.command ?? requestContext.command,
    family: explicitContext.family ?? requestContext.family,
    format: explicitContext.format === undefined ? requestContext.format : explicitContext.format,
    stage: explicitContext.stage ?? requestContext.stage,
  };

  if (
    context.command === undefined &&
    context.family === undefined &&
    context.format === undefined &&
    context.stage === undefined
  ) {
    return undefined;
  }

  return context;
}

function readErrorContext(error: unknown) {
  return readWorkerErrorContext(error) ?? {};
}

function readRequestContext(message: unknown): RomWeaverWorkerErrorContext {
  if (!message || typeof message !== "object") {
    return {};
  }

  const record = message as UnknownRecord;
  const context: RomWeaverWorkerErrorContext = {};
  if (typeof record.type === "string") {
    context.stage = `worker.${record.type}`;
  }

  if (record.type === "run" || record.type === "runJson") {
    const command = readPayloadCommand(record.request) as UnknownRecord | null;
    if (typeof command?.type === "string" && command.type.length > 0) {
      context.command = command.type;
    }
  }

  return context;
}
