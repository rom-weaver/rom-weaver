import type {
  WorkerProgressCallback,
  WorkerRequestData,
  WorkerResultFile,
} from "../../protocol/worker-runtime-payloads.ts";
import type { EmscriptenWorkerModule } from "../wasm/emscripten-types.ts";
import { COMPRESSION_OPFS_MOUNTPOINT, type WorkerScalar, workerScope } from "../worker-compression-types.ts";
import { createPercentRangeProgressCallback } from "../worker-progress-utils.ts";
import { createOpfsOutputManager } from "./opfs-manager.ts";
import { normalizeRelativeFilePath } from "./path-utils.ts";
import { getWorkerStorageBucketPath } from "./storage-layout.ts";
import type { CompressionOpfsManager, PreparedCompressionOutput, WorkerOpfsManager } from "./types.ts";

type CompressionOutputPathKey = keyof PreparedCompressionOutput["paths"];

const opfsOutputManagerPromises: WeakMap<EmscriptenWorkerModule, Promise<CompressionOpfsManager | null>> | null =
  typeof WeakMap === "function" ? new WeakMap() : null;
const opfsOutputManagerRecords: Array<{
  moduleObject: EmscriptenWorkerModule;
  promise: Promise<CompressionOpfsManager | null>;
}> = [];

const toCompressionOpfsManager = (manager: WorkerOpfsManager): CompressionOpfsManager => ({
  cleanup: (filePaths?: string[]) => manager.cleanup(filePaths),
  ensureMounted: (moduleObject) => manager.ensureMounted(moduleObject),
  ensureNode: (filePath: string) => manager.ensureNode(filePath),
  getFile: (filePath: string) => manager.getFile(filePath),
  getFileHandle: (filePath: string) => manager.getFileHandle?.(filePath) || null,
  getFilePath: (filePath: string) => manager.getFilePath?.(filePath) || Promise.resolve(null),
  getPreparedPaths: () => manager.getPreparedPaths(),
  linkFile: (sourcePath: string, targetPath: string) => manager.linkFile?.(sourcePath, targetPath) ?? false,
  openFile: (filePath: string) => manager.openFile?.(filePath) || Promise.resolve(null),
  prepareFile: async (filePath: string) => {
    const backend = await manager.prepareFile(filePath);
    return !!backend;
  },
  releaseFile: (filePath: string) => manager.releaseFile?.(filePath),
  writeBlob: (filePath: string, blob: Blob) => manager.writeBlob(filePath, blob),
  writeFile: (filePath: string, bytes: Uint8Array) => manager.writeFile(filePath, bytes),
});

const getOpfsOutputManager = (moduleObject: EmscriptenWorkerModule): Promise<CompressionOpfsManager | null> => {
  if (!moduleObject?.FS) return Promise.resolve(null);
  if (opfsOutputManagerPromises) {
    const cachedPromise = opfsOutputManagerPromises.get(moduleObject);
    if (cachedPromise) return cachedPromise;
  } else {
    for (const record of opfsOutputManagerRecords) {
      if (record && record.moduleObject === moduleObject) return record.promise;
    }
  }
  const opfsOutputManagerPromise = Promise.resolve()
    .then(async () => {
      const manager = await createOpfsOutputManager({
        moduleObject,
        mountPoint: COMPRESSION_OPFS_MOUNTPOINT,
        navigatorObject: workerScope.navigator,
        preferPortableMount: true,
      });
      if (!manager) return null;
      return toCompressionOpfsManager(manager);
    })
    .catch(() => null);
  if (opfsOutputManagerPromises) opfsOutputManagerPromises.set(moduleObject, opfsOutputManagerPromise);
  opfsOutputManagerRecords.push({ moduleObject, promise: opfsOutputManagerPromise });
  return opfsOutputManagerPromise;
};

const createCompressionOutputPaths = (workId: string) => ({
  bin: getWorkerStorageBucketPath(
    COMPRESSION_OPFS_MOUNTPOINT,
    "output",
    `output-${workId}.bin`,
    `output-${workId}.bin`,
  ),
  createChd: getWorkerStorageBucketPath(
    COMPRESSION_OPFS_MOUNTPOINT,
    "output",
    `create-output-${workId}.chd`,
    `create-output-${workId}.chd`,
  ),
  createRvz: getWorkerStorageBucketPath(
    COMPRESSION_OPFS_MOUNTPOINT,
    "output",
    `rvz-create-output-${workId}.rvz`,
    `rvz-create-output-${workId}.rvz`,
  ),
  cue: getWorkerStorageBucketPath(
    COMPRESSION_OPFS_MOUNTPOINT,
    "output",
    `output-${workId}.cue`,
    `output-${workId}.cue`,
  ),
  iso: getWorkerStorageBucketPath(
    COMPRESSION_OPFS_MOUNTPOINT,
    "output",
    `output-${workId}.iso`,
    `output-${workId}.iso`,
  ),
  rvzIso: getWorkerStorageBucketPath(
    COMPRESSION_OPFS_MOUNTPOINT,
    "output",
    `rvz-output-${workId}.iso`,
    `rvz-output-${workId}.iso`,
  ),
});

