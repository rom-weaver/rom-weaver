import type { ChecksumVariant } from "../../types/checksum.ts";
import type { ParsedIdentifyResolution } from "../../types/identify.ts";
import type { SelectionCandidate } from "../../types/selection.ts";
import type { CommonSettings } from "../../types/settings.ts";
import type { WorkflowOptions, WorkflowWarning } from "../../types/workflow-controller.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { STANDARD_CHECKSUM_ALGORITHMS } from "../checksum-algorithms.ts";
import { RomWeaverError } from "../errors.ts";
import { type InputAsset, getPrimaryInputAsset, isChecksummableInputAsset } from "../input/input-assets.ts";
import { BaseWorkflowController, type BaseWorkflowSnapshot, type SourceValidator } from "./base-workflow-controller.ts";
import { cloneCandidate, cloneValue, cloneWarning } from "./controller-utils.ts";
import type { SharedParentCompression } from "./staged-source-types.ts";
import type { SharedRomStagedSource, StagedRomSourceController } from "./staged-rom-source.ts";
import {
  getAssetChecksumState,
  calculateInputChecksumsForFile,
  cloneChecksumVariants,
  cloneIdentification,
  getPatchFilePrecomputedChecksumVariants,
  getPatchFilePrecomputedChecksums,
  getPatchFilePrecomputedIdentification,
} from "./staged-source-checksums.ts";

type ChecksumWorkflowSourceStatus = "empty" | "failed" | "loading" | "needsSelection" | "ready";

/** One hashed file of the staged input: the ROM itself, or one track of a multi-file disc. */
type ChecksumWorkflowFile = {
  id: string;
  fileName: string;
  size: number;
  /** Lowercase hex digest per algorithm; an algorithm the runtime could not produce is absent. */
  checksums: Record<string, string>;
  checksumVariants?: ChecksumVariant[];
  trackNumber?: number;
};

type ChecksumWorkflowSourceState = {
  id: string;
  fileName?: string;
  status: ChecksumWorkflowSourceStatus;
  candidates: SelectionCandidate[];
  selectedCandidateId?: string;
  size?: number;
  sourceSize?: number;
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
  parentCompressions: SharedParentCompression[];
  identification?: ParsedIdentifyResolution;
  /** Every checksummed file, primary first. Cue and GDI sheets are not hashed. */
  files: ChecksumWorkflowFile[];
  warnings: WorkflowWarning[];
};

type InternalSourceState = Omit<ChecksumWorkflowSourceState, "files"> & { role: "input" };
type StagedSource<TSource> = SharedRomStagedSource<TSource, InternalSourceState>;

/** Reactive snapshot of the checksum workflow's staged state (see {@link BaseWorkflowController.getSnapshot}). */
type ChecksumWorkflowSnapshot = BaseWorkflowSnapshot & { input: ChecksumWorkflowSourceState | null };

const CHECKSUM_INPUT_ROLE = "input" as const;

const getAssetChecksums = (asset: InputAsset): Record<string, string> => ({
  ...getPatchFilePrecomputedChecksums(asset.file),
  ...asset.checksums,
});

/* Merge a later pass's variants into the known ones by id, so each variant
   carries every algorithm computed so far. */
const mergeChecksumVariants = (
  known: ChecksumVariant[] | undefined,
  added: ChecksumVariant[] | undefined,
): ChecksumVariant[] | undefined => {
  if (!added?.length) return known;
  if (!known?.length) return added;
  const merged = known.map((variant) => {
    const match = added.find((entry) => entry.id === variant.id);
    return match ? { ...variant, checksums: { ...variant.checksums, ...match.checksums } } : variant;
  });
  return [...merged, ...added.filter((entry) => !known.some((variant) => variant.id === entry.id))];
};

