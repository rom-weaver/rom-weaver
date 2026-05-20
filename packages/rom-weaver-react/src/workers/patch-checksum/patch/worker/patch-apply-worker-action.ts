import type {
  PatchFileEntry,
  WorkerProgressCallback,
  WorkerRequestData,
} from "../../../protocol/worker-runtime-payloads.ts";
import type { ParsedPatchLike, WorkerPatchFile } from "../../../shared/binary/types.ts";
import PatchFile from "../../../shared/file-io/patch-file.ts";
import { postWorkerLog } from "../../../shared/worker-message-utils.ts";
import { createProgressCallback } from "../../../shared/worker-progress-utils.ts";
import { getWorkerStorageBucketPath } from "../../../shared/worker-storage/storage-layout.ts";
import type { WorkerOpfsManager } from "../../../shared/worker-storage/types.ts";
import { createTimingFromStart, now } from "../../../shared/worker-timing.ts";
import { computeCRC32 } from "../../shared/checksum.ts";
import {
  APPLY_OPFS_MOUNTPOINT,
  getPatchWorkerFileExtension,
  type PatchWorkerFs,
  type PatchWorkerScope,
} from "../../shared/patch-worker-storage.ts";
import RomWeaver from "../engine/patch-operations.ts";
import BPS from "../formats/bps.ts";

type PatchContext = {
  romFile: WorkerPatchFile;
  patchFileEntries: PatchFileEntry[];
  patchFiles: WorkerPatchFile[];
  patches: ParsedPatchLike[];
};

type WorkerApplyOptions = {
  addHeader?: boolean;
  fixChecksum?: boolean;
  onProgress?: WorkerProgressCallback;
  opfsManager?: WorkerOpfsManager | null;
  outputExtension?: string | null;
  outputFileFactory?: (size: number) => WorkerPatchFile;
  outputName?: string | null;
  appendOutputSuffix?: boolean;
  removeHeader?: boolean;
  requireInputChecksumMatch?: boolean;
  onTrace?: (message: string, details?: Record<string, unknown>) => void;
};

type ParsedPatchResult = {
  patch: ParsedPatchLike;
};

type WorkerApplySummary = {
  outputSize?: number;
  patches?: Array<{
    fileName: string;
    format: string;
    size?: number;
  }>;
  patchSize?: number;
  rom?: {
    fileName: string;
    size?: number;
  };
  timing?: { elapsedMs?: number; elapsedSeconds?: number } | null;
};

type ApplyTraceCallback = (message: string, details?: Record<string, unknown>) => void;

let applyRunId = 0;

const getPatchSourceKind = (file: WorkerPatchFile | null | undefined) => {
  if (!file) return "missing";
  if (file.filePath) return String(file.filePath).startsWith(APPLY_OPFS_MOUNTPOINT) ? "opfs-path" : "file-path";
  if ((file as { _file?: unknown })._file) return "blob";
  if ((file as { _u8array?: unknown })._u8array) return "memory";
  return "unknown";
};

const summarizePatchFile = (file: WorkerPatchFile | null | undefined, index?: number) =>
  file
    ? {
        fileName: file.fileName,
        filePath: file.filePath,
        index,
        size: file.fileSize,
        sourceKind: getPatchSourceKind(file),
      }
    : null;

const createApplyTrace =
  (workerScope: PatchWorkerScope, data: WorkerRequestData): ApplyTraceCallback =>
  (message, details = {}) => {
    if (data.logLevel !== "trace") return;
    postWorkerLog(workerScope, data.requestId, "trace", "worker:patch", message, {
      action: data.action,
      romFileName: data.romFileName,
      ...details,
    });
  };

