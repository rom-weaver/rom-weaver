import type { StagedSource } from "./apply-workflow-state.ts";

// A .dcp is a ZIP that rebuilds a Dreamcast disc, so browser Apply cannot run it. It is recognised by
// file name alone, before the patch is staged or ingested: ingesting its ZIP would open an entry
// selection dialog over the patch's own files and leak the extracted copies.
const DCP_BROWSER_UNSUPPORTED_MESSAGE =
  "Dreamcast DCP patches are not supported in browser Apply yet. Apply this patch with the CLI using a .cue or .gdi disc: https://rom-weaver.com/docs/cli-apply#apply-a-dreamcast-dcp-patch";

const isDcpPatchName = (fileName: string | undefined): boolean => !!fileName && /\.dcp$/i.test(fileName);

// A .dcp inside an archive (translation.zip holding game.dcp) cannot be named up front: the archive
// ingest runs in the worker and only fails once it reaches the nested .dcp, whose path the nested
// extract error names. Recognise that failure so the zipped DCP gets the same card as a bare one.
const ZIPPED_DCP_ERROR_REGEX = /nested extract failed for `[^`]*\.dcp`/i;

const isZippedDcpError = (error: unknown): boolean =>
  ZIPPED_DCP_ERROR_REGEX.test(error instanceof Error ? error.message : String(error ?? ""));

// Stages already judged to be a DCP, so later readiness passes keep the verdict even though the
// stage's own file name (the archive) does not end in .dcp.
const dcpStages = new WeakSet<object>();

const isDcpPatchStage = <TSource>(stage: StagedSource<TSource>): boolean =>
  dcpStages.has(stage) || isDcpPatchName(stage.state.fileName);

// Record the failed-card verdict. It is a per-patch fault independent of any ROM, so the card shows it
// with no ROM, one ROM, or many patchable assets, and it blocks Apply like an unreadable patch.
const markDcpPatchUnsupported = <TSource>(stage: StagedSource<TSource>): void => {
  dcpStages.add(stage);
  stage.state.requirements = undefined;
  stage.state.checksumPreflight = undefined;
  stage.state.targetInputId = undefined;
  stage.state.targetInputFileName = undefined;
  stage.state.status = "ready";
  stage.state.patchValidation = {
    message: DCP_BROWSER_UNSUPPORTED_MESSAGE,
    status: "invalid",
    unreadable: true,
  };
};

export { isDcpPatchName, isDcpPatchStage, isZippedDcpError, markDcpPatchUnsupported };
