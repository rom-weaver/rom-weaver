import type { StagedSource } from "./apply-workflow-state.ts";

// A .dcp is a ZIP that rebuilds a Dreamcast disc, so browser Apply cannot run it. It is recognised by
// file name alone, before the patch is staged or ingested: ingesting its ZIP would open an entry
// selection dialog over the patch's own files and leak the extracted copies.
const DCP_BROWSER_UNSUPPORTED_MESSAGE =
  "Dreamcast DCP patches are not supported in browser Apply yet. Apply this patch with the CLI using a .cue or .gdi disc: https://rom-weaver.com/docs/cli-apply#apply-a-dreamcast-dcp-patch";

const isDcpPatchName = (fileName: string | undefined): boolean => !!fileName && /\.dcp$/i.test(fileName);

// Stages already judged to be a DCP, so later readiness passes keep the verdict. A .dcp inside an
// archive (translation.zip holding game.dcp) is not named by the stage: native ingest reports it as
// the archive's one patch leaf (it never descends into a .dcp), so the prepared patch file is named
// .dcp even though the stage's own file name (the archive) is not.
const dcpStages = new WeakSet<object>();

const isDcpPatchStage = <TSource>(stage: StagedSource<TSource>): boolean =>
  dcpStages.has(stage) || isDcpPatchName(stage.state.fileName) || isDcpPatchName(stage.preparedPatchFile?.fileName);

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

export { isDcpPatchName, isDcpPatchStage, markDcpPatchUnsupported };