const parsePatchFile = async (
  patchFile: WorkerPatchFile,
  streamBps: boolean,
  trace?: ApplyTraceCallback,
): Promise<ParsedPatchResult> => {
  const startedAt = Date.now();
  trace?.("patch.apply.patch.parse.start", {
    fileName: patchFile.fileName,
    size: patchFile.fileSize,
    sourceKind: getPatchSourceKind(patchFile),
    streamBps,
  });
  patchFile.seek(0);
  const header = patchFile.readString(8);
  if (header.startsWith(BPS.MAGIC)) {
    patchFile.seek(0);
    const patch = (await BPS.fromFileAsync(
      patchFile as object as Parameters<typeof BPS.fromFileAsync>[0],
      streamBps ? { lazyTargetRead: true, streamActions: true } : undefined,
    )) as object as ParsedPatchLike;
    trace?.("patch.apply.patch.parse.finish", {
      durationMs: Date.now() - startedAt,
      fileName: patchFile.fileName,
      format: "BPS",
      size: patchFile.fileSize,
      streamActions: streamBps,
    });
    return {
      patch,
    };
  }
  patchFile.seek(0);
  const patch = await RomWeaver.parsePatchFile(patchFile as object as Parameters<typeof RomWeaver.parsePatchFile>[0]);
  if (!patch) throw new Error("Invalid patch file");
  trace?.("patch.apply.patch.parse.finish", {
    durationMs: Date.now() - startedAt,
    fileName: patchFile.fileName,
    format: patch.constructor?.name || "patch",
    size: patchFile.fileSize,
    streamActions: false,
  });
  return { patch };
};

const createRomFileForPatchContext = async (
  data: WorkerRequestData,
  manager: WorkerOpfsManager | null,
  storage: PatchWorkerFs,
) => {
  if (typeof data.romFilePath === "string" && data.romFilePath.trim()) {
    const romFileName = data.romFileName || "input.bin";
    if (manager && data.romFilePath.startsWith(APPLY_OPFS_MOUNTPOINT)) {
      return storage.openOpfsInputRomFile(
        manager,
        data.romFilePath,
        romFileName,
        "application/octet-stream",
      ) as Promise<WorkerPatchFile>;
    }
    const binFile = new PatchFile(data.romFilePath) as object as WorkerPatchFile;
    binFile.fileName = romFileName;
    return binFile;
  }
  if (data.romFile) {
    const romFileName = data.romFileName || data.romFile.name || "input.bin";
    if (!manager) throw new Error("Patch worker inputs must be staged into OPFS before worker execution");
    return storage.createOpfsInputRomFile(
      manager,
      getWorkerStorageBucketPath(
        APPLY_OPFS_MOUNTPOINT,
        "input",
        `input-rom-${++applyRunId}${getPatchWorkerFileExtension(romFileName, ".bin")}`,
        romFileName,
      ),
      data.romFile,
      romFileName,
      data.romFile.type || "application/octet-stream",
    );
  }
  throw new Error("No ROM provided");
};

