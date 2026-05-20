import type { CoreRomPatchFileLike, OutputFileFactory, ProgressEventLike } from "../../../shared/binary/types.ts";
import {
  getFileExtension,
  getFileNameWithoutExtension,
  type NumericValue,
  type ProgressInput,
  sanitizeFileNamePart,
} from "./patch-engine-progress.ts";

const LEADING_DOT_REGEX = /^\./;
const FILE_EXTENSION_CAPTURE_REGEX = /\.([^./\\\s]+)$/;

type ParsedPatchLike = {
  fileName?: string;
  _generatedPatchName?: string;
  _originalPatchFile?: {
    fileName?: string;
    _generatedPatchName?: string;
  };
};
type ParsedPatchWithSourceLike = ParsedPatchLike & {
  isXdeltaPatch?: boolean;
};
type OpfsManagerLike = {
  outputDirectory?: string;
  cleanup?: (filePaths?: string[]) => Promise<void>;
};
type TraceCallback = (message: string, details?: Record<string, unknown>) => void;
type ApplyPatchOptions = {
  requireValidation: boolean;
  removeHeader: boolean;
  addHeader: boolean;
  fixChecksum: boolean;
  appendOutputSuffix: boolean;
  outputName: string | null;
  outputExtension: string | null;
  outputFileFactory: OutputFileFactory<CoreRomPatchFileLike> | null;
  opfsManager?: OpfsManagerLike | null;
  onProgress?: ((progress: ProgressEventLike) => void) | null;
  onTrace?: TraceCallback | null;
  workerThreads?: string | number | null;
};
type ApplyOptionRecord = {
  requireInputChecksumMatch?: boolean;
  removeHeader?: boolean;
  addHeader?: boolean;
  fixChecksum?: boolean;
  appendOutputSuffix?: boolean;
  outputName?: string | null;
  outputExtension?: string | null;
  outputFileFactory?: OutputFileFactory<CoreRomPatchFileLike> | null;
  opfsManager?: OpfsManagerLike | null;
  onProgress?: ((progress: ProgressEventLike | ProgressInput, total?: NumericValue) => void) | null;
  onTrace?: TraceCallback | null;
  workerThreads?: string | number | null;
};

const getPatchFileName = (patch: ParsedPatchLike, index: number): string => {
  if (patch?._generatedPatchName) return patch._generatedPatchName;
  if (patch?._originalPatchFile?._generatedPatchName) return patch._originalPatchFile._generatedPatchName;
  if (patch?._originalPatchFile?.fileName) return patch._originalPatchFile.fileName;
  if (patch?.fileName) return patch.fileName;
  return `patch ${index + 1}`;
};
const getOutputFileNameFromOptions = (romFileName: string, options: ApplyPatchOptions) => {
  if (options.outputName) return options.outputName;

  if (options.outputName) {
    const extension = options.outputExtension
      ? sanitizeFileNamePart(options.outputExtension, "")
      : getFileExtension(romFileName);
    const outputName = sanitizeFileNamePart(options.outputName, "patched");
    return outputName + (extension ? `.${extension.replace(LEADING_DOT_REGEX, "")}` : "");
  }
  return null;
};
const getPatchedSuffixFileName = (romFileName: string, unpatched: boolean | undefined) => {
  const suffix = unpatched ? " (unpatched)" : " (patched)";
  if (FILE_EXTENSION_CAPTURE_REGEX.test(romFileName))
    return romFileName.replace(FILE_EXTENSION_CAPTURE_REGEX, `${suffix}.$1`);
  return romFileName + suffix;
};
const normalizeApplyPatchOptions = (
  optionsParam: ApplyOptionRecord | null | undefined,
  defaultOutputSuffix: boolean,
): ApplyPatchOptions => {
  const options: ApplyPatchOptions = {
    addHeader: false,
    appendOutputSuffix: !!defaultOutputSuffix,
    fixChecksum: false,
    outputExtension: null,
    outputFileFactory: null,
    outputName: null,
    removeHeader: false,
    requireValidation: false,
  };
  if (typeof optionsParam === "object" && optionsParam) {
    const optionRecord = optionsParam as ApplyOptionRecord;
    if (typeof optionRecord.requireInputChecksumMatch !== "undefined")
      options.requireValidation = !!optionRecord.requireInputChecksumMatch;
    if (typeof optionRecord.removeHeader !== "undefined") options.removeHeader = !!optionRecord.removeHeader;
    if (typeof optionRecord.addHeader !== "undefined") options.addHeader = !!optionRecord.addHeader;
    if (typeof optionRecord.fixChecksum !== "undefined") options.fixChecksum = !!optionRecord.fixChecksum;
    if (typeof optionRecord.appendOutputSuffix !== "undefined")
      options.appendOutputSuffix = !!optionRecord.appendOutputSuffix;
    if (typeof optionRecord.outputName === "string" && optionRecord.outputName.trim())
      options.outputName = optionRecord.outputName.trim();
    if (typeof optionRecord.outputName === "string" && optionRecord.outputName.trim())
      options.outputName = optionRecord.outputName.trim();
    if (typeof optionRecord.outputExtension === "string" && optionRecord.outputExtension.trim())
      options.outputExtension = optionRecord.outputExtension.trim().replace(LEADING_DOT_REGEX, "");
    if (typeof optionRecord.outputFileFactory === "function")
      options.outputFileFactory = optionRecord.outputFileFactory as OutputFileFactory<CoreRomPatchFileLike>;
    if (typeof optionRecord.onTrace === "function") options.onTrace = optionRecord.onTrace;
    if (typeof optionRecord.workerThreads === "number" || typeof optionRecord.workerThreads === "string")
      options.workerThreads = optionRecord.workerThreads;
  }
  return options;
};
const generatePatchedFileName = (romFileName: string, patches: ParsedPatchLike[], options: ApplyPatchOptions) => {
  const explicitOutputFileName = getOutputFileNameFromOptions(romFileName, options);
  if (explicitOutputFileName) return explicitOutputFileName;

  if (options.appendOutputSuffix) return getPatchedSuffixFileName(romFileName, false);

  const romName = sanitizeFileNamePart(getFileNameWithoutExtension(romFileName), "patched");
  const patchNames = patches.reduce<string[]>((acc, patch, index) => {
    const patchName = sanitizeFileNamePart(getFileNameWithoutExtension(getPatchFileName(patch, index)), "");
    if (patchName) acc.push(patchName);
    return acc;
  }, []);

  let outputName = romName;
  if (patchNames.length) outputName += ` - ${patchNames.join(" + ")}`;

  const extension = options.outputExtension
    ? sanitizeFileNamePart(options.outputExtension, "")
    : getFileExtension(romFileName);
  return outputName + (extension ? `.${extension.replace(LEADING_DOT_REGEX, "")}` : "");
};

export type {
  ApplyOptionRecord,
  ApplyPatchOptions,
  CoreRomPatchFileLike,
  OutputFileFactory,
  ParsedPatchLike,
  ParsedPatchWithSourceLike,
};
export {
  generatePatchedFileName,
  getOutputFileNameFromOptions,
  getPatchedSuffixFileName,
  getPatchFileName,
  normalizeApplyPatchOptions,
};
