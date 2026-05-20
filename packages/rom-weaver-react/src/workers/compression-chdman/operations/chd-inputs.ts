import type { WorkerRequestData, WorkerResultFile } from "../../protocol/worker-runtime-payloads.ts";
import type { EmscriptenWorkerModule } from "../../shared/wasm/emscripten-types.ts";
import { encodeWorkerText, getWorkerPathBaseName } from "../../shared/worker-byte-utils.ts";
import type { ChdInfo } from "../../shared/worker-compression-types.ts";
import {
  COMPRESSION_OPFS_MOUNTPOINT,
  normalizeRelativeFilePath,
  type prepareBrowserOutput,
} from "../../shared/worker-storage/compression-output.ts";
import { stageWorkerInput } from "../../shared/worker-storage/input-staging.ts";
import { getWorkerStorageBucketPath } from "../../shared/worker-storage/storage-layout.ts";
import ChdManager from "../chd-manager.ts";

const DISC_TRACK_EXTENSION_REGEX = /\.(cue|bin)$/i;

const getCreateMode = (data: WorkerRequestData, fileName: string | number | boolean | null | undefined) => {
  const mode = data.mode || "auto";
  if (mode !== "auto") return mode;
  if (data.chdMode === "cd" || data.chdMode === "dvd") return data.chdMode;
  return DISC_TRACK_EXTENSION_REGEX.test(String(fileName || "")) ? "cd" : "dvd";
};

const inspectChdInput = (moduleObject: EmscriptenWorkerModule, inputPath: string | null) => {
  const chdman = moduleObject?.wasmTool;
  if (!chdman || typeof chdman.run !== "function" || !inputPath) return Promise.resolve(null);
  return chdman
    .run(["info", "-i", inputPath])
    .then((result) => {
      if (result.status !== 0) return null;
      return ChdManager.parseChdInfo(result.stdout) as ChdInfo;
    })
    .catch(() => null);
};

const stageCueInputs = async (
  data: WorkerRequestData,
  browserOutput: Awaited<ReturnType<typeof prepareBrowserOutput>>,
  workId: string,
) => {
  if (!(browserOutput && data.imageFiles && data.chdCueText)) return null;
  const inputDirectory = getWorkerStorageBucketPath(
    COMPRESSION_OPFS_MOUNTPOINT,
    "input",
    `create-input-${workId}`,
    `create-input-${workId}`,
  );
  const cueFileName = normalizeRelativeFilePath(data.cueInputFileName || "disc.cue", "disc.cue");
  const inputPath = `${inputDirectory}/${cueFileName}`;
  let inputSize = 0;
  const cueBytes = encodeWorkerText(data.chdCueText);
  const preparedCue = await browserOutput.writeFile(inputPath, cueBytes);
  if (!preparedCue) throw new Error("This browser cannot prepare CHD CUE input in the worker filesystem.");
  for (let i = 0; i < data.imageFiles.length; i++) {
    const entry = data.imageFiles[i];
    if (!(entry?.file || entry?.filePath)) throw new Error("Missing CHD CUE track input");
    const trackFileName = entry.fileName || entry.file?.name || getWorkerPathBaseName(entry.filePath || "");
    const trackPath = `${inputDirectory}/${normalizeRelativeFilePath(trackFileName, `track-${i + 1}.bin`)}`;
    const stagedTrack = await stageWorkerInput(browserOutput, {
      defaultExtension: ".bin",
      defaultFileName: `track-${i + 1}.bin`,
      errorMessage: "This browser cannot prepare CHD CUE track input in the worker filesystem.",
      file: entry.file as Blob | null | undefined,
      fileName: trackFileName,
      filePath: entry.filePath,
      inputPath: trackPath,
      preferPathFileName: true,
    });
    inputSize += stagedTrack.inputSize || entry.file?.size || 0;
  }
  return {
    cueInputPath: null,
    imageFile: {
      fileName: data.cueInputFileName || "disc.cue",
      fileSize: inputSize,
    } as WorkerResultFile,
    inputPath,
    inputSize,
  };
};

const stageImageInput = async (
  data: WorkerRequestData,
  browserOutput: Awaited<ReturnType<typeof prepareBrowserOutput>>,
  workId: string,
) => {
  if (!(browserOutput && (data.imageFile || data.imageFilePath))) return null;
  const stagedInput = await stageWorkerInput(browserOutput, {
    allowMountedSourcePath: true,
    defaultExtension: ".bin",
    defaultFileName: "input.bin",
    errorMessage: "This browser cannot prepare CHD input in the worker filesystem.",
    file: data.imageFile as Blob | null | undefined,
    fileName: data.fileName,
    filePath: data.imageFilePath,
    mountPoint: COMPRESSION_OPFS_MOUNTPOINT,
    pathBucket: "input",
    pathPrefix: `create-input-${workId}`,
  });
  const { inputFileName, inputPath, inputSize } = stagedInput;
  let cueInputPath: string | null = null;
  if (data.chdCueText && getCreateMode(data, inputFileName) === "cd") {
    cueInputPath = getWorkerStorageBucketPath(
      COMPRESSION_OPFS_MOUNTPOINT,
      "input",
      `create-input-${workId}.cue`,
      `create-input-${workId}.cue`,
    );
    const cueText = ChdManager.replaceCuePatchFileName(String(data.chdCueText), getWorkerPathBaseName(inputPath));
    const cueBytes = encodeWorkerText(cueText);
    const preparedCue = await browserOutput.writeFile(cueInputPath, cueBytes);
    if (!preparedCue) throw new Error("This browser cannot prepare CHD CUE input in the worker filesystem.");
  }
  return {
    cueInputPath,
    imageFile: stagedInput.inputFile,
    inputPath,
    inputSize,
  };
};

export { getCreateMode, inspectChdInput, stageCueInputs, stageImageInput };
