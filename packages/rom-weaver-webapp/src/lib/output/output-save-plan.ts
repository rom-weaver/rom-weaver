import type { JsonValue } from "../../types/runtime.ts";
import type { WorkflowRomFileLike as RomFileLike } from "../../types/workflow-source.ts";
import { getBaseFileName, hasFileNameExtension, replaceFileNameExtension } from "../input/path-utils.ts";
import { getCompressedOutputFileName } from "./output-files.ts";

const ARCHIVE_OUTPUT_EXTENSION_REGEX = /\.(?:7z|zip)$/i;

type CreatePatchedRomSavePlanInput = {
  romFile?: RomFileLike | null;
  patchedFileName?: string | null;
  compressionFormat?: string | null;
  compressionSettings?: Record<string, JsonValue> | null;
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
}: CreatePatchedRomSavePlanInput) => {
  const compression = compressionFormat || "none";
  const normalizedPatchedFileName = patchedFileName || "patched.bin";
  const finalOutputFileName =
    compression === "none"
      ? normalizedPatchedFileName
      : getCompressedOutputFileName(normalizedPatchedFileName, compression, compressionSettings || {}, romFile);
  const archiveEntryFileName =
    compression === "7z" || compression === "zip" ? getArchivePatchedRomEntryName(romFile, finalOutputFileName) : null;

  return {
    archiveEntryFileName: archiveEntryFileName,
    compression: compression,
    finalOutputFileName: finalOutputFileName,
  };
};

export { createPatchedRomSavePlan };