const createPatchContext = async (
  data: WorkerRequestData,
  manager: WorkerOpfsManager | null,
  storage: PatchWorkerFs,
  trace?: ApplyTraceCallback,
): Promise<PatchContext> => {
  const romFile = await createRomFileForPatchContext(data, manager, storage);
  trace?.("patch.apply.input.ready", {
    input: summarizePatchFile(romFile),
  });
  const patchFileEntries: PatchFileEntry[] = data.patchFiles || [
    {
      patchFile: data.patchFile,
      patchFileName: data.patchFileName,
    },
  ];
  const patchFiles: WorkerPatchFile[] = [];
  for (let i = 0; i < patchFileEntries.length; i++) {
    const patchFileEntry = patchFileEntries[i];
    let patchFilePath = "";
    if (typeof patchFileEntry?.patchFilePath === "string") patchFilePath = patchFileEntry.patchFilePath;
    else if (i === 0 && typeof data.patchFilePath === "string") patchFilePath = data.patchFilePath;
    if (!patchFileEntry) throw new Error("Patch file was not provided");
    if (!(patchFileEntry.patchFile || patchFilePath.trim())) throw new Error("Patch file was not provided");
    const patchFileName = patchFileEntry.patchFileName || patchFileEntry.patchFile?.name || `patch-${i + 1}.bin`;
    if (patchFilePath.trim()) {
      if (manager && patchFilePath.startsWith(APPLY_OPFS_MOUNTPOINT)) {
        patchFiles.push(
          (await storage.openOpfsInputRomFile(
            manager,
            patchFilePath,
            patchFileName,
            "application/octet-stream",
          )) as object as WorkerPatchFile,
        );
        continue;
      }
      const binFile = new PatchFile(patchFilePath) as object as WorkerPatchFile;
      binFile.fileName = patchFileName;
      patchFiles.push(binFile);
      continue;
    }
    if (!manager) throw new Error("Patch worker inputs must be staged into OPFS before worker execution");
    const stagedPatchFile = patchFileEntry.patchFile;
    if (!stagedPatchFile) throw new Error("Patch file was not provided");
    patchFiles.push(
      await storage.createOpfsInputRomFile(
        manager,
        getWorkerStorageBucketPath(
          APPLY_OPFS_MOUNTPOINT,
          "patches",
          `input-patch-${++applyRunId}${getPatchWorkerFileExtension(patchFileName, ".bin")}`,
          patchFileName,
        ),
        stagedPatchFile,
        patchFileName,
        stagedPatchFile.type || "application/octet-stream",
      ),
    );
  }
  trace?.("patch.apply.patches.ready", {
    patches: patchFiles.map((patchFile, index) => summarizePatchFile(patchFile, index)),
  });
  const patches = (await Promise.all(patchFiles.map((patchFile) => parsePatchFile(patchFile, true, trace)))).map(
    (result) => result.patch as ParsedPatchLike,
  );
  return {
    patches,
    patchFileEntries,
    patchFiles,
    romFile,
  };
};

