// Zero-dependency trace-string formatters shared by the worker client, the runner worker, the
// WASI thread worker/pool, and the OPFS stdio-events layer. Kept free of any wasi-shim or OPFS
// imports so every worker bundle can pull these in without dragging heavy modules along.

type TraceRecord = Record<string, unknown>;

export function basenameForTrace(value: unknown): string {
  const text = String(value ?? "");
  if (!text.includes("/")) return text;
  return text.slice(text.lastIndexOf("/") + 1) || text;
}

export function truncateForTrace(value: unknown, maxLength = 180): string {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}...`;
}

export function formatErrorForTrace(error: unknown): string {
  if (error instanceof Error) return `${error.name}:${truncateForTrace(error.message)}`;
  return truncateForTrace(String(error));
}

function toTraceValue(value: unknown): unknown {
  if (typeof value === "string") return basenameForTrace(value);
  if (Array.isArray(value)) return value.map((entry) => toTraceValue(entry));
  if (!value || typeof value !== "object") return value;
  const out: TraceRecord = {};
  for (const [key, entry] of Object.entries(value)) out[key] = toTraceValue(entry);
  return out;
}

export function formatCommandForTrace(command: unknown): string {
  if (!command || typeof command !== "object") return "unknown";
  try {
    return truncateForTrace(JSON.stringify(toTraceValue(command)));
  } catch {
    return String((command as TraceRecord).type ?? "unknown");
  }
}

export function summarizeVirtualFiles(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "count=0";
  let proxyCount = 0;
  let directCount = 0;
  let totalBytes = 0;
  for (const entry of value) {
    const record = entry && typeof entry === "object" ? (entry as TraceRecord) : {};
    const source = record.source ?? record.file ?? record.blob ?? record.bytes ?? record.data;
    const sourceRecord = source && typeof source === "object" ? (source as TraceRecord) : {};
    totalBytes += Number(sourceRecord.size ?? sourceRecord.byteLength ?? 0) || 0;
    if (record.useProxyHandle) {
      proxyCount += 1;
      continue;
    }
    directCount += 1;
  }
  return `count=${value.length},proxy=${proxyCount},direct=${directCount},bytes=${totalBytes}`;
}

export function summarizeSelectRequest(request: unknown): string {
  if (typeof request !== "string") return "request=invalid";
  try {
    const parsed = JSON.parse(request) as TraceRecord;
    const heading = typeof parsed?.heading === "string" ? parsed.heading : "";
    const mode = typeof parsed?.mode === "string" ? parsed.mode : "single";
    const candidateCount = Array.isArray(parsed?.candidates) ? parsed.candidates.length : 0;
    return `mode=${mode} heading="${heading}" candidates=${candidateCount}`;
  } catch {
    return `request=unparsable bytes=${request.length}`;
  }
}

export function summarizeRunResult(result: unknown): string {
  if (!result || typeof result !== "object") return "result=unknown";
  const record = result as TraceRecord;
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
