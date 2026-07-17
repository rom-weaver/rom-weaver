import type { WorkflowProgress } from "../../types/progress.ts";
import type { ApplySettings } from "../../types/settings.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { getPreparedAssetFileName } from "./apply-source-staging.ts";
import type { InputSession, StagedSource } from "./apply-workflow-state.ts";
import {
  calculateStandardInputChecksumsForFile,
  cloneChecksumRomProbe,
  cloneChecksumVariants,
  cloneRomType,
  getAssetDecompressionTimeMs,
  getAssetParentCompressions,
  getAssetSourceSize,
  getInputAssetChecksums,
  getPatchFilePrecomputedChecksumMs,
  getPatchFilePrecomputedChecksums,
  getPatchFilePrecomputedChecksumVariants,
  getPatchFilePrecomputedRomType,
  getPrimaryInputAsset,
  isChecksummableInputAsset,
} from "./staged-source-checksums.ts";

type InputChecksumAdapters<TSource> = {
  emitProgress: (event: {
    details?: Record<string, unknown>;
    id: string;
    label: string;
    percent?: number | null;
    role: WorkflowProgress["role"];
    stage: WorkflowProgress["stage"];
    workflow: WorkflowProgress["workflow"];
  }) => void;
  getSelectedInputOwner: () => StagedSource<TSource> | undefined;
  runtime: WorkflowRuntime;
  settings: Partial<ApplySettings>;
  syncInputSessionView: () => void;
  workflowId: string;
};

const finalizeApplyInputChecksums = async <TSource>(
  session: InputSession<TSource> | undefined,
  adapters: InputChecksumAdapters<TSource>,
): Promise<boolean> => {
  const selected = adapters.getSelectedInputOwner();
  if (!session) return false;
  const checksumStages = session.synthetic ? session.stages : [selected];
  for (let index = 0; index < checksumStages.length; index += 1) {
    const stage = checksumStages[index];
    if (!(stage && stage.state.status === "ready" && stage.preparedInputAssets?.[0]?.file)) continue;
    const assets = stage.preparedInputAssets || [];
    for (let assetIndex = 0; assetIndex < assets.length; assetIndex += 1) {
      const asset = assets[assetIndex];
      if (!(asset?.file && isChecksummableInputAsset(asset))) continue;
      if (asset.checksums) continue;
      const precomputed = getPatchFilePrecomputedChecksums(asset.file);
      if (precomputed) {
        asset.checksums = precomputed;
        asset.checksumVariants = getPatchFilePrecomputedChecksumVariants(asset.file);
        asset.romType = getPatchFilePrecomputedRomType(asset.file);
        // A bare ROM checksummed in place (`ingest`) carries its real elapsed time; an archive leaf
        // checksummed during extract has none → 0, which renders as "from extract".
        asset.checksumTimeMs = getPatchFilePrecomputedChecksumMs(asset.file) ?? 0;
        continue;
      }
      const checksumFileName = getPreparedAssetFileName(asset, stage.state.fileName);
      const checksumStartedAt = Date.now();
      const checksumResult = await calculateStandardInputChecksumsForFile({
        emitProgress: adapters.emitProgress,
        file: asset.file,
        logLevel: adapters.settings.logging?.level,
        onLog: adapters.settings.logging?.sink,
        progressId: session.synthetic
          ? `${adapters.workflowId}:${stage.state.id}:${index}:${assetIndex}`
          : `${adapters.workflowId}:${stage.state.id}:${assetIndex}`,
        role: "input",
        runtime: adapters.runtime,
        state: {
          ...stage.state,
          decompressionTimeMs: getAssetDecompressionTimeMs(asset, stage.state.decompressionTimeMs),
          fileName: checksumFileName,
          order: assetIndex,
          parentCompressions: getAssetParentCompressions(asset, stage.parentCompressions),
          size: asset.size,
          sourceSize: getAssetSourceSize(asset, stage.state.sourceSize),
          wasDecompressed: asset.preparation?.wasDecompressed ?? stage.state.wasDecompressed,
        },
        workflow: "apply",
      });
      asset.checksums = checksumResult.checksums;
      asset.checksumVariants = checksumResult.variants;
      asset.romProbe = checksumResult.romProbe;
      asset.romType = checksumResult.romType;
      asset.checksumTimeMs = Date.now() - checksumStartedAt;
    }
    const primaryAsset = getPrimaryInputAsset(assets);
    const primaryChecksums = getInputAssetChecksums(primaryAsset);
    if (primaryChecksums) {
      stage.state.checksums = primaryChecksums;
      stage.state.checksumVariants = cloneChecksumVariants(primaryAsset?.checksumVariants);
      stage.state.checksumTimeMs = primaryAsset?.checksumTimeMs;
      stage.state.romProbe = cloneChecksumRomProbe(primaryAsset?.romProbe);
      stage.state.romType = cloneRomType(primaryAsset?.romType);
    }
  }
  if (session.synthetic) adapters.syncInputSessionView();
  return !!(selected && session.view.state.status === "ready" && selected.preparedInputAssets?.[0]?.file);
};

export { finalizeApplyInputChecksums };
