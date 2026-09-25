import type { LogLevel } from "../../types/logging.ts";
import type {
  RuntimePatchWorkerProgress,
  RuntimeTrimWorkerInput,
  RuntimeWorkerIo,
  WorkflowRuntimeLog,
} from "../../types/workflow-runtime-adapter.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import { getPathBaseName } from "../path-utils.ts";
import { toThreadBudget } from "./compression-thread-budget.ts";
import { emitRuntimeTrace, toRomWeaverOptions } from "./run-options.ts";
import { getTrimOutputFileName, runWithRomWeaverOutputScope } from "./run-output-paths.ts";
import { ensureRomWeaverSuccess, getEmittedFileDetails, getRunResultTiming } from "./run-result-parsing.ts";
import { runRomWeaverJson, relaySimpleProgress } from "./wasm-command-shared.ts";

const invokeRomWeaverTrimWorker = async (
  input: RuntimeTrimWorkerInput,
  onProgress?: (progress: RuntimePatchWorkerProgress) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0]> => {
  const sourceFilePath = String(input.sourceFilePath || "").trim();
  if (!sourceFilePath) throw new Error("Trim source path is required");
  const outputFileName = getTrimOutputFileName(sourceFilePath, input.outputName);
  return runWithRomWeaverOutputScope(sourceFilePath, outputFileName, [sourceFilePath], async (outputPath) => {
    const normalizedExtension = typeof input.extension === "string" ? input.extension.trim() : "";
    const threadArg = toThreadBudget(input.threads);
    // Matches the Rust `TrimCommand`: `source: Vec<PathBuf>` (required), `output: Option<PathBuf>`
    // (conflicts with `in_place`), `extension: Option<String>`, `in_place`, `dry_run`, `revert`,
    // `recursive` (defaults true), `threads`. We always write a new file (`in_place: false`), never
    // simulate (`dry_run: false`), and never restore padding (`revert: false`).
    const command = createRomWeaverCommand("trim", {
      dry_run: false,
      in_place: false,
      output: outputPath,
      revert: false,
      input: [sourceFilePath],
      ...(normalizedExtension ? { extension: normalizedExtension } : {}),
      ...(threadArg ? { threads: threadArg } : {}),
    });
    emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson trim dispatch", {
      command,
      extension: normalizedExtension || "",
      outputPath,
      sourceFilePath,
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
    ensureRomWeaverSuccess(result, "Trim failed");

    const emitted = getEmittedFileDetails(result);
    return {
      fileName: outputFileName,
      filePath: emitted?.path || outputPath,
      size: emitted?.sizeBytes,
      timing: getRunResultTiming(result),
    };
  });
};

const invokeRomWeaverPpfUndoWorker = async (input: {
  knownInputPaths?: string[];
  logLevel?: LogLevel | string;
  outputName: string;
  patchFilePath: string;
  romFilePath: string;
  signal?: AbortSignal;
}): Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0]> => {
  const outputFileName = getPathBaseName(input.outputName, "restored-rom.bin");
  return runWithRomWeaverOutputScope(
    input.romFilePath,
    outputFileName,
    [input.romFilePath, input.patchFilePath],
    async (outputPath) => {
      const command = createRomWeaverCommand("tools-ppf-undo", {
        output: outputPath,
        patch: input.patchFilePath,
        rom: input.romFilePath,
      });
      emitRuntimeTrace({ logLevel: input.logLevel }, "runJson tools-ppf-undo dispatch", {
        command,
        outputPath,
        patchFilePath: input.patchFilePath,
        romFilePath: input.romFilePath,
      });
      const result = await runRomWeaverJson(
        command,
        toRomWeaverOptions({
          knownInputPaths: input.knownInputPaths,
          logLevel: input.logLevel,
          signal: input.signal,
        }),
      );
      ensureRomWeaverSuccess(result, "PPF undo failed");
      const emitted = getEmittedFileDetails(result);
      return {
        fileName: outputFileName,
        filePath: emitted?.path || outputPath,
        size: emitted?.sizeBytes,
        timing: getRunResultTiming(result),
      };
    },
  );
};

export { invokeRomWeaverTrimWorker, invokeRomWeaverPpfUndoWorker };
