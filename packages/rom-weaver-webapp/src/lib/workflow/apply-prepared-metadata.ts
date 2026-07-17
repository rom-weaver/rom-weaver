import type { ApplyWorkflowParentCompression } from "../../types/apply-workflow.ts";
import { getInputPreparationMetrics, type InputParentCompression } from "../input/input-assets.ts";
import type { prepareInputFile } from "../input/input-preparation-service.ts";
import { getBaseFileName } from "../input/path-utils.ts";
import { chdModeFromMetadata } from "../input/rom-specific-file-utils.ts";
import { getPreparedAssetFileName } from "./apply-source-staging.ts";
import type { StagedSource } from "./apply-workflow-state.ts";
import { getInputAssetChecksums, getPrimaryInputAsset } from "./staged-source-checksums.ts";

const normalizeParentCompressions = (
  parentCompressions: InputParentCompression[] | undefined,
): ApplyWorkflowParentCompression[] =>
  (parentCompressions || []).map((entry) => ({
    decompressionTimeMs: entry.decompressionTimeMs,
    depth: entry.depth,
    fileName: entry.fileName,
    kind: entry.kind,
    outputSize: entry.outputSize,
    sourceSize: entry.sourceSize,
  }));

const applyPreparedInputMetadata = <TSource>(stage: StagedSource<TSource>) => {
  const assets = stage.preparedInputAssets || [];
  const preparation = getInputPreparationMetrics(assets);
  stage.parentCompressions = normalizeParentCompressions(preparation?.parentCompressions);
  stage.state.fileName = getPreparedAssetFileName(assets[0], stage.state.fileName || stage.state.id);
  stage.state.size = assets.reduce((total, asset) => total + asset.size, 0) || stage.state.size;
  stage.state.sourceSize =
    (typeof preparation?.sourceSize === "number" && Number.isFinite(preparation.sourceSize)
      ? preparation.sourceSize
      : stage.state.sourceSize) || stage.state.size;
  stage.state.chdMode =
    assets.map((asset) => chdModeFromMetadata(asset.file.metadata)).find((mode) => mode) ||
    (assets.some((asset) => asset.kind === "cue" || asset.file.metadata?.cuePath || asset.file.metadata?.cueText)
      ? "cd"
      : stage.state.chdMode);
  stage.state.decompressionTimeMs =
    typeof preparation?.decompressionTimeMs === "number" && Number.isFinite(preparation.decompressionTimeMs)
      ? preparation.decompressionTimeMs
      : undefined;
  stage.state.wasDecompressed = preparation?.wasDecompressed === true;
  if (!stage.state.checksums) {
    const precomputed = getInputAssetChecksums(getPrimaryInputAsset(assets));
    if (precomputed) {
      stage.state.checksums = precomputed;
      stage.state.checksumTimeMs = 0;
    }
  }
};

/** Side-channel chain attached to a fanned-out leaf patch File so a re-stage (which sees only the
 * raw patch, not its parent archive) can still render the archive-nesting "extract section". */
type NestedPatchSourceMetadata = { __nestedParentCompressions?: InputParentCompression[] };

const applyPreparedPatchMetadata = <TSource>(
  stage: StagedSource<TSource>,
  prepared: Awaited<ReturnType<typeof prepareInputFile>>,
) => {
  const carried = (stage.source as Partial<NestedPatchSourceMetadata> | undefined)?.__nestedParentCompressions;
  // On a re-stage the source is a raw leaf File, so `prepared` has no nesting chain; fall back to
  // the chain (and its root extract time) carried on the implicit leaf source so the row keeps its
  // extract section, parent-archive size, and elapsed time across re-stages.
  const usingCarried = !prepared.parentCompressions?.length && !!carried?.length;
  const activeChain = usingCarried ? carried : prepared.parentCompressions;
  stage.parentCompressions = normalizeParentCompressions(activeChain);
  stage.state.fileName = getBaseFileName(prepared.file.fileName || stage.state.fileName || stage.state.id);
  stage.state.size = prepared.file.fileSize;
  stage.state.sourceSize = prepared.sourceSize || prepared.file.fileSize;
  // The leaf patch itself often isn't decompressed (an already-extracted multi-select pick, or a
  // re-staged raw leaf) - its extract time lives on the nesting chain's root archive. Surface that
  // root time from whichever chain is active (prepared or the carried side-channel) so the patch
  // row's "extract:" timing renders instead of going blank.
  const chainRootTime = activeChain?.[0]?.decompressionTimeMs;
  stage.state.decompressionTimeMs = prepared.wasDecompressed
    ? prepared.decompressionTimeMs
    : typeof chainRootTime === "number"
      ? chainRootTime
      : undefined;
  stage.state.wasDecompressed = prepared.wasDecompressed || typeof chainRootTime === "number";
};

export { applyPreparedInputMetadata, applyPreparedPatchMetadata, normalizeParentCompressions };
