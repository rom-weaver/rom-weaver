import {
  configureObjectBinarySourceReaderFactories,
  createBinaryObjectReader,
} from "../shared/binary/binary-source-utils.ts";
import {
  type BinaryObjectLike,
  isBinaryObjectLike,
  isFileSystemFileHandleLike,
} from "../shared/binary/source-shared.ts";

const getRecordValue = (source: unknown, key: string) =>
  source && typeof source === "object" ? (source as Record<string, unknown>)[key] : undefined;

const getBrowserSourceHandle = (source: unknown): FileSystemFileHandle | null => {
  if (isFileSystemFileHandleLike(source)) return source;
  const handle = getRecordValue(source, "_fileHandle") || getRecordValue(source, "fileHandle");
  return isFileSystemFileHandleLike(handle) ? handle : null;
};

const getBrowserSourceBlob = (source: unknown): Blob | null => {
  if (typeof Blob !== "undefined" && source instanceof Blob) return source;
  const blob = getRecordValue(source, "_file") || getRecordValue(source, "file") || getRecordValue(source, "blob");
  return typeof Blob !== "undefined" && blob instanceof Blob ? blob : null;
};

let configured = false;

const configureBrowserSourcePrimitives = () => {
  if (configured) return;
  configured = true;
  configureObjectBinarySourceReaderFactories([
    async (source, name, fallbackName) => {
      const handle = getBrowserSourceHandle(source);
      const object = handle ? await handle.getFile() : source;
      if (!isBinaryObjectLike(object)) return null;
      return createBinaryObjectReader(object as BinaryObjectLike, name || object.name || fallbackName);
    },
  ]);
};

export { configureBrowserSourcePrimitives, getBrowserSourceBlob, getBrowserSourceHandle, isFileSystemFileHandleLike };
