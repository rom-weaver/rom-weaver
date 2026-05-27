import {
  readWorkerErrorContext,
  resolveWorkerErrorKind,
} from './worker-error-utils.mjs';

export class RomWeaverWorkerClientCore {
  constructor(worker, transport) {
    this.worker = worker;
    this._transport = transport;
    this._nextRequestId = 1;
    this._pending = new Map();

    this._onMessage = this._onMessage.bind(this);
    this._onError = this._onError.bind(this);
    this._onMessageError = this._onMessageError.bind(this);
    this._onExit = this._onExit.bind(this);

    this._transport.onMessage(this.worker, this._onMessage);
    this._transport.onError(this.worker, this._onError);
    this._transport.onMessageError?.(this.worker, this._onMessageError);
    this._transport.onExit?.(this.worker, this._onExit);
  }

  run(args = [], options = {}) {
    return this._send({ type: 'run', args, options });
  }

  runJson(args = [], options = {}) {
    const {
      onEvent,
      onNonJsonLine,
      onTraceEvent,
      onTraceNonJsonLine,
      ...runOptions
    } = options ?? {};
    return this._send(
      { type: 'runJson', args, options: runOptions },
      { onEvent, onNonJsonLine, onTraceEvent, onTraceNonJsonLine },
    );
  }

  dispose() {
    return this._send({ type: 'dispose' });
  }

  _send(payload, handlers = {}) {
    const requestId = this._nextRequestId;
    this._nextRequestId += 1;
    const streamChannel = createWorkerStreamChannel({
      handlers,
      payload,
      requestId,
    });

    return new Promise((resolve, reject) => {
      this._pending.set(requestId, {
        resolve: (value) => {
          streamChannel?.close();
          resolve(value);
        },
        reject: (error) => {
          streamChannel?.close();
          reject(error);
        },
        onEvent: typeof handlers.onEvent === 'function' ? handlers.onEvent : null,
        onNonJsonLine: typeof handlers.onNonJsonLine === 'function'
          ? handlers.onNonJsonLine
          : null,
        onTraceEvent: typeof handlers.onTraceEvent === 'function'
          ? handlers.onTraceEvent
          : null,
        onTraceNonJsonLine: typeof handlers.onTraceNonJsonLine === 'function'
          ? handlers.onTraceNonJsonLine
          : null,
      });

      try {
        emitClientTrace(
          handlers,
          `[worker-client] send requestId=${requestId} ${summarizeRequestPayload(payload)}`,
        );
        this._transport.postMessage(this.worker, { ...payload, requestId });
        emitClientTrace(
          handlers,
          `[worker-client] postMessage returned requestId=${requestId}`,
        );
      } catch (error) {
        this._pending.delete(requestId);
        streamChannel?.close();
        emitClientTrace(
          handlers,
          `[worker-client] postMessage failed requestId=${requestId} error=${formatErrorForTrace(error)}`,
        );
        reject(toWorkerError(error, 'worker'));
      }
    });
  }

