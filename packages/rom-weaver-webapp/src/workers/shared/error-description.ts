import type { RomWeaverWorkerErrorContext } from "../../wasm/rom-weaver-types.d.ts";

type DescribeErrorOptions = {
  /** Prefer a stack over the message (worker crash reports). */
  stack?: boolean;
  /** Append a reported error's `context` (command, stage) to its message. */
  context?: boolean;
  /** Serialize an object with nothing else to describe it as JSON. */
  serialize?: boolean;
};

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

/** The command, family, format, and stage a worker error reports, from its `context` or its own fields. */
function readWorkerErrorContext(input: unknown): RomWeaverWorkerErrorContext | undefined {
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

const readString = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === "string" ? (record[key] as string).trim() : "";

const getContextSuffix = (record: Record<string, unknown>): string => {
  const context = readWorkerContextFields(record.context);
  const command = context.command?.trim() ?? "";
  const stage = context.stage?.trim() ?? "";
  if (!(command || stage)) return "";
  return ` (${[command ? `command=${command}` : "", stage ? `stage=${stage}` : ""].filter(Boolean).join(", ")})`;
};

/**
 * An ErrnoError carries no message, only a numeric errno, so it needs its own
 * wording. Returns "" when the error is not one.
 */
const describeErrnoError = (record: Record<string, unknown>): string => {
  if (record.name !== "ErrnoError") return "";
  const errno = record.errno;
  if (!(typeof errno === "number" || typeof errno === "string")) return "";
  if (String(errno) === "2") return "Worker filesystem file not found while preparing disc output.";
  return `Worker filesystem error ${errno} while preparing disc output.`;
};

const describeErrorRecord = (record: Record<string, unknown>, options: DescribeErrorOptions): string => {
  const message = readString(record, "message");
  if (message) return options.context ? `${message}${getContextSuffix(record)}` : message;
  const stack = options.stack ? readString(record, "stack") : "";
  if (stack) return stack;
  const kind = readString(record, "kind");
  if (kind) return `rom-weaver error (${kind})`;
  const errno = describeErrnoError(record);
  if (errno || !options.serialize) return errno;
  try {
    return JSON.stringify(record);
  } catch {
    return String(record);
  }
};

/**
 * Text for a thrown or reported error value: a string, an Error, or an error
 * record posted across a worker boundary. Every layer that turns an error into
 * text uses this. Returns "" when there is nothing to describe.
 */
const describeError = (value: unknown, options: DescribeErrorOptions = {}): string => {
  if (typeof value === "string") return value.trim();
  if (value instanceof Error) return ((options.stack && value.stack) || value.message || "").trim();
  if (value && typeof value === "object") return describeErrorRecord(value as Record<string, unknown>, options);
  return value ? String(value) : "";
};

export { describeError, readWorkerErrorContext };
