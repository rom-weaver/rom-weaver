import * as wasiShim from "@bjorn3/browser_wasi_shim";
import {
  OPFS_SEQUENTIAL_DIRECT_WRITE_MIN_BYTES,
  OPFS_SEQUENTIAL_WRITE_BUFFER_BYTES,
} from "./browser-opfs-constants.ts";
import { requestsWriteRights } from "./browser-opfs-wasi-paths.ts";

/**
 * Structural surface this module needs from the random-access file adapters
 * (BrowserVirtualRandomAccessFile and the proxy-backed BrowserProxyRandomAccessFile).
 * Optional members exist only on some adapters and are feature-detected before use.
 */
export interface RandomAccessFileLike {
  allocateAtLeast?: (size: number) => void;
  close?: () => void;
  flush: () => void;
  readAt: (offset: number | bigint, dst: Uint8Array) => number;
  reopen?: () => void;
  scratchName?: string | null;
  size: () => number;
  supportsBufferedSequentialWrite?: boolean;
  supportsDirectWasmRead?: boolean;
  truncate: (size: number) => void;
  writeAt: (offset: number | bigint, data: Uint8Array) => number;
}

interface WasiRandomAccessFileInodeOptions {
  closeOnLastFdClose?: boolean;
  readonly?: boolean;
  scratchBacked?: boolean;
}

export class WasiRandomAccessFileInode extends wasiShim.Inode {
  closeOnLastFdClose: boolean;
  file: RandomAccessFileLike;
  openRefCount: number;
  readonly: boolean;
  scratchBacked: boolean;

  constructor(file: RandomAccessFileLike, options: WasiRandomAccessFileInodeOptions = {}) {
    super();
    this.file = file;
    this.readonly = Boolean(options.readonly);
    this.scratchBacked = Boolean(options.scratchBacked);
    this.closeOnLastFdClose = Boolean(options.closeOnLastFdClose);
    this.openRefCount = 0;
  }

  path_open(oflags: number, fsRightsBase: bigint, fdFlags: number) {
    if (this.readonly && requestsWriteRights(fsRightsBase, oflags)) {
      return { fd_obj: null, ret: wasiShim.wasi.ERRNO_PERM };
    }
    const openRet = this.prepareOpenFile();
    if (openRet !== wasiShim.wasi.ERRNO_SUCCESS) {
      return { fd_obj: null, ret: openRet };
    }
    if ((oflags & wasiShim.wasi.OFLAGS_TRUNC) === wasiShim.wasi.OFLAGS_TRUNC) {
      if (this.readonly) return { fd_obj: null, ret: wasiShim.wasi.ERRNO_PERM };
      this.file.truncate(0);
    }
    const fd = new OpenWasiRandomAccessFile(this);
    this.registerOpenFile();
    if (fdFlags & wasiShim.wasi.FDFLAGS_APPEND) fd.fd_seek(0n, wasiShim.wasi.WHENCE_END);
    return { fd_obj: fd, ret: wasiShim.wasi.ERRNO_SUCCESS };
  }

  prepareOpenFile() {
    if (this.closeOnLastFdClose && this.openRefCount === 0 && typeof this.file?.reopen === "function") {
      this.file.reopen();
    }
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  registerOpenFile() {
    this.openRefCount += 1;
  }

  releaseOpenFile() {
    if (this.openRefCount > 0) this.openRefCount -= 1;
    if (this.openRefCount !== 0 || !this.closeOnLastFdClose) return wasiShim.wasi.ERRNO_SUCCESS;
    if (typeof this.file?.close !== "function") return wasiShim.wasi.ERRNO_SUCCESS;
    try {
      this.file.close();
      return wasiShim.wasi.ERRNO_SUCCESS;
    } catch {
      return wasiShim.wasi.ERRNO_IO;
    }
  }

  get size() {
    return BigInt(this.file.size());
  }

  stat() {
    return new wasiShim.wasi.Filestat(this.ino, wasiShim.wasi.FILETYPE_REGULAR_FILE, this.size);
  }
}

function normalizeWasiReadResult(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { bytesRead: 0, ret: wasiShim.wasi.ERRNO_IO };
  const integral = Math.trunc(numeric);
  if (integral >= 0) return { bytesRead: integral, ret: wasiShim.wasi.ERRNO_SUCCESS };
  const errno = Math.abs(integral);
  if (errno > 0 && errno <= 0xffff) return { bytesRead: 0, ret: errno };
  return { bytesRead: 0, ret: wasiShim.wasi.ERRNO_IO };
}

function emitWasiReadErrorTrace(scope: string, rawValue: unknown, retCode: number) {
  if (typeof console === "undefined") return;
  const log = typeof console.debug === "function" ? console.debug : console.log;
  log.call(console, `[rom-weaver trace] browser-opfs: ${scope} readAt returned error-like value`, {
    rawValue,
    retCode,
  });
}

class OpenWasiRandomAccessFile extends wasiShim.Fd {
  closed: boolean;
  inode: WasiRandomAccessFileInode;
  position: bigint;
  writeBuffer: Uint8Array | null;
  writeBufferLength: number;
  writeBufferStart: bigint;

