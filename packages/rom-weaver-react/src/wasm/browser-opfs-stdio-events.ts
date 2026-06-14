import * as wasiShim from "@bjorn3/browser_wasi_shim";
import {
  addRandomAccessFileIoStats,
  createRandomAccessFileIoStats,
  isVirtualFileProxy,
  randomAccessFileIoStatsHaveData,
} from "./browser-opfs-io-adapters.ts";
import type { LineHandler, TraceLine } from "./browser-opfs-runtime-types.ts";
import { basenameForTrace } from "./workers/worker-trace-format.ts";

export {
  basenameForTrace,
  formatCommandForTrace,
  formatErrorForTrace,
} from "./workers/worker-trace-format.ts";

type RandomAccessFileIoStats = ReturnType<typeof createRandomAccessFileIoStats>;

type IoStatsSnapshotSource = {
  snapshotIoStats(): Partial<Record<keyof RandomAccessFileIoStats, unknown>>;
};

type DirectWasiFileIoStats = {
  readBytes: number;
  readCalls: number;
  readMs: number;
  writeBytes: number;
  writeCalls: number;
  writeMs: number;
};

type DirectIoReadResult = { nread: number; ret: number };
type DirectIoWriteResult = { nwritten: number; ret: number };

type DirectIoReadableFd = {
  fd_pread_into(target: Uint8Array, offset: bigint): DirectIoReadResult;
  fd_read_into(target: Uint8Array): DirectIoReadResult;
};

type DirectIoWritableFd = {
  fd_pwrite(source: Uint8Array, offset: bigint): DirectIoWriteResult;
  fd_write(source: Uint8Array): DirectIoWriteResult;
};

type WasiFdReadImport = (fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number) => unknown;
type WasiFdPreadImport = (
  fd: number,
  iovsPtr: number,
  iovsLen: number,
  offset: number | bigint,
  nreadPtr: number,
) => unknown;
type WasiFdWriteImport = (fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number) => unknown;
type WasiFdPwriteImport = (
  fd: number,
  iovsPtr: number,
  iovsLen: number,
  offset: number | bigint,
  nwrittenPtr: number,
) => unknown;

// Loose view of a WASI import table: the four file-io entries this module wraps plus
// the rom-weaver markers it installs. Keeps shim WASI instances assignable while still
// typing the wrapped imports.
type DirectFileIoImportTable = Record<string, unknown> & {
  __romWeaverDirectFileIo?: unknown;
  __romWeaverDirectFileIoStats?: unknown;
  fd_pread?: WasiFdPreadImport;
  fd_pwrite?: WasiFdPwriteImport;
  fd_read?: WasiFdReadImport;
  fd_write?: WasiFdWriteImport;
};

// Structural view of the parts of a WASI instance this module touches. Weak enough that
// both shim WASI instances and the runtime's extended wasi objects are assignable.
type DirectIoWasi = {
  fds?: ReadonlyArray<unknown>;
  inst?: { exports?: { memory?: unknown } };
  wasiImport?: DirectFileIoImportTable;
};

type BufferedWriteWasiFd = {
  flushPendingWrite(): number;
  pendingWriteBufferLength(): number;
};

export function createRunTrace(runOptions: { onTraceNonJsonLine?: unknown } | null | undefined): TraceLine {
  return createLineTrace(runOptions?.onTraceNonJsonLine);
}

export function createLineTrace(onTraceNonJsonLine: unknown): TraceLine {
  const trace = typeof onTraceNonJsonLine === "function" ? (onTraceNonJsonLine as TraceLine) : null;
  return (line) => {
    if (!trace) return;
    try {
      trace(String(line));
    } catch {
      // Trace callbacks are diagnostic only and must not affect runtime behavior.
    }
  };
}

export function summarizeRawVirtualFiles(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "count=0";
  return summarizeVirtualFileEntries(value, (entry) => {
    const record = entry as
      | {
          blob?: unknown;
          bytes?: unknown;
          data?: unknown;
          file?: unknown;
          proxy?: unknown;
          source?: unknown;
        }
      | null
      | undefined;
    return record?.source ?? record?.file ?? record?.blob ?? record?.bytes ?? record?.data ?? record?.proxy;
  });
}

export function summarizeNormalizedVirtualFiles(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "count=0";
  return summarizeVirtualFileEntries(value, (entry) => {
    const record = entry as { source?: unknown } | null | undefined;
    return record?.source;
  });
}

