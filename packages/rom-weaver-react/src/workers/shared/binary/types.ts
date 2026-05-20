import type { JsonRecord, JsonValue } from "../../../types/runtime.ts";
import type { WorkerRuntimeRecord } from "../../protocol/worker-runtime-payloads.ts";
import type { ByteSourceMetadata, SyncByteSource, WritableSyncByteSource } from "./byte-sources.ts";

export type { ByteSourceMetadata, SyncByteSource, WritableSyncByteSource };

export type ProgressEventLike = {
  label: string;
  percent: number | null;
  message?: string;
  loaded?: number;
  total?: number;
  [action: string]: JsonValue | undefined;
};

export type ProgressCallback = (progress: ProgressEventLike) => void;
export type HashProgressCallback = (loadedBytes: number, totalBytes: number) => void;
export type PatchFileRuntime = "browser" | "webworker" | null;
export type ChecksumResult = {
  adler32?: number;
  crc16?: number;
  crc32: number;
  md5: string;
  sha1: string;
};
export type PatchFileHashResult = {
  crc32?: number;
  md5?: string;
  sha1?: string;
  [action: string]: JsonValue | undefined;
};

export type PatchFileBytes = Uint8Array | number[];
export type PatchFileChunkIterationResult = {
  bytes: Uint8Array;
  offset: number;
};
export type PatchFileChunkOptions = {
  buffer?: Uint8Array | null;
  chunkSize?: number;
};

export type PatchFileInit = {
  fileName: string;
  fileType: string;
  fileSize: number;
  filePath?: string;
  littleEndian?: boolean;
  offset?: number;
  _byteSource?: SyncByteSource;
  _file?: Blob | File;
  _u8array?: Uint8Array;
};

export type PatchFileLike = {
  fileName: string;
  fileType: string;
  fileSize: number;
  littleEndian: boolean;
  offset: number;
  _fileReader?: PatchFileReader;
  _u8array?: Uint8Array;
  _byteSource?: SyncByteSource;
  _file?: Blob;
  filePath?: string;
  _lastRead?: number | string | number[] | null;
  _offsetsStack?: number[];
  _sharedReadScratch?: Uint8Array;
  _readViewSource?: PatchFileLike;
  _readViewOffset?: number;
  push?: () => void;
  pop?: () => void;
  _getReadScratch?: (size: number) => Uint8Array;
  readIntoAt: (
    buffer: ArrayBuffer | ArrayBufferView,
    bufferOffset?: number,
    len?: number,
    fileOffset?: number,
  ) => number;
  forEachChunk?: (
    start: number | undefined,
    len: number | undefined,
    callback: (bytes: Uint8Array, fileOffset: number, loaded: number, total: number) => boolean | undefined,
    options?: PatchFileChunkOptions,
  ) => number;
  iterateChunks?: (
    start?: number,
    len?: number,
    options?: PatchFileChunkOptions,
  ) => IterableIterator<PatchFileChunkIterationResult>;
  readBytesAt?: (offset: number, len: number) => Uint8Array;
  readU8At?: (offset: number) => number;
  writeU8At?: (offset: number, value: number) => void;
  writeBytesAt?: (offset: number, bytes: Uint8Array | ArrayBuffer | ArrayBufferView | number[]) => void;
  readU8: () => number;
  readU16: () => number;
  readU24: () => number;
  readU32: () => number;
  readU64?: () => number;
  readBytes: (len: number) => Uint8Array | number[];
  readString: (len: number) => string;
  writeU8?: (value: number) => void;
  writeU16?: (value: number) => void;
  writeU24?: (value: number) => void;
  writeU32?: (value: number) => void;
  writeBytes?: (bytes: ArrayLike<number>) => void;
  writeString?: (value: string, length?: number) => void;
  seek: (offset: number) => void;
  skip: (nBytes: number) => void;
  isEOF: () => boolean;
  slice: (offset?: number, len?: number, doNotClone?: boolean) => PatchFileLike;
  materialize: (offset?: number, len?: number) => PatchFileLike;
  prependBytes?: (bytes: Uint8Array | number[]) => PatchFileLike;
  removeLeadingBytes?: (nBytes: number) => number[];
  copyTo: (
    target: PatchFileLike | { writeBytesAt: (offset: number, bytes: Uint8Array) => void; _u8array?: Uint8Array },
    offsetSource?: number,
    len?: number,
    offsetTarget?: number,
  ) => void;
  save?: () => void;
  getExtension?: () => string;
  getName?: () => string;
  setExtension?: (newExtension: string) => string;
  setName?: (newName: string) => string;
  swapBytes?: (swapSize?: number, newFile?: boolean) => PatchFileLike;
};

