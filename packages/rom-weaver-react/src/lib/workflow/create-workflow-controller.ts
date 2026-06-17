import type { ChecksumVariant } from "../../types/checksum.ts";
import type { CreateWorkflowParentCompression, CreateWorkflowSourceState } from "../../types/create-workflow.ts";
import type { CreateResult } from "../../types/public.ts";
import type { SelectionCandidate } from "../../types/selection.ts";
import type { CreateSettings, PatchFormat } from "../../types/settings.ts";
import type { WorkflowOptions, WorkflowWarning } from "../../types/workflow-controller.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { CreatePatchInput, CreateWorkflowOptions } from "../../types/workflow-runtime-types.ts";
import { ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY } from "../../wasm/generated/rom-weaver-format-metadata.ts";
import { CREATE_ARCHIVE_COMPRESSION_FORMATS } from "../compression/container-format-registry.ts";
import {
  createPatchFormatSupportsCreateSizes,
  getCreatePatchFormatSizeErrorMessage,
  normalizeCreatePatchFormat,
} from "../create/patch-format-limits.ts";
import { createWorkflowDeps, runCreateWorkflow } from "../create/workflow.ts";
import { RomWeaverError, withAbortSignal } from "../errors.ts";
import { getFileNameWithoutExtension } from "../input/path-utils.ts";
import { wrapPublicOutput } from "../output/index.ts";
import { BaseWorkflowController, type BaseWorkflowSnapshot, type SourceValidator } from "./base-workflow-controller.ts";
import { cloneCandidate, cloneValue, cloneWarning, getPreparationProgressStage, isRecord } from "./controller-utils.ts";
import type { SharedRomSourceSession, SharedRomStagedSource, StagedRomSourceController } from "./staged-rom-source.ts";
import {
  calculateStandardInputChecksumsForFile,
  cloneChecksumVariants,
  getAssetDecompressionTimeMs,
  getAssetParentCompressions,
  getAssetSourceSize,
  getInputAssetChecksums,
  getPatchFilePrecomputedChecksums,
  getPatchFilePrecomputedChecksumVariants,
  getPrimaryInputAsset,
  isChecksummableInputAsset,
  type StandardWorkflowChecksums,
} from "./staged-source-checksums.ts";

type SourceRole = "modified" | "original";
type SourceStatus = CreateWorkflowSourceState["status"];
type ParentCompression = CreateWorkflowParentCompression;
type CreateWorkflowChecksums = StandardWorkflowChecksums;
type InternalSourceState = {
  id: string;
  fileName?: string;
  status: SourceStatus;
  candidates: SelectionCandidate[];
  parentCompressions: ParentCompression[];
  selectedCandidateId?: string;
  size?: number;
  sourceSize?: number;
  chdMode?: string;
  checksums?: CreateWorkflowChecksums;
  checksumTimeMs?: number;
  checksumVariants?: ChecksumVariant[];
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
  warnings: WorkflowWarning[];
  role: SourceRole;
};
type StagedSource<TSource> = SharedRomStagedSource<TSource, InternalSourceState>;
type SourceSession<TSource> = SharedRomSourceSession<TSource, InternalSourceState>;

const SUPPORTED_CREATE_PATCH_TYPES = new Set<PatchFormat | string>(
  ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.supportedCreateFormats,
);
const CREATE_OUTPUT_FORMATS = new Set(["none", ...CREATE_ARCHIVE_COMPRESSION_FORMATS]);

const cloneSourceState = (state: InternalSourceState | null | undefined) =>
  state
    ? ({
        candidates: state.candidates.map(cloneCandidate),
        chdMode: state.chdMode,
        checksums: state.checksums ? cloneValue(state.checksums) : undefined,
        checksumTimeMs: state.checksumTimeMs,
        checksumVariants: cloneChecksumVariants(state.checksumVariants),
        decompressionTimeMs: state.decompressionTimeMs,
        fileName: state.fileName,
        id: state.id,
        parentCompressions: state.parentCompressions.map((entry) => ({ ...entry })),
        selectedCandidateId: state.selectedCandidateId,
        size: state.size,
        sourceSize: state.sourceSize,
        status: state.status,
        warnings: state.warnings.map(cloneWarning),
        wasDecompressed: state.wasDecompressed,
      } satisfies CreateWorkflowSourceState)
    : null;

/** Reactive snapshot of the create workflow's staged state (see {@link BaseWorkflowController.getSnapshot}). */
type CreateWorkflowSnapshot = BaseWorkflowSnapshot & {
  original: CreateWorkflowSourceState | null;
  modified: CreateWorkflowSourceState | null;
  patchType: string;
  outputName: string;
  manualOutputName: boolean;
};

