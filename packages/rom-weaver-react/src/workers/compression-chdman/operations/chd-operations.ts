import type { WorkerRequestData, WorkerResultFile } from "../../protocol/worker-runtime-payloads.ts";
import { formatCompressionOperationLabel } from "../../shared/progress/compression-labels.ts";
import { createToolNumericProgressMapper } from "../../shared/progress/compression-progress.ts";
import { postCreatedFile, postExtractedFile } from "../../shared/rpc/compression-result-posting.ts";
import { getWorkerPathBaseName } from "../../shared/worker-byte-utils.ts";
import type { CompressionOperationOptions } from "../../shared/worker-compression-types.ts";
import { createProgressCallback } from "../../shared/worker-progress-utils.ts";
import { createWorkId } from "../../shared/worker-request-id.ts";
import {
  COMPRESSION_OPFS_MOUNTPOINT,
  completeBrowserDiscOutput,
  createPercentRangeProgressCallback,
  getCompressionSourceDisplayFileName,
  prepareBrowserOutput,
  withBrowserOutputCleanup,
} from "../../shared/worker-storage/compression-output.ts";
import { stageWorkerInput } from "../../shared/worker-storage/input-staging.ts";
import { getWorkerStorageBucketPath, getWorkerStorageBucketRoot } from "../../shared/worker-storage/storage-layout.ts";
import { createTimingFromStart, now } from "../../shared/worker-timing.ts";
import ChdManager from "../chd-manager.ts";
import { waitForChdmanModule } from "../chdman-toolchain.ts";
import { getCreateMode, inspectChdInput, stageCueInputs, stageImageInput } from "./chd-inputs.ts";

const FILE_EXTENSION_REGEX = /\.[^./\\]+$/;

const getChdOperationLabel = (
  action: "Compressing" | "Extracting",
  mode: string | null | undefined,
  threads: WorkerRequestData["threads"],
) => {
  const typeLabel =
    mode === "cd"
      ? "CD "
      : (() => {
          if (mode === "dvd") {
            return "DVD ";
          }
          if (mode === "hd") {
            return "hard disk ";
          }
          if (mode === "raw") {
            return "raw ";
          }
          return "";
        })();
  return formatCompressionOperationLabel(`${action} ${typeLabel}CHD`, threads);
};

const IGNORED_CHD_NUMERIC_PROGRESS_LABELS = new Set(["done", "inspecting chd...", "loading chd tools..."]);

const normalizeChdProgressPercent = (percent: number | null | undefined) => {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return percent;
  return Math.max(0, Math.min(100, Math.floor(percent)));
};

const mapChdNumericProgress = (mapProgress: (percent: number | null | undefined) => void) =>
  createToolNumericProgressMapper(IGNORED_CHD_NUMERIC_PROGRESS_LABELS, (percent) =>
    mapProgress(normalizeChdProgressPercent(percent)),
  );

const CHD_OUTPUT_DIRECTORY = getWorkerStorageBucketRoot(COMPRESSION_OPFS_MOUNTPOINT, "output");

const prepareChdOperation = async (data: WorkerRequestData, operation: "create" | "extract") => {
  const progressCallback = createProgressCallback(data.requestId);
  progressCallback({
    hasProgress: false,
    label: "Loading CHD tools...",
    percent: null,
  });
  const moduleObject = await waitForChdmanModule(data.threads);
  const workId = createWorkId(operation);
  const browserOutput = await prepareBrowserOutput(moduleObject, workId);
  if (!browserOutput) throw new Error("Worker-backed CHD output storage is not available");
  return {
    browserOutput,
    moduleObject,
    progressCallback,
    startedAt: now(),
    workId,
  };
};

const prepareChdListOperation = async (data: WorkerRequestData) => {
  const progressCallback = createProgressCallback(data.requestId);
  progressCallback({
    hasProgress: false,
    label: "Loading CHD tools...",
    percent: null,
  });
  const moduleObject = await waitForChdmanModule(data.threads);
  const workId = createWorkId("list");
  const browserOutput = await prepareBrowserOutput(moduleObject, workId, []);
  if (!browserOutput) throw new Error("Worker-backed CHD output storage is not available");
  return {
    browserOutput,
    moduleObject,
    progressCallback,
    workId,
  };
};

