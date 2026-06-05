import {
  readWorkerErrorContext,
  resolveWorkerErrorKind,
} from './worker-error-utils.ts';
import type {
  RomWeaverBrowserOpfsRunner,
} from '../rom-weaver-browser-opfs-api.ts';
import type {
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverWorkerErrorContext,
  RomWeaverWorkerSerializedError,
} from '../rom-weaver-types.d.ts';
import type {
  RomWeaverWorkerRequest,
  RomWeaverWorkerResponse,
} from './worker-protocol.ts';

type RunnerWorkerInitResult = {
  mode: 'browser-opfs';
  runner: RomWeaverBrowserOpfsRunner;
};

type RunnerWorkerMessageQueueOptions = {
  initRunner: (input: { mode?: string; options: Record<string, unknown> }) => Promise<RunnerWorkerInitResult>;
  postMessage: (message: RomWeaverWorkerResponse) => void;
};

type RunnerWorkerRunOptions = RomWeaverRunJsonOptions<RomWeaverRunJsonEvent, unknown> & Record<string, unknown>;
type AnyRecord = Record<string, any>;
type AnyWorkerRequest = RomWeaverWorkerRequest & AnyRecord;

export function createRunnerWorkerMessageQueue({ postMessage, initRunner }: RunnerWorkerMessageQueueOptions) {
  let runner: RomWeaverBrowserOpfsRunner | null = null;
  let queue = Promise.resolve();
  let activeMessage = null;
  let queuedCount = 0;

  return {
    enqueue(message: RomWeaverWorkerRequest) {
      const workerMessage = message as AnyWorkerRequest;
      const queuedMessage = summarizeQueueMessage(workerMessage);
      queuedCount += 1;
      postTraceLine(
        readRequestId(workerMessage),
        `[runner-worker] message enqueued ${queuedMessage} queued=${queuedCount} active=${activeMessage ?? 'none'}`,
      );
      queue = queue
        .then(async () => {
          queuedCount = Math.max(0, queuedCount - 1);
          activeMessage = queuedMessage;
          postTraceLine(
            readRequestId(workerMessage),
            `[runner-worker] message handling ${queuedMessage} queued=${queuedCount}`,
          );
          try {
            await handleMessage(workerMessage);
            postTraceLine(readRequestId(workerMessage), `[runner-worker] message handled ${queuedMessage}`);
          } finally {
            activeMessage = null;
          }
        })
        .catch((error) => {
          postMessage({
            type: 'error',
            requestId: readRequestId(workerMessage),
            error: serializeError(error, workerMessage),
          });
        });
    },
  };

  async function handleMessage(message: AnyWorkerRequest) {
    const type = readType(message);
    const requestId = readRequestId(message);

    switch (type) {
      case 'init': {
        const { runner: nextRunner, mode } = await initRunner({
          mode: typeof message.mode === 'string' ? message.mode : undefined,
          options: message.options ?? {},
        });
        runner = nextRunner;
        postMessage({
          type: 'ready',
          requestId,
          mode: String(mode),
          threaded: Boolean(nextRunner?.threaded),
          wasmUrl: nextRunner?.wasmUrl ?? null,
        });
        return;
      }

      case 'run': {
        assertRunnerInitialized();
        const result = await runner.run(readRunPayload(message), message.options ?? {});
        postMessage({
          type: 'result',
          requestId,
          operation: 'run',
          result,
        });
        return;
      }

      case 'runJson': {
        postTraceLine(
          requestId,
          `[runner-worker] runJson received ${summarizeRunRequest(message)}`,
        );
        assertRunnerInitialized();
        const runOptions: RunnerWorkerRunOptions = {
          ...(message.options ?? {}),
          onEvent(event: RomWeaverRunJsonEvent) {
            postMessage({ type: 'event', requestId, event });
          },
          onNonJsonLine(line: string) {
            postMessage({ type: 'nonJsonLine', requestId, line: String(line) });
          },
          onTraceEvent(event: unknown) {
            postMessage({ type: 'traceEvent', requestId, event });
          },
          onTraceNonJsonLine(line: string) {
            postMessage({ type: 'traceNonJsonLine', requestId, line: String(line) });
          },
        };
        const request = readRunPayload(message);
        traceRunOptionLine(
          runOptions,
          `[runner-worker] runJson invoking runner command=${formatCommandForTrace(readPayloadCommand(request))}`,
        );
        let result;
        try {
          result = await runner.runJson(request, runOptions);
        } catch (error) {
          traceRunOptionLine(
            runOptions,
            `[runner-worker] runJson threw ${formatErrorForTrace(error)}`,
          );
          throw error;
        }
        traceRunOptionLine(
          runOptions,
          `[runner-worker] runJson runner returned ${summarizeRunResult(result)}`,
        );
        postMessage({
          type: 'result',
          requestId,
          operation: 'runJson',
          result,
        });
        return;
      }

      case 'dispose': {
        postTraceLine(requestId, '[runner-worker] dispose received');
        await runner?.dispose?.();
        runner = null;
        postMessage({ type: 'disposed', requestId });
        return;
      }

      default:
        throw new Error(`unknown worker message type: ${String(type)}`);
    }
  }

  function assertRunnerInitialized() {
    if (!runner) {
      throw new Error('worker is not initialized. Send an init message first.');
    }
  }

  function postTraceLine(requestId, line) {
    if (requestId === null || requestId === undefined) return;
    postMessage({ type: 'traceNonJsonLine', requestId, line: String(line) });
  }
}

