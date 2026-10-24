import type {
  RomWeaverErrorKind,
  RomWeaverWorkerErrorContext,
  RomWeaverWorkerErrorKind,
} from "../rom-weaver-types.d.ts";
import { ROM_WEAVER_ERROR_KIND_PREFIXES } from "../generated/rom-weaver-format-metadata.ts";

/**
 * Compile-time exhaustive set of generated Rust error kinds. Typed event kinds
 * drive runtime classification; message-prefix inference is fallback-only. The
 * keys also seed WORKER_ERROR_KINDS.
 */
const CORE_ERROR_KINDS = {
  cancelled: true,
  io: true,
  thread_pool_build: true,
  unknown_format: true,
  unsupported: true,
  validation: true,
} satisfies Record<RomWeaverErrorKind, true>;

// JS-transport-only kinds with no Rust variant (see RomWeaverWorkerErrorKind).
const WORKER_ONLY_ERROR_KINDS = ["worker", "panic", "unknown"] satisfies RomWeaverWorkerErrorKind[];

const WORKER_ERROR_KINDS = new Set<RomWeaverWorkerErrorKind>([
  ...(Object.keys(CORE_ERROR_KINDS) as RomWeaverErrorKind[]),
  ...WORKER_ONLY_ERROR_KINDS,
]);

export function resolveWorkerErrorKind(
  error: unknown,
  name: string,
  message: string,
  fallbackKind?: unknown,
): RomWeaverWorkerErrorKind {
  // Prefer the typed kind the Rust core attached to the error (the generated
  // RomWeaverErrorKind, propagated from a failed event's `error_kind`). This is
  // the canonical classification; the message-prefix table below is only a
  // fallback for errors that arrive without it (worker/panic strings, or
  // messages wrapped in extra context).
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

// Fallback for errors that reach JS without the typed kind: classify the bare
// RomWeaverError `Display` message with the generated prefix table that also
// backs Rust's `RomWeaverErrorKind::classify_message`.
function inferCoreWorkerErrorKind(message: string): RomWeaverWorkerErrorKind | null {
  const normalized = message.toLowerCase();
  return ROM_WEAVER_ERROR_KIND_PREFIXES.find(({ prefix }) => normalized.startsWith(prefix))?.kind ?? null;
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
