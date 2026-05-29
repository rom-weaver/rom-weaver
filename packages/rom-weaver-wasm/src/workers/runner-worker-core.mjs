import {
  readWorkerErrorContext,
  resolveWorkerErrorKind,
} from './worker-error-utils.mjs';

export function createRunnerWorkerMessageQueue({ postMessage, initRunner }) {
  let runner = null;
  let queue = Promise.resolve();
  let activeMessage = null;
  let queuedCount = 0;

  return {
    enqueue(message) {
      const queuedMessage = summarizeQueueMessage(message);
      queuedCount += 1;
      postTraceLine(
        readRequestId(message),
        `[runner-worker] message enqueued ${queuedMessage} queued=${queuedCount} active=${activeMessage ?? 'none'}`,
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
            type: 'error',
            requestId: readRequestId(message),
            error: serializeError(error, message),
          });
        });
    },
  };

  async function handleMessage(message) {
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
        const runOptions = {
          ...(message.options ?? {}),
          onEvent(event) {
            postMessage({ type: 'event', requestId, event });
          },
          onNonJsonLine(line) {
            postMessage({ type: 'nonJsonLine', requestId, line: String(line) });
          },
          onTraceEvent(event) {
            postMessage({ type: 'traceEvent', requestId, event });
          },
          onTraceNonJsonLine(line) {
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

function readType(message) {
  if (!message || typeof message !== 'object') {
    throw new TypeError('worker message must be an object');
  }

  return message.type;
}

function readRequestId(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }
  return message.requestId ?? null;
}

function readRunPayload(message) {
  if (!message || typeof message !== 'object') return undefined;
  return message.request;
}

function summarizeQueueMessage(message) {
  const type = safeReadType(message);
  const requestId = readRequestId(message);
  return `requestId=${requestId ?? 'none'} type=${type}`;
}

function safeReadType(message) {
  try {
    return String(readType(message) ?? 'unknown');
  } catch {
    return 'invalid';
  }
}

function traceRunOptionLine(runOptions, line) {
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

function summarizeRunRequest(message) {
  const options = message?.options && typeof message.options === 'object' ? message.options : {};
  return [
    `command=${formatCommandForTrace(readPayloadCommand(message?.request))}`,
    `stream=${typeof options.__streamBroadcastChannelName === 'string'}`,
    `virtualFiles=${summarizeVirtualFiles(options.virtualFiles)}`,
  ].join(' ');
}

function summarizeRunResult(result) {
  if (!result || typeof result !== 'object') return 'result=unknown';
  const parts = [];
  if (Object.hasOwn(result, 'ok')) parts.push(`ok=${Boolean(result.ok)}`);
  if (Object.hasOwn(result, 'exitCode')) parts.push(`exitCode=${String(result.exitCode)}`);
  if (Array.isArray(result.events)) parts.push(`events=${result.events.length}`);
  if (Array.isArray(result.nonJsonLines)) parts.push(`nonJsonLines=${result.nonJsonLines.length}`);
  if (Array.isArray(result.traceEvents)) parts.push(`traceEvents=${result.traceEvents.length}`);
  if (Array.isArray(result.traceNonJsonLines)) {
    parts.push(`traceNonJsonLines=${result.traceNonJsonLines.length}`);
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

function readPayloadCommand(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.command && typeof payload.command === 'object' ? payload.command : payload;
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

function serializeError(error, requestMessage) {
  const name = error && typeof error.name === 'string' ? error.name : 'Error';
  const message = error && typeof error.message === 'string' ? error.message : String(error);
  const stack = error && typeof error.stack === 'string' ? error.stack : undefined;
  const kind = resolveErrorKind(error, name, message);
  const context = resolveErrorContext(error, requestMessage);

  return {
    name,
    message,
    stack,
    kind,
    ...(context ? { context } : {}),
  };
}

function resolveErrorKind(error, name, message) {
  return resolveWorkerErrorKind(error, name, message);
}

function resolveErrorContext(error, requestMessage) {
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

function readErrorContext(error) {
  return readWorkerErrorContext(error) ?? {};
}

function readRequestContext(message) {
  if (!message || typeof message !== 'object') {
    return {};
  }

  const context = {};
  if (typeof message.type === 'string') {
    context.stage = `worker.${message.type}`;
  }

  if (message.type === 'run' || message.type === 'runJson') {
    const command = readPayloadCommand(message.request);
    if (typeof command?.type === 'string' && command.type.length > 0) {
      context.command = command.type;
    }
  }

  return context;
}
