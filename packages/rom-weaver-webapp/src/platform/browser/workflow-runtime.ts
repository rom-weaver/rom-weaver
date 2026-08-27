import { getPathBaseName } from "../../lib/path-utils.ts";
import { emitTraceLog } from "../../lib/logging.ts";
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
  runRomWeaverProbeWorker,
} from "../../lib/runtime/wasm-command-runtime.ts";
import {
  createRuntimePreload,
  createSharedCompressionRuntime,
  createSharedPatchRuntime,
  createSharedTrimRuntime,
  type RomSpecificRuntimeAdapter,
} from "../../lib/runtime/workflow-runtime-core.ts";
import {
  configureBrowserSourcePrimitives,
  registerBrowserSourceCleanup,
} from "../../storage/browser/browser-source-primitives.ts";
import { createCleanupOnce } from "../../storage/shared/disposal.ts";
import { joinVfsPath } from "../../storage/vfs/path.ts";
import { createVfsPathId } from "../../storage/vfs/path-id.ts";
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
import { noteRomWeaverIoBatch } from "../../workers/rom-weaver/runner-control.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../workers/shared/worker-storage/storage-layout.ts";
import { triggerBrowserDownload } from "./browser-download.ts";
import type { BrowserIdentifyPack } from "./identify-packs.ts";
import { createBrowserRuntimeVfsIo } from "./browser-runtime-vfs.ts";
import { createBrowserArchiveRuntime } from "./workflow-runtime-archive.ts";
import { createBrowserChdRuntime, stripPrimaryChdTrackSuffix } from "./workflow-runtime-chd.ts";
import { createBrowserDiscFormatsRuntime } from "./workflow-runtime-disc-formats.ts";
import { browserVfs } from "./workflow-runtime-vfs-cleanup.ts";

type BrowserBundleCreateInput = Parameters<NonNullable<NonNullable<WorkflowRuntime["bundle"]>["create"]>>[0];

const stageBundleCreateInputs = async ({
  bundleRom,
  logLevel,
  onLog,
  patches,
  rom,
  workerIo,
}: Pick<BrowserBundleCreateInput, "bundleRom" | "patches" | "rom"> & {
  logLevel: BrowserBundleCreateInput["logLevel"];
  onLog: BrowserBundleCreateInput["onLog"];
  workerIo: RuntimeWorkerIo;
}) => {
  const staged: Array<Awaited<ReturnType<RuntimeWorkerIo["stageSource"]>>> = [];
  const pathPrefixRoot = `bundle-create-${createVfsPathId()}`;
  const stage = async (
    source: { source: unknown; fileName?: string },
    pathPrefix: string,
    fallbackFileName: string,
  ) => {
    const stagedSource = await workerIo.stageSource({
      fallbackFileName,
      pathPrefix: `${pathPrefixRoot}/${pathPrefix}`,
      pathPrefixInPath: true,
      scope: "archive",
      source: source.source,
      trace: { logLevel, onLog },
    });
    staged.push(stagedSource);
    return stagedSource.filePath;
  };
  const romPath = rom ? await stage(rom, "bundle-rom", rom.fileName || "rom.bin") : undefined;
  const bundleRomPath = bundleRom
    ? await stage(bundleRom, "bundle-bundle-rom", bundleRom.fileName || "rom.bin")
    : undefined;
  const patchPaths: string[] = [];
  for (const [index, patch] of patches.entries()) {
    patchPaths.push(await stage(patch, `bundle-patch-${index + 1}`, patch.fileName || `patch-${index + 1}.bin`));
  }
  return {
    bundleRomPath,
    inputPaths: [...(romPath ? [romPath] : []), ...(bundleRomPath ? [bundleRomPath] : []), ...patchPaths],
    patchPaths,
    romPath,
    staged,
  };
};

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

type IngestRunInput = Parameters<NonNullable<NonNullable<WorkflowRuntime["ingest"]>["run"]>>[0];

/**
 * Stage the identify work for one ingest: which ROM members to look at, and
 * which title packs to fetch for them.
 *
 * Stage 1 is the file name: a `.gba` drop needs exactly one pack and no probe.
 * Stage 2 is a decompression-free probe, run when the name says nothing
 * (`.zip`, `.bin`, `.rom`) or when the caller wants every ROM member. The probe
 * returns the container's member list and the ROM header's platform, and both
 * narrow the pack set the same way. Loading all 6.7 MB stays the last resort,
 * because skipping a pack a ROM could match would report a wrong "no match".
 */
