import type { ArchiveOutputSettings, CompressionIntermediateOptions } from "../../types/workflow-compression.ts";
import type { WorkflowRomFileLike as SourceFileLike } from "../../types/workflow-source.ts";
import OutputCompressionManager from "../compression/output-compression-manager.ts";
import {
  createRomSpecificExtensionRegex,
  hasRomSpecificExtension,
  RVZ_DECOMPRESSION_INPUT_EXTENSIONS,
} from "../compression/rom-specific-format-support.ts";
import {
  z3dsUnderlyingExtensionForCompressedExtension,
  z3dsUnderlyingExtensionForMagic,
} from "../compression/z3ds-subtypes.ts";
import { appendFileNameExtension, hasFileNameExtension, replaceFileNameExtension } from "../input/path-utils.ts";
import { CHD_EXTENSION_REGEX } from "../path-utils.ts";

const RVZ_EXTENSION_REGEX = createRomSpecificExtensionRegex(RVZ_DECOMPRESSION_INPUT_EXTENSIONS);
const Z3DS_EXTENSION_REGEX = /\.(zcia|zcci|zcxi|z3dsx|z3ds)$/i;
const ARCHIVE_EXTENSION_REGEX = /\.(7z|zip)$/i;

const getSourceExtension = (source: SourceFileLike | null | undefined, fallback?: string): string => {
  if (source && typeof source.getExtension === "function") {
    const extension = source.getExtension();
    if (extension) return extension;
  }
  return fallback === undefined ? "" : fallback;
};

const getOptionalString = (value: string | number | boolean | null | undefined) =>
  typeof value === "string" ? value : undefined;
const getOptionalCompressionLevel = (value: string | number | boolean | null | undefined) =>
  typeof value === "string" || typeof value === "number" || value === null ? value : undefined;

const getArchiveOutputOptions = (compression: string, settings: ArchiveOutputSettings) => ({
  sevenZipCodec:
    compression === "7z"
      ? OutputCompressionManager.getArchiveCodec("7z", {
          sevenZipCodec: getOptionalString(settings.sevenZipCodec),
          zipCodec: getOptionalString(settings.zipCodec),
        }) || undefined
      : getOptionalString(settings.sevenZipCodec),
  sevenZipLevel: getOptionalCompressionLevel(settings.sevenZipLevel),
  zipCodec:
    compression === "zip"
      ? OutputCompressionManager.getArchiveCodec("zip", {
          sevenZipCodec: getOptionalString(settings.sevenZipCodec),
          zipCodec: getOptionalString(settings.zipCodec),
        }) || undefined
      : getOptionalString(settings.zipCodec),
  zipLevel: getOptionalCompressionLevel(settings.zipLevel),
});

const getCompressedOutputFileName = (
  fileName: string,
  compression: string,
  settings: ArchiveOutputSettings,
  source?: SourceFileLike | null,
): string => {
  if (compression === "7z" || compression === "zip") {
    return appendFileNameExtension(
      fileName,
      OutputCompressionManager.getArchiveOutputExtension(compression, getArchiveOutputOptions(compression, settings)),
    );
  }

  const sourceExtension = source ? getSourceExtension(source, "") : "";
  const resolvedSourceFileName =
    !hasFileNameExtension(fileName) && sourceExtension ? replaceFileNameExtension(fileName, sourceExtension) : fileName;
  const compressionSource =
    source && typeof source === "object"
      ? {
          ...source,
          fileName: resolvedSourceFileName,
        }
      : { fileName: resolvedSourceFileName };
  return OutputCompressionManager.getCompressedFileName(
    compressionSource,
    compression,
    getArchiveOutputOptions(compression, settings),
  );
};

