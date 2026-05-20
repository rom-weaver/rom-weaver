import type { WorkerRequestData } from "../../../protocol/worker-runtime-payloads.ts";
import type { CoreRomPatchFileLike } from "../../../shared/binary/types.ts";
import PatchFile from "../../../shared/file-io/patch-file.ts";
import { normalizeWorkerFileName } from "../../../shared/worker-message-utils.ts";
import { createProgressCallback } from "../../../shared/worker-progress-utils.ts";
import { getWorkerStorageBucketPath } from "../../../shared/worker-storage/storage-layout.ts";
import type { WorkerOpfsManager } from "../../../shared/worker-storage/types.ts";
import {
  CREATE_PATCH_OPFS_MOUNTPOINT,
  type PatchWorkerFs,
  type WorkerFileLike,
} from "../../shared/patch-worker-storage.ts";
import RomWeaver from "../engine/patch-operations.ts";

type PatchExportable = {
  _originalPatchFile?: CoreRomPatchFileLike;
  _u8array?: Uint8Array;
  file?: CoreRomPatchFileLike;
  fileType?: string;
  export(fileName: string): PatchExportable;
};
type JsonPrimitive = string | number | boolean | null;
type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue | undefined }
  | Blob
  | ArrayBufferLike
  | Uint8Array;

type CreatePatchSourceInput = {
  file?: WorkerFileLike;
  fileName?: string;
  filePath?: string;
};

const FILE_EXTENSION_REGEX = /\.[^./\\\s]+$/;

const isPathBackedPatchOutput = (
  patchFile: CoreRomPatchFileLike | null | undefined,
): patchFile is CoreRomPatchFileLike & { filePath: string } =>
  !!patchFile && typeof patchFile.filePath === "string" && !!patchFile.filePath.trim();

let createPatchWorkId = 0;

const createPatchSourcePatchFile = async (
  storage: PatchWorkerFs,
  manager: WorkerOpfsManager | null,
  source: CreatePatchSourceInput,
  fallbackFileName: string,
): Promise<CoreRomPatchFileLike> => {
  const fileName = source.fileName || source.file?.name || fallbackFileName;
  if (typeof source.filePath === "string" && source.filePath.trim()) {
    if (manager && source.filePath.startsWith(CREATE_PATCH_OPFS_MOUNTPOINT)) {
      return storage.openOpfsInputRomFile(manager, source.filePath, fileName, "application/octet-stream");
    }
    const binFile = new PatchFile(source.filePath) as object as CoreRomPatchFileLike;
    binFile.fileName = fileName;
    return binFile;
  }
  if (source.file instanceof Blob && manager) {
    const filePath = getWorkerStorageBucketPath(
      CREATE_PATCH_OPFS_MOUNTPOINT,
      "input",
      `input-${++createPatchWorkId}${storage.getFileExtension(fileName, ".bin")}`,
      fileName,
    );
    return storage.createOpfsInputRomFile(
      manager,
      filePath,
      source.file,
      fileName,
      source.file.type || "application/octet-stream",
    );
  }
  throw new Error(`Missing ${fallbackFileName} file`);
};

const createRunCreatePatch = (storage: PatchWorkerFs) => async (data: WorkerRequestData) => {
  if (typeof data.format !== "string" || !data.format.trim()) throw new Error("Missing patch format");

  const progressCallback = createProgressCallback(data.requestId || "0");
  progressCallback({ label: "Preparing patch inputs...", percent: 0 });
  const manager = await storage.getCreatePatchOpfsManager();
  if (!manager) throw new Error("Worker-backed output storage is required for patch creation");
  const format = data.format.trim().toLowerCase();
  const originalFileName = data.originalFileName || data.originalFile?.name || "original.bin";
  const modifiedFileName = data.modifiedFileName || data.modifiedFile?.name || "modified.bin";
  progressCallback({ label: "Reading original ROM...", percent: 10 });
  const originalFile = await createPatchSourcePatchFile(
    storage,
    manager,
    {
      file: data.originalFile,
      fileName: originalFileName,
      filePath: data.originalFilePath,
    },
    "original.bin",
  );
  progressCallback({ label: "Reading modified ROM...", percent: 25 });
  const modifiedFile = await createPatchSourcePatchFile(
    storage,
    manager,
    {
      file: data.modifiedFile,
      fileName: modifiedFileName,
      filePath: data.modifiedFilePath,
    },
    "modified.bin",
  );
  const outputName = normalizeWorkerFileName(
    data.outputName,
    `${String(originalFile.fileName || "patch").replace(FILE_EXTENSION_REGEX, "") || "patch"}.${format}`,
  );
  const exportBaseName = outputName.replace(new RegExp(`\\.${format}$`, "i"), "");
  // Xdelta/VCDIFF creation can consume one filesystem-backed slot before falling back to the finalized patch file.
  const workerOutputCount = format === "xdelta" || format === "vcdiff" ? 2 : 1;
  const createPatchOptions = {
    opfsManager: manager,
    outputFileFactory: await storage.createOpfsOutputFactory(
      manager,
      workerOutputCount,
      `create-patch-${createPatchWorkId}`,
      outputName,
    ),
    workerThreads: data.workerThreads,
  };
  progressCallback({ label: "Creating patch...", percent: 40 });
  const patch = (await RomWeaver.createPatch(
    originalFile,
    modifiedFile,
    format,
    (data.metadata || {}) as Record<string, JsonValue>,
    createPatchOptions,
  )) as object as PatchExportable;
  const pathBackedPatchOutput = patch._originalPatchFile || patch.file;
  // Reuse the worker-backed patch file directly when createPatch already returned an OPFS-backed artifact.
  if (manager && isPathBackedPatchOutput(pathBackedPatchOutput)) {
    storage.postCreatePatchComplete({
      cleanupRef: { paths: manager.getPreparedPaths() },
      fileName: outputName,
      outputRef: {
        fileName: outputName,
        filePath: pathBackedPatchOutput.filePath,
        kind: "opfs",
        size: pathBackedPatchOutput.fileSize,
      },
      requestId: data.requestId,
      success: true,
    });
    progressCallback({ label: "Patch created", percent: 100 });
    return;
  }
  progressCallback({ label: "Exporting patch...", percent: 90 });
  const exportedPatch = patch.export(exportBaseName);
  const patchBytes = exportedPatch._u8array instanceof Uint8Array ? exportedPatch._u8array : new Uint8Array(0);
  const filePath = getWorkerStorageBucketPath(
    CREATE_PATCH_OPFS_MOUNTPOINT,
    "output",
    `patch-${createPatchWorkId}-${normalizeWorkerFileName(outputName, "patch.bin")}`,
    outputName,
  );
  const backend = await manager.prepareFile(filePath);
  if (!backend) throw new Error("Could not prepare OPFS output for patch creation");
  backend.accessHandle.write(patchBytes, { at: 0 });
  backend.size = patchBytes.byteLength;
  backend.timestamp = Date.now();
  backend.accessHandle.flush();
  const file = await manager.getFile(filePath);
  if (!file) {
    await manager.cleanup([filePath]);
    throw new Error("Could not read patch output from OPFS");
  }
  storage.postCreatePatchComplete({
    cleanupRef: { paths: manager.getPreparedPaths() },
    fileName: outputName,
    outputRef: {
      fileName: outputName,
      filePath,
      kind: "opfs",
      size: file.size,
    },
    requestId: data.requestId,
    success: true,
  });
  progressCallback({ label: "Patch created", percent: 100 });
};

export { createRunCreatePatch };
