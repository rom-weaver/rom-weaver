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

type WorkerRequestBase<TAction extends string> = {
  action: TAction;
  logLevel?: string;
  requestId: WorkerRequestId;
  workerKind: WorkerKind;
};

type WorkerRequestOptions = Record<string, WorkerRuntimeValue>;
type WorkerRequestMetadata = Record<string, WorkerRuntimeValue>;
type WorkerRomSpecificMetadata = Record<string, string | number | boolean | Uint8Array | null | undefined>;
type WorkerCodecSelection = string | string[] | Record<string, string | number> | null;
type WorkerImageFileEntry = {
  file?: BrowserWorkerFile;
  fileName?: string;
  filePath?: string;
};

type WorkerPatchApplyRequestData = WorkerRequestBase<"apply"> & {
  options?: WorkerRequestOptions;
  patchFile?: BrowserWorkerFile;
  patchFileName?: string;
  patchFilePath?: string;
  patchFiles: PatchFileEntry[];
  romFile?: BrowserWorkerFile;
  romFileName?: string;
  romFilePath: string;
};

type WorkerPatchValidateRequestData = WorkerRequestBase<"validate-patch"> & {
  options?: WorkerRequestOptions;
  patchFiles: PatchFileEntry[];
  romFileName?: string;
  romFilePath: string;
};

type WorkerPatchParseRequestData = WorkerRequestBase<"parse-patch"> & {
  patchFile?: BrowserWorkerFile;
  patchFileName?: string;
  patchFilePath: string;
};

type WorkerPatchCreateCandidatesRequestData = WorkerRequestBase<"create-patch-candidates"> & {
  modifiedFile?: BrowserWorkerFile;
  modifiedFileName: string;
  modifiedFilePath: string;
  originalFile?: BrowserWorkerFile;
  originalFileName: string;
  originalFilePath: string;
  workerThreads?: string | number | null;
};

type WorkerPatchCreateRequestData = WorkerRequestBase<"create-patch"> & {
  format: string;
  metadata?: WorkerRequestMetadata;
  modifiedFile?: BrowserWorkerFile;
  modifiedFileName: string;
  modifiedFilePath: string;
  originalFile?: BrowserWorkerFile;
  originalFileName: string;
  originalFilePath: string;
  outputName: string;
  workerThreads?: string | number | null;
};

type WorkerChecksumRequestData = WorkerRequestBase<"checksum"> & {
  checksumAlgorithms: string[];
  checksumStartOffset?: number;
  fileName?: string;
  filePath: string;
  fileSize?: number;
};

type WorkerCompressionRequestBase<
  TAction extends "create" | "extract" | "list" | "warmup",
  TOperation extends CompressionWorkerOperation,
> = WorkerRequestBase<TAction> & {
  kind: CompressionWorkerKind;
  operation: TOperation;
};

type WorkerCompressionCreateRequestData = WorkerCompressionRequestBase<"create", "create"> & {
  chdCreateMode?: string;
  chdFile?: BrowserWorkerFile;
  chdFileName?: string;
  chdFilePath?: string;
  chdInputFileName?: string;
  chdMode?: string;
  chdOutputFileName?: string;
  compressionCodecs?: WorkerCodecSelection;
  fileName?: string;
  filePaths: string[];
  format: string;
  imageFile?: BrowserWorkerFile;
  imageFilePath?: string;
  imageFiles?: WorkerImageFileEntry[];
  metadata?: WorkerRequestMetadata;
  mode?: string;
  outputName: string;
  rvzBlockSize?: string | number | null;
  rvzCodec?: string;
  rvzCompressionLevel?: string | number | null;
  rvzFile?: BrowserWorkerFile;
  rvzFileName?: string;
  rvzFilePath?: string;
  rvzMode?: string;
  rvzScrub?: boolean | string | number | null;
  rvzSourceFileName?: string;
  threads?: string | number | null;
  workerThreads?: string | number | null;
  z3dsCompressionLevel?: string | number | null;
  z3dsFile?: BrowserWorkerFile;
  z3dsFileName?: string;
  z3dsFilePath?: string;
  z3dsMetadata?: WorkerRomSpecificMetadata | null;
  z3dsSourceFileName?: string;
  z3dsUnderlyingMagic?: string;
};

type WorkerCompressionExtractRequestData = WorkerCompressionRequestBase<"extract", "extract"> & {
  archiveEntryName?: string;
  archiveFileName?: string;
  chdFile?: BrowserWorkerFile;
  chdFileName?: string;
  chdFilePath?: string;
  chdMode?: string;
  fileName?: string;
  filePaths?: string[];
  outputName?: string;
  rvzFile?: BrowserWorkerFile;
  rvzFileName?: string;
  rvzFilePath?: string;
  rvzMode?: string;
  threads?: string | number | null;
  workerThreads?: string | number | null;
  z3dsFile?: BrowserWorkerFile;
  z3dsFileName?: string;
  z3dsFilePath?: string;
};

type WorkerCompressionListRequestData = WorkerCompressionRequestBase<"list", "list"> & {
  archiveFileName?: string;
  chdFile?: BrowserWorkerFile;
  chdFileName?: string;
  chdFilePath?: string;
  fileName?: string;
  filePaths?: string[];
  rvzFile?: BrowserWorkerFile;
  rvzFileName?: string;
  rvzFilePath?: string;
  z3dsFile?: BrowserWorkerFile;
  z3dsFileName?: string;
  z3dsFilePath?: string;
};

type WorkerCompressionWarmupRequestData = WorkerCompressionRequestBase<"warmup", "warmup"> & {
  workerThreads?: string | number | null;
};

type WorkerCleanupRequestData = WorkerRequestBase<"cleanup"> & {
  filePaths: string[];
};

type WorkerTrimRequestData = WorkerRequestBase<"trim"> & {
  fileName?: string;
  filePath: string;
  outputName?: string;
  workerThreads?: string | number | null;
};

type WorkerRequestData =
  | WorkerChecksumRequestData
  | WorkerCleanupRequestData
  | WorkerCompressionCreateRequestData
  | WorkerCompressionExtractRequestData
  | WorkerCompressionListRequestData
  | WorkerCompressionWarmupRequestData
  | WorkerPatchApplyRequestData
  | WorkerPatchCreateCandidatesRequestData
  | WorkerPatchCreateRequestData
  | WorkerPatchParseRequestData
  | WorkerPatchValidateRequestData
  | WorkerTrimRequestData;

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
