import type { JsonRecord, JsonValue } from "../../../types/runtime.ts";
import type { SyncByteSource } from "./byte-sources.ts";

export type { SyncByteSource };

export type PatchFileRuntime = "browser" | "webworker" | null;

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
  push?: () => void;
  pop?: () => void;
  _getReadScratch?: (size: number) => Uint8Array;
  readIntoAt: (
    buffer: ArrayBuffer | ArrayBufferView,
    bufferOffset?: number,
    len?: number,
    fileOffset?: number,
  ) => number;
  readBytesAt?: (offset: number, len: number) => Uint8Array;
  readU8At?: (offset: number) => number;
  writeU8At?: (offset: number, value: number) => void;
  writeBytesAt?: (offset: number, bytes: Uint8Array | ArrayBuffer | ArrayBufferView | number[]) => void;
  readU8: () => number;
  readU16: () => number;
  readU24: () => number;
  readU32: () => number;
  readU64?: () => number;
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
  getExtension?: () => string;
  getName?: () => string;
  setExtension?: (newExtension: string) => string;
  setName?: (newName: string) => string;
};

type CoreRomPatchFileLike = PatchFileLike & {
  _archiveEntryName?: string;
  _archiveEntryType?: string;
  _archiveFileName?: string;
  _browserFileBacked?: boolean;
  _chdCuePath?: string;
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

type PatchValidationInfo = {
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
