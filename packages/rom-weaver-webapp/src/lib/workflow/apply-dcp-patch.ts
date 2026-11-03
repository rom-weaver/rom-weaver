import type { InputAsset } from "../input/input-assets.ts";
import type { StagedSource } from "./apply-workflow-state.ts";

// A .dcp is a ZIP that rebuilds a Dreamcast disc's GD-ROM data track, so Apply runs it alone on the whole
// disc instead of patching one file's bytes. It is recognised by file name alone, before the patch is
// staged or ingested: ingesting its ZIP would open an entry selection dialog over the patch's own files.
const DCP_PATCH_ALONE_MESSAGE =
  "A Dreamcast DCP patch rebuilds the whole disc, so it must be applied on its own. Remove or turn off the other patches and cheats.";
const DCP_DISC_REQUIRED_MESSAGE =
  "A Dreamcast DCP patch needs a GD-ROM disc. Add its .gdi or .cue with the track files, a CHD, or an archive of them.";

const isDcpPatchName = (fileName: string | undefined): boolean => !!fileName && /\.dcp$/i.test(fileName);

// Stages already judged to be a DCP, so later readiness passes keep the verdict. A .dcp inside an
// archive (translation.zip holding game.dcp) is not named by the stage: native ingest reports it as
// the archive's one patch leaf (it never descends into a .dcp), so the prepared patch file is named
// .dcp even though the stage's own file name (the archive) is not.
const dcpStages = new WeakSet<object>();

const isDcpPatchStage = <TSource>(stage: StagedSource<TSource>): boolean =>
  dcpStages.has(stage) || isDcpPatchName(stage.state.fileName) || isDcpPatchName(stage.preparedPatchFile?.fileName);

// A cue is a GD-ROM only when it marks the inner program area, the rule CHD output and the Rust
// layout use; a plain CD cue has no data track for the DCP to rebuild.
const isGdRomCueAsset = (asset: InputAsset): boolean =>
  asset.kind === "cue" && /^\s*REM\b.*HIGH-DENSITY AREA/im.test(asset.file.metadata?.cueText || "");

/** The disc sheet a DCP rebuilds: a `.gdi` wins over a GD-ROM `.cue` beside it, as for GD-ROM CHD creation. */
const findDcpDiscSheet = (assets: readonly InputAsset[]): InputAsset | undefined =>
  assets.find((asset) => asset.kind === "gdi") ?? assets.find(isGdRomCueAsset);

type DcpReadinessContext = {
  /** Every prepared input asset, sheets included. */
  inputAssets: readonly InputAsset[];
  /** Another enabled patch or a ROM cheat is in the run. */
  combined: boolean;
};

// A per-patch fault independent of any ROM choice: the card shows it and it blocks Apply like an
// unreadable patch, with no "Apply anyway" override.
const blockDcpPatch = <TSource>(stage: StagedSource<TSource>, message: string): void => {
  stage.state.status = "ready";
  stage.state.patchValidation = { message, status: "invalid", unreadable: true };
};

/**
 * Settle a DCP stage's readiness. It has no byte-level requirements, header, byte order, or target
 * track: the engine picks the GD-ROM data track. The stage targets the disc sheet so the card names
 * the disc. Returns whether the verdict changed.
 */
const evaluateDcpPatchStage = <TSource>(stage: StagedSource<TSource>, context: DcpReadinessContext): boolean => {
  const before = JSON.stringify([stage.state.status, stage.state.patchValidation, stage.state.targetInputId]);
  dcpStages.add(stage);
  stage.state.dcp = true;
  stage.state.requirements = undefined;
  stage.state.checksumPreflight = undefined;
  stage.state.headerResolution = undefined;
  stage.state.n64Resolution = undefined;
  stage.state.targetInputId = undefined;
  stage.state.targetInputFileName = undefined;
  stage.state.patchValidation = undefined;
  const sheet = findDcpDiscSheet(context.inputAssets);
  if (context.combined) blockDcpPatch(stage, DCP_PATCH_ALONE_MESSAGE);
  else if (!context.inputAssets.length) stage.state.status = "needsSelection";
  else if (sheet) {
    stage.state.status = "ready";
    stage.state.targetInputId = sheet.id;
    stage.state.targetInputFileName = sheet.fileName;
  } else blockDcpPatch(stage, DCP_DISC_REQUIRED_MESSAGE);
  return before !== JSON.stringify([stage.state.status, stage.state.patchValidation, stage.state.targetInputId]);
};

export {
  DCP_DISC_REQUIRED_MESSAGE,
  DCP_PATCH_ALONE_MESSAGE,
  evaluateDcpPatchStage,
  findDcpDiscSheet,
  isDcpPatchName,
  isDcpPatchStage,
};
export type { DcpReadinessContext };