function readType(message: unknown) {
  if (!message || typeof message !== 'object') {
    throw new TypeError('worker message must be an object');
  }

  return (message as AnyRecord).type;
}

function readRequestId(message: unknown) {
  if (!message || typeof message !== 'object') {
    return null;
  }
  return (message as AnyRecord).requestId ?? null;
}

function readRunPayload(message: unknown) {
  if (!message || typeof message !== 'object') return undefined;
  return (message as AnyRecord).request;
}

function summarizeQueueMessage(message: unknown) {
  const type = safeReadType(message);
  const requestId = readRequestId(message);
  return `requestId=${requestId ?? 'none'} type=${type}`;
}

function safeReadType(message: unknown) {
  try {
    return String(readType(message) ?? 'unknown');
  } catch {
    return 'invalid';
  }
}

function traceRunOptionLine(runOptions: RunnerWorkerRunOptions, line: string) {
  const onTraceNonJsonLine = typeof runOptions?.onTraceNonJsonLine === 'function'
    ? runOptions.onTraceNonJsonLine
    : null;
  if (!onTraceNonJsonLine) return;
  try {
    onTraceNonJsonLine(line);
  } catch {
    // Trace callbacks are diagnostic only and must not affect worker execution.
  }
}

function summarizeRunRequest(message: unknown) {
  const record = (message && typeof message === 'object' ? message : {}) as AnyRecord;
  const options = record.options && typeof record.options === 'object' ? record.options : {};
  return [
    `command=${formatCommandForTrace(readPayloadCommand(record.request))}`,
    `stream=${typeof options.__streamBroadcastChannelName === 'string'}`,
    `virtualFiles=${summarizeVirtualFiles(options.virtualFiles)}`,
  ].join(' ');
}

function summarizeRunResult(result: unknown) {
  if (!result || typeof result !== 'object') return 'result=unknown';
  const record = result as AnyRecord;
  const parts: string[] = [];
  if (Object.hasOwn(record, 'ok')) parts.push(`ok=${Boolean(record.ok)}`);
  if (Object.hasOwn(record, 'exitCode')) parts.push(`exitCode=${String(record.exitCode)}`);
  if (Array.isArray(record.events)) parts.push(`events=${record.events.length}`);
  if (Array.isArray(record.nonJsonLines)) parts.push(`nonJsonLines=${record.nonJsonLines.length}`);
  if (Array.isArray(record.traceEvents)) parts.push(`traceEvents=${record.traceEvents.length}`);
  if (Array.isArray(record.traceNonJsonLines)) {
    parts.push(`traceNonJsonLines=${record.traceNonJsonLines.length}`);
  }
  return parts.length > 0 ? parts.join(' ') : 'result=object';
}

