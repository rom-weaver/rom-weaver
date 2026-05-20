import { getManagedOpfsFileHandle, removeManagedOpfsPath } from "../protocol/opfs-path.ts";
import { getWorkerErrorMessage, postCloneSafeWorkerMessage } from "../shared/worker-message-utils.ts";
import {
  getWorkerStorageBucketPath,
  WORKER_OPFS_MOUNTPOINT,
  type WorkerStorageBucket,
} from "../shared/worker-storage/storage-layout.ts";

type StageRequest = {
  action: "cleanup" | "stage";
  bucket?: WorkerStorageBucket;
  file?: File;
  fileHandle?: FileSystemFileHandle;
  fileName?: string;
  filePath?: string;
  filePaths?: string[];
  mountPoint?: string;
  pathPrefix?: string;
  requestId?: string;
};

type StageResponse = {
  action: "cleanup-complete" | "stage-complete" | "stage-error";
  error?: { message: string };
  fileName?: string;
  filePath?: string;
  requestId?: string;
  size?: number;
  success: boolean;
};

const workerScope = self as DedicatedWorkerGlobalScope;
const CHUNK_SIZE = 8 * 1024 * 1024;
const LEADING_DOTS_REGEX = /^\.+/;
const PATH_SEPARATOR_REGEX = /[\\/]+/g;
const UNSAFE_FILE_CHARS_REGEX = /[^A-Za-z0-9._-]+/g;
const EDGE_UNDERSCORES_REGEX = /^_+|_+$/g;
const TRAILING_SLASHES_REGEX = /\/+$/;
let stagedSourceId = 0;

const normalizeFileName = (fileName: string | null | undefined, fallback = "input.bin") =>
  String(fileName || fallback)
    .replace(PATH_SEPARATOR_REGEX, "_")
    .replace(UNSAFE_FILE_CHARS_REGEX, "_")
    .replace(EDGE_UNDERSCORES_REGEX, "")
    .replace(LEADING_DOTS_REGEX, "") || fallback;

const createInputPath = (request: StageRequest, fileName: string) => {
  const mountPoint = String(request.mountPoint || WORKER_OPFS_MOUNTPOINT).replace(TRAILING_SLASHES_REGEX, "");
  const bucket = request.bucket || "input";
  const pathPrefix = normalizeFileName(request.pathPrefix || "input", "input");
  stagedSourceId += 1;
  return getWorkerStorageBucketPath(
    mountPoint,
    bucket,
    `${pathPrefix}-${stagedSourceId}-${normalizeFileName(fileName)}`,
    normalizeFileName(fileName),
  );
};

const writeBlobToOpfsPath = async (filePath: string, file: Blob) => {
  const fileHandle = await getManagedOpfsFileHandle(filePath, { create: true, navigatorObject: navigator });
  if (!fileHandle || typeof fileHandle.createSyncAccessHandle !== "function")
    throw new Error("OPFS sync access handles are not available in this browser worker");
  let accessHandle: FileSystemSyncAccessHandle;
  try {
    accessHandle = await fileHandle.createSyncAccessHandle();
  } catch (error) {
    throw new Error(
      `OPFS staging createSyncAccessHandle failed for ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    accessHandle.truncate(0);
    let position = 0;
    while (position < file.size) {
      const nextPosition = Math.min(position + CHUNK_SIZE, file.size);
      const chunkBytes = new Uint8Array(await file.slice(position, nextPosition).arrayBuffer());
      const bytesWritten = accessHandle.write(chunkBytes, { at: position });
      position += bytesWritten;
      if (bytesWritten < chunkBytes.byteLength) throw new Error("OPFS import wrote fewer bytes than expected");
    }
    accessHandle.truncate(file.size);
    accessHandle.flush();
  } finally {
    accessHandle.close();
  }
};

const stageSource = async (request: StageRequest): Promise<StageResponse> => {
  const sourceFile = request.file || (request.fileHandle ? await request.fileHandle.getFile() : null);
  if (!sourceFile) throw new Error("Browser OPFS staging requires a File or FileSystemFileHandle");
  const fileName = normalizeFileName(request.fileName || sourceFile.name, "input.bin");
  const filePath = request.filePath || createInputPath(request, fileName);
  await writeBlobToOpfsPath(filePath, sourceFile);
  return {
    action: "stage-complete",
    fileName,
    filePath,
    requestId: request.requestId,
    size: sourceFile.size,
    success: true,
  };
};

const cleanupPaths = async (request: StageRequest): Promise<StageResponse> => {
  await Promise.all((request.filePaths || []).map((filePath) => removeManagedOpfsPath(filePath, navigator)));
  return {
    action: "cleanup-complete",
    requestId: request.requestId,
    success: true,
  };
};

workerScope.onmessage = (event: MessageEvent<StageRequest>) => {
  const request = event.data || ({} as StageRequest);
  const run = request.action === "cleanup" ? cleanupPaths(request) : stageSource(request);
  run
    .then((response) => postCloneSafeWorkerMessage(workerScope, response))
    .catch((error) => {
      postCloneSafeWorkerMessage(workerScope, {
        action: "stage-error",
        error: { message: getWorkerErrorMessage(error) },
        requestId: request.requestId,
        success: false,
      } satisfies StageResponse);
    });
};
