import type {
  ArchiveEntry,
  ArchiveExtractionResult,
  BrowserFileLike,
  ProgressCallback,
  ProgressEvent,
} from "../../types/runtime.ts";
import { createArchiveSourceBlob, normalizeArchiveEntryBytes, resolveArchiveEntryFileName } from "../archive-utils.ts";

const FILE_NAME_SEPARATOR_REGEX = /[/\\]+/;
const EXTENSION_REGEX = /\.[^/.\\]+$/;

const getBaseFileName = (fileName?: string | null) => {
  const normalized = String(fileName || "").trim();
  if (!normalized) return "";
  return normalized.split(FILE_NAME_SEPARATOR_REGEX).pop() || "";
};

const getFileNameWithoutExtension = (fileName?: string | null) =>
  getBaseFileName(fileName).replace(EXTENSION_REGEX, "");

type ArchiveFileSource = BrowserFileLike | FileSystemFileHandle | string;
type ArchiveExtractedBytes = ArrayBufferLike | Uint8Array | ArrayBufferView;

type ArchiveManagerLike = {
  listEntriesFromFile: (file: ArchiveFileSource) => Promise<ArchiveEntry[]>;
  extractEntryFromFile: (
    file: ArchiveFileSource,
    entryName: string,
    options?: { onProgress?: ProgressCallback },
  ) => Promise<ArchiveExtractedBytes>;
  extractEntryToFile: (
    file: ArchiveFileSource,
    entryName: string,
    options?: { onProgress?: ProgressCallback },
  ) => Promise<ArchiveExtractionResult>;
  toArrayBuffer: (data: ArchiveExtractedBytes | Blob) => ArrayBuffer | Uint8Array | ArrayBufferView;
};
type ArchiveListManagerLike = Pick<ArchiveManagerLike, "listEntriesFromFile">;
type ArchiveExtractToFileManagerLike = Pick<ArchiveManagerLike, "extractEntryToFile">;

type ExtractSelectedArchiveFileEntriesInput = {
  ArchiveManager: ArchiveManagerLike;
  file: ArchiveFileSource;
  entryNames: string[];
  onEntryProgress?: (event: { event: ProgressEvent; index: number; total: number; entryName: string }) => void;
};

const listArchiveFileEntries = async ({
  ArchiveManager,
  file,
}: {
  ArchiveManager: ArchiveListManagerLike;
  file: ArchiveFileSource;
}) => ArchiveManager.listEntriesFromFile(file);

const listArchiveBufferEntries = async ({
  ArchiveManager,
  buffer,
  archiveFileName,
}: {
  ArchiveManager: ArchiveListManagerLike;
  buffer: ArrayBufferLike | null;
  archiveFileName?: string | null;
}) => ArchiveManager.listEntriesFromFile(createArchiveSourceBlob(buffer || new ArrayBuffer(0), archiveFileName));

const listArchiveFileDataEntries = async ({
  ArchiveManager,
  file,
}: {
  ArchiveManager: ArchiveManagerLike;
  file: ArchiveFileSource;
}) => {
  const entries = await listArchiveFileEntries({ ArchiveManager, file });
  return entries.filter((entry) => entry.fileType === "File");
};

const extractArchiveFileEntry = async ({
  ArchiveManager,
  file,
  entryName,
  onProgress,
}: {
  ArchiveManager: ArchiveManagerLike;
  file: ArchiveFileSource;
  entryName: string;
  onProgress?: ProgressCallback;
}) => {
  const data = await ArchiveManager.extractEntryFromFile(file, entryName, { onProgress });
  return {
    data: normalizeArchiveEntryBytes(ArchiveManager.toArrayBuffer(data)),
    filename: resolveArchiveEntryFileName({ fileName: entryName }),
  };
};

const extractArchiveFileEntryToFile = async ({
  ArchiveManager,
  file,
  entryName,
  onProgress,
}: {
  ArchiveManager: ArchiveExtractToFileManagerLike;
  file: ArchiveFileSource;
  entryName: string;
  onProgress?: ProgressCallback;
}) => ArchiveManager.extractEntryToFile(file, entryName, { onProgress });

const extractArchiveBufferEntry = async ({
  ArchiveManager,
  buffer,
  entryName,
  onProgress,
  archiveFileName,
}: {
  ArchiveManager: ArchiveManagerLike;
  buffer: ArrayBufferLike | null;
  entryName: string;
  onProgress?: ProgressCallback;
  archiveFileName?: string | null;
}): Promise<Uint8Array> =>
  ArchiveManager.extractEntryFromFile(
    createArchiveSourceBlob(buffer || new ArrayBuffer(0), archiveFileName),
    entryName,
    { onProgress },
  ).then((data) => normalizeArchiveEntryBytes(data));

const extractSelectedArchiveFileEntries = async ({
  ArchiveManager,
  file,
  entryNames,
  onEntryProgress,
}: ExtractSelectedArchiveFileEntriesInput) => {
  const extractedEntries: Array<{ filename: string; data: Uint8Array }> = [];
  for (let index = 0; index < entryNames.length; index++) {
    const entryName = entryNames[index];
    if (!entryName) continue;
    extractedEntries.push(
      await extractArchiveFileEntry({
        ArchiveManager,
        entryName,
        file,
        onProgress: (event) => onEntryProgress?.({ entryName, event, index, total: entryNames.length }),
      }),
    );
  }
  return extractedEntries;
};

const getSingleExtractedEntryDownloadName = (entryName?: string, archiveFileName?: string) =>
  getBaseFileName(entryName) || `${getFileNameWithoutExtension(archiveFileName || "extracted")}.bin`;

export {
  extractArchiveBufferEntry,
  extractArchiveFileEntryToFile,
  extractSelectedArchiveFileEntries,
  getSingleExtractedEntryDownloadName,
  listArchiveBufferEntries,
  listArchiveFileDataEntries,
  listArchiveFileEntries,
};
