import { hasEngineErrorCode } from "../errors.ts";
import type { LogLevel } from "../../types/logging.ts";
import type { ApplySettings } from "../../types/settings.ts";
import type {
  RuntimePatchWorkerProgress,
  RuntimeTrimWorkerInput,
  RuntimeWorkerIo,
  WorkflowRuntimeLog,
} from "../../types/workflow-runtime-adapter.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import { getRomWeaverRunEventDetails } from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { getPathBaseName, joinPath } from "../path-utils.ts";
import { toThreadBudget } from "./compression-thread-budget.ts";
import { emitRuntimeTrace, toRomWeaverOptions } from "./run-options.ts";
import { getTrimOutputFileName, runWithRomWeaverOutputScope } from "./run-output-paths.ts";
import {
  asRecord,
  ensureRomWeaverSuccess,
  getLastEvent,
  getEmittedFileDetails,
  getEmittedFiles,
  getRunResultTiming,
  getTerminalEvent,
  romTypeFromEmittedFile,
} from "./run-result-parsing.ts";
import { runRomWeaverJson, relaySimpleProgress } from "./wasm-command-shared.ts";

const TRIM_UNSUPPORTED_MESSAGE = "This input does not support trimming";
const GAMECUBE_WII_COMPRESS_HINT = "Use Compress to convert GameCube and Wii discs to RVZ.";

const invokeRomWeaverTrimWorker = async (
  input: RuntimeTrimWorkerInput,
  onProgress?: (progress: RuntimePatchWorkerProgress) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0]> => {
  const sourceFilePath = String(input.sourceFilePath || "").trim();
  if (!sourceFilePath) throw new Error("Trim source path is required");
  const outputFileName = getTrimOutputFileName(sourceFilePath, input.outputName, input.revert ? "restore" : "trim");
  return runWithRomWeaverOutputScope(sourceFilePath, outputFileName, [sourceFilePath], async (scopePath) => {
    const normalizedExtension = typeof input.extension === "string" ? input.extension.trim() : "";
    const threadArg = toThreadBudget(input.threads);
    const siblingPath = (fileName: string) => joinPath(scopePath.slice(0, scopePath.lastIndexOf("/")), fileName);
    // Matches the Rust `TrimCommand`: `source: Vec<PathBuf>` (required), `output: Option<PathBuf>`
    // (conflicts with `in_place`), `extension: Option<String>`, `in_place`, `dry_run`, `revert`,
    // `recursive` (defaults true), `threads`. We always write a new file (`in_place: false`) and
    // simulate only for the staging probe (`dryRun`); `revert` restores padding instead of removing it,
    // and `revert_marker` appends the footer that makes that restore exact.
    //
    // Only the engine knows which inputs it can trim, and a trim is the heavy pass (an XISO rebuild),
    // so it runs once. Its output path is extensionless, which the engine accepts for every input; the
    // user-visible name is chosen afterwards from the `output_format` that same run reports.
    const outputPath = siblingPath("trim-output");
    const command = createRomWeaverCommand("trim", {
      dry_run: !!input.dryRun,
      in_place: false,
      output: outputPath,
      revert: !!input.revert,
      ...(input.revertMarker && !input.revert ? { revert_marker: true } : {}),
      input: [sourceFilePath],
      ...(normalizedExtension ? { extension: normalizedExtension } : {}),
      ...(threadArg ? { threads: threadArg } : {}),
    });
    emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson trim dispatch", { command });
    const result = await runRomWeaverJson(
      command,
      toRomWeaverOptions({
        logLevel: input.logLevel,
        onEvent: relaySimpleProgress(onProgress),
        onLog,
        signal: input.signal,
      }),
    );
    try {
      ensureRomWeaverSuccess(result, "Trim failed");
    } catch (error) {
      // The engine refuses a lone GameCube/Wii disc outright (Compress writes those as RVZ); report it
      // the way an unsupported input is reported so the staging probe flags it before any run.
      if (hasEngineErrorCode(error, "trim.unsupported_disc")) {
        throw Object.assign(new Error(`${TRIM_UNSUPPORTED_MESSAGE}. ${GAMECUBE_WII_COMPRESS_HINT}`), {
          code: "TRIM_UNSUPPORTED",
        });
      }
      throw error;
    }
    const terminal = getTerminalEvent(result);
    const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null);
    if (
      details?.processed === 0 &&
      typeof details.skipped_unsupported === "number" &&
      details.skipped_unsupported > 0
    ) {
      // A batch that skipped only GameCube/Wii discs gets the same Compress hint as a lone disc.
      const skippedDiscs = typeof details.skipped_gamecube_wii === "number" && details.skipped_gamecube_wii > 0;
      throw Object.assign(
        new Error(
          skippedDiscs ? `${TRIM_UNSUPPORTED_MESSAGE}. ${GAMECUBE_WII_COMPRESS_HINT}` : TRIM_UNSUPPORTED_MESSAGE,
        ),
        { code: "TRIM_UNSUPPORTED" },
      );
    }
    if (input.dryRun) {
      return {
        filePath: outputPath,
        trimPlan: {
          revertMarker: details?.revert_marker === true,
          wouldChange: typeof details?.would_change === "number" && details.would_change > 0,
        },
      };
    }
    const emitted = getEmittedFileDetails(result);
    return {
      fileName: outputFileName,
      filePath: emitted?.path || outputPath,
      // The extensionless output path says nothing about the file, so an engine-reported create mode (the
      // current engine reports none for a trim: an XISO is never stored as CHD) is kept for the CHD step.
      romType: romTypeFromEmittedFile({
        chdCreateMode: typeof details?.chd_create_mode === "string" ? details.chd_create_mode : undefined,
      }),
      size: emitted?.sizeBytes,
      timing: getRunResultTiming(result),
    };
  });
};

