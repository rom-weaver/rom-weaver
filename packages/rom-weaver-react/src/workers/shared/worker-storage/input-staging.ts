import type { WorkerResultFile } from "../../protocol/worker-runtime-payloads.ts";
import { getWorkerPathBaseName } from "../worker-byte-utils.ts";
import { getWorkerFileExtension } from "../worker-message-utils.ts";
import { getWorkerStorageBucketPath, type WorkerStorageBucket } from "./storage-layout.ts";
import type { BlobWritingSupport, ByteWritingSupport, OpfsBackend } from "./types.ts";

type WorkerInputFile = Blob & {
  name?: string;
};
type StageWorkerInputOptions = {
  defaultExtension: string;
  defaultFileName: string;
  errorMessage: string;
  file?: WorkerInputFile | null;
  fileName?: string | number | boolean | null;
  filePath?: string | null;
  inputPath?: string | null;
  allowMountedSourcePath?: boolean;
  missingInputMessage?: string;
  mountPoint?: string;
  pathBucket?: WorkerStorageBucket;
  pathPrefix?: string;
  preferPathFileName?: boolean;
};
type StagedWorkerInput = {
  inputFile: WorkerResultFile;
  inputFileName: string;
  inputPath: string;
  inputSize: number;
};
type PathBackedInputSupport = {
  ensureNode?: (filePath: string) => boolean;
  getFile?: (filePath: string) => Promise<Blob | null>;
  linkFile?: (sourcePath: string, targetPath: string) => boolean;
  openFile?: (filePath: string) => Promise<OpfsBackend | null>;
  outputDirectory?: string;
  prepareFile?: (filePath: string) => Promise<unknown>;
};

const TRAILING_SLASHES_REGEX = /\/+$/;
const PATH_SEPARATOR_REGEX = /[\\/]+/;

const getMountedSourcePath = (output: PathBackedInputSupport, openedInput: OpfsBackend, fallbackPath: string) => {
  const outputDirectory = String(output.outputDirectory || "").replace(TRAILING_SLASHES_REGEX, "");
  const storageName = String(openedInput.storageName || "");
  if (!(outputDirectory && storageName) || storageName.startsWith("/")) return fallbackPath;
  const storageParts = storageName.split(PATH_SEPARATOR_REGEX).filter((part) => part && part !== "." && part !== "..");
  return storageParts.length ? `${outputDirectory}/${storageParts.join("/")}` : fallbackPath;
};

const isMountedOutputPath = (output: PathBackedInputSupport, filePath: string) => {
  const outputDirectory = String(output.outputDirectory || "").replace(TRAILING_SLASHES_REGEX, "");
  return !!(outputDirectory && (filePath === outputDirectory || filePath.startsWith(`${outputDirectory}/`)));
};

const getStagedWorkerInputFileName = ({
  defaultFileName,
  file,
  fileName,
  filePath,
  preferPathFileName,
}: Pick<StageWorkerInputOptions, "defaultFileName" | "file" | "fileName" | "filePath" | "preferPathFileName">) => {
  const explicitFileName = String(fileName || "");
  if (explicitFileName) return explicitFileName;
  const pathFileName = getWorkerPathBaseName(filePath || "");
  if (preferPathFileName && pathFileName) return pathFileName;
  return file?.name || pathFileName || defaultFileName;
};

const getStagedWorkerInputPath = (options: StageWorkerInputOptions, inputFileName: string) => {
  if (options.inputPath) return options.inputPath;
  if (!(options.mountPoint && options.pathPrefix)) {
    throw new Error("Worker input staging requires either inputPath or mountPoint/pathPrefix");
  }
  return getWorkerStorageBucketPath(
    options.mountPoint,
    options.pathBucket || "input",
    `${options.pathPrefix}${getWorkerFileExtension(inputFileName, options.defaultExtension)}`,
    inputFileName,
  );
};

const stageWorkerInput = async (
  output: ByteWritingSupport & BlobWritingSupport & PathBackedInputSupport,
  options: StageWorkerInputOptions,
): Promise<StagedWorkerInput> => {
  if (!(options.file || options.filePath)) throw new Error(options.missingInputMessage || "Missing worker input");
  const inputFileName = getStagedWorkerInputFileName(options);
  const inputPath = getStagedWorkerInputPath(options, inputFileName);
  const prepareLinkedPath = async (targetPath: string) =>
    output.prepareFile ? !!(await output.prepareFile(targetPath)) : true;
  if (options.filePath) {
    const sourcePath = options.filePath;
    const openedInput = output.openFile ? await output.openFile(sourcePath) : null;
    if (openedInput) {
      const mountedSourcePath = getMountedSourcePath(output, openedInput, sourcePath);
      const mountedSourceRequested =
        options.allowMountedSourcePath &&
        (mountedSourcePath !== sourcePath || isMountedOutputPath(output, mountedSourcePath));
      if (mountedSourceRequested) {
        const mountedSourceReady = output.ensureNode ? output.ensureNode(mountedSourcePath) !== false : true;
        if (mountedSourceReady) {
          return {
            inputFile: {
              fileName: inputFileName,
              fileSize: openedInput.size || 0,
            } as WorkerResultFile,
            inputFileName,
            inputPath: mountedSourcePath,
            inputSize: openedInput.size || 0,
          };
        }
      }
      const linkedInput =
        inputPath === sourcePath
          ? output.ensureNode?.(inputPath) !== false
          : (await prepareLinkedPath(inputPath)) && output.linkFile?.(sourcePath, inputPath) === true;
      if (!linkedInput && mountedSourceRequested) throw new Error(options.errorMessage);
      if (!linkedInput) {
        return {
          inputFile: {
            fileName: inputFileName,
            fileSize: openedInput.size || 0,
          } as WorkerResultFile,
          inputFileName,
          inputPath: sourcePath,
          inputSize: openedInput.size || 0,
        };
      }
      return {
        inputFile: {
          fileName: inputFileName,
          fileSize: openedInput.size || 0,
        } as WorkerResultFile,
        inputFileName,
        inputPath,
        inputSize: openedInput.size || 0,
      };
    }
    if (isMountedOutputPath(output, sourcePath)) throw new Error(options.errorMessage);
    if (inputPath === sourcePath) {
      return {
        inputFile: {
          fileName: inputFileName,
          fileSize: 0,
        } as WorkerResultFile,
        inputFileName,
        inputPath: sourcePath,
        inputSize: 0,
      };
    }
    if ((await prepareLinkedPath(inputPath)) && output.linkFile?.(sourcePath, inputPath) === true) {
      return {
        inputFile: {
          fileName: inputFileName,
          fileSize: 0,
        } as WorkerResultFile,
        inputFileName,
        inputPath,
        inputSize: 0,
      };
    }
    return {
      inputFile: {
        fileName: inputFileName,
        fileSize: 0,
      } as WorkerResultFile,
      inputFileName,
      inputPath: sourcePath,
      inputSize: 0,
    };
  }
  const inputSize = options.file?.size || 0;
  const preparedInput = await output.writeBlob(inputPath, options.file as Blob);
  if (!preparedInput) throw new Error(options.errorMessage);
  return {
    inputFile: {
      fileName: inputFileName,
      fileSize: inputSize,
    } as WorkerResultFile,
    inputFileName,
    inputPath,
    inputSize,
  };
};

export type { StagedWorkerInput, StageWorkerInputOptions };
export { stageWorkerInput };