function summarizeVirtualFileEntries(value: ReadonlyArray<unknown>, readSource: (entry: unknown) => unknown): string {
  let proxyCount = 0;
  let directCount = 0;
  let totalBytes = 0;
  for (const entry of value) {
    const source = readSource(entry);
    if (isVirtualFileProxy(source)) {
      proxyCount += 1;
      totalBytes += Number(source.size) || 0;
      continue;
    }
    const direct = source as { byteLength?: unknown; size?: unknown } | null | undefined;
    directCount += 1;
    totalBytes += Number(direct?.size ?? direct?.byteLength ?? 0) || 0;
  }
  return `count=${value.length} proxy=${proxyCount} direct=${directCount} bytes=${totalBytes}`;
}

export function formatArgsForTrace(args: unknown): string {
  if (!Array.isArray(args) || args.length === 0) return "[]";
  return JSON.stringify(args.map((value: unknown) => basenameForTrace(value)));
}

export function installDirectWasiFileIoImports(wasi: DirectIoWasi | null | undefined, trace?: TraceLine | null): void {
  if (!wasi) return;
  const imports = wasi.wasiImport;
  if (!imports || imports.__romWeaverDirectFileIo) return;
  const originalFdRead = imports.fd_read;
  const originalFdPread = imports.fd_pread;
  const originalFdWrite = imports.fd_write;
  const originalFdPwrite = imports.fd_pwrite;
  // A complete WASI import table always defines these four entries; if any is missing the
  // module instantiation itself would fail before the wrappers could run.
  if (
    typeof originalFdRead !== "function" ||
    typeof originalFdPread !== "function" ||
    typeof originalFdWrite !== "function" ||
    typeof originalFdPwrite !== "function"
  ) {
    return;
  }
  const stats = createDirectWasiFileIoStats();
  imports.fd_read = (fd, iovsPtr, iovsLen, nreadPtr) => {
    const fdObj = wasi.fds?.[fd];
    if (!isDirectIoReadableFd(fdObj, "fd_read_into")) {
      return originalFdRead(fd, iovsPtr, iovsLen, nreadPtr);
    }
    return directWasiFileRead({
      fdObj,
      iovsLen,
      iovsPtr,
      nreadPtr,
      original: () => originalFdRead(fd, iovsPtr, iovsLen, nreadPtr),
      stats,
      wasi,
    });
  };
  imports.fd_pread = (fd, iovsPtr, iovsLen, offset, nreadPtr) => {
    const fdObj = wasi.fds?.[fd];
    if (!isDirectIoReadableFd(fdObj, "fd_pread_into")) {
      return originalFdPread(fd, iovsPtr, iovsLen, offset, nreadPtr);
    }
    return directWasiFileRead({
      fdObj,
      iovsLen,
      iovsPtr,
      nreadPtr,
      offset,
      original: () => originalFdPread(fd, iovsPtr, iovsLen, offset, nreadPtr),
      stats,
      wasi,
    });
  };
  imports.fd_write = (fd, iovsPtr, iovsLen, nwrittenPtr) => {
    const fdObj = wasi.fds?.[fd];
    if (!isDirectIoWritableFd(fdObj, "fd_write")) {
      return originalFdWrite(fd, iovsPtr, iovsLen, nwrittenPtr);
    }
    return directWasiFileWrite({
      fdObj,
      iovsLen,
      iovsPtr,
      nwrittenPtr,
      original: () => originalFdWrite(fd, iovsPtr, iovsLen, nwrittenPtr),
      stats,
      wasi,
    });
  };
  imports.fd_pwrite = (fd, iovsPtr, iovsLen, offset, nwrittenPtr) => {
    const fdObj = wasi.fds?.[fd];
    if (!isDirectIoWritableFd(fdObj, "fd_pwrite")) {
      return originalFdPwrite(fd, iovsPtr, iovsLen, offset, nwrittenPtr);
    }
    return directWasiFileWrite({
      fdObj,
      iovsLen,
      iovsPtr,
      nwrittenPtr,
      offset,
      original: () => originalFdPwrite(fd, iovsPtr, iovsLen, offset, nwrittenPtr),
      stats,
      wasi,
    });
  };
  imports.__romWeaverDirectFileIoStats = stats;
  imports.__romWeaverDirectFileIo = true;
  trace?.("[browser-opfs] direct file io imports installed");
}

