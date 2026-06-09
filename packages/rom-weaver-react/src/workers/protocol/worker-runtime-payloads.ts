import type {
  ChecksumCommand,
  CompressCommand,
  ExtractCommand,
  ListCommand,
  PatchCreateCandidatesCommand,
  PatchCreateCommand,
  RomWeaverJsonValue,
  RomWeaverProgressEvent,
  TrimCommand,
} from "rom-weaver-wasm";
import type { WorkerKind } from "../../types/worker-messages.ts";
import type {
  RuntimePatchApplyOptions,
  RuntimePatchValidateOptions,
  RuntimeThreadBudgetInput,
} from "../../types/workflow-runtime-adapter.ts";
import type { PatchFileEntry as WorkflowPatchFileEntry } from "../../types/workflow-source.ts";
import type { BrowserWorkerFile, CompressionWorkerKind, CompressionWorkerOperation } from "./worker-protocol.ts";

type WorkerRequestId = string;
type WorkerRuntimeValue = RomWeaverJsonValue | object | undefined;
type WorkerRuntimeRecord = {
  [key: string]: WorkerRuntimeValue;
};

type WorkerProgressEvent = Partial<RomWeaverProgressEvent> & {
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

type WorkerRequestMetadata = Record<string, RomWeaverJsonValue | undefined>;
type WorkerRomSpecificMetadata = Record<string, string | number | boolean | Uint8Array | null | undefined>;
type WorkerCodecSelection = CompressCommand["codec"] | string | Record<string, string | number> | null;
type WorkerImageFileEntry = {
  file?: BrowserWorkerFile;
  fileName?: string;
  filePath?: string;
};

type WorkerPatchApplyRequestData = WorkerRequestBase<"apply"> & {
  options?: RuntimePatchApplyOptions;
  patchFile?: BrowserWorkerFile;
  patchFileName?: string;
  patchFilePath?: string;
  patchFiles: PatchFileEntry[];
  romFile?: BrowserWorkerFile;
  romFileName?: string;
  romFilePath: string;
};

type WorkerPatchValidateRequestData = WorkerRequestBase<"validate-patch"> & {
  options?: RuntimePatchValidateOptions;
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
  modifiedFileName: PatchCreateCandidatesCommand["modified"];
  modifiedFilePath: PatchCreateCandidatesCommand["modified"];
  originalFile?: BrowserWorkerFile;
  originalFileName: PatchCreateCandidatesCommand["original"];
  originalFilePath: PatchCreateCandidatesCommand["original"];
  workerThreads?: RuntimeThreadBudgetInput;
};

type WorkerPatchCreateRequestData = WorkerRequestBase<"create-patch"> & {
  format: NonNullable<PatchCreateCommand["format"]>;
  metadata?: WorkerRequestMetadata;
  modifiedFile?: BrowserWorkerFile;
  modifiedFileName: PatchCreateCommand["modified"];
  modifiedFilePath: PatchCreateCommand["modified"];
  originalFile?: BrowserWorkerFile;
  originalFileName: PatchCreateCommand["original"];
  originalFilePath: PatchCreateCommand["original"];
  outputName: PatchCreateCommand["output"];
  workerThreads?: RuntimeThreadBudgetInput;
};

type WorkerChecksumRequestData = WorkerRequestBase<"checksum"> & {
  checksumAlgorithms: ChecksumCommand["algo"];
  checksumStartOffset?: number;
  fileName?: string;
  filePath: ChecksumCommand["source"];
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
  filePaths: CompressCommand["input"];
  format: NonNullable<CompressCommand["format"]>;
  imageFile?: BrowserWorkerFile;
  imageFilePath?: string;
  imageFiles?: WorkerImageFileEntry[];
  metadata?: WorkerRequestMetadata;
  mode?: string;
  outputName: CompressCommand["output"];
  rvzBlockSize?: RuntimeThreadBudgetInput;
  rvzCodec?: string;
  rvzCompressionLevel?: RuntimeThreadBudgetInput;
  rvzFile?: BrowserWorkerFile;
  rvzFileName?: string;
  rvzFilePath?: string;
  rvzMode?: string;
  rvzScrub?: boolean | string | number | null;
  rvzSourceFileName?: string;
  threads?: RuntimeThreadBudgetInput;
  workerThreads?: RuntimeThreadBudgetInput;
  z3dsCompressionLevel?: RuntimeThreadBudgetInput;
  z3dsFile?: BrowserWorkerFile;
  z3dsFileName?: string;
  z3dsFilePath?: string;
  z3dsMetadata?: WorkerRomSpecificMetadata | null;
  z3dsSourceFileName?: string;
  z3dsUnderlyingMagic?: string;
};

type WorkerCompressionExtractRequestData = WorkerCompressionRequestBase<"extract", "extract"> & {
  archiveEntryName?: NonNullable<ExtractCommand["select"]>[number];
  archiveFileName?: string;
  chdFile?: BrowserWorkerFile;
  chdFileName?: string;
  chdFilePath?: string;
  chdMode?: string;
  fileName?: string;
  filePaths?: ExtractCommand["select"];
  outputName?: ExtractCommand["out_dir"];
  rvzFile?: BrowserWorkerFile;
  rvzFileName?: string;
  rvzFilePath?: string;
  rvzMode?: string;
  threads?: RuntimeThreadBudgetInput;
  workerThreads?: RuntimeThreadBudgetInput;
  z3dsFile?: BrowserWorkerFile;
  z3dsFileName?: string;
  z3dsFilePath?: string;
};

type WorkerCompressionListRequestData = WorkerCompressionRequestBase<"list", "list"> & {
  archiveFileName?: ListCommand["source"];
  chdFile?: BrowserWorkerFile;
  chdFileName?: string;
  chdFilePath?: string;
  fileName?: string;
  filePaths?: ListCommand["select"];
  rvzFile?: BrowserWorkerFile;
  rvzFileName?: string;
  rvzFilePath?: string;
  z3dsFile?: BrowserWorkerFile;
  z3dsFileName?: string;
  z3dsFilePath?: string;
};

type WorkerCompressionWarmupRequestData = WorkerCompressionRequestBase<"warmup", "warmup"> & {
  workerThreads?: RuntimeThreadBudgetInput;
};

type WorkerCleanupRequestData = WorkerRequestBase<"cleanup"> & {
  filePaths: string[];
};

type WorkerTrimRequestData = WorkerRequestBase<"trim"> & {
  fileName?: string;
  filePath: TrimCommand["source"][number];
  outputName?: TrimCommand["output"];
  workerThreads?: RuntimeThreadBudgetInput;
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
