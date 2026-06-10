type ThreadWorkerErrorContext = {
  index: number | string;
  tid?: number | null;
};

type ErrorLikeFields = {
  cause?: unknown;
  message?: unknown;
  name?: unknown;
  stack?: unknown;
};

export function isErrorLike(value: unknown): value is ErrorLikeFields {
  return Boolean(value) && (typeof value === 'object' || typeof value === 'function');
}

export function wrapThreadFailure(tid: number, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const out = new Error(`wasi thread ${tid} failed before completion: ${message}`);
  if (error instanceof Error && typeof error.stack === 'string') out.stack = error.stack;
  return out;
}

export function createThreadWorkerLoadError(
  event: ErrorEvent,
  slot: ThreadWorkerErrorContext,
  workerUrl: string,
): Error {
  const originalError = event?.error instanceof Error ? event.error : null;
  const parts = [
    `browser wasi thread worker ${slot.index} failed`,
    `workerUrl=${workerUrl}`,
    `tid=${slot.tid ?? 'ready'}`,
  ];
  const message = typeof event?.message === 'string' && event.message.trim() ? event.message.trim() : '';
  if (message) parts.push(`message=${message}`);
  if (typeof event?.filename === 'string' && event.filename.trim()) parts.push(`filename=${event.filename.trim()}`);
  if (Number.isFinite(event?.lineno)) parts.push(`line=${event.lineno}`);
  if (Number.isFinite(event?.colno)) parts.push(`column=${event.colno}`);
  const out = new Error(parts.join('; '));
  if (originalError) {
    out.cause = originalError;
    if (typeof originalError.stack === 'string') out.stack = originalError.stack;
  }
  return out;
}

export function annotateThreadWorkerError(error: Error, slot: ThreadWorkerErrorContext, workerUrl: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const out = new Error(
    `browser wasi thread worker ${slot.index} failed`
    + ` (workerUrl=${workerUrl}, tid=${slot.tid ?? 'ready'}): ${message}`,
  );
  if (error instanceof Error) {
    out.name = error.name;
    out.cause = error;
    if (typeof error.stack === 'string') out.stack = error.stack;
  }
  return out;
}

export function deserializeThreadWorkerError(error: unknown): Error {
  const source = isErrorLike(error) ? error : null;
  const out = new Error(
    source && typeof source.message === 'string' ? source.message : 'browser wasi thread worker failed',
  );
  if (source && typeof source.name === 'string') out.name = source.name;
  if (source && typeof source.stack === 'string') out.stack = source.stack;
  if (source?.cause) out.cause = deserializeThreadWorkerError(source.cause);
  return out;
}

export function toThreadWorkerError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}