  _onMessage(rawMessage) {
    const message = this._transport.readMessage(rawMessage);
    if (!message || typeof message !== 'object') {
      return;
    }

    const requestId = message.requestId;
    const pending = this._pending.get(requestId);

    switch (message.type) {
      case 'event':
        pending?.onEvent?.(message.event);
        return;
      case 'nonJsonLine':
        pending?.onNonJsonLine?.(message.line);
        return;
      case 'traceEvent':
        pending?.onTraceEvent?.(message.event);
        return;
      case 'traceNonJsonLine':
        pending?.onTraceNonJsonLine?.(message.line);
        return;
      case 'ready':
        this._pending.delete(requestId);
        emitPendingTrace(
          pending,
          `[worker-client] ready requestId=${requestId} mode=${message.mode ?? ''} threaded=${Boolean(message.threaded)}`,
        );
        pending?.resolve({
          mode: message.mode,
          threaded: Boolean(message.threaded),
          wasmUrl: message.wasmUrl ?? null,
        });
        return;
      case 'disposed':
        this._pending.delete(requestId);
        emitPendingTrace(pending, `[worker-client] disposed requestId=${requestId}`);
        pending?.resolve({ disposed: true });
        return;
      case 'result':
        this._pending.delete(requestId);
        emitPendingTrace(
          pending,
          `[worker-client] result requestId=${requestId} operation=${message.operation ?? ''} ${summarizeWorkerResult(message.result)}`,
        );
        pending?.resolve(message.result);
        return;
      case 'error':
        this._pending.delete(requestId);
        if (!pending && (requestId === null || requestId === undefined)) {
          this._rejectAllPending(deserializeError(message.error), 'worker unscoped error');
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

  _onError(rawError) {
    this._rejectAllPending(this._transport.toError(rawError), 'worker error');
  }

  _onMessageError(rawError) {
    const error = this._transport.toMessageError?.(rawError)
      ?? new Error('worker messageerror');
    this._rejectAllPending(error, 'worker messageerror');
  }

  _onExit(code) {
    if (this._pending.size === 0) {
      return;
    }

    const error = this._transport.toExitError?.(code);
    if (error) {
      this._rejectAllPending(error, 'worker exit');
    }
  }

  _rejectAllPending(error, reason = 'worker rejected pending requests') {
    const normalizedError = toWorkerError(error, 'worker');
    for (const pending of this._pending.values()) {
      emitPendingTrace(
        pending,
        `[worker-client] ${reason} ${formatErrorForTrace(normalizedError)}`,
      );
      pending.reject(normalizedError);
    }
    this._pending.clear();
  }

  _shutdown(reason = 'worker terminated') {
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

export function createBrowserWorkerTransport() {
  return {
    postMessage(worker, message) {
      worker.postMessage(message);
    },
    onMessage(worker, listener) {
      worker.addEventListener('message', listener);
    },
    offMessage(worker, listener) {
      worker.removeEventListener('message', listener);
    },
    onError(worker, listener) {
      worker.addEventListener('error', listener);
    },
    offError(worker, listener) {
      worker.removeEventListener('error', listener);
    },
    onMessageError(worker, listener) {
      worker.addEventListener('messageerror', listener);
    },
    offMessageError(worker, listener) {
      worker.removeEventListener('messageerror', listener);
    },
    readMessage(event) {
      return event.data;
    },
    toError(event) {
      if (event?.error instanceof Error) {
        return event.error;
      }
      const messageParts = [];
      if (typeof event?.message === 'string' && event.message.trim().length > 0) {
        messageParts.push(event.message.trim());
      }
      if (typeof event?.filename === 'string' && event.filename.trim().length > 0) {
        const location = [
          event.filename,
          Number.isFinite(event?.lineno) ? String(event.lineno) : null,
          Number.isFinite(event?.colno) ? String(event.colno) : null,
        ]
          .filter(Boolean)
          .join(':');
        if (location.length > 0) {
          messageParts.push(`at ${location}`);
        }
      }
      return new Error(messageParts.join(' ') || 'worker error');
    },
    toMessageError(event) {
      const message = typeof event?.message === 'string' && event.message.trim().length > 0
        ? event.message.trim()
        : 'worker messageerror';
      return new Error(message);
    },
    terminate(worker) {
      worker.terminate();
    },
  };
}

function createWorkerStreamChannel({ handlers, payload, requestId }) {
  if (
    payload?.type !== 'runJson'
    || typeof BroadcastChannel !== 'function'
    || !hasAnyStreamHandler(handlers)
  ) {
    return null;
  }

  const name = `rom-weaver-wasm-stream:${Date.now()}:${Math.random().toString(16).slice(2)}:${requestId}`;
  const channel = new BroadcastChannel(name);
  channel.onmessage = (event) => {
    const message = event?.data;
    if (!message || typeof message !== 'object' || message.requestId !== requestId) return;
    dispatchStreamMessage(handlers, message);
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

function hasAnyStreamHandler(handlers) {
  return Boolean(
    typeof handlers?.onEvent === 'function'
      || typeof handlers?.onNonJsonLine === 'function'
      || typeof handlers?.onTraceEvent === 'function'
      || typeof handlers?.onTraceNonJsonLine === 'function',
  );
}

function dispatchStreamMessage(handlers, message) {
  switch (message.type) {
    case 'event':
      handlers.onEvent?.(message.event);
      return;
    case 'nonJsonLine':
      handlers.onNonJsonLine?.(message.line);
      return;
    case 'traceEvent':
      handlers.onTraceEvent?.(message.event);
      return;
    case 'traceNonJsonLine':
      handlers.onTraceNonJsonLine?.(message.line);
      return;
    default:
      return;
  }
}

function emitClientTrace(handlers, line) {
  const onTraceNonJsonLine = typeof handlers?.onTraceNonJsonLine === 'function'
    ? handlers.onTraceNonJsonLine
    : null;
  if (!onTraceNonJsonLine) return;
  try {
    onTraceNonJsonLine(line);
  } catch {
    // Trace callbacks are diagnostic only and must not affect worker execution.
  }
}

function emitPendingTrace(pending, line) {
  const onTraceNonJsonLine = typeof pending?.onTraceNonJsonLine === 'function'
    ? pending.onTraceNonJsonLine
    : null;
  if (!onTraceNonJsonLine) return;
  try {
    onTraceNonJsonLine(line);
  } catch {
    // Trace callbacks are diagnostic only and must not affect worker execution.
  }
}

function summarizeRequestPayload(payload) {
  const type = String(payload?.type ?? 'unknown');
  const args = Array.isArray(payload?.args) ? payload.args.map((value) => String(value)) : [];
  const options = payload?.options && typeof payload.options === 'object' ? payload.options : {};
  const stream = typeof options.__streamBroadcastChannelName === 'string';
  const virtualFiles = summarizeVirtualFiles(options.virtualFiles);
  return [
    `type=${type}`,
    `args=${formatArgsForTrace(args)}`,
    `stream=${stream}`,
    `virtualFiles=${virtualFiles}`,
  ].join(' ');
}

function summarizeWorkerResult(result) {
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

function summarizeSerializedError(error) {
  if (!error || typeof error !== 'object') return `error=${String(error)}`;
  return [
    `name=${String(error.name ?? 'Error')}`,
    `kind=${String(error.kind ?? '')}`,
    `message=${truncateForTrace(error.message ?? '')}`,
  ].join(' ');
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

function formatArgsForTrace(args) {
  if (!Array.isArray(args) || args.length === 0) return '[]';
  return JSON.stringify(args.map((value) => basenameForTrace(value)));
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

function deserializeError(error) {
  const out = new Error(
    error && typeof error.message === 'string' ? error.message : 'worker request failed',
  );

  if (error && typeof error.name === 'string') {
    out.name = error.name;
  }
  if (error && typeof error.stack === 'string') {
    out.stack = error.stack;
  }

  out.kind = resolveErrorKind(error, out.name, out.message, 'unknown');
  const context = readErrorContext(error);
  if (context) {
    out.context = context;
  }

  return out;
}

function toWorkerError(error, fallbackKind) {
  if (error instanceof Error) {
    error.kind = resolveErrorKind(error, error.name, error.message, fallbackKind);
    const context = readErrorContext(error);
    if (context) {
      error.context = context;
    }
    return error;
  }

  const out = new Error(String(error));
  out.kind = resolveErrorKind(error, out.name, out.message, fallbackKind);
  const context = readErrorContext(error);
  if (context) {
    out.context = context;
  }
  return out;
}

function resolveErrorKind(error, name, message, fallbackKind) {
  return resolveWorkerErrorKind(error, name, message, fallbackKind);
}

function readErrorContext(error) {
  return readWorkerErrorContext(error);
}