const COMPRESSION_OUTPUT_PATH_KEYS = Object.freeze(
  Object.keys(createCompressionOutputPaths("work")) as CompressionOutputPathKey[],
);

const cleanupOpfsOutputManagers = (filePaths?: string[]) => {
  const cleanupPaths = filePaths || [];
  return Promise.all(
    opfsOutputManagerRecords.map((record) =>
      record.promise.then((manager) => manager?.cleanup(cleanupPaths)).catch(() => undefined),
    ),
  );
};

const prepareBrowserOutput = async (
  moduleObject: EmscriptenWorkerModule,
  workId: string,
  outputPathKeys: readonly CompressionOutputPathKey[] = COMPRESSION_OUTPUT_PATH_KEYS,
): Promise<PreparedCompressionOutput | null> => {
  const manager = await getOpfsOutputManager(moduleObject);
  if (!manager) return null;
  const outputPaths = createCompressionOutputPaths(workId);
  for (const outputPathKey of outputPathKeys) {
    const outputPath = outputPaths[outputPathKey];
    if (!outputPath) continue;
    const prepared = await manager.prepareFile(outputPath);
    const mounted = manager.ensureNode ? manager.ensureNode(outputPath) !== false : true;
    if (!(prepared && mounted)) {
      await manager.cleanup();
      return null;
    }
  }
  return {
    ...manager,
    outputDirectory: COMPRESSION_OPFS_MOUNTPOINT,
    paths: outputPaths,
  };
};

const getCompressionSourceDisplayFileName = (
  fileName: WorkerScalar,
  archiveEntryName: WorkerScalar,
  archiveFileName: WorkerScalar,
) => {
  const sourceFileName = archiveEntryName || fileName || "";
  return archiveFileName ? `${archiveFileName} / ${sourceFileName}` : String(sourceFileName);
};

const withBrowserOutputCleanup = async <TResult>(
  browserOutput: PreparedCompressionOutput,
  callback: () => Promise<TResult>,
) => {
  try {
    return await callback();
  } catch (error) {
    const cleanupPaths = Array.from(
      new Set([...browserOutput.getPreparedPaths(), ...Object.values(browserOutput.paths).filter(Boolean)]),
    );
    await browserOutput.cleanup(cleanupPaths);
    throw error;
  }
};

type PostDiscResult = (
  requestId: WorkerRequestData["requestId"],
  resultFile: WorkerResultFile,
  cleanupPaths: string[] | null,
  timing: { elapsedMs?: number; elapsedSeconds?: number } | null | undefined,
) => Promise<boolean>;

const completeBrowserDiscOutput = async ({
  browserOutput,
  operationLabel,
  outputPath,
  postResult,
  progressCallback,
  requestId,
  resultFile,
  timing,
}: {
  browserOutput: PreparedCompressionOutput;
  operationLabel: string;
  outputPath?: string | null;
  postResult: PostDiscResult;
  progressCallback: WorkerProgressCallback;
  requestId: WorkerRequestData["requestId"];
  resultFile: WorkerResultFile;
  timing: { elapsedMs?: number; elapsedSeconds?: number } | null | undefined;
}) => {
  if (outputPath) {
    const outputFile = await browserOutput.getFile(outputPath);
    const workerFilePath = outputFile ? null : await browserOutput.getFilePath?.(outputPath);
    if (!(outputFile || workerFilePath)) throw new Error(`${operationLabel} output was not created`);
    if (outputFile) {
      resultFile._opfsPath = outputPath;
      resultFile.fileSize = outputFile.size;
    }
    if (workerFilePath) resultFile.filePath = workerFilePath;
    progressCallback({ label: operationLabel, percent: 100 });
  }
  const cleanupPaths =
    (resultFile._opfsPath || resultFile.filePath) && typeof browserOutput.getPreparedPaths === "function"
      ? browserOutput.getPreparedPaths()
      : null;
  const cleanupDeferred = await postResult(requestId, resultFile, cleanupPaths, timing);
  if (!cleanupDeferred) await browserOutput.cleanup();
  return cleanupDeferred;
};

export {
  COMPRESSION_OPFS_MOUNTPOINT,
  cleanupOpfsOutputManagers,
  completeBrowserDiscOutput,
  createPercentRangeProgressCallback,
  getCompressionSourceDisplayFileName,
  normalizeRelativeFilePath,
  prepareBrowserOutput,
  withBrowserOutputCleanup,
};
