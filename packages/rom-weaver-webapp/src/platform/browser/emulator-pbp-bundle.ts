import { OUT_OF_MEMORY_MESSAGE_REGEX, RomWeaverError, throwIfAborted } from "../../lib/errors.ts";
import { createRomWeaverOutputScope } from "../../lib/runtime/run-output-paths.ts";
import { toRomWeaverOptions } from "../../lib/runtime/run-options.ts";
import { ensureRomWeaverSuccess } from "../../lib/runtime/run-result-parsing.ts";
import { invokeRomWeaverChecksumWorker } from "../../lib/runtime/wasm-checksum-command.ts";
import { invokeRomWeaverExtractAllWorker } from "../../lib/runtime/wasm-compression-commands.ts";
import { relaySimpleProgress, runRomWeaverJson } from "../../lib/runtime/wasm-command-shared.ts";
import { withBrowserOutputStorageFailureContext } from "../../storage/browser/browser-output-storage-guard.ts";
import { joinVfsPath } from "../../storage/vfs/path.ts";
import { readRuntimeOutputBlob } from "../../storage/vfs/runtime-output.ts";
import type { RuntimeWorkerIo } from "../../types/workflow-runtime-adapter.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import { browserVfs } from "./workflow-runtime-vfs-cleanup.ts";

type PbpBundleOptions = {
  onProgress?: Parameters<typeof invokeRomWeaverExtractAllWorker>[1];
  signal?: AbortSignal;
};

const preparePbpEmulatorBundle = async (
  workerIo: RuntimeWorkerIo,
  source: Blob,
  _fileName: string,
  discCount: number,
  options: PbpBundleOptions = {},
) => {
  const scope = createRomWeaverOutputScope();
  let staged: Awaited<ReturnType<RuntimeWorkerIo["stageSource"]>> | undefined;
  try {
    throwIfAborted(options.signal);
    staged = await workerIo.stageSource({
      fallbackFileName: "game.pbp",
      pathPrefix: "emulator-pbp",
      scope: "archive",
      source: new File([source], "game.pbp", { type: source.type }),
    });
    throwIfAborted(options.signal);
    const extracted = await invokeRomWeaverExtractAllWorker(
      {
        inputPath: staged.filePath,
        outDirPath: joinVfsPath(scope.rootPath, "discs"),
        interactiveSelectionEnabled: false,
        knownInputPaths: [staged.filePath],
        noIgnore: true,
        signal: options.signal,
      },
      options.onProgress,
    );
    throwIfAborted(options.signal);
    const cues = extracted.filter((entry) => /\.cue$/i.test(entry.fileName || ""));
    const bins = extracted.filter((entry) => /\.bin$/i.test(entry.fileName || ""));
    if (
      cues.length !== discCount ||
      bins.length !== discCount ||
      extracted.length !== discCount * 2 ||
      new Set(extracted.map((entry) => entry.filePath)).size !== extracted.length
    ) {
      throw new Error(`PBP extraction did not return every disc and cue sheet (${discCount} discs expected).`);
    }
    const sizes = await Promise.all(
      extracted.map(async (entry) => {
        const size = entry.size ?? (await browserVfs.stat(entry.filePath))?.size;
        if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
          throw new Error("PBP extraction did not report every disc's complete size.");
        return size;
      }),
    );
    const expandedSizeBytes = sizes.reduce((total, size) => total + size, 0);
    const checksumSource = discCount === 1 ? bins[0]?.filePath : staged.filePath;
    if (!checksumSource) throw new Error("PBP extraction returned no disc to checksum.");
    const { checksums } = await invokeRomWeaverChecksumWorker({
      algorithms: ["sha1"],
      autoExtract: false,
      onProgress: options.onProgress,
      signal: options.signal,
      sourcePath: checksumSource,
    });
    throwIfAborted(options.signal);
    // The archive stem becomes the playlist stem, which names the core's save file; a shared stem would share one memory card.
    const bundleStem = (checksums.sha1 ?? "").toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(bundleStem)) throw new Error("PBP extraction returned no SHA-1 checksum.");
    const archivePath = joinVfsPath(scope.rootPath, `${bundleStem}.zip`);
    const result = await runRomWeaverJson(
      createRomWeaverCommand("playlist", {
        input: cues.map((entry) => entry.filePath),
        output: archivePath,
        layout: "flat",
        staged_paths: Object.fromEntries(extracted.map((entry) => [entry.filePath, entry.filePath])),
      }),
      toRomWeaverOptions({
        interactiveSelectionEnabled: false,
        invalidateMountCacheBeforeRun: true,
        knownInputPaths: extracted.map((entry) => entry.filePath),
        onEvent: relaySimpleProgress(options.onProgress),
        signal: options.signal,
      }),
    );
    ensureRomWeaverSuccess(result, "Could not prepare the PBP disc playlist.");
    throwIfAborted(options.signal);
    const stat = await browserVfs.stat(archivePath);
    const archiveSize = stat?.size ?? 0;
    if (!Number.isSafeInteger(archiveSize) || archiveSize <= 0)
      throw new Error("The PBP disc playlist archive is missing or empty.");
    const blob = await readRuntimeOutputBlob(
      { path: archivePath, size: archiveSize, vfs: browserVfs, mediaType: "application/zip" },
      options.signal,
    );
    throwIfAborted(options.signal);
    return { blob, checksum: checksums.sha1, expandedSizeBytes };
  } catch (error) {
    const storageError = await withBrowserOutputStorageFailureContext(error, { operationLabel: "Preparing PBP discs" });
    if (storageError !== error || (error instanceof DOMException && error.name === "QuotaExceededError")) {
      throw new RomWeaverError(
        "OUTPUT_WRITE_FAILED",
        "There is not enough browser storage to prepare every PBP disc. Free browser storage and try again.",
        { cause: error },
      );
    }
    if (error instanceof RangeError || (error instanceof Error && OUT_OF_MEMORY_MESSAGE_REGEX.test(error.message))) {
      throw new RomWeaverError(
        "WORKER_FAILED",
        "This PBP needs more memory to prepare all of its discs. Close other games or try a browser with more memory.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    await scope.cleanup().catch(() => undefined);
    await staged?.cleanup().catch(() => undefined);
  }
};

export { preparePbpEmulatorBundle };
