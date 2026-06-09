import * as wasiShim from '@bjorn3/browser_wasi_shim';
import {
  addRandomAccessFileIoStats,
  createRandomAccessFileIoStats,
  isVirtualFileProxy,
  randomAccessFileIoStatsHaveData,
} from './browser-opfs-io-adapters.ts';
import type { AnyRecord, LineHandler } from './browser-opfs-runtime-types.ts';

export function createRunTrace(runOptions) {
  return createLineTrace(runOptions?.onTraceNonJsonLine);
}

export function createLineTrace(onTraceNonJsonLine) {
  const trace = typeof onTraceNonJsonLine === 'function' ? onTraceNonJsonLine : null;
  return (line) => {
    if (!trace) return;
    try {
      trace(String(line));
    } catch {
      // Trace callbacks are diagnostic only and must not affect runtime behavior.
    }
  };
}

export function summarizeRawVirtualFiles(value) {
  if (!Array.isArray(value) || value.length === 0) return 'count=0';
  return summarizeVirtualFileEntries(value, (entry) => (
    entry?.source ?? entry?.file ?? entry?.blob ?? entry?.bytes ?? entry?.data ?? entry?.proxy
  ));
}

export function summarizeNormalizedVirtualFiles(value) {
  if (!Array.isArray(value) || value.length === 0) return 'count=0';
  return summarizeVirtualFileEntries(value, (entry) => entry?.source);
}

function summarizeVirtualFileEntries(value, readSource) {
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
    directCount += 1;
    totalBytes += Number(source?.size ?? source?.byteLength ?? 0) || 0;
  }
  return `count=${value.length} proxy=${proxyCount} direct=${directCount} bytes=${totalBytes}`;
}

export function formatArgsForTrace(args) {
  if (!Array.isArray(args) || args.length === 0) return '[]';
  return JSON.stringify(args.map((value) => basenameForTrace(value)));
}

export function formatCommandForTrace(command) {
  if (!command || typeof command !== 'object') return 'unknown';
  try {
    return truncateForTrace(JSON.stringify(toTraceValue(command)));
  } catch {
    return String(command?.type ?? 'unknown');
  }
}

function toTraceValue(value) {
  if (typeof value === 'string') return basenameForTrace(value);
  if (Array.isArray(value)) return value.map((entry) => toTraceValue(entry));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) out[key] = toTraceValue(entry);
  return out;
}

export function basenameForTrace(value) {
  const text = String(value ?? '');
  if (!text.includes('/')) return text;
  return text.slice(text.lastIndexOf('/') + 1) || text;
}

export function formatErrorForTrace(error) {
  if (error instanceof Error) return `${error.name}:${truncateForTrace(error.message)}`;
  return truncateForTrace(String(error));
}