  constructor(inode: WasiRandomAccessFileInode) {
    super();
    this.inode = inode;
    this.position = 0n;
    this.writeBuffer = null;
    this.writeBufferStart = 0n;
    this.writeBufferLength = 0;
    this.closed = false;
  }

  override fd_allocate(offset: bigint, len: bigint) {
    if (this.closed) return wasiShim.wasi.ERRNO_BADF;
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return flushRet;
    const requested = BigInt(offset) + BigInt(len);
    if (BigInt(this.inode.file.size()) >= requested) return wasiShim.wasi.ERRNO_SUCCESS;
    if (typeof this.inode.file.allocateAtLeast === "function") {
      this.inode.file.allocateAtLeast(Number(requested));
    } else {
      this.inode.file.truncate(Number(requested));
    }
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  override fd_fdstat_get() {
    if (this.closed) {
      return {
        fdstat: null,
        ret: wasiShim.wasi.ERRNO_BADF,
      };
    }
    return {
      fdstat: new wasiShim.wasi.Fdstat(wasiShim.wasi.FILETYPE_REGULAR_FILE, 0),
      ret: wasiShim.wasi.ERRNO_SUCCESS,
    };
  }

  override fd_filestat_get() {
    if (this.closed) return { filestat: null, ret: wasiShim.wasi.ERRNO_BADF };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { filestat: null, ret: flushRet };
    return { filestat: this.inode.stat(), ret: wasiShim.wasi.ERRNO_SUCCESS };
  }

  override fd_filestat_set_size(size: bigint) {
    if (this.closed) return wasiShim.wasi.ERRNO_BADF;
    if (this.inode.readonly) return wasiShim.wasi.ERRNO_BADF;
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return flushRet;
    const nextSize = Number(size);
    this.inode.file.truncate(nextSize);
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  override fd_read(size: number) {
    if (this.closed) return { data: new Uint8Array(0), ret: wasiShim.wasi.ERRNO_BADF };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) {
      return { data: new Uint8Array(0), ret: flushRet };
    }
    const buffer = new Uint8Array(size);
    const rawRead = this.inode.file.readAt(this.position, buffer);
    const readResult = normalizeWasiReadResult(rawRead);
    if (readResult.ret !== wasiShim.wasi.ERRNO_SUCCESS) {
      emitWasiReadErrorTrace("fd_read", rawRead, readResult.ret);
      return { data: new Uint8Array(0), ret: readResult.ret };
    }
    const bytesRead = Math.max(0, Math.min(readResult.bytesRead, buffer.byteLength));
    this.position += BigInt(bytesRead);
    return { data: buffer.subarray(0, bytesRead), ret: wasiShim.wasi.ERRNO_SUCCESS };
  }

  override fd_pread(size: number, offset: bigint) {
    if (this.closed) return { data: new Uint8Array(0), ret: wasiShim.wasi.ERRNO_BADF };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) {
      return { data: new Uint8Array(0), ret: flushRet };
    }
    const buffer = new Uint8Array(size);
    const rawRead = this.inode.file.readAt(offset, buffer);
    const readResult = normalizeWasiReadResult(rawRead);
    if (readResult.ret !== wasiShim.wasi.ERRNO_SUCCESS) {
      emitWasiReadErrorTrace("fd_pread", rawRead, readResult.ret);
      return { data: new Uint8Array(0), ret: readResult.ret };
    }
    const bytesRead = Math.max(0, Math.min(readResult.bytesRead, buffer.byteLength));
    return { data: buffer.subarray(0, bytesRead), ret: wasiShim.wasi.ERRNO_SUCCESS };
  }

