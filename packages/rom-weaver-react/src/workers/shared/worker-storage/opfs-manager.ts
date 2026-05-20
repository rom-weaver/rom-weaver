import {
  getManagedOpfsFileHandle,
  getManagedOpfsStorageName,
  removeManagedOpfsPath,
} from "../../protocol/opfs-path.ts";
import type { WritableSyncByteSource } from "../../shared/binary/byte-sources.ts";
import type { CoreRomPatchFileLike, WorkerPatchFile } from "../../shared/binary/types.ts";
import PatchFile, { createPatchFileWithPrototype } from "../../shared/file-io/patch-file.ts";
import { normalizeReadIntoRequest } from "../binary/binary-source-utils.ts";
import { resolveSeekPosition } from "../binary/source-file-utils.ts";
import type {
  EmscriptenFileSystem,
  EmscriptenFsNode,
  EmscriptenFsStream,
  EmscriptenNodeOps,
  EmscriptenStreamOps,
  EmscriptenWorkerModule,
} from "../wasm/emscripten-types.ts";
import { createBrowserOpfsStorageManager } from "./browser-opfs-manager.ts";
import { getBaseName, getParentPath } from "./path-utils.ts";
import type { OpfsBackend, WorkerOpfsManager } from "./types.ts";

const TRAILING_POSIX_SLASHES_REGEX = /\/+$/;
const NOT_FOUND_ERROR_REGEX = /not\s+found|object\s+can\s+not\s+be\s+found/i;

type OpfsManagerOptions = {
  moduleObject?: EmscriptenWorkerModule | null;
  mountPoint: string;
  navigatorObject?: Navigator | null;
  preferPortableMount?: boolean;
};

type OpfsPreparedFileOptions<TFile> = {
  createFile: (backend: OpfsBackend, filePath: string, fileName: string, fileType: string) => TFile;
  fileName: string;
  filePath: string;
  fileType: string;
  manager: WorkerOpfsManager;
  moduleObject?: EmscriptenWorkerModule | null;
};

const OPFS_BINFILE_WRITE_BUFFER_SIZE = 1024 * 1024;
const OPFS_BINFILE_MEMORY_MIRROR_SIZE = 128 * 1024 * 1024;
const formatOpfsErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isNotFoundError = (error: unknown) =>
  typeof DOMException !== "undefined" && error instanceof DOMException
    ? error.name === "NotFoundError"
    : error instanceof Error && NOT_FOUND_ERROR_REGEX.test(error.message);

type OpfsPatchFileInstance = WorkerPatchFile & {
  backend: OpfsBackend;
  littleEndian: boolean;
  offset: number;
  readU8: () => number;
  readU16: () => number;
  readU24: () => number;
  readU32: () => number;
  readBytes: (len: number) => number[];
  readString: (len: number) => string;
  seek: (offset: number) => void;
  skip: (nBytes: number) => void;
  isEOF: () => boolean;
  materialize: (offset?: number, len?: number) => WorkerPatchFile;
  copyTo: (target: WorkerPatchFile, offsetSource?: number, len?: number, offsetTarget?: number) => void;
  hashCRC32: (start?: number, len?: number) => Promise<number>;
  _getReadScratch: (size: number) => Uint8Array;
  _expectedFileSize: number;
  _memoryBytes: Uint8Array | null;
  _memoryDirty: boolean;
  _pendingWriteBytes: Uint8Array | null;
  _pendingWriteLength: number;
  _pendingWriteOffset: number;
  _flushMemoryMirror: () => void;
  _flushPendingWrites: () => void;
  close: () => void;
  flush: () => void;
  readIntoAt: (
    buffer: Uint8Array | ArrayBufferView | ArrayBuffer,
    bufferOffset?: number,
    len?: number,
    fileOffset?: number,
  ) => number;
  readU8At: (offset: number) => number;
  readBytesAt: (offset: number, len: number) => Uint8Array;
  reset: (size: number, fileName?: string, fileType?: string) => void;
  slice: (offset?: number, len?: number, doNotClone?: boolean) => WorkerPatchFile;
  syncExternalWrite: (size: number) => void;
  truncate: (size: number) => void;
  writeU8At: (offset: number, value: number) => void;
  writeBytesAt: (offset: number, bytes: ArrayBuffer | ArrayBufferView | ArrayLike<number>) => void;
};

