import { getPathBaseName } from "../../lib/path-utils.ts";
import { createBrowserLargeFileVfs } from "../../storage/browser/browser-large-file-vfs.ts";
import type { WorkflowRuntimeLog } from "../../types/workflow-runtime-adapter.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../workers/shared/worker-storage/storage-layout.ts";
import {
  type ExtractedFileEntry,
  emitBrowserWorkflowTrace,
  findExtractedFile,
  joinPath,
  normalizeEntryPath,
} from "./workflow-runtime-helpers.ts";

const BROWSER_VFS_PATH_RETRY_ATTEMPTS = 6;

const browserVfs = createBrowserLargeFileVfs({
  rootPath: WORKER_OPFS_MOUNTPOINT,
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForBrowserVfsPath = async (filePath: string) => {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) return null;
  let stat = await browserVfs.stat(normalizedPath);
  if (stat) return stat;
  for (let attempt = 0; attempt < BROWSER_VFS_PATH_RETRY_ATTEMPTS; attempt += 1) {
    await wait(25 * (attempt + 1));
    stat = await browserVfs.stat(normalizedPath);
    if (stat) return stat;
  }
  return null;
};

const toSizeByteCount = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
};

const withExtractedFileSize = async (entry: ExtractedFileEntry): Promise<ExtractedFileEntry> => {
  const knownSize = toSizeByteCount(entry.sizeBytes);
  if (knownSize !== null) return { ...entry, sizeBytes: knownSize };
  const stat = await waitForBrowserVfsPath(entry.path).catch(() => null);
  const statSize = toSizeByteCount(stat?.size);
  return statSize === null ? entry : { ...entry, sizeBytes: statSize };
};

const selectPreferredExtractedFile = async (input: {
  emittedFiles: ExtractedFileEntry[];
  logLevel?: unknown;
  onLog?: (log: WorkflowRuntimeLog) => void;
  preferredEntryNames: Array<string | null | undefined>;
  traceLabel: string;
}): Promise<ExtractedFileEntry | null> => {
  const preferred: ExtractedFileEntry[] = [];
  const seenPreferredPaths = new Set<string>();
  for (const name of input.preferredEntryNames) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName) continue;
    const matched = findExtractedFile(input.emittedFiles, normalizedName);
    if (!matched) continue;
    const pathKey = normalizeEntryPath(matched.path);
    if (pathKey && seenPreferredPaths.has(pathKey)) continue;
    if (pathKey) seenPreferredPaths.add(pathKey);
    preferred.push(matched);
  }
  const hasPreferred = (entry: ExtractedFileEntry) => seenPreferredPaths.has(normalizeEntryPath(entry.path));
  const nonPreferred = input.emittedFiles.filter((entry) => !hasPreferred(entry));
  const preferredWithSizes = await Promise.all(preferred.map((entry) => withExtractedFileSize(entry)));
  const nonPreferredWithSizes = await Promise.all(nonPreferred.map((entry) => withExtractedFileSize(entry)));
  const firstPreferredNonEmpty = preferredWithSizes.find((entry) => (entry.sizeBytes || 0) > 0) || null;
  const firstAnyNonEmpty =
    firstPreferredNonEmpty || nonPreferredWithSizes.find((entry) => (entry.sizeBytes || 0) > 0) || null;
  const fallback =
    preferredWithSizes[0] ||
    nonPreferredWithSizes[0] ||
    (input.emittedFiles[0] ? await withExtractedFileSize(input.emittedFiles[0]) : null);
  const selected = firstAnyNonEmpty || fallback;
  emitBrowserWorkflowTrace(
    {
      logLevel: input.logLevel,
      onLog: input.onLog,
    },
    `extract selection ${input.traceLabel}`,
    {
      emitted: input.emittedFiles.map((entry) => ({
        fileName: entry.fileName,
        path: entry.path,
        sizeBytes: entry.sizeBytes,
      })),
      preferredCandidates: preferredWithSizes.map((entry) => ({
        fileName: entry.fileName,
        path: entry.path,
        sizeBytes: entry.sizeBytes,
      })),
      selected: selected
        ? {
            fileName: selected.fileName,
            path: selected.path,
            sizeBytes: selected.sizeBytes,
          }
        : null,
    },
  );
  return selected;
};

const filterOutputCandidatesAwayFromSource = (filePaths: string[], sourcePath: string) => {
  const normalizedSourcePath = String(sourcePath || "").trim();
  if (!normalizedSourcePath) return filePaths;
  return filePaths.filter((filePath) => String(filePath || "").trim() !== normalizedSourcePath);
};

const getBrowserExtractOutputPathCandidates = (outDirPath: string, entryName: string): string[] => {
  const normalizedEntryName = normalizeEntryPath(entryName);
  const baseName = getPathBaseName(normalizedEntryName, normalizedEntryName);
  const candidates = [
    normalizedEntryName ? joinPath(outDirPath, normalizedEntryName) : "",
    baseName ? joinPath(outDirPath, baseName) : "",
  ];
  const seen = new Set<string>();
  return candidates
    .map((value) => String(value || "").trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
};

const readTextFromBrowserVfs = async (filePath: string): Promise<string> => {
  const stat = await browserVfs.stat(filePath);
  const size = stat?.size || 0;
  if (!size) return "";
  const bytes = new Uint8Array(size);
  await browserVfs.read(filePath, bytes, {
    bufferOffset: 0,
    fileOffset: 0,
    length: bytes.byteLength,
  });
  return new TextDecoder().decode(bytes);
};

const writeTextToBrowserVfs = async (filePath: string, text: string) => {
  const bytes = new TextEncoder().encode(text);
  await browserVfs.truncate(filePath, 0);
  if (bytes.byteLength > 0) await browserVfs.write(filePath, bytes, { fileOffset: 0 });
};

const sumBrowserVfsPathBytes = async (paths: string[]): Promise<number> => {
  let total = 0;
  for (const filePath of paths) {
    const stat = await browserVfs.stat(filePath).catch(() => null);
    total += toSizeByteCount(stat?.size) ?? 0;
  }
  return total;
};

export {
  browserVfs,
  filterOutputCandidatesAwayFromSource,
  getBrowserExtractOutputPathCandidates,
  readTextFromBrowserVfs,
  selectPreferredExtractedFile,
  sumBrowserVfsPathBytes,
  waitForBrowserVfsPath,
  writeTextToBrowserVfs,
};
