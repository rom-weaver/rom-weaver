import type { JsonValue, ProgressEvent } from "../../types/runtime.ts";
import {
  type ArchiveEntryInput,
  encodeArchiveEntryText,
  type MaterializedArchiveEntry,
  materializeArchiveEntry,
  normalizeArchiveEntryBytes,
} from "../archive-utils.ts";
import OutputCompressionManagerConstructor from "../compression/output-compression-manager.ts";
import { createTiming, now as defaultNow } from "../progress/timing.ts";

export type ArchiveCompressionSettings = Record<string, JsonValue>;
export type ArchiveProgress = ProgressEvent;
type ArchiveOptions = { format: string; onProgress?: (progress: ArchiveProgress) => void; options: string };
type ArchiveBinaryData = ArrayBuffer | Uint8Array | ArrayBufferView;

type OutputCompressionManagerLike = {
  getArchiveFormat: (compression: string) => string;
  getCompressedFileName: (
    file: { fileName: string },
    compression: string,
    settings: ArchiveCompressionSettings,
  ) => string;
  getArchiveWriterOptions: (compression: string, settings: ArchiveCompressionSettings) => string;
};

export type ArchiveManagerLike = {
  configure?: (options: { threads: number }) => void;
  createArchive: (entries: MaterializedArchiveEntry[], options: ArchiveOptions) => Promise<ArrayBuffer | Uint8Array>;
  toArrayBuffer: (data: ArchiveBinaryData) => ArrayBuffer | Uint8Array | ArrayBufferView;
};

const OutputCompressionManager: OutputCompressionManagerLike = OutputCompressionManagerConstructor;

const materializeArchiveOutputEntry = (entry: ArchiveEntryInput) => materializeArchiveEntry(entry);

const createArchiveOutputData = async ({
  ArchiveManager,
  entries,
  compression,
  compressionSettings,
  onProgress,
  threads,
}: {
  ArchiveManager: ArchiveManagerLike;
  entries?: ArchiveEntryInput[] | null;
  compression: string;
  compressionSettings: ArchiveCompressionSettings;
  onProgress?: (progress: ArchiveProgress) => void;
  threads?: number | string | null;
}): Promise<ArrayBuffer | Uint8Array> => {
  if (typeof ArchiveManager.configure === "function" && threads !== undefined)
    ArchiveManager.configure({ threads: Math.max(1, Number(threads) || 1) });
  const archiveEntries: Array<MaterializedArchiveEntry> = [];
  for (const entry of entries || []) archiveEntries.push(await materializeArchiveOutputEntry(entry || {}));
  if (!archiveEntries.length) throw new Error("Archive entries were not provided");
  return ArchiveManager.createArchive(archiveEntries, {
    format: OutputCompressionManager.getArchiveFormat(compression),
    onProgress,
    options: OutputCompressionManager.getArchiveWriterOptions(compression, {
      ...(compressionSettings || {}),
      ...(threads !== undefined && threads !== null ? { threads } : {}),
    }),
  });
};

const getArchiveOutputFileName = ({
  entries,
  compression,
  compressionSettings,
  outputName,
}: {
  entries?: ArchiveEntryInput[] | null;
  compression: string;
  compressionSettings: ArchiveCompressionSettings;
  outputName?: string;
}) => {
  if (outputName) return outputName;
  const firstEntry = (entries || [])[0] || {};
  return OutputCompressionManager.getCompressedFileName(
    { fileName: firstEntry.fileName || firstEntry.filename || firstEntry.name || "archive.bin" },
    compression,
    compressionSettings || {},
  );
};

const createBrowserArchiveOutputFile = async ({
  ArchiveManager,
  entries,
  outputName,
  compression,
  compressionSettings,
  onProgress,
  threads,
  now,
}: {
  ArchiveManager: ArchiveManagerLike;
  entries?: ArchiveEntryInput[] | null;
  outputName?: string;
  compression: string;
  compressionSettings: ArchiveCompressionSettings;
  onProgress?: (progress: ArchiveProgress) => void;
  threads?: number | string | null;
  now?: () => number;
}) => {
  const getNow = typeof now === "function" ? now : defaultNow;
  const startedAt = getNow();
  const archiveData = await createArchiveOutputData({
    ArchiveManager,
    compression,
    compressionSettings,
    entries,
    onProgress,
    threads,
  });
  const fileName = getArchiveOutputFileName({ compression, compressionSettings, entries, outputName });
  const elapsedMs = getNow() - startedAt;
  const FileConstructor = typeof File === "function" ? File : null;
  const archiveBytes = normalizeArchiveEntryBytes(archiveData);
  return {
    file: FileConstructor
      ? new FileConstructor([archiveBytes as BlobPart], fileName, { type: "application/octet-stream" })
      : null,
    fileName,
    timing: createTiming(elapsedMs),
    u8array: FileConstructor ? null : archiveBytes,
  };
};

export {
  createArchiveOutputData,
  createBrowserArchiveOutputFile,
  encodeArchiveEntryText,
  getArchiveOutputFileName,
  materializeArchiveOutputEntry,
  normalizeArchiveEntryBytes,
};