const toUint8Array = (source: ArrayBuffer | ArrayBufferView | ArrayLike<number>): Uint8Array => {
  if (source instanceof Uint8Array) return source;
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return Uint8Array.from(source);
};

const createOpfsPatchFile = (
  backend: OpfsBackend,
  filePath: string,
  fileName: string,
  fileType: string,
): OpfsPatchFileInstance => {
  const binFile = createPatchFileWithPrototype<OpfsPatchFileInstance>(PatchFile.prototype, {
    fileName,
    filePath,
    fileSize: backend.size || 0,
    fileType,
  });
  binFile.backend = backend;
  binFile._fileHandle = backend.fileHandle;
  binFile._expectedFileSize = backend.size || 0;
  binFile._memoryBytes = null;
  binFile._memoryDirty = false;
  binFile._pendingWriteBytes = null;
  binFile._pendingWriteLength = 0;
  binFile._pendingWriteOffset = 0;
  binFile._flushPendingWrites = function () {
    if (this._memoryBytes || !this._pendingWriteLength || !this._pendingWriteBytes) return;
    const bytesWritten = this.backend.accessHandle.write(
      this._pendingWriteBytes.subarray(0, this._pendingWriteLength),
      {
        at: this._pendingWriteOffset,
      },
    );
    this.backend.size = Math.max(this.backend.size, this._pendingWriteOffset + bytesWritten);
    this.backend.timestamp = Date.now();
    this.fileSize = Math.max(this._expectedFileSize, this.backend.size);
    this._pendingWriteLength = 0;
  };
  binFile._flushMemoryMirror = function () {
    if (!(this._memoryBytes && this._memoryDirty)) return;
    if (this.backend.size > this._memoryBytes.byteLength) {
      this._memoryBytes = null;
      this._memoryDirty = false;
      return;
    }
    this.backend.accessHandle.truncate(this._memoryBytes.byteLength);
    if (this._memoryBytes.byteLength) this.backend.accessHandle.write(this._memoryBytes, { at: 0 });
    this.backend.size = this._memoryBytes.byteLength;
    this.backend.timestamp = Date.now();
    this.fileSize = this.backend.size;
    this._memoryDirty = false;
  };
  binFile.readIntoAt = function (
    buffer: Uint8Array | ArrayBufferView | ArrayBuffer,
    bufferOffset?: number,
    len?: number,
    fileOffset?: number,
  ) {
    const { target, targetOffset, sourceOffset, readLength } = normalizeReadIntoRequest({
      buffer,
      bufferOffset,
      fileOffset,
      fileSize: this.fileSize,
      invalidLabel: "Invalid OPFS read target",
      len,
    });
    if (!readLength) return 0;
    if (this._memoryBytes) {
      target.set(this._memoryBytes.subarray(sourceOffset, sourceOffset + readLength), targetOffset);
      return readLength;
    }
    this._flushPendingWrites();
    return this.backend.accessHandle.read(target.subarray(targetOffset, targetOffset + readLength), {
      at: sourceOffset,
    });
  };
  binFile.readU8At = function (offset: number) {
    const scratch = this._getReadScratch(1);
    return this.readIntoAt(scratch, 0, 1, offset) ? (scratch[0] ?? 0) : 0;
  };
  binFile.readBytesAt = function (offset: number, len: number) {
    const bytes = new Uint8Array(Math.max(0, len || 0));
    const readLength = this.readIntoAt(bytes, 0, bytes.byteLength, offset);
    return readLength === bytes.byteLength ? bytes : bytes.subarray(0, readLength);
  };
  binFile.writeU8At = function (offset: number, value: number) {
    this.writeBytesAt(offset, new Uint8Array([value & 0xff]));
  };
  binFile.writeBytesAt = function (offset: number, bytes: ArrayBuffer | ArrayBufferView | ArrayLike<number>) {
    const u8array = toUint8Array(bytes);
    if (!u8array.byteLength) return;
    if (this._memoryBytes) {
      const endOffset = offset + u8array.byteLength;
      if (endOffset > this._memoryBytes.byteLength)
        throw new Error(`Write exceeds mirrored OPFS file size: ${endOffset} > ${this._memoryBytes.byteLength}`);
      this._memoryBytes.set(u8array, offset);
      this.backend.size = Math.max(this.backend.size, endOffset);
      this.backend.timestamp = Date.now();
      this.fileSize = this.backend.size;
      this._memoryDirty = true;
      return;
    }
    if (!this._pendingWriteBytes) this._pendingWriteBytes = new Uint8Array(OPFS_BINFILE_WRITE_BUFFER_SIZE);
    if (this._pendingWriteLength && offset !== this._pendingWriteOffset + this._pendingWriteLength)
      this._flushPendingWrites();
    if (u8array.byteLength >= OPFS_BINFILE_WRITE_BUFFER_SIZE) {
      this._flushPendingWrites();
      const bytesWritten = this.backend.accessHandle.write(u8array, { at: offset });
      this.backend.size = Math.max(this.backend.size, offset + bytesWritten);
      this.backend.timestamp = Date.now();
      this.fileSize = Math.max(this._expectedFileSize, this.backend.size);
      return;
    }
    if (!this._pendingWriteLength) this._pendingWriteOffset = offset;
    let written = 0;
    while (written < u8array.byteLength) {
      if (!this._pendingWriteBytes) this._pendingWriteBytes = new Uint8Array(OPFS_BINFILE_WRITE_BUFFER_SIZE);
      const remainingCapacity = OPFS_BINFILE_WRITE_BUFFER_SIZE - this._pendingWriteLength;
      if (!remainingCapacity) {
        this._flushPendingWrites();
        this._pendingWriteOffset = offset + written;
        continue;
      }
      const chunkLength = Math.min(remainingCapacity, u8array.byteLength - written);
      this._pendingWriteBytes.set(u8array.subarray(written, written + chunkLength), this._pendingWriteLength);
      this._pendingWriteLength += chunkLength;
      written += chunkLength;
      this.backend.size = Math.max(this.backend.size, offset + written);
      this.fileSize = Math.max(this._expectedFileSize, this.backend.size);
      if (this._pendingWriteLength === OPFS_BINFILE_WRITE_BUFFER_SIZE) this._flushPendingWrites();
    }
    this.backend.timestamp = Date.now();
  };
  binFile.truncate = function (size: number) {
    if (this._memoryBytes) {
      const normalizedSize = Math.max(0, Math.floor(size || 0));
      if (normalizedSize !== this._memoryBytes.byteLength) {
        const resized = new Uint8Array(normalizedSize);
        resized.set(this._memoryBytes.subarray(0, Math.min(this._memoryBytes.byteLength, normalizedSize)));
        this._memoryBytes = resized;
        this._memoryDirty = true;
      }
      this.backend.size = normalizedSize;
      this.backend.timestamp = Date.now();
      this.fileSize = normalizedSize;
      if (this.offset > normalizedSize) this.offset = normalizedSize;
      return;
    }
    this._flushPendingWrites();
    this.backend.accessHandle.truncate(size);
    this.backend.size = size;
    this._expectedFileSize = size;
    this.backend.timestamp = Date.now();
    this.fileSize = size;
    if (this.offset > size) this.offset = size;
  };
  binFile.reset = function (size: number, nextFileName?: string, nextFileType?: string) {
    this.fileName = nextFileName || this.fileName;
    this.fileType = nextFileType || this.fileType;
    this.offset = 0;
    const normalizedSize = Math.max(0, Math.floor(size || 0));
    this._expectedFileSize = normalizedSize;
    if (normalizedSize <= OPFS_BINFILE_MEMORY_MIRROR_SIZE) {
      this._pendingWriteLength = 0;
      this._memoryBytes = new Uint8Array(normalizedSize);
      this._memoryDirty = true;
      this.backend.size = normalizedSize;
      this.fileSize = normalizedSize;
      return;
    }
    this._pendingWriteLength = 0;
    this._memoryBytes = null;
    this._memoryDirty = false;
    this.backend.accessHandle.truncate(0);
    this.backend.size = 0;
    this.backend.timestamp = Date.now();
    this.fileSize = normalizedSize;
  };
  binFile.slice = function (offset?: number, len?: number, doNotClone?: boolean) {
    const normalizedOffset = typeof offset !== "number" || offset < 0 ? 0 : Math.floor(offset);
    if (normalizedOffset >= this.fileSize) throw new Error("out of bounds slicing");
    const normalizedLen =
      typeof len !== "number" || len < 0 || normalizedOffset + len > this.fileSize
        ? this.fileSize - normalizedOffset
        : Math.floor(len);
    if (normalizedLen === 0) throw new Error("zero length provided for slicing");
    if (normalizedOffset === 0 && normalizedLen === this.fileSize && doNotClone) return this;
    return PatchFile.createReadView(
      this as unknown as Parameters<typeof PatchFile.createReadView>[0],
      normalizedOffset,
      normalizedLen,
    ) as unknown as WorkerPatchFile;
  };
  binFile.flush = function () {
    if (this.backend.closed) return;
    this._flushMemoryMirror();
    this._flushPendingWrites();
    if (!this._memoryBytes && this._expectedFileSize > this.backend.size) {
      this.backend.accessHandle.truncate(this._expectedFileSize);
      this.backend.size = this._expectedFileSize;
      this.backend.timestamp = Date.now();
      this.fileSize = this._expectedFileSize;
    }
    this.backend.accessHandle.flush();
  };
  binFile.syncExternalWrite = function (size: number) {
    const normalizedSize = Math.max(0, Math.floor(size || 0));
    this._pendingWriteLength = 0;
    this._memoryBytes = null;
    this._memoryDirty = false;
    this._expectedFileSize = normalizedSize;
    this.backend.size = normalizedSize;
    this.backend.timestamp = Date.now();
    this.fileSize = normalizedSize;
    if (this.offset > normalizedSize) this.offset = normalizedSize;
    if (!this.backend.closed) this.backend.accessHandle.flush();
  };
  binFile.close = function () {
    this.flush();
  };
  const opfsByteSource: WritableSyncByteSource = {
    close: () => binFile.close(),
    get fileName() {
      return binFile.fileName;
    },
    get filePath() {
      return binFile.filePath;
    },
    get fileSize() {
      return binFile.fileSize;
    },
    get fileType() {
      return binFile.fileType;
    },
    flush: () => binFile.flush(),
    readBytesAt: (offset: number, len: number) => binFile.readBytesAt(offset, len),
    readIntoAt: (buffer: ArrayBuffer | ArrayBufferView, bufferOffset?: number, len?: number, fileOffset?: number) =>
      binFile.readIntoAt(buffer, bufferOffset, len, fileOffset),
    slice: (offset?: number, len?: number, _doNotClone?: boolean) =>
      PatchFile.createReadView(binFile as object as Parameters<typeof PatchFile.createReadView>[0], offset, len)
        ._byteSource || opfsByteSource,
    truncate: (size: number) => binFile.truncate(size),
    writeBytesAt: (offset: number, bytes: ArrayBuffer | ArrayBufferView | ArrayLike<number>) =>
      binFile.writeBytesAt(offset, bytes),
  } satisfies WritableSyncByteSource;
  binFile._byteSource = opfsByteSource;
  return binFile;
};

