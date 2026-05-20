import type { WorkerRequestData } from "../../protocol/worker-runtime-payloads.ts";
import { copySourceToWriter, createBinarySourceReader } from "../../shared/binary/binary-source-utils.ts";
import type { CoreRomPatchFileLike, ProgressEventLike, WorkerPatchFile } from "../../shared/binary/types.ts";
import PatchFile from "../../shared/file-io/patch-file.ts";
import type { EmscriptenWorkerModule } from "../../shared/wasm/emscripten-types.ts";
import { normalizeWorkerFileName, postCloneSafeWorkerMessage } from "../../shared/worker-message-utils.ts";
import {
  createOpfsInputPatchFile,
  createOpfsOutputManager,
  createOpfsPatchFile,
  createOpfsPreparedFile,
  writeBlobToOpfsBackend,
} from "../../shared/worker-storage/opfs-manager.ts";
import { getWorkerStorageBucketPath, WORKER_OPFS_MOUNTPOINT } from "../../shared/worker-storage/storage-layout.ts";
import type { OpfsBackend, WorkerOpfsManager } from "../../shared/worker-storage/types.ts";

const FILE_EXTENSION_REGEX = /\.[^./\\\s]+$/;

const APPLY_OPFS_MOUNTPOINT = WORKER_OPFS_MOUNTPOINT;
const CREATE_PATCH_OPFS_MOUNTPOINT = WORKER_OPFS_MOUNTPOINT;

type PatchWorkerScope = typeof globalThis & {
  Module?: EmscriptenWorkerModule;
  navigator: Navigator;
  postMessage: (message: PatchWorkerMessage, transfer?: Transferable[]) => void;
};

type PatchWorkerMessage = {
  action?: string;
  code?: string;
  error?: { code?: string; details?: Record<string, unknown>; message: string };
  requestId?: string;
  message?: string;
  success?: boolean;
  type?: "error" | "result";
  workerKind?: "patch-checksum";
  [key: string]:
    | string
    | number
    | boolean
    | Blob
    | File
    | FileSystemFileHandle
    | string[]
    | Uint8Array
    | object
    | null
    | undefined;
};

type WorkerScalar = string | number | boolean | null | undefined;
type WorkerFileLike = Blob & { name?: string; type?: string };

const getPatchWorkerFileExtension = (fileName: WorkerScalar, fallback: WorkerScalar) => {
  const match = normalizeWorkerFileName(fileName, fallback || "input.bin").match(FILE_EXTENSION_REGEX);
  return match ? match[0] : ".bin";
};

const isBrowserFileLike = (file: Blob | File | object | null | undefined): file is WorkerFileLike =>
  !!file && typeof (file as Blob).size === "number" && typeof (file as Blob).slice === "function";

const hasSyncAccessHandleBackend = (backend: OpfsBackend | null | undefined) =>
  !!(
    backend &&
    backend.accessHandle &&
    typeof backend.accessHandle.read === "function" &&
    typeof backend.accessHandle.write === "function"
  );

const requireSyncAccessHandleBackend = (backend: OpfsBackend | null | undefined, context: string) => {
  if (!hasSyncAccessHandleBackend(backend)) {
    throw new Error(`${context} requires sync access-handle storage`);
  }
  return backend as OpfsBackend;
};

const createPathBackedPatchFile = (filePath: string, fileName: string, fileType: string): WorkerPatchFile => {
  const patchFile = new PatchFile(filePath) as object as WorkerPatchFile;
  patchFile.fileName = fileName;
  patchFile.fileType = fileType || "application/octet-stream";
  patchFile.filePath = filePath;
  return patchFile;
};

const resetPathBackedPatchFile = (file: WorkerPatchFile, size: number, fileName: string, fileType: string) => {
  const writableSource = (file as WorkerPatchFile & { _byteSource?: { truncate?: (size: number) => void } })
    ._byteSource;
  if (!(writableSource && typeof writableSource.truncate === "function"))
    throw new Error("Path-backed apply output is not resettable");
  const normalizedSize = Math.max(0, Math.floor(size || 0));
  writableSource.truncate(normalizedSize);
  file.fileName = fileName || file.fileName;
  file.fileType = fileType || file.fileType;
  file.fileSize = normalizedSize;
  if (typeof file.seek === "function") file.seek(0);
};

