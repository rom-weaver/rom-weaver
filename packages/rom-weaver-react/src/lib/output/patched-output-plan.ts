import type { ChdCompressionCodecs, CompressionOptionValue } from "../../types/workflow-compression.ts";
import type { WorkflowRomFileLike as RomFileLike } from "../../types/workflow-source.ts";
import { chdModeFromMetadata } from "../input/rom-specific-file-utils.ts";
import { getCompressionIntermediateFileName } from "./output-files.ts";
import { createPatchedRomSavePlan } from "./output-save-plan.ts";

type ArchiveEntrySaveInfo = {
  fileName: string;
  kind: "patched-rom" | "cue";
  text?: string;
};

type CreatePatchedOutputPlanInput = {
  romFile?: RomFileLike | null;
  patchedFileName: string;
  compressionFormat?: string | null;
  compressionSettings?: Record<string, CompressionOptionValue> | null;
  chdOutputMode?: string | null;
  resolveChdCodecMode?: ((inputFileName: string, createMode: string | null) => string | null) | null;
  resolveChdCompressionCodecs?: ((codecMode: string | null) => ChdCompressionCodecs | null) | null;
  rvzOptions?: Record<string, CompressionOptionValue> | null;
  z3dsOptions?: Record<string, CompressionOptionValue> | null;
};

type PatchedOutputPlan = {
  kind: string;
  compression: string;
  finalOutputFileName: string;
  archiveEntryFileName?: string;
  archiveEntries?: ArchiveEntrySaveInfo[];
  inputFileName?: string;
  chdSourceMode?: string | null;
  chdCuePath?: string | null;
  chdCreateMode?: string | null;
  chdCompressionCodecs?: ChdCompressionCodecs | null;
  rvzSourceFileName?: string;
  rvzMode?: string;
  rvzOptions?: Record<string, CompressionOptionValue>;
  z3dsSourceFileName?: string;
  z3dsUnderlyingMagic?: string;
  z3dsOptions?: Record<string, CompressionOptionValue>;
  chdCodecMode?: string | null;
};

const resolveChdCreateMode = (
  romFile: RomFileLike | null | undefined,
  chdOutputMode: string | null | undefined,
): string | null => {
  const mode = chdModeFromMetadata(romFile?.metadata);
  if (chdOutputMode === "auto" && mode) return mode;
  return chdOutputMode || "auto";
};

const createPatchedOutputPlan = ({
  romFile,
  patchedFileName,
  compressionFormat,
  compressionSettings,
  chdOutputMode,
  resolveChdCodecMode,
  resolveChdCompressionCodecs,
  rvzOptions,
  z3dsOptions,
}: CreatePatchedOutputPlanInput) => {
  const compression = compressionFormat || "none";
  const savePlan = createPatchedRomSavePlan({
    compressionFormat: compression,
    compressionSettings: compressionSettings,
    patchedFileName: patchedFileName,
    romFile: romFile,
  });
  const basePlan = {
    compression: savePlan.compression,
    finalOutputFileName: savePlan.finalOutputFileName,
    kind: savePlan.compression === "none" ? "raw" : savePlan.compression,
    savePlan: savePlan,
  };

  if (compression === "7z" || compression === "zip") {
    return Object.assign({}, basePlan, {
      archiveEntries: [{ fileName: savePlan.archiveEntryFileName, kind: "patched-rom" }],
      archiveEntryFileName: savePlan.archiveEntryFileName,
    });
  }
  if (compression === "chd") {
    const inputFileName = getCompressionIntermediateFileName(patchedFileName, "chd", romFile, {
      chdOutputMode: chdOutputMode || undefined,
    });
    const createMode = resolveChdCreateMode(romFile, chdOutputMode);
    const codecMode =
      typeof resolveChdCodecMode === "function" ? resolveChdCodecMode(inputFileName, createMode) : createMode;
    return Object.assign({}, basePlan, {
      chdCodecMode: codecMode,
      chdCompressionCodecs:
        typeof resolveChdCompressionCodecs === "function" ? resolveChdCompressionCodecs(codecMode) : null,
      chdCreateMode: createMode,
      chdCuePath: romFile?.metadata?.cuePath,
      chdSourceMode: chdModeFromMetadata(romFile?.metadata),
      inputFileName: inputFileName,
    });
  }
  if (compression === "rvz") {
    return Object.assign({}, basePlan, {
      inputFileName: getCompressionIntermediateFileName(patchedFileName, "rvz", romFile),
      rvzMode: romFile?.metadata?.mode,
      rvzOptions: rvzOptions || {},
      rvzSourceFileName: romFile?.metadata?.sourceFileName,
    });
  }
  if (compression === "z3ds") {
    return Object.assign({}, basePlan, {
      inputFileName: getCompressionIntermediateFileName(patchedFileName, "z3ds", romFile),
      z3dsOptions: z3dsOptions || {},
      z3dsSourceFileName: romFile?.metadata?.sourceFileName,
      z3dsUnderlyingMagic: romFile?.metadata?.underlyingMagic,
    });
  }
  return basePlan;
};

export type { PatchedOutputPlan };
export { createPatchedOutputPlan };