const createOpfsInputPatchFile = (
  backend: OpfsBackend,
  fileName: string,
  fileType: string,
  filePath?: string,
): CoreRomPatchFileLike =>
  createOpfsPatchFile(
    backend,
    filePath || getBaseName(backend.storageName),
    fileName,
    fileType,
  ) as RuntimeValue as CoreRomPatchFileLike;

const ensureDirectory = (FS: EmscriptenFileSystem, directory: string) => {
  if (directory && directory !== "/") FS.mkdirTree(directory);
};

const removeFsPath = (FS: EmscriptenFileSystem, filePath: string) => {
  try {
    FS.unlink(filePath);
  } catch (_err) {
    /* ignore cleanup errors */
  }
};

const makeStats = (node: EmscriptenFsNode, size: number) => {
  const timestamp = new Date(node.timestamp || Date.now());
  const blocks = Math.ceil((size || 0) / 4096);
  return {
    atime: timestamp,
    blksize: 4096,
    blocks,
    ctime: timestamp,
    dev: 1,
    gid: 0,
    ino: node.id || 0,
    mode: node.mode || 0,
    mtime: timestamp,
    nlink: 1,
    rdev: 0,
    size: size || 0,
    uid: 0,
  };
};

const getSeekPosition = (
  stream: EmscriptenFsStream,
  offset: number,
  whence: number,
  size: number,
  FS: EmscriptenFileSystem,
) =>
  resolveSeekPosition({
    createRangeError: () => new FS.ErrnoError(28),
    currentPosition: stream.position,
    offset,
    size,
    whence,
  });