function isDirectIoReadableFd(value: unknown, method: keyof DirectIoReadableFd): value is DirectIoReadableFd {
  if (!value) return false;
  return typeof (value as Partial<DirectIoReadableFd>)[method] === "function";
}

function isDirectIoWritableFd(value: unknown, method: keyof DirectIoWritableFd): value is DirectIoWritableFd {
  if (!value) return false;
  return typeof (value as Partial<DirectIoWritableFd>)[method] === "function";
}

function createDirectWasiFileIoStats(): DirectWasiFileIoStats {
  return {
    readBytes: 0,
    readCalls: 0,
    readMs: 0,
    writeBytes: 0,
    writeCalls: 0,
    writeMs: 0,
  };
}

function isDirectWasiFileIoStatsRecord(value: unknown): value is DirectWasiFileIoStats {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<DirectWasiFileIoStats>;
  return (
    typeof record.readBytes === "number" &&
    typeof record.readCalls === "number" &&
    typeof record.readMs === "number" &&
    typeof record.writeBytes === "number" &&
    typeof record.writeCalls === "number" &&
    typeof record.writeMs === "number"
  );
}

export function traceDirectWasiFileIoStats(
  trace: TraceLine | null | undefined,
  wasi: DirectIoWasi | null | undefined,
  label: string,
): void {
  if (typeof trace !== "function") return;
  const stats = wasi?.wasiImport?.__romWeaverDirectFileIoStats;
  if (!isDirectWasiFileIoStatsRecord(stats) || (stats.readCalls === 0 && stats.writeCalls === 0)) return;
  trace(
    `${label} readCalls=${stats.readCalls} readBytes=${stats.readBytes} readMs=${stats.readMs.toFixed(1)} readMiBps=${formatIoMiBps(stats.readBytes, stats.readMs)} writeCalls=${stats.writeCalls} writeBytes=${stats.writeBytes} writeMs=${stats.writeMs.toFixed(1)} writeMiBps=${formatIoMiBps(stats.writeBytes, stats.writeMs)}`,
  );
}

export function traceRandomAccessFileIoStats(
  trace: TraceLine | null | undefined,
  fds: Iterable<unknown> | null | undefined,
  label: string,
): void {
  if (typeof trace !== "function") return;
  const stats = collectRandomAccessFileIoStats(fds);
  if (!randomAccessFileIoStatsHaveData(stats)) return;
  trace(
    `${label}` +
      ` blobReadCalls=${stats.blobReadCalls} blobReadBytes=${stats.blobReadBytes} blobReadMs=${stats.blobReadMs.toFixed(1)} blobReadMiBps=${formatIoMiBps(stats.blobReadBytes, stats.blobReadMs)}` +
      ` blobCacheHits=${stats.blobCacheHits} blobCacheMisses=${stats.blobCacheMisses} blobCacheHitBytes=${stats.blobCacheHitBytes} blobCacheFillBytes=${stats.blobCacheFillBytes}` +
      ` opfsReadCalls=${stats.opfsReadCalls} opfsReadBytes=${stats.opfsReadBytes} opfsReadMs=${stats.opfsReadMs.toFixed(1)} opfsReadMiBps=${formatIoMiBps(stats.opfsReadBytes, stats.opfsReadMs)}` +
      ` opfsCacheHits=${stats.opfsCacheHits} opfsCacheMisses=${stats.opfsCacheMisses} opfsCacheHitBytes=${stats.opfsCacheHitBytes} opfsCacheFillBytes=${stats.opfsCacheFillBytes}` +
      ` opfsWriteCalls=${stats.opfsWriteCalls} opfsWriteBytes=${stats.opfsWriteBytes} opfsWriteMs=${stats.opfsWriteMs.toFixed(1)} opfsWriteMiBps=${formatIoMiBps(stats.opfsWriteBytes, stats.opfsWriteMs)}` +
      ` opfsFlushCalls=${stats.opfsFlushCalls} opfsFlushMs=${stats.opfsFlushMs.toFixed(1)}`,
  );
}

