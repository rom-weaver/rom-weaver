import { getSourceExtension, getSourceFileName, replaceFileExtension } from "../../shared/binary/source-file-utils.ts";
import { normalizeThreadCount, parseIntegerInRange } from "../../shared/compression-options.ts";

const OUTPUT_COMPRESSION = {
  SEVEN_ZIP: "7z",
  ZIP: "zip",
} as const;
const SEVEN_ZIP_COMPRESSION_METHODS = ["lzma2", "zstd"];
const ZIP_COMPRESSION_METHODS = ["deflate", "store", "zstd"];
const ARCHIVE_FORMATS: Record<string, string> = {
  "7z": "7zip",
  zip: "zip",
};

type CompressionChoiceInput = string | null | undefined;
type CodecChoiceInput = string | null | undefined;
type OutputCompressionOptions = {
  sevenZipCodec?: CodecChoiceInput;
  sevenZipLevel?: string | number | null;
  zipCodec?: CodecChoiceInput;
  zipLevel?: string | number | null;
  threads?: string | number | boolean | null;
};

const getFileName = (source: RuntimeValue) =>
  getSourceFileName(source, { allowString: true, keys: ["fileName", "name", "_archiveEntryName"] });

const normalizeOutputCompression = (value: CompressionChoiceInput) => {
  const normalized = String(value || OUTPUT_COMPRESSION.SEVEN_ZIP).toLowerCase();
  if (normalized === OUTPUT_COMPRESSION.SEVEN_ZIP || normalized === OUTPUT_COMPRESSION.ZIP) return normalized;
  throw new Error(`Unsupported output compression: ${value}`);
};

const normalizeCompressionLevel = (value: string | number | null | undefined, fallback?: number) => {
  const parsed = parseIntegerInRange(value, {
    allowEmpty: true,
    failureMessage: `Unsupported compression level: ${value}`,
    max: 9,
    min: 0,
    requireExactString: true,
  });
  if (parsed !== null) return parsed;
  return fallback === undefined ? 9 : fallback;
};

const normalizeZstdCompressionLevel = (value: string | number | null | undefined, fallback?: number) => {
  const parsed = parseIntegerInRange(value, {
    allowEmpty: true,
    failureMessage: `Unsupported zstd compression level: ${value}`,
    max: 22,
    min: 0,
    requireExactString: true,
  });
  if (parsed !== null) return parsed;
  return fallback === undefined ? 9 : fallback;
};

const normalizeArchiveCompressionLevelForFormat = (
  compression: string | null | undefined,
  codec: string | null | undefined,
  value: string | number | null | undefined,
  fallback?: number,
) => {
  const selected = normalizeOutputCompression(compression);
  if (selected === OUTPUT_COMPRESSION.ZIP) return normalizeCompressionLevel(value, fallback);
  return String(codec || "").toLowerCase() === "zstd"
    ? normalizeZstdCompressionLevel(value, fallback)
    : normalizeCompressionLevel(value, fallback);
};

const normalizeArchiveCodec = (value: CodecChoiceInput, validCodecs: string[], fallback: string, label: string) => {
  const normalized = String(value || fallback || "")
    .trim()
    .toLowerCase();
  if (validCodecs.indexOf(normalized) !== -1) return normalized;
  throw new Error(`Unsupported ${label || "archive"} codec: ${value}`);
};

const normalizeSevenZipCodec = (value: CodecChoiceInput, fallback?: string) =>
  normalizeArchiveCodec(value, SEVEN_ZIP_COMPRESSION_METHODS, fallback || "lzma2", "7z");

const normalizeZipCodec = (value: CodecChoiceInput, fallback?: string) =>
  normalizeArchiveCodec(value, ZIP_COMPRESSION_METHODS, fallback || "deflate", "ZIP");

const getArchiveFormat = (compression: CompressionChoiceInput) => {
  const archiveFormat = ARCHIVE_FORMATS[normalizeOutputCompression(compression)];
  if (!archiveFormat) throw new Error(`Unsupported archive output compression: ${compression}`);
  return archiveFormat;
};

const getArchiveCodec = (compression: CompressionChoiceInput, options?: OutputCompressionOptions): string | null => {
  const selected = normalizeOutputCompression(compression);
  if (selected === OUTPUT_COMPRESSION.SEVEN_ZIP) return normalizeSevenZipCodec(options?.sevenZipCodec);
  if (selected === OUTPUT_COMPRESSION.ZIP) return normalizeZipCodec(options?.zipCodec);
  return null;
};

const getArchiveThreadsOption = (options?: OutputCompressionOptions) =>
  normalizeThreadCount(options?.threads, { fallback: null });

const getArchiveOutputExtension = (compression: CompressionChoiceInput, options?: OutputCompressionOptions) =>
  normalizeOutputCompression(compression) === OUTPUT_COMPRESSION.ZIP && getArchiveCodec(compression, options) === "zstd"
    ? "zipx"
    : normalizeOutputCompression(compression);

const getArchiveLevelOption = (compression: CompressionChoiceInput, options?: OutputCompressionOptions) => {
  const selected = normalizeOutputCompression(compression);
  if (selected === OUTPUT_COMPRESSION.SEVEN_ZIP) {
    const codec = getArchiveCodec(compression, options);
    return normalizeArchiveCompressionLevelForFormat(selected, codec, options?.sevenZipLevel, 9);
  }
  const codec = getArchiveCodec(compression, options);
  if (codec === "store") return null;
  const level = normalizeArchiveCompressionLevelForFormat(selected, codec, options?.zipLevel, 9);
  const threads = getArchiveThreadsOption(options);
  if (codec === "zstd" && threads !== null && threads > 1 && typeof level === "number" && level >= 9) return 8;
  return level;
};

const getArchiveWriterOptions = (compression: CompressionChoiceInput, options?: OutputCompressionOptions) => {
  const codec = getArchiveCodec(compression, options);
  const level = getArchiveLevelOption(compression, options);
  const threads = getArchiveThreadsOption(options);
  if (codec === "store") return threads === null ? "compression=store" : `compression=store,threads=${threads}`;
  return threads === null
    ? `compression=${codec},compression-level=${level}`
    : `compression=${codec},compression-level=${level},threads=${threads}`;
};

const getCompressedFileName = (
  source: RuntimeValue,
  compression: CompressionChoiceInput,
  options?: OutputCompressionOptions,
) => replaceFileExtension(getFileName(source) || "patched.bin", getArchiveOutputExtension(compression, options));

export {
  getArchiveFormat,
  getArchiveWriterOptions,
  getCompressedFileName,
  getSourceExtension,
  normalizeArchiveCompressionLevelForFormat,
  normalizeOutputCompression,
  normalizeSevenZipCodec,
  normalizeZipCodec,
};
