import type { LogRecord } from "../../types/logging.ts";
import type { ProgressCallback } from "../../types/runtime.ts";
import {
  createApplyPatchWorkerClient,
  createCreatePatchWorkerClient,
  createParsePatchWorkerClient,
} from "./worker-clients.ts";
import { createPatchWorkerInstance } from "./worker-factories.ts";
import type {
  BrowserApplyPatchWorkerInput,
  BrowserApplyPatchWorkerResult,
  BrowserCreatePatchWorkerInput,
  BrowserCreatePatchWorkerResult,
  BrowserParsePatchWorkerInput,
  BrowserParsePatchWorkerResult,
} from "./worker-protocol.ts";

type NodeCreatePatchWorkerInput = {
  format: string;
  logLevel?: string;
  metadata?: BrowserCreatePatchWorkerInput["metadata"];
  modifiedFileName: string;
  modifiedFilePath?: string;
  originalFileName: string;
  originalFilePath?: string;
  outputName: string;
  workerThreads?: number | string;
};
type NodeApplyPatchWorkerInput = {
  logLevel?: string;
  options?: BrowserApplyPatchWorkerInput["options"];
  patchFileName: string;
  patchFilePath?: string;
  patchFiles?: Array<{ patchFileName?: string; patchFilePath: string }>;
  romFileName: string;
  romFilePath: string;
};

const CREATE_PATCH_WORKER_ERROR = "Create patch worker failed to load or crashed.";
const APPLY_PATCH_WORKER_ERROR = "Apply patch worker failed to load or crashed.";
const PARSE_PATCH_WORKER_ERROR = "Parse patch worker failed to load or crashed.";

const createPatchWorkerClient = createCreatePatchWorkerClient(createPatchWorkerInstance);
const applyPatchWorkerClient = createApplyPatchWorkerClient(createPatchWorkerInstance);
const parsePatchWorkerClient = createParsePatchWorkerClient(createPatchWorkerInstance);

const createPatchInBrowserWorker = async (
  input: BrowserCreatePatchWorkerInput,
  onProgress?: ProgressCallback,
  onLog?: (record: LogRecord) => void,
): Promise<BrowserCreatePatchWorkerResult> => {
  try {
    return await createPatchWorkerClient.run(input, onProgress, onLog);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err || CREATE_PATCH_WORKER_ERROR));
  }
};

const createPatchInNodeWorker = async (
  input: NodeCreatePatchWorkerInput,
  onProgress?: ProgressCallback,
  onLog?: (record: LogRecord) => void,
): Promise<BrowserCreatePatchWorkerResult> => {
  const nodeCreatePatchWorkerClient = createCreatePatchWorkerClient(createPatchWorkerInstance);
  try {
    return await nodeCreatePatchWorkerClient.run(
      {
        format: input.format,
        logLevel: input.logLevel,
        metadata: input.metadata,
        modifiedFileName: input.modifiedFileName,
        modifiedFilePath: input.modifiedFilePath,
        originalFileName: input.originalFileName,
        originalFilePath: input.originalFilePath,
        outputName: input.outputName,
        workerThreads: input.workerThreads,
      },
      onProgress,
      onLog,
    );
  } finally {
    nodeCreatePatchWorkerClient.reset();
  }
};

const applyPatchInBrowserWorker = async (
  input: BrowserApplyPatchWorkerInput,
  onProgress?: ProgressCallback,
  onLog?: (record: LogRecord) => void,
): Promise<BrowserApplyPatchWorkerResult> => {
  try {
    return await applyPatchWorkerClient.run(input, onProgress, onLog);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err || APPLY_PATCH_WORKER_ERROR));
  }
};
const applyPatchInNodeWorker = async (
  input: NodeApplyPatchWorkerInput,
  onProgress?: ProgressCallback,
  onLog?: (record: LogRecord) => void,
): Promise<BrowserApplyPatchWorkerResult> => {
  const nodeApplyPatchWorkerClient = createApplyPatchWorkerClient(createPatchWorkerInstance);
  try {
    return await nodeApplyPatchWorkerClient.run(
      {
        logLevel: input.logLevel,
        options: input.options,
        patchFileName: input.patchFileName,
        patchFilePath: input.patchFilePath,
        patchFiles: input.patchFiles?.map((patchFile) => ({
          patchFileName: patchFile.patchFileName,
          patchFilePath: patchFile.patchFilePath,
        })),
        romFileName: input.romFileName,
        romFilePath: input.romFilePath,
      },
      onProgress,
      onLog,
    );
  } finally {
    nodeApplyPatchWorkerClient.reset();
  }
};

const parsePatchInBrowserWorker = async (
  input: BrowserParsePatchWorkerInput,
): Promise<BrowserParsePatchWorkerResult> => {
  try {
    return await parsePatchWorkerClient.run(input);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err || PARSE_PATCH_WORKER_ERROR));
  }
};

const resetBrowserPatchWorkerClients = () => {
  createPatchWorkerClient.reset();
  applyPatchWorkerClient.reset();
  parsePatchWorkerClient.reset();
};

export type { NodeApplyPatchWorkerInput, NodeCreatePatchWorkerInput };
export {
  applyPatchInBrowserWorker,
  applyPatchInNodeWorker,
  createPatchInBrowserWorker,
  createPatchInNodeWorker,
  parsePatchInBrowserWorker,
  resetBrowserPatchWorkerClients,
};