export type CoreRomPatchFileLike = PatchFileLike & {
  _archiveEntryName?: string;
  _archiveEntryType?: string;
  _archiveFileName?: string;
  _browserFileBacked?: boolean;
  _chdCueFileName?: string;
  _chdCueText?: string;
  _chdMode?: string;
  _chdOutputPath?: string;
  _chdSourceFileName?: string;
  _rvzMode?: string;
  _rvzSourceFileName?: string;
  _z3dsMetadata?: Record<string, string | number | boolean | Uint8Array | null | undefined> | null;
  _z3dsSourceFileName?: string;
  _z3dsUnderlyingMagic?: string;
  _file?: Blob;
  fakeHeader?: boolean;
  unpatched?: boolean;
};

export type PatchFileInstance = PatchFileLike & CoreRomPatchFileLike;
export type PatchFileReader = FileReader & {
  binFile: PatchFileInstance;
};
export type PatchFileCopyTarget =
  | PatchFileLike
  | { writeBytesAt: (offset: number, bytes: Uint8Array) => void; _u8array?: Uint8Array };

export type WorkerPatchFile = WorkerRuntimeRecord & {
  _archiveEntryName?: string;
  _archiveEntryType?: string;
  _archiveFileName?: string;
  _chdCueFileName?: string;
  _chdCueText?: string;
  _chdMode?: string;
  _chdOutputPath?: string;
  _chdSourceFileName?: string;
  _file?: File | Blob;
  _fileHandle?: FileSystemFileHandle | null;
  _opfsPath?: string;
  _rvzMode?: string;
  _rvzOutputPath?: string;
  _rvzSourceFileName?: string;
  _u8array?: Uint8Array;
  _byteSource?: SyncByteSource;
  _z3dsMetadata?: Record<string, string | number | boolean | Uint8Array | null | undefined> | null;
  _z3dsSourceFileName?: string;
  _z3dsUnderlyingMagic?: string | null;
  fileName: string;
  filePath?: string;
  fileSize: number;
  fileType?: string;
  flush?: () => void;
  materialize?: () => WorkerPatchFile;
  readString: (len: number) => string;
  reset?: (size: number, fileName?: string, fileType?: string) => void;
  seek: (offset: number) => void;
};

export type PatchFileNameSize = Pick<PatchFileLike, "fileName" | "fileSize">;

export type ReadablePatchPatchFileLike<TBytes extends PatchFileBytes = PatchFileBytes> = {
  fileName: string;
  fileSize: number;
  isEOF(): boolean;
  offset: number;
  readBytes(length: number): TBytes;
  readString(length: number): string;
  readU8(): number;
  seek(offset: number): void;
  skip(offset: number): void;
};

export type WritablePatchPatchFileLike<TBytes extends PatchFileBytes = PatchFileBytes> =
  ReadablePatchPatchFileLike<TBytes> & {
    copyTo(target: WritablePatchPatchFileLike<TBytes>, offset?: number, length?: number, fileOffset?: number): void;
    slice(offset?: number, length?: number): WritablePatchPatchFileLike<TBytes>;
    writeBytes(data: TBytes): void;
    writeString(value: string, length?: number): void;
    writeU8(value: number): void;
  };

export type PatchReadablePatchFile<
  TBytes extends PatchFileBytes = PatchFileBytes,
  TExtra extends object = object,
> = ReadablePatchPatchFileLike<TBytes> & TExtra;

export type PatchWritablePatchFile<
  TBytes extends PatchFileBytes = PatchFileBytes,
  TExtra extends object = object,
> = WritablePatchPatchFileLike<TBytes> & TExtra;

export type PatchWritableRandomAccessPatchFile<
  TBytes extends PatchFileBytes = PatchFileBytes,
  TExtra extends object = object,
> = PatchWritablePatchFile<TBytes, TExtra> & RandomAccessPatchFileLike;

