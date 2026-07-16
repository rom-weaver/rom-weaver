import {
  configureObjectBinarySourceReaderFactories,
  createBinaryObjectReader,
} from "../shared/binary/binary-source-utils.ts";
import {
  type BinaryObjectLike,
  isBinaryObjectLike,
  isFileSystemFileHandleLike,
} from "../shared/binary/source-shared.ts";
import { createCleanupOnce } from "../shared/disposal.ts";

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

const managedSourceCleanups = new WeakMap<object, () => Promise<void>>();

const registerBrowserSourceCleanup = (source: object, cleanup: () => Promise<void> | void): (() => Promise<void>) => {
  const cleanupOnce = createCleanupOnce(cleanup);
  managedSourceCleanups.set(source, cleanupOnce);
  return cleanupOnce;
};

const releaseBrowserSource = async (source: unknown): Promise<void> => {
  if (!(source && typeof source === "object")) return;
  const cleanup = managedSourceCleanups.get(source);
  if (!cleanup) return;
  managedSourceCleanups.delete(source);
  await cleanup();
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

export {
  configureBrowserSourcePrimitives,
  getBrowserSourceBlob,
  getBrowserSourceHandle,
  registerBrowserSourceCleanup,
  releaseBrowserSource,
};