const getChdIntermediateFileName = (
  fileName: string,
  source: SourceFileLike | null | undefined,
  chdOutputMode: string | null | undefined,
): string => {
  if (!source) return fileName;
  if (!hasFileNameExtension(fileName)) {
    const sourceExtension = getSourceExtension(source, source?._chdMode === "cd" ? "bin" : "iso");
    return replaceFileNameExtension(fileName, sourceExtension);
  }
  if (CHD_EXTENSION_REGEX.test(fileName)) {
    const sourceExtension = getSourceExtension(source, chdOutputMode === "cd" ? "bin" : "iso");
    return replaceFileNameExtension(fileName, sourceExtension || (source?._chdMode === "cd" ? "bin" : "iso"));
  }
  return fileName;
};

const getArchiveIntermediateFileName = (fileName: string, source: SourceFileLike | null | undefined): string => {
  if (!source) return fileName;
  if (!hasFileNameExtension(fileName)) return replaceFileNameExtension(fileName, getSourceExtension(source, "bin"));
  if (ARCHIVE_EXTENSION_REGEX.test(fileName)) {
    const sourceExtension = getSourceExtension(source, "bin");
    return replaceFileNameExtension(fileName, sourceExtension || "bin");
  }
  return fileName;
};

const getRvzIntermediateFileName = (fileName: string, source: SourceFileLike | null | undefined): string => {
  if (!source) return fileName;
  const normalizeRvzSourceExtension = (extension: string) =>
    extension && hasRomSpecificExtension(RVZ_DECOMPRESSION_INPUT_EXTENSIONS, extension) ? "iso" : extension;
  if (!hasFileNameExtension(fileName)) {
    const sourceExtension = normalizeRvzSourceExtension(getSourceExtension(source, "iso"));
    return replaceFileNameExtension(fileName, sourceExtension);
  }
  if (RVZ_EXTENSION_REGEX.test(fileName)) {
    const sourceExtension = normalizeRvzSourceExtension(getSourceExtension(source, "iso"));
    return replaceFileNameExtension(fileName, sourceExtension || "iso");
  }
  return fileName;
};

const getZ3dsDecompressedSourceExtension = (source: SourceFileLike | null | undefined): string => {
  const sourceExtension = getSourceExtension(source, "");
  const specific = z3dsUnderlyingExtensionForCompressedExtension(sourceExtension);
  if (specific) return specific;
  const magicExtension = z3dsUnderlyingExtensionForMagic(source?._z3dsUnderlyingMagic);
  if (sourceExtension === "z3ds") return magicExtension || "3ds";
  return sourceExtension || magicExtension || "3ds";
};

const getZ3dsIntermediateFileName = (fileName: string, source: SourceFileLike | null | undefined): string => {
  if (!source) return fileName;
  const sourceExtension = getZ3dsDecompressedSourceExtension(source);
  if (!hasFileNameExtension(fileName)) {
    return replaceFileNameExtension(fileName, sourceExtension);
  }
  if (Z3DS_EXTENSION_REGEX.test(fileName)) {
    return replaceFileNameExtension(fileName, sourceExtension);
  }
  return fileName;
};

const getRawIntermediateFileName = (fileName: string, source: SourceFileLike | null | undefined): string => {
  if (!source || hasFileNameExtension(fileName)) return fileName;
  const sourceExtension = getSourceExtension(source, "");
  return sourceExtension ? replaceFileNameExtension(fileName, sourceExtension) : fileName;
};

const getCompressionIntermediateFileName = (
  fileName: string,
  compression: string,
  source?: SourceFileLike | null,
  options?: CompressionIntermediateOptions | null,
): string => {
  if (compression === "chd") return getChdIntermediateFileName(fileName, source || null, options?.chdOutputMode);
  if (compression === "rvz") return getRvzIntermediateFileName(fileName, source || null);
  if (compression === "z3ds") return getZ3dsIntermediateFileName(fileName, source || null);
  if (compression === "7z" || compression === "zip") return getArchiveIntermediateFileName(fileName, source || null);
  return getRawIntermediateFileName(fileName, source || null);
};

export { getCompressedOutputFileName, getCompressionIntermediateFileName };
