import { STANDARD_CHECKSUM_ALGORITHMS } from "../../lib/checksum-algorithms.ts";
import { normalizeRomSpecificExtractedFileName } from "../../lib/compression/container-format-registry.ts";
import {
  getFileNameWithoutExtension,
  getPathBaseName,
  isCompressionLevelProfile,
  joinPath,
} from "../../lib/path-utils.ts";
import type { WorkflowRuntimeLog } from "../../types/workflow-runtime-adapter.ts";

const FILE_CAPTURE_REGEX = /^(.+[/\\])?([^/\\]+)$/;
const EXTRACT_CHECKSUM_ALGORITHMS = STANDARD_CHECKSUM_ALGORITHMS;

const getFileStem = (fileName: string) => getFileNameWithoutExtension(fileName);

const getPathDirectory = (filePath: string): string => {
  const match = String(filePath || "").match(FILE_CAPTURE_REGEX);
  return match?.[1] || "";
};

const uniqueNonEmptyStrings = (values: string[]): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!(normalized && !seen.has(normalized))) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

const getPathDerivedFileName = (filePath: string, fallback: string): string => getPathBaseName(filePath, fallback);

const toNumericLevel = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
};

const toLevelProfile = (value: unknown): string | null => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  return isCompressionLevelProfile(normalized) ? normalized : null;
};

const withCodecLevel = (codec: unknown, level: unknown): string[] => {
  const codecName = String(codec || "").trim();
  if (!codecName) return [];
  const numericLevel = toNumericLevel(level);
  if (numericLevel === null || codecName.includes(":")) return [codecName];
  return [`${codecName}:${numericLevel}`];
};

const normalizeEntryPath = (value: string) =>
  String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

type ListedOutputEntry = { fileName?: string; filename?: string; name?: string };

const getListedOutputEntryName = (entry: ListedOutputEntry | null | undefined): string =>
  String(entry?.fileName || entry?.filename || entry?.name || "").trim();

const isCueEntryName = (entryName: string): boolean => /\.cue$/i.test(getPathBaseName(entryName, entryName));

const normalizeRomSpecificListEntries = <TEntry extends ListedOutputEntry>(
  entries: TEntry[],
  stagedFileName: string,
  sourceFileName: string,
): TEntry[] => {
  const stagedBaseName = getPathBaseName(stagedFileName, stagedFileName);
  const sourceBaseName = getPathBaseName(sourceFileName, sourceFileName);
  const stagedStem = getFileStem(stagedBaseName);
  const sourceStem = getFileStem(sourceBaseName);
  if (!(stagedStem && sourceStem)) return entries;
  return entries.map((entry) => {
    const entryName = getListedOutputEntryName(entry);
    if (!entryName) return entry;
    const normalizedEntryName = normalizeEntryPath(entryName);
    const pathParts = normalizedEntryName.split("/");
    const leafName = pathParts.pop() || normalizedEntryName;
    let normalizedLeafName = leafName;
    if (leafName === stagedBaseName) normalizedLeafName = sourceBaseName;
    else if (leafName === stagedStem) normalizedLeafName = sourceStem;
    else if (leafName.startsWith(`${stagedStem}.`) || leafName.startsWith(`${stagedStem} (Track `))
      // `.`-suffixed (`<stem>.cue`, `<stem>.track02.bin`) and redump-style `<stem> (Track N).bin`
      // outputs both rebase onto the logical source stem.
      normalizedLeafName = `${sourceStem}${leafName.slice(stagedStem.length)}`;
    else {
      const sourceStemWithExtension = `${sourceStem}.`;
      const sourceStemIndex = leafName.indexOf(sourceStemWithExtension);
      if (sourceStemIndex > 0) normalizedLeafName = leafName.slice(sourceStemIndex);
      else if (sourceStemIndex === -1) {
        const sourceStemSuffix = `-${sourceStem}`;
        const sourceStemSuffixIndex = leafName.lastIndexOf(sourceStemSuffix);
        if (sourceStemSuffixIndex > 0 && sourceStemSuffixIndex + sourceStemSuffix.length === leafName.length)
          normalizedLeafName = sourceStem;
      }
    }
    if (normalizedLeafName === leafName) return entry;
    const normalizedName = pathParts.length ? `${pathParts.join("/")}/${normalizedLeafName}` : normalizedLeafName;
    return {
      ...entry,
      fileName: normalizedName,
      filename: normalizedName,
      name: getPathBaseName(normalizedName, normalizedName),
    };
  });
};

