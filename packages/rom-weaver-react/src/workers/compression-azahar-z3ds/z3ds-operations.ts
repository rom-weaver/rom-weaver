import type { WorkerRequestData, WorkerResultFile } from "../protocol/worker-runtime-payloads.ts";
import { formatCompressionOperationLabel } from "../shared/progress/compression-labels.ts";
import { postCreatedFile, postExtractedFile } from "../shared/rpc/compression-result-posting.ts";
import { getWorkerPathBaseName } from "../shared/worker-byte-utils.ts";
import { createProgressCallback } from "../shared/worker-progress-utils.ts";
import { createWorkId } from "../shared/worker-request-id.ts";
import {
  completeBrowserDiscOutput,
  prepareBrowserOutput,
  withBrowserOutputCleanup,
} from "../shared/worker-storage/compression-output.ts";
import { stageWorkerInput } from "../shared/worker-storage/input-staging.ts";
import { getWorkerStorageBucketPath } from "../shared/worker-storage/storage-layout.ts";
import { createTimingFromStart, now } from "../shared/worker-timing.ts";
import { waitForAzaharZ3dsModule } from "./azahar-z3ds-toolchain.ts";
import Z3dsManager from "./z3ds-manager.ts";

const prepareZ3dsOperation = async (data: WorkerRequestData, actionLabel: "Compressing Z3DS" | "Extracting Z3DS") => {
  const progressCallback = createProgressCallback(data.requestId);
  progressCallback({ label: "Loading Z3DS tools...", percent: 0 });
  const moduleObject = await waitForAzaharZ3dsModule(data.threads);
  const startedAt = now();
  progressCallback({ label: formatCompressionOperationLabel(actionLabel, data.threads), percent: null });
  return { moduleObject, progressCallback, startedAt };
};

const prepareZ3dsOutput = async (moduleObject: Awaited<ReturnType<typeof waitForAzaharZ3dsModule>>, workId: string) => {
  const manager = await prepareBrowserOutput(moduleObject, workId);
  if (!manager) throw new Error("Worker-backed Z3DS output is not available");
  return manager;
};

const getZ3dsSourceFileName = (
  fileName: string | null | undefined,
  filePath: string | null | undefined,
  file: Blob | File | null | undefined,
  fallbackFileName: string,
) =>
  fileName ||
  (filePath ? getWorkerPathBaseName(filePath) : "") ||
  (file as { name?: string } | null | undefined)?.name ||
  "" ||
  fallbackFileName;

const runExtractZ3ds = async (data: WorkerRequestData) => {
  const { moduleObject, progressCallback, startedAt } = await prepareZ3dsOperation(data, "Extracting Z3DS");
  const workId = createWorkId("z3ds-extract");
  const z3dsOutput = await prepareZ3dsOutput(moduleObject, workId);
  await withBrowserOutputCleanup(z3dsOutput, async () => {
    const stagedInput = await stageWorkerInput(z3dsOutput, {
      allowMountedSourcePath: true,
      defaultExtension: ".z3ds",
      defaultFileName: "input.z3ds",
      errorMessage: "This browser cannot prepare Z3DS input in the worker filesystem.",
      file: data.z3dsFile as Blob | null | undefined,
      fileName: data.z3dsFileName,
      filePath: data.z3dsFilePath,
      inputPath: getWorkerStorageBucketPath(
        z3dsOutput.outputDirectory,
        "input",
        `z3ds-input-${workId}.z3ds`,
        `z3ds-input-${workId}.z3ds`,
      ),
      missingInputMessage: "Missing Z3DS input",
      preferPathFileName: true,
    });
    const z3dsFile = {
      _archiveEntryName: data.archiveEntryName,
      _archiveFileName: data.archiveFileName,
      fileName: getZ3dsSourceFileName(data.z3dsFileName, data.z3dsFilePath, data.z3dsFile, "input.z3ds"),
      fileSize: stagedInput.inputSize,
    };
    const extractedFile = (await Z3dsManager.decompress(z3dsFile, {
      archiveFileName: data.archiveFileName,
      inputPath: stagedInput.inputPath,
      onProgress: progressCallback,
      outputName: data.outputName,
      outputPath: z3dsOutput.paths.bin,
      readOutput: false,
      threads: data.threads,
    })) as WorkerResultFile;
    extractedFile._archiveEntryName = data.archiveEntryName;
    extractedFile._archiveFileName = data.archiveFileName;
    await completeBrowserDiscOutput({
      browserOutput: z3dsOutput,
      operationLabel: formatCompressionOperationLabel("Extracting Z3DS", data.threads),
      outputPath: z3dsOutput.paths.bin,
      postResult: postExtractedFile,
      progressCallback,
      requestId: data.requestId,
      resultFile: extractedFile,
      timing: createTimingFromStart(startedAt),
    });
  });
};

