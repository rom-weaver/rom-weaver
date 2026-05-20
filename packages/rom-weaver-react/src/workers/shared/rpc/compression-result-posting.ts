import type { WorkerResultFile } from "../../protocol/worker-runtime-payloads.ts";
import { type WorkerMessage, workerScope } from "../worker-compression-types.ts";
import { normalizeWorkerRequestId, postCloneSafeWorkerMessage } from "../worker-message-utils.ts";

const postExtractedFile = (
  requestId: string | number | null | undefined,
  extractedFile: WorkerResultFile,
  cleanupPaths: string[] | null,
  timing: { elapsedMs?: number; elapsedSeconds?: number } | null | undefined,
) => {
  const message: WorkerMessage = {
    action: "complete",
    archiveEntryName: extractedFile._archiveEntryName,
    archiveEntryType: extractedFile._archiveEntryType,
    archiveFileName: extractedFile._archiveFileName,
    chdCueFileName: extractedFile._chdCueFileName,
    chdCueText: extractedFile._chdCueText,
    chdMode: extractedFile._chdMode,
    chdSourceFileName: extractedFile._chdSourceFileName,
    fileName: extractedFile.fileName,
    kind: workerScope.__romWeaverCompressionWorkerKind || "chdman",
    operation: "extract",
    requestId: normalizeWorkerRequestId(requestId),
    rvzMode: extractedFile._rvzMode,
    rvzSourceFileName: extractedFile._rvzSourceFileName,
    success: true,
    timing: timing || null,
    type: "result",
    workerKind: workerScope.__romWeaverWorkerKind,
    z3dsMetadata: extractedFile._z3dsMetadata,
    z3dsSourceFileName: extractedFile._z3dsSourceFileName,
    z3dsUnderlyingMagic: extractedFile._z3dsUnderlyingMagic,
  };
  if (extractedFile._file) throw new Error("Worker outputs must be returned as managed file paths");
  if (typeof extractedFile._opfsPath === "string" && extractedFile._opfsPath) {
    message.outputRef = {
      fileName: extractedFile.fileName || "output.bin",
      filePath: extractedFile._opfsPath,
      kind: "opfs",
      size: extractedFile.fileSize,
    };
    message.cleanupRef = { paths: cleanupPaths || [] };
    postCloneSafeWorkerMessage(workerScope, message);
    return Promise.resolve(true);
  }
  if (typeof extractedFile.filePath === "string" && extractedFile.filePath) {
    message.outputRef = {
      fileName: extractedFile.fileName || "output.bin",
      filePath: extractedFile.filePath,
      kind: "file",
    };
    message.cleanupRef = { paths: cleanupPaths || [extractedFile.filePath] };
    postCloneSafeWorkerMessage(workerScope, message);
    return Promise.resolve(true);
  }
  throw new Error("Browser-backed disc extraction output is not available");
};

const postCreatedFile = (
  requestId: string | number | null | undefined,
  chdFile: WorkerResultFile,
  cleanupPaths: string[] | null,
  timing: { elapsedMs?: number; elapsedSeconds?: number } | null | undefined,
) => {
  const message: WorkerMessage = {
    action: "complete",
    chdMode: chdFile._chdMode,
    chdSourceFileName: chdFile._chdSourceFileName,
    fileName: chdFile.fileName,
    kind: workerScope.__romWeaverCompressionWorkerKind || "chdman",
    operation: "create",
    requestId: normalizeWorkerRequestId(requestId),
    rvzMode: chdFile._rvzMode,
    rvzSourceFileName: chdFile._rvzSourceFileName,
    success: true,
    timing: timing || null,
    type: "result",
    workerKind: workerScope.__romWeaverWorkerKind,
    z3dsMetadata: chdFile._z3dsMetadata,
    z3dsSourceFileName: chdFile._z3dsSourceFileName,
    z3dsUnderlyingMagic: chdFile._z3dsUnderlyingMagic,
  };
  if (chdFile._file) {
    throw new Error("Worker outputs must be returned as managed file paths");
  }
  if (typeof chdFile._opfsPath === "string" && chdFile._opfsPath) {
    message.outputRef = {
      fileName: chdFile.fileName || "output.bin",
      filePath: chdFile._opfsPath,
      kind: "opfs",
      size: chdFile.fileSize,
    };
    message.cleanupRef = { paths: cleanupPaths || [] };
    postCloneSafeWorkerMessage(workerScope, message);
    return Promise.resolve(true);
  }
  if (typeof chdFile.filePath === "string" && chdFile.filePath) {
    message.outputRef = {
      fileName: chdFile.fileName || "output.bin",
      filePath: chdFile.filePath,
      kind: "file",
    };
    message.cleanupRef = { paths: cleanupPaths || [chdFile.filePath] };
    postCloneSafeWorkerMessage(workerScope, message);
    return Promise.resolve(true);
  }
  throw new Error("Browser-backed disc creation output is not available");
};

export { postCreatedFile, postExtractedFile };
