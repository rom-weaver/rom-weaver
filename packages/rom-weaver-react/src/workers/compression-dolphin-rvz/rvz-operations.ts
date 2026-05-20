import type { WorkerRequestData, WorkerResultFile } from "../protocol/worker-runtime-payloads.ts";
import { formatCompressionOperationLabel } from "../shared/progress/compression-labels.ts";
import { createToolNumericProgressMapper } from "../shared/progress/compression-progress.ts";
import { postCreatedFile, postExtractedFile } from "../shared/rpc/compression-result-posting.ts";
import type { EmscriptenWorkerModule } from "../shared/wasm/emscripten-types.ts";
import { getWorkerPathBaseName } from "../shared/worker-byte-utils.ts";
import type { CompressionOperationOptions } from "../shared/worker-compression-types.ts";
import { createProgressCallback } from "../shared/worker-progress-utils.ts";
import { createWorkId } from "../shared/worker-request-id.ts";
import {
  COMPRESSION_OPFS_MOUNTPOINT,
  completeBrowserDiscOutput,
  createPercentRangeProgressCallback,
  prepareBrowserOutput,
  withBrowserOutputCleanup,
} from "../shared/worker-storage/compression-output.ts";
import { stageWorkerInput } from "../shared/worker-storage/input-staging.ts";
import { getWorkerStorageBucketPath } from "../shared/worker-storage/storage-layout.ts";
import { createTimingFromStart, now } from "../shared/worker-timing.ts";
import DolphinRvzManager from "./dolphin-rvz-manager.ts";
import { waitForDolphinRvzModule } from "./dolphin-rvz-toolchain.ts";

const NON_TOOL_PROGRESS_LABELS = new Set(["done", "loading rvz tools..."]);

const mapToolNumericProgress = (mapProgress: (percent: number | null | undefined) => void) =>
  createToolNumericProgressMapper(NON_TOOL_PROGRESS_LABELS, mapProgress);

const mountDolphinRvzRuntimeStorage = (
  browserOutput: Awaited<ReturnType<typeof prepareBrowserOutput>>,
  moduleObject: EmscriptenWorkerModule,
) => {
  if (!(browserOutput && moduleObject.dolphinRvz)) return;
  browserOutput.ensureMounted?.(moduleObject.dolphinRvz as EmscriptenWorkerModule);
};

const prepareRvzOperation = async (data: WorkerRequestData, operation: "rvz-create" | "rvz-extract") => {
  const progressCallback = createProgressCallback(data.requestId);
  progressCallback({ label: "Loading RVZ tools...", percent: 0 });
  const moduleObject = await waitForDolphinRvzModule(data.threads);
  const workId = createWorkId(operation);
  const browserOutput = await prepareBrowserOutput(moduleObject, workId);
  if (!browserOutput) throw new Error("Browser-backed RVZ output is not available");
  mountDolphinRvzRuntimeStorage(browserOutput, moduleObject);
  return {
    browserOutput,
    progressCallback,
    startedAt: now(),
    workId,
  };
};

const runExtractRvz = async (data: WorkerRequestData) => {
  const { browserOutput, progressCallback, startedAt, workId } = await prepareRvzOperation(data, "rvz-extract");
  let rvzFile: WorkerResultFile | null = null;
  let inputPath: string | null = null;
  const operationLabel = formatCompressionOperationLabel("Extracting RVZ", data.threads);
  const rvzProgressCallback = progressCallback;
  // biome-ignore format: source-level regression tests assert this exact call shape.
  const mapConversionProgress = createPercentRangeProgressCallback(operationLabel, 0, 100, rvzProgressCallback,);
  const options: CompressionOperationOptions = {
    onProgress: mapToolNumericProgress(mapConversionProgress),
    outputName: data.outputName,
    outputPath: browserOutput.paths.rvzIso,
    threads: data.threads,
    workId,
  };
  await withBrowserOutputCleanup(browserOutput, async () => {
    try {
      const stagedInput = await stageWorkerInput(browserOutput, {
        allowMountedSourcePath: true,
        defaultExtension: ".rvz",
        defaultFileName: "input.rvz",
        errorMessage: "This browser cannot prepare RVZ input in the worker filesystem. Try a desktop browser.",
        file: data.rvzFile as Blob | null | undefined,
        fileName: data.rvzFileName,
        filePath: data.rvzFilePath,
        inputPath: getWorkerStorageBucketPath(
          COMPRESSION_OPFS_MOUNTPOINT,
          "input",
          `rvz-input-${workId}.rvz`,
          `rvz-input-${workId}.rvz`,
        ),
        missingInputMessage: "Missing worker-backed RVZ input",
        preferPathFileName: true,
      });
      inputPath = stagedInput.inputPath;
      options.inputPath = inputPath;
      rvzFile = {
        ...stagedInput.inputFile,
        _archiveEntryName: data.archiveEntryName,
        _archiveFileName: data.archiveFileName,
      };
      if (data.archiveEntryName) rvzFile._archiveEntryName = data.archiveEntryName;
      if (data.archiveFileName) rvzFile._archiveFileName = data.archiveFileName;
      options.readOutput = false;
      const extractedFile = (await DolphinRvzManager.rvzToIso(rvzFile, options)) as WorkerResultFile;
      await completeBrowserDiscOutput({
        browserOutput,
        operationLabel,
        outputPath: extractedFile._rvzOutputPath,
        postResult: postExtractedFile,
        progressCallback: rvzProgressCallback,
        requestId: data.requestId,
        resultFile: extractedFile,
        timing: createTimingFromStart(startedAt),
      });
    } finally {
      if (data.rvzFilePath) browserOutput.releaseFile?.(data.rvzFilePath);
    }
  });
};

