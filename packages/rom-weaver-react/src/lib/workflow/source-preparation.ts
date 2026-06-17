// Input-source classification/preparation helpers shared by the create and trim
// workflows, which previously carried byte-identical copies (the only prior
// difference was the options/result type parameter).

import type { DirectSource, SourceRef } from "../../types/source.ts";
import type { CreateWorkflowDeps, PatchFileInstance } from "../../types/workflow-internal.ts";
import { isArchiveFile } from "../../workers/protocol/archive-shared-utils.ts";
import {
  createRomSpecificExtensionRegex,
  ROM_SPECIFIC_DECOMPRESSION_INPUT_EXTENSIONS,
} from "../compression/rom-specific-format-support.ts";
import { classifyPatcherInput, getInputSourceFileName } from "../input/input-classification.ts";

const ROM_SPECIFIC_INPUT_EXTENSION_REGEX = createRomSpecificExtensionRegex(ROM_SPECIFIC_DECOMPRESSION_INPUT_EXTENSIONS);
const FILE_QUERY_OR_HASH_REGEX = /[?#].*$/;

type SourcePrepDeps = Pick<CreateWorkflowDeps, "getNamedSource" | "getNamedSourceFileName">;
type WorkflowSourceInput = PatchFileInstance | SourceRef;
type ContainerInputOptions = { input?: { containerInputsEnabled?: boolean } } | undefined;

const createClassificationSource = (source: SourceRef, deps: SourcePrepDeps) => {
  const directSource = deps.getNamedSource(source) as DirectSource;
  const fileName = deps.getNamedSourceFileName(source);
  if (!fileName || directSource === source) return source;
  if (typeof Blob !== "undefined" && directSource instanceof Blob) return { _file: directSource, fileName };
  if (directSource && typeof directSource === "object") return { ...directSource, fileName };
  return directSource;
};

/** Whether a workflow source must be prepared (archive/container extraction) before use. */
export const shouldPrepareWorkflowSource = (
  source: SourceRef,
  options: ContainerInputOptions,
  selectedArchiveEntry: string | undefined,
  deps: SourcePrepDeps,
) => {
  if (selectedArchiveEntry) return true;
  const directSource = deps.getNamedSource(source) as DirectSource;
  if (typeof directSource === "string") {
    if (isArchiveFile(directSource)) return options?.input?.containerInputsEnabled !== false;
    if (ROM_SPECIFIC_INPUT_EXTENSION_REGEX.test(directSource)) return options?.input?.containerInputsEnabled !== false;
    return false;
  }
  const classification = classifyPatcherInput(createClassificationSource(source, deps));
  return classification.kind === "compression" ? options?.input?.containerInputsEnabled !== false : false;
};

/** Resolve a display/output file name for a workflow source, falling back to `fallback`. */
export const getWorkflowSourceFileName = (source: WorkflowSourceInput, fallback: string, deps: SourcePrepDeps) => {
  const namedFileName = deps.getNamedSourceFileName(source as SourceRef, { fallback: "" });
  if (namedFileName) return namedFileName;
  const directSource = deps.getNamedSource(source as SourceRef);
  if (typeof directSource === "string" && directSource.trim()) {
    const normalized = directSource.replace(/\\/g, "/").replace(FILE_QUERY_OR_HASH_REGEX, "");
    const slashIndex = normalized.lastIndexOf("/");
    return normalized.slice(slashIndex + 1) || fallback;
  }
  return getInputSourceFileName(source) || fallback;
};

/** Round an output's `timing.elapsedMs` to whole ms, or `undefined` when absent/invalid. */
export const roundElapsedMs = (timing: { elapsedMs?: unknown } | null | undefined): number | undefined => {
  const elapsedMs = timing?.elapsedMs;
  return typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs >= 0
    ? Math.round(elapsedMs)
    : undefined;
};