export function truncateForTrace(value, maxLength = 180) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}...`;
}

export function installDirectWasiFileIoImports(wasi, trace) {
  const imports = wasi?.wasiImport;
  if (!imports || imports.__romWeaverDirectFileIo) return;
  const stats = createDirectWasiFileIoStats();
  const originalFdRead = imports.fd_read;
  const originalFdPread = imports.fd_pread;
  const originalFdWrite = imports.fd_write;
  const originalFdPwrite = imports.fd_pwrite;
  imports.fd_read = (fd, iovsPtr, iovsLen, nreadPtr) => {
    const fdObj = wasi.fds?.[fd];
    if (!fdObj || typeof fdObj.fd_read_into !== 'function') {
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
    if (!fdObj || typeof fdObj.fd_pread_into !== 'function') {
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
    if (!fdObj || typeof fdObj.fd_write !== 'function') {
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
    if (!fdObj || typeof fdObj.fd_pwrite !== 'function') {
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
  trace?.('[browser-opfs] direct file io imports installed');
}

function createDirectWasiFileIoStats() {
  return {
    readBytes: 0,
    readCalls: 0,
    readMs: 0,
    writeBytes: 0,
    writeCalls: 0,
    writeMs: 0,
  };
}

export function traceDirectWasiFileIoStats(trace, wasi, label) {
  if (typeof trace !== 'function') return;
  const stats = wasi?.wasiImport?.__romWeaverDirectFileIoStats;
  if (!stats || (stats.readCalls === 0 && stats.writeCalls === 0)) return;
  trace(
    `${label} readCalls=${stats.readCalls} readBytes=${stats.readBytes} readMs=${stats.readMs.toFixed(1)} readMiBps=${formatIoMiBps(stats.readBytes, stats.readMs)} writeCalls=${stats.writeCalls} writeBytes=${stats.writeBytes} writeMs=${stats.writeMs.toFixed(1)} writeMiBps=${formatIoMiBps(stats.writeBytes, stats.writeMs)}`,
  );
}

export function traceRandomAccessFileIoStats(trace, fds, label) {
  if (typeof trace !== 'function') return;
  const stats = collectRandomAccessFileIoStats(fds);
  if (!randomAccessFileIoStatsHaveData(stats)) return;
  trace(
    `${label}`
    + ` blobReadCalls=${stats.blobReadCalls} blobReadBytes=${stats.blobReadBytes} blobReadMs=${stats.blobReadMs.toFixed(1)} blobReadMiBps=${formatIoMiBps(stats.blobReadBytes, stats.blobReadMs)}`
    + ` blobCacheHits=${stats.blobCacheHits} blobCacheMisses=${stats.blobCacheMisses} blobCacheHitBytes=${stats.blobCacheHitBytes} blobCacheFillBytes=${stats.blobCacheFillBytes}`
    + ` opfsReadCalls=${stats.opfsReadCalls} opfsReadBytes=${stats.opfsReadBytes} opfsReadMs=${stats.opfsReadMs.toFixed(1)} opfsReadMiBps=${formatIoMiBps(stats.opfsReadBytes, stats.opfsReadMs)}`
    + ` opfsCacheHits=${stats.opfsCacheHits} opfsCacheMisses=${stats.opfsCacheMisses} opfsCacheHitBytes=${stats.opfsCacheHitBytes} opfsCacheFillBytes=${stats.opfsCacheFillBytes}`
    + ` opfsWriteCalls=${stats.opfsWriteCalls} opfsWriteBytes=${stats.opfsWriteBytes} opfsWriteMs=${stats.opfsWriteMs.toFixed(1)} opfsWriteMiBps=${formatIoMiBps(stats.opfsWriteBytes, stats.opfsWriteMs)}`
    + ` opfsFlushCalls=${stats.opfsFlushCalls} opfsFlushMs=${stats.opfsFlushMs.toFixed(1)}`,
  );
}

function collectRandomAccessFileIoStats(fds) {
  const stats = createRandomAccessFileIoStats();
  const seenFiles = new Set();
  const seenEntries = new Set();

  const addFile = (file) => {
    if (!file || seenFiles.has(file) || typeof file.snapshotIoStats !== 'function') return;
    seenFiles.add(file);
    addRandomAccessFileIoStats(stats, file.snapshotIoStats());
  };

  const visitEntry = (entry) => {
    if (!entry || typeof entry !== 'object' || seenEntries.has(entry)) return;
    seenEntries.add(entry);
    addFile(entry.file);
    addFile(entry.inode?.file);
    if (entry.mount?.contents instanceof Map) visitEntries(entry.mount.contents);
    if (entry.contents instanceof Map) visitEntries(entry.contents);
  };

  const visitEntries = (entries) => {
    for (const entry of entries.values()) visitEntry(entry);
  };

  for (const fd of fds ?? []) visitEntry(fd);
  return stats;
}

function formatIoMiBps(bytes, elapsedMs) {
  if (!(elapsedMs > 0) || !(bytes > 0)) return '0.0';
  return ((bytes / 1048576) / (elapsedMs / 1000)).toFixed(1);
}

export function traceFlushOpenWasiFileDescriptors(trace, fds, label) {
  const startMs = monotonicNowMs();
  let flushedCount = 0;
  let flushedBytes = 0;
  if (Array.isArray(fds)) {
    for (const fd of fds) {
      if (!fd || typeof fd.pendingWriteBufferLength !== 'function' || typeof fd.flushPendingWrite !== 'function') {
        continue;
      }
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
    trace?.(`${label} count=${flushedCount} bytes=${flushedBytes} ms=${elapsedMs.toFixed(1)} MiBps=${formatIoMiBps(flushedBytes, elapsedMs)}`);
  }
}

export function monotonicNowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
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
  fdObj: any;
  iovsLen: any;
  iovsPtr: any;
  nreadPtr: any;
  offset?: any;
  original: () => any;
  stats: AnyRecord;
  wasi: any;
}) {
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
      const result = currentOffset === null
        ? fdObj.fd_read_into(target)
        : fdObj.fd_pread_into(target, currentOffset);
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
  fdObj: any;
  iovsLen: any;
  iovsPtr: any;
  nwrittenPtr: any;
  offset?: any;
  original: () => any;
  stats: AnyRecord;
  wasi: any;
}) {
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
      const result = currentOffset === null
        ? fdObj.fd_write(source)
        : fdObj.fd_pwrite(source, currentOffset);
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

export function createOutputCollector(ConsoleStdout, options: { onLine?: LineHandler } = {}) {
  const chunks = [];
  const lineStream = createTextLineStream(options.onLine);
  return {
    chunks,
    flush() {
      lineStream?.flush();
    },
    fd: new ConsoleStdout((bytes) => {
      const chunk = copyUint8Array(bytes);
      chunks.push(chunk);
      lineStream?.push(chunk);
    }),
  };
}

function createTextLineStream(onLine) {
  if (typeof onLine !== 'function') return null;
  const decoder = new TextDecoder();
  let pending = '';

  return {
    push(bytes) {
      pending += decoder.decode(bytes, { stream: true });
      emitCompleteLines();
    },
    flush() {
      pending += decoder.decode();
      if (pending.length > 0) {
        emitLine(pending);
        pending = '';
      }
    },
  };

  function emitCompleteLines() {
    let lineEnd = pending.indexOf('\n');
    while (lineEnd !== -1) {
      emitLine(pending.slice(0, lineEnd));
      pending = pending.slice(lineEnd + 1);
      lineEnd = pending.indexOf('\n');
    }
  }

  function emitLine(line) {
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  }
}

export function decodeChunks(chunks) {
  const decoder = new TextDecoder();
  let output = '';
  for (const chunk of chunks) {
    output += decoder.decode(chunk, { stream: true });
  }
  output += decoder.decode();
  return output;
}

export function copyUint8Array(data) {
  const copied = new Uint8Array(data.byteLength);
  copied.set(data);
  return copied;
}