const invokeRomWeaverPpfUndoWorker = async (input: {
  target?: string;
  onWarning?: (message: string) => void;
  settings?: Partial<ApplySettings>;
  knownInputPaths?: string[];
  logLevel?: LogLevel | string;
  outputName: string;
  patchFilePath: string;
  romFilePath: string;
  signal?: AbortSignal;
}): Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0] & { files: ReturnType<typeof getEmittedFiles> }> => {
  const outputFileName = getPathBaseName(input.outputName, "restored-rom.bin");
  const threadArg = toThreadBudget(input.settings?.workers?.threads);
  return runWithRomWeaverOutputScope(
    input.romFilePath,
    outputFileName,
    [input.romFilePath, input.patchFilePath],
    async (outputPath) => {
      const command = createRomWeaverCommand("tools-ppf-undo", {
        ...(input.target ? { target: input.target } : {}),
        no_extract: true,
        no_compress: true,
        ...(threadArg ? { threads: threadArg } : {}),
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
          onLog: (record) => {
            if (record.level === "warn") input.onWarning?.(record.message);
          },
          logLevel: input.logLevel,
          signal: input.signal,
        }),
      );
      ensureRomWeaverSuccess(result, "PPF undo failed");
      const terminal = getLastEvent(result);
      const details = terminal ? getRomWeaverRunEventDetails(terminal) : undefined;
      if (details && typeof details === "object" && !Array.isArray(details) && Array.isArray(details.warnings)) {
        for (const warning of details.warnings) if (typeof warning === "string") input.onWarning?.(warning);
      }
      const files = getEmittedFiles(result);
      const primary = files[0];
      return {
        cueText: primary?.cueText,
        gdiText: primary?.gdiText,
        discGroupId: primary?.discGroupId,
        files,
        fileName: outputFileName,
        filePath: primary?.path || outputPath,
        size: primary?.sizeBytes,
        timing: getRunResultTiming(result),
      };
    },
  );
};

export { invokeRomWeaverTrimWorker, invokeRomWeaverPpfUndoWorker };