const runCreateRvz = async (data: WorkerRequestData) => {
  const { browserOutput, progressCallback, startedAt, workId } = await prepareRvzOperation(data, "rvz-create");
  let inputPath: string | null = null;
  let inputSize = 0;
  const operationLabel = formatCompressionOperationLabel("Compressing RVZ", data.threads);
  const rvzProgressCallback = progressCallback;
  // biome-ignore format: source-level regression tests assert this exact call shape.
  const mapConversionProgress = createPercentRangeProgressCallback(operationLabel, 0, 100, rvzProgressCallback,);
  await withBrowserOutputCleanup(browserOutput, async () => {
    try {
      const stagedInput = await stageWorkerInput(browserOutput, {
        allowMountedSourcePath: true,
        defaultExtension: ".iso",
        defaultFileName: "input.iso",
        errorMessage: "This browser cannot prepare RVZ input in the worker filesystem.",
        file: data.imageFile as Blob | null | undefined,
        fileName: data.fileName,
        filePath: data.imageFilePath,
        missingInputMessage: "Missing RVZ creation input",
        mountPoint: COMPRESSION_OPFS_MOUNTPOINT,
        pathBucket: "input",
        pathPrefix: `rvz-create-input-${workId}`,
        preferPathFileName: true,
      });
      inputPath = stagedInput.inputPath;
      inputSize = stagedInput.inputSize;
      const imageFile: WorkerResultFile = stagedInput.inputFile;
      if (data.rvzSourceFileName) imageFile._rvzSourceFileName = data.rvzSourceFileName;
      if (data.rvzMode) imageFile._rvzMode = data.rvzMode;
      const rvzFile = (await DolphinRvzManager.isoToRvz(imageFile, {
        blockSize: data.rvzBlockSize,
        compression: data.rvzCompression,
        compressionLevel: data.rvzCompressionLevel,
        inputPath,
        inputSize: inputSize || imageFile.fileSize,
        onProgress: mapToolNumericProgress(mapConversionProgress),
        outputName: data.outputName,
        outputPath: browserOutput.paths.createRvz,
        readOutput: false,
        removeInput: false,
        scrub: data.rvzScrub,
        threads: data.threads,
      })) as WorkerResultFile;
      await completeBrowserDiscOutput({
        browserOutput,
        operationLabel,
        outputPath: rvzFile._rvzOutputPath,
        postResult: postCreatedFile,
        progressCallback: rvzProgressCallback,
        requestId: data.requestId,
        resultFile: rvzFile,
        timing: createTimingFromStart(startedAt),
      });
    } finally {
      if (data.imageFilePath) browserOutput.releaseFile?.(data.imageFilePath);
    }
  });
};

const runListRvz = async (data: WorkerRequestData) => {
  const sourceFileName =
    data.rvzFileName ||
    data.rvzFile?.name ||
    (data.rvzFilePath ? getWorkerPathBaseName(data.rvzFilePath) : "") ||
    "input.rvz";
  const extractedFileName = DolphinRvzManager.getExtractedFileName({ fileName: sourceFileName });
  return [{ archiveEntryType: "rom", fileName: extractedFileName, filename: extractedFileName }];
};

export { runCreateRvz, runExtractRvz, runListRvz };