function collectRandomAccessFileIoStats(fds: Iterable<unknown> | null | undefined): RandomAccessFileIoStats {
  const stats = createRandomAccessFileIoStats();
  const seenFiles = new Set<unknown>();
  const seenEntries = new Set<unknown>();

  const addFile = (file: unknown) => {
    if (!file || seenFiles.has(file) || !hasIoStatsSnapshot(file)) return;
    seenFiles.add(file);
    addRandomAccessFileIoStats(stats, file.snapshotIoStats());
  };

  const visitEntry = (entry: unknown) => {
    if (!entry || typeof entry !== "object" || seenEntries.has(entry)) return;
    seenEntries.add(entry);
    const record = entry as {
      contents?: unknown;
      file?: unknown;
      inode?: { file?: unknown } | null;
      mount?: { contents?: unknown } | null;
    };
    addFile(record.file);
    addFile(record.inode?.file);
    if (record.mount?.contents instanceof Map) visitEntries(record.mount.contents);
    if (record.contents instanceof Map) visitEntries(record.contents);
  };

  const visitEntries = (entries: Map<unknown, unknown>) => {
    for (const entry of entries.values()) visitEntry(entry);
  };

  for (const fd of fds ?? []) visitEntry(fd);
  return stats;
}

function hasIoStatsSnapshot(value: unknown): value is IoStatsSnapshotSource {
  return typeof (value as Partial<IoStatsSnapshotSource> | null | undefined)?.snapshotIoStats === "function";
}

function formatIoMiBps(bytes: number, elapsedMs: number): string {
  if (!(elapsedMs > 0 && bytes > 0)) return "0.0";
  return (bytes / 1048576 / (elapsedMs / 1000)).toFixed(1);
}

export function traceFlushOpenWasiFileDescriptors(
  trace: TraceLine | null | undefined,
  fds: ReadonlyArray<unknown> | null | undefined,
  label: string,
): void {
  const startMs = monotonicNowMs();
  let flushedCount = 0;
  let flushedBytes = 0;
  if (Array.isArray(fds)) {
    for (const fd of fds) {
      if (!isBufferedWriteWasiFd(fd)) continue;
      const pendingBytes = fd.pendingWriteBufferLength();
      if (pendingBytes <= 0) continue;
      const ret = fd.flushPendingWrite();
      if (ret !== wasiShim.wasi.ERRNO_SUCCESS) {
        throw new Error(`failed to flush buffered WASI fd writes: errno=${ret}`);
      }
      flushedCount += 1;
      flushedBytes += pendingBytes;
    }
  }
  if (flushedCount > 0) {
    const elapsedMs = monotonicNowMs() - startMs;
    trace?.(
      `${label} count=${flushedCount} bytes=${flushedBytes} ms=${elapsedMs.toFixed(1)} MiBps=${formatIoMiBps(flushedBytes, elapsedMs)}`,
    );
  }
}

function isBufferedWriteWasiFd(value: unknown): value is BufferedWriteWasiFd {
  if (!value) return false;
  const candidate = value as Partial<BufferedWriteWasiFd>;
  return typeof candidate.pendingWriteBufferLength === "function" && typeof candidate.flushPendingWrite === "function";
}

export function monotonicNowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function directWasiFileRead({
  fdObj,
  iovsLen,
  iovsPtr,
  nreadPtr,
  offset,
  original,
  stats,
  wasi,
}: {
  fdObj: DirectIoReadableFd;
  iovsLen: number;
  iovsPtr: number;
  nreadPtr: number;
  offset?: number | bigint;
  original: () => unknown;
  stats: DirectWasiFileIoStats;
  wasi: DirectIoWasi;
}): unknown {
  const memory = wasi?.inst?.exports?.memory;
  if (!(memory instanceof WebAssembly.Memory)) return original();

  const buffer = new DataView(memory.buffer);
  const buffer8 = new Uint8Array(memory.buffer);
  const iovecs = wasiShim.wasi.Iovec.read_bytes_array(buffer, iovsPtr, iovsLen);
  let nread = 0;
  let currentOffset = offset === undefined ? null : BigInt(offset);
  try {
    for (const iovec of iovecs) {
      const target = buffer8.subarray(iovec.buf, iovec.buf + iovec.buf_len);
      const callStartMs = monotonicNowMs();
      const result = currentOffset === null ? fdObj.fd_read_into(target) : fdObj.fd_pread_into(target, currentOffset);
      stats.readCalls += 1;
      stats.readMs += monotonicNowMs() - callStartMs;
      if (result.ret !== wasiShim.wasi.ERRNO_SUCCESS) {
        if (nread === 0 && result.ret === wasiShim.wasi.ERRNO_NOTSUP) return original();
        buffer.setUint32(nreadPtr, nread, true);
        return result.ret;
      }
      const bytesRead = Math.max(0, Math.min(Number(result.nread) || 0, iovec.buf_len));
      stats.readBytes += bytesRead;
      nread += bytesRead;
      if (currentOffset !== null) currentOffset += BigInt(bytesRead);
      if (bytesRead !== iovec.buf_len) break;
    }
    buffer.setUint32(nreadPtr, nread, true);
    return wasiShim.wasi.ERRNO_SUCCESS;
  } catch (error) {
    if (nread === 0) return original();
    throw error;
  }
}

