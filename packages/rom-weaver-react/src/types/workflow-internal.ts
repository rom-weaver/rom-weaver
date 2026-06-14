import type { PatchFileInstance } from "../workers/protocol/patch-engine.ts";
import type { JsonValue } from "./runtime.ts";

type SharedProgressEventLike = {
  details?: JsonValue;
  label?: string;
  message?: string;
  percent?: string | number | null;
  stage?: string;
  loaded?: string | number | boolean | null;
  total?: string | number | boolean | null;
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
  toPublicOutput: typeof import("../lib/apply/patch-apply-service.ts").toPublicOutput;
  verifyPatchedOutputIfRequired: typeof import("../lib/apply/patch-apply-service.ts").verifyPatchedOutputIfRequired;
};

type CreateWorkflowDeps = PatchWorkflowDeps & {
  createPatchFile: typeof import("../lib/input/binary-service.ts").createPatchFile;
  getPatchFileBytes: typeof import("../lib/input/binary-service.ts").getPatchFileBytes;
  getDefaultCreatePatchOutputFileName: typeof import("../lib/input/binary-service.ts").getDefaultCreatePatchOutputFileName;
  getNamedSource: typeof import("../storage/shared/binary/source-file-utils.ts").getNamedSource;
  getNamedSourceFileName: typeof import("../storage/shared/binary/source-file-utils.ts").getNamedSourceFileName;
  hasArchiveFileName: (fileName: string, compression: string) => boolean;
};

export type { CreateWorkflowDeps, PatchFileInstance, PatchWorkflowDeps, SharedProgressEventLike };
