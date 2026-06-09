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

const collectEntryFiles = async (entry: FileSystemEntry): Promise<File[]> => {
  if (isHiddenName(entry.name)) return [];
  if (entry.isFile) {
    try {
      return [await readFileFromEntry(entry as FileSystemFileEntry)];
    } catch (error) {
      logger.warn("failed to read dropped file entry", { error, name: entry.name });
      return [];
    }
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children: FileSystemEntry[] = [];
    // readEntries yields the directory's children in batches; keep reading
    // until it returns an empty batch.
    for (;;) {
      const batch = await readDirectoryBatch(reader).catch((error) => {
        logger.warn("failed to read dropped directory entries", { error, name: entry.name });
        return [] as FileSystemEntry[];
      });
      if (batch.length === 0) break;
      children.push(...batch);
    }
    const nested = await Promise.all(children.map(collectEntryFiles));
    return nested.flat();
  }
  return [];
};

const readDataTransferFiles = async (dataTransfer: DataTransfer | null): Promise<File[]> => {
  if (!dataTransfer) return [];
  // Capture entries synchronously before any await — the transfer is cleared
  // once the drop handler returns.
  const entries: FileSystemEntry[] = [];
  let hasEntrySupport = false;
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== "file") continue;
    if (typeof item.webkitGetAsEntry !== "function") continue;
    hasEntrySupport = true;
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }
  if (!hasEntrySupport) {
    const files = dataTransfer.files ? Array.from(dataTransfer.files) : [];
    return files.filter((file) => !isHiddenName(file.name));
  }
  const collected = await Promise.all(entries.map(collectEntryFiles));
  const files = collected.flat();
  logger.trace("read dropped files", {
    count: files.length,
    hadDirectory: entries.some((entry) => entry.isDirectory),
  });
  return files;
};

export { readDataTransferFiles };
