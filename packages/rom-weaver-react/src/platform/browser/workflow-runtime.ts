import { romTypeFromEmittedFile } from "../../lib/runtime/run-result-parsing.ts";
import { assertBrowserBinarySource } from "../../lib/runtime/source-normalization.ts";
import {
  invokeRomWeaverCreatePatchCandidatesWorker,
  invokeRomWeaverCreatePatchWorker,
  invokeRomWeaverIngestWorker,
  invokeRomWeaverPatchApplyWorker,
  invokeRomWeaverPatchValidateWorker,
  invokeRomWeaverTrimWorker,
} from "../../lib/runtime/wasm-command-runtime.ts";
import {
  createRuntimePreload,
  createSharedCompressionRuntime,
  createSharedPatchRuntime,
  createSharedTrimRuntime,
  type RomSpecificRuntimeAdapter,
} from "../../lib/runtime/workflow-runtime-core.ts";
import { configureBrowserSourcePrimitives } from "../../storage/browser/browser-source-primitives.ts";
import {
  createRuntimeOutputFromBytes,
  createRuntimeOutputFromSource,
  getRuntimeOutputStorage,
  readRuntimeOutputBlob,
} from "../../storage/vfs/runtime-output.ts";
import type {
  RuntimePublicOutputAdapter,
  RuntimeWorkerIo,
  WorkflowRuntime,
} from "../../types/workflow-runtime-adapter.ts";
import { noteRomWeaverIoBatch } from "../../workers/rom-weaver/rom-weaver-runner.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../workers/shared/worker-storage/storage-layout.ts";
import { triggerBrowserDownload } from "./browser-download.ts";
import { createBrowserRuntimeVfsIo } from "./browser-runtime-vfs.ts";
import { createBrowserArchiveRuntime } from "./workflow-runtime-archive.ts";
import { createBrowserChdRuntime } from "./workflow-runtime-chd.ts";
import { createBrowserDiscFormatsRuntime } from "./workflow-runtime-disc-formats.ts";
import { browserVfs } from "./workflow-runtime-vfs-cleanup.ts";

const getBrowserDestinationHandle = (destination: unknown) => {
  if (!destination || typeof destination === "string") return undefined;
  if (typeof destination === "object" && "createWritable" in destination) return destination as FileSystemFileHandle;
  if (typeof destination === "object" && "fileHandle" in destination)
    return (destination as { fileHandle?: FileSystemFileHandle }).fileHandle;
  return undefined;
};

const getBrowserDestinationFileName = (destination: unknown) => {
  if (!destination || typeof destination !== "object" || !("fileName" in destination)) return "";
  const fileName = (destination as { fileName?: unknown }).fileName;
  return typeof fileName === "string" ? fileName.trim() : "";
};

const createBrowserPublicOutputAdapter = (): RuntimePublicOutputAdapter => ({
  getBlob: (output) => readRuntimeOutputBlob(output),
  getSize: (output) => output.size,
  getStorage: (output) => getRuntimeOutputStorage(output),
  saveAs: async (output, destination) => {
    const fileHandle = getBrowserDestinationHandle(destination);
    const fileName = getBrowserDestinationFileName(destination);
    if (fileHandle || fileName || destination == null) {
      await output.saveAs(fileHandle || (fileName ? { fileName } : undefined));
      return;
    }
    const blob = await readRuntimeOutputBlob(output);
    await triggerBrowserDownload(blob, output.fileName);
  },
});