const createRunApply =
  (storage: PatchWorkerFs, normalizeFatalWorkerError: (error: unknown) => string, workerScope: PatchWorkerScope) =>
  async (data: WorkerRequestData) => {
    const progressCallback = createProgressCallback(data.requestId);
    const trace = createApplyTrace(workerScope, data);
    const workId = `apply-${++applyRunId}`;
    let manager: WorkerOpfsManager | null = null;
    let failureMessage: string | false = false;
    let patchedRom: WorkerPatchFile | null = null;
    let context: PatchContext | null = null;
    let applyTiming: { elapsedMs?: number; elapsedSeconds?: number } | null = null;
    let applySummary: WorkerApplySummary | null = null;
    try {
      trace("patch.apply.start", {
        hasRomFile: !!data.romFile,
        hasRomFilePath: !!data.romFilePath,
        patchCount: data.patchFiles?.length || (data.patchFile || data.patchFilePath ? 1 : 0),
      });
      progressCallback({ label: "Reading patch...", percent: null });
      progressCallback({ label: "Preparing apply output...", percent: null });
      const managerStartedAt = Date.now();
      manager = await storage.getApplyOpfsManager();
      trace("patch.apply.manager.ready", {
        durationMs: Date.now() - managerStartedAt,
        hasManager: !!manager,
      });
      const contextStartedAt = Date.now();
      context = await createPatchContext(data, manager, storage, trace);
      trace("patch.apply.context.ready", {
        durationMs: Date.now() - contextStartedAt,
        input: summarizePatchFile(context.romFile),
        patchCount: context.patches.length,
        patches: context.patchFiles.map((patchFile, index) => ({
          ...summarizePatchFile(patchFile, index),
          format: context?.patches[index]?.constructor?.name || "patch",
        })),
      });
      const patchContext = context;
      if (patchContext.patches.length && patchContext.patches.every((patch) => !!patch)) {
        const applyOptions: WorkerApplyOptions = Object.assign({}, data.options || {});
        if (typeof applyOptions.onProgress !== "function") applyOptions.onProgress = progressCallback;
        applyOptions.onTrace = trace;
        applyOptions.opfsManager = manager;
        applyOptions.outputFileFactory = await storage.createOpfsOutputFactory(
          manager,
          patchContext.patches.length + 2,
          workId,
          applyOptions.outputName || data.romFileName || "patched.bin",
        );
        progressCallback({ label: "Applying patch...", percent: 0 });
        const applyStartedAt = now();
        trace("patch.apply.engine.start", {
          input: summarizePatchFile(patchContext.romFile),
          patchCount: patchContext.patches.length,
          patches: patchContext.patchFiles.map((patchFile, index) => ({
            ...summarizePatchFile(patchFile, index),
            format: patchContext.patches[index]?.constructor?.name || "patch",
          })),
        });
        patchedRom = (await RomWeaver.applyPatchSequence(
          patchContext.romFile as object as Parameters<typeof RomWeaver.applyPatchSequence>[0],
          patchContext.patches as Parameters<typeof RomWeaver.applyPatchSequence>[1],
          applyOptions as Parameters<typeof RomWeaver.applyPatchSequence>[2],
        )) as WorkerPatchFile;
        applyTiming = createTimingFromStart(applyStartedAt);
        trace("patch.apply.engine.finish", {
          output: summarizePatchFile(patchedRom),
          timing: applyTiming,
        });
        if (data.options?.requireOutputChecksumMatch === true) {
          const finalPatch = patchContext.patches.at(-1);
          const validationInfo =
            finalPatch && typeof finalPatch.getValidationInfo === "function" ? finalPatch.getValidationInfo() : null;
          const checksumType = String(validationInfo?.type || "")
            .trim()
            .toUpperCase()
            .replace(/[-_]/g, "");
          const targetScope = String(validationInfo?.targetChecksumScope || validationInfo?.targetValueScope || "")
            .trim()
            .toLowerCase()
            .replace(/[_\s]+/g, "-");
          const hasChunkSafeChecksum =
            checksumType === "CRC32" && !Array.isArray(validationInfo?.targetValue) && targetScope !== "target-window";
          if (hasChunkSafeChecksum) {
            const expected = Number(validationInfo?.targetValue);
            if (Number.isFinite(expected)) {
              const actual = (await computeCRC32(patchedRom)) >>> 0;
              if (actual !== expected >>> 0) throw new Error("Patched output checksum mismatch");
            }
          }
        }
        applySummary = {
          outputSize: patchedRom.fileSize,
          patches: patchContext.patchFiles.map((patchFile, index) => ({
            fileName:
              patchContext.patchFileEntries[index]?.patchFileName || patchFile.fileName || `patch-${index + 1}.bin`,
            format: patchContext.patches[index]?.constructor?.name || "patch",
            size: patchFile.fileSize,
          })),
          patchSize: patchContext.patchFiles.reduce((total, patchFile) => total + patchFile.fileSize, 0),
          rom: {
            fileName: data.romFileName || patchContext.romFile.fileName || "input.bin",
            size: patchContext.romFile.fileSize,
          },
          timing: applyTiming,
        };
        progressCallback({ label: "Preparing download...", percent: null });
      } else {
        failureMessage = "Invalid patch file";
      }
    } catch (error) {
      failureMessage = normalizeFatalWorkerError(error);
      trace("patch.apply.fail", {
        error: failureMessage,
      });
    }
    try {
      trace("patch.apply.result.post.start", {
        failureMessage: failureMessage || undefined,
        output: summarizePatchFile(patchedRom),
      });
      const cleanupDeferred = await storage.postApplyResult({
        applySummary,
        data,
        failureMessage,
        manager,
        patchedRom,
        timing: applyTiming,
      });
      trace("patch.apply.result.post.finish", {
        cleanupDeferred,
        failureMessage: failureMessage || undefined,
      });
      if (cleanupDeferred) manager = null;
    } finally {
      if (manager) await manager.cleanup();
    }
  };

export { createRunApply };
