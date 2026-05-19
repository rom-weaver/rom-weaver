import {
  readWorkerContextFields,
  resolveWorkerErrorKind,
} from './worker-error-utils.mjs';

export function createRunnerWorkerMessageQueue({ postMessage, initRunner }) {
  let runner = null;
  let queue = Promise.resolve();

  return {
    enqueue(message) {
      queue = queue
        .then(() => handleMessage(message))
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
        postMessage({ type: 'ready', requestId, mode: String(mode) });
        return;
      }

      case 'run': {
        assertRunnerInitialized();
        const result = await runner.run(normalizeArgs(message.args), message.options ?? {});
        postMessage({
          type: 'result',
          requestId,
          operation: 'run',
          result,
        });
        return;
      }

      case 'runJson': {
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
        const result = await runner.runJson(normalizeArgs(message.args), runOptions);
        postMessage({
          type: 'result',
          requestId,
          operation: 'runJson',
          result,
        });
        return;
      }

      case 'dispose': {
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

function normalizeArgs(args) {
  if (!Array.isArray(args)) {
    return [];
  }
  return args.map((value) => String(value));
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
  if (!error || typeof error !== 'object') {
    return {};
  }

  const fromContext = readWorkerContextFields(error.context);
  const fromError = readWorkerContextFields(error);
  return {
    command: fromContext.command ?? fromError.command,
    family: fromContext.family ?? fromError.family,
    format: fromContext.format !== undefined ? fromContext.format : fromError.format,
    stage: fromContext.stage ?? fromError.stage,
  };
}

function readRequestContext(message) {
  if (!message || typeof message !== 'object') {
    return {};
  }

  const context = {};
  if (typeof message.type === 'string') {
    context.stage = `worker.${message.type}`;
  }

  if (
    (message.type === 'run' || message.type === 'runJson')
    && Array.isArray(message.args)
    && typeof message.args[0] === 'string'
    && message.args[0].length > 0
  ) {
    context.command = message.args[0];
  }

  return context;
}
