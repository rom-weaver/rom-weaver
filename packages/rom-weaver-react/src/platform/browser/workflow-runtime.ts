import { getPathBaseName } from "../../lib/path-utils.ts";
import { createRomWeaverOutputScope } from "../../lib/runtime/run-output-paths.ts";
import { romTypeFromEmittedFile } from "../../lib/runtime/run-result-parsing.ts";
import { assertBrowserBinarySource } from "../../lib/runtime/source-normalization.ts";
import {
  invokeRomWeaverBundleCreateWorker,
  invokeRomWeaverBundleParseWorker,
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
  createRuntimeOutputFromVfs,
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
import { createBrowserChdRuntime, stripPrimaryChdTrackSuffix } from "./workflow-runtime-chd.ts";
import { createBrowserDiscFormatsRuntime } from "./workflow-runtime-disc-formats.ts";
import { browserVfs } from "./workflow-runtime-vfs-cleanup.ts";

const getBrowserDestinationHandle = (destination: unknown) => {
  if (!destination || typeof destination === "string") return undefined;
  if (typeof destination === "object" && "createWritable" in destination) return destination as FileSystemFileHandle;
  if (typeof destination === "object" && "fileHandle" in destination)
    return (destination as { fileHandle?: FileSystemFileHandle }).fileHandle;
  return undefined;
};

const getBrowserDestinationInteractive = (destination: unknown) =>
  !!destination && typeof destination === "object" && "interactive" in destination && destination.interactive === true;

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
    const interactive = getBrowserDestinationInteractive(destination);
    if (fileHandle || fileName || interactive || destination == null) {
      await output.saveAs(
        fileHandle || (fileName || interactive ? { fileName: fileName || undefined, interactive } : undefined),
      );
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
// bridge; each output's cleanup removes its leaf. Only the staged source is cleaned up here - a bare
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
    const outputScope = createRomWeaverOutputScope();
    try {
      const result = await invokeRomWeaverIngestWorker(
        {
          ...(checksumAlgorithms?.length ? { checksumAlgorithms } : {}),
          ...(select?.length ? { select } : {}),
          ...(typeof interactiveSelectionEnabled === "boolean" ? { interactiveSelectionEnabled } : {}),
          ...(typeof splitBin === "boolean" ? { splitBin } : {}),
          knownInputPaths: [staged.filePath],
          logLevel,
          outDirPath: outputScope.rootPath,
          signal,
          sourcePath: staged.filePath,
        },
        onProgress,
        onLog,
      );
      const extractedAssets = result.assets.filter((asset) => !asset.copiedInPlace);
      const extractedPatches = result.patches.filter((patch) => patch.leafPath !== staged.filePath);
      const outputCleanups = await outputScope.createOutputCleanups(
        [...extractedAssets.map((asset) => asset.path), ...extractedPatches.map((patch) => patch.leafPath)],
        (filePath) => browserVfs.remove(filePath),
      );
      const outputs = await Promise.all(
        extractedAssets.map((asset, index) =>
          workerIo.createWorkerOutput(
            {
              checksums: asset.checksums,
              checksumVariants: asset.checksumVariants,
              cleanup: outputCleanups[index],
              ...(asset.cueText ? { cueText: asset.cueText } : {}),
              ...(asset.discGroupId ? { discGroupId: asset.discGroupId } : {}),
              // Rebase a split CD's primary track ("Game (Track 1).bin" -> "Game.bin") to match the
              // descend/extract runtimes, which strip the same suffix; ingest emits the raw name.
              fileName: asset.trackNumber === 1 ? stripPrimaryChdTrackSuffix(asset.fileName) : asset.fileName,
              filePath: asset.path,
              ...(asset.gdiText ? { gdiText: asset.gdiText } : {}),
              romType: romTypeFromEmittedFile({
                discFormat: asset.discFormat,
                platform: asset.platform,
                recommendedFormat: asset.recommendedFormat,
              }),
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
      // leaf IS the staged source (cleaned up in `finally`), so it is skipped - the caller keeps its
      // own dropped file and only consumes the descriptor's metadata.
      const patchOutputs = await Promise.all(
        extractedPatches.map((patch, index) =>
          workerIo.createWorkerOutput(
            {
              cleanup: outputCleanups[extractedAssets.length + index],
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
    } catch (error) {
      await outputScope.cleanup().catch(() => undefined);
      throw error;
    } finally {
      await staged.cleanup().catch(() => undefined);
    }
  },
});

// Bundle parsing hands extracted members to the normal drop pipeline, so those
// small leaves still need a browser File. Bundle creation never uses this path.
const readBrowserVfsFileAsHeapFile = async (filePath: string, fileName: string): Promise<File> => {
  const stat = await browserVfs.stat(filePath);
  if (!stat) throw new Error(`Bundle file is not available: ${filePath}`);
  const bytes = new Uint8Array(stat.size);
  let readBytes = 0;
  while (readBytes < stat.size) {
    const chunk = await browserVfs.read(filePath, bytes, {
      bufferOffset: readBytes,
      fileOffset: readBytes,
      length: stat.size - readBytes,
    });
    if (!chunk) break;
    readBytes += chunk;
  }
  if (readBytes !== stat.size) {
    throw new Error(`Bundle file read was truncated: ${filePath} (${readBytes}/${stat.size} bytes)`);
  }
  return new File([bytes], fileName, { type: "application/octet-stream" });
};

// Parse a rom-weaver-bundle.json source (plain/compressed/archive). Bundled ROM/patch leaves land under
// the worker OPFS mount; they are materialized as plain heap `File`s (keyed by extracted path) and
// their OPFS copies removed, so the caller can hand them to the standard drop pipeline with nothing
// left dangling in staging.
const createBrowserBundleRuntime = (workerIo: RuntimeWorkerIo): WorkflowRuntime["bundle"] => ({
  create: async ({
    rom,
    bundleRom,
    patches,
    outputName,
    outputHeader,
    romChecksums,
    romSize,
    outputCheck,
    bundleFileName,
    noBundleRom,
    logLevel,
    onLog,
    onProgress,
    signal,
  }) => {
    const staged: Array<{ cleanup: () => Promise<void> }> = [];
    const createdOutputs: Array<{ dispose: () => Promise<void> }> = [];
    const outputScope = createRomWeaverOutputScope();
    try {
      let romPath: string | undefined;
      if (rom) {
        const stagedRom = await workerIo.stageSource({
          fallbackFileName: rom.fileName || "rom.bin",
          pathPrefix: "bundle-rom",
          scope: "archive",
          source: rom.source,
          trace: { logLevel, onLog },
        });
        staged.push(stagedRom);
        romPath = stagedRom.filePath;
      }
      let bundleRomPath: string | undefined;
      if (bundleRom) {
        const stagedBundleRom = await workerIo.stageSource({
          fallbackFileName: bundleRom.fileName || "rom.bin",
          pathPrefix: "bundle-bundle-rom",
          scope: "archive",
          source: bundleRom.source,
          trace: { logLevel, onLog },
        });
        staged.push(stagedBundleRom);
        bundleRomPath = stagedBundleRom.filePath;
      }
      const patchPaths: string[] = [];
      for (const [index, patch] of patches.entries()) {
        const stagedPatch = await workerIo.stageSource({
          fallbackFileName: patch.fileName || `patch-${index + 1}.bin`,
          pathPrefix: `bundle-patch-${index + 1}`,
          scope: "archive",
          source: patch.source,
          trace: { logLevel, onLog },
        });
        staged.push(stagedPatch);
        patchPaths.push(stagedPatch.filePath);
      }
      const inputPaths = [...(romPath ? [romPath] : []), ...(bundleRomPath ? [bundleRomPath] : []), ...patchPaths];
      const outputPath = outputScope.selectOutputPath("", "rom-weaver-bundle.json", inputPaths);
      // The bundle name comes from the caller (its extension picks the archive
      // format); only its base name is honored so it stays inside the mount.
      const bundleBaseName = bundleFileName ? getPathBaseName(bundleFileName, "rom-weaver-bundle.zip") : undefined;
      const bundlePath = bundleBaseName
        ? outputScope.selectOutputPath("", bundleBaseName, [...inputPaths, outputPath])
        : undefined;
      const result = await invokeRomWeaverBundleCreateWorker(
        {
          ...(bundlePath ? { bundlePath } : {}),
          ...(bundleRomPath ? { bundleRomPath } : {}),
          knownInputPaths: inputPaths,
          logLevel,
          ...(noBundleRom ? { noBundleRom: true } : {}),
          ...(outputCheck ? { outputCheck } : {}),
          ...(romChecksums ? { romChecksums } : {}),
          ...(typeof romSize === "number" ? { romSize } : {}),
          ...(outputHeader ? { outputHeader } : {}),
          ...(outputName ? { outputName } : {}),
          outputPath,
          patchDescriptions: patches.map((patch) => patch.description || ""),
          patchHeaders: patches.map((patch) => patch.header || "auto"),
          patchInputChecks: patches.map((patch) => patch.inputChecks || ""),
          patchLabels: patches.map((patch) => patch.label || ""),
          patchNames: patches.map((patch) => patch.name || ""),
          patchOptionals: patches.map((patch) => patch.optional === true),
          patchOutputChecks: patches.map((patch) => patch.outputChecks || ""),
          patchPaths,
          ...(romPath ? { romPath } : {}),
          signal,
        },
        onProgress,
        onLog,
      );
      const outputCleanups = await outputScope.createOutputCleanups(
        [result.bundlePath, ...(result.archivePath ? [result.archivePath] : [])],
        (filePath) => browserVfs.remove(filePath),
      );
      const bundleOutput = await createRuntimeOutputFromVfs(
        browserVfs,
        result.bundlePath,
        getPathBaseName(result.bundlePath, "rom-weaver-bundle.json"),
        { cleanup: outputCleanups[0] },
      );
      createdOutputs.push(bundleOutput);
      const archiveOutput = result.archivePath
        ? await createRuntimeOutputFromVfs(
            browserVfs,
            result.archivePath,
            getPathBaseName(result.archivePath, "rom-weaver-bundle.zip"),
            { cleanup: outputCleanups[1] },
          )
        : undefined;
      if (archiveOutput) createdOutputs.push(archiveOutput);
      return { ...(archiveOutput ? { archiveOutput } : {}), bundleOutput, result };
    } catch (error) {
      await Promise.all(createdOutputs.map((output) => output.dispose().catch(() => undefined)));
      await outputScope.cleanup().catch(() => undefined);
      throw error;
    } finally {
      await Promise.all(staged.map((source) => source.cleanup().catch(() => undefined)));
    }
  },
  parse: async ({ source, fileName, logLevel, onLog, onProgress, signal }) => {
    const staged = await workerIo.stageSource({
      fallbackFileName: fileName || "rom-weaver-bundle.json",
      pathPrefix: "bundle-input",
      scope: "archive",
      source,
      trace: { logLevel, onLog },
    });
    try {
      const result = await invokeRomWeaverBundleParseWorker(
        {
          extractDirPath: WORKER_OPFS_MOUNTPOINT,
          knownInputPaths: [staged.filePath],
          logLevel,
          signal,
          sourcePath: staged.filePath,
        },
        onProgress,
        onLog,
      );
      const extractedPaths = new Set<string>();
      if (result.romSource?.kind === "extracted") extractedPaths.add(result.romSource.extractedPath);
      for (const patchSource of result.patchSources) {
        if (patchSource.source.kind === "extracted") extractedPaths.add(patchSource.source.extractedPath);
      }
      const extractedFiles = new Map<string, File>();
      try {
        for (const extractedPath of extractedPaths) {
          extractedFiles.set(
            extractedPath,
            await readBrowserVfsFileAsHeapFile(extractedPath, getPathBaseName(extractedPath, "bundle-entry.bin")),
          );
        }
      } finally {
        await Promise.all([...extractedPaths].map((path) => browserVfs.remove(path).catch(() => undefined)));
      }
      return { extractedFiles, result };
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
    bundle: createBrowserBundleRuntime(workerIo),
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