const normalizeRomSpecificEntryNameForSource = (
  entryName: string,
  stagedFileName: string,
  sourceFileName: string,
): string => {
  const normalized = normalizeRomSpecificListEntries(
    [{ fileName: entryName, filename: entryName, name: entryName }],
    stagedFileName,
    sourceFileName,
  )[0];
  return String(normalized?.fileName || entryName || "");
};

const replaceProgressSourceLabel = <TProgress extends { label?: string; message?: string }>(
  progress: TProgress,
  sourcePath: string,
  displayFileName: string,
): TProgress => {
  const displayName = getPathBaseName(displayFileName, displayFileName);
  if (!displayName) return progress;
  const sourceName = getPathBaseName(sourcePath, sourcePath);
  const replaceSource = (value: string | undefined) => {
    const normalized = String(value || "");
    if (!normalized) return value;
    let next = normalized;
    if (sourcePath) next = next.replaceAll(sourcePath, displayName);
    if (sourceName && sourceName !== displayName) next = next.replaceAll(sourceName, displayName);
    return next === normalized ? value : next;
  };
  const label = replaceSource(progress.label);
  const message = replaceSource(progress.message);
  return label === progress.label && message === progress.message ? progress : { ...progress, label, message };
};

type ExtractedFileEntry = {
  checksums?: Record<string, string>;
  discFormat?: string;
  extractTimeMs?: number;
  fileName: string;
  kind?: string;
  path: string;
  platform?: string;
  sizeBytes?: number;
};

const findExtractedFile = (emittedFiles: ExtractedFileEntry[], entryName: string) => {
  const normalizedEntry = normalizeEntryPath(entryName);
  const normalizedBase = getPathBaseName(normalizedEntry, normalizedEntry);
  for (const emitted of emittedFiles) {
    const emittedName = normalizeEntryPath(emitted.fileName);
    const emittedPath = normalizeEntryPath(emitted.path);
    const emittedPathBase = getPathBaseName(emittedPath, emittedPath);
    if (emittedName === normalizedEntry) return emitted;
    if (getPathBaseName(emittedName, emittedName) === normalizedBase) return emitted;
    if (emittedPathBase === normalizedBase) return emitted;
    if (normalizedEntry.endsWith(`/${emittedName}`)) return emitted;
    if (normalizedEntry.endsWith(`/${emittedPath}`)) return emitted;
  }
  return null;
};

const isTraceLogLevel = (value: unknown) =>
  String(value || "")
    .trim()
    .toLowerCase() === "trace";

const emitBrowserWorkflowTrace = (
  input: { logLevel?: unknown; onLog?: (log: WorkflowRuntimeLog) => void },
  message: string,
  details?: Record<string, unknown>,
) => {
  if (!isTraceLogLevel(input.logLevel)) return;
  input.onLog?.({
    details: details || {},
    level: "trace",
    message,
    namespace: "runtime:browser-workflow",
    timestamp: new Date().toISOString(),
  });
};

export type { ExtractedFileEntry };
export {
  EXTRACT_CHECKSUM_ALGORITHMS,
  emitBrowserWorkflowTrace,
  findExtractedFile,
  getFileStem,
  getPathDerivedFileName,
  getPathDirectory,
  isCueEntryName,
  joinPath,
  normalizeEntryPath,
  normalizeRomSpecificEntryNameForSource,
  replaceProgressSourceLabel,
  toLevelProfile,
  uniqueNonEmptyStrings,
  withCodecLevel,
};