const runCreate = async (data: WorkerRequestData) => {
  const { browserOutput, progressCallback, startedAt, workId } = await prepareChdOperation(data, "create");
  const operationLabel = getChdOperationLabel(
    "Compressing",
    getCreateMode(data, data.cueInputFileName || data.fileName || data.imageFile?.name),
    data.threads,
  );
  const chdProgressCallback = progressCallback;
  const mapConversionProgress = createPercentRangeProgressCallback(operationLabel, 0, 100, chdProgressCallback);
  await withBrowserOutputCleanup(browserOutput, async () => {
    try {
      const stagedInput =
        data.imageFiles && data.chdCueText
          ? await stageCueInputs(data, browserOutput, workId)
          : await stageImageInput(data, browserOutput, workId);
      if (!stagedInput) throw new Error("Missing CHD creation input");
      const imageFile = stagedInput.imageFile;
      imageFile.fileName = data.fileName || imageFile.fileName;
      if (data.chdMode) imageFile._chdMode = data.chdMode;
      if (data.chdCueText) imageFile._chdCueText = data.chdCueText;
      const chdFile = (await ChdManager.createFromImage(
        imageFile as object as Parameters<typeof ChdManager.createFromImage>[0],
        {
          compressionCodecs: data.compressionCodecs,
          cueInputPath: stagedInput.cueInputPath || (data.imageFiles && data.chdCueText ? stagedInput.inputPath : null),
          cueText: stagedInput.cueInputPath ? undefined : data.chdCueText,
          inputPath: stagedInput.inputPath,
          inputSize: stagedInput.inputSize || imageFile.fileSize,
          mode: data.mode || "auto",
          onProgress: mapChdNumericProgress(mapConversionProgress),
          outputDirectory: CHD_OUTPUT_DIRECTORY,
          outputName: data.outputName,
          readOutput: false,
          threads: data.threads,
          workId,
        } as object as Parameters<typeof ChdManager.createFromImage>[1],
      )) as WorkerResultFile;
      await completeBrowserDiscOutput({
        browserOutput,
        operationLabel,
        outputPath: chdFile._chdOutputPath,
        postResult: postCreatedFile,
        progressCallback: chdProgressCallback,
        requestId: data.requestId,
        resultFile: chdFile,
        timing: createTimingFromStart(startedAt),
      });
    } finally {
      if (data.imageFilePath) browserOutput.releaseFile?.(data.imageFilePath);
    }
  });
};

const runExtract = async (data: WorkerRequestData) => {
  const { browserOutput, moduleObject, progressCallback, startedAt, workId } = await prepareChdOperation(
    data,
    "extract",
  );
  const options: CompressionOperationOptions = {
    mode: data.mode || "auto",
    onProgress: progressCallback,
    outputDirectory: CHD_OUTPUT_DIRECTORY,
    outputName: data.outputName,
    threads: data.threads,
    workId,
  };
  await withBrowserOutputCleanup(browserOutput, async () => {
    try {
      const stagedInput = await stageWorkerInput(browserOutput, {
        allowMountedSourcePath: true,
        defaultExtension: ".chd",
        defaultFileName: "input.chd",
        errorMessage: "This browser cannot prepare CHD input in the worker filesystem. Try a desktop browser.",
        file: data.chdFile as Blob | null | undefined,
        fileName: data.chdFileName,
        filePath: data.chdFilePath,
        inputPath: getWorkerStorageBucketPath(
          COMPRESSION_OPFS_MOUNTPOINT,
          "input",
          `input-${workId}.chd`,
          `input-${workId}.chd`,
        ),
        missingInputMessage: "Missing worker-backed CHD input",
        preferPathFileName: true,
      });
      const inputPath = stagedInput.inputPath;
      options.inputPath = inputPath;
      const chdFile: WorkerResultFile = {
        _archiveEntryName: data.archiveEntryName,
        _archiveFileName: data.archiveFileName,
        fileName:
          data.chdFileName ||
          data.chdFile?.name ||
          (data.chdFilePath ? getWorkerPathBaseName(data.chdFilePath) : null) ||
          "input.chd",
        fileSize: stagedInput.inputSize,
      };
      progressCallback({
        hasProgress: false,
        label: "Inspecting CHD...",
        percent: null,
      });
      const chdInfo = await inspectChdInput(moduleObject, inputPath);
      if (chdInfo) options.chdInfo = chdInfo;
      if ((data.mode || "auto") === "auto" && chdInfo?.type) options.mode = chdInfo.type;
      progressCallback({
        hasProgress: false,
        label: "Inspecting CHD...",
        percent: null,
        resolvedFileName: ChdManager.getExtractedFileName({
          _chdMode: options.mode,
          fileName: chdFile.fileName,
        }),
        sourceDisplayFileName: getCompressionSourceDisplayFileName(
          data.chdFileName,
          data.archiveEntryName,
          data.archiveFileName,
        ),
      });
      const operationLabel = getChdOperationLabel("Extracting", options.mode, data.threads);
      const chdProgressCallback = progressCallback;
      const mapExtractionProgress = createPercentRangeProgressCallback(operationLabel, 0, 100, chdProgressCallback);
      let maxReportedExtractionPercent = 0;
      const reportExtractionProgress = (percent: number | null | undefined) => {
        const normalizedPercent = normalizeChdProgressPercent(percent);
        if (typeof normalizedPercent !== "number" || !Number.isFinite(normalizedPercent)) return;
        if (normalizedPercent <= maxReportedExtractionPercent) return;
        maxReportedExtractionPercent = normalizedPercent;
        mapExtractionProgress(normalizedPercent);
      };
      options.readOutput = false;
      options.onProgress = mapChdNumericProgress(reportExtractionProgress);
      const extractedFile = (await ChdManager.extractToIso(
        chdFile as object as Parameters<typeof ChdManager.extractToIso>[0],
        options as object as Parameters<typeof ChdManager.extractToIso>[1],
      )) as WorkerResultFile;
      await completeBrowserDiscOutput({
        browserOutput,
        operationLabel,
        outputPath: extractedFile._chdOutputPath,
        postResult: postExtractedFile,
        progressCallback: chdProgressCallback,
        requestId: data.requestId,
        resultFile: extractedFile,
        timing: createTimingFromStart(startedAt),
      });
    } finally {
      if (data.chdFilePath) browserOutput.releaseFile?.(data.chdFilePath);
    }
  });
};

