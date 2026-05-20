import type { JsonValue } from "../../types/runtime.ts";
import type { ChdCompressionCodecs, CompressionOptionValue } from "../../types/workflow-compression.ts";
import type { WorkflowRomFileLike as RomFileLike } from "../../types/workflow-source.ts";
import { getCompressionIntermediateFileName } from "./output-files.ts";
import { createPatchedRomSavePlan } from "./output-save-plan.ts";

type ArchiveEntrySaveInfo = {
  fileName: string;
  kind: "patched-rom" | "cue";
  text?: string;
};

type CueOutput = {
  fileName: string;
  text: string;
};

type CreatePatchedOutputPlanInput = {
  romFile?: RomFileLike | null;
  patchedFileName: string;
  compressionFormat?: string | null;
  compressionSettings?: Record<string, CompressionOptionValue> | null;
  replaceCuePatchFileName?: ((cueText: string, outputName: string) => string) | null;
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
  cueOutput?: CueOutput | null;
  archiveEntryFileName?: string;
  archiveEntries?: ArchiveEntrySaveInfo[];
  inputFileName?: string;
  chdSourceMode?: string | null;
  chdCueText?: string | null;
  chdCreateMode?: string | null;
  chdCompressionCodecs?: ChdCompressionCodecs | null;
  rvzSourceFileName?: string;
  rvzMode?: string;
  rvzOptions?: Record<string, CompressionOptionValue>;
  z3dsSourceFileName?: string;
  z3dsUnderlyingMagic?: string;
  z3dsMetadata?: JsonValue;
  z3dsOptions?: Record<string, CompressionOptionValue>;
  chdCodecMode?: string | null;
};

const resolveChdCreateMode = (
  romFile: RomFileLike | null | undefined,
  chdOutputMode: string | null | undefined,
): string | null => {
  if (chdOutputMode === "auto" && romFile && (romFile._chdMode === "cd" || romFile._chdMode === "dvd"))
    return romFile._chdMode;
  return chdOutputMode || "auto";
};

const createPatchedOutputPlan = ({
  romFile,
  patchedFileName,
  compressionFormat,
  compressionSettings,
  replaceCuePatchFileName,
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
    replaceCuePatchFileName: replaceCuePatchFileName,
    romFile: romFile,
  });
  const basePlan = {
    compression: savePlan.compression,
    cueOutput: savePlan.cueOutput,
    finalOutputFileName: savePlan.finalOutputFileName,
    kind: savePlan.compression === "none" ? "raw" : savePlan.compression,
    savePlan: savePlan,
  };

  if (compression === "7z" || compression === "zip") {
    return Object.assign({}, basePlan, {
      archiveEntries: [
        { fileName: savePlan.archiveEntryFileName, kind: "patched-rom" },
        ...(savePlan.cueOutput
          ? [{ fileName: savePlan.cueOutput.fileName, kind: "cue", text: savePlan.cueOutput.text }]
          : []),
      ],
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
      chdCueText: romFile?._chdCueText,
      chdSourceMode: romFile?._chdMode,
      inputFileName: inputFileName,
    });
  }
  if (compression === "rvz") {
    return Object.assign({}, basePlan, {
      inputFileName: getCompressionIntermediateFileName(patchedFileName, "rvz", romFile),
      rvzMode: romFile?._rvzMode,
      rvzOptions: rvzOptions || {},
      rvzSourceFileName: romFile?._rvzSourceFileName,
    });
  }
  if (compression === "z3ds") {
    return Object.assign({}, basePlan, {
      inputFileName: getCompressionIntermediateFileName(patchedFileName, "z3ds", romFile),
      z3dsMetadata: romFile?._z3dsMetadata,
      z3dsOptions: z3dsOptions || {},
      z3dsSourceFileName: romFile?._z3dsSourceFileName,
      z3dsUnderlyingMagic: romFile?._z3dsUnderlyingMagic,
    });
  }
  return basePlan;
};

export type { ChdCompressionCodecs, PatchedOutputPlan };
export { createPatchedOutputPlan };