  fd_read_into(target: Uint8Array) {
    if (this.closed) return { nread: 0, ret: wasiShim.wasi.ERRNO_BADF };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { nread: 0, ret: flushRet };
    if (!this.inode.file.supportsDirectWasmRead) {
      return { nread: 0, ret: wasiShim.wasi.ERRNO_NOTSUP };
    }
    const rawRead = this.inode.file.readAt(this.position, target);
    const readResult = normalizeWasiReadResult(rawRead);
    if (readResult.ret !== wasiShim.wasi.ERRNO_SUCCESS) {
      emitWasiReadErrorTrace("fd_read_into", rawRead, readResult.ret);
      return { nread: 0, ret: readResult.ret };
    }
    const bytesRead = Math.max(0, Math.min(readResult.bytesRead, target.byteLength));
    this.position += BigInt(bytesRead);
    return { nread: bytesRead, ret: wasiShim.wasi.ERRNO_SUCCESS };
  }

  fd_pread_into(target: Uint8Array, offset: bigint) {
    if (this.closed) return { nread: 0, ret: wasiShim.wasi.ERRNO_BADF };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { nread: 0, ret: flushRet };
    if (!this.inode.file.supportsDirectWasmRead) {
      return { nread: 0, ret: wasiShim.wasi.ERRNO_NOTSUP };
    }
    const rawRead = this.inode.file.readAt(offset, target);
    const readResult = normalizeWasiReadResult(rawRead);
    if (readResult.ret !== wasiShim.wasi.ERRNO_SUCCESS) {
      emitWasiReadErrorTrace("fd_pread_into", rawRead, readResult.ret);
      return { nread: 0, ret: readResult.ret };
    }
    const bytesRead = Math.max(0, Math.min(readResult.bytesRead, target.byteLength));
    return { nread: bytesRead, ret: wasiShim.wasi.ERRNO_SUCCESS };
  }

  override fd_seek(offset: bigint, whence: number) {
    if (this.closed) return { offset: this.position, ret: wasiShim.wasi.ERRNO_BADF };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { offset: this.position, ret: flushRet };
    let nextPosition: bigint;
    switch (whence) {
      case wasiShim.wasi.WHENCE_SET:
        nextPosition = BigInt(offset);
        break;
      case wasiShim.wasi.WHENCE_CUR:
        nextPosition = this.position + BigInt(offset);
        break;
      case wasiShim.wasi.WHENCE_END:
        nextPosition = BigInt(this.inode.file.size()) + BigInt(offset);
        break;
      default:
        return { offset: 0n, ret: wasiShim.wasi.ERRNO_INVAL };
    }
    if (nextPosition < 0n) return { offset: 0n, ret: wasiShim.wasi.ERRNO_INVAL };
    this.position = nextPosition;
    return { offset: this.position, ret: wasiShim.wasi.ERRNO_SUCCESS };
  }

  override fd_tell() {
    if (this.closed) return { offset: this.position, ret: wasiShim.wasi.ERRNO_BADF };
    return { offset: this.position, ret: wasiShim.wasi.ERRNO_SUCCESS };
  }

  override fd_write(data: Uint8Array) {
    if (this.closed) return { nwritten: 0, ret: wasiShim.wasi.ERRNO_BADF };
    if (this.inode.readonly) return { nwritten: 0, ret: wasiShim.wasi.ERRNO_BADF };
    if (data.byteLength === 0) return { nwritten: 0, ret: wasiShim.wasi.ERRNO_SUCCESS };
    if (!this.inode.file.supportsBufferedSequentialWrite) {
      const bytesWritten = this.inode.file.writeAt(this.position, data);
      this.position += BigInt(bytesWritten);
      return { nwritten: bytesWritten, ret: wasiShim.wasi.ERRNO_SUCCESS };
    }
    return this.bufferSequentialWrite(data);
  }

