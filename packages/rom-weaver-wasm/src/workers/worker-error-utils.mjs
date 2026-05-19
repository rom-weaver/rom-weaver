const WORKER_ERROR_KINDS = new Set([
  'validation',
  'unknown_format',
  'unsupported',
  'cancelled',
  'io',
  'thread_pool_build',
  'worker',
  'panic',
  'unknown',
]);

export function resolveWorkerErrorKind(error, name, message, fallbackKind) {
  const explicit = normalizeWorkerErrorKind(error && error.kind);
  if (explicit) {
    return explicit;
  }

  const coreKind = inferCoreWorkerErrorKind(message);
  if (coreKind) {
    return coreKind;
  }

  if (isPanicLikeError(name, message)) {
    return 'panic';
  }

  if (isWorkerErrorMessage(message)) {
    return 'worker';
  }

  const fallback = normalizeWorkerErrorKind(fallbackKind);
  if (fallback) {
    return fallback;
  }

  return 'unknown';
}

export function readWorkerContextFields(input) {
  if (!input || typeof input !== 'object') {
    return {};
  }

  return {
    command: typeof input.command === 'string' ? input.command : undefined,
    family: typeof input.family === 'string' ? input.family : undefined,
    format:
      typeof input.format === 'string' || input.format === null
        ? input.format
        : undefined,
    stage: typeof input.stage === 'string' ? input.stage : undefined,
  };
}

function inferCoreWorkerErrorKind(message) {
  if (/^validation failed:/i.test(message)) {
    return 'validation';
  }
  if (/^unknown format for path\b/i.test(message)) {
    return 'unknown_format';
  }
  if (/^unsupported operation:/i.test(message)) {
    return 'unsupported';
  }
  if (/^operation cancelled\b/i.test(message)) {
    return 'cancelled';
  }
  if (/^(?:i\/o|io) error:/i.test(message)) {
    return 'io';
  }
  if (/^thread pool build failed:/i.test(message)) {
    return 'thread_pool_build';
  }

  return null;
}

function isWorkerErrorMessage(message) {
  return /\bworker\b/i.test(message);
}

function isPanicLikeError(name, message) {
  if (/\bpanic\b/i.test(name)) {
    return true;
  }

  return /\bpanicked at\b/i.test(message);
}

function normalizeWorkerErrorKind(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!WORKER_ERROR_KINDS.has(normalized)) {
    return null;
  }

  return normalized;
}
