import type { BlobLike } from "../../../protocol/archive-source-types.ts";

export type { BlobLike };

export type ArchiveSourceScalar = string | number | boolean | null | undefined;
export type ArchiveEntry = {
  archiveFileName?: string | null;
  encrypted?: boolean;
  fileName?: string;
  filename: string;
  fileType?: string;
  lastModified?: number;
  method?: string;
  mtime?: number;
  name?: string;
  size?: number;
  [key: string]: RuntimeValue | undefined;
};
export type ArchiveEntryInput = {
  arrayBuffer?: ArrayBufferLike | Uint8Array;
  data?: ArrayBufferLike | ArrayBufferView | BlobLike | Uint8Array;
  directory?: boolean;
  file?: BlobLike & { arrayBuffer?: () => Promise<ArrayBuffer> };
  fileName?: string;
  filePath?: string;
  filename?: string;
  lastModified?: number;
  mode?: number;
  mtime?: number;
  name?: string;
  text?: string | number;
  u8array?: Uint8Array;
};
export type ProgressEvent = {
  label?: string;
  percent?: number | null;
  resolvedFileName?: string;
  [key: string]: RuntimeValue | undefined;
};
export type ProgressCallback = (progress: ProgressEvent) => void;
export type ArchiveSourceRecord = {
  [key: string]: RuntimeValue;
  _file?: BlobLike & { name?: string };
  _u8array?: Uint8Array;
  fileName?: string;
  fileSize?: number;
  materialize?: (start: number, end: number) => { _u8array: Uint8Array };
  name?: string;
  readIntoAt?: (buffer: Uint8Array, bufferOffset: number, len: number, fileOffset: number) => void;
};
export type ArchiveSourceValue =
  | ArchiveSourceScalar
  | ArchiveSourceRecord
  | ArchiveSourceValue[]
  | ArrayBuffer
  | ArrayBufferView
  | BlobLike;
export type ArchiveSource = ArchiveSourceValue | FileSystemFileHandle;
export type ArchiveEntryList = ArchiveEntry[];
export type ArchiveReadOptions = {
  blockSize?: number;
  chunkSize?: number;
  onProgress?: ProgressCallback;
  passphrase?: string | null;
};
export type ArchiveCreateEntry = Omit<ArchiveEntryInput, "data"> & {
  data?: ArrayBufferLike | ArrayBufferView | BlobLike | Uint8Array;
  directory?: boolean;
  mode?: number;
};
export type ArchiveCreateOptions = {
  filter?: string | null;
  format?: string | null;
  onProgress?: ProgressCallback;
  options?: string | null;
  outputFileName?: string | null;
  outputPath?: string | null;
};
export type ArchiveCreatedFile = {
  cleanupPaths?: string[];
  file?: File;
  fileHandle?: FileSystemFileHandle;
  fileName: string;
  filePath: string;
  size: number;
};
export type ExtractedArchiveEntryFile = {
  cleanup?: () => Promise<void> | void;
  cleanupPaths?: string[];
  data?: Uint8Array;
  file?: File;
  fileHandle?: FileSystemFileHandle;
  fileName: string;
  filePath?: string;
  size: number;
};
export type SevenZipFactoryOptions = {
  [key: string]: RuntimeValue;
  preRun?: RuntimeValue;
  workerThreads?: number;
};
export type SevenZipOutputState = {
  onStderrProgress?: ((percent: number) => void) | null;
  resetStderrProgress?: (() => void) | null;
  stderr: string[];
  stdout: string[];
};
export type SevenZipFactoryLike = (
  moduleArg?: SevenZipFactoryOptions,
) => Promise<SevenZipModuleLike> | SevenZipModuleLike;
export type SevenZipModuleLike = {
  FS: EmscriptenFsLike;
  NODEFS?: { mount: (mount: RuntimeValue) => RuntimeValue };
  OPFS?: { createBackend?: (...args: RuntimeValue[]) => RuntimeValue };
  callMain: (args: string[]) => number;
  __romWeaverSevenZipZstdSelectionReason?: string;
  __romWeaverSevenZipZstdThreadCount?: number;
  __romWeaverSevenZipZstdThreaded?: boolean;
  __romWeaverWasmAbort?: RuntimeValue | null;
  __romWeaverSevenZipZstdOutput?: SevenZipOutputState;
  selectionReason?: string;
  threadCount?: number;
  threaded?: boolean;
  wasmToolName?: string;
};
export type EmscriptenFsLike = {
  chdir: (path: string) => void;
  cwd: () => string;
  getPath?: (node: RuntimeValue) => string;
  init?: (
    input?: ((...args: RuntimeValue[]) => RuntimeValue) | null,
    output?: ((...args: RuntimeValue[]) => RuntimeValue) | null,
    error?: ((value: number) => void) | null,
  ) => void;
  isDir?: (mode: number) => boolean;
  mkdir: (path: string) => void;
  mkdirTree?: (path: string) => void;
  mount?: (
    fs: { mount: (mount: RuntimeValue) => RuntimeValue },
    options: Record<string, RuntimeValue>,
    mountPoint: string,
  ) => void;
  read?: (
    stream: { node?: RuntimeValue; path?: string; position?: number },
    buffer: Uint8Array,
    offset: number,
    length: number,
    position?: number,
  ) => number;
  readFile: (path: string, options?: { encoding?: "binary" | "utf8" }) => Uint8Array | string;
  readdir: (path: string) => string[];
  rmdir: (path: string) => void;
  stat: (path: string) => { mode: number; size?: number };
  unlink: (path: string) => void;
  unmount?: (path: string) => void;
  utime?: (path: string, atime: number, mtime: number) => void;
  write?: (
    stream: { node?: RuntimeValue; path?: string; position?: number },
    buffer: Uint8Array,
    offset: number,
    length: number,
    position?: number,
    canOwn?: boolean,
  ) => number;
  writeFile: (path: string, data: Uint8Array | string) => void;
};
export type SevenZipRunResult = {
  stderr: string;
  stdout: string;
  status: number;
};
export type SevenZipCliProgressResult = {
  percents: number[];
  stream: "stdout" | "stderr" | null;
  stderrPercents: number[];
  stdoutPercents: number[];
  useful: boolean;
};
export type ParsedSltArchive = {
  archiveType: string;
  entries: ArchiveEntry[];
};
export type MaterializedCreateEntry = {
  data: Uint8Array;
  directory: boolean;
  filePath?: string;
  fileSize?: number;
  filename: string;
  mtime: number;
};
export type RootWithSevenZip = typeof globalThis & {
  File?: typeof File;
};
