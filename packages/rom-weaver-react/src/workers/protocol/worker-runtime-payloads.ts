import type { WorkerKind } from "../../types/worker-messages.ts";
import type { PatchFileEntry as WorkflowPatchFileEntry } from "../../types/workflow-source.ts";
import type { BrowserWorkerFile, CompressionWorkerKind, CompressionWorkerOperation } from "./worker-protocol.ts";

type WorkerRequestId = string;
type WorkerRuntimeValue = string | number | boolean | object | null | undefined;
type WorkerRuntimeRecord = {
  [key: string]: WorkerRuntimeValue;
};

type WorkerProgressEvent = {
  label?: string;
  percent?: number | null;
  resolvedFileName?: string;
  sourceDisplayFileName?: string;
  [key: string]: WorkerRuntimeValue;
};

type WorkerProgressCallback = (progress: WorkerProgressEvent) => void;

type PatchFileEntry = WorkflowPatchFileEntry<BrowserWorkerFile>;

type WorkerRequestData = WorkerRuntimeRecord & {
  action: string;
  archiveEntryName?: string;
  archiveFileName?: string;
  chdFile?: BrowserWorkerFile;
  chdFileName?: string;
  chdFilePath?: string;
  chdCreateMode?: string;
  chdInputFileName?: string;
  chdMode?: string;
  chdOutputFileName?: string;
  compressionCodecs?: string | string[] | Record<string, string | number> | null;
  fileName?: string;
  filePaths?: string[];
  imageFile?: BrowserWorkerFile;
  imageFilePath?: string;
  imageFiles?: Array<{ file?: BrowserWorkerFile; fileName?: string; filePath?: string }>;
  kind?: CompressionWorkerKind;
  logLevel?: string;
  format?: string;
  metadata?: Record<string, WorkerRuntimeValue>;
  mode?: string;
  modifiedFile?: BrowserWorkerFile;
  modifiedFileName?: string;
  modifiedFilePath?: string;
  options?: Record<string, WorkerRuntimeValue>;
  originalFile?: BrowserWorkerFile;
  originalFileName?: string;
  originalFilePath?: string;
  operation?: CompressionWorkerOperation;
  outputName?: string;
  patchFile?: BrowserWorkerFile;
  patchFileName?: string;
  patchFilePath?: string;
  patchFiles?: PatchFileEntry[];
  requestId: WorkerRequestId;
  romFile?: BrowserWorkerFile;
  romFilePath?: string;
  romFileName?: string;
  rvzBlockSize?: string | number | null;
  rvzCompression?: string;
  rvzCompressionLevel?: string | number | null;
  rvzFile?: BrowserWorkerFile;
  rvzFileName?: string;
  rvzFilePath?: string;
  rvzMode?: string;
  rvzScrub?: boolean | string | number | null;
  rvzSourceFileName?: string;
  threads?: string | number | null;
  workerThreads?: string | number | null;
  workerKind: WorkerKind;
  z3dsCompressionLevel?: string | number | null;
  z3dsFile?: BrowserWorkerFile;
  z3dsFileName?: string;
  z3dsFilePath?: string;
  z3dsMetadata?: Record<string, string | number | boolean | Uint8Array | null | undefined> | null;
  z3dsSourceFileName?: string;
  z3dsUnderlyingMagic?: string;
};

type WorkerResultFile = WorkerRuntimeRecord & {
  _archiveEntryName?: string;
  _archiveEntryType?: string;
  _archiveFileName?: string;
  _chdCuePath?: string;
  _chdCueText?: string;
  _chdMode?: string;
  _file?: File | Blob;
  _chdOutputPath?: string;
  _chdSourceFileName?: string;
  _fileHandle?: FileSystemFileHandle | null;
  _opfsPath?: string;
  _rvzMode?: string;
  _rvzOutputPath?: string;
  _rvzSourceFileName?: string;
  _u8array?: Uint8Array;
  _z3dsMetadata?: Record<string, string | number | boolean | Uint8Array | null | undefined> | null;
  _z3dsSourceFileName?: string;
  _z3dsUnderlyingMagic?: string | null;
  fileName: string;
  fileSize?: number;
};

export type {
  BrowserWorkerFile,
  PatchFileEntry,
  WorkerProgressCallback,
  WorkerProgressEvent,
  WorkerRequestData,
  WorkerResultFile,
  WorkerRuntimeRecord,
  WorkerRuntimeValue,
};
