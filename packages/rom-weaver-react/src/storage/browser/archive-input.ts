import type { ArchiveEntry, ArchiveExtractionResult, BrowserFileLike, ProgressCallback } from "../../types/runtime.ts";

type ArchiveFileSource = BrowserFileLike | FileSystemFileHandle | string;

type ArchiveListManagerLike = {
  listEntriesFromFile: (file: ArchiveFileSource) => Promise<ArchiveEntry[]>;
};

type ArchiveExtractToFileManagerLike = {
  extractEntryToFile: (
    file: ArchiveFileSource,
    entryName: string,
    options?: { onProgress?: ProgressCallback },
  ) => Promise<ArchiveExtractionResult>;
};

const listArchiveFileEntries = async ({
  ArchiveManager,
  file,
}: {
  ArchiveManager: ArchiveListManagerLike;
  file: ArchiveFileSource;
}) => ArchiveManager.listEntriesFromFile(file);

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

export { extractArchiveFileEntryToFile, listArchiveFileEntries };
