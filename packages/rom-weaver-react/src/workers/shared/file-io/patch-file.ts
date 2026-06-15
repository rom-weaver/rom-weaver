import { getFileNameExtension } from "../../../lib/path-utils.ts";
import {
  DEFAULT_FILE_NAME,
  DEFAULT_FILE_TYPE,
  isSyncByteSource,
  isWritableSyncByteSource,
  MemoryByteSource,
  normalizeRange as normalizeByteSourceRange,
  normalizeReadInto as normalizeByteSourceReadInto,
  toUint8Array,
} from "../binary/byte-sources.ts";
import type {
  PatchFileInstance,
  PatchFileLike,
  PatchFileReader,
  PatchFileRuntime,
  PatchFileSource,
  SyncByteSource,
} from "../binary/types.ts";

/*
 * PatchFile.js (last update: 2024-08-21)
 * by Marc Robledo, https://www.marcrobledo.com
 *
 * a JS class for reading/writing sequentially binary data from/to a file
 * that allows much more manipulation than simple DataView
 * compatible with both browsers and Node.js
 *
 * NOTE: this fork trims upstream helpers unused by rom-weaver (chunk iteration,
 * copyTo, prepend/removeLeadingBytes, swapBytes, save, and the ReadablePatchFileView
 * read-view). The seek/read/write primitives the app relies on are unchanged.
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
}
export default PatchFile;
