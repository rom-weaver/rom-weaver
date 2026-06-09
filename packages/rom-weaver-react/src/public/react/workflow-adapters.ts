import { useEffect, useRef } from "react";
import { resolveAutomaticSelection } from "../../lib/input/selection.ts";
import { ApplyWorkflow, type CandidateSelectionRequest, CreateWorkflow } from "../../platform/browser/browser-api.ts";
import { clampProgressPercent, normalizeProgressDisplayPercent } from "../../presentation/workflow-presentation.ts";
import type { ApplyWorkflowInputState, ApplyWorkflowPatchState } from "../../types/apply-workflow.ts";
import type { CreateWorkflowSourceState } from "../../types/create-workflow.ts";
import type { ProgressEvent } from "../../types/workflow-runtime.ts";
import type { BinarySource } from "./patcher-form.ts";

const CREATE_OUTPUT_EXTENSION_REGEX = /\.[^.]*$/;
type SelectionRole = CandidateSelectionRequest["role"];

const useApplyWorkflow = (options: ConstructorParameters<typeof ApplyWorkflow>[0] = {}): ApplyWorkflow => {
  const workflowRef = useRef<ApplyWorkflow | null>(null);
  if (!workflowRef.current) workflowRef.current = new ApplyWorkflow(options);
  useEffect(
    () => () => {
      void workflowRef.current?.dispose();
      workflowRef.current = null;
    },
    [],
  );
  return workflowRef.current as ApplyWorkflow;
};

const useCreateWorkflow = (options: ConstructorParameters<typeof CreateWorkflow>[0] = {}): CreateWorkflow => {
  const workflowRef = useRef<CreateWorkflow | null>(null);
  if (!workflowRef.current) workflowRef.current = new CreateWorkflow(options);
  useEffect(
    () => () => {
      void workflowRef.current?.dispose();
      workflowRef.current = null;
    },
    [],
  );
  return workflowRef.current as CreateWorkflow;
};

const toBrowserPublicBinarySource = (source: BinarySource) => source;

const getReactBinarySourceFileName = (source: BinarySource | null | undefined, fallback: string) => {
  if (!source) return "";
  if (source instanceof File && source.name) return source.name;
  if ("name" in source && typeof source.name === "string" && source.name) return source.name;
  return fallback;
};

const getDefaultCreateOutputName = (original: BinarySource | null | undefined) => {
  const originalName = getReactBinarySourceFileName(original, "");
  return originalName.replace(CREATE_OUTPUT_EXTENSION_REGEX, "");
};

const getReactProgressStage = (event: { role?: string; stage?: string }): ProgressEvent["stage"] => {
  if (event.role === "output" || event.stage === "compress") return "output";
  if (event.stage === "apply" || event.stage === "create") return "apply";
  return "input";
};

const toReactProgressEvent = (event: {
  details?: Record<string, unknown>;
  hasProgress?: boolean;
  id?: string;
  indeterminate?: boolean;
  label: string;
  percent?: number | null;
  role?: string;
  stage?: string;
  workflow?: string;
}): ProgressEvent => {
  const percent = normalizeProgressDisplayPercent(event.percent);
  const visualPercent = clampProgressPercent(event.percent);
  const hasProgress =
    event.hasProgress === false
      ? false
      : event.hasProgress === true || event.indeterminate === true || "percent" in event;
  return {
    details: {
      ...(event.details || {}),
      id: event.id,
      role: event.role,
      stage: event.stage,
      ...(visualPercent === null ? {} : { visualPercent }),
      workflow: event.workflow,
    },
    ...(event.hasProgress === false ? { hasProgress: false } : {}),
    ...(event.indeterminate === true ? { indeterminate: true } : {}),
    label: event.label,
    message: typeof percent === "number" ? `${event.label} ${percent}%` : event.label,
    ...(hasProgress ? { percent } : {}),
    stage: getReactProgressStage(event),
  };
};

