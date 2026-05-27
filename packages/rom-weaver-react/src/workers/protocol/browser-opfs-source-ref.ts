import { getBrowserSourceBlob, getBrowserSourceHandle } from "../../storage/browser/browser-source-primitives.ts";
import {
  getNamedSource,
  getNamedSourceFileName,
  getNamedSourceSize,
} from "../../storage/shared/binary/source-file-utils.ts";
import type { WorkerStorageBucket } from "../shared/worker-storage/storage-layout.ts";
import { getWorkerStorageBucketPath, WORKER_OPFS_MOUNTPOINT } from "../shared/worker-storage/storage-layout.ts";
import { getManagedOpfsFileHandle } from "./opfs-path.ts";

type BrowserOpfsSourceRef = {
  cleanup: () => Promise<void>;
  fileName: string;
  filePath: string;
  kind: "path";
  size?: number;
  storageKind: "opfs";
};

const getRecordValue = (source: unknown, key: string) =>
  source && typeof source === "object" ? (source as Record<string, unknown>)[key] : undefined;

const getStringRecordValue = (source: unknown, key: string) => {
  const value = getRecordValue(source, key);
  return typeof value === "string" && value.trim() ? value : "";
};

const getByteSource = (source: unknown): Uint8Array | null => {
  if (source instanceof Uint8Array) return source;
  const bytes = getRecordValue(source, "_u8array") || getRecordValue(source, "u8array");
  return bytes instanceof Uint8Array ? bytes : null;
};

const LEADING_DOTS_REGEX = /^\.+/;
const PATH_SEPARATOR_REGEX = /[\\/]+/g;
const UNSAFE_FILE_CHARS_REGEX = /[^A-Za-z0-9._-]+/g;
const EDGE_UNDERSCORES_REGEX = /^_+|_+$/g;
const TRAILING_SLASHES_REGEX = /\/+$/;
let virtualSourceId = 0;

const normalizeVirtualFileName = (fileName: string | null | undefined, fallback = "input.bin") =>
  String(fileName || fallback)
    .replace(PATH_SEPARATOR_REGEX, "_")
    .replace(UNSAFE_FILE_CHARS_REGEX, "_")
    .replace(EDGE_UNDERSCORES_REGEX, "")
    .replace(LEADING_DOTS_REGEX, "") || fallback;

const createVirtualPathNonce = () => {
  const sequence = ++virtualSourceId;
  const timeToken = Date.now().toString(36);
  const randomToken = Math.random().toString(16).slice(2, 10);
  return `${timeToken}-${sequence}-${randomToken}`;
};

const createVirtualInputPath = (
  options: { bucket?: WorkerStorageBucket; mountPoint: string; pathPrefix: string },
  fileName: string,
) => {
  const mountPoint = String(options.mountPoint || WORKER_OPFS_MOUNTPOINT).replace(TRAILING_SLASHES_REGEX, "");
  const bucket = options.bucket || "input";
  const pathPrefix = normalizeVirtualFileName(options.pathPrefix || "input", "input");
  return getWorkerStorageBucketPath(
    mountPoint,
    bucket,
    `${pathPrefix}-${createVirtualPathNonce()}-${normalizeVirtualFileName(fileName)}`,
    normalizeVirtualFileName(fileName),
  );
};

const getOpfsPathSize = async (filePath: string): Promise<number | undefined> => {
  try {
    const handle = await getManagedOpfsFileHandle(filePath, { navigatorObject: navigator });
    const file = await handle?.getFile();
    return typeof file?.size === "number" ? file.size : undefined;
  } catch (_error) {
    return undefined;
  }
};

const createBrowserOpfsSourceRef = async (
  source: unknown,
  fallbackFileName: string,
  options: { bucket?: WorkerStorageBucket; mountPoint: string; pathPrefix: string },
): Promise<BrowserOpfsSourceRef> => {
  const directSource = getNamedSource(source as Parameters<typeof getNamedSource>[0]);
  const fileName = getNamedSourceFileName(source as Parameters<typeof getNamedSource>[0], {
    fallback: fallbackFileName,
  });
  const sizeHint = getNamedSourceSize(source as Parameters<typeof getNamedSourceSize>[0]);
  const filePath =
    (typeof directSource === "string" && directSource.trim() ? directSource : "") ||
    getStringRecordValue(directSource, "filePath") ||
    getStringRecordValue(source, "filePath");
  if (filePath)
    return {
      cleanup: async () => undefined,
      fileName,
      filePath,
      kind: "path",
      size: sizeHint ?? (await getOpfsPathSize(filePath)),
      storageKind: "opfs",
    };
  const fileHandle = getBrowserSourceHandle(directSource) || getBrowserSourceHandle(source);
  const blob = getBrowserSourceBlob(directSource) || getBrowserSourceBlob(source);
  const bytes = getByteSource(directSource) || getByteSource(source);
  const normalizedFileName = normalizeVirtualFileName(fileName || fallbackFileName, fallbackFileName || "input.bin");
  const opfsPathHint = createVirtualInputPath(options, normalizedFileName);
  const sourceKind = fileHandle
    ? "file-handle"
    : blob
      ? "blob"
      : bytes
        ? "bytes"
        : source && typeof source === "object"
          ? "object"
          : typeof source;
  throw new Error(
    `Browser runtime requires OPFS-backed input paths; got ${sourceKind} for \`${normalizedFileName}\` (expected OPFS path like \`${opfsPathHint}\`)`,
  );
};

export type { BrowserOpfsSourceRef };
export { createBrowserOpfsSourceRef };
