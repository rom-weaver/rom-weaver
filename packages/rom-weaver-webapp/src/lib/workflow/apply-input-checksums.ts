import type { WorkflowProgress } from "../../types/progress.ts";
import type { ApplySettings } from "../../types/settings.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { ParsedIdentifyResolution } from "../../types/identify.ts";
import { lookupExpectedRom } from "../apply/expected-rom-lookup.ts";
import { createLogger } from "../logging.ts";
import { getPrimaryInputAsset, type InputAsset, isChecksummableInputAsset } from "../input/input-assets.ts";
import { shouldIdentifySource } from "../input/input-identification-policy.ts";
import { getPreparedAssetFileName } from "./apply-source-staging.ts";
import type { InputSession, StagedSource } from "./apply-workflow-state.ts";
import {
  calculateStandardInputChecksumsForFile,
  cloneChecksumRomProbe,
  cloneChecksumVariants,
  cloneIdentification,
  cloneRomType,
  getAssetDecompressionTimeMs,
  getAssetParentCompressions,
  getAssetSourceSize,
  getInputAssetChecksums,
  getPatchFilePrecomputedChecksumMs,
  getPatchFilePrecomputedChecksums,
  getPatchFilePrecomputedChecksumVariants,
  getPatchFilePrecomputedIdentification,
  getPatchFilePrecomputedIdentifyRetry,
  getPatchFilePrecomputedRomType,
} from "./staged-source-checksums.ts";

const logger = createLogger("apply-input-identify");

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
  /** False once the session was removed or replaced, so a late identification is dropped. */
  isCurrentSession: (session: InputSession<TSource>) => boolean;
  /** Called after a late identification updated the staged input. */
  onIdentified: () => void;
  runtime: WorkflowRuntime;
  settings: Partial<ApplySettings>;
  syncInputSessionView: () => void;
  workflowId: string;
};

/**
 * An ingest that stopped waiting for identify data reports `unavailable` while the pack keeps
 * loading. Once that load succeeds, look the already-computed checksums up again and update the
 * card; a failed load, a removed or replaced input, or a changed identification leaves it alone.
 */
const reidentifyWhenLoaded = <TSource>({
  adapters,
  asset,
  retry,
  session,
  stage,
}: {
  adapters: InputChecksumAdapters<TSource>;
  asset: InputAsset;
  retry: Promise<boolean>;
  session: InputSession<TSource>;
  stage: StagedSource<TSource>;
}): void => {
  const pending = asset.identification;
  const checksums = Object.fromEntries(Object.entries(asset.checksums ?? {}).filter(([, value]) => !!value));
  void (async () => {
    if (!((await retry) && Object.keys(checksums).length)) return;
    const found = await lookupExpectedRom({
      checksums,
      ...(typeof asset.size === "number" ? { size: asset.size } : {}),
    });
    if (found?.status === "unavailable") return;
    if (!adapters.isCurrentSession(session) || asset.identification !== pending) return;
    asset.identification = found ?? ({ matches: [], status: "unknown" } satisfies ParsedIdentifyResolution);
    if (getPrimaryInputAsset(stage.preparedInputAssets || []) === asset) {
      stage.state.identification = cloneIdentification(asset.identification);
    }
    if (session.synthetic) adapters.syncInputSessionView();
    adapters.onIdentified();
  })().catch((error: unknown) => logger.warn("late ROM identification failed", { error }));
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
    let resolvedOrder = 0;
    for (let assetIndex = 0; assetIndex < assets.length; assetIndex += 1) {
      const asset = assets[assetIndex];
      if (!(asset?.file && isChecksummableInputAsset(asset))) continue;
      const order = resolvedOrder;
      resolvedOrder += 1;
      if (asset.checksums) continue;
      const precomputed = getPatchFilePrecomputedChecksums(asset.file);
      if (precomputed) {
        asset.checksums = precomputed;
        asset.checksumVariants = getPatchFilePrecomputedChecksumVariants(asset.file);
        asset.identification = getPatchFilePrecomputedIdentification(asset.file);
        asset.romType = getPatchFilePrecomputedRomType(asset.file);
        // A bare ROM checksummed in place (`ingest`) carries its real elapsed time; an archive leaf
        // checksummed during extract has none → 0, which renders as "from extract".
        asset.checksumTimeMs = getPatchFilePrecomputedChecksumMs(asset.file) ?? 0;
        const precomputedRetry = getPatchFilePrecomputedIdentifyRetry(asset.file);
        if (precomputedRetry) reidentifyWhenLoaded({ adapters, asset, retry: precomputedRetry, session, stage });
        continue;
      }
      const checksumFileName = getPreparedAssetFileName(asset, stage.state.fileName);
      const checksumStartedAt = Date.now();
      const checksumResult = await calculateStandardInputChecksumsForFile({
        emitProgress: adapters.emitProgress,
        file: asset.file,
        identify: shouldIdentifySource(asset.file),
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
          order,
          parentCompressions: getAssetParentCompressions(asset, stage.parentCompressions),
          size: asset.size,
          sourceSize: getAssetSourceSize(asset, stage.state.sourceSize),
          wasDecompressed: asset.preparation?.wasDecompressed ?? stage.state.wasDecompressed,
        },
        workflow: "apply",
      });
      asset.checksums = checksumResult.checksums;
      asset.checksumVariants = checksumResult.variants;
      asset.identification = checksumResult.identification;
      asset.romProbe = checksumResult.romProbe;
      asset.romType = checksumResult.romType;
      asset.checksumTimeMs = Date.now() - checksumStartedAt;
      if (checksumResult.identifyRetry) {
        reidentifyWhenLoaded({ adapters, asset, retry: checksumResult.identifyRetry, session, stage });
      }
    }
    const primaryAsset = getPrimaryInputAsset(assets);
    const primaryChecksums = getInputAssetChecksums(primaryAsset);
    if (primaryChecksums) {
      stage.state.checksums = primaryChecksums;
      stage.state.checksumVariants = cloneChecksumVariants(primaryAsset?.checksumVariants);
      stage.state.identification = cloneIdentification(primaryAsset?.identification);
      stage.state.checksumTimeMs = primaryAsset?.checksumTimeMs;
      stage.state.romProbe = cloneChecksumRomProbe(primaryAsset?.romProbe);
      stage.state.romType = cloneRomType(primaryAsset?.romType);
    }
  }
  if (session.synthetic) adapters.syncInputSessionView();
  return !!(selected && session.view.state.status === "ready" && selected.preparedInputAssets?.[0]?.file);
};

export { finalizeApplyInputChecksums };