/**
 * Stages one ROM exactly like apply and trim - archives extract, and a multi-ROM
 * input asks which member to use - then hashes the resolved file(s) with any
 * checksum algorithm the runtime supports. Staging hashes the standard set
 * (reusing digests computed during extraction); {@link calculate} adds more.
 */
class ChecksumWorkflowController<TSource> extends BaseWorkflowController<
  TSource,
  CommonSettings,
  ChecksumWorkflowSnapshot
> {
  private readonly inputStages: StagedRomSourceController<TSource, InternalSourceState>;
  private inputStage?: StagedSource<TSource>;

  constructor(
    runtime: WorkflowRuntime,
    options: WorkflowOptions<CommonSettings> = {},
    validateSources?: SourceValidator<TSource>,
  ) {
    super("checksum", runtime, options, validateSources);
    this.inputStages = this.createStagedController<InternalSourceState>({
      getExecutionOptions: () => ({
        input: cloneValue(this.settings.input || {}),
        logging: cloneValue(this.settings.logging || {}),
        onLog: this.settings.logging?.sink,
        signal: this.abortController.signal,
        workers: cloneValue(this.settings.workers || {}),
      }),
      getSourceId: (_role, index) => `${CHECKSUM_INPUT_ROLE}-${index + 1}`,
      releasePreparedOnSelection: "always",
    });
  }

  getInput(): ChecksumWorkflowSourceState | null {
    const stage = this.inputStage;
    if (!stage) return null;
    const { state } = stage;
    return {
      candidates: state.candidates.map(cloneCandidate),
      decompressionTimeMs: state.decompressionTimeMs,
      fileName: state.fileName,
      files: state.status === "ready" ? this.getChecksumFiles(stage) : [],
      id: state.id,
      identification: cloneIdentification(state.identification),
      parentCompressions: (state.parentCompressions || []).map((entry) => ({ ...entry })),
      selectedCandidateId: state.selectedCandidateId,
      size: state.size,
      sourceSize: state.sourceSize,
      status: state.status,
      warnings: state.warnings.map(cloneWarning),
      wasDecompressed: state.wasDecompressed,
    };
  }

  async setInput(source: TSource): Promise<void> {
    return this.runExclusiveMutation("setInput", async () => {
      this.validateSources?.(source);
      try {
        await this.releaseInputStage();
        const stage = (await this.inputStages.stageSource(
          this.inputStages.createInitialSource(CHECKSUM_INPUT_ROLE, source, 0),
        )) as StagedSource<TSource>;
        this.inputStage = stage;
        await this.inputStages.maybeResolveBlockingStageSelection(stage);
        this.trace("checksum.input.staged", { fileName: stage.state.fileName, status: stage.state.status });
        if (stage.state.status === "ready") await this.hashAssets(stage, undefined);
      } catch (error) {
        await this.releaseInputStage();
        await this.inputStages.releaseRuntimeSources([source]);
        throw error;
      }
    });
  }

  /**
   * Hash the staged file(s) with every algorithm in `algorithms` that is not already known.
   * {@link abort} cancels only this pass: the staged ROM stays ready for another one.
   */
  async calculate(algorithms: readonly string[]): Promise<ChecksumWorkflowSourceState> {
    return this.runQueuedMutation(
      "calculate",
      async () => {
        const stage = this.inputStage;
        if (!stage) throw new RomWeaverError("INVALID_INPUT", "A ROM is required before calculating checksums");
        if (stage.state.status !== "ready" || !stage.state.selectedCandidateId)
          throw new RomWeaverError("AMBIGUOUS_SELECTION", "Checksum source requires candidate selection");
        await this.hashAssets(stage, algorithms);
        return this.getInput() as ChecksumWorkflowSourceState;
      },
      { rearmAbort: true },
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.abort();
    // See settleMutations: releasing while an aborted operation is still going
    // strands whatever it stages next.
    await this.settleMutations();
    await this.releaseInputStage();
    this.clearListeners();
    this.disposed = true;
  }

  protected computeSnapshot(): ChecksumWorkflowSnapshot {
    const input = this.getInput();
    return {
      busy: this.isBusy(),
      id: this.id,
      input,
      ready: input?.status === "ready" && !!input.selectedCandidateId,
    };
  }

  private getChecksummableAssets(stage: StagedSource<TSource>): InputAsset[] {
    const assets = (stage.preparedInputAssets || []).filter(
      (asset) => !!asset?.file && isChecksummableInputAsset(asset),
    );
    const primary = getPrimaryInputAsset(assets);
    return primary ? [primary, ...assets.filter((asset) => asset !== primary)] : assets;
  }

  private getChecksumFiles(stage: StagedSource<TSource>): ChecksumWorkflowFile[] {
    return this.getChecksummableAssets(stage).map((asset) => ({
      checksumVariants: cloneChecksumVariants(
        asset.checksumVariants || getPatchFilePrecomputedChecksumVariants(asset.file),
      ),
      checksums: getAssetChecksums(asset),
      fileName: asset.fileName || stage.state.fileName || stage.state.id,
      id: asset.id,
      size: asset.size,
      ...(typeof asset.trackNumber === "number" ? { trackNumber: asset.trackNumber } : {}),
    }));
  }

  /**
   * Fill in the checksums each asset is missing. With no `algorithms`, this is
   * the staging pass: it hashes the standard set and identifies the ROM, and
   * reuses the digests extraction already produced instead of re-reading them.
   */
  private async hashAssets(stage: StagedSource<TSource>, algorithms: readonly string[] | undefined) {
    const assets = this.getChecksummableAssets(stage);
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index];
      if (!asset) continue;
      const staging = !algorithms;
      const precomputed = getPatchFilePrecomputedChecksums(asset.file);
      if (staging && precomputed) {
        asset.checksumVariants ??= getPatchFilePrecomputedChecksumVariants(asset.file);
        asset.identification ??= getPatchFilePrecomputedIdentification(asset.file);
      }
      const known = getAssetChecksums(asset);
      const missing = (algorithms || STANDARD_CHECKSUM_ALGORITHMS).filter((algorithm) => !known[algorithm]);
      if (!missing.length) continue;
      this.trace("checksum.calculate.start", { algorithms: missing, fileName: asset.fileName, staging });
      const result = await calculateInputChecksumsForFile({
        algorithms: missing,
        emitProgress: (event) => this.emitProgress(event),
        file: asset.file,
        // Only the staging pass identifies; a later pass only adds digests.
        identify: staging,
        logLevel: this.settings.logging?.level,
        onLog: this.settings.logging?.sink,
        progressId: `${this.id}:${stage.state.id}:${index}`,
        role: CHECKSUM_INPUT_ROLE,
        runtime: this.runtime,
        signal: this.abortController.signal,
        state: getAssetChecksumState(asset, stage, index),
        workflow: "checksum",
      });
      const computed = Object.fromEntries(Object.entries(result.checksums).filter(([, value]) => !!value));
      asset.checksums = { ...known, ...computed };
      asset.checksumVariants = mergeChecksumVariants(
        asset.checksumVariants || getPatchFilePrecomputedChecksumVariants(asset.file),
        result.variants,
      );
      if (staging) asset.identification = result.identification;
      this.trace("checksum.calculate.finish", { algorithms: Object.keys(computed), fileName: asset.fileName });
    }
    stage.state.identification = cloneIdentification(assets[0]?.identification);
  }

  private async releaseInputStage() {
    const stage = this.inputStage;
    this.inputStage = undefined;
    if (!stage) return;
    await this.inputStages.releaseSession({
      role: CHECKSUM_INPUT_ROLE,
      sources: [stage.source],
      stages: [stage],
      synthetic: false,
      view: stage,
    });
  }
}

export { ChecksumWorkflowController };
export type { ChecksumWorkflowFile, ChecksumWorkflowSourceState };