function summarizeVirtualFiles(value) {
  if (!Array.isArray(value) || value.length === 0) return 'count=0';
  let proxyCount = 0;
  let directCount = 0;
  let totalBytes = 0;
  for (const entry of value) {
    const source = entry?.source ?? entry?.file ?? entry?.blob ?? entry?.bytes ?? entry?.data ?? entry?.proxy;
    const proxy = entry?.proxy ?? (isTraceVirtualFileProxy(source) ? source : null);
    if (isTraceVirtualFileProxy(proxy)) {
      proxyCount += 1;
      totalBytes += Number(proxy.size) || 0;
      continue;
    }
    directCount += 1;
    totalBytes += Number(source?.size ?? source?.byteLength ?? 0) || 0;
  }
  return `count=${value.length},proxy=${proxyCount},direct=${directCount},bytes=${totalBytes}`;
}

function isTraceVirtualFileProxy(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && typeof value.id === 'string'
      && Array.isArray(value.slots)
      && Number.isFinite(Number(value.size)),
  );
}

function formatCommandForTrace(command) {
  if (!command || typeof command !== 'object') return 'unknown';
  try {
    return truncateForTrace(JSON.stringify(toTraceValue(command)));
  } catch {
    return String(command?.type ?? 'unknown');
  }
}

function readPayloadCommand(payload: unknown) {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as AnyRecord;
  return record.command && typeof record.command === 'object' ? record.command : record;
}

function toTraceValue(value) {
  if (typeof value === 'string') return basenameForTrace(value);
  if (Array.isArray(value)) return value.map((entry) => toTraceValue(entry));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) out[key] = toTraceValue(entry);
  return out;
}

function basenameForTrace(value) {
  const text = String(value ?? '');
  if (!text.includes('/')) return text;
  return text.slice(text.lastIndexOf('/') + 1) || text;
}

function formatErrorForTrace(error) {
  if (error instanceof Error) return `${error.name}:${truncateForTrace(error.message)}`;
  return truncateForTrace(String(error));
}

function truncateForTrace(value, maxLength = 180) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}...`;
}

function serializeError(error: unknown, requestMessage: unknown): RomWeaverWorkerSerializedError {
  const record = (error && typeof error === 'object' ? error : {}) as AnyRecord;
  const name = typeof record.name === 'string' ? record.name : 'Error';
  const message = typeof record.message === 'string' ? record.message : stringifyThrownValue(error);
  const stack = typeof record.stack === 'string' ? record.stack : undefined;
  const kind = resolveErrorKind(error, name, message);
  const context = resolveErrorContext(error, requestMessage);
  const cause = serializeErrorCause(record.cause);

  return {
    name,
    message,
    stack,
    kind,
    ...(context ? { context } : {}),
    ...(cause !== undefined ? { cause } : {}),
  };
}

function serializeErrorCause(value: unknown): RomWeaverWorkerSerializedError | string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Error) {
    return {
      name: typeof value.name === 'string' ? value.name : 'Error',
      message: typeof value.message === 'string' ? value.message : String(value),
      stack: typeof value.stack === 'string' ? value.stack : undefined,
    };
  }
  return typeof value === 'string' ? value : undefined;
}

function stringifyThrownValue(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error === undefined) return 'undefined';
  if (error === null) return 'null';
  try {
    const json = JSON.stringify(error);
    if (json && json !== '{}') return json;
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
    format:
      explicitContext.format !== undefined
        ? explicitContext.format
        : requestContext.format,
    stage: explicitContext.stage ?? requestContext.stage,
  };

  if (
    context.command === undefined
    && context.family === undefined
    && context.format === undefined
    && context.stage === undefined
  ) {
    return undefined;
  }

  return context;
}

function readErrorContext(error: unknown) {
  return readWorkerErrorContext(error) ?? {};
}

function readRequestContext(message: unknown): RomWeaverWorkerErrorContext {
  if (!message || typeof message !== 'object') {
    return {};
  }

  const record = message as AnyRecord;
  const context: RomWeaverWorkerErrorContext = {};
  if (typeof record.type === 'string') {
    context.stage = `worker.${record.type}`;
  }

  if (record.type === 'run' || record.type === 'runJson') {
    const command = readPayloadCommand(record.request) as AnyRecord | null;
    if (typeof command?.type === 'string' && command.type.length > 0) {
      context.command = command.type;
    }
  }

  return context;
}
