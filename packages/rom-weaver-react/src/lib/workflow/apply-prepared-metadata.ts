import type { ApplyWorkflowParentCompression } from "../../types/apply-workflow.ts";
import { getInputPreparationMetrics, type InputParentCompression } from "../input/input-assets.ts";
import type { prepareInputFile } from "../input/input-preparation-service.ts";
import { getBaseFileName } from "../input/path-utils.ts";
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
  // The cue is not shown as its own row; its text rides on the sibling bin/track rows via
  // `cueText`. Output generation still reads `preparedInputAssets` directly, so the cue asset
  // stays available there. Filter the cue out of the UI-facing resolved inputs only.
  const assets = (stage.preparedInputAssets || []).filter((asset) => asset.kind !== "cue");
  const preparation = getInputPreparationMetrics(assets);
  stage.parentCompressions = normalizeParentCompressions(preparation?.parentCompressions);
  stage.state.fileName = getPreparedAssetFileName(assets[0], stage.state.fileName || stage.state.id);
  stage.state.size = assets.reduce((total, asset) => total + asset.size, 0) || stage.state.size;
  stage.state.sourceSize =
    (typeof preparation?.sourceSize === "number" && Number.isFinite(preparation.sourceSize)
      ? preparation.sourceSize
      : stage.state.sourceSize) || stage.state.size;
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

const applyPreparedPatchMetadata = <TSource>(
  stage: StagedSource<TSource>,
  prepared: Awaited<ReturnType<typeof prepareInputFile>>,
) => {
  stage.parentCompressions = normalizeParentCompressions(prepared.parentCompressions);
  stage.state.fileName = getBaseFileName(prepared.file.fileName || stage.state.fileName || stage.state.id);
  stage.state.size = prepared.file.fileSize;
  stage.state.sourceSize = prepared.sourceSize || prepared.file.fileSize;
  stage.state.decompressionTimeMs = prepared.wasDecompressed ? prepared.decompressionTimeMs : undefined;
  stage.state.wasDecompressed = prepared.wasDecompressed;
};

export { applyPreparedInputMetadata, applyPreparedPatchMetadata };
