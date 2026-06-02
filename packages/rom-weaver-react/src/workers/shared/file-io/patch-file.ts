import { getFileNameExtension } from "../../../lib/path-utils.ts";
import {
  DEFAULT_FILE_NAME,
  DEFAULT_FILE_TYPE,
  isSyncByteSource,
  isWritableSyncByteSource,
  MemoryByteSource,
  normalizeRange as normalizeByteSourceRange,
  normalizeReadInto as normalizeByteSourceReadInto,
  ReadViewByteSource,
  toUint8Array,
} from "../binary/byte-sources.ts";
import type {
  ByteSourceMetadata,
  ChecksumResult,
  PatchFileChunkIterationResult as ChunkIterationResult,
  PatchFileChunkOptions as ChunkOptions,
  HashProgressCallback,
  PatchFileCopyTarget,
  PatchFileInit,
  PatchFileInstance,
  PatchFileLike,
  PatchFileReader,
  PatchFileRuntime,
  PatchFileSource,
  SyncByteSource,
  WritableSyncByteSource,
} from "../binary/types.ts";

/*
 * PatchFile.js (last update: 2024-08-21)
 * by Marc Robledo, https://www.marcrobledo.com
 *
 * a JS class for reading/writing sequentially binary data from/to a file
 * that allows much more manipulation than simple DataView
 * compatible with both browsers and Node.js
 *
 * MIT License
 *
 * Copyright (c) 2014-2024 Marc Robledo
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

type RangeResult = {
  offset: number;
  len: number;
  end: number;
};

type ReadIntoResult = {
  buffer: Uint8Array;
  bufferOffset: number;
  fileOffset: number;
  len: number;
};

type ReadablePatchFileViewInstance = PatchFileLike & {
  _readViewSource: PatchFileLike;
  _readViewOffset: number;
};

const DEFAULT_CHUNK_SIZE = 1024 * 1024;

const _toUint8Array = (source: ArrayBuffer | ArrayBufferView | ArrayLike<number> | null | undefined): Uint8Array =>
  source ? toUint8Array(source) : new Uint8Array(0);
const _copyFileMetadata = <TTarget extends PatchFileLike>(source: PatchFileLike, target: TTarget) => {
  target.fileName = source.fileName;
  target.fileType = source.fileType;
  target.littleEndian = source.littleEndian;
  if (source.filePath) target.filePath = source.filePath;
  return target;
};
const initializePatchFile = <TTarget extends object>(target: TTarget, init: PatchFileInit): TTarget => {
  const nextTarget = target as TTarget & PatchFileLike;
  nextTarget.fileName = init.fileName;
  nextTarget.fileType = init.fileType;
  nextTarget.fileSize = init.fileSize;
  nextTarget.littleEndian = init.littleEndian === true;
  nextTarget.offset = typeof init.offset === "number" ? init.offset : 0;
  nextTarget._lastRead = null;
  nextTarget._offsetsStack = [];
  if (init.filePath) nextTarget.filePath = init.filePath;
  else delete nextTarget.filePath;
  if (init._byteSource) nextTarget._byteSource = init._byteSource;
  else delete nextTarget._byteSource;
  if (init._file) nextTarget._file = init._file;
  else delete nextTarget._file;
  if (init._u8array) nextTarget._u8array = init._u8array;
  else delete nextTarget._u8array;
  return target;
};
const createPatchFileWithPrototype = <TTarget extends object>(prototype: object, init: PatchFileInit): TTarget =>
  initializePatchFile(Object.create(prototype) as TTarget, init);
const _normalizeRange = (
  file: { fileSize: number },
  offset?: number,
  len?: number,
  allowEmpty?: boolean,
): RangeResult => {
  return normalizeByteSourceRange(file.fileSize, offset, len, allowEmpty);
};
const _normalizeReadInto = (
  file: { fileSize: number },
  buffer: ArrayBuffer | ArrayBufferView,
  bufferOffset?: number,
  len?: number,
  fileOffset?: number,
): ReadIntoResult => {
  const normalized = normalizeByteSourceReadInto(file.fileSize, buffer, bufferOffset, len, fileOffset);
  return {
    buffer: normalized.target,
    bufferOffset: normalized.targetOffset,
    fileOffset: normalized.sourceOffset,
    len: normalized.readLength,
  };
};

const _syncMetadataFromByteSource = (file: PatchFileLike) => {
  const source = file._byteSource;
  if (!source) return;
  file.fileName = source.fileName || file.fileName || DEFAULT_FILE_NAME;
  file.fileType = source.fileType || file.fileType || DEFAULT_FILE_TYPE;
  file.fileSize = source.fileSize;
  if (source.filePath) file.filePath = source.filePath;
  else delete file.filePath;
  if (source instanceof MemoryByteSource) file._u8array = source._u8array;
  else delete file._u8array;
  if ("_file" in source) file._file = (source as SyncByteSource & { _file?: Blob | File })._file;
};
const _syncStorageFromByteSource = (file: PatchFileLike) => {
  const source = file._byteSource;
  if (!source) return;
  file.fileSize = source.fileSize;
  if (source instanceof MemoryByteSource) file._u8array = source._u8array;
  else delete file._u8array;
};

const _setByteSource = (file: PatchFileLike, source: SyncByteSource) => {
  file._byteSource = source;
  _syncMetadataFromByteSource(file);
};

class PatchFile implements PatchFileLike {
  static RUNTIME_ENVIROMENT: PatchFileRuntime = (() => {
    if (typeof window === "object" && typeof window.document === "object") return "browser";
    if (
      typeof self === "object" &&
      self !== null &&
      typeof (globalThis as { importScripts?: RuntimeValue }).importScripts === "function" &&
      !("document" in self)
    )
      return "webworker";
    return null;
  })();
  static DEVICE_LITTLE_ENDIAN = (() => {
    const buffer = new ArrayBuffer(2);
    new DataView(buffer).setInt16(0, 256, true);
    return new Int16Array(buffer)[0] === 256;
  })();
  static DEFAULT_CHUNK_SIZE = DEFAULT_CHUNK_SIZE;

  static createReadView(source: PatchFileLike, offset?: number, len?: number) {
    return new ReadablePatchFileView(source, offset, len);
  }

  fileName = DEFAULT_FILE_NAME;
  fileType = DEFAULT_FILE_TYPE;
  fileSize = 0;
  littleEndian = false;
  offset = 0;
  filePath?: string;
  _file?: Blob | File;
  _fileReader?: PatchFileReader;
  _byteSource?: SyncByteSource;
  _u8array?: Uint8Array;
  _lastRead: number | string | number[] | null = null;
  _offsetsStack: number[] = [];
  _sharedReadScratch?: Uint8Array;
  _readViewSource?: PatchFileLike;
  _readViewOffset?: number;

  constructor(source: PatchFileSource, onLoad?: (file: PatchFileInstance) => void) {
    if (isSyncByteSource(source)) {
      _setByteSource(this, source);
      if (typeof onLoad === "function") onLoad(this);
      return;
    }

    if (
      PatchFile.RUNTIME_ENVIROMENT === "browser" &&
      ((typeof File !== "undefined" && source instanceof File) ||
        (typeof FileList !== "undefined" && source instanceof FileList) ||
        (typeof HTMLInputElement !== "undefined" &&
          source instanceof HTMLInputElement &&
          source.tagName === "INPUT" &&
          source.type === "file"))
    ) {
      let browserSource: File | undefined;
      if (typeof HTMLInputElement !== "undefined" && source instanceof HTMLInputElement)
        browserSource = source.files?.[0];
      else if (typeof FileList !== "undefined" && source instanceof FileList) browserSource = source[0];
      else browserSource = source as File;
      if (!browserSource) throw new Error("invalid PatchFile source");

      this.fileName = browserSource.name;
      this.fileType = browserSource.type;
      this.fileSize = browserSource.size;
      this._file = browserSource;
      throw new Error("PatchFile does not accept browser File sources directly; stage or materialize them first");
    }
    if (source instanceof PatchFile) {
      const bytes = new Uint8Array(new ArrayBuffer(source.fileSize));
      if (source.fileSize) source.readIntoAt(bytes, 0, source.fileSize, 0);
      _setByteSource(this, new MemoryByteSource(bytes, { fileName: source.fileName, fileType: source.fileType }));
      this.littleEndian = source.littleEndian;
      if (typeof onLoad === "function") onLoad(this);
      return;
    }
    if (source instanceof ArrayBuffer) {
      _setByteSource(this, new MemoryByteSource(source));
      if (typeof onLoad === "function") onLoad(this);
      return;
    }
    if (ArrayBuffer.isView(source)) {
      _setByteSource(this, new MemoryByteSource(source));
      if (typeof onLoad === "function") onLoad(this);
      return;
    }
    if (typeof source === "number") {
      _setByteSource(this, new MemoryByteSource(source));
      if (typeof onLoad === "function") onLoad(this);
      return;
    }
    throw new Error("invalid PatchFile source");
  }

  push() {
    this._offsetsStack.push(this.offset);
  }

  pop() {
    const offset = this._offsetsStack.pop();
    this.seek(typeof offset === "number" ? offset : 0);
  }

  seek(offset: number) {
    this.offset = offset;
  }

  skip(nBytes: number) {
    this.offset += nBytes;
  }

  isEOF() {
    return !(this.offset < this.fileSize);
  }

  _getReadScratch(size: number) {
    const minLength = Math.max(1, Math.floor(size) || 1);
    if (!this._sharedReadScratch || this._sharedReadScratch.byteLength < minLength)
      this._sharedReadScratch = new Uint8Array(minLength);
    return this._sharedReadScratch;
  }

  readIntoAt(buffer: ArrayBuffer | ArrayBufferView, bufferOffset?: number, len?: number, fileOffset?: number) {
    const normalized = _normalizeReadInto(this, buffer, bufferOffset, len, fileOffset);
    if (!normalized.len) return 0;

    if (this._byteSource)
      return this._byteSource.readIntoAt(
        normalized.buffer,
        normalized.bufferOffset,
        normalized.len,
        normalized.fileOffset,
      );
    if (this._u8array) {
      normalized.buffer.set(
        this._u8array.subarray(normalized.fileOffset, normalized.fileOffset + normalized.len),
        normalized.bufferOffset,
      );
      return normalized.len;
    }
    if (typeof this.readBytesAt === "function" && this.readBytesAt !== PatchFile.prototype.readBytesAt) {
      const bytes = _toUint8Array(this.readBytesAt(normalized.fileOffset, normalized.len));
      const bytesRead = Math.min(normalized.len, bytes.byteLength);
      normalized.buffer.set(bytes.subarray(0, bytesRead), normalized.bufferOffset);
      return bytesRead;
    }
    if (typeof this.readU8At === "function") {
      for (let i = 0; i < normalized.len; i++)
        normalized.buffer[normalized.bufferOffset + i] = this.readU8At(normalized.fileOffset + i);
      return normalized.len;
    }
    throw new Error("readIntoAt is not implemented for this PatchFile");
  }

  forEachChunk(
    start: number | undefined,
    len: number | undefined,
    callback: (bytes: Uint8Array, fileOffset: number, loaded: number, total: number) => boolean | undefined,
    options?: ChunkOptions,
  ) {
    if (typeof callback !== "function") return 0;

    const range = _normalizeRange(this, start, len, true);
    if (!range.len) return 0;

    let loaded = 0;
    for (const chunk of this.iterateChunks(range.offset, range.len, options)) {
      loaded += chunk.bytes.byteLength;
      if (callback(chunk.bytes, chunk.offset, loaded, range.len) === false) return loaded;
    }
    return loaded;
  }

  *iterateChunks(start?: number, len?: number, options?: ChunkOptions): IterableIterator<ChunkIterationResult> {
    const range = _normalizeRange(this, start, len, true);
    if (!range.len) return;

    const reusableBuffer = options && options.buffer instanceof Uint8Array ? options.buffer : null;
    const chunkSize = Math.max(
      1,
      reusableBuffer
        ? reusableBuffer.byteLength
        : Math.floor(options?.chunkSize ? options.chunkSize : PatchFile.DEFAULT_CHUNK_SIZE),
    );
    let loaded = 0;
    while (loaded < range.len) {
      const fileOffset = range.offset + loaded;
      const readLength = Math.min(chunkSize, range.len - loaded);
      let chunk: Uint8Array;
      if (reusableBuffer) {
        const bytesRead = this.readIntoAt(reusableBuffer, 0, readLength, fileOffset);
        chunk = reusableBuffer.subarray(0, bytesRead);
      } else if (this._u8array) {
        chunk = this._u8array.subarray(fileOffset, fileOffset + readLength);
      } else {
        const scratch = new Uint8Array(readLength);
        const bytesRead = this.readIntoAt(scratch, 0, readLength, fileOffset);
        chunk = scratch.subarray(0, bytesRead);
      }

      if (!chunk.byteLength) break;
      loaded += chunk.byteLength;
      yield {
        bytes: chunk,
        offset: fileOffset,
      };
    }
  }

  materialize(offset?: number, len?: number) {
    const range = _normalizeRange(this, offset, len, true);
    const materialized = new PatchFile(range.len);
    _copyFileMetadata(this, materialized);
    if (range.len && materialized._u8array) this.readIntoAt(materialized._u8array, 0, range.len, range.offset);
    return materialized;
  }

  slice(offset?: number, len?: number, doNotClone?: boolean) {
    const range = _normalizeRange(this, offset, len, false);
    if (range.offset === 0 && range.len === this.fileSize && doNotClone) return this;

    if (this._byteSource && doNotClone) {
      const slicedFile = new PatchFile(this._byteSource.slice(range.offset, range.len, true));
      _copyFileMetadata(this, slicedFile);
      slicedFile.fileSize = range.len;
      slicedFile.littleEndian = this.littleEndian;
      return slicedFile;
    }
    return this.materialize(range.offset, range.len);
  }

  prependBytes(bytes: Uint8Array | number[]) {
    const newFile = new PatchFile(this.fileSize + bytes.length);
    newFile.seek(0);
    newFile.writeBytes(bytes);
    this.copyTo(newFile, 0, this.fileSize, bytes.length);

    this.fileSize = newFile.fileSize;
    this._u8array = newFile._u8array;
    if (newFile._byteSource) this._byteSource = newFile._byteSource;
    return this;
  }

  removeLeadingBytes(nBytes: number) {
    this.seek(0);
    const oldData = this.readBytes(nBytes);
    const newFile = this.slice(nBytes);

    this.fileSize = newFile.fileSize;
    this._u8array = newFile._u8array;
    if (newFile._byteSource) this._byteSource = newFile._byteSource;
    return oldData;
  }

  copyTo(target: PatchFileCopyTarget, offsetSource?: number, len?: number, offsetTarget?: number) {
    if (!(target instanceof PatchFile) && typeof target.writeBytesAt !== "function")
      throw new Error("target is not a PatchFile object");

    const resolvedOffsetTarget =
      typeof offsetTarget === "number"
        ? offsetTarget
        : (() => {
            if (typeof offsetSource === "number") return offsetSource;
            return 0;
          })();
    const range = _normalizeRange(this, offsetSource, len, true);
    if (!range.len) return;

    const writeBytesAt = target.writeBytesAt;
    if (typeof writeBytesAt === "function") {
      const copyBuffer = this._u8array
        ? null
        : this._getReadScratch(Math.min(PatchFile.DEFAULT_CHUNK_SIZE, Math.max(1, range.len)));
      this.forEachChunk(
        range.offset,
        range.len,
        (bytes, fileOffset) => {
          writeBytesAt.call(target, resolvedOffsetTarget + (fileOffset - range.offset), bytes);
        },
        {
          buffer: copyBuffer,
          chunkSize: PatchFile.DEFAULT_CHUNK_SIZE,
        },
      );
      return;
    }

    target._u8array?.set(this.readBytesAt(range.offset, range.len), offsetTarget);
  }

  readU8At(offset: number) {
    if (this._byteSource) {
      const scratch = this._getReadScratch(1);
      return this._byteSource.readIntoAt(scratch, 0, 1, offset) ? (scratch[0] ?? 0) : 0;
    }
    if (this._u8array) return this._u8array[offset] ?? 0;
    const scratch = this._getReadScratch(1);
    return this.readIntoAt(scratch, 0, 1, offset) ? (scratch[0] ?? 0) : 0;
  }

  readBytesAt(offset: number, len: number) {
    const range = _normalizeRange(this, offset, len, true);
    if (this._byteSource) return this._byteSource.readBytesAt(range.offset, range.len);
    if (this._u8array) return this._u8array.subarray(range.offset, range.end);
    const bytes = new Uint8Array(range.len);
    if (range.len) this.readIntoAt(bytes, 0, range.len, range.offset);
    return bytes;
  }

  writeU8At(offset: number, value: number) {
    if (isWritableSyncByteSource(this._byteSource)) {
      this._byteSource.writeBytesAt(offset, new Uint8Array([value & 0xff]));
      _syncStorageFromByteSource(this);
      return;
    }
    if (!this._u8array) throw new Error("PatchFile is not writable");
    this._u8array[offset] = value;
  }

  writeBytesAt(offset: number, bytes: ArrayBuffer | ArrayBufferView | number[]) {
    if (isWritableSyncByteSource(this._byteSource)) {
      this._byteSource.writeBytesAt(offset, bytes);
      _syncStorageFromByteSource(this);
      return;
    }
    if (!this._u8array) throw new Error("PatchFile is not writable");
    this._u8array.set(_toUint8Array(bytes), offset);
  }

  save() {
    if (PatchFile.RUNTIME_ENVIROMENT === "browser") {
      if (!this._u8array) throw new Error("PatchFile has no data to save");
      const fileBlob = new Blob(
        [
          this._u8array.buffer.slice(
            this._u8array.byteOffset,
            this._u8array.byteOffset + this._u8array.byteLength,
          ) as ArrayBuffer,
        ],
        { type: this.fileType },
      );
      const blobUrl = URL.createObjectURL(fileBlob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = this.fileName;
      a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(blobUrl);
        if (a.parentElement) a.parentElement.removeChild(a);
      }, 0);
    } else {
      throw new Error("invalid runtime environment, can't save file");
    }
  }

  getExtension() {
    return getFileNameExtension(this.fileName);
  }

  getName() {
    return this.fileName.replace(new RegExp(`\\.${this.getExtension()}$`, "i"), "");
  }

  setExtension(newExtension: string) {
    this.fileName = `${this.getName()}.${newExtension}`;
    return this.fileName;
  }

  setName(newName: string) {
    this.fileName = `${newName}.${this.getExtension()}`;
    return this.fileName;
  }

  readU8() {
    this._lastRead = this.readU8At(this.offset);
    this.offset++;
    return this._lastRead;
  }

  readU16() {
    const bytes = this._getReadScratch(2);
    this.readIntoAt(bytes, 0, 2, this.offset);
    if (this.littleEndian) this._lastRead = (bytes[0] ?? 0) + ((bytes[1] ?? 0) << 8);
    else this._lastRead = ((bytes[0] ?? 0) << 8) + (bytes[1] ?? 0);
    this.offset += 2;
    return (this._lastRead as number) >>> 0;
  }

  readU24() {
    const bytes = this._getReadScratch(3);
    this.readIntoAt(bytes, 0, 3, this.offset);
    if (this.littleEndian) this._lastRead = (bytes[0] ?? 0) + ((bytes[1] ?? 0) << 8) + ((bytes[2] ?? 0) << 16);
    else this._lastRead = ((bytes[0] ?? 0) << 16) + ((bytes[1] ?? 0) << 8) + (bytes[2] ?? 0);
    this.offset += 3;
    return (this._lastRead as number) >>> 0;
  }

  readU32() {
    const bytes = this._getReadScratch(4);
    this.readIntoAt(bytes, 0, 4, this.offset);
    if (this.littleEndian)
      this._lastRead = (bytes[0] ?? 0) + ((bytes[1] ?? 0) << 8) + ((bytes[2] ?? 0) << 16) + ((bytes[3] ?? 0) << 24);
    else this._lastRead = ((bytes[0] ?? 0) << 24) + ((bytes[1] ?? 0) << 16) + ((bytes[2] ?? 0) << 8) + (bytes[3] ?? 0);
    this.offset += 4;
    return (this._lastRead as number) >>> 0;
  }

  readU64() {
    const bytes = this._getReadScratch(8);
    this.readIntoAt(bytes, 0, 8, this.offset);
    let value = 0;
    if (this.littleEndian) {
      for (let i = 7; i >= 0; i--) value = value * 256 + (bytes[i] ?? 0);
    } else {
      for (let j = 0; j < 8; j++) value = value * 256 + (bytes[j] ?? 0);
    }
    this._lastRead = value;
    this.offset += 8;
    return this._lastRead as number;
  }

  readBytes(len: number) {
    this._lastRead = Array.from(this.readBytesAt(this.offset, len));
    this.offset += len;
    return this._lastRead as number[];
  }

  readString(len: number) {
    this._lastRead = "";
    const bytes = this.readBytesAt(this.offset, len);
    for (let i = 0; i < bytes.byteLength && (bytes[i] ?? 0) > 0; i++) {
      (this._lastRead as string) += String.fromCharCode(bytes[i] ?? 0);
    }
    this.offset += len;
    return this._lastRead as string;
  }

  writeU8(u8: number) {
    this.writeBytesAt(this.offset, new Uint8Array([u8 & 0xff]));
    this.offset++;
  }

  writeU16(u16: number) {
    const bytes = new Uint8Array(2);
    if (this.littleEndian) {
      bytes[0] = u16 & 0xff;
      bytes[1] = u16 >> 8;
    } else {
      bytes[0] = u16 >> 8;
      bytes[1] = u16 & 0xff;
    }
    this.writeBytesAt(this.offset, bytes);
    this.offset += 2;
  }

  writeU24(u24: number) {
    const bytes = new Uint8Array(3);
    if (this.littleEndian) {
      bytes[0] = u24 & 0x0000ff;
      bytes[1] = (u24 & 0x00ff00) >> 8;
      bytes[2] = (u24 & 0xff0000) >> 16;
    } else {
      bytes[0] = (u24 & 0xff0000) >> 16;
      bytes[1] = (u24 & 0x00ff00) >> 8;
      bytes[2] = u24 & 0x0000ff;
    }
    this.writeBytesAt(this.offset, bytes);
    this.offset += 3;
  }

  writeU32(u32: number) {
    const bytes = new Uint8Array(4);
    if (this.littleEndian) {
      bytes[0] = u32 & 0x000000ff;
      bytes[1] = (u32 & 0x0000ff00) >> 8;
      bytes[2] = (u32 & 0x00ff0000) >> 16;
      bytes[3] = (u32 & 0xff000000) >> 24;
    } else {
      bytes[0] = (u32 & 0xff000000) >> 24;
      bytes[1] = (u32 & 0x00ff0000) >> 16;
      bytes[2] = (u32 & 0x0000ff00) >> 8;
      bytes[3] = u32 & 0x000000ff;
    }
    this.writeBytesAt(this.offset, bytes);
    this.offset += 4;
  }

  writeBytes(a: ArrayLike<number>) {
    this.writeBytesAt(this.offset, Array.from(a));
    this.offset += a.length;
  }

  writeString(str: string, len?: number) {
    const resolvedLength = len || str.length;
    const bytes = new Uint8Array(resolvedLength);
    let i = 0;
    for (; i < str.length && i < resolvedLength; i++) bytes[i] = str.charCodeAt(i);

    for (; i < resolvedLength; i++) bytes[i] = 0x00;
    this.writeBytesAt(this.offset, bytes);
    this.offset += resolvedLength;
  }

  swapBytes(swapSize?: number, newFile?: boolean) {
    let resolvedSwapSize = swapSize;
    if (typeof resolvedSwapSize !== "number") resolvedSwapSize = 4;

    if (this.fileSize % resolvedSwapSize !== 0) throw new Error(`file size is not divisible by ${resolvedSwapSize}`);

    const swappedFile = new PatchFile(this.fileSize);
    this.seek(0);
    while (!this.isEOF()) swappedFile.writeBytes(this.readBytes(resolvedSwapSize).reverse());

    if (newFile) {
      swappedFile.fileName = this.fileName;
      swappedFile.fileType = this.fileType;
      return swappedFile;
    }

    this._u8array = swappedFile._u8array;
    if (swappedFile._byteSource) this._byteSource = swappedFile._byteSource;
    return this;
  }
}

const createPatchFile = (source: PatchFileSource, onLoad?: (file: PatchFileInstance) => void): PatchFileInstance =>
  new PatchFile(source, onLoad);

const createReadView = (source: PatchFileLike, offset?: number, len?: number): ReadablePatchFileViewInstance =>
  new ReadablePatchFileView(source, offset, len);

const setPatchFileRuntime = (runtime: PatchFileRuntime) => {
  PatchFile.RUNTIME_ENVIROMENT = runtime;
};

const getPatchFileRuntime = () => PatchFile.RUNTIME_ENVIROMENT;
const PATCH_FILE_DEFAULT_CHUNK_SIZE = PatchFile.DEFAULT_CHUNK_SIZE;
const PATCH_FILE_DEVICE_LITTLE_ENDIAN = PatchFile.DEVICE_LITTLE_ENDIAN;
const patchFilePrototype = PatchFile.prototype;

class ReadablePatchFileView extends PatchFile implements ReadablePatchFileViewInstance {
  declare _readViewSource: PatchFileLike;
  declare _readViewOffset: number;

  constructor(source: PatchFileLike, offset?: number, len?: number) {
    super(0);
    const baseSource = source._readViewSource ? source._readViewSource : source;
    const baseOffset = typeof source._readViewOffset === "number" ? source._readViewOffset : 0;
    const range = _normalizeRange(source, offset, len, true);
    const byteSource = source._byteSource
      ? new ReadViewByteSource(source._byteSource, range.offset, range.len)
      : undefined;

    initializePatchFile(this as RuntimeValue as object, {
      _byteSource: byteSource,
      fileName: source.fileName,
      filePath: source.filePath,
      fileSize: range.len,
      fileType: source.fileType,
    });
    this._readViewSource = baseSource;
    this._readViewOffset = baseOffset + range.offset;
    this.littleEndian = source.littleEndian;
  }

  override readIntoAt(buffer: ArrayBuffer | ArrayBufferView, bufferOffset?: number, len?: number, fileOffset?: number) {
    const normalized = _normalizeReadInto(this, buffer, bufferOffset, len, fileOffset);
    if (!normalized.len) return 0;
    return this._readViewSource.readIntoAt(
      normalized.buffer,
      normalized.bufferOffset,
      normalized.len,
      this._readViewOffset + normalized.fileOffset,
    );
  }

  override readU8At(offset: number) {
    const scratch = this._getReadScratch(1);
    return this.readIntoAt(scratch, 0, 1, offset) ? (scratch[0] ?? 0) : 0;
  }

  override readBytesAt(offset: number, len: number) {
    const range = _normalizeRange(this, offset, len, true);
    const bytes = new Uint8Array(range.len);
    if (range.len) this.readIntoAt(bytes, 0, range.len, range.offset);
    return bytes;
  }

  override slice(offset?: number, len?: number, doNotClone?: boolean) {
    const range = _normalizeRange(this, offset, len, false);
    if (range.offset === 0 && range.len === this.fileSize && doNotClone) return this;
    return new ReadablePatchFileView(this, range.offset, range.len);
  }
}

export type {
  ByteSourceMetadata,
  ChecksumResult,
  HashProgressCallback,
  PatchFileCopyTarget,
  PatchFileInit,
  PatchFileInstance,
  PatchFileLike,
  PatchFileReader,
  PatchFileRuntime,
  PatchFileSource,
  SyncByteSource,
  WritableSyncByteSource,
};
export default PatchFile;
export {
  createPatchFile,
  createPatchFileWithPrototype,
  createReadView,
  getPatchFileRuntime,
  initializePatchFile,
  isSyncByteSource,
  isWritableSyncByteSource,
  MemoryByteSource,
  PATCH_FILE_DEFAULT_CHUNK_SIZE,
  PATCH_FILE_DEVICE_LITTLE_ENDIAN,
  patchFilePrototype,
  ReadViewByteSource,
  setPatchFileRuntime,
};
