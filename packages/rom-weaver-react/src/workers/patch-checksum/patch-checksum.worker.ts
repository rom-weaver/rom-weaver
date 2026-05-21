/* RomWeaver v20250922 - Marc Robledo 2016-2025 - http://www.marcrobledo.com/license */

import type { ChecksumWorkerRequest } from "../protocol/worker-protocol.ts";
import type { WorkerRequestData } from "../protocol/worker-runtime-payloads.ts";
import type { ParsedPatchLike, WorkerPatchFile } from "../shared/binary/types.ts";
import PatchFile from "../shared/file-io/patch-file.ts";
import type { EmscriptenWorkerModule } from "../shared/wasm/emscripten-types.ts";
import { attachWorkerDispatcher } from "../shared/worker-dispatcher.ts";
import { getWorkerErrorMessage, postCloneSafeWorkerMessage } from "../shared/worker-message-utils.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../shared/worker-storage/storage-layout.ts";
import { runChecksum, warmupChecksumWasm } from "./checksum-worker-core.ts";
import RomWeaver from "./patch/engine/patch-operations.ts";
import BPS from "./patch/formats/bps.ts";
import { createRunApply } from "./patch/worker/patch-apply-worker-action.ts";
import { createRunCreatePatch } from "./patch/worker/patch-create-worker-action.ts";
import XdeltaManager from "./patch/xdelta/XdeltaManager.ts";
import { createPatchWorkerFs, type PatchWorkerScope } from "./shared/patch-worker-storage.ts";

type WorkerPatchSummary = {
  validationInfo: ReturnType<NonNullable<ParsedPatchLike["getValidationInfo"]>> | null;
  description: string | null;
};

const workerScope = self as typeof globalThis &
  PatchWorkerScope & {
    Module?: EmscriptenWorkerModule;
    __romWeaverWorkerKind?: "patch-checksum";
  };

workerScope.__romWeaverWorkerKind = "patch-checksum";

(
  RomWeaver as typeof RomWeaver & {
    setXdeltaManager?: (manager: typeof XdeltaManager) => void;
  }
).setXdeltaManager?.(XdeltaManager);

const _normalizeFatalWorkerError = getWorkerErrorMessage;
const patchWorkerFs = createPatchWorkerFs({
  normalizeFatalWorkerError: _normalizeFatalWorkerError,
  workerScope,
});

const _createPatchSummaryData = (patch: ParsedPatchLike | null | undefined): WorkerPatchSummary | null => {
  if (!patch) return null;
  const patchWithDescription = patch as ParsedPatchLike & {
    getDescription?: () => string | null | undefined;
    description?: string | null;
  };
  return {
    description:
      typeof patchWithDescription.getDescription === "function"
        ? patchWithDescription.getDescription() || null
        : (() => {
            if (typeof patchWithDescription.description === "string") {
              return patchWithDescription.description || null;
            }
            return null;
          })(),
    validationInfo: typeof patch.getValidationInfo === "function" ? patch.getValidationInfo() : null,
  };
};

const _parsePatchSummary = async (patchFile: WorkerPatchFile) => {
  patchFile.seek(0);
  const header = patchFile.readString(8);
  if (header.startsWith(BPS.MAGIC))
    return BPS.readSummary(patchFile as object as Parameters<typeof BPS.readSummary>[0]);
  patchFile.seek(0);
  return _createPatchSummaryData(
    await RomWeaver.parsePatchFile(patchFile as object as Parameters<typeof RomWeaver.parsePatchFile>[0]),
  );
};

const _runParsePatch = (data: WorkerRequestData) => {
  Promise.resolve()
    .then(async () => {
      let openedPatchPath: string | null = null;
      let manager = null as Awaited<ReturnType<typeof patchWorkerFs.getApplyOpfsManager>> | null;
      let patchFile: WorkerPatchFile;
      try {
        if (typeof data.patchFilePath === "string" && data.patchFilePath.trim()) {
          manager = await patchWorkerFs.getApplyOpfsManager().catch(() => null);
          if (manager && data.patchFilePath.startsWith(WORKER_OPFS_MOUNTPOINT)) {
            openedPatchPath = data.patchFilePath;
            patchFile = (await patchWorkerFs.openOpfsInputRomFile(
              manager,
              data.patchFilePath,
              data.patchFileName || "patch.bin",
              "application/octet-stream",
            )) as object as WorkerPatchFile;
          } else {
            patchFile = new PatchFile(data.patchFilePath) as object as WorkerPatchFile;
            patchFile.fileName = data.patchFileName || "patch.bin";
          }
        } else {
          throw new Error("Patch file was not provided");
        }
        return await _parsePatchSummary(patchFile);
      } finally {
        if (openedPatchPath) manager?.releaseFile?.(openedPatchPath);
      }
    })
    .then((patchSummary) => {
      postCloneSafeWorkerMessage(workerScope, {
        action: "parse-patch-complete",
        patch: patchSummary,
        requestId: data.requestId,
        success: true,
        type: "result",
        workerKind: "patch-checksum",
      });
    })
    .catch((error) => {
      const message = _normalizeFatalWorkerError(error);
      const errorPayload = {
        code: "WORKER_FAILED" as const,
        details: { requestId: String(data.requestId), workerKind: "patch-checksum" },
        message,
      };
      const response = {
        action: "parse-patch-complete",
        code: errorPayload.code,
        error: errorPayload,
        message,
        requestId: data.requestId,
        success: false,
        type: "error",
        workerKind: "patch-checksum",
      };
      postCloneSafeWorkerMessage(workerScope, response);
    });
};

const _runWarmup = async (data: WorkerRequestData) => {
  await warmupChecksumWasm(data.requestId);
};

const _cleanupPatchWorkerFiles = async (filePaths?: string[]) => {
  await patchWorkerFs.cleanupPatchWorkerFiles(filePaths);
};

const _runCreatePatch = createRunCreatePatch(patchWorkerFs);
const _runApply = createRunApply(patchWorkerFs, _normalizeFatalWorkerError, workerScope);

attachWorkerDispatcher(workerScope, {
  getErrorAction: (data) => {
    if (data.action === "parse-patch") return "parse-patch-complete";
    if (typeof data.action === "string" && data.action.startsWith("checksum")) return "checksum-error";
    return "complete";
  },
  getErrorMessage: _normalizeFatalWorkerError,
  handlers: {
    apply: _runApply,
    checksum: (data) => runChecksum(data as ChecksumWorkerRequest),
    "checksum-stream-chunk": (data) => runChecksum(data as ChecksumWorkerRequest),
    "checksum-stream-complete": (data) => runChecksum(data as ChecksumWorkerRequest),
    "checksum-stream-start": (data) => runChecksum(data as ChecksumWorkerRequest),
    cleanup: async (data) => {
      await _cleanupPatchWorkerFiles(Array.isArray(data.filePaths) ? (data.filePaths as string[]) : []);
    },
    "create-patch": _runCreatePatch,
    "parse-patch": _runParsePatch,
    "patch-apply": _runApply,
    "patch-create": _runCreatePatch,
    warmup: _runWarmup,
  },
  normalizeRequest: (request) =>
    ({
      ...(request || {}),
      action: typeof request.action === "string" ? request.action : "",
      requestId: request.requestId === undefined ? "0" : String(request.requestId),
    }) as WorkerRequestData,
});