const createOpfsPreparedFile = async <TFile>({
  createFile,
  fileName,
  filePath,
  fileType,
  manager,
  moduleObject,
}: OpfsPreparedFileOptions<TFile>): Promise<TFile | null> => {
  if (moduleObject?.FS && !manager.ensureMounted(moduleObject)) return null;
  const backend = await manager.prepareFile(filePath);
  if (!backend) return null;
  if (moduleObject?.FS && !manager.ensureNode(filePath)) return null;
  return createFile(backend, filePath, fileName, fileType);
};

const writeBlobToOpfsBackend = async (backend: OpfsBackend, file: Blob) => {
  backend.accessHandle.truncate(0);
  const chunkSize = 8 * 1024 * 1024;
  let position = 0;
  while (position < file.size) {
    const nextPosition = Math.min(position + chunkSize, file.size);
    const chunkBytes = new Uint8Array(await file.slice(position, nextPosition).arrayBuffer());
    const bytesWritten = backend.accessHandle.write(chunkBytes, { at: position });
    backend.size = Math.max(backend.size, position + bytesWritten);
    position = nextPosition;
  }
  backend.timestamp = Date.now();
  backend.accessHandle.flush();
};

const createOpfsOutputManager = async ({
  moduleObject,
  mountPoint,
  navigatorObject,
  preferPortableMount,
}: OpfsManagerOptions): Promise<WorkerOpfsManager | null> => {
  if (!(navigatorObject?.storage && typeof navigatorObject.storage.getDirectory === "function")) return null;

  if (!preferPortableMount) {
    const browserMountedManager = await createBrowserOpfsStorageManager({
      moduleObject,
      mountPoint,
      navigatorObject,
    }).catch(() => null);
    if (browserMountedManager) return browserMountedManager;
  }

  await navigatorObject.storage.getDirectory();
  const prepared: Record<string, OpfsBackend> = {};
  const pendingDeletes: string[] = [];
  const writeObservers = new Set<(filePath: string, rangeStart: number, rangeEnd: number) => void>();
  const mountedFileSystems: Array<{ FS: EmscriptenFileSystem; mountedRootNode: EmscriptenFsNode | null }> = [];
  let FS: EmscriptenFileSystem | null = null;
  let mountedRootNode: EmscriptenFsNode | null = null;

  const requireFs = () => {
    if (!FS) throw new Error("Worker filesystem is not mounted");
    return FS;
  };

  const getFullPath = (parent: EmscriptenFsNode | null, name: string) => {
    if (!FS) return `${mountPoint.replace(TRAILING_POSIX_SLASHES_REGEX, "")}/${name}`;
    const parentPath = !parent || parent === mountedRootNode ? mountPoint : FS.getPath(parent);
    return `${parentPath.replace(TRAILING_POSIX_SLASHES_REGEX, "")}/${name}`;
  };

  const closeBackend = (backend?: OpfsBackend | null) => {
    if (!backend || backend.closed) return;
    try {
      backend.accessHandle.flush();
    } catch (_err) {
      /* ignore cleanup errors */
    }
    try {
      backend.accessHandle.close();
    } catch (_err) {
      /* ignore cleanup errors */
    }
    backend.closed = true;
  };

  const releaseBackend = (backend?: OpfsBackend | null) => {
    if (!backend) return;
    closeBackend(backend);
  };

  const notifyWriteObservers = (filePath: string, rangeStart: number, rangeEnd: number) => {
    if (!(writeObservers.size && rangeEnd > rangeStart)) return;
    for (const observer of writeObservers) {
      try {
        observer(filePath, rangeStart, rangeEnd);
      } catch (_err) {
        /* ignore progress observer errors */
      }
    }
  };

  const cleanupBackend = (backend?: OpfsBackend | null) => {
    if (!backend) return;
    releaseBackend(backend);
    if (!backend.deleteQueued) {
      backend.deleteQueued = true;
      pendingDeletes.push(backend.storageName);
    }
  };

  const resetBackend = (backend?: OpfsBackend | null) => {
    if (!backend || backend.closed) return;
    // Some tools unlink then recreate output files; keep the OPFS handle alive until manager cleanup.
    try {
      backend.accessHandle.truncate(0);
      backend.accessHandle.flush();
      backend.size = 0;
      backend.timestamp = Date.now();
    } catch (_err) {
      /* ignore cleanup errors */
    }
  };

  const createNode = (parent: EmscriptenFsNode | null, name: string, mode: number, backend?: OpfsBackend | null) => {
    const fs = requireFs();
    const node = fs.createNode(parent, name, mode, 0);
    node.timestamp = Date.now();
    if ((mode & 0x4000) === 0x4000) {
      node.contents = {};
      node.node_ops = directoryNodeOps;
      node.stream_ops = directoryStreamOps;
    } else {
      node.backend = backend || undefined;
      node.node_ops = fileNodeOps;
      node.stream_ops = fileStreamOps;
    }
    if (parent) parent.contents[name] = node;
    return node;
  };

  const directoryNodeOps: EmscriptenNodeOps = {
    getattr: (node: EmscriptenFsNode) => makeStats(node, 4096),
    lookup: (parent: EmscriptenFsNode, name: string) => {
      if (parent.contents[name]) return parent.contents[name];
      throw new (requireFs().ErrnoError)(44);
    },
    mknod: (parent: EmscriptenFsNode, name: string, mode: number) => {
      const fullPath = getFullPath(parent, name);
      if ((mode & 0x4000) === 0x4000) return createNode(parent, name, mode);
      const backend = prepared[fullPath];
      if (!backend) throw new (requireFs().ErrnoError)(2);
      return createNode(parent, name, mode, backend);
    },
    readdir: (node: EmscriptenFsNode) => [".", ".."].concat(Object.keys(node.contents)),
    setattr: (node: EmscriptenFsNode, attr: { mode?: number; timestamp?: number }) => {
      if (attr.mode !== undefined) node.mode = attr.mode;
      if (attr.timestamp !== undefined) node.timestamp = attr.timestamp;
    },
    unlink: (parent: EmscriptenFsNode, name: string) => {
      const node = parent.contents[name];
      if (!node) throw new (requireFs().ErrnoError)(44);
      if (node.backend?.truncateOnUnlink) resetBackend(node.backend);
      delete parent.contents[name];
      parent.timestamp = Date.now();
    },
  };

  const directoryStreamOps: EmscriptenStreamOps = {
    llseek: (stream: EmscriptenFsStream, offset: number, whence: number) => {
      return getSeekPosition(stream, offset, whence, 0, requireFs());
    },
  };

  const fileNodeOps: EmscriptenNodeOps = {
    getattr: (node: EmscriptenFsNode) => makeStats(node, node.backend ? node.backend.size : 0),
    setattr: (node: EmscriptenFsNode, attr: { mode?: number; timestamp?: number; size?: number }) => {
      if (attr.mode !== undefined) node.mode = attr.mode;
      if (attr.timestamp !== undefined) node.timestamp = attr.timestamp;
      if (attr.size !== undefined && node.backend) {
        node.backend.accessHandle.truncate(attr.size);
        node.backend.size = attr.size;
        node.backend.timestamp = Date.now();
      }
    },
  };

  const fileStreamOps: EmscriptenStreamOps = {
    close: (stream: EmscriptenFsStream) => {
      if (stream.node.backend && !stream.node.backend.closed) stream.node.backend.accessHandle.flush();
    },
    llseek: (stream: EmscriptenFsStream, offset: number, whence: number) => {
      return getSeekPosition(stream, offset, whence, stream.node.backend ? stream.node.backend.size : 0, requireFs());
    },
    read: (stream: EmscriptenFsStream, buffer: Uint8Array, offset: number, length: number, position: number) => {
      const backend = stream.node.backend;
      if (!backend || position >= backend.size) return 0;
      backend.timestamp = Date.now();
      return backend.accessHandle.read(buffer.subarray(offset, offset + length), { at: position });
    },
    write: (
      stream: EmscriptenFsStream,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | undefined,
    ) => {
      const backend = stream.node.backend;
      if (!backend) throw new (requireFs().ErrnoError)(29);
      const writePosition = typeof position === "number" ? position : stream.position;
      const bytesWritten = backend.accessHandle.write(buffer.subarray(offset, offset + length), { at: writePosition });
      backend.size = Math.max(backend.size, writePosition + bytesWritten);
      backend.timestamp = Date.now();
      if (bytesWritten > 0)
        notifyWriteObservers(requireFs().getPath(stream.node), writePosition, writePosition + bytesWritten);
      return bytesWritten;
    },
  };

  const ensureMounted = (nextModuleObject?: EmscriptenWorkerModule | { FS?: EmscriptenFileSystem } | null) => {
    const nextFs = nextModuleObject?.FS as EmscriptenFileSystem | undefined;
    if (!nextFs || typeof nextFs.mount !== "function") return false;
    for (const mountedFileSystem of mountedFileSystems) {
      if (mountedFileSystem && mountedFileSystem.FS === nextFs) {
        FS = mountedFileSystem.FS;
        mountedRootNode = mountedFileSystem.mountedRootNode;
        return true;
      }
    }
    FS = nextFs;
    mountedRootNode = null;
    const fileSystem = {
      mount: () => {
        mountedRootNode = createNode(null, "/", 0x4000 | 0o777);
        return mountedRootNode;
      },
    };
    try {
      FS.mkdirTree(mountPoint);
    } catch (_err) {
      /* ignore cleanup errors */
    }
    try {
      FS.mount(fileSystem, {}, mountPoint);
    } catch (_err) {
      return false;
    }
    mountedFileSystems.push({ FS, mountedRootNode });
    return true;
  };

  const prepareWriteTarget = async (
    managerInstance: WorkerOpfsManager,
    filePath: string,
    options?: { ensureNode?: boolean },
  ) => {
    const backend = await managerInstance.prepareFile(filePath);
    if (!backend) return null;
    if (!FS && moduleObject) managerInstance.ensureMounted(moduleObject);
    if (!FS) return null;
    ensureDirectory(FS, getParentPath(filePath));
    if (options?.ensureNode && !managerInstance.ensureNode(filePath)) return null;
    return backend;
  };

  const manager: WorkerOpfsManager = {
    cleanup: async (filePaths?: string[]) => {
      const paths = filePaths?.length ? filePaths.slice() : Object.keys(prepared);
      for (const filePath of paths) {
        cleanupBackend(prepared[filePath]);
        delete prepared[filePath];
      }
      while (pendingDeletes.length) {
        const storageName = pendingDeletes.pop();
        try {
          if (storageName) await removeManagedOpfsPath(storageName, navigatorObject);
        } catch (_err) {
          /* ignore cleanup errors */
        }
      }
    },
    ensureMounted,
    ensureNode: (filePath: string) => {
      if (!FS) return false;
      ensureDirectory(FS, getParentPath(filePath));
      try {
        const existingNode = FS.lookupPath(filePath).node;
        if (prepared[filePath]) existingNode.backend = prepared[filePath];
        return true;
      } catch (_err) {
        /* ignore cleanup errors */
      }
      FS.mknod(filePath, 0x8000 | 0o666, 0);
      return true;
    },
    getFile: async (filePath: string) => {
      const backend = prepared[filePath];
      if (!backend) return null;
      closeBackend(backend);
      return backend.fileHandle.getFile();
    },
    getFileHandle: (filePath: string) => prepared[filePath]?.fileHandle || null,
    getPreparedPaths: () => Object.keys(prepared),
    linkFile: (sourcePath: string, targetPath: string) => {
      if (!FS) return false;
      const sourceBackend = prepared[sourcePath];
      if (!sourceBackend) return false;
      ensureDirectory(FS, getParentPath(targetPath));
      if (sourcePath === targetPath) return manager.ensureNode(targetPath);
      try {
        removeFsPath(FS, targetPath);
      } catch (_err) {
        /* ignore missing aliases */
      }
      const parentPath = getParentPath(targetPath);
      const parentNode = FS.lookupPath(parentPath).node;
      const aliasNode = createNode(parentNode, getBaseName(targetPath), 0x8000 | 0o666, sourceBackend);
      aliasNode.backend = sourceBackend;
      prepared[targetPath] = sourceBackend;
      return true;
    },
    observeWrites: (observer) => {
      writeObservers.add(observer);
      return () => {
        writeObservers.delete(observer);
      };
    },
    openFile: async (filePath: string) => {
      if (prepared[filePath]) return prepared[filePath];
      const storageName = getManagedOpfsStorageName(filePath);
      let fileHandle: FileSystemFileHandle;
      try {
        const managedFileHandle = await getManagedOpfsFileHandle(storageName, {
          create: false,
          navigatorObject,
        });
        if (!managedFileHandle) return null;
        fileHandle = managedFileHandle;
      } catch (error) {
        if (isNotFoundError(error)) return null;
        throw error;
      }
      if (typeof fileHandle.createSyncAccessHandle !== "function") return null;
      let accessHandle: FileSystemSyncAccessHandle;
      try {
        accessHandle = await fileHandle.createSyncAccessHandle();
      } catch (error) {
        throw new Error(
          `OPFS openFile createSyncAccessHandle failed for ${filePath}: ${formatOpfsErrorMessage(error)}`,
        );
      }
      const size =
        typeof accessHandle.getSize === "function" ? accessHandle.getSize() : (await fileHandle.getFile()).size;
      const backend: OpfsBackend = {
        accessHandle,
        closed: false,
        deleteQueued: false,
        fileHandle,
        size,
        storageName,
        timestamp: Date.now(),
        truncateOnUnlink: false,
      };
      prepared[filePath] = backend;
      return backend;
    },
    outputDirectory: mountPoint,
    prepareFile: async (filePath: string) => {
      if (prepared[filePath]) {
        cleanupBackend(prepared[filePath]);
        delete prepared[filePath];
      }
      const storageName = getManagedOpfsStorageName(filePath);
      const fileHandle = await getManagedOpfsFileHandle(storageName, { create: true, navigatorObject });
      if (!fileHandle) return null;
      if (typeof fileHandle.createSyncAccessHandle !== "function") return null;
      let accessHandle: FileSystemSyncAccessHandle;
      try {
        accessHandle = await fileHandle.createSyncAccessHandle();
      } catch (error) {
        throw new Error(
          `OPFS prepareFile createSyncAccessHandle failed for ${filePath}: ${formatOpfsErrorMessage(error)}`,
        );
      }
      accessHandle.truncate(0);
      accessHandle.flush();
      const backend: OpfsBackend = {
        accessHandle,
        closed: false,
        deleteQueued: false,
        fileHandle,
        size: 0,
        storageName,
        timestamp: Date.now(),
        truncateOnUnlink: true,
      };
      prepared[filePath] = backend;
      return backend;
    },
    releaseFile: (filePath: string) => {
      if (FS) {
        try {
          removeFsPath(FS, filePath);
        } catch (_err) {
          /* ignore missing aliases */
        }
      }
      releaseBackend(prepared[filePath]);
      delete prepared[filePath];
    },
    usesPortableMount: true,
    writeBlob: async function (this: WorkerOpfsManager, filePath: string, blob: Blob) {
      const backend = await prepareWriteTarget(this, filePath, { ensureNode: true });
      if (!backend) return false;
      const chunkSize = 8 * 1024 * 1024;
      let position = 0;
      while (position < blob.size) {
        const nextPosition = Math.min(position + chunkSize, blob.size);
        const chunkBytes = new Uint8Array(await blob.slice(position, nextPosition).arrayBuffer());
        const bytesWritten = backend.accessHandle.write(chunkBytes, { at: position });
        backend.size = Math.max(backend.size, position + bytesWritten);
        backend.timestamp = Date.now();
        notifyWriteObservers(filePath, position, position + bytesWritten);
        position = nextPosition;
      }
      backend.accessHandle.truncate(blob.size);
      backend.size = blob.size;
      backend.accessHandle.flush();
      this.ensureNode(filePath);
      return true;
    },
    writeFile: async function (this: WorkerOpfsManager, filePath: string, bytes: Uint8Array) {
      const backend = await prepareWriteTarget(this, filePath);
      if (!(backend && FS)) return false;
      FS.writeFile(filePath, bytes);
      notifyWriteObservers(filePath, 0, bytes.byteLength);
      return true;
    },
  };

  if (moduleObject && !ensureMounted(moduleObject)) return null;
  return manager;
};

export {
  createOpfsInputPatchFile,
  createOpfsOutputManager,
  createOpfsPatchFile,
  createOpfsPreparedFile,
  removeFsPath,
  writeBlobToOpfsBackend,
};