// Stage the dropped source into OPFS, ingest it (classify + nested-extract + checksum ROMs in one
// pass; describe patches), and return the parsed result plus adopted `outputs`. Archive ROM leaves
// land under the worker OPFS mount and are wrapped as path-backed PublicOutputs (carrying the ingest
// checksums + disc structure) so the staging pipeline reuses its PublicOutput→PatchFileInstance
// bridge; each output's cleanup removes its leaf. Only the staged source is cleaned up here — a bare
// ROM is checksummed in place (`copiedInPlace`), so it produces no leaf/output.
const createBrowserIngestRuntime = (workerIo: RuntimeWorkerIo): WorkflowRuntime["ingest"] => ({
  run: async ({
    source,
    fileName,
    checksumAlgorithms,
    select,
    interactiveSelectionEnabled,
    splitBin,
    logLevel,
    onLog,
    onProgress,
    signal,
  }) => {
    const staged = await workerIo.stageSource({
      fallbackFileName: fileName || "input.bin",
      pathPrefix: "ingest-input",
      scope: "archive",
      source,
      trace: { logLevel, onLog },
    });
    try {
      const result = await invokeRomWeaverIngestWorker(
        {
          ...(checksumAlgorithms?.length ? { checksumAlgorithms } : {}),
          ...(select?.length ? { select } : {}),
          ...(typeof interactiveSelectionEnabled === "boolean" ? { interactiveSelectionEnabled } : {}),
          ...(typeof splitBin === "boolean" ? { splitBin } : {}),
          knownInputPaths: [staged.filePath],
          logLevel,
          outDirPath: WORKER_OPFS_MOUNTPOINT,
          signal,
          sourcePath: staged.filePath,
        },
        onProgress,
        onLog,
      );
      const outputs = await Promise.all(
        result.assets
          .filter((asset) => !asset.copiedInPlace)
          .map((asset) =>
            workerIo.createWorkerOutput(
              {
                checksums: asset.checksums,
                checksumVariants: asset.checksumVariants,
                cleanup: () =>
                  browserVfs
                    .remove(asset.path)
                    .then(() => undefined)
                    .catch(() => undefined),
                ...(asset.cueText ? { cueText: asset.cueText } : {}),
                ...(asset.discGroupId ? { discGroupId: asset.discGroupId } : {}),
                fileName: asset.fileName,
                filePath: asset.path,
                ...(asset.gdiText ? { gdiText: asset.gdiText } : {}),
                romType: romTypeFromEmittedFile({ discFormat: asset.discFormat, platform: asset.platform }),
                size: asset.sizeBytes,
                ...(typeof asset.trackNumber === "number" ? { trackNumber: asset.trackNumber } : {}),
              },
              asset.fileName,
              "ingest worker did not return browser output",
            ),
          ),
      );
      // Adopt each ARCHIVE patch leaf (extracted into the worker OPFS mount) as a path-backed output so
      // the patch-staging path reuses the same PublicOutput→PatchFileInstance bridge. A bare patch's
      // leaf IS the staged source (cleaned up in `finally`), so it is skipped — the caller keeps its
      // own dropped file and only consumes the descriptor's metadata.
      const patchOutputs = await Promise.all(
        result.patches
          .filter((patch) => patch.leafPath !== staged.filePath)
          .map((patch) =>
            workerIo.createWorkerOutput(
              {
                cleanup: () =>
                  browserVfs
                    .remove(patch.leafPath)
                    .then(() => undefined)
                    .catch(() => undefined),
                fileName: patch.fileName,
                filePath: patch.leafPath,
                size: patch.sizeBytes,
              },
              patch.fileName,
              "ingest worker did not return browser patch output",
            ),
          ),
      );
      return { outputs, patchOutputs, result };
    } finally {
      await staged.cleanup().catch(() => undefined);
    }
  },
});

const createBrowserRomSpecificRuntime = (workerIo: RuntimeWorkerIo): RomSpecificRuntimeAdapter => ({
  ...createBrowserChdRuntime(workerIo),
  ...createBrowserDiscFormatsRuntime(workerIo),
});

const createBrowserCompressionRuntime = (workerIo: RuntimeWorkerIo): WorkflowRuntime["compression"] => {
  const archiveRuntime = createBrowserArchiveRuntime(workerIo);
  const romSpecificRuntime = createBrowserRomSpecificRuntime(workerIo);
  return createSharedCompressionRuntime(archiveRuntime, romSpecificRuntime);
};

const createBrowserPatchRuntime = (workerIo: RuntimeWorkerIo): WorkflowRuntime["patch"] => {
  const sharedPatchRuntime = createSharedPatchRuntime({
    invokeApplyPatchWorker: (input, onProgress, onLog) => invokeRomWeaverPatchApplyWorker(input, onProgress, onLog),
    invokeCreatePatchCandidatesWorker: (input, onProgress, onLog) =>
      invokeRomWeaverCreatePatchCandidatesWorker(input, onProgress, onLog),
    invokeCreatePatchWorker: (input, onProgress, onLog) => invokeRomWeaverCreatePatchWorker(input, onProgress, onLog),
    invokeValidatePatchWorker: (input, onProgress, onLog) =>
      invokeRomWeaverPatchValidateWorker(input, onProgress, onLog),
    workerIo,
    workerOutputFailureMessage: "Patch worker did not return browser output",
  });
  return sharedPatchRuntime;
};

const createBrowserTrimRuntime = (workerIo: RuntimeWorkerIo): WorkflowRuntime["trim"] =>
  createSharedTrimRuntime({
    invokeTrimWorker: (input, onProgress, onLog) => invokeRomWeaverTrimWorker(input, onProgress, onLog),
    workerIo,
    workerOutputFailureMessage: "Trim worker did not return browser output",
  });

const createBrowserRuntime = (): WorkflowRuntime => {
  configureBrowserSourcePrimitives();
  const workerIo = createBrowserRuntimeVfsIo({
    mountPoint: WORKER_OPFS_MOUNTPOINT,
    vfs: browserVfs,
  });
  return {
    binary: {
      assertSource: assertBrowserBinarySource,
    },
    compression: createBrowserCompressionRuntime(workerIo),
    ingest: createBrowserIngestRuntime(workerIo),
    name: "browser",
    noteIoBatch: noteRomWeaverIoBatch,
    output: {
      createBytes: (bytes, fileName) =>
        createRuntimeOutputFromBytes(browserVfs, bytes, fileName, {
          pathPrefix: "runtime-bytes",
        }),
      createSource: (source, fileName) =>
        createRuntimeOutputFromSource(browserVfs, source, fileName, {
          pathPrefix: "runtime-source",
        }),
    },
    patch: createBrowserPatchRuntime(workerIo),
    preload: createRuntimePreload(),
    publicOutput: createBrowserPublicOutputAdapter(),
    sidecars: {},
    trim: createBrowserTrimRuntime(workerIo),
    useBlobOutput: true,
    vfs: browserVfs,
    workerIo,
  };
};

const browserRuntime = createBrowserRuntime();

export { browserRuntime, createBrowserRuntime };
