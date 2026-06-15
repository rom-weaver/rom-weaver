import { getBaseFileName } from "./path-utils.ts";

// z3ds path-resolution helpers split out of the input-archive orchestrator. The z3ds container
// preserves the original 3DS file extension in its output path; these map an extracted file name back
// to the compressed z3ds-family extension and pick the path-derived name when it carries one.

const getZ3dsCompressedExtensionForExtractedFileName = (
  fileName: string | number | boolean | null | undefined,
): string | null => {
  const normalizedFileName = getBaseFileName(fileName).toLowerCase();
  if (/\.cia$/i.test(normalizedFileName)) return "zcia";
  if (/\.cci$/i.test(normalizedFileName)) return "zcci";
  if (/\.cxi$/i.test(normalizedFileName)) return "zcxi";
  if (/\.3dsx$/i.test(normalizedFileName)) return "z3dsx";
  if (/\.3ds$/i.test(normalizedFileName)) return "z3ds";
  return null;
};

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