const getWorkflowSourceRole = (
  source: CreateWorkflowSourceState | ApplyWorkflowInputState | ApplyWorkflowPatchState | undefined,
): SelectionRole | undefined => {
  if (!(source && "role" in source) || typeof source.role !== "string") return undefined;
  if (source.role === "input" || source.role === "patch" || source.role === "original" || source.role === "modified") {
    return source.role;
  }
  return undefined;
};

const getWorkflowArchiveName = (
  source: CreateWorkflowSourceState | ApplyWorkflowInputState | ApplyWorkflowPatchState | undefined,
  originalName: string,
) => {
  if (source && "parentCompressions" in source) {
    const archivePath = [...(source.parentCompressions || [])]
      .sort((left, right) => left.depth - right.depth)
      .map((entry) => entry.fileName)
      .filter((fileName): fileName is string => !!fileName)
      .join(" > ");
    if (archivePath) return archivePath;
  }
  const fileName = source?.fileName || originalName;
  return originalName && fileName && originalName !== fileName ? originalName : "-";
};

const getSelectedResolvedInput = (source: ApplyWorkflowInputState | undefined | null) => {
  const resolvedInputs = source?.resolvedInputs || [];
  return resolvedInputs.find((entry) => entry.selected) || resolvedInputs[0] || null;
};

const getResolvedInputArchiveName = (
  resolved: NonNullable<ReturnType<typeof getSelectedResolvedInput>>,
  originalName: string,
) => {
  const archivePath = [...(resolved.parentCompressions || [])]
    .sort((left, right) => left.depth - right.depth)
    .map((entry) => entry.fileName)
    .filter((fileName): fileName is string => !!fileName)
    .join(" > ");
  if (archivePath) return archivePath;
  return originalName && resolved.fileName && originalName !== resolved.fileName ? originalName : "-";
};

const toStagedInputInfo = (
  source: CreateWorkflowSourceState | ApplyWorkflowInputState | undefined | null,
  originalName: string,
  checksums?: Record<string, string> | null,
) => {
  if (!source) return null;
  const resolved = "resolvedInputs" in source ? getSelectedResolvedInput(source) : null;
  const fileName = resolved?.fileName || source.fileName || originalName;
  return {
    archiveName: resolved
      ? getResolvedInputArchiveName(resolved, originalName)
      : getWorkflowArchiveName(source, originalName),
    chdMode: resolved?.chdMode || ("chdMode" in source ? source.chdMode : undefined),
    checksums: checksums || resolved?.checksums || ("checksums" in source ? source.checksums : undefined),
    decompressionTimeMs: resolved?.decompressionTimeMs ?? source.decompressionTimeMs,
    fileName,
    parentCompressions:
      resolved?.parentCompressions || ("parentCompressions" in source ? source.parentCompressions : undefined),
    size: resolved?.size ?? source.size,
    sourceSize: resolved?.sourceSize ?? source.sourceSize,
    wasDecompressed: resolved?.wasDecompressed ?? source.wasDecompressed,
  };
};

const createWorkflowFormError = (code: string, message: string) => {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
};

const chooseWorkflowSource = async (
  source: CreateWorkflowSourceState | ApplyWorkflowInputState | ApplyWorkflowPatchState | undefined,
  selectFile: (request: CandidateSelectionRequest) => Promise<{ id: string }>,
  role: SelectionRole = getWorkflowSourceRole(source) || "input",
) => {
  if (!source || source.selectedCandidateId || source.status !== "needsSelection") return undefined;
  const request = {
    candidates: source.candidates,
    role,
    sourceName: source.fileName || source.id,
    warnings: source.warnings.map((warning) => warning.message),
  } satisfies CandidateSelectionRequest;
  const automaticSelection = resolveAutomaticSelection(request);
  if (automaticSelection) return automaticSelection;
  return selectFile(request);
};

export {
  chooseWorkflowSource,
  createWorkflowFormError,
  getDefaultCreateOutputName,
  getReactBinarySourceFileName,
  toBrowserPublicBinarySource,
  toReactProgressEvent,
  toStagedInputInfo,
  useApplyWorkflow,
  useCreateWorkflow,
};