class CreateWorkflowController<TSource, TDestination> extends BaseWorkflowController<
  TSource,
  CreateSettings,
  CreateWorkflowSnapshot
> {
  private readonly sourceStages: StagedRomSourceController<TSource, InternalSourceState>;
  private patchType?: PatchFormat | string;
  private outputName = "";
  private manualOutputName = false;
  private originalSession?: SourceSession<TSource>;
  private modifiedSession?: SourceSession<TSource>;

  constructor(
    runtime: WorkflowRuntime,
    options: WorkflowOptions<CreateSettings> = {},
    validateSources?: SourceValidator<TSource>,
  ) {
    super("create", runtime, options, validateSources);
    this.sourceStages = this.createStagedController<InternalSourceState>({
      getExecutionOptions: () => this.createExecutionOptions(),
      getSessionId: (role) => role,
      getSourceId: (role, index) => `${role}-${index + 1}`,
    });
    this.patchType = this.settings.format;
    if (typeof this.settings.output?.outputName === "string") {
      this.manualOutputName = true;
      this.outputName = this.settings.output.outputName;
    }
    if (!this.manualOutputName) this.outputName = this.buildAutomaticOutputName();
  }

  getOriginal(): CreateWorkflowSourceState | null {
    return cloneSourceState(this.originalSession?.view.state);
  }

  getModified(): CreateWorkflowSourceState | null {
    return cloneSourceState(this.modifiedSession?.view.state);
  }

  async setOriginal(source: TSource | TSource[]): Promise<void> {
    return this.setSource("setOriginal", "original", source);
  }

  async setModified(source: TSource | TSource[]): Promise<void> {
    return this.setSource("setModified", "modified", source);
  }

  /**
   * Swap the original and modified sources without re-staging them. The sessions
   * already hold the extracted/prepared source, so the swap is a slot exchange —
   * no decompression or checksum work is repeated. Used by the UI's "Swap"
   * action so flipping the patch direction stays instant.
   */
  async swap(): Promise<void> {
    return this.mutate("swap", async () => {
      const original = this.originalSession;
      this.originalSession = this.modifiedSession;
      this.modifiedSession = original;
      if (!this.manualOutputName) this.outputName = this.buildAutomaticOutputName();
    });
  }

  async setPatchType(patchType: PatchFormat | string): Promise<void> {
    return this.mutate("setPatchType", async () => {
      this.patchType = patchType;
      if (!this.manualOutputName) this.outputName = this.buildAutomaticOutputName();
    });
  }

  async setOutputName(name: string): Promise<void> {
    return this.mutate("setOutputName", async () => {
      const normalizedName = name.trim();
      this.manualOutputName = !!normalizedName;
      this.outputName = this.manualOutputName ? name : this.buildAutomaticOutputName();
    });
  }

  async setSettings(settings: Partial<CreateSettings>): Promise<void> {
    return this.mutate("setSettings", async () => {
      this.settings = cloneValue(settings || {});
      if (this.settings.format) this.patchType = this.settings.format;
      if (typeof this.settings.output?.outputName === "string" && this.settings.output.outputName.trim()) {
        this.manualOutputName = true;
        this.outputName = this.settings.output.outputName;
      } else if (!this.manualOutputName) {
        this.outputName = this.buildAutomaticOutputName();
      }
    });
  }

  async run(): Promise<CreateResult<TDestination>> {
    return this.mutate("run", async () => {
      const original = this.getSelectedSourceOwner(this.originalSession);
      const modified = this.getSelectedSourceOwner(this.modifiedSession);
      if (!(original && modified))
        throw new RomWeaverError("INVALID_INPUT", "Original and modified sources are required");
      if (original.state.status !== "ready" || !original.state.selectedCandidateId)
        throw new RomWeaverError("AMBIGUOUS_SELECTION", "Original source requires candidate selection");
      if (modified.state.status !== "ready" || !modified.state.selectedCandidateId)
        throw new RomWeaverError("AMBIGUOUS_SELECTION", "Modified source requires candidate selection");
      const patchType = this.getPatchType();
      if (!SUPPORTED_CREATE_PATCH_TYPES.has(patchType))
        throw new RomWeaverError("UNSUPPORTED_FORMAT", `Unsupported patch type: ${patchType}`);
      if (!createPatchFormatSupportsCreateSizes(patchType, original.state.size, modified.state.size)) {
        throw new RomWeaverError(
          "UNSUPPORTED_FORMAT",
          getCreatePatchFormatSizeErrorMessage(patchType, original.state.size, modified.state.size) ||
            `Unsupported patch type for create input sizes: ${patchType}`,
        );
      }
      this.getOutputCompression();
      const outputName = this.outputName.trim();
      if (!outputName) throw new RomWeaverError("INVALID_SETTINGS", "Output name is required");
      const result = await withAbortSignal(
        runCreateWorkflow(this.createPatchInput(), this.runtime, createWorkflowDeps as never),
        this.abortController.signal,
      );
      const output = wrapPublicOutput<TDestination>(result.output, this.runtime, 0);
      const rawSize = result.sizeSummary?.rawSize ?? result.sizeSummary?.outputSize ?? result.output.size;
      return {
        modified: this.toSelectedInputInfo(modified, "modified"),
        original: this.toSelectedInputInfo(original, "original"),
        output,
        sizeSummary: { ...(result.sizeSummary || {}), outputSize: output.size, rawSize },
        type: result.format as PatchFormat,
      };
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.abort();
    await this.releaseSourceSession(this.originalSession);
    await this.releaseSourceSession(this.modifiedSession);
    this.originalSession = undefined;
    this.modifiedSession = undefined;
    this.clearListeners();
    this.disposed = true;
  }

  private mutate<TValue>(operation: string, callback: () => Promise<TValue>): Promise<TValue> {
    return this.runQueuedMutation(operation, callback);
  }

  protected computeSnapshot(): CreateWorkflowSnapshot {
    return {
      busy: this.isBusy(),
      id: this.id,
      manualOutputName: this.manualOutputName,
      modified: this.getModified(),
      original: this.getOriginal(),
      outputName: this.outputName,
      patchType: this.getPatchType(),
      ready: this.computeReady(),
    };
  }

  /** Mirror the preconditions enforced by {@link run}: both sources ready+selected and an output
   * name resolved. */
  private computeReady(): boolean {
    const original = this.getSelectedSourceOwner(this.originalSession);
    const modified = this.getSelectedSourceOwner(this.modifiedSession);
    if (!(original && modified)) return false;
    if (original.state.status !== "ready" || !original.state.selectedCandidateId) return false;
    if (modified.state.status !== "ready" || !modified.state.selectedCandidateId) return false;
    return !!this.outputName.trim();
  }

  private async setSource(operation: string, role: SourceRole, source: TSource | TSource[]): Promise<void> {
    return this.mutate(operation, async () => {
      this.validateSources?.(source);
      const sources = Array.isArray(source) ? [...source] : [source];
      if (!sources.length) throw new RomWeaverError("INVALID_INPUT", `No ${role} source was provided`);
      try {
        await this.releaseRoleSession(role);
        await this.runtime.preload?.preloadCapability?.("compression", () => undefined, {
          workerThreads: this.settings.workers?.threads,
        });
        const session = (await this.sourceStages.stageSession(role, sources, {
          allowLazyBrowserRomSource: true,
        })) as SourceSession<TSource>;
        if (role === "original") this.originalSession = session;
        else this.modifiedSession = session;
        await this.sourceStages.maybeResolveBlockingSessionSelection(session);
        await this.finalizeSourceStableState(session);
        if (!this.manualOutputName) this.outputName = this.buildAutomaticOutputName();
      } catch (error) {
        await this.releaseRoleSession(role);
        await this.sourceStages.releaseRuntimeSources(sources);
        throw error;
      }
    });
  }

  private syncSourceSessionView(session: SourceSession<TSource>) {
    this.sourceStages.syncSessionView(session);
  }

  private getSelectedSourceOwner(session: SourceSession<TSource> | undefined): StagedSource<TSource> | undefined {
    return this.sourceStages.getSelectedOwner(session) as StagedSource<TSource> | undefined;
  }

  private async finalizeSourceStableState(session: SourceSession<TSource>) {
    const selected = this.getSelectedSourceOwner(session);
    if (!(selected && session.view.state.status === "ready" && selected.preparedInputAssets?.[0]?.file)) return;
    const checksumStages = session.synthetic ? session.stages : [selected];
    for (let index = 0; index < checksumStages.length; index += 1) {
      const stage = checksumStages[index] as StagedSource<TSource> | undefined;
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
          asset.checksumTimeMs = 0;
          continue;
        }
        const checksumFileName = asset.fileName || stage.state.fileName || stage.state.id;
        const checksumStartedAt = Date.now();
        const checksumResult = await calculateStandardInputChecksumsForFile({
          emitProgress: (event) => this.emitProgress(event),
          file: asset.file,
          logLevel: this.settings.logging?.level,
          onLog: this.settings.logging?.sink,
          progressId: session.synthetic
            ? `${this.id}:${stage.state.id}:${index}:${assetIndex}`
            : `${this.id}:${stage.state.id}:${assetIndex}`,
          role: stage.state.role,
          runtime: this.runtime,
          state: {
            decompressionTimeMs: getAssetDecompressionTimeMs(asset, stage.state.decompressionTimeMs),
            fileName: checksumFileName,
            id: stage.state.id,
            order: assetIndex,
            parentCompressions: getAssetParentCompressions(asset, stage.parentCompressions),
            size: asset.size,
            sourceSize: getAssetSourceSize(asset, stage.state.sourceSize),
            wasDecompressed: asset.preparation?.wasDecompressed ?? stage.state.wasDecompressed,
          },
          workflow: "create",
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
      }
    }
    if (session.synthetic) this.syncSourceSessionView(session);
  }

  private getPreparedPatchSource(stage: StagedSource<TSource>): unknown | undefined {
    return (
      (stage.preparedInputAssets || []).find((asset) => asset.patchable)?.file || stage.preparedInputAssets?.[0]?.file
    );
  }

  private async releaseRoleSession(role: SourceRole) {
    if (role === "original") {
      await this.releaseSourceSession(this.originalSession);
      this.originalSession = undefined;
      return;
    }
    await this.releaseSourceSession(this.modifiedSession);
    this.modifiedSession = undefined;
  }

  private async releaseSourceSession(session?: SourceSession<TSource>) {
    if (!session) return;
    await this.sourceStages.releaseSession(session);
  }

  private getPatchType() {
    return normalizeCreatePatchFormat(String(this.patchType || this.settings.format || "bps"));
  }

  private getOutputCompression() {
    const compression = this.settings.output?.compression || "none";
    if (!CREATE_OUTPUT_FORMATS.has(String(compression))) {
      throw new RomWeaverError("INVALID_SETTINGS", `Unsupported create output compression: ${compression}`);
    }
    return compression as "7z" | "none" | "zip";
  }

  private buildAutomaticOutputName() {
    const modified = this.getModified();
    const original = this.getOriginal();
    const sourceFileName = modified?.fileName || original?.fileName;
    if (!sourceFileName) return this.outputName;
    const baseName = getFileNameWithoutExtension(sourceFileName) || "patch";
    return `${baseName}.${this.getPatchType()}`;
  }

  private createExecutionOptions(): CreateWorkflowOptions {
    const patchType = this.getPatchType();
    return {
      format: patchType,
      input: cloneValue(this.settings.input || {}),
      limits: cloneValue(this.settings.limits || {}),
      logging: cloneValue(this.settings.logging || {}),
      onLog: this.settings.logging?.sink,
      output: {
        ...cloneValue(this.settings.output || {}),
        compression: this.getOutputCompression(),
        outputName: this.outputName || this.settings.output?.outputName,
      },
      patch: this.settings.patch?.metadata ? { metadata: cloneValue(this.settings.patch.metadata) } : undefined,
      signal: this.abortController.signal,
      workers: cloneValue(this.settings.workers || {}),
    };
  }

  private createPatchInput(): CreatePatchInput {
    const original = this.getSelectedSourceOwner(this.originalSession);
    const modified = this.getSelectedSourceOwner(this.modifiedSession);
    if (!(original && modified))
      throw new RomWeaverError("INVALID_INPUT", "Original and modified sources are required");
    const preparedOriginal = this.getPreparedPatchSource(original);
    const preparedModified = this.getPreparedPatchSource(modified);
    return {
      modified: (preparedModified || modified.source) as never,
      options: {
        ...this.createExecutionOptions(),
        onProgress: (progress) => {
          let stage = getPreparationProgressStage(progress);
          if (progress.stage === "output") stage = "compress";
          else if (progress.stage === "create") stage = "create";
          let fallbackLabel = "Preparing input...";
          if (stage === "compress") fallbackLabel = "Compressing output...";
          else if (stage === "create") fallbackLabel = "Creating patch...";
          this.emitProgress({
            details: isRecord(progress.details) ? progress.details : undefined,
            hasProgress: progress.hasProgress,
            id: `${this.id}:worker:${stage}`,
            label: progress.label || fallbackLabel,
            percent:
              typeof progress.percent === "number" && Number.isFinite(progress.percent) ? progress.percent : null,
            role: progress.stage === "output" ? "output" : "worker",
            stage,
            workflow: "create",
          });
        },
      },
      original: (preparedOriginal || original.source) as never,
      originalCrc32: original.state.checksums?.crc32,
      selectedModifiedEntryName: preparedModified ? undefined : modified.selectedArchiveEntry,
      selectedOriginalEntryName: preparedOriginal ? undefined : original.selectedArchiveEntry,
    };
  }
}

export type { CreateWorkflowSnapshot };
export { CreateWorkflowController };