const replaceFileExtension = (fileName: string, extension: string) =>
  FILE_EXTENSION_REGEX.test(fileName)
    ? fileName.replace(FILE_EXTENSION_REGEX, `.${extension}`)
    : `${fileName}.${extension}`;

const runList = async (data: WorkerRequestData) => {
  const { browserOutput, moduleObject, progressCallback, workId } = await prepareChdListOperation(data);
  return withBrowserOutputCleanup(browserOutput, async () => {
    const stagedInput = await stageWorkerInput(browserOutput, {
      allowMountedSourcePath: true,
      defaultExtension: ".chd",
      defaultFileName: "input.chd",
      errorMessage: "This browser cannot prepare CHD input in the worker filesystem. Try a desktop browser.",
      file: data.chdFile as Blob | null | undefined,
      fileName: data.chdFileName,
      filePath: data.chdFilePath,
      inputPath: getWorkerStorageBucketPath(
        COMPRESSION_OPFS_MOUNTPOINT,
        "input",
        `input-${workId}.chd`,
        `input-${workId}.chd`,
      ),
      missingInputMessage: "Missing worker-backed CHD input",
      preferPathFileName: true,
    });
    try {
      const sourceFileName =
        data.chdFileName ||
        data.chdFile?.name ||
        (data.chdFilePath ? getWorkerPathBaseName(data.chdFilePath) : "") ||
        "input.chd";
      progressCallback({
        hasProgress: false,
        label: "Inspecting CHD...",
        percent: null,
      });
      const chdInfo = await inspectChdInput(moduleObject, stagedInput.inputPath);
      const mode = (data.mode || "auto") === "auto" ? chdInfo?.type || "raw" : String(data.mode || "raw");
      const extractedFileName = ChdManager.getExtractedFileName({
        _chdMode: mode,
        fileName: sourceFileName,
      });
      if (mode === "cd") {
        const cueFileName = replaceFileExtension(extractedFileName, "cue");
        return [
          { archiveEntryType: "cue", fileName: cueFileName, filename: cueFileName },
          { archiveEntryType: "track", fileName: extractedFileName, filename: extractedFileName },
        ];
      }
      return [{ archiveEntryType: "rom", fileName: extractedFileName, filename: extractedFileName }];
    } finally {
      if (data.chdFilePath) browserOutput.releaseFile?.(data.chdFilePath);
      if (data.chdFile || stagedInput.inputPath !== data.chdFilePath) {
        await browserOutput.cleanup([stagedInput.inputPath]).catch(() => undefined);
      }
    }
  });
};

export { runCreate, runExtract, runList };
