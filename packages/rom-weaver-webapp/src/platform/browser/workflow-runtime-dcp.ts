import { getPathBaseName } from "../../lib/path-utils.ts";
import { createRomWeaverOutputScope } from "../../lib/runtime/run-output-paths.ts";
import {
  asRecord,
  getEmittedFileDetails,
  getRunResultWarnings,
  getTerminalEvent,
} from "../../lib/runtime/run-result-parsing.ts";
import { emitRuntimeTrace, toRomWeaverOptions } from "../../lib/runtime/run-options.ts";
import {
  relaySimpleProgress,
  runRomWeaverJson,
  throwRomWeaverFailureWithBrowserOutputContext,
} from "../../lib/runtime/wasm-command-shared.ts";
import { forwardCreatePatchProgress } from "../shared/workflow-runtime-progress.ts";
import type { RuntimeWorkerIo, WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import { replaceCueFileReferences } from "../../workers/protocol/cue-file-utils.ts";
import { replaceGdiFileReferences } from "../../workers/protocol/gdi-file-utils.ts";
import { getRomWeaverRunEventDetails } from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { readStagedCueText } from "./disc-sheet-staging.ts";
import { joinPath } from "./workflow-runtime-helpers.ts";
import { writeTextToBrowserVfs } from "./workflow-runtime-vfs-cleanup.ts";

type ApplyDcpPatch = NonNullable<WorkflowRuntime["patch"]["applyDcpPatch"]>;

const DCP_REBUILT_TRACK_FILE_NAME = "dcp-rebuilt-track.bin";

// The path the engine reports for the data track it rebuilt (`details.dcp_data_track.path`).
const getRebuiltTrackPath = (result: Parameters<typeof getTerminalEvent>[0]): string => {
  const terminal = getTerminalEvent(result);
  const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : undefined);
  const track = asRecord(details?.dcp_data_track);
  return typeof track?.path === "string" ? track.path : "";
};

// A `.dcp` rebuilds the GD-ROM data track inside the disc's filesystem, so the engine needs the whole
// disc: the sheet plus every track it references. Staged tracks keep their own paths (an extracted
// track stays where ingest put it), so a copy of the sheet pointing at those paths is written into the
// run's output scope. With `--no-compress` and a `.bin` output the engine writes only the rebuilt
// track; the workflow swaps it into the disc it already holds.
const createBrowserDcpApply =
  (workerIo: RuntimeWorkerIo): ApplyDcpPatch =>
  async ({ sheet, tracks, patch, logLevel, onLog, onProgress, signal }) => {
    const trace = { logLevel, onLog };
    const staged = await workerIo.stageSources([
      { fallbackFileName: sheet.fileName, pathPrefix: "apply-dcp-sheet", scope: "apply", source: sheet.source, trace },
      ...tracks.map((track, index) => ({
        fallbackFileName: track.fileName,
        pathPrefix: `apply-dcp-track-${index + 1}`,
        scope: "apply" as const,
        source: track.source,
        trace,
      })),
      {
        fallbackFileName: patch.patchFileName || "patch.dcp",
        pathBucket: "patches" as const,
        pathPrefix: "apply-dcp-patch",
        scope: "apply" as const,
        source: patch.patchFile,
        trace,
      },
    ]);
    const [stagedSheet, ...rest] = staged;
    const stagedPatch = rest.pop();
    const stagedTracks = rest;
    const scope = createRomWeaverOutputScope();
    let scopeAdopted = false;
    try {
      if (!(stagedSheet && stagedPatch)) throw new Error("DCP apply inputs were not staged");
      // A sheet names a track by its file on disk, which can differ from the asset's display name (a
      // CHD's first track is listed as `disc.bin` but extracted as `disc (Track 1).bin`).
      const trackPathByName = new Map(
        tracks.flatMap((track, index) => {
          const stagedPath = stagedTracks[index]?.filePath || "";
          return [track.fileName, stagedPath].map(
            (name) => [getPathBaseName(name, name).toLowerCase(), stagedPath] as const,
          );
        }),
      );
      const resolveTrackPath = (name: string) => trackPathByName.get(getPathBaseName(name, name).toLowerCase());
      const sheetText = await readStagedCueText(stagedSheet.filePath);
      const isGdi = /\.gdi$/i.test(sheet.fileName);
      const sheetPath = joinPath(scope.rootPath, getPathBaseName(sheet.fileName, isGdi ? "disc.gdi" : "disc.cue"));
      await writeTextToBrowserVfs(
        sheetPath,
        isGdi
          ? replaceGdiFileReferences(sheetText, resolveTrackPath)
          : replaceCueFileReferences(sheetText, resolveTrackPath),
      );
      const outputPath = joinPath(scope.rootPath, DCP_REBUILT_TRACK_FILE_NAME);
      const command = createRomWeaverCommand("patch-apply", {
        filter: ["rom", "patch"],
        input: sheetPath,
        no_compress: true,
        output: outputPath,
        patches: [stagedPatch.filePath],
      });
      emitRuntimeTrace(trace, "runJson patch-apply (dcp) dispatch", {
        command,
        sheetPath,
        tracks: stagedTracks.map((track) => track.filePath),
      });
      const result = await runRomWeaverJson(
        command,
        toRomWeaverOptions({
          invalidateMountCacheBeforeRun: true,
          knownInputPaths: [sheetPath, stagedPatch.filePath, ...stagedTracks.map((track) => track.filePath)],
          logLevel,
          onEvent: relaySimpleProgress(onProgress ? forwardCreatePatchProgress(onProgress) : undefined),
          onLog,
          signal,
        }),
      );
      if (!(result.ok && result.exitCode === 0))
        await throwRomWeaverFailureWithBrowserOutputContext(result, "DCP patch apply failed", "apply DCP patch output");
      const rebuiltPath = getRebuiltTrackPath(result);
      const trackIndex = stagedTracks.findIndex((track) => track.filePath === rebuiltPath);
      const trackFileName = tracks[trackIndex]?.fileName;
      if (!trackFileName) throw new Error(`DCP apply rebuilt an unknown track: ${rebuiltPath || "(none reported)"}`);
      const emitted = getEmittedFileDetails(result);
      const output = await workerIo.createWorkerOutput(
        {
          cleanup: scope.cleanup,
          fileName: trackFileName,
          filePath: emitted?.path || outputPath,
          size: emitted?.sizeBytes,
        },
        trackFileName,
        "DCP patch worker did not return browser output",
      );
      scopeAdopted = true;
      return { output, trackFileName, warnings: getRunResultWarnings(result) };
    } finally {
      if (!scopeAdopted) await scope.cleanup().catch(() => undefined);
      await Promise.all(staged.map((entry) => entry.cleanup().catch(() => undefined)));
    }
  };

export { createBrowserDcpApply };
