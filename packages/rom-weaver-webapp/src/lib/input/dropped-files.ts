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

const collectEntryFiles = async (entry: FileSystemEntry, fallback?: File | null): Promise<File[]> => {
  if (isHiddenName(entry.name)) return [];
  if (entry.isFile) {
    try {
      return [await readFileFromEntry(entry as FileSystemFileEntry)];
    } catch (error) {
      logger.warn("failed to read dropped file entry", { error, name: entry.name });
      return fallback && !isHiddenName(fallback.name) ? [fallback] : [];
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
    const nested = await Promise.all(children.map((child) => collectEntryFiles(child)));
    return nested.flat();
  }
  return [];
};

type DroppedFilesTransfer = {
  files: ArrayLike<File>;
  items?: ArrayLike<{
    kind: string;
    webkitGetAsEntry?: () => FileSystemEntry | null;
    getAsFile?: () => File | null;
  }>;
};

// Replayed drops MUST reuse flattened files so browser entry reads cannot delay delivery again.
const flattenedTransfers = new WeakMap<DroppedFilesTransfer, File[]>();

const createFileDataTransfer = (files: File[]) => {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  flattenedTransfers.set(
    transfer,
    files.filter((file) => !isHiddenName(file.name)),
  );
  return transfer;
};

const readDataTransferFiles = async (dataTransfer: DroppedFilesTransfer | null): Promise<File[]> => {
  if (!dataTransfer) return [];
  const flattened = flattenedTransfers.get(dataTransfer);
  if (flattened) return flattened;
  // Capture entries synchronously before any await - the transfer is cleared
  // once the drop handler returns.
  const collected: Promise<File[]>[] = [];
  let hadDirectory = false;
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
    // Capture the File before entry reading yields and the transfer clears.
    const file = item.getAsFile?.();
    if (entry) {
      // WebKit can expose an unreadable filesystem entry for a valid in-memory
      // File. Keep that File as the entry's fallback.
      collected.push(collectEntryFiles(entry, file));
      hadDirectory ||= entry.isDirectory;
    } else if (file && !isHiddenName(file.name)) {
      fallbackFiles.push(file);
    }
  }
  if (!hasEntrySupport) {
    const files = dataTransfer.files ? Array.from(dataTransfer.files) : [];
    return files.filter((file) => !isHiddenName(file.name));
  }
  const files = [...(await Promise.all(collected)).flat(), ...fallbackFiles];
  logger.trace("read dropped files", {
    count: files.length,
    fallbackCount: fallbackFiles.length,
    hadDirectory,
  });
  return files;
};

export { createFileDataTransfer, readDataTransferFiles };
export type { DroppedFilesTransfer };
