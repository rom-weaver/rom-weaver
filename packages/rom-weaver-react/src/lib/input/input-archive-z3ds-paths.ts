import { z3dsCompressedExtensionForUnderlyingExtension } from "../compression/z3ds-subtypes.ts";
import { getFileNameExtension } from "../path-utils.ts";
import { getBaseFileName } from "./path-utils.ts";

// z3ds path-resolution helpers split out of the input-archive orchestrator. The z3ds container
// preserves the original 3DS file extension in its output path; these map an extracted file name back
// to the compressed z3ds-family extension (via the generated subtype table) and pick the path-derived
// name when it carries one.

const getZ3dsCompressedExtensionForExtractedFileName = (
  fileName: string | number | boolean | null | undefined,
): string | null =>
  z3dsCompressedExtensionForUnderlyingExtension(getFileNameExtension(getBaseFileName(fileName).toLowerCase()));

const getZ3dsOutputPathFileName = (
  output: { fileName?: string; filePath?: string; path?: string },
  fallbackFileName: string,
): string => {
  const outputPathFileName = getBaseFileName(output.path || output.filePath || "");
  if (outputPathFileName && getZ3dsCompressedExtensionForExtractedFileName(outputPathFileName)) {
    return outputPathFileName;
  }
  return fallbackFileName;
};

export { getZ3dsOutputPathFileName };
