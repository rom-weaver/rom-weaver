import { classifyPatcherInput } from "../../lib/input/input-classification.ts";
import { buildPatchedOutputBaseName } from "../../lib/output/output-name-composition.ts";
import { formatByteSize, formatPercentFixed } from "../../presentation/workflow-presentation.ts";
import type { ApplySettings } from "../../types/settings.ts";

type OutputOption = {
  value: string;
  label: string;
};

type OutputOptionLabelMap = Record<string, string>;

type SectionSizeSummary = {
  inputCompressedBytes?: number | null;
  inputUncompressedBytes?: number | null;
  patchCompressedBytes?: number | null;
  patchRawBytes?: number | null;
  outputRawBytes?: number | null;
  outputRecompressedBytes?: number | null;
};

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

const EXTENSION_REGEX = /\.([^./\\\s]+)$/;
const FILE_NAME_SEPARATOR_REGEX = /[/\\]+/;

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
    .map((patchSource) =>
      sanitizeFileNamePart(
        getFileNameWithoutExtension(patchSource._generatedPatchName || patchSource.fileName || ""),
        "",
      ),
    )
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
  if (!patchSources.length) return sourceFileName;

  return generatePatchedFileName(
    sourceFileName,
    patchSources.map((patchSource, index) =>
      normalizePatchSourceForGeneratedFileName(patchSource, `patch ${index + 1}`),
    ),
    settings,
  );
};

const createOutputOptions = (compressionOptions: string[], labels: OutputOptionLabelMap = {}): OutputOption[] =>
  compressionOptions.map((option) => ({
    label: labels[option] || (option === "none" ? "None" : option.toUpperCase()),
    value: option,
  }));

const formatLabeledByteSize = (label: string, value?: number | null) => {
  const formattedSize = formatByteSize(value);
  return formattedSize ? `${label}: ${formattedSize}` : "";
};

const formatLabeledSizeRatio = (value?: number | null, baseValue?: number | null) =>
  typeof value === "number" && Number.isFinite(value) && typeof baseValue === "number" && Number.isFinite(baseValue)
    ? `(${formatPercentFixed((value / Math.max(1, baseValue)) * 100, 1)})`
    : "";

const createSectionSizeText = ({
  inputCompressedBytes,
  inputUncompressedBytes,
  patchCompressedBytes,
  patchRawBytes,
  outputRawBytes,
  outputRecompressedBytes,
}: SectionSizeSummary) => ({
  input: [
    formatLabeledByteSize("in", inputCompressedBytes),
    formatLabeledByteSize("raw", inputUncompressedBytes),
    formatLabeledSizeRatio(inputCompressedBytes, inputUncompressedBytes),
  ]
    .filter(Boolean)
    .join(" / "),
  output: [
    formatLabeledByteSize("raw", outputRawBytes),
    formatLabeledByteSize("out", outputRecompressedBytes),
    formatLabeledSizeRatio(outputRecompressedBytes, outputRawBytes),
  ]
    .filter(Boolean)
    .join(" / "),
  patch: [
    formatLabeledByteSize("in", patchCompressedBytes),
    formatLabeledByteSize("patch", patchRawBytes),
    formatLabeledSizeRatio(patchCompressedBytes, patchRawBytes),
  ]
    .filter(Boolean)
    .join(" / "),
});

const combineSectionTimingText = (timingText?: string | null, sizeText?: string | null) =>
  [String(timingText || ""), String(sizeText || "")].filter(Boolean).join(" | ");

export type { OutputOption, OutputOptionLabelMap, SectionSizeSummary };
export { combineSectionTimingText, createOutputOptions, createSectionSizeText, getGeneratedOutputName };