  override fd_pwrite(data: Uint8Array, offset: bigint) {
    if (this.closed) return { nwritten: 0, ret: wasiShim.wasi.ERRNO_BADF };
    if (this.inode.readonly) return { nwritten: 0, ret: wasiShim.wasi.ERRNO_BADF };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { nwritten: 0, ret: flushRet };
    const bytesWritten = this.inode.file.writeAt(offset, data);
    return { nwritten: bytesWritten, ret: wasiShim.wasi.ERRNO_SUCCESS };
  }

  override fd_sync() {
    if (this.closed) return wasiShim.wasi.ERRNO_BADF;
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return flushRet;
    this.inode.file.flush();
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  override fd_close() {
    if (this.closed) return wasiShim.wasi.ERRNO_SUCCESS;
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return flushRet;
    this.closed = true;
    this.writeBuffer = null;
    this.writeBufferLength = 0;
    this.writeBufferStart = 0n;
    return this.inode.releaseOpenFile();
  }

  pendingWriteBufferLength() {
    if (this.closed) return 0;
    return this.writeBufferLength;
  }

  ensureWriteBuffer() {
    if (!this.writeBuffer) {
      this.writeBuffer = new Uint8Array(OPFS_SEQUENTIAL_WRITE_BUFFER_BYTES);
    }
    return this.writeBuffer;
  }

  flushPendingWrite() {
    if (this.closed) return wasiShim.wasi.ERRNO_BADF;
    // writeBuffer is always allocated before writeBufferLength becomes positive; the null
    // check only narrows the type and matches the empty-buffer early return.
    const buffer = this.writeBuffer;
    if (this.writeBufferLength <= 0 || buffer === null) return wasiShim.wasi.ERRNO_SUCCESS;
    const source = buffer.subarray(0, this.writeBufferLength);
    const bytesWritten = this.inode.file.writeAt(this.writeBufferStart, source);
    if (bytesWritten !== this.writeBufferLength) {
      if (bytesWritten > 0 && bytesWritten < this.writeBufferLength) {
        buffer.copyWithin(0, bytesWritten, this.writeBufferLength);
        this.writeBufferStart += BigInt(bytesWritten);
        this.writeBufferLength -= bytesWritten;
      }
      return wasiShim.wasi.ERRNO_IO;
    }
    this.writeBufferLength = 0;
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  bufferSequentialWrite(data: Uint8Array) {
    if (this.closed) return { nwritten: 0, ret: wasiShim.wasi.ERRNO_BADF };
    let nwritten = 0;
    while (nwritten < data.byteLength) {
      if (this.writeBufferLength > 0) {
        const expectedPosition = this.writeBufferStart + BigInt(this.writeBufferLength);
        if (this.position !== expectedPosition) {
          const flushRet = this.flushPendingWrite();
          if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { nwritten, ret: flushRet };
        }
      }

      if (this.writeBufferLength === 0) {
        this.writeBufferStart = this.position;
        const remaining = data.byteLength - nwritten;
        if (remaining >= OPFS_SEQUENTIAL_DIRECT_WRITE_MIN_BYTES) {
          const source = data.subarray(nwritten);
          const bytesWritten = this.inode.file.writeAt(this.position, source);
          this.position += BigInt(bytesWritten);
          nwritten += bytesWritten;
          if (bytesWritten !== source.byteLength) break;
          continue;
        }
      }

      const buffer = this.ensureWriteBuffer();
      const available = buffer.byteLength - this.writeBufferLength;
      if (available <= 0) {
        const flushRet = this.flushPendingWrite();
        if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { nwritten, ret: flushRet };
        continue;
      }
      const chunkLength = Math.min(data.byteLength - nwritten, available);
      buffer.set(data.subarray(nwritten, nwritten + chunkLength), this.writeBufferLength);
      this.writeBufferLength += chunkLength;
      this.position += BigInt(chunkLength);
      nwritten += chunkLength;
      if (this.writeBufferLength >= buffer.byteLength) {
        const flushRet = this.flushPendingWrite();
        if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { nwritten, ret: flushRet };
      }
    }
    return { nwritten, ret: wasiShim.wasi.ERRNO_SUCCESS };
  }
}
