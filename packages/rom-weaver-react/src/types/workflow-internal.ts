import type { InputAsset } from "../lib/input/input-assets.ts";
import type { CoreRomPatchFileLike, PatchFileInstance } from "../workers/protocol/patch-engine.ts";
import type { JsonValue } from "./runtime.ts";
import type { CompressionCreateInput, CompressionExtractInput } from "./workflow-runtime.ts";

type SharedProgressEventLike = {
  label?: string;
  message?: string;
  percent?: string | number | null;
  loaded?: string | number | boolean | null;
  total?: string | number | boolean | null;
};

type ArchiveWorkflowDeps = {
  ArchiveManager: {
    toArrayBuffer: (
      data: Blob | ArrayBuffer | Uint8Array | ArrayBufferView,
    ) => ArrayBuffer | Uint8Array | ArrayBufferView;
  };
  createArchiveOutputData: (input: Record<string, unknown>) => Promise<ArrayBuffer | Uint8Array>;
  extractArchiveSourceEntry: (input: Record<string, unknown>) => Promise<{
    data?: Uint8Array;
    u8array?: Uint8Array;
    file?: Blob;
    fileName?: string;
    size?: number;
    cleanup?: () => Promise<void> | void;
  }>;
  getArchiveOutputFileName: (input: Record<string, unknown>) => string;
  getArchiveSourceTransport: (
    source: unknown,
    fallbackFileName: string,
  ) => {
    archiveSource: unknown;
    fileName: string;
  };
  listArchiveSourceEntries: (input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  normalizeArchiveEntryBytes: (data: ArrayBuffer | Uint8Array | ArrayBufferView) => Uint8Array;
  normalizeArchiveEntryInfo: (entry: Record<string, unknown>) => Record<string, unknown> & { filename?: string };
  reportCompressionProgress: (
    options: CompressionExtractInput["options"] | CompressionCreateInput["options"],
    event: {
      stage: "input" | "output";
      label: string;
      percent: number | null;
      details?: JsonValue;
    },
  ) => void;
};

type PatchWorkflowDeps = {
  buildSessionOutputFiles: typeof import("../lib/output/output-build-service.ts").buildSessionOutputFiles;
  createPatchFile: typeof import("../lib/input/binary-service.ts").createPatchFile;
  getBinarySourceSize: typeof import("../lib/input/input-preparation-service.ts").getBinarySourceSize;
  normalizePatchOptions: typeof import("../lib/apply/patch-apply-service.ts").normalizePatchOptions;
  parsePatchForApply: typeof import("../lib/apply/patch-apply-service.ts").parsePatchForApply;
  prepareAutoPatchInputs: typeof import("../lib/input/input-preparation-service.ts").prepareAutoPatchInputs;
  prepareInput: typeof import("../lib/input/input-preparation-service.ts").prepareInput;
  prepareInputAssets: typeof import("../lib/input/input-preparation-service.ts").prepareInputAssets;
  prepareMultipleDirectInputAssets: typeof import("../lib/input/input-preparation-service.ts").prepareMultipleDirectInputAssets;
  reportProgress: typeof import("../lib/progress/progress-reporting.ts").reportProgress;
  resolvePatchTargets: typeof import("../lib/apply/patch-apply-service.ts").resolvePatchTargets;
  RomWeaver: Pick<typeof import("../lib/apply/patch-apply-service.ts").RomWeaver, "applyPatchSequence"> & {
    createPatch: (
      original: CoreRomPatchFileLike,
      modified: CoreRomPatchFileLike,
      format: string,
      metadata: Record<string, JsonValue>,
      options?: { workerThreads?: number | string | null },
    ) => Promise<{
      export(fileName: string): PatchFileInstance;
    }>;
  };
  toPublicOutput: typeof import("../lib/apply/patch-apply-service.ts").toPublicOutput;
  verifyPatchedOutputIfRequired: typeof import("../lib/apply/patch-apply-service.ts").verifyPatchedOutputIfRequired;
};

type CreateWorkflowDeps = PatchWorkflowDeps & {
  ArchiveManager: ArchiveWorkflowDeps["ArchiveManager"];
  createArchiveOutputData: ArchiveWorkflowDeps["createArchiveOutputData"];
  createPatchFile: typeof import("../lib/input/binary-service.ts").createPatchFile;
  getPatchFileBytes: typeof import("../lib/input/binary-service.ts").getPatchFileBytes;
  getDefaultCreatePatchOutputFileName: typeof import("../lib/input/binary-service.ts").getDefaultCreatePatchOutputFileName;
  getNamedSource: typeof import("../storage/shared/binary/source-file-utils.ts").getNamedSource;
  getNamedSourceFileName: typeof import("../storage/shared/binary/source-file-utils.ts").getNamedSourceFileName;
  hasArchiveFileName: (fileName: string, compression: string) => boolean;
  normalizeArchiveEntryBytes: ArchiveWorkflowDeps["normalizeArchiveEntryBytes"];
};

export type {
  ArchiveWorkflowDeps,
  CreateWorkflowDeps,
  InputAsset,
  PatchFileInstance,
  PatchWorkflowDeps,
  SharedProgressEventLike,
};
