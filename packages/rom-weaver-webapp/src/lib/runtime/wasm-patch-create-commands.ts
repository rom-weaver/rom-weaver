import type {
  RuntimePatchCreateCandidatesWorkerInput,
  RuntimePatchCreateFormatCandidates,
  RuntimePatchCreateWorkerInput,
  RuntimePatchWorkerProgress,
  RuntimeWorkerIo,
  WorkflowRuntimeLog,
} from "../../types/workflow-runtime-adapter.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import { getPathBaseName } from "../path-utils.ts";
import { toThreadBudget } from "./compression-thread-budget.ts";
import { readPatchCreateFormatCandidates } from "./patch-run-resolution.ts";
import { emitRuntimeTrace, toRomWeaverOptions } from "./run-options.ts";
import { runWithRomWeaverOutputScope } from "./run-output-paths.ts";
import { ensureRomWeaverSuccess, getEmittedFileDetails, getRunResultTiming } from "./run-result-parsing.ts";
import { runRomWeaverJson, relaySimpleProgress } from "./wasm-command-shared.ts";

const invokeRomWeaverCreatePatchCandidatesWorker = async (
  input: RuntimePatchCreateCandidatesWorkerInput,
  onProgress?: (progress: RuntimePatchWorkerProgress) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<RuntimePatchCreateFormatCandidates> => {
  const threadArg = toThreadBudget(input.threads);
  const command = createRomWeaverCommand("patch-create", {
    modified: input.modifiedFilePath,
    original: input.originalFilePath,
    plan: true,
    ...(threadArg ? { threads: threadArg } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson patch-create plan dispatch", {
    command,
    modifiedFileName: input.modifiedFileName,
    modifiedFilePath: input.modifiedFilePath,
    originalFileName: input.originalFileName,
    originalFilePath: input.originalFilePath,
    threadArg,
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      logLevel: input.logLevel,
      onEvent: relaySimpleProgress(onProgress),
      onLog,
      signal: input.signal,
    }),
  );
  ensureRomWeaverSuccess(result, "Patch create candidate selection failed");
  return readPatchCreateFormatCandidates(result);
};

const invokeRomWeaverCreatePatchWorker = async (
  input: RuntimePatchCreateWorkerInput,
  onProgress?: (progress: RuntimePatchWorkerProgress) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0]> => {
  const outputFileName = getPathBaseName(
    input.outputName || `patch.${String(input.format || "bin").toLowerCase()}`,
    `patch.${String(input.format || "bin").toLowerCase()}`,
  );
  return runWithRomWeaverOutputScope(
    input.modifiedFilePath || input.originalFilePath,
    outputFileName,
    [input.originalFilePath, input.modifiedFilePath],
    async (outputPath) => {
      const threadArg = toThreadBudget(input.threads);
      // Rust `patch-create` takes either a modified ROM or cheat codes it bakes
      // into the original; passing both is rejected, so the codes path omits
      // `modified` entirely.
      const codes = (input.codes || []).map((code) => String(code || "").trim()).filter((code) => !!code);
      const command = createRomWeaverCommand("patch-create", {
        format: input.format,
        ...(codes.length
          ? {
              codes,
              ...(input.codeSystem ? { code_system: input.codeSystem } : {}),
              ...(input.codeKind ? { code_kind: input.codeKind } : {}),
            }
          : { modified: input.modifiedFilePath }),
        original: input.originalFilePath,
        output: outputPath,
        ...(input.checksumName ? { checksum_name: true } : {}),
        ...(input.sourceCrc32 ? { assume_in: [`crc32=${input.sourceCrc32}`] } : {}),
        ...(threadArg ? { threads: threadArg } : {}),
      });
      emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson patch-create dispatch", {
        codeCount: codes.length,
        command,
        modifiedFilePath: input.modifiedFilePath,
        originalFilePath: input.originalFilePath,
        outputPath,
        threadArg,
      });
      const result = await runRomWeaverJson(
        command,
        toRomWeaverOptions({
          logLevel: input.logLevel,
          onEvent: relaySimpleProgress(onProgress),
          onLog,
          signal: input.signal,
        }),
      );
      ensureRomWeaverSuccess(result, "Patch create failed");

      const emitted = getEmittedFileDetails(result);
      return {
        // Rust may rename the output (e.g. `--checksum-name` embeds the source crc32),
        // so the emitted path is authoritative for the final file name.
        fileName: emitted?.path ? getPathBaseName(emitted.path, outputFileName) : outputFileName,
        filePath: emitted?.path || outputPath,
        size: emitted?.sizeBytes,
        timing: getRunResultTiming(result),
      };
    },
  );
};

export { invokeRomWeaverCreatePatchCandidatesWorker, invokeRomWeaverCreatePatchWorker };
