import type { JsonValue } from "../../types/runtime.ts";
import type { WorkflowRomFileLike as RomFileLike } from "../../types/workflow-source.ts";
import { getBaseFileName, hasFileNameExtension, replaceFileNameExtension } from "../input/path-utils.ts";
import { getCompressedOutputFileName } from "./output-files.ts";

const ARCHIVE_OUTPUT_EXTENSION_REGEX = /\.(?:7z|zip)$/i;

type CueOutputEntry = {
  fileName: string;
  text: string;
};

type CreateCueOutputEntryInput = {
  romFile?: RomFileLike | null;
  patchedFileName?: string | null;
  replaceCuePatchFileName?: ((cueText: string, outputName: string) => string) | null;
};

type CreatePatchedRomSavePlanInput = {
  romFile?: RomFileLike | null;
  patchedFileName?: string | null;
  compressionFormat?: string | null;
  compressionSettings?: Record<string, JsonValue> | null;
  replaceCuePatchFileName?: ((cueText: string, outputName: string) => string) | null;
};

const shouldIncludeCueOutput = (romFile?: RomFileLike | null): boolean =>
  !!(romFile && romFile._chdMode === "cd" && romFile._chdCueText);

const createCueOutputEntry = ({
  romFile,
  patchedFileName,
  replaceCuePatchFileName,
}: CreateCueOutputEntryInput): CueOutputEntry | null => {
  if (!shouldIncludeCueOutput(romFile) || typeof replaceCuePatchFileName !== "function") return null;
  const outputName = getBaseFileName(patchedFileName || "patched.bin");
  const cueText = romFile?._chdCueText || "";
  return {
    fileName: replaceFileNameExtension(outputName, "cue"),
    text: replaceCuePatchFileName(cueText, outputName),
  };
};

const getArchivePatchedRomEntryName = (romFile: RomFileLike | null | undefined, outputName?: string | null): string => {
  const fileName = getBaseFileName(outputName || "patched.bin");
  const archiveEntryFileName = fileName.replace(ARCHIVE_OUTPUT_EXTENSION_REGEX, "") || fileName;
  if (hasFileNameExtension(archiveEntryFileName)) return archiveEntryFileName;
  const sourceExtension = typeof romFile?.getExtension === "function" ? romFile.getExtension() : "";
  return sourceExtension ? replaceFileNameExtension(archiveEntryFileName, sourceExtension) : archiveEntryFileName;
};

const createPatchedRomSavePlan = ({
  romFile,
  patchedFileName,
  compressionFormat,
  compressionSettings,
  replaceCuePatchFileName,
}: CreatePatchedRomSavePlanInput) => {
  const compression = compressionFormat || "none";
  const normalizedPatchedFileName = patchedFileName || "patched.bin";
  const finalOutputFileName =
    compression === "none"
      ? normalizedPatchedFileName
      : getCompressedOutputFileName(normalizedPatchedFileName, compression, compressionSettings || {}, romFile);
  const archiveEntryFileName =
    compression === "7z" || compression === "zip" ? getArchivePatchedRomEntryName(romFile, finalOutputFileName) : null;
  const cuePatchedFileName = archiveEntryFileName || normalizedPatchedFileName;
  const cueOutput = createCueOutputEntry({
    patchedFileName: cuePatchedFileName,
    replaceCuePatchFileName: replaceCuePatchFileName,
    romFile: romFile,
  });

  return {
    archiveEntryFileName: archiveEntryFileName,
    compression: compression,
    cueOutput: cueOutput,
    finalOutputFileName: finalOutputFileName,
  };
};

export { createCueOutputEntry, createPatchedRomSavePlan, getArchivePatchedRomEntryName, shouldIncludeCueOutput };
