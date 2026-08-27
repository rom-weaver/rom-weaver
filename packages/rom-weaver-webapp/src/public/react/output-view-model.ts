import {
  CREATE_ARCHIVE_COMPRESSION_FORMATS,
  CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS,
} from "../../lib/compression/container-format-registry.ts";
import OutputCompressionManager from "../../lib/compression/output-compression-manager.ts";
import { getCreatePatchFormatsForSizes } from "../../lib/create/patch-format-limits.ts";
import { classifyPatcherInput } from "../../lib/input/input-classification.ts";
import { buildPatchedOutputBaseName } from "../../lib/output/output-name-composition.ts";
import type { ApplySettings } from "../../types/settings.ts";

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
  identifiedBase?: string | null,
) => {
  if (settings.outputName) return settings.outputName;
  const baseName = identifiedBase || getFileNameWithoutExtension(romFileName);
  if (settings.suffix) {
    const romName = sanitizeFileNamePart(baseName, "patched");
    return `${romName} (patched)`;
  }

  const romName = sanitizeFileNamePart(baseName, "patched");
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
  identifiedBase?: string | null,
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
    identifiedBase,
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

const createApplyOutputOptions = createOutputOptions;

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
  getGeneratedOutputName,
};