const createPatchWorkerFs = ({
  normalizeFatalWorkerError,
  workerScope,
}: {
  normalizeFatalWorkerError: (error: unknown) => string;
  workerScope: PatchWorkerScope;
}) => {
  let applyOpfsManagerPromise: Promise<WorkerOpfsManager> | null = null;
  let createPatchOpfsManagerPromise: Promise<WorkerOpfsManager | null> | null = null;

  const getApplyOutputUnavailableErrorMessage = async () => {
    const navigatorObject = workerScope.navigator;
    if (!navigatorObject) return "Browser-backed apply output requires navigator access inside the patch worker.";
    if (!navigatorObject.storage || typeof navigatorObject.storage.getDirectory !== "function")
      return "Browser-backed apply output requires navigator.storage.getDirectory() in the patch worker.";
    let storageRoot: FileSystemDirectoryHandle;
    try {
      storageRoot = await navigatorObject.storage.getDirectory();
    } catch (error) {
      return `Browser-backed apply output could not open OPFS storage: ${normalizeFatalWorkerError(error)}`;
    }
    const probeName = `rom-weaver-apply-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const fileHandle = await storageRoot.getFileHandle(probeName, { create: true });
      if (typeof fileHandle.createSyncAccessHandle !== "function")
        return "Browser-backed apply output requires FileSystemFileHandle.createSyncAccessHandle() in the patch worker.";
      let accessHandle: FileSystemSyncAccessHandle;
      try {
        accessHandle = await fileHandle.createSyncAccessHandle();
      } catch (error) {
        return `Browser-backed apply output could not create an OPFS sync access handle for ${probeName}: ${normalizeFatalWorkerError(error)}`;
      }
      try {
        accessHandle.truncate(0);
        accessHandle.flush();
      } finally {
        accessHandle.close();
      }
      return "Browser-backed apply output is not available for an unknown OPFS reason.";
    } catch (error) {
      return `Browser-backed apply output could not create an OPFS sync access handle: ${normalizeFatalWorkerError(error)}`;
    } finally {
      try {
        await storageRoot.removeEntry(probeName);
      } catch (_error) {
        /* ignore cleanup errors */
      }
    }
  };

  const getApplyOpfsManager = (moduleObject?: EmscriptenWorkerModule | null): Promise<WorkerOpfsManager> => {
    if (!applyOpfsManagerPromise) {
      applyOpfsManagerPromise = Promise.resolve()
        .then(async () => {
          const manager = await createOpfsOutputManager({
            moduleObject: moduleObject || null,
            mountPoint: APPLY_OPFS_MOUNTPOINT,
            navigatorObject: workerScope.navigator,
            preferPortableMount: true,
          });
          if (!manager) throw new Error(await getApplyOutputUnavailableErrorMessage());
          return manager;
        })
        .catch((error) => {
          applyOpfsManagerPromise = null;
          throw error;
        });
    }
    return applyOpfsManagerPromise.then((manager) => {
      if (
        manager &&
        moduleObject?.FS &&
        typeof manager.ensureMounted === "function" &&
        !manager.ensureMounted(moduleObject)
      )
        throw new Error(
          `Browser-backed apply output could not mount ${APPLY_OPFS_MOUNTPOINT} in the worker filesystem.`,
        );
      return manager;
    });
  };

  const getCreatePatchOpfsManager = () => {
    if (!createPatchOpfsManagerPromise) {
      createPatchOpfsManagerPromise = createOpfsOutputManager({
        mountPoint: CREATE_PATCH_OPFS_MOUNTPOINT,
        navigatorObject: workerScope.navigator || null,
        preferPortableMount: true,
      });
    }
    return createPatchOpfsManagerPromise;
  };

  const cleanupPatchWorkerFiles = async (filePaths?: string[]) => {
    const applyManager = applyOpfsManagerPromise ? await getApplyOpfsManager().catch(() => null) : null;
    if (applyManager) await applyManager.cleanup(filePaths);
    const createManager = createPatchOpfsManagerPromise ? await getCreatePatchOpfsManager().catch(() => null) : null;
    if (createManager) await createManager.cleanup(filePaths);
  };

  const createOpfsInputRomFile = async (
    manager: WorkerOpfsManager,
    filePath: string,
    source: WorkerFileLike | Uint8Array,
    fileName: string,
    fileType: string,
  ): Promise<CoreRomPatchFileLike> => {
    const sourceReader = await createBinarySourceReader(source, fileName);
    const opfsInputFile = await createOpfsPreparedFile({
      createFile: (backend, nextFilePath, nextFileName, nextFileType) =>
        createOpfsInputPatchFile(backend, nextFileName, nextFileType, nextFilePath),
      fileName,
      filePath,
      fileType,
      manager,
      moduleObject: null,
    });
    if (!opfsInputFile) throw new Error("OPFS is required for browser patch creation");
    const backend = (opfsInputFile as CoreRomPatchFileLike & { backend: OpfsBackend | null | undefined }).backend;
    if (!hasSyncAccessHandleBackend(backend)) {
      const writeSuccess = isBrowserFileLike(source)
        ? await manager.writeBlob(filePath, source)
        : await manager.writeFile(filePath, source);
      if (!writeSuccess) throw new Error("Patch worker input staging could not write the source file");
      const sourcePath = (await manager.getFilePath?.(filePath)) || filePath;
      const pathBackedFile = createPathBackedPatchFile(
        sourcePath,
        fileName,
        fileType,
      ) as object as CoreRomPatchFileLike;
      pathBackedFile.fileSize = sourceReader.size;
      return pathBackedFile;
    }
    const syncBackend = requireSyncAccessHandleBackend(
      (opfsInputFile as CoreRomPatchFileLike & { backend: OpfsBackend | null | undefined }).backend,
      "Patch worker input staging",
    );
    if (isBrowserFileLike(source)) await writeBlobToOpfsBackend(syncBackend, source);
    else {
      await copySourceToWriter(source, (bytes, offset) => {
        syncBackend.accessHandle.write(bytes, { at: offset });
      });
    }
    syncBackend.size = sourceReader.size;
    syncBackend.timestamp = Date.now();
    syncBackend.accessHandle.flush();
    (opfsInputFile as CoreRomPatchFileLike & { fileSize: number }).fileSize = sourceReader.size;
    return opfsInputFile;
  };

  const openOpfsInputRomFile = async (
    manager: WorkerOpfsManager,
    filePath: string,
    fileName: string,
    fileType: string,
  ): Promise<CoreRomPatchFileLike> => {
    const backend = await manager.openFile?.(filePath);
    if (!backend) throw new Error(`OPFS input is not available: ${fileName || filePath}`);
    if (!hasSyncAccessHandleBackend(backend)) {
      const sourcePath = (await manager.getFilePath?.(filePath)) || filePath;
      return createPathBackedPatchFile(
        sourcePath,
        fileName,
        fileType || "application/octet-stream",
      ) as CoreRomPatchFileLike;
    }
    return createOpfsInputPatchFile(backend, fileName, fileType || "application/octet-stream", filePath);
  };

  const createOpfsOutputFactory = async (
    manager: WorkerOpfsManager,
    outputCount: number,
    workId: string,
    outputName: string | null | undefined,
    moduleObject?: EmscriptenWorkerModule | null,
  ) => {
    const outputFiles: WorkerPatchFile[] = [];
    const normalizedOutputFileName = typeof outputName === "string" && outputName ? outputName : "patched.bin";
    const outputExtension = getPatchWorkerFileExtension(normalizedOutputFileName, "patched.bin");
    for (let i = 0; i < outputCount; i++) {
      const outputPath = getWorkerStorageBucketPath(
        manager.outputDirectory,
        "output",
        `patched-output-${workId}-${i}${outputExtension}`,
        normalizedOutputFileName,
      );
      const outputFile = await createOpfsPreparedFile({
        createFile: (backend, filePath, fileName, fileType) =>
          createOpfsPatchFile(backend, filePath, fileName, fileType),
        fileName: normalizedOutputFileName,
        filePath: outputPath,
        fileType: "application/octet-stream",
        manager,
        moduleObject: moduleObject || null,
      });
      if (!outputFile) throw new Error("Browser-backed apply output is not available");
      const outputBackend = (outputFile as WorkerPatchFile & { backend?: OpfsBackend | null }).backend;
      if (hasSyncAccessHandleBackend(outputBackend)) {
        outputFiles.push(outputFile);
        continue;
      }
      const hostOutputPath = await manager.getFilePath?.(outputPath);
      if (!hostOutputPath) throw new Error("Patch worker output staging requires file-backed storage");
      outputFiles.push(createPathBackedPatchFile(hostOutputPath, normalizedOutputFileName, "application/octet-stream"));
    }
    let nextOutputIndex = 0;
    return (size: number) => {
      if (nextOutputIndex >= outputFiles.length) throw new Error("Browser-backed apply output was exhausted");
      const outputFile = outputFiles[nextOutputIndex];
      nextOutputIndex++;
      if (!outputFile) throw new Error("Browser-backed apply output was exhausted");
      if (typeof outputFile.reset === "function") {
        outputFile.reset(size, normalizedOutputFileName || outputFile.fileName, "application/octet-stream");
      } else {
        resetPathBackedPatchFile(
          outputFile,
          size,
          normalizedOutputFileName || outputFile.fileName,
          "application/octet-stream",
        );
      }
      return outputFile;
    };
  };

  const postApplyResult = async ({
    applySummary,
    cleanupPaths,
    data,
    failureMessage,
    manager,
    patchedRom,
    timing,
  }: {
    applySummary?: Record<string, unknown> | null;
    cleanupPaths?: string[];
    data: WorkerRequestData;
    failureMessage: string | false;
    manager: WorkerOpfsManager | null;
    patchedRom: WorkerPatchFile | null | undefined;
    timing: ProgressEventLike | { elapsedMs?: number; elapsedSeconds?: number } | null | undefined;
  }) => {
    if (patchedRom) {
      const error =
        failureMessage === false
          ? undefined
          : {
              code: "WORKER_FAILED",
              details: { requestId: String(data.requestId), workerKind: "patch-checksum" },
              message: failureMessage,
            };
      const message: PatchWorkerMessage = {
        action: "complete",
        ...(applySummary ? { applySummary } : null),
        code: error?.code,
        error,
        message: error?.message,
        patchedRomFileName: patchedRom.fileName,
        requestId: data.requestId,
        success: !failureMessage,
        timing: timing || null,
        type: error ? "error" : "result",
        workerKind: "patch-checksum",
      };
      if (!failureMessage && patchedRom.filePath && manager) {
        if (typeof patchedRom.flush === "function") patchedRom.flush();
        const patchedRomFile = await manager.getFile(patchedRom.filePath);
        if (patchedRomFile) {
          message.outputRef = {
            fileName: patchedRom.fileName || data.romFileName || "patched.bin",
            filePath: patchedRom.filePath,
            kind: "opfs",
            size: patchedRomFile.size,
          };
          message.cleanupRef = {
            paths: typeof manager.getPreparedPaths === "function" ? manager.getPreparedPaths() : [patchedRom.filePath],
          };
          postCloneSafeWorkerMessage(workerScope, message);
          return true;
        }
      }
      if (!failureMessage && patchedRom.filePath) {
        message.outputRef = {
          fileName: patchedRom.fileName || data.romFileName || "patched.bin",
          filePath: patchedRom.filePath,
          kind: "file",
        };
        message.cleanupRef = { paths: cleanupPaths || [patchedRom.filePath] };
        postCloneSafeWorkerMessage(workerScope, message);
        return true;
      }
      message.success = false;
      message.type = "error";
      message.message = failureMessage || "Browser-backed apply output is not available";
      message.error = {
        code: "WORKER_FAILED",
        details: { requestId: String(data.requestId), workerKind: "patch-checksum" },
        message: message.message,
      };
      postCloneSafeWorkerMessage(workerScope, message);
      return false;
    }
    const message = failureMessage || "Browser-backed apply output is not available";
    postCloneSafeWorkerMessage(workerScope, {
      action: "complete",
      code: "WORKER_FAILED",
      error: {
        code: "WORKER_FAILED",
        details: { requestId: String(data.requestId), workerKind: "patch-checksum" },
        message,
      },
      message,
      requestId: data.requestId,
      success: false,
      type: "error",
      workerKind: "patch-checksum",
    });
    return false;
  };

  const postCreatePatchComplete = (message: {
    success: boolean;
    fileName?: string;
    requestId?: string;
    cleanupRef?: { paths: string[] };
    error?: { code?: string; details?: Record<string, unknown>; message: string };
    outputRef?: {
      file?: Blob;
      fileHandle?: FileSystemFileHandle;
      fileName: string;
      filePath?: string;
      kind: "file" | "opfs";
      opfsPath?: string;
      size?: number;
    };
    message?: string;
  }) => {
    postCloneSafeWorkerMessage(workerScope, {
      action: "complete",
      type: message.success ? "result" : "error",
      workerKind: "patch-checksum",
      ...message,
    });
  };

  return {
    cleanupPatchWorkerFiles,
    createOpfsInputRomFile,
    createOpfsOutputFactory,
    getApplyOpfsManager,
    getCreatePatchOpfsManager,
    getFileExtension: getPatchWorkerFileExtension,
    openOpfsInputRomFile,
    postApplyResult,
    postCreatePatchComplete,
  };
};

type PatchWorkerFs = ReturnType<typeof createPatchWorkerFs>;

export type { PatchWorkerFs, PatchWorkerMessage, PatchWorkerScope, WorkerFileLike };
export {
  APPLY_OPFS_MOUNTPOINT,
  CREATE_PATCH_OPFS_MOUNTPOINT,
  createPatchWorkerFs,
  getPatchWorkerFileExtension,
  isBrowserFileLike,
};