export type PatchWritableHashingPatchFile<
  TBytes extends PatchFileBytes = PatchFileBytes,
  _THashKey extends string | null = null,
  TExtra extends object = object,
> = PatchWritablePatchFile<TBytes, TExtra> & object;

export type PatchWritableHashingRandomAccessPatchFile<
  TBytes extends PatchFileBytes = PatchFileBytes,
  _THashKey extends string | null = null,
  TExtra extends object = object,
> = PatchWritableHashingPatchFile<TBytes, _THashKey, TExtra> & RandomAccessPatchFileLike;

export type PatchWritablePatchFileWithVlv<
  TFile extends object,
  TVlvKey extends keyof VlvPatchFileLike = keyof VlvPatchFileLike,
> = TFile & Required<Pick<VlvPatchFileLike, TVlvKey>>;

export type RandomAccessPatchFileLike = {
  _u8array?: Uint8Array;
  readIntoAt?: (
    buffer: ArrayBuffer | ArrayBufferView,
    bufferOffset?: number,
    len?: number,
    fileOffset?: number,
  ) => number;
  readBytesAt?: (offset: number, len: number) => Uint8Array | number[] | ArrayBuffer | ArrayBufferView;
  readU8At?: (offset: number) => number;
  writeBytesAt?: (offset: number, bytes: Uint8Array | number[] | ArrayBuffer | ArrayBufferView) => void;
  writeU8At?: (offset: number, value: number) => void;
};

export type VlvPatchFileLike = {
  readVLV?(): number;
  writeVLV?(data: number): void;
};

export type PatchFileSource =
  | number
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Uint8Array
  | Blob
  | File
  | FileList
  | HTMLInputElement
  | SyncByteSource
  | PatchFileLike;

export type PatchFileConstructor<TFile extends PatchFileLike = PatchFileLike> = new (
  source: PatchFileSource,
  onLoad?: (file: TFile) => void,
) => TFile;

export type TypedPatchFileConstructor<TFile, TSource = PatchFileSource> = new (
  source: TSource,
  onLoad?: (file: TFile) => void,
) => TFile;

export type PatchValidationInfo = {
  targetChecksumScope?: string;
  type: string;
  value?: number | string | null;
  targetValue?: number | string | null;
  targetValueScope?: string;
};

export type ParsedPatchLike = {
  _originalPatchFile?: PatchFileLike;
  fileName?: string;
  format?: string;
  targetSize?: number;
  sizeOutput?: number;
  patchedSize?: number;
  header?: {
    sizeOutput?: number;
    [action: string]: JsonValue | undefined;
  };
  validateSourceAsync?: (romFile: PatchFileLike, headerSize?: number) => Promise<boolean>;
  getValidationInfo?: () => PatchValidationInfo;
  apply: (romFile: PatchFileLike, validate: boolean, options?: JsonRecord) => PatchFileLike | Promise<PatchFileLike>;
};

export type ParsedPatchWithSourceLike = ParsedPatchLike & {
  file?: PatchFileLike;
  isXdeltaPatch?: boolean;
};

export type OutputFileFactory<TFile extends PatchFileLike = CoreRomPatchFileLike> = (size: number) => TFile;

export type RomWeaverApplyOptionsLike<TFile extends PatchFileLike = CoreRomPatchFileLike> = {
  addHeader?: boolean;
  fixChecksum?: boolean;
  onProgress?: ProgressCallback;
  opfsManager?: JsonValue;
  outputExtension?: string;
  outputFileFactory?: OutputFileFactory<TFile>;
  outputName?: string;
  appendOutputSuffix?: boolean;
  removeHeader?: boolean;
  requireInputChecksumMatch?: boolean;
};

export type RomWeaverCreatePatchMetadataLike = {
  Description?: string;
  [action: string]: JsonValue | undefined;
};

export type WorkerApplyRequest = {
  requestId: string;
  action: "apply";
  romFile: PatchFileLike;
  patchFiles: PatchFileLike[];
  patchFileEntries?: string[];
  options?: Record<string, JsonValue>;
};

export type WorkerProgressMessage = {
  requestId: string;
  action: "progress";
  progress: ProgressEventLike;
};

export type WorkerResultMessage = {
  requestId: string;
  action: "success" | "error";
  result?: JsonValue;
  error?: string;
};
