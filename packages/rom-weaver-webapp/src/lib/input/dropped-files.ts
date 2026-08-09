import { createLogger } from "../logging.ts";

/**
 * Read every file out of a drag-and-drop transfer, recursing into any dropped
 * folders. Hidden entries (dotfiles such as `.DS_Store`) are skipped. Browsers
 * without the directory-entry API fall back to the flat `DataTransfer.files`
 * list.
 *
 * IMPORTANT: call this synchronously from the `drop` handler. The directory
 * entries are captured before the first `await`, because the `DataTransfer`
 * and its `DataTransferItemList` are cleared once the event handler returns.
 */

const logger = createLogger("dropped-files");

const isHiddenName = (name: string) => name.startsWith(".");

const readFileFromEntry = (entry: FileSystemFileEntry): Promise<File> =>
  new Promise((resolve, reject) => entry.file(resolve, reject));

const readDirectoryBatch = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
  new Promise((resolve, reject) => reader.readEntries(resolve, reject));

/**
 * Files read out of a drop, plus how many entries could not be read. A folder
 * with unreadable entries used to disappear into a console warning; the count
 * is what lets the drop UI say so.
 */
type DroppedFileRead = { files: File[]; skippedCount: number };

const collectEntryFiles = async (entry: FileSystemEntry): Promise<DroppedFileRead> => {
  if (isHiddenName(entry.name)) return { files: [], skippedCount: 0 };
  if (entry.isFile) {
    try {
      return { files: [await readFileFromEntry(entry as FileSystemFileEntry)], skippedCount: 0 };
    } catch (error) {
      logger.warn("failed to read dropped file entry", { error, name: entry.name });
      return { files: [], skippedCount: 1 };
    }
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children: FileSystemEntry[] = [];
    // A directory whose listing fails hides an unknown number of files. One is
    // the honest floor: the UI says "at least one", never a made-up total.
    let skippedCount = 0;
    // readEntries yields the directory's children in batches; keep reading
    // until it returns an empty batch.
    for (;;) {
      const batch = await readDirectoryBatch(reader).catch((error) => {
        logger.warn("failed to read dropped directory entries", { error, name: entry.name });
        skippedCount += 1;
        return [] as FileSystemEntry[];
      });
      if (batch.length === 0) break;
      children.push(...batch);
    }
    const nested = await Promise.all(children.map(collectEntryFiles));
    return {
      files: nested.flatMap((child) => child.files),
      skippedCount: nested.reduce((sum, child) => sum + child.skippedCount, skippedCount),
    };
  }
  return { files: [], skippedCount: 0 };
};

const readDataTransfer = async (dataTransfer: DataTransfer | null): Promise<DroppedFileRead> => {
  if (!dataTransfer) return { files: [], skippedCount: 0 };
  // Capture entries synchronously before any await - the transfer is cleared
  // once the drop handler returns.
  const entries: FileSystemEntry[] = [];
  // webkitGetAsEntry can return null even when the item is a real file (drags
  // from some sources, script-constructed transfers) - fall back to the item's
  // plain File so those drops are not silently discarded.
  const fallbackFiles: File[] = [];
  let hasEntrySupport = false;
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== "file") continue;
    if (typeof item.webkitGetAsEntry !== "function") continue;
    hasEntrySupport = true;
    const entry = item.webkitGetAsEntry();
    if (entry) {
      entries.push(entry);
      continue;
    }
    const file = item.getAsFile();
    if (file && !isHiddenName(file.name)) fallbackFiles.push(file);
  }
  if (!hasEntrySupport) {
    const files = dataTransfer.files ? Array.from(dataTransfer.files) : [];
    return { files: files.filter((file) => !isHiddenName(file.name)), skippedCount: 0 };
  }
  const collected = await Promise.all(entries.map(collectEntryFiles));
  const files = [...collected.flatMap((entry) => entry.files), ...fallbackFiles];
  const skippedCount = collected.reduce((sum, entry) => sum + entry.skippedCount, 0);
  logger.trace("read dropped files", {
    count: files.length,
    fallbackCount: fallbackFiles.length,
    hadDirectory: entries.some((entry) => entry.isDirectory),
    skippedCount,
  });
  return { files, skippedCount };
};

/** {@link readDataTransfer} for callers that have no way to report skipped entries. */
const readDataTransferFiles = async (dataTransfer: DataTransfer | null): Promise<File[]> =>
  (await readDataTransfer(dataTransfer)).files;

export { readDataTransfer, readDataTransferFiles };
