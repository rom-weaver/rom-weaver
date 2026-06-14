import { normalizeRelativeFilePath } from "../../../storage/shared/path-utils.ts";
import { DEFAULT_VFS_ROOT } from "../../../storage/vfs/path.ts";

const WORKER_OPFS_MOUNTPOINT = DEFAULT_VFS_ROOT;
const WORKER_STORAGE_BUCKETS = ["input", "patches", "output", "temp"] as const;
type WorkerStorageBucket = (typeof WORKER_STORAGE_BUCKETS)[number] | "inputs" | "outputs" | "temps";

const LEADING_SLASHES_REGEX = /^\/+/;
const TRAILING_SLASHES_REGEX = /\/+$/;

const normalizeWorkerStorageMountPoint = (mountPoint: string, fallback = WORKER_OPFS_MOUNTPOINT) => {
  const normalized = `/${String(mountPoint || fallback).replace(LEADING_SLASHES_REGEX, "")}`.replace(/\/+/g, "/");
  return normalized.replace(TRAILING_SLASHES_REGEX, "") || fallback;
};

const getWorkerStorageBucketRoot = (mountPoint: string, _bucket: WorkerStorageBucket) =>
  normalizeWorkerStorageMountPoint(mountPoint);

const getWorkerStorageBucketPath = (
  mountPoint: string,
  bucket: WorkerStorageBucket,
  relativePath: string,
  fallbackFileName = "file.bin",
) => `${getWorkerStorageBucketRoot(mountPoint, bucket)}/${normalizeRelativeFilePath(relativePath, fallbackFileName)}`;

export type { WorkerStorageBucket };
export { getWorkerStorageBucketPath, WORKER_OPFS_MOUNTPOINT };
