import type { LogLevel } from "../../types/logging.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import { getRomWeaverRunEventDetails } from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { getPathBaseName } from "../path-utils.ts";
import { parseSaveEditorResult } from "./save-editor-result.ts";
import type { SaveEditorResult } from "./save-editor-result.ts";
import { toRomWeaverOptions } from "./run-options.ts";
import { runWithRomWeaverOutputScope } from "./run-output-paths.ts";
import {
  ensureRomWeaverSuccess,
  getEmittedFileDetails,
  getRunResultTiming,
  getTerminalEvent,
} from "./run-result-parsing.ts";
import { runRomWeaverJson } from "./wasm-command-shared.ts";
import type { RomWeaverJsonResult } from "./wasm-command-shared.ts";

type RuntimeSaveCommandInput = {
  game?: string;
  inputPath?: string;
  logLevel?: LogLevel | string;
  romSha1?: string;
  schemaPath?: string;
  signal?: AbortSignal;
};

type RuntimeSaveSetInput = RuntimeSaveCommandInput & {
  assignments: string[];
  dryRun?: boolean;
  outputName: string;
};

const runSaveCommand = async (
  type: "identify" | "inspect" | "get" | "set" | "export-schema" | "create" | "list-games",
  args: Record<string, unknown>,
  input: RuntimeSaveCommandInput,
  outputPath?: string,
): Promise<{ parsed: SaveEditorResult; result: RomWeaverJsonResult; outputPath?: string }> => {
  const command = createRomWeaverCommand(`save-${type}`, {
    ...args,
    ...(input.inputPath ? { [type === "create" ? "template" : "input"]: input.inputPath } : {}),
    ...(input.game ? { game: input.game } : {}),
    ...(input.romSha1 ? { rom_sha1: input.romSha1 } : {}),
    ...(input.schemaPath ? { schema: input.schemaPath } : {}),
    ...(outputPath ? { output: outputPath } : {}),
  } as never);
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      knownInputPaths: [input.inputPath, input.schemaPath].filter((path): path is string => Boolean(path)),
      logLevel: input.logLevel,
      signal: input.signal,
      invalidateMountCacheBeforeRun: true,
    }),
  );
  const terminal = getTerminalEvent(result);
  if (!(type === "identify" && terminal?.status === "unsupported")) {
    ensureRomWeaverSuccess(result, `Save ${type} failed`);
  }
  const details = terminal ? getRomWeaverRunEventDetails(terminal) : undefined;
  return { parsed: parseSaveEditorResult(details), result, ...(outputPath ? { outputPath } : {}) };
};

const invokeRomWeaverSaveIdentifyWorker = (input: RuntimeSaveCommandInput) => runSaveCommand("identify", {}, input);
const invokeRomWeaverSaveInspectWorker = (input: RuntimeSaveCommandInput) => runSaveCommand("inspect", {}, input);
const invokeRomWeaverSaveListGamesWorker = (input: RuntimeSaveCommandInput) => runSaveCommand("list-games", {}, input);
const invokeRomWeaverSaveCreateWorker = async (input: Omit<RuntimeSaveSetInput, "dryRun">) => {
  const result = await runSaveWriteCommand("create", input);
  if (!("filePath" in result)) throw new Error("Save generation did not return an output path");
  return result;
};
const invokeRomWeaverSaveSetWorker = (input: RuntimeSaveSetInput) => runSaveWriteCommand("set", input);
const runSaveWriteCommand = async (type: "create" | "set", input: RuntimeSaveSetInput) => {
  if (input.dryRun)
    return (await runSaveCommand(type, { assignments: input.assignments, dry_run: true }, input)).parsed;
  const outputName = getPathBaseName(input.outputName, "edited-save.sav");
  return runWithRomWeaverOutputScope(input.inputPath || "", outputName, [input.inputPath || ""], async (outputPath) => {
    const execution = await runSaveCommand(
      type,
      { assignments: input.assignments, dry_run: false, force: true },
      input,
      outputPath,
    );
    const emitted = getEmittedFileDetails(execution.result);
    return {
      ...execution.parsed,
      parsed: execution.parsed,
      fileName: emitted?.path ? getPathBaseName(emitted.path, outputName) : outputName,
      filePath: emitted?.path || outputPath,
      size: emitted?.sizeBytes,
      timing: getRunResultTiming(execution.result),
    };
  });
};

export {
  invokeRomWeaverSaveIdentifyWorker,
  invokeRomWeaverSaveInspectWorker,
  invokeRomWeaverSaveListGamesWorker,
  invokeRomWeaverSaveCreateWorker,
  invokeRomWeaverSaveSetWorker,
};
