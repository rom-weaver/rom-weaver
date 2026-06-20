import { requestBrowserOpfsStorage } from "../../workers/protocol/browser-opfs-worker-client.ts";
import type { PatchFileInstance } from "../../workers/protocol/patch-engine.ts";
import {
  getWorkerStorageBucketPath,
  WORKER_OPFS_MOUNTPOINT,
} from "../../workers/shared/worker-storage/storage-layout.ts";
import { emitTraceLog } from "../logging.ts";
import { convertPatchFileToLazyExternal, getPatchFileBlob } from "./binary-service.ts";

type StageTrace = {
  logLevel?: string;
  onLog?: Parameters<typeof emitTraceLog>[0]["onLog"];
};

let stagedInputCounter = 0;

const emitStageTrace = (trace: StageTrace | undefined, message: string, details: Record<string, unknown> = {}) =>
  emitTraceLog({ logLevel: trace?.logLevel, namespace: "input:opfs-staging", onLog: trace?.onLog }, message, details);

const getExistingFilePath = (file: PatchFileInstance): string =>
  typeof (file as { filePath?: unknown }).filePath === "string" ? (file as { filePath: string }).filePath.trim() : "";

/**
 * Resolve the OPFS guest path to pass as the checksum's `writeTo`, so the source Blob is copied to OPFS
 * DURING the checksum in a single read pass. The checksum reads the Blob once and writes it here in the
 * same pass — the interleaved writes keep a large WebKit/iOS read from OOM-reloading the tab (this is
 * exactly what the extract write path does, which never reloads), and the copy is reused by a later
 * apply. Always staged for Blob-backed inputs; returns null only when there is nothing to copy (no Blob)
 * or the input is already path-backed.
 */
const resolveInputWriteToPath = (file: PatchFileInstance, trace?: StageTrace): string | null => {
  const blob = getPatchFileBlob(file);
  if (!blob) return null;
  if (getExistingFilePath(file)) return null;
  const fileName = file.fileName || "input.bin";
  stagedInputCounter += 1;
  const stagePath = getWorkerStorageBucketPath(
    WORKER_OPFS_MOUNTPOINT,
    "input",
    `staged-${stagedInputCounter}-${fileName}`,
    fileName,
  );
  emitStageTrace(trace, "[perf] checksum will copy input to OPFS (write-to)", {
    fileName,
    size: blob.size,
    stagePath,
  });
  return stagePath;
};

/**
 * After a successful checksum copied the input to `stagePath`, morph the input to read disk-backed from
 * there: drop the in-memory Blob and route reads to the OPFS copy, so a later apply reuses it instead of
 * re-reading the Blob. Attaches cleanup that removes the OPFS copy when the input is released.
 */
const adoptStagedInput = (
  file: PatchFileInstance,
  stagePath: string,
  size: number | undefined,
  trace?: StageTrace,
): void => {
  convertPatchFileToLazyExternal(file, {
    cleanup: async () => {
      await requestBrowserOpfsStorage({ action: "cleanup", filePaths: [stagePath] }).catch(() => undefined);
    },
    filePath: stagePath,
    ...(typeof size === "number" && Number.isFinite(size) ? { size } : {}),
  });
  emitStageTrace(trace, "[perf] input adopted its OPFS copy; apply will reuse it", {
    fileName: file.fileName,
    stagePath,
  });
};

export { adoptStagedInput, resolveInputWriteToPath };
