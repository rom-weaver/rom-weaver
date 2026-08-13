import {
  CREATE_ARCHIVE_COMPRESSION_FORMATS,
  CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS,
} from "../../lib/compression/container-format-registry.ts";
import OutputCompressionManager from "../../lib/compression/output-compression-manager.ts";
import { getCreatePatchFormatsForSizes, normalizeCreatePatchFormat } from "../../lib/create/patch-format-limits.ts";
import { classifyPatcherInput } from "../../lib/input/input-classification.ts";
import { buildPatchedOutputBaseName } from "../../lib/output/output-name-composition.ts";
import { getFileNameExtension, replaceFileNameExtension } from "../../lib/path-utils.ts";
import type { ApplySettings } from "../../types/settings.ts";
import { ROM_WEAVER_PATCH_FORMATS } from "../../wasm/generated/rom-weaver-format-metadata.ts";

type OutputOption = {
  value: string;
  label: string;
};

type OutputOptionLabelMap = Record<string, string>;

type OutputNameSettings = Pick<NonNullable<ApplySettings["output"]>, "extension" | "outputName" | "suffix">;

type GeneratedPatchNameSource = {
  _generatedPatchName?: string | null;
  _originalPatchFile?: { fileName?: string | null } | null;
  fileName?: string | null;
  name?: string | null;
};
type ParsedPatchNameLike = {
  _generatedPatchName?: string | null;
  fileName?: string | null;
};
type GeneratedOutputBinarySource = string | Blob | File | FileSystemFileHandle;
type GeneratedOutputSource = GeneratedOutputBinarySource | GeneratedPatchNameSource | null | undefined;
type CreatePatchFormatOptions = {
  candidateFormats?: readonly string[] | null;
  modifiedSize?: number | null;
  originalSize?: number | null;
};

const EXTENSION_REGEX = /\.([^./\\\s]+)$/;
const FILE_NAME_SEPARATOR_REGEX = /[/\\]+/;
const NONE_COMPRESSION_LABEL = "None";

const getFileNameWithoutExtension = (fileName: string) =>
  getBaseFileName(fileName).replace(EXTENSION_REGEX, "") || getBaseFileName(fileName);

const getBaseFileName = (fileName: string) =>
  String(fileName || "")
    .split(FILE_NAME_SEPARATOR_REGEX)
    .pop() || "";

