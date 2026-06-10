import type { RomWeaverWorkerErrorContext, RomWeaverWorkerErrorKind } from "../rom-weaver-types.d.ts";

const WORKER_ERROR_KINDS = new Set([
  "validation",
  "unknown_format",
  "unsupported",
  "cancelled",
  "io",
  "thread_pool_build",
  "worker",
  "panic",
  "unknown",
] satisfies RomWeaverWorkerErrorKind[]);

export function resolveWorkerErrorKind(
  error: unknown,
  name: string,
  message: string,
  fallbackKind?: unknown,
): RomWeaverWorkerErrorKind {
  const explicit = normalizeWorkerErrorKind(readOptionalRecord(error)?.kind);
  if (explicit) {
    return explicit;
  }

  const coreKind = inferCoreWorkerErrorKind(message);
  if (coreKind) {
    return coreKind;
  }

  if (isPanicLikeError(name, message)) {
    return "panic";
  }

  if (isWorkerErrorMessage(message)) {
    return "worker";
  }

  const fallback = normalizeWorkerErrorKind(fallbackKind);
  if (fallback) {
    return fallback;
  }

  return "unknown";
}

function readWorkerContextFields(input: unknown): RomWeaverWorkerErrorContext {
  if (!input || typeof input !== "object") {
    return {};
  }
  const record = input as Record<string, unknown>;
  const format = record.format;

  return {
    command: typeof record.command === "string" ? record.command : undefined,
    family: typeof record.family === "string" ? record.family : undefined,
    format: typeof format === "string" || format === null ? (format as string | null) : undefined,
    stage: typeof record.stage === "string" ? record.stage : undefined,
  };
}

export function readWorkerErrorContext(input: unknown): RomWeaverWorkerErrorContext | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;

  const fromContext = readWorkerContextFields(record.context);
  const fromInput = readWorkerContextFields(input);
  const context = {
    command: fromContext.command ?? fromInput.command,
    family: fromContext.family ?? fromInput.family,
    format: fromContext.format === undefined ? fromInput.format : fromContext.format,
    stage: fromContext.stage ?? fromInput.stage,
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

function inferCoreWorkerErrorKind(message: string): RomWeaverWorkerErrorKind | null {
  if (/^validation failed:/i.test(message)) {
    return "validation";
  }
  if (/^unknown format for path\b/i.test(message)) {
    return "unknown_format";
  }
  if (/^unsupported operation:/i.test(message)) {
    return "unsupported";
  }
  if (/^operation cancelled\b/i.test(message)) {
    return "cancelled";
  }
  if (/^(?:i\/o|io) error:/i.test(message)) {
    return "io";
  }
  if (/^thread pool build failed:/i.test(message)) {
    return "thread_pool_build";
  }

  return null;
}

function isWorkerErrorMessage(message: string): boolean {
  return /\bworker\b/i.test(message);
}

function isPanicLikeError(name: string, message: string): boolean {
  if (/\bpanic\b/i.test(name)) {
    return true;
  }

  return /\bpanicked at\b/i.test(message);
}

function normalizeWorkerErrorKind(value: unknown): RomWeaverWorkerErrorKind | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!WORKER_ERROR_KINDS.has(normalized as RomWeaverWorkerErrorKind)) {
    return null;
  }

  return normalized as RomWeaverWorkerErrorKind;
}

function readOptionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
