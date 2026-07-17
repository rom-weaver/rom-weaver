import { createProgressViewModelFromEvent } from "../../presentation/workflow-presentation.ts";
import { getNamedSourceFileName, getNamedSourceSize } from "../../storage/shared/binary/source-file-utils.ts";
import type { ProgressEvent } from "../../types/workflow-runtime-types.ts";
import type { InputProgress } from "./patcher-ui-state.ts";

type NamedSourceLike = Parameters<typeof getNamedSourceFileName>[0];
type ProgressLike = InputProgress | ProgressEvent;

const isFileSystemFileHandleLike = (source: unknown): source is FileSystemFileHandle =>
  typeof FileSystemFileHandle !== "undefined" && source instanceof FileSystemFileHandle;

const isBlobLike = (
  source: unknown,
): source is Blob & {
  lastModified?: number;
  name?: string;
  type?: string;
} =>
  !!source &&
  typeof source === "object" &&
  typeof (source as Blob).size === "number" &&
  typeof (source as Blob).slice === "function";

const getBinarySourceFileName = (source: NamedSourceLike, fallback: string): string =>
  getNamedSourceFileName(source, { fallback }) || fallback;
const getBinarySourceSize = getNamedSourceSize;

const getBinarySourceStableSignature = (source: NamedSourceLike): string => {
  if (isFileSystemFileHandleLike(source)) return `handle:${source.kind || "file"}:${source.name || ""}`;
  if (isBlobLike(source)) {
    return [
      "blob",
      source.name || "",
      source.type || "",
      typeof source.lastModified === "number" ? source.lastModified : "",
      source.size,
    ].join(":");
  }
  return `source:${getBinarySourceFileName(source, "")}:${getBinarySourceSize(source) || 0}`;
};

const getBinarySourceListStableIds = (sources: NamedSourceLike[]): string[] => {
  const occurrenceBySignature = new Map<string, number>();
  return sources.map((source) => {
    const signature = getBinarySourceStableSignature(source);
    const nextOccurrence = (occurrenceBySignature.get(signature) || 0) + 1;
    occurrenceBySignature.set(signature, nextOccurrence);
    return `${signature}#${nextOccurrence}`;
  });
};

const sameBinarySourceLists = (left: NamedSourceLike[], right: NamedSourceLike[]) => {
  if (left.length !== right.length) return false;
  const leftIds = getBinarySourceListStableIds(left);
  const rightIds = getBinarySourceListStableIds(right);
  return leftIds.every((id, index) => id === rightIds[index]);
};

const toInputProgress = (event: ProgressEvent): InputProgress =>
  createProgressViewModelFromEvent(event, { stage: "input" });

const toApplyButtonProgress = (event: ProgressLike) => createProgressViewModelFromEvent(event, { stage: "apply" });

export {
  getBinarySourceFileName,
  getBinarySourceListStableIds,
  getBinarySourceSize,
  sameBinarySourceLists,
  toApplyButtonProgress,
  toInputProgress,
};