const sanitizeFileNamePart = (value: string | null | undefined, fallback: string) => {
  const withoutControlCharacters = Array.from(String(value || ""))
    .filter((char) => char.charCodeAt(0) >= 32)
    .join("");
  const sanitized = withoutControlCharacters
    .replace(/[<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || fallback;
};

const getFileName = (source: GeneratedOutputSource, fallback: string) => {
  if (source && typeof source === "object" && "name" in source && typeof source.name === "string") return source.name;
  if (source && typeof source === "object" && "fileName" in source && typeof source.fileName === "string")
    return source.fileName;
  return fallback;
};

const getGeneratedOutputSourceFileName = (source: GeneratedOutputSource, fallback: string) => {
  const classifiedInput = classifyPatcherInput(source);
  if (classifiedInput.kind === "compression" && classifiedInput.compressionFormat !== classifiedInput.fileName) {
    return classifiedInput.defaultExtractedEntryName || classifiedInput.fileName || fallback;
  }
  return getFileName(source, fallback);
};

const normalizePatchSourceForGeneratedFileName = (
  patchSource: GeneratedOutputSource,
  fallback: string,
): ParsedPatchNameLike => {
  if (typeof patchSource === "string" && patchSource) return { fileName: patchSource };
  if (patchSource && typeof patchSource === "object") {
    const source = patchSource as GeneratedPatchNameSource;
    const providedFileName = source._originalPatchFile?.fileName || source.fileName || source.name;
    if (providedFileName) {
      return {
        _generatedPatchName: source._generatedPatchName || undefined,
        fileName: providedFileName,
      };
    }
    if (source._generatedPatchName) {
      return {
        _generatedPatchName: source._generatedPatchName,
      };
    }
  }
  return { fileName: fallback };
};

const generatePatchedFileName = (
  romFileName: string,
  patchSources: ParsedPatchNameLike[],
  settings: OutputNameSettings,
) => {
  if (settings.outputName) return settings.outputName;
  if (settings.suffix) {
    const romName = sanitizeFileNamePart(getFileNameWithoutExtension(romFileName), "patched");
    return `${romName} (patched)`;
  }

  const romName = sanitizeFileNamePart(getFileNameWithoutExtension(romFileName), "patched");
  const patchNames = patchSources
    .map((patchSource) => {
      const generatedName = patchSource._generatedPatchName;
      const name = generatedName || getFileNameWithoutExtension(patchSource.fileName || "");
      return sanitizeFileNamePart(name, "");
    })
    .filter(Boolean);
  return buildPatchedOutputBaseName(romName, patchNames);
};

const getGeneratedOutputName = (
  inputSource: GeneratedOutputSource,
  patchSources: GeneratedOutputSource[],
  settings: OutputNameSettings,
) => {
  if (settings.outputName) return settings.outputName;

  const sourceFileName = getGeneratedOutputSourceFileName(inputSource, "");
  if (!sourceFileName) return "";

  return generatePatchedFileName(
    sourceFileName,
    patchSources.map((patchSource, index) =>
      normalizePatchSourceForGeneratedFileName(patchSource, `patch ${index + 1}`),
    ),
    settings,
  );
};

const getOutputOptionExtensionLabel = (option: string, source?: GeneratedOutputSource) => {
  if (option === "none" && !getGeneratedOutputSourceFileName(source, "")) return "";
  try {
    const fileName = OutputCompressionManager.getCompressedFileName(
      source as Parameters<typeof OutputCompressionManager.getCompressedFileName>[0],
      option,
    );
    const extension = getBaseFileName(fileName).match(EXTENSION_REGEX)?.[1]?.toLowerCase();
    return extension ? `.${extension}` : "";
  } catch {
    return "";
  }
};

const createOutputOptions = (
  compressionOptions: readonly string[],
  source?: GeneratedOutputSource,
  labels: OutputOptionLabelMap = {},
): OutputOption[] =>
  compressionOptions.map((option) => ({
    label:
      labels[option] ||
      getOutputOptionExtensionLabel(option, source) ||
      (option === "none" ? NONE_COMPRESSION_LABEL : `.${String(option).toLowerCase()}`),
    value: option,
  }));

const APPLY_OUTPUT_FORMAT_NAMES: Record<string, string> = {
  "7z": "7z",
  chd: "CHD disc image",
  rvz: "RVZ disc image",
  zip: "ZIP",
  z3ds: "Z3DS image",
};

const getOutputOptionExtension = (option: OutputOption, source?: GeneratedOutputSource) => {
  const labelExtension = option.label.trim().match(/^\.([^\s()]+)(?:\s|$)/)?.[1];
  if (labelExtension) return labelExtension.toLowerCase();
  return getOutputOptionExtensionLabel(option.value, source).replace(/^\./, "").toLowerCase();
};

const getApplyOutputLabel = (option: OutputOption) => {
  if (option.value === "none") return "Raw ROM";
  if (option.value === "7z") return "Smaller 7z";
  const formatName = APPLY_OUTPUT_FORMAT_NAMES[option.value] || option.label.replace(/^\./, "").toUpperCase();
  return ["chd", "rvz", "z3ds"].includes(option.value) ? formatName : `Small ${formatName}`;
};

const createApplyOutputOptions = (
  compressionOptions: readonly (string | OutputOption)[],
  source?: GeneratedOutputSource,
): OutputOption[] =>
  compressionOptions
    .flatMap((option) => (typeof option === "string" ? createOutputOptions([option], source) : [option]))
    .map((option) => ({
      label: getApplyOutputLabel(option),
      value: option.value,
    }));

const getOutputFormatForFileName = (
  fileName: string | null | undefined,
  options: readonly OutputOption[],
  { rawExtensions = [] }: { rawExtensions?: readonly string[] } = {},
) => {
  const extension = getFileNameExtension(fileName);
  if (!extension) return null;
  const directMatch = options.find((option) => getOutputOptionExtension(option) === extension);
  if (directMatch) return directMatch.value;
  if (rawExtensions.some((rawExtension) => rawExtension.toLowerCase() === extension)) {
    return options.find((option) => option.value === "none")?.value || null;
  }
  return null;
};

const getOutputExtensionWarning = (
  fileName: string | null | undefined,
  options: readonly OutputOption[],
  { rawExtensions = [] }: { rawExtensions?: readonly string[] } = {},
) => {
  const extension = getFileNameExtension(fileName);
  if (!extension || getOutputFormatForFileName(fileName, options, { rawExtensions })) return null;
  return `The extension .${extension} is not a valid output format. Choose a format from the dropdown.`;
};

const getOutputFileNameForFormat = (
  fileName: string,
  format: string,
  options: readonly OutputOption[],
  {
    fallbackExtension = "",
    rawExtensions = [],
    source,
  }: { fallbackExtension?: string; rawExtensions?: readonly string[]; source?: GeneratedOutputSource } = {},
) => {
  const currentExtension = getFileNameExtension(fileName);
  if (!fileName.trim() || (currentExtension && !getOutputFormatForFileName(fileName, options, { rawExtensions })))
    return fileName;
  const nextOption = options.find((option) => option.value === format);
  const nextExtension = nextOption ? getOutputOptionExtension(nextOption, source) || fallbackExtension : "";
  if (!nextExtension) return fileName;
  return currentExtension ? replaceFileNameExtension(fileName, nextExtension) : `${fileName}.${nextExtension}`;
};

const getCreatePatchFormatForFileName = (fileName: string | null | undefined, options: readonly OutputOption[]) => {
  const extension = getFileNameExtension(fileName);
  if (!extension) return null;
  const format = ROM_WEAVER_PATCH_FORMATS.find((candidate) =>
    candidate.extensions.some(
      (candidateExtension) => candidateExtension.replace(/^\./, "").toLowerCase() === extension,
    ),
  );
  const formatName = format ? normalizeCreatePatchFormat(format.name) : "";
  return options.find((option) => option.value === formatName)?.value || null;
};

const getCreatePatchExtensionWarning = (
  fileName: string | null | undefined,
  options: readonly OutputOption[],
  compressionOptions: readonly OutputOption[] = [],
  selectedCompression?: string,
) => {
  const extension = getFileNameExtension(fileName);
  const compressionFormat = getOutputFormatForFileName(fileName, compressionOptions);
  if (
    !extension ||
    getCreatePatchFormatForFileName(fileName, options) ||
    (compressionFormat && (!selectedCompression || compressionFormat === selectedCompression))
  )
    return null;
  return `The extension .${extension} is not a valid patch format. Choose a format from the dropdown.`;
};

/**
 * Compression-type options for the output "Options" panel. The uncompressed
 * choice collapses to a single "None" entry floated to the top, while compressed
 * formats keep their extension labels. The separate output-extension selector
 * still surfaces the real rom/patch extension for the uncompressed choice - only
 * the compression-type dropdown shows "None".
 */
const createCompressionTypeOptions = (
  options: OutputOption[],
  uncompressedValue: string,
  noneLabel: string = NONE_COMPRESSION_LABEL,
): OutputOption[] => {
  if (!options.some((option) => option.value === uncompressedValue)) return options;
  const compressed = options.filter((option) => option.value !== uncompressedValue);
  return [{ label: noneLabel, value: uncompressedValue }, ...compressed];
};

const normalizeExtensionValue = (value: string, fallback: string) =>
  String(value || "")
    .trim()
    .replace(/^\./, "") || fallback;

const createCreateOutputCompressionOptions = (): OutputOption[] => [
  { label: NONE_COMPRESSION_LABEL, value: "none" },
  ...createOutputOptions(CREATE_ARCHIVE_COMPRESSION_FORMATS),
];

const createCreatePatchFormatOptions = (options: CreatePatchFormatOptions = {}): OutputOption[] => {
  const candidateFormats = Array.isArray(options.candidateFormats)
    ? options.candidateFormats
        .map((value) =>
          String(value || "")
            .trim()
            .toLowerCase(),
        )
        .filter((value) => !!value)
    : [];
  const formats = candidateFormats.length
    ? Array.from(new Set(candidateFormats))
    : getCreatePatchFormatsForSizes(options.originalSize, options.modifiedSize);
  return formats.map((value) => ({ label: `.${value}`, value }));
};

const uniqueOutputOptions = (options: OutputOption[]): OutputOption[] => {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
};

const createTrimOutputOptions = (rawExtension: string, { rawLabel }: { rawLabel?: string } = {}): OutputOption[] => {
  const normalizedRawExtension = normalizeExtensionValue(rawExtension, "raw");
  return uniqueOutputOptions([
    { label: rawLabel || `.${normalizedRawExtension}`, value: normalizedRawExtension },
    ...createOutputOptions([...CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS, ...CREATE_ARCHIVE_COMPRESSION_FORMATS]),
  ]);
};

export type { OutputOption };
export {
  createApplyOutputOptions,
  createCompressionTypeOptions,
  createCreateOutputCompressionOptions,
  createCreatePatchFormatOptions,
  createOutputOptions,
  createTrimOutputOptions,
  getCreatePatchExtensionWarning,
  getCreatePatchFormatForFileName,
  getGeneratedOutputName,
  getOutputExtensionWarning,
  getOutputFileNameForFormat,
  getOutputFormatForFileName,
};
