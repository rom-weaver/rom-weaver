import type { WorkflowProgress, WorkflowProgressRole, WorkflowProgressStage } from "../../types/progress.ts";
import type { SelectionCandidate } from "../../types/selection.ts";
import type { WorkflowWarning } from "../../types/workflow-controller.ts";
import type { PatchFileInstance } from "../../workers/protocol/patch-engine.ts";
import { STANDARD_CHECKSUM_ALGORITHMS } from "../checksum-algorithms.ts";
import { getPatchFileSourceAccess } from "../input/binary-service.ts";
import { getBaseFileName } from "../input/path-utils.ts";

const DEFAULT_CHECKSUMS = STANDARD_CHECKSUM_ALGORITHMS;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !ArrayBuffer.isView(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;

const cloneValue = <TValue>(value: TValue): TValue => {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry)) as TValue;
  if (isPlainObject(value)) {
    const clone: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) clone[key] = cloneValue(child);
    return clone as TValue;
  }
  return value;
};

const getSourceFileName = (source: unknown, fallback: string): string => {
  if (typeof source === "string") return getBaseFileName(source);
  if (!isRecord(source)) return fallback;
  if (typeof source.fileName === "string" && source.fileName.trim()) return getBaseFileName(source.fileName);
  if (typeof source.name === "string" && source.name.trim()) return getBaseFileName(source.name);
  if ("source" in source) return getSourceFileName(source.source, fallback);
  return fallback;
};

const getSourceSize = (source: unknown): number | undefined => {
  if (typeof Blob !== "undefined" && source instanceof Blob) return source.size;
  if (!isRecord(source)) return undefined;
  if (typeof source.size === "number" && Number.isFinite(source.size)) return source.size;
  if ("source" in source) return getSourceSize(source.source);
  return undefined;
};

const cloneCandidate = (candidate: SelectionCandidate): SelectionCandidate => {
  if (candidate.type === "group") {
    return {
      ...candidate,
      candidateIds: [...candidate.candidateIds],
      warnings: [...candidate.warnings],
      ...(candidate.breadcrumbs?.length ? { breadcrumbs: [...candidate.breadcrumbs] } : {}),
    };
  }
  return {
    ...candidate,
    ...(candidate.breadcrumbs?.length ? { breadcrumbs: [...candidate.breadcrumbs] } : {}),
  };
};

const cloneWarning = (warning: WorkflowWarning): WorkflowWarning => ({
  code: warning.code,
  details: warning.details ? cloneValue(warning.details) : undefined,
  message: warning.message,
  role: warning.role,
});

const isRomSpecificDecompressionOutput = (file: PatchFileInstance) =>
  !!(file as { _romSpecificDecompressionOutput?: boolean })._romSpecificDecompressionOutput;

const createChecksumSource = (file: PatchFileInstance, fallbackFileName?: string) => {
  const sourceAccess = getPatchFileSourceAccess(file, fallbackFileName);

  const sourceRef = sourceAccess.getExternalSource({
    // Prefer OPFS/path-backed sources over direct browser Blob sources.
    // This keeps checksum work on file-backed inputs whenever available.
    preferDirectBrowserSource: false,
  });
  if (sourceRef) return sourceRef;

  const preferDirectBrowserSource = !isRomSpecificDecompressionOutput(file);
  if (preferDirectBrowserSource) {
    const blob = sourceAccess.getBlob();
    if (blob) {
      return {
        fileName: sourceAccess.fileName,
        ...(sourceAccess.size === undefined ? {} : { size: sourceAccess.size }),
        source: blob,
      };
    }
  }

  throw new Error(`Checksum source must be filesystem-backed: ${sourceAccess.fileName}`);
};

const getPreparationProgressStage = (
  progress: { label?: string; message?: string },
  role?: WorkflowProgressRole,
): WorkflowProgressStage => {
  const label = String(progress.label || progress.message || "").toLowerCase();
  if (label.includes("checksum")) return role === "input" ? "checksum" : "detect";
  if (label.includes("extract") || label.includes("decompress")) return "decompress";
  return "detect";
};

const createWorkflowId = () => {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `workflow-${random}`;
};

const createWorkflowProgress = (
  sequence: number,
  event: {
    current?: number;
    details?: Record<string, unknown>;
    hasProgress?: boolean;
    id: string;
    indeterminate?: boolean;
    label: string;
    percent?: number | null;
    role: WorkflowProgressRole;
    stage: WorkflowProgressStage;
    total?: number;
    workflow: WorkflowProgress["workflow"];
  },
): WorkflowProgress => {
  const percent = typeof event.percent === "number" && Number.isFinite(event.percent) ? event.percent : null;
  const hasExplicitProgress =
    event.hasProgress !== false &&
    (event.hasProgress === true ||
      event.indeterminate === true ||
      Object.hasOwn(event, "percent") ||
      typeof event.current === "number" ||
      typeof event.total === "number");
  const details = {
    ...event.details,
    role: event.role,
    stage: event.stage,
    workflow: event.workflow,
  };
  return {
    details,
    ...(typeof event.current === "number" ? { current: event.current } : {}),
    hasProgress: hasExplicitProgress,
    id: event.id,
    indeterminate: hasExplicitProgress && percent === null,
    label: event.label,
    percent,
    role: event.role,
    sequence,
    stage: event.stage,
    ...(typeof event.total === "number" ? { total: event.total } : {}),
    workflow: event.workflow,
  };
};

export {
  cloneCandidate,
  cloneValue,
  cloneWarning,
  createChecksumSource,
  createWorkflowId,
  createWorkflowProgress,
  DEFAULT_CHECKSUMS,
  getPreparationProgressStage,
  getSourceFileName,
  getSourceSize,
  isRecord,
};
