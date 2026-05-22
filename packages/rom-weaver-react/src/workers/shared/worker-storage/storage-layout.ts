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

const normalizeWorkerStorageBucket = (bucket: WorkerStorageBucket) => {
  if (bucket === "inputs") return "input";
  if (bucket === "outputs") return "output";
  if (bucket === "temps") return "temp";
  return bucket;
};

const getWorkerStorageBucketRoot = (mountPoint: string, bucket: WorkerStorageBucket) =>
  `${normalizeWorkerStorageMountPoint(mountPoint)}/${normalizeWorkerStorageBucket(bucket)}`;

const getWorkerStorageBucketPath = (
  mountPoint: string,
  bucket: WorkerStorageBucket,
  relativePath: string,
  fallbackFileName = "file.bin",
) => `${getWorkerStorageBucketRoot(mountPoint, bucket)}/${normalizeRelativeFilePath(relativePath, fallbackFileName)}`;

export type { WorkerStorageBucket };
export {
  getWorkerStorageBucketPath,
  getWorkerStorageBucketRoot,
  normalizeWorkerStorageMountPoint,
  WORKER_OPFS_MOUNTPOINT,
  WORKER_STORAGE_BUCKETS,
};
