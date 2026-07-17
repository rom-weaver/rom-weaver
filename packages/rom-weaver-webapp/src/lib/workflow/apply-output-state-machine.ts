import type { ApplyWorkflowInputState } from "../../types/apply-workflow.ts";
import type { ApplySettings, CompressionFormat } from "../../types/settings.ts";
import {
  getCompressionOutputExtension,
  isCompressionFormat,
  resolveAutomaticCompressionFormat,
} from "../compression/container-format-registry.ts";
import { appendFileNameExtension, getFileNameWithoutExtension, stripFileNameQuery } from "../input/path-utils.ts";
import { buildPatchedOutputBaseName } from "../output/output-name-composition.ts";
import { getFileNameExtension } from "../path-utils.ts";
import type { InputSession } from "./apply-workflow-state.ts";
import { getSourceFileName, getSourceSize } from "./controller-utils.ts";

type ApplyOutputState = {
  manualOutputFormat: boolean;
  manualOutputName: boolean;
  outputFormat: CompressionFormat;
  outputName: string;
};

const getCompressionExtension = (
  format: CompressionFormat,
  inputFileName: string | undefined,
  settings: Partial<ApplySettings>,
): string => getCompressionOutputExtension(format, { inputFileName, settings });

const resolveAutomaticFormat = (
  input: InputSession<unknown> | undefined,
  _settings: Partial<ApplySettings>,
): CompressionFormat => {
  const sourceName = input?.sources[0] ? getSourceFileName(input.sources[0], "input") : "";
  return resolveAutomaticCompressionFormat({
    parentCompressions: input?.view?.parentCompressions,
    sourceFileName: stripFileNameQuery(sourceName),
    sourceSize: getSourceSize(input?.sources[0]),
  });
};

const createApplyOutputState = (
  settings: Partial<ApplySettings>,
  inputSession?: InputSession<unknown>,
): ApplyOutputState => {
  const state: ApplyOutputState = {
    manualOutputFormat: false,
    manualOutputName: false,
    outputFormat: "7z",
    outputName: "",
  };
  applyOutputSettings(state, settings, inputSession);
  return state;
};

const applyOutputSettings = (
  state: ApplyOutputState,
  settings: Partial<ApplySettings>,
  inputSession?: InputSession<unknown>,
): void => {
  const output = settings.output || {};
  const initialCompression = output.compression;
  state.manualOutputFormat = !!(
    initialCompression &&
    initialCompression !== "auto" &&
    isCompressionFormat(initialCompression)
  );
  state.outputFormat = state.manualOutputFormat
    ? (initialCompression as CompressionFormat)
    : resolveAutomaticFormat(inputSession, settings);
  state.manualOutputName = typeof output.outputName === "string" && !!output.outputName.trim();
  state.outputName = state.manualOutputName ? output.outputName || "" : "";
};

const setApplyOutputName = (
  state: ApplyOutputState,
  settings: Partial<ApplySettings>,
  name: string,
  recompute: () => void,
): void => {
  const normalizedName = name.trim();
  state.manualOutputName = !!normalizedName;
  if (state.manualOutputName) {
    state.outputName = name;
    settings.output = {
      ...settings.output,
      outputName: name,
    };
    return;
  }
  if (settings.output) delete settings.output.outputName;
  recompute();
};

const setApplyOutputFormat = (
  state: ApplyOutputState,
  settings: Partial<ApplySettings>,
  format: CompressionFormat,
): void => {
  state.manualOutputFormat = true;
  state.outputFormat = format;
  settings.output = {
    ...settings.output,
    compression: format,
  };
};

const recomputeApplyOutputState = (
  state: ApplyOutputState,
  settings: Partial<ApplySettings>,
  {
    input,
    inputSession,
    patchOutputNames,
  }: {
    input: ApplyWorkflowInputState | null;
    inputSession?: InputSession<unknown>;
    patchOutputNames: string[];
  },
): void => {
  if (!state.manualOutputFormat) state.outputFormat = resolveAutomaticFormat(inputSession, settings);
  if (!state.manualOutputName) state.outputName = buildAutomaticOutputName(state, input, patchOutputNames);
};

// A multi-track disc's "primary" resolved file is a track (e.g. `track01.bin`), a poor output name.
// Prefer the disc's own name: the source archive (depth 0 of the archive chain) for an archived
// disc, otherwise the `.cue`/`.gdi` sheet for a loose disc.
const getDiscOutputFileName = (input: ApplyWorkflowInputState): string | undefined => {
  const resolved = input.resolvedInputs;
  if (!resolved?.length) return undefined;
  const isDisc = resolved.some((entry) => entry.kind === "track" || entry.kind === "cue" || entry.kind === "gdi");
  if (!isDisc) return undefined;
  return (
    input.parentCompressions[0]?.fileName ||
    resolved.find((entry) => entry.kind === "cue" || entry.kind === "gdi")?.fileName ||
    undefined
  );
};

const buildAutomaticOutputName = (
  state: ApplyOutputState,
  input: ApplyWorkflowInputState | null,
  patchOutputNames: string[],
): string => {
  if (!input?.fileName) return state.outputName;
  const inputBase = getFileNameWithoutExtension(getDiscOutputFileName(input) || input.fileName) || "patched";
  const patchNames = patchOutputNames.map((fileName) => getFileNameWithoutExtension(fileName)).filter(Boolean);
  return buildPatchedOutputBaseName(inputBase, patchNames);
};

const getApplyExecutionOutputName = (
  state: ApplyOutputState,
  settings: Partial<ApplySettings>,
  inputFileName: string | undefined,
): string => {
  const outputName = state.outputName || settings.output?.outputName || "";
  if (state.manualOutputName || !outputName) return outputName;
  if (state.outputFormat === "none") {
    const extension = getCompressionExtension(state.outputFormat, inputFileName, settings);
    return extension ? appendFileNameExtension(outputName, extension) : outputName;
  }
  const outputExtension = getFileNameExtension(stripFileNameQuery(outputName));
  const compressionExtension = getCompressionExtension(state.outputFormat, inputFileName, settings).toLowerCase();
  if (outputExtension && compressionExtension && outputExtension === compressionExtension) {
    return getFileNameWithoutExtension(outputName) || outputName;
  }
  return outputName;
};

export type { ApplyOutputState };
export {
  applyOutputSettings,
  createApplyOutputState,
  getApplyExecutionOutputName,
  recomputeApplyOutputState,
  setApplyOutputFormat,
  setApplyOutputName,
};