function directWasiFileWrite({
  fdObj,
  iovsLen,
  iovsPtr,
  nwrittenPtr,
  offset,
  original,
  stats,
  wasi,
}: {
  fdObj: DirectIoWritableFd;
  iovsLen: number;
  iovsPtr: number;
  nwrittenPtr: number;
  offset?: number | bigint;
  original: () => unknown;
  stats: DirectWasiFileIoStats;
  wasi: DirectIoWasi;
}): unknown {
  const memory = wasi?.inst?.exports?.memory;
  if (!(memory instanceof WebAssembly.Memory)) return original();

  const buffer = new DataView(memory.buffer);
  const buffer8 = new Uint8Array(memory.buffer);
  const iovecs = wasiShim.wasi.Ciovec.read_bytes_array(buffer, iovsPtr, iovsLen);
  let nwritten = 0;
  let currentOffset = offset === undefined ? null : BigInt(offset);
  try {
    for (const iovec of iovecs) {
      const source = buffer8.subarray(iovec.buf, iovec.buf + iovec.buf_len);
      const callStartMs = monotonicNowMs();
      const result = currentOffset === null ? fdObj.fd_write(source) : fdObj.fd_pwrite(source, currentOffset);
      stats.writeCalls += 1;
      stats.writeMs += monotonicNowMs() - callStartMs;
      if (result.ret !== wasiShim.wasi.ERRNO_SUCCESS) {
        if (nwritten === 0 && result.ret === wasiShim.wasi.ERRNO_NOTSUP) return original();
        buffer.setUint32(nwrittenPtr, nwritten, true);
        return result.ret;
      }
      const bytesWritten = Math.max(0, Math.min(Number(result.nwritten) || 0, source.byteLength));
      stats.writeBytes += bytesWritten;
      nwritten += bytesWritten;
      if (currentOffset !== null) currentOffset += BigInt(bytesWritten);
      if (bytesWritten !== source.byteLength) break;
    }
    buffer.setUint32(nwrittenPtr, nwritten, true);
    return wasiShim.wasi.ERRNO_SUCCESS;
  } catch (error) {
    if (nwritten === 0) return original();
    throw error;
  }
}

export function createOutputCollector(
  ConsoleStdout: typeof wasiShim.ConsoleStdout,
  options: { onLine?: LineHandler } = {},
) {
  const chunks: Uint8Array[] = [];
  const lineStream = createTextLineStream(options.onLine);
  return {
    chunks,
    fd: new ConsoleStdout((bytes) => {
      const chunk = copyUint8Array(bytes);
      chunks.push(chunk);
      lineStream?.push(chunk);
    }),
    flush() {
      lineStream?.flush();
    },
  };
}

function createTextLineStream(onLine: LineHandler | undefined) {
  if (typeof onLine !== "function") return null;
  const handler = onLine;
  const decoder = new TextDecoder();
  let pending = "";

  return {
    flush() {
      pending += decoder.decode();
      if (pending.length > 0) {
        emitLine(pending);
        pending = "";
      }
    },
    push(bytes: Uint8Array) {
      pending += decoder.decode(bytes, { stream: true });
      emitCompleteLines();
    },
  };

  function emitCompleteLines() {
    let lineEnd = pending.indexOf("\n");
    while (lineEnd !== -1) {
      emitLine(pending.slice(0, lineEnd));
      pending = pending.slice(lineEnd + 1);
      lineEnd = pending.indexOf("\n");
    }
  }

  function emitLine(line: string) {
    handler(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
}

export function decodeChunks(chunks: Iterable<Uint8Array>): string {
  const decoder = new TextDecoder();
  let output = "";
  for (const chunk of chunks) {
    output += decoder.decode(chunk, { stream: true });
  }
  output += decoder.decode();
  return output;
}

function copyUint8Array(data: Uint8Array): Uint8Array {
  const copied = new Uint8Array(data.byteLength);
  copied.set(data);
  return copied;
}