const runCreateZ3ds = async (data: WorkerRequestData) => {
  const { moduleObject, progressCallback, startedAt } = await prepareZ3dsOperation(data, "Compressing Z3DS");
  const workId = createWorkId("z3ds-create");
  const z3dsOutput = await prepareZ3dsOutput(moduleObject, workId);
  await withBrowserOutputCleanup(z3dsOutput, async () => {
    const stagedInput = await stageWorkerInput(z3dsOutput, {
      allowMountedSourcePath: true,
      defaultExtension: ".bin",
      defaultFileName: "input.bin",
      errorMessage: "This browser cannot prepare Z3DS input in the worker filesystem.",
      file: data.imageFile as Blob | null | undefined,
      fileName: data.fileName,
      filePath: data.imageFilePath,
      inputPath: getWorkerStorageBucketPath(
        z3dsOutput.outputDirectory,
        "input",
        `z3ds-create-input-${workId}.bin`,
        `z3ds-create-input-${workId}.bin`,
      ),
      missingInputMessage: "Missing Z3DS creation input",
      preferPathFileName: true,
    });
    const imageFile = {
      _z3dsMetadata: data.z3dsMetadata,
      _z3dsSourceFileName: data.z3dsSourceFileName,
      _z3dsUnderlyingMagic: data.z3dsUnderlyingMagic,
      fileName: getZ3dsSourceFileName(data.fileName, data.imageFilePath, data.imageFile, "input.bin"),
      fileSize: stagedInput.inputSize,
    };
    const z3dsFile = (await Z3dsManager.compress(imageFile, {
      compressionLevel: data.z3dsCompressionLevel,
      inputPath: stagedInput.inputPath,
      metadata: data.z3dsMetadata,
      onProgress: progressCallback,
      outputName: data.outputName,
      outputPath: z3dsOutput.paths.bin,
      readOutput: false,
      threads: data.threads,
      underlyingMagic: data.z3dsUnderlyingMagic,
    })) as WorkerResultFile;
    await completeBrowserDiscOutput({
      browserOutput: z3dsOutput,
      operationLabel: formatCompressionOperationLabel("Compressing Z3DS", data.threads),
      outputPath: z3dsOutput.paths.bin,
      postResult: postCreatedFile,
      progressCallback,
      requestId: data.requestId,
      resultFile: z3dsFile,
      timing: createTimingFromStart(startedAt),
    });
  });
};

const runListZ3ds = async (data: WorkerRequestData) => {
  const sourceFileName =
    data.z3dsFileName ||
    data.z3dsFile?.name ||
    (data.z3dsFilePath ? getWorkerPathBaseName(data.z3dsFilePath) : "") ||
    "input.z3ds";
  const extractedFileName = Z3dsManager.getExtractedFileName({
    _z3dsUnderlyingMagic: data.z3dsUnderlyingMagic,
    fileName: sourceFileName,
  });
  return [{ archiveEntryType: "rom", fileName: extractedFileName, filename: extractedFileName }];
};

export { runCreateZ3ds, runExtractZ3ds, runListZ3ds };
