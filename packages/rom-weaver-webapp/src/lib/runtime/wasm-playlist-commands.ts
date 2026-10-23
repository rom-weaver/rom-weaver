import type { LogLevel } from "../../types/logging.ts";
import type { RuntimeWorkerIo } from "../../types/workflow-runtime-adapter.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import { getRomWeaverRunEventDetails } from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { getPathBaseName } from "../path-utils.ts";
import { emitRuntimeTrace, toRomWeaverOptions } from "./run-options.ts";
import { runWithRomWeaverOutputScope } from "./run-output-paths.ts";
import {
  asRecord,
  ensureRomWeaverSuccess,
  getEmittedFiles,
  getRunResultTiming,
  getTerminalEvent,
} from "./run-result-parsing.ts";
import { runRomWeaverJson } from "./wasm-command-shared.ts";

type PlaylistWorkerInput = {
  /** Staged paths of the disc files, in the order they should appear when `sort` is false. */
  discFilePaths: string[];
  stagedPaths: Record<string, string>;
  /** Order the discs by the numbers in their names instead of keeping the given order. */
  sort: boolean;
  /** A ZIP holding the playlist and its discs; otherwise just the `.m3u`. */
  archive: boolean;
  logLevel?: LogLevel | string;
  outputName: string;
  signal?: AbortSignal;
};

type PlaylistWorkerResult = Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0] & {
  /** The playlist lines, in playlist order, exactly as written. */
  entries: string[];
};

const invokeRomWeaverPlaylistWorker = async (input: PlaylistWorkerInput): Promise<PlaylistWorkerResult> => {
  const firstPath = input.discFilePaths[0];
  if (!firstPath) throw new Error("Add at least one disc file");
  const fallbackName = input.archive ? "playlist.zip" : "playlist.m3u";
  const outputFileName = getPathBaseName(input.outputName, fallbackName);
  return runWithRomWeaverOutputScope(firstPath, outputFileName, input.discFilePaths, async (outputPath) => {
    const command = createRomWeaverCommand("playlist", {
      flat: !input.archive,
      input: input.discFilePaths,
      no_sort: !input.sort,
      output: outputPath,
      staged_paths: input.stagedPaths,
    });
    emitRuntimeTrace({ logLevel: input.logLevel }, "runJson playlist dispatch", { command, outputPath });
    const result = await runRomWeaverJson(
      command,
      toRomWeaverOptions({
        knownInputPaths: input.discFilePaths,
        logLevel: input.logLevel,
        signal: input.signal,
      }),
    );
    ensureRomWeaverSuccess(result, "Playlist failed");
    const terminal = getTerminalEvent(result);
    const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null);
    const playlist = asRecord(details?.playlist);
    const entries = Array.isArray(playlist?.entries)
      ? playlist.entries.filter((entry): entry is string => typeof entry === "string")
      : [];
    const primary = getEmittedFiles(result)[0];
    return {
      entries,
      fileName: outputFileName,
      filePath: primary?.path || outputPath,
      size: primary?.sizeBytes,
      timing: getRunResultTiming(result),
    };
  });
};

export { invokeRomWeaverPlaylistWorker };