const prepareIngestIdentify = async ({
  fileName,
  logLevel,
  onLog,
  onProgress,
  selectAllRomEntries,
  signal,
  sourcePath,
}: {
  fileName: string;
  logLevel?: IngestRunInput["logLevel"];
  onLog?: IngestRunInput["onLog"];
  onProgress?: IngestRunInput["onProgress"];
  selectAllRomEntries?: boolean;
  signal?: AbortSignal;
  sourcePath: string;
}): Promise<{
  entryNames: string[];
  packs: BrowserIdentifyPack[];
  unavailable?: string;
}> => {
  const trace = { logLevel, namespace: "runtime:browser-workflow", onLog };
  let entryNames: string[] = [];
  try {
    const { loadIdentifyPackSelection, selectIdentifySlugs } = await import("./identify-packs.ts");
    let hints: Parameters<typeof loadIdentifyPackSelection>[0] = { fileName };
    if (selectAllRomEntries || !selectIdentifySlugs(hints).length) {
      onProgress?.({ message: "Inspecting the input…" });
      try {
        const probe = await runRomWeaverProbeWorker(
          { logLevel, romFilter: true, signal, sourcePath },
          undefined,
          onLog,
        );
        entryNames = probe.entries.map((entry) => entry.filename || entry.fileName || entry.name || "").filter(Boolean);
        hints = { entryNames, fileName, ...(probe.platform ? { platform: probe.platform } : {}) };
      } catch (error) {
        // A probe failure only costs precision here - the ingest itself still runs.
        emitTraceLog(trace, "ROM identify probe failed; widening the identify pack selection", {
          error: error instanceof Error ? error.message : String(error),
          fileName,
        });
      }
    }
    emitTraceLog(trace, "loading ROM identify packs", {
      entryCount: entryNames.length,
      fileName,
      slugs: selectIdentifySlugs(hints),
    });
    const selection = await loadIdentifyPackSelection(hints, (platforms) => {
      onProgress?.({
        message:
          platforms.length === 1
            ? `Loading ${platforms[0]} identification data…`
            : `Loading identification data for ${platforms.length} systems…`,
      });
    });
    return {
      entryNames,
      packs: selection.packs,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    emitTraceLog(trace, "ROM identify data unavailable; continuing without title lookup", { error: reason, fileName });
    return { entryNames, packs: [], unavailable: reason };
  }
};

// Ingest a staged source and adopt extracted leaves as path-backed outputs. Bare ROMs are checksummed
// in place and produce no output leaf.
const createBrowserIngestRuntime = (workerIo: RuntimeWorkerIo): WorkflowRuntime["ingest"] => ({
  run: async ({
    source,
    fileName,
    checksumAlgorithms,
    identify,
    identifyAllRomEntries,
    select,
    interactiveSelectionEnabled,
    splitBin,
    logLevel,
    onLog,
    onProgress,
    signal,
  }) => {
    const stagedSource = await workerIo.stageSource({
      fallbackFileName: fileName || "input.bin",
      pathPrefix: "ingest-input",
      scope: "archive",
      source,
      trace: { logLevel, onLog },
    });
    const identifyPacks =
      identify === false
        ? { entryNames: [], packs: [], unavailable: undefined }
        : await prepareIngestIdentify({
            fileName: fileName || "input.bin",
            logLevel,
            onLog,
            onProgress,
            selectAllRomEntries: identifyAllRomEntries,
            signal,
            sourcePath: stagedSource.filePath,
          });
    /* Identifying an archive must answer for EVERY ROM member, so the selection
       is made here instead of being left to the interactive host prompt - which
       an identify run has no answer for and would cancel. */
    const identifySelection = identifyAllRomEntries && !select?.length ? identifyPacks.entryNames : [];
    const stagedPacks = identifyPacks.packs.length
      ? await workerIo.stageSources(
          identifyPacks.packs.map((pack, index) => ({
            fallbackFileName: pack.fileName,
            pathPrefix: `identify-pack-${index + 1}`,
            pathPrefixInPath: true as const,
            scope: "checksum" as const,
            source: pack.blob,
            trace: { logLevel, onLog },
          })),
        )
      : [];
    const staged = [stagedSource, ...stagedPacks];
    const outputScope = createRomWeaverOutputScope();
    try {
      const result = await invokeRomWeaverIngestWorker(
        {
          ...(checksumAlgorithms?.length ? { checksumAlgorithms } : {}),
          ...(stagedPacks.length ? { databasePaths: stagedPacks.map((entry) => entry.filePath) } : {}),
          ...(select?.length ? { select } : identifySelection.length ? { select: identifySelection } : {}),
          ...(typeof interactiveSelectionEnabled === "boolean" ? { interactiveSelectionEnabled } : {}),
          ...(typeof splitBin === "boolean" ? { splitBin } : {}),
          knownInputPaths: staged.map((entry) => entry.filePath),
          logLevel,
          outDirPath: outputScope.rootPath,
          signal,
          sourcePath: stagedSource.filePath,
        },
        onProgress,
        onLog,
      );
      // Archive-relative member path (folders kept) so the UI can name exactly which
      // member inside a container was identified.
      const memberPathPrefix = `${outputScope.rootPath.replace(/\/+$/u, "")}/`;
      for (const asset of result.assets) {
        if (asset.copiedInPlace || !asset.path.startsWith(memberPathPrefix)) continue;
        const memberPath = asset.path.slice(memberPathPrefix.length);
        if (memberPath) asset.memberPath = memberPath;
      }
      const extractedAssets = result.assets.filter((asset) => !asset.copiedInPlace);
      const extractedPatches = result.patches.filter((patch) => patch.leafPath !== stagedSource.filePath);
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
      return {
        ...(identifyPacks.unavailable ? { identifyUnavailable: identifyPacks.unavailable } : {}),
        outputs,
        patchOutputs,
        result,
      };
    } catch (error) {
      await outputScope.cleanup().catch(() => undefined);
      throw error;
    } finally {
      await Promise.all(staged.map((entry) => entry.cleanup().catch(() => undefined)));
    }
  },
});

// Parse a rom-weaver-bundle.json source (plain/compressed/archive). Bundled ROM/patch leaves land under
// a unique per-parse OPFS scope. Disk-backed File views carry their path into the normal drop pipeline;
// final workflow ownership releases each member and removes the scope after the last member is gone.
const createBrowserBundleRuntime = (workerIo: RuntimeWorkerIo): WorkflowRuntime["bundle"] => ({
  create: async ({
    rom,
    bundleRom,
    patches,
    outputName,
    outputHeader,
    romName,
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
      const {
        bundleRomPath,
        inputPaths,
        patchPaths,
        romPath,
        staged: stagedInputs,
      } = await stageBundleCreateInputs({
        bundleRom,
        logLevel,
        onLog,
        patches,
        rom,
        workerIo,
      });
      staged.push(...stagedInputs);
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
          ...(romName === undefined ? {} : { romName }),
          outputPath,
          patchBases: patches.map((patch) => patch.basis || "auto"),
          patchAuthors: patches.map((patch) => patch.author || ""),
          patchDescriptions: patches.map((patch) => patch.description || ""),
          patchHeaders: patches.map((patch) => patch.header || "auto"),
          patchInputChecks: patches.map((patch) => patch.inputChecks || ""),
          patchIds: patches.map((patch) => patch.id || ""),
          patchLabels: patches.map((patch) => patch.label || ""),
          patchNames: patches.map((patch) => patch.name || ""),
          patchOptionals: patches.map((patch) => patch.optional === true),
          patchOutputChecks: patches.map((patch) => patch.outputChecks || ""),
          patchVersions: patches.map((patch) => patch.version || ""),
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
    const extractDirPath = joinVfsPath(WORKER_OPFS_MOUNTPOINT, "bundle-parse", createVfsPathId());
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
          extractDirPath,
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
      const remainingPaths = new Set(extractedPaths);
      const removeExtractedPath = async (path: string) => {
        await browserVfs.remove(path).catch(() => undefined);
        remainingPaths.delete(path);
        if (!remainingPaths.size) await browserVfs.remove(extractDirPath).catch(() => undefined);
      };
      const extractedCleanups: Array<() => Promise<void>> = [];
      for (const extractedPath of extractedPaths) {
        const storedFile = await browserVfs.getFile?.(extractedPath);
        if (!storedFile) throw new Error(`Bundle file is not available: ${extractedPath}`);
        const file = new File([storedFile], getPathBaseName(extractedPath, "bundle-entry.bin"), {
          lastModified: storedFile.lastModified,
          type: storedFile.type || "application/octet-stream",
        });
        Object.defineProperty(file, "filePath", { value: extractedPath });
        const release = registerBrowserSourceCleanup(file, () => removeExtractedPath(extractedPath));
        extractedCleanups.push(release);
        extractedFiles.set(extractedPath, file);
      }
      const cleanup = createCleanupOnce(async () => {
        await Promise.all(extractedCleanups.map((release) => release()));
        await browserVfs.remove(extractDirPath).catch(() => undefined);
      });
      return { cleanup, extractedFiles, result };
    } catch (error) {
      await browserVfs.remove(extractDirPath).catch(() => undefined);
      throw error;
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
