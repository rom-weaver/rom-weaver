import { isDcpPatchName, isDcpPatchStage, markDcpPatchUnsupported } from "./apply-dcp-patch.ts";
import { createVfsFileRef, isVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type {
  ApplyWorkflowWeaveSources,
  ApplyWorkflowInputState,
  ApplyWorkflowPatchState,
} from "../../types/apply-workflow.ts";
import type { ApplyResult, CreateResult } from "../../types/public.ts";
import type { CandidateSelectionRequest, SelectionCandidate } from "../../types/selection.ts";
import type { ApplySettings, CompressionFormat, CreateSettings } from "../../types/settings.ts";
import type { SourceRef } from "../../types/source.ts";
import type { WorkflowOptions } from "../../types/workflow-controller.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { PatchValidationPlan } from "../../wasm/index.ts";
import type {
  ApplyWorkflowOptions,
  PatchInput,
  ProgressEvent,
  PublicOutput,
} from "../../types/workflow-runtime-types.ts";
import type { ParsedPatchLike, PatchFileInstance } from "../../workers/protocol/patch-engine.ts";
import { getPatchProbeRequirements, parsePatchForApply } from "../apply/patch-apply-service.ts";
import { runApplyWorkflow } from "../apply/workflow.ts";
import { runCreateWorkflow } from "../create/workflow.ts";
import { isCompressionFormat } from "../compression/container-format-registry.ts";
import type { CheatRecord } from "../cheats/model.ts";
import { RomWeaverError, toRomWeaverError, withAbortSignal } from "../errors.ts";
import { getPatchFileBlob, getPatchFileBytes, getPatchFileExternalSource } from "../input/binary-service.ts";
import {
  getPrimaryInputAsset,
  type InputAsset,
  type InputParentCompression,
  type PreparedSidecarPatch,
} from "../input/input-assets.ts";
import { collectMemberRefs, findMemberAssets } from "../apply/bare-member-target.ts";
import { getPatchArchiveReplacement } from "../input/patch-archive-replacement.ts";
import {
  getPatchLeafFileForSelection,
  getPatchLeafParentCompressionsForSelection,
  prepareInputFile,
} from "../input/input-preparation-service.ts";
import { wrapPublicOutput } from "../output/index.ts";
import { startStageSpan } from "../runtime/perf-latency.ts";
import { finalizeApplyInputChecksums } from "./apply-input-checksums.ts";
import {
  type ApplyOutputState,
  applyOutputSettings,
  createApplyOutputState,
  getApplyExecutionOutputName,
  recomputeApplyOutputState,
  setApplyOutputFormat,
  setApplyOutputName,
} from "./apply-output-state-machine.ts";
import { createPatchOutputLabel, resolvePatchOutputName } from "./apply-patch-output-naming.ts";
import {
  assignApplyPatchTarget,
  clearApplyPatchTarget,
  evaluateApplyPatchReadiness,
} from "./apply-patch-readiness-state-machine.ts";
import {
  isTransientValidationError,
  type PatchTargetValidationAdapters,
  validateApplyPatchTargets,
} from "./apply-patch-target-validation.ts";
import {
  applyPreparedInputMetadata,
  applyPreparedPatchMetadata,
  normalizeParentCompressions,
} from "./apply-prepared-metadata.ts";
import { releasePreparedSource, releasePreparedSourceAndWait } from "./apply-prepared-source-release.ts";
import {
  canRecoverWithCandidateSelection,
  createSourceStagingOptions,
  getPreparedAssetFileName,
} from "./apply-source-staging.ts";
import {
  cloneInputState,
  clonePatchRequirements,
  clonePatchState,
  cloneResolvedInputStatesForStage,
} from "./apply-state-cloning.ts";
import type {
  InputSession,
  InternalPatchChecksumPreflight,
  InternalSourceState,
  SourceRole,
  SourceValidator,
  StagedSource,
} from "./apply-workflow-state.ts";
import {
  BaseWorkflowController,
  type BaseWorkflowSnapshot,
  type WorkflowProgressEvent,
} from "./base-workflow-controller.ts";
import { cloneCandidate, cloneValue, getSourceFileName, getSourceSize, isRecord } from "./controller-utils.ts";
import { projectSelectionCandidates } from "./selection-candidate-projection.ts";
import type { StagedRomSourceController } from "./staged-rom-source.ts";
import {
  calculateInputChecksumsForFile,
  cloneChecksumRomProbe,
  getInputAssetChecksums,
} from "./staged-source-checksums.ts";
import {
  type ComputedChecksums,
  isTransformVariant,
  type WeaveRomCheck,
  type WeaveRomExpectation,
  verifyWeaveRom,
} from "./apply-weave-rom-check.ts";

/** A weave-ROM check for this pass: a verdict, or `unavailable` when hashing failed transiently. */
type WeaveRomRunCheck =
  | WeaveRomCheck
  | { message: string; missing: string[]; status: "unavailable"; variant?: undefined };

/** Side-channel chain attached to a fanned-out leaf patch File so a re-stage (which sees only the
 * raw patch, not its parent archive) can still render the archive-nesting "extract section". */
type NestedPatchSourceMetadata = { __nestedParentCompressions?: InputParentCompression[] };

type ApplyWorkflowSnapshot = BaseWorkflowSnapshot & {
  chainPlans: ReadonlyMap<string, PatchValidationPlan>;
  input: ApplyWorkflowInputState | null;
  patches: ApplyWorkflowPatchState[];
  output: {
    manualOutputFormat: boolean;
    manualOutputName: boolean;
    outputFormat: CompressionFormat;
    outputName: string;
  };
};

class ApplyWorkflowController<TSource, TDestination> extends BaseWorkflowController<
  TSource,
  ApplySettings,
  ApplyWorkflowSnapshot
> {
  private readonly ownedSourceRefCounts = new Map<unknown, number>();
  private readonly retainUncompressedOutput: ApplyWorkflowOptions["retainUncompressedOutput"];
  private readonly pendingOwnedSourceReleases = new Map<unknown, ReturnType<typeof setTimeout>>();
  private readonly releasedOwnedSources = new WeakSet<object>();
  /** Latest verification plan per target chain, refreshed by each plan-mode validate pass. The
   * form reads it for chain verdict chips, order suggestions, and output enforceability. */
  readonly latestChainPlans = new Map<string, PatchValidationPlan>();
  private readonly chainLayoutBases = new Map<
    string,
    { fingerprint: string; sources: unknown[]; bases: Array<"base" | "previous"> }
  >();
  private publishedChainPlans: ReadonlyMap<string, PatchValidationPlan> = new Map();
  private readonly inputStages: StagedRomSourceController<TSource, InternalSourceState>;
  private nextCandidateSequence = 0;
  private nextInputSequence = 0;
  private nextPatchSequence = 0;
  private defaultPatchBasis: "auto" | "base" | "previous" = "auto";
  private outputState: ApplyOutputState;
  private inputSession?: InputSession<TSource>;
  private patches: Array<StagedSource<TSource>> = [];
  /** Toggled-off patches from the latest validation pass; they are excluded from the run. Tracked by
   * stage, not index: re-staging (the run's enabled-only list) creates new stages, which none match. */
  private disabledPatches: ReadonlySet<StagedSource<TSource>> = new Set();
  private inputs: TSource[] = [];
  // Object identities MUST remain weak so replaced archives can be collected while restaging stays deduplicated.
  private discoveredSidecarSources = new WeakSet<object>();
  private discoveredSidecarPrimitiveSources = new Set<TSource>();
  private cheatRecords: CheatRecord[] = [];
  private cheatPositions: number[] = [];
  /** The active weave's `rom.checks`, verified against the supplied ROM file. */
  private weaveRom: WeaveRomExpectation | undefined;
  /** Declared ROM checksums staging does not compute (e.g. sha256), hashed once per file. */
  private readonly weaveRomChecksums = new WeakMap<object, ComputedChecksums>();
  /** The variant the weave's `rom.checks` matched when the raw file did not: its asset and CRC32.
   * Patches without layout evidence of their own take their header/byte-order decision from it. */
  private weaveRomLayout: { assetId: string; crc32: string } | undefined;
  /** Cancels the in-flight on-demand weave-ROM hash when the ROM is replaced or cleared. */
  private weaveRomHashAbort: AbortController | undefined;
  /** Picks from an early sidecar dialog (opened off the streamed `patch-manifest` before the ROM
   * finished hashing), keyed by input stage id; `discoverImplicitPatches` applies them instead of
   * re-opening the dialog. Values are chosen file names in apply order; empty = user picked nothing. */
  private earlySidecarSelections = new Map<string, string[]>();
  /** In-flight early sidecar dialogs keyed by input stage id, so a repeated `patch-manifest` event
   * never opens a second dialog and `discoverImplicitPatches` can await the pick before reconciling. */
  private earlySidecarSelectionInFlight = new Map<string, Promise<void>>();

  constructor(
    runtime: WorkflowRuntime,
    options: WorkflowOptions<ApplySettings> = {},
    validateSources?: SourceValidator<TSource>,
  ) {
    super("apply", runtime, options, validateSources);
    this.retainUncompressedOutput = options.retainUncompressedOutput;
    this.outputState = createApplyOutputState(this.settings);
    this.inputStages = this.createStagedController<InternalSourceState>({
      getExecutionOptions: () => this.createExecutionOptions(),
      getPreparedFileName: getPreparedAssetFileName,
      getSessionId: () => "input-session",
      getSourceId: () => `input-${++this.nextInputSequence}`,
    });
  }

  getInput(): ApplyWorkflowInputState | null {
    const session = this.inputSession;
    if (!session?.view) return null;
    const selectedOwner = this.getSelectedInputOwner();
    // Synthetic session = several separately-provided ROMs. After a pick expose only the chosen one
    // ("ask which one" keeps a single input); before it, every ready stage so the prompt can list them.
    const resolvedInputs = session.synthetic
      ? selectedOwner
        ? cloneResolvedInputStatesForStage(selectedOwner, true)
        : session.stages
            .filter((stage) => stage.state.status === "ready")
            .flatMap((stage) => cloneResolvedInputStatesForStage(stage, false))
      : cloneResolvedInputStatesForStage(session.view, true);
    return cloneInputState(session.view.state, session.view.parentCompressions || [], resolvedInputs);
  }

  getPatches(): ApplyWorkflowPatchState[] {
    return this.patches.map((patch) => clonePatchState(patch.state, patch.parentCompressions));
  }

  getPatchSources(): TSource[] {
    return this.patches.map((patch) => patch.source);
  }

  /** Set the ROM cheat records that the next run bakes into the output. */
  setCheats(records: CheatRecord[], cheatPositions: number[] = []): void {
    this.cheatRecords = records.map((record) => cloneValue(record));
    this.cheatPositions = [...cheatPositions];
    this.recomputeOutputState();
  }

  /** Set (or clear) the active weave's expected ROM, verified by the plan pass and the next run. */
  setWeaveRom(expectation: WeaveRomExpectation | undefined): void {
    const next = expectation?.checks ? { ...expectation } : undefined;
    if (next?.checks !== this.weaveRom?.checks || next?.member !== this.weaveRom?.member) {
      this.weaveRomLayout = undefined;
      this.chainLayoutBases.clear();
    }
    this.weaveRom = next;
  }

  /** Export the exact leaves staging prepared, so a weave export right after apply needs no
   * second archive extraction/ingest pass. */
  getBundleExportSources(): ApplyWorkflowWeaveSources {
    return this.getWeaveExportSources();
  }

  getWeaveExportSources(): ApplyWorkflowWeaveSources {
    const session = this.inputSession;
    const selectedOwner = this.getSelectedInputOwner();
    const inputStage = selectedOwner || session?.view;
    const inputAssets = (inputStage?.preparedInputAssets || []).filter((asset) => asset.patchable);
    const primaryAsset = getPrimaryInputAsset(inputAssets);
    const sourceForFile = (file: PatchFileInstance | undefined, fallback: TSource, fileName: string): SourceRef => {
      const external = file ? getPatchFileExternalSource(file, fileName) : undefined;
      if (!external) return fallback as unknown as SourceRef;
      if (isVfsFileRef(external.source)) {
        return createVfsFileRef(external.source.vfs, external.source.path, {
          fileName,
          mediaType: external.source.mediaType,
        });
      }
      return { fileName, size: external.size, source: external.source };
    };
    let exportError: string | undefined;
    const patchTargets = this.patches.map((stage, index) => {
      const targetId = stage.state.targetInputId;
      if (!targetId) {
        exportError = `Patch ${index + 1} has no resolved ROM target`;
        return undefined;
      }
      const target = inputAssets.find((asset) => asset.id === targetId);
      if (!target) {
        exportError = `Patch ${index + 1} target belongs to a different ROM source`;
        return undefined;
      }
      if (target.kind === "track" && !target.member)
        exportError = `Patch ${index + 1} track has no stable member locator`;
      if (target.member && inputAssets.filter((asset) => asset.member === target.member).length > 1)
        exportError = `Patch ${index + 1} member locator is ambiguous: ${target.member}`;
      return target;
    });
    const memberTarget = patchTargets.find((target) => target?.member);
    const romChecksums = getInputAssetChecksums(memberTarget || primaryAsset);
    const rom =
      primaryAsset && inputStage
        ? {
            fileName: memberTarget?.member
              ? inputStage.state.fileName || primaryAsset.fileName || "rom.bin"
              : primaryAsset.file.fileName || primaryAsset.fileName || inputStage.state.fileName || "rom.bin",
            originalSource: inputStage.source as unknown as SourceRef,
            size: memberTarget?.size ?? primaryAsset.size,
            source: memberTarget?.member
              ? (inputStage.source as unknown as SourceRef)
              : sourceForFile(
                  primaryAsset.file,
                  inputStage.source,
                  primaryAsset.file.fileName || primaryAsset.fileName,
                ),
            ...(memberTarget?.member ? { member: memberTarget.member } : {}),
            ...(romChecksums ? { checksums: { ...romChecksums } } : {}),
            ...(inputStage.state.romType?.recommendedFormat
              ? { recommendedFormat: inputStage.state.romType.recommendedFormat }
              : {}),
          }
        : null;
    const patches = this.patches.map((stage, index) => {
      const selectedCandidate = stage.state.candidates.find(
        (candidate) => candidate.id === stage.state.selectedCandidateId,
      );
      const selectedFileName =
        selectedCandidate && "fileName" in selectedCandidate ? selectedCandidate.fileName : undefined;
      const fileName = stage.preparedPatchFile?.fileName || selectedFileName || stage.state.fileName || "patch.bin";
      return {
        fileName,
        originalSource: stage.source as unknown as SourceRef,
        size: stage.preparedPatchFile?.fileSize || stage.state.size,
        source: sourceForFile(stage.preparedPatchFile, stage.source, fileName),
        target:
          stage.state.patchTarget ??
          (patchTargets[index]?.member
            ? { rom: true as const, member: patchTargets[index].member }
            : ({ rom: true } as const)),
      };
    });
    return { patches, rom, ...(exportError ? { error: exportError } : {}) };
  }

  async setInput(
    input: TSource | TSource[],
    options?: {
      appendSidecarPatches?: boolean;
      onPrepared?: (input: ApplyWorkflowInputState | null) => void;
      onFinalized?: (input: ApplyWorkflowInputState | null) => void;
    },
  ): Promise<void> {
    this.cancelWeaveRomHash();
    return this.mutate("setInput", async () => {
      this.weaveRomLayout = undefined;
      this.chainLayoutBases.clear();
      this.trace("input.set.start", {
        inputCount: Array.isArray(input) ? input.length : input ? 1 : 0,
      });
      this.validateSources?.(input);
      const retainedInputs = Array.isArray(input) ? [...input] : [input];
      if (!retainedInputs.length) throw new RomWeaverError("INVALID_INPUT", "Input source is required");
      let replacementSessionCreated = false;
      try {
        this.retainOwnedSources(retainedInputs);
        await this.releaseInputSession();
        this.inputs = retainedInputs;
        const initial = this.createInitialInputView(this.inputs);
        this.inputSession = {
          role: "input",
          sources: this.inputs,
          stages: [],
          synthetic: false,
          view: initial,
        };
        replacementSessionCreated = true;
        this.trace("input.set.initialized", {
          fileName: initial.state.fileName,
          inputCount: this.inputs.length,
        });
        const endStage = startStageSpan("setInput:stageInputSession");
        this.inputSession = await this.stageInputSession(this.inputs);
        const stagedSession = this.inputSession;
        if (!stagedSession) return;
        endStage();
        this.trace("input.set.staged", {
          selectedCandidateId: this.inputSession.view.state.selectedCandidateId,
          stageCount: this.inputSession.stages.length,
          status: this.inputSession.view.state.status,
          synthetic: this.inputSession.synthetic,
        });
        const endSelection = startStageSpan("setInput:resolveSelection");
        await this.maybeResolveBlockingInputSelection();
        endSelection();
        this.trace("input.set.selection-resolved", {
          selectedCandidateId: this.inputSession.view.state.selectedCandidateId,
          status: this.inputSession.view.state.status,
        });
        // Publish the resolved asset shape before checksumming: loose CUE/GDI sets already have their
        // disc group, so hosts can collapse raw drop rows into one card without waiting on track checksums.
        options?.onPrepared?.(this.getInput());
        const endFinalize = startStageSpan("setInput:finalizeStableState");
        await this.finalizeInputStableState();
        endFinalize();
        if (!this.inputSession) {
          options?.onFinalized?.(
            cloneInputState(
              stagedSession.view.state,
              stagedSession.view.parentCompressions || [],
              cloneResolvedInputStatesForStage(stagedSession.view, true),
            ),
          );
          return;
        }
        this.trace("input.set.finalized", {
          hasChecksums: !!this.inputSession.view.state.checksums,
          status: this.inputSession.view.state.status,
        });
        // Surface the fully-checksummed terminal state now; the patch (re)validation below reports
        // only on the patch row and must not keep the ROM row showing "checksumming".
        options?.onFinalized?.(this.getInput());
        const endImplicit = startStageSpan("setInput:discoverImplicitPatches");
        await this.discoverImplicitPatches(options?.appendSidecarPatches);
        endImplicit();
        await this.refreshPatchReadiness();
        this.recomputeOutputState();
        this.trace("input.set.finish", {
          status: this.inputSession.view.state.status,
        });
      } catch (error) {
        if (replacementSessionCreated) await this.releaseInputSession();
        else await this.releaseOwnedSources(retainedInputs);
        this.inputs = [];
        this.trace("input.set.fail", {
          error,
        });
        throw error;
      }
    });
  }

  async clearInput(): Promise<void> {
    this.cancelWeaveRomHash();
    return this.mutate("clearInput", async () => {
      this.weaveRomLayout = undefined;
      this.chainLayoutBases.clear();
      await this.releaseInputSession();
      this.inputs = [];
      this.inputSession = undefined;
      await this.refreshPatchReadiness();
      this.recomputeOutputState();
    });
  }

  async addPatch(patch: TSource): Promise<void> {
    this.assertCanStartOperation();
    try {
      this.validateSources?.(patch);
    } catch (error) {
      throw toRomWeaverError(error);
    }
    const patchIndex = this.patches.length;
    this.retainOwnedSources([patch]);
    const stage = this.createInitialSource("patch", patch, patchIndex);
    stage.outputLabel = createPatchOutputLabel(stage.state.fileName);
    this.patches.push(stage);
    const stagedPromise = this.stagePatchEagerly(stage);
    return this.mutate("addPatch", async () => {
      try {
        const staged = await stagedPromise;
        await this.maybeResolveBlockingPatchSelection(staged);
        await this.evaluatePatchReadiness(staged);
        this.recomputeOutputState();
      } catch (error) {
        const index = this.patches.indexOf(stage);
        if (index !== -1) this.patches.splice(index, 1);
        await releasePreparedSourceAndWait(stage);
        await this.releaseRuntimeSources([stage.source]);
        await this.releaseOwnedSources([stage.source]);
        this.recomputeOutputState();
        throw error;
      }
    });
  }

  /** Swap the patch at {@link index} in place: only that slot re-stages and re-validates. The new
   * stage reuses the replaced slot's id, so the target chain's validation fingerprint (ordered member
   * ids) is unchanged and untouched siblings keep their cached verdicts. Caller falls back to
   * clear-and-re-add for multi-slot or length-changing edits. */
  async replacePatchAt(index: number, patch: TSource): Promise<void> {
    this.assertCanStartOperation();
    const previous = this.patches[index];
    if (index < 0 || index >= this.patches.length || !previous)
      throw new RomWeaverError("WORKFLOW_INVALID_STATE", `No patch to replace at index ${index}`);
    try {
      this.validateSources?.(patch);
    } catch (error) {
      throw toRomWeaverError(error);
    }
    this.retainOwnedSources([patch]);
    const stage = this.createInitialSource("patch", patch, index);
    // Id reuse keeps the chain fingerprint identical - siblings skip re-validation (see doc above).
    stage.state.id = previous.state.id;
    stage.outputLabel = createPatchOutputLabel(stage.state.fileName);
    // Swap the loading stage in immediately so the row reflects it; the detached previous stage is
    // released once the new one is applied.
    this.patches[index] = stage;
    const stagedPromise = this.stagePatchEagerly(stage);
    return this.mutate("replacePatchAt", async () => {
      try {
        const staged = await stagedPromise;
        await this.maybeResolveBlockingPatchSelection(staged);
        await this.evaluatePatchReadiness(staged);
        await releasePreparedSourceAndWait(previous);
        await this.releaseRuntimeSources([previous.source]);
        await this.releaseOwnedSources([previous.source]);
        this.recomputeOutputState();
      } catch (error) {
        // Restore the previous patch so the slot is never left empty, and release the failed stage.
        if (this.patches[index] === stage) this.patches[index] = previous;
        await releasePreparedSourceAndWait(stage);
        await this.releaseRuntimeSources([stage.source]);
        await this.releaseOwnedSources([stage.source]);
        this.recomputeOutputState();
        throw error;
      }
    });
  }

  // Patch I/O and selection MUST start outside the mutation queue to overlap ROM staging.
  // Handle early rejections until the queued mutation can await the same promise.
  private stagePatchEagerly(stage: StagedSource<TSource>): Promise<StagedSource<TSource>> {
    const stagedPromise = this.stageSource(stage, { deferBlockingSelection: true })
      .then((staged) => {
        this.emitPatchAwaitingInputProgress(staged);
        return staged;
      })
      .then(async (staged) => {
        await this.resolvePatchSelectionChoice(staged);
        this.emitPatchAwaitingInputProgress(staged);
        return staged;
      })
      .catch((error) => {
        throw toRomWeaverError(error);
      });
    void stagedPromise.catch(() => undefined);
    return stagedPromise;
  }

  private async addFannedOutPatch(
    patchFile: PatchFileInstance,
    parentCompressions: InputParentCompression[],
  ): Promise<void> {
    this.trace("patch.multiselect.fanout.add", { fileName: patchFile.fileName, patchCount: this.patches.length });
    const stage = this.createInitialSource(
      "patch",
      this.createImplicitPatchSource(patchFile, parentCompressions),
      this.patches.length,
    );
    stage.preparedPatchFile = patchFile;
    stage.outputLabel = createPatchOutputLabel(patchFile.fileName) || stage.outputLabel;
    applyPreparedPatchMetadata(stage, {
      decompressionTimeMs: parentCompressions[0]?.decompressionTimeMs || 0,
      file: patchFile,
      parentCompressions,
      sourceSize: patchFile.fileSize,
      wasDecompressed: true,
    });
    this.addDirectCandidate(stage, "patch", stage.index, stage.state.id);
    stage.state.selectedCandidateId = stage.state.candidates[0]?.id;
    if (stage.outputLabel)
      (stage.preparedPatchFile as PatchFileInstance & { _generatedPatchName?: string })._generatedPatchName =
        stage.outputLabel;
    await this.evaluatePatchReadiness(stage);
    this.patches.push(stage);
  }

  private createImplicitPatchSource(
    patchFile: PatchFileInstance,
    parentCompressions?: InputParentCompression[],
  ): TSource {
    const fileName = patchFile.fileName || "patch.bin";
    if (typeof File !== "undefined") {
      const blob = getPatchFileBlob(patchFile);
      const file = blob
        ? new File([blob], fileName, { type: "application/octet-stream" })
        : new File([new Uint8Array(getPatchFileBytes(patchFile))], fileName, { type: "application/octet-stream" });
      // Carry the archive-nesting chain on the leaf File so a later re-stage (which sees only a raw
      // patch, no archive) can still show the "extract section" in the patch row.
      if (parentCompressions?.length)
        (file as File & NestedPatchSourceMetadata).__nestedParentCompressions = parentCompressions;
      return file as TSource;
    }
    return patchFile as unknown as TSource;
  }

  // Sidecar patches the ROM-staging `ingest` already extracted from this stage's archive (no separate
  // scan); empty unless the source was a mixed ROM+patch archive.
  private stageSidecarPatches(stage: StagedSource<TSource>): PreparedSidecarPatch[] {
    return (stage.preparedInputAssets ?? []).flatMap((asset) => asset.sidecarPatches ?? []);
  }

  /** Intercept the streamed `patch-manifest` event (ingest enumerates sidecar patches BEFORE hashing
   * the ROM) and open the multi-select dialog right away; the pick is reconciled in
   * {@link discoverImplicitPatches} once the input session finishes staging. */
  protected override emitProgress(event: WorkflowProgressEvent): void {
    this.maybeSurfaceEarlySidecarPatches(event);
    super.emitProgress(event);
  }

  private maybeSurfaceEarlySidecarPatches(event: WorkflowProgressEvent): void {
    // Headless soft-patching applies name-matched sidecars without a dialog - nothing to open early.
    if (!this.selectFile) return;
    const details = event.details;
    if (!isRecord(details)) return;
    const manifest = details.patch_manifest;
    if (!isRecord(manifest)) return;
    const stageId = typeof details.sourceId === "string" ? details.sourceId : undefined;
    if (!stageId) return;
    // Surface once per input stage; the manifest can be re-emitted.
    if (this.earlySidecarSelectionInFlight.has(stageId) || this.earlySidecarSelections.has(stageId)) return;
    const patchFileNames = (Array.isArray(manifest.patches) ? manifest.patches : [])
      .map((patch) => (isRecord(patch) && typeof patch.file_name === "string" ? patch.file_name : undefined))
      .filter((name): name is string => !!name);
    // A lone sidecar auto-adds later (no prompt); only two or more open the multi-select dialog.
    if (patchFileNames.length < 2) return;
    this.trace("patch.implicit.early-surface.start", { count: patchFileNames.length, stageId });
    this.earlySidecarSelectionInFlight.set(stageId, this.surfaceEarlySidecarSelection(stageId, patchFileNames));
  }

  private async surfaceEarlySidecarSelection(stageId: string, patchFileNames: string[]): Promise<void> {
    try {
      const selection = await this.resolveSelectionRequest(
        this.buildSidecarManifestRequest(patchFileNames),
        this.selectFile,
      );
      // Candidate ids ARE the patch file names, kept in pick order. A null selection records an
      // empty pick so the reconcile step does not re-open a fallback dialog.
      const selectedIds = selection
        ? Array.isArray(selection.ids) && selection.ids.length
          ? selection.ids
          : [selection.id]
        : [];
      const picked = selectedIds.filter((id): id is string => typeof id === "string" && patchFileNames.includes(id));
      this.earlySidecarSelections.set(stageId, picked);
      this.trace("patch.implicit.early-surface.resolved", { picked, stageId });
    } catch (error) {
      // No recorded pick on failure/cancel - discoverImplicitPatches falls back to the normal dialog.
      this.trace("patch.implicit.early-surface.failed", { error, stageId });
    } finally {
      this.earlySidecarSelectionInFlight.delete(stageId);
    }
  }

  /** Synthetic multi-select request over the streamed sidecar file names - dialog ids/labels only
   * (each candidate id is its file name); the chosen leaves are applied later from `sidecarPatches`. */
  private buildSidecarManifestRequest(patchFileNames: string[]): CandidateSelectionRequest {
    return {
      candidates: patchFileNames.map((fileName) => ({
        fileName,
        id: fileName,
        kind: "patch",
        patchable: true,
        selectable: true,
        type: "file",
      })),
      multiSelect: true,
      role: "patch",
      sourceName: patchFileNames[0] || "patch",
      warnings: [],
    };
  }

  /** Apply an early `patch-manifest` pick: await any in-flight dialog, then fan the chosen sidecars
   * out from the already-materialized leaves (no second dialog, no re-ingest). Returns whether an
   * early pick was handled, including an empty pick. */
  private async applyEarlySidecarSelection(
    stage: StagedSource<TSource>,
    sidecarPatches: PreparedSidecarPatch[],
  ): Promise<boolean> {
    const inFlight = this.earlySidecarSelectionInFlight.get(stage.state.id);
    if (inFlight) await inFlight;
    const picked = this.earlySidecarSelections.get(stage.state.id);
    if (!picked) return false;
    // Consume each match once so duplicate file names map to distinct leaves, preserving pick order.
    const remaining = [...sidecarPatches];
    const chosen: PreparedSidecarPatch[] = [];
    for (const fileName of picked) {
      const index = remaining.findIndex((sidecar) => sidecar.file.fileName === fileName);
      if (index !== -1) chosen.push(...remaining.splice(index, 1));
    }
    this.trace("patch.implicit.early-apply", {
      applied: chosen.length,
      picked: picked.length,
      stageId: stage.state.id,
    });
    for (const leaf of chosen) await this.addFannedOutPatch(leaf.file, leaf.parentCompressions);
    return true;
  }

  private hasDiscoveredSidecarSource(source: TSource): boolean {
    if (typeof source === "object" && source !== null) return this.discoveredSidecarSources.has(source);
    return this.discoveredSidecarPrimitiveSources.has(source);
  }

  private rememberDiscoveredSidecarSource(source: TSource): void {
    if (typeof source === "object" && source !== null) {
      this.discoveredSidecarSources.add(source);
      return;
    }
    this.discoveredSidecarPrimitiveSources.add(source);
  }

  private async discoverImplicitPatches(appendSidecarPatches = false): Promise<void> {
    if (!this.inputSession || (this.patches.length && !(appendSidecarPatches && this.selectFile))) return;
    const sessionStages = this.inputSession.stages.length ? this.inputSession.stages : [this.inputSession.view];
    const stages = appendSidecarPatches
      ? sessionStages.filter(
          (stage) =>
            !(
              this.hasDiscoveredSidecarSource(stage.source) ||
              this.patches.some((patch) => patch.source === stage.source)
            ),
        )
      : sessionStages;
    // No selection handler = headless/libretro-style soft-patching: apply only name-matched sidecars,
    // no prompt. With a handler (the webapp) every sidecar goes through the selection flow instead.
    if (!this.selectFile) {
      await this.discoverNameMatchedSidecarPatches(stages);
      return;
    }
    for (const stage of stages) {
      const sidecarPatches = this.stageSidecarPatches(stage);
      if (!sidecarPatches.length) continue;
      // Preferred path: the dialog already ran off the streamed `patch-manifest` while the ROM hashed;
      // apply that pick off the materialized leaves - no second dialog, no re-ingest.
      if (await this.applyEarlySidecarSelection(stage, sidecarPatches)) {
        if (appendSidecarPatches) this.rememberDiscoveredSidecarSource(stage.source);
        continue;
      }
      // A lone sidecar auto-adds (no prompt), reusing the already-extracted leaf. (The apply
      // execution skips its own discovery once rows exist.)
      if (sidecarPatches.length === 1) {
        const only = sidecarPatches[0];
        if (only) {
          this.trace("patch.implicit.sidecar-auto-add", { fileName: only.file.fileName });
          await this.addFannedOutPatch(only.file, only.parentCompressions);
        }
        if (appendSidecarPatches) this.rememberDiscoveredSidecarSource(stage.source);
        continue;
      }
      // Fallback (early dialog never ran): surface the multi-select by re-staging the archive as a
      // patch source.
      this.trace("patch.implicit.sidecar-surface", { count: sidecarPatches.length, fileName: stage.state.fileName });
      // The staging cache is reference-counted, so the patch flow can share the exact source object
      // with the input flow without conflating a same-metadata but different File.
      await this.surfaceArchivePatchSelection(stage.source);
      if (appendSidecarPatches) this.rememberDiscoveredSidecarSource(stage.source);
    }
  }

  // Headless/libretro path: apply the sidecar patch(es) whose name matches the ROM, with no selection
  // prompt (matching the non-interactive apply execution and RetroArch soft-patch conventions). The
  // matches and apply order come from the ROM-staging ingest (`sidecarOrder`), not a separate scan.
  private async discoverNameMatchedSidecarPatches(stages: StagedSource<TSource>[]): Promise<void> {
    const discovered = stages
      .flatMap((stage) => this.stageSidecarPatches(stage))
      .filter((leaf) => typeof leaf.sidecarOrder === "number")
      .sort((left, right) => (left.sidecarOrder ?? 0) - (right.sidecarOrder ?? 0));
    if (!discovered.length) return;
    this.trace("patch.implicit.discovered", {
      patchCount: discovered.length,
      patches: discovered.map((leaf) => leaf.file.fileName || "patch.bin"),
    });
    for (const leaf of discovered) {
      await this.addFannedOutPatch(leaf.file, leaf.parentCompressions);
    }
  }

  // Stage a ROM-bearing archive as a patch source through the same machinery as a dropped patch
  // archive (enumerate → 1 auto-prepares, 2+ → selection dialog → fan-out). Inlined without `mutate`
  // because this runs inside `setInput`'s mutation; awaiting `addPatch` here would deadlock the queue.
  private async surfaceArchivePatchSelection(patchSource: TSource): Promise<void> {
    this.retainOwnedSources([patchSource]);
    const stage = this.createInitialSource("patch", patchSource, this.patches.length);
    stage.outputLabel = createPatchOutputLabel(stage.state.fileName);
    this.patches.push(stage);
    this.trace("patch.implicit.surface-archive-patches", { fileName: stage.state.fileName });
    try {
      const staged = await this.stageSource(stage);
      await this.maybeResolveBlockingPatchSelection(staged);
      await this.evaluatePatchReadiness(staged);
    } catch (error) {
      const index = this.patches.indexOf(stage);
      if (index !== -1) this.patches.splice(index, 1);
      await releasePreparedSourceAndWait(stage);
      await this.releaseRuntimeSources([stage.source]);
      await this.releaseOwnedSources([stage.source]);
      this.trace("patch.implicit.surface-failed", { error });
    }
  }

  async clearPatches(): Promise<void> {
    return this.mutate("clearPatches", async () => {
      const patchCount = this.patches.length;
      await this.releasePatchSources();
      this.patches = [];
      this.latestChainPlans.clear();
      this.chainLayoutBases.clear();
      this.recomputeOutputState();
      this.trace("patches.clear", { patchCount });
    });
  }

  async setSettings(settings: Partial<ApplySettings>): Promise<void> {
    return this.mutate("setSettings", async () => {
      this.trace("settings.set.start", {
        hasInputSession: !!this.inputSession,
      });
      const previousThreads = this.settings.workers?.threads;
      this.settings = cloneValue(settings || {});
      applyOutputSettings(this.outputState, this.settings, this.inputSession as InputSession<unknown> | undefined);
      if (String(previousThreads ?? "auto") !== String(this.settings.workers?.threads ?? "auto")) {
        this.preloadRuntimeCapability("compression");
      }
      await this.refreshPatchReadiness();
      this.recomputeOutputState();
      this.trace("settings.set.finish", {
        outputFormat: this.outputState.outputFormat,
      });
    });
  }

  async setOutputName(name: string): Promise<void> {
    return this.mutate("setOutputName", async () => {
      setApplyOutputName(this.outputState, this.settings, name, () => this.recomputeOutputState());
    });
  }

  async setOutputFormat(format: CompressionFormat): Promise<void> {
    return this.mutate("setOutputFormat", async () => {
      if (!isCompressionFormat(format))
        throw new RomWeaverError("INVALID_SETTINGS", `Unsupported output format: ${String(format)}`);
      setApplyOutputFormat(this.outputState, this.settings, format);
      this.recomputeOutputState();
    });
  }

  async setDefaultPatchBasis(basis: "auto" | "base" | "previous"): Promise<void> {
    return this.mutate("setDefaultPatchBasis", async () => {
      if (this.defaultPatchBasis === basis) return;
      this.defaultPatchBasis = basis;
      this.trace("patch.basis.default", { basis });
    });
  }

  async setPatchTarget(index: number, targetInputId: string | "auto"): Promise<void> {
    return this.mutate("setPatchTarget", async () => {
      const stage = this.patches[index];
      if (!stage) throw new RomWeaverError("INVALID_INPUT", `Patch ${index + 1} was not found`);
      if (targetInputId === "auto") {
        stage.state.patchTarget = undefined;
        clearApplyPatchTarget(stage);
        await this.evaluatePatchReadiness(stage);
        this.recomputeOutputState();
        return;
      }
      const target = this.getPatchableInputAssets().find(
        (asset) => asset.id === targetInputId || asset.fileName === targetInputId,
      );
      if (!target) throw new RomWeaverError("SELECTION_NOT_FOUND", `Patch target was not found: ${targetInputId}`);
      stage.state.patchTarget = target.member ? { member: target.member, rom: true } : { rom: true };
      assignApplyPatchTarget(stage, target);
      await this.evaluatePatchReadiness(stage);
      this.recomputeOutputState();
    });
  }

  async setPatchOption(
    index: number,
    option: {
      id?: string;
      input?: ApplyWorkflowPatchState["patchInput"];
      target?: ApplyWorkflowPatchState["patchTarget"];
      inputChecks?: string;
      outputChecks?: string;
      basis?: "base" | "previous";
      validateInputChecksum?: string;
      validateOutputChecksum?: string;
      header?: "keep" | "strip";
      n64ByteOrder?: "keep" | "big-endian" | "little-endian" | "byte-swapped";
    },
  ): Promise<void> {
    return this.mutate("setPatchOption", async () => {
      const stage = this.patches[index];
      if (!stage) throw new RomWeaverError("INVALID_INPUT", `Patch ${index + 1} was not found`);
      let verificationChanged = false;
      if ("inputChecks" in option) {
        const value = option.inputChecks?.trim() || undefined;
        verificationChanged ||= stage.state.inputChecks !== value;
        stage.state.inputChecks = value;
      }
      if ("id" in option) {
        verificationChanged ||= stage.state.patchId !== option.id?.trim();
        stage.state.patchId = option.id?.trim() || undefined;
      }
      if ("input" in option) {
        verificationChanged ||= JSON.stringify(stage.state.patchInput) !== JSON.stringify(option.input);
        stage.state.patchInput = option.input;
        if (option.input && "patch" in option.input) {
          const producerId = option.input.patch;
          const producerIndex = this.patches.findIndex((candidate) => candidate.state.patchId === producerId);
          if (producerIndex < 0 || producerIndex >= index)
            throw new RomWeaverError("INVALID_INPUT", `Patch input producer is unavailable: ${producerId}`);
          const producerTargetId = this.patches[producerIndex]?.state.targetInputId;
          const producerTarget = this.getPatchableInputAssets().find((asset) => asset.id === producerTargetId);
          if (producerTarget) assignApplyPatchTarget(stage, producerTarget);
          else clearApplyPatchTarget(stage);
        } else if (option.input?.member) {
          const member = option.input.member;
          const matches = findMemberAssets(
            member,
            this.getPatchableInputAssets(),
            this.memberChecksFor(stage),
            this.getPatchMemberRefs(),
          );
          if (matches.length === 1) assignApplyPatchTarget(stage, matches[0] as InputAsset);
          else clearApplyPatchTarget(stage);
        }
      }
      if ("target" in option) {
        verificationChanged ||= JSON.stringify(stage.state.patchTarget) !== JSON.stringify(option.target);
        stage.state.patchTarget = option.target;
        const target = option.target;
        if (target && "patch" in target) {
          const producerIndex = this.patches.findIndex((candidate) => candidate.state.patchId === target.patch);
          if (producerIndex < 0 || producerIndex >= index)
            throw new RomWeaverError("INVALID_INPUT", `Patch target producer is unavailable: ${target.patch}`);
          const producerTargetId = this.patches[producerIndex]?.state.targetInputId;
          const producerTarget = this.getPatchableInputAssets().find((asset) => asset.id === producerTargetId);
          if (producerTarget) assignApplyPatchTarget(stage, producerTarget);
          else clearApplyPatchTarget(stage);
        } else if (target?.member) {
          const matches = findMemberAssets(
            target.member,
            this.getPatchableInputAssets(),
            this.memberChecksFor(stage),
            this.getPatchMemberRefs(),
          );
          if (matches.length === 1) assignApplyPatchTarget(stage, matches[0] as InputAsset);
          else clearApplyPatchTarget(stage);
        }
      }
      if ("outputChecks" in option) {
        const value = option.outputChecks?.trim() || undefined;
        verificationChanged ||= stage.state.outputChecks !== value;
        stage.state.outputChecks = value;
      }
      if ("basis" in option) {
        verificationChanged ||= stage.state.basisChoice !== option.basis;
        stage.state.basisChoice = option.basis;
      }
      if ("validateInputChecksum" in option) {
        const value = option.validateInputChecksum?.trim() || undefined;
        verificationChanged ||= stage.state.validateInputChecksum !== value;
        stage.state.validateInputChecksum = value;
      }
      if ("validateOutputChecksum" in option) {
        const value = option.validateOutputChecksum?.trim() || undefined;
        verificationChanged ||= stage.state.validateOutputChecksum !== value;
        stage.state.validateOutputChecksum = value;
      }
      if ("header" in option) {
        verificationChanged ||= stage.state.headerChoice !== option.header;
        stage.state.headerChoice = option.header;
      }
      if ("n64ByteOrder" in option) {
        verificationChanged ||= stage.state.n64ByteOrderChoice !== option.n64ByteOrder;
        stage.state.n64ByteOrderChoice = option.n64ByteOrder;
      }
      // Any of these change what the run verifies (the header changes which bytes
      // the apply runs against; a user input check joins the preflight
      // requirements), so the checksum preflight - and with it the target
      // validation key - must be recomputed. The caller reruns the deep
      // validation off the new key. No-op writes skip the recompute entirely.
      if (verificationChanged) await this.evaluatePatchReadiness(stage);
      this.recomputeOutputState();
    });
  }

  async run(): Promise<ApplyResult<TDestination>> {
    return this.mutate("run", async () => {
      await this.prepareRun();
      // The strict-validation override (or a non-strict setting) skips the weave's ROM check, like
      // the CLI's --ignore-checksum-validation skips weave checks.
      if (this.settings.validation?.requireInputChecksumMatch === true) {
        const verdict = await this.verifyWeaveRom();
        if (verdict?.status === "mismatch")
          throw new RomWeaverError("CHECKSUM_MISMATCH", verdict.message || "Input checksum mismatch");
        if (verdict?.status === "unavailable")
          throw new RomWeaverError("WORKER_FAILED", verdict.message || "The weave's ROM could not be verified");
      }
      const result = await withAbortSignal(
        runApplyWorkflow(
          this.createPatchInput((progress) => this.emitApplyWorkerProgress(progress)),
          this.runtime,
        ),
        this.abortController.signal,
      );
      const outputs = result.outputs.map((output, index) =>
        wrapPublicOutput<TDestination>(output, this.runtime, index),
      );
      const publicResult: ApplyResult<TDestination> = {
        ...(result.cheats ? { cheats: result.cheats } : {}),
        inputs: result.inputs,
        output: outputs[0] as ApplyResult<TDestination>["output"],
        outputs,
        patches: result.patches,
        sizeSummary: result.sizeSummary,
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      };
      return publicResult;
    });
  }

  private async prepareRun(): Promise<void> {
    const input = this.inputSession;
    if (!input) throw new RomWeaverError("INVALID_INPUT", "Input source is required");
    await this.finalizeInputStableState();
    await this.refreshPatchReadiness();
    this.recomputeOutputState();
    if (input.view.state.status !== "ready" || !input.view.state.selectedCandidateId)
      throw new RomWeaverError("AMBIGUOUS_SELECTION", "Input selection is required");
    const pendingPatch = this.patches.find((patch) => patch.state.status !== "ready");
    if (pendingPatch) {
      if (!pendingPatch.state.selectedCandidateId)
        throw new RomWeaverError("AMBIGUOUS_SELECTION", `${pendingPatch.state.fileName || "Patch"} requires selection`);
      throw new RomWeaverError(
        "AMBIGUOUS_SELECTION",
        pendingPatch.state.warnings.at(-1)?.message || `${pendingPatch.state.fileName || "Patch"} is not ready`,
      );
    }
    const outputName = this.outputState.outputName;
    if (!outputName) throw new RomWeaverError("INVALID_SETTINGS", "Output name is required");
  }

  async createCombinedPatch(settings: Partial<CreateSettings>): Promise<CreateResult<TDestination>> {
    return this.mutate("createCombinedPatch", async () => {
      await this.prepareRun();
      if (!(this.patches.length || this.cheatRecords.length))
        throw new RomWeaverError("INVALID_INPUT", "Select at least one patch or cheat to combine");
      const assets = this.getPreparedInputAssets();
      if (assets.length !== 1 || !assets[0]?.patchable)
        throw new RomWeaverError(
          "INVALID_INPUT",
          "Combined patches require exactly one ROM file; multi-file ROMs are not supported",
        );
      const original = assets[0];
      const originalSource = getPatchFileExternalSource(original.file, original.fileName);
      if (!originalSource) throw new RomWeaverError("INVALID_INPUT", "The prepared original ROM is not readable");
      const outputName = settings.output?.outputName?.trim();
      if (!outputName) throw new RomWeaverError("INVALID_SETTINGS", "Output name is required");
      const applyPatch = this.runtime.patch.applyPatch;
      const createPatch = this.runtime.patch.createPatch;
      const createSource = this.runtime.output.createSource;
      if (!createSource)
        throw new RomWeaverError("UNSUPPORTED_FORMAT", "Combined patch output is unavailable in this runtime");
      const intermediateOutputs: PublicOutput[] = [];
      const modifiedSources: SourceRef[] = [];
      const applyInput = this.createPatchInput((progress) => this.emitApplyWorkerProgress(progress));
      applyInput.options = {
        ...applyInput.options,
        retainUncompressedOutput: undefined,
        // The user's Apply name MAY carry an archive extension that would misclassify the raw intermediate ROM.
        output: { ...applyInput.options?.output, compression: "none", header: "keep", outputName: original.fileName },
      };
      const runtime: WorkflowRuntime = {
        ...this.runtime,
        patch: {
          ...this.runtime.patch,
          applyPatch: applyPatch
            ? async (...args) => {
                const output = await applyPatch(...args);
                intermediateOutputs.push(output);
                return output;
              }
            : undefined,
        },
        output: {
          ...this.runtime.output,
          // Chaining MUST use the prepared source: public output paths may belong to a download-only VFS.
          createSource: async (source, fileName) => {
            modifiedSources.push(source);
            const output = await createSource(source, fileName);
            intermediateOutputs.push(output);
            return output;
          },
        },
      };
      let createdOutput: PublicOutput | undefined;
      let succeeded = false;
      try {
        const applied = await runApplyWorkflow(applyInput, runtime);
        if (applied.outputs.length !== 1 || modifiedSources.length !== 1)
          throw new RomWeaverError("INVALID_INPUT", "Combined patches require exactly one modified ROM output");
        this.abortController.signal.throwIfAborted();
        const createRuntime: WorkflowRuntime = {
          ...this.runtime,
          patch: {
            ...this.runtime.patch,
            createPatch: createPatch
              ? async (...args) => {
                  const result = await createPatch(...args);
                  intermediateOutputs.push(result.output);
                  return result;
                }
              : undefined,
          },
        };
        const created = await runCreateWorkflow(
          {
            original: originalSource,
            modified: modifiedSources[0],
            originalCrc32: getInputAssetChecksums(original)?.crc32,
            options: {
              ...cloneValue(settings),
              output: { ...cloneValue(settings.output), outputName },
              signal: this.abortController.signal,
              onLog: settings.logging?.sink ?? this.settings.logging?.sink,
              onProgress: (progress) =>
                this.emitProgress({
                  ...progress,
                  stage: progress.stage === "output" ? "compress" : "create",
                  details: isRecord(progress.details) ? progress.details : undefined,
                  id: `${this.id}:worker:create`,
                  role: "worker",
                  workflow: "create",
                }),
            },
          },
          createRuntime,
        );
        createdOutput = created.output;
        this.abortController.signal.throwIfAborted();
        const output = wrapPublicOutput<TDestination>(created.output, this.runtime, 0);
        const warnings = [...(applied.warnings || []), ...(created.warnings || [])];
        const result: CreateResult<TDestination> = {
          original: { id: original.id, fileName: original.fileName, kind: original.kind, size: original.size },
          modified: {
            id: `${this.id}:combined`,
            fileName: applied.output.fileName,
            kind: "rom",
            size: applied.output.size,
          },
          output,
          type: created.format as CreateResult<TDestination>["type"],
          sizeSummary: { ...created.sizeSummary, outputSize: output.size },
          ...(warnings.length ? { warnings } : {}),
        };
        succeeded = true;
        return result;
      } finally {
        await Promise.allSettled(
          [...new Set(intermediateOutputs)]
            .filter((output) => output !== createdOutput)
            .map((output) => output.dispose()),
        );
        if (!succeeded && createdOutput) await createdOutput.dispose();
      }
    });
  }

  private emitApplyWorkerProgress(progress: ProgressEvent): void {
    const stage = progress.stage === "output" ? "compress" : "apply";
    const role = progress.stage === "output" ? "output" : "worker";
    this.emitProgress({
      details: {
        ...(isRecord(progress.details) ? progress.details : {}),
      },
      hasProgress: progress.hasProgress,
      id: `${this.id}:${role}:${stage}`,
      label: progress.label || (stage === "compress" ? "Compressing output..." : "Applying patch..."),
      percent: typeof progress.percent === "number" && Number.isFinite(progress.percent) ? progress.percent : null,
      role,
      stage,
      workflow: "apply",
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.abort();
    // Abort does not unwind an operation that is already running, and the
    // releases below only cover what this workflow owns right now. Anything an
    // in-flight operation stages after them is left with no owner.
    await this.settleMutations();
    await this.releaseInputSession();
    await this.releasePatchSources();
    await this.flushPendingOwnedSourceReleases();
    await this.runtime.workerIo?.releaseOwnedSources?.([...this.ownedSourceRefCounts.keys()]).catch(() => undefined);
    this.ownedSourceRefCounts.clear();
    this.discoveredSidecarPrimitiveSources.clear();
    this.patches = [];
    this.clearListeners();
    this.disposed = true;
  }

  private preloadRuntimeCapability(capability: "checksum" | "compression" | "patch"): void {
    const preload = this.runtime.preload?.preloadCapability;
    if (!preload) return;
    this.trace("runtime.preload.start", {
      capability,
      threads: this.settings.workers?.threads,
    });
    void preload(capability, () => undefined, {
      threads: this.settings.workers?.threads,
    })
      .then(() => {
        this.trace("runtime.preload.finish", {
          capability,
        });
      })
      .catch((error) => {
        this.trace("runtime.preload.fail", {
          capability,
          error,
        });
      });
  }

  private mutate<TValue>(operation: string, callback: () => Promise<TValue>): Promise<TValue> {
    return this.runQueuedMutation(operation, callback, { rearmAbort: true, wrapErrors: true });
  }

  private createInitialSource(role: SourceRole, source: TSource, index: number): StagedSource<TSource> {
    const fileName = getSourceFileName(source, `${role}-${index + 1}`);
    const sourceSize = getSourceSize(source);
    return {
      index,
      internalCandidates: new Map(),
      outputLabel: role === "patch" ? createPatchOutputLabel(fileName) : undefined,
      parentCompressions: [],
      source,
      state: {
        candidates: [],
        fileName,
        id: role === "input" ? `input-${++this.nextInputSequence}` : `patch-${++this.nextPatchSequence}`,
        order: index,
        role,
        size: sourceSize,
        sourceSize,
        status: "loading",
        warnings: [],
      },
    };
  }

  private createInitialInputView(sources: TSource[]): StagedSource<TSource> {
    return this.inputStages.createInitialSource("input", sources[0] as TSource, 0) as StagedSource<TSource>;
  }

  private async stageInputSession(sources: TSource[]): Promise<InputSession<TSource>> {
    const session = (await this.inputStages.stageSession("input", sources)) as InputSession<TSource>;
    this.inputSession = session;
    this.refreshPreparedInputMetadata(session);
    return session;
  }

  private async stageSource(
    stage: StagedSource<TSource>,
    stageOptions: { deferBlockingSelection?: boolean } = {},
  ): Promise<StagedSource<TSource>> {
    if (stage.state.role === "input") {
      const staged = (await this.inputStages.stageSource(stage)) as StagedSource<TSource>;
      this.refreshPreparedInputMetadataForStage(staged);
      return staged;
    }
    this.trace("source.stage.start", {
      fileName: stage.state.fileName,
      order: stage.state.order,
      role: stage.state.role,
      sourceSize: stage.state.sourceSize,
    });
    if (isDcpPatchName(stage.state.fileName)) {
      // Name the DCP before any staging, ingest, or selection runs; see apply-dcp-patch.ts.
      this.addDirectCandidate(stage, stage.state.role, stage.index, stage.state.id);
      stage.state.selectedCandidateId = stage.state.candidates[0]?.id;
      markDcpPatchUnsupported(stage);
      return stage;
    }
    const requests: CandidateSelectionRequest[] = [];
    const options = createSourceStagingOptions({
      base: this.createExecutionOptions(),
      emitProgress: (event) => this.emitProgress(event),
      onCandidatesFound: (request) => requests.push(request),
      patchLeafPreference: getPatchArchiveReplacement(stage.source),
      state: stage.state,
      workflowId: this.id,
    });
    try {
      const prepared = await prepareInputFile(
        stage.source as never,
        "patch",
        options as never,
        this.runtime,
        undefined,
        stage.index,
      );
      stage.preparedPatchFile = prepared.file;
      applyPreparedPatchMetadata(stage, prepared);
      this.trace("source.stage.prepare-patch.finish", {
        fileName: stage.state.fileName,
        order: stage.state.order,
        preparedFileName: prepared.file.fileName,
      });
    } catch (error) {
      this.trace("source.stage.prepare.fail", {
        error,
        fileName: stage.state.fileName,
        order: stage.state.order,
        requestCount: requests.length,
        role: stage.state.role,
      });
      if (requests.length && !canRecoverWithCandidateSelection(error, requests)) throw error;
      if (!requests.length) this.pushWarning(stage, toRomWeaverError(error));
    }
    for (const request of requests) this.addCandidateRequest(stage, request);
    if (!stage.state.candidates.length) this.addDirectCandidate(stage, stage.state.role, stage.index, stage.state.id);
    const selectable = stage.state.candidates.filter((candidate) => candidate.selectable);
    if (selectable.length === 1) {
      stage.state.selectedCandidateId = selectable[0]?.id;
      stage.selectedArchiveEntry = stage.internalCandidates.get(selectable[0]?.id || "")?.archiveEntry;
      await this.prepareSelectedSource(stage, stageOptions);
      this.trace("source.stage.prepare-selected.finish", {
        fileName: stage.state.fileName,
        order: stage.state.order,
        selectedCandidateId: stage.state.selectedCandidateId,
        status: stage.state.status,
      });
      await this.parsePatch(stage);
    } else {
      stage.state.status = "needsSelection";
      // When staging eagerly (outside the mutation queue) the blocking selection is deferred to the
      // queued mutation so it cannot race setInput's ROM dialog; the stage is left in "needsSelection"
      // for the mutation's maybeResolveBlockingPatchSelection to resolve.
      if (!stageOptions.deferBlockingSelection) await this.maybeResolveBlockingPatchSelection(stage);
    }
    this.trace("source.stage.finish", {
      candidateCount: stage.state.candidates.length,
      fileName: stage.state.fileName,
      order: stage.state.order,
      role: stage.state.role,
      status: stage.state.status,
      warningCount: stage.state.warnings.length,
    });
    return stage;
  }

  private async prepareSelectedSource(
    stage: StagedSource<TSource>,
    stageOptions: { deferBlockingSelection?: boolean } = {},
  ): Promise<void> {
    if (stage.state.role === "input") {
      await this.inputStages.prepareSelectedSource(stage);
      this.refreshPreparedInputMetadataForStage(stage);
      return;
    }
    this.trace("source.prepare-selected.enter", {
      candidateId: stage.state.selectedCandidateId,
      fileName: stage.state.fileName,
      order: stage.state.order,
      role: stage.state.role,
    });
    const requests: CandidateSelectionRequest[] = [];
    const options = createSourceStagingOptions({
      base: this.createExecutionOptions(),
      emitProgress: (event) => this.emitProgress(event),
      onCandidatesFound: (request) => requests.push(request),
      patchLeafPreference: getPatchArchiveReplacement(stage.source),
      state: stage.state,
      workflowId: this.id,
    });
    try {
      const prepared = stage.preparedPatchFile
        ? {
            decompressionTimeMs: stage.state.decompressionTimeMs || 0,
            file: stage.preparedPatchFile,
            parentCompressions: stage.parentCompressions,
            sourceSize: stage.state.sourceSize || stage.preparedPatchFile.fileSize,
            wasDecompressed: stage.state.wasDecompressed === true,
          }
        : await prepareInputFile(
            stage.source as never,
            "patch",
            options as never,
            this.runtime,
            stage.selectedArchiveEntry,
            stage.index,
          );
      stage.preparedPatchFile = prepared.file;
      applyPreparedPatchMetadata(stage, prepared);
      stage.outputLabel = stage.outputLabel || createPatchOutputLabel(prepared.file.fileName);
      if (stage.outputLabel)
        (
          stage.preparedPatchFile as PatchFileInstance & {
            _generatedPatchName?: string;
          }
        )._generatedPatchName = stage.outputLabel;
      stage.state.status = "ready";
    } catch (error) {
      if (requests.length && !canRecoverWithCandidateSelection(error, requests)) throw error;
      if (requests.length) {
        this.handleSourceSelectionRequests(stage, requests);
        // Eager staging defers interactive selection: leave the stage in "needsSelection" so the
        // queued mutation resolves it serially, avoiding a second dialog racing setInput's ROM prompt.
        if (!stageOptions.deferBlockingSelection) await this.maybeResolveBlockingPatchSelection(stage);
        return;
      }
      throw error;
    }
  }

  private handleSourceSelectionRequests(stage: StagedSource<TSource>, requests: CandidateSelectionRequest[]) {
    stage.internalCandidates.clear();
    stage.state.candidates = [];
    for (const request of requests) this.addCandidateRequest(stage, request);
    stage.state.checksums = undefined;
    stage.state.checksumVariants = undefined;
    stage.state.checksumTimeMs = undefined;
    stage.state.decompressionTimeMs = undefined;
    stage.state.selectedCandidateId = undefined;
    stage.state.targetInputId = undefined;
    stage.state.targetInputFileName = undefined;
    stage.state.requirements = undefined;
    stage.state.checksumPreflight = undefined;
    stage.state.patchValidation = undefined;
    stage.state.status = "needsSelection";
    stage.state.wasDecompressed = undefined;
    stage.parentCompressions = [];
    releasePreparedSource(stage);
  }

  private createSelectionRequest(state: InternalSourceState): CandidateSelectionRequest {
    return {
      candidates: state.candidates.map(cloneCandidate),
      ...(state.multiSelect ? { multiSelect: true } : {}),
      role: state.role,
      sourceName: state.fileName || state.id,
      warnings: state.warnings.map((warning) => warning.message),
    };
  }

  private async maybeResolveBlockingInputSelection(): Promise<boolean> {
    const session = this.inputSession;
    if (!session) return false;
    const resolved = await this.inputStages.maybeResolveBlockingSessionSelection(session);
    this.refreshPreparedInputMetadata(session);
    return resolved;
  }

  /** Open the multi-select dialog for a patch (under the single-modal mutex) and stash the user's
   * picks on the stage. Splitting the user-facing ask from {@link applyPatchSelectionChoice} lets the
   * dialog surface ASAP (before the ROM finishes) while the state-mutating apply stays serialized in
   * the mutation queue. Returns whether a choice now awaits application. */
  private async resolvePatchSelectionChoice(stage: StagedSource<TSource>): Promise<boolean> {
    if (stage.pendingSelectedIds?.length) return true;
    if (!(stage.state.status === "needsSelection" && !stage.state.selectedCandidateId && stage.state.candidates.length))
      return false;
    const selection = await this.resolveSelectionRequest(this.createSelectionRequest(stage.state), this.selectFile);
    if (!selection) return false;
    const selectedIds = Array.isArray(selection.ids) && selection.ids.length ? selection.ids : [selection.id];
    this.trace("patch.multiselect.resolved", {
      count: selectedIds.length,
      hasIdsArray: Array.isArray(selection.ids),
      selectedIds,
    });
    for (const id of selectedIds) {
      if (!stage.internalCandidates.has(id))
        throw new RomWeaverError("SELECTION_NOT_FOUND", `Selection candidate was not found: ${id}`);
    }
    stage.pendingSelectedIds = selectedIds;
    return true;
  }

  private async maybeResolveBlockingPatchSelection(stage: StagedSource<TSource>): Promise<boolean> {
    if (!(await this.resolvePatchSelectionChoice(stage))) return false;
    await this.applyPatchSelectionChoice(stage);
    return true;
  }

  /** Apply the picks captured by {@link resolvePatchSelectionChoice}: prepare the first pick and fan
   * each additional pick out into its own patch row. Mutates shared `this.patches`, so it must run
   * inside the mutation queue, never eagerly. */
  private async applyPatchSelectionChoice(stage: StagedSource<TSource>): Promise<void> {
    const selectedIds = stage.pendingSelectedIds;
    stage.pendingSelectedIds = undefined;
    if (!selectedIds?.length) return;
    const [firstId, ...restIds] = selectedIds as [string, ...string[]];
    releasePreparedSource(stage);
    stage.state.multiSelect = false;
    stage.state.selectedCandidateId = firstId;
    const firstInternal = stage.internalCandidates.get(firstId);
    stage.selectedArchiveEntry = firstInternal?.archiveEntry;
    // Reuse the already-extracted leaf file when the source pre-extracted every branch (patch
    // multi-select); otherwise fall back to extracting the selected entry in prepareSelectedSource.
    const firstLeaf =
      (firstInternal?.request && getPatchLeafFileForSelection(firstInternal.request, firstInternal.candidate.id)) ||
      undefined;
    this.trace("patch.multiselect.first", {
      candidateId: firstInternal?.candidate?.id,
      leafFound: !!firstLeaf,
      selectedArchiveEntry: stage.selectedArchiveEntry,
    });
    if (firstLeaf) {
      stage.preparedPatchFile = firstLeaf;
      // Keep the archive-nesting chain on the first pick too so its row shows the extract section.
      const firstParentCompressions =
        (firstInternal?.request &&
          getPatchLeafParentCompressionsForSelection(firstInternal.request, firstInternal.candidate.id)) ||
        undefined;
      if (firstParentCompressions?.length) {
        stage.parentCompressions = normalizeParentCompressions(firstParentCompressions);
        // Carry the extract elapsed time onto the stage so the row shows it (prepareSelectedSource
        // reuses stage.state.decompressionTimeMs for the already-extracted leaf).
        const rootTime = firstParentCompressions[0]?.decompressionTimeMs;
        if (typeof rootTime === "number") stage.state.decompressionTimeMs = rootTime;
      }
      // Replace the archive source with the extracted leaf so a later re-stage resolves a single
      // patch directly and never re-opens the multi-select dialog (only when several were picked).
      if (restIds.length) {
        await this.replaceOwnedStageSource(stage, this.createImplicitPatchSource(firstLeaf, firstParentCompressions));
      }
    }
    await this.prepareSelectedSource(stage);
    // Each additional pick becomes its own patch-stack entry, mirroring implicit-patch discovery.
    for (const id of restIds) {
      const internal = stage.internalCandidates.get(id);
      const leaf = internal?.request && getPatchLeafFileForSelection(internal.request, internal.candidate.id);
      const parentCompressions =
        (internal?.request && getPatchLeafParentCompressionsForSelection(internal.request, internal.candidate.id)) ||
        [];
      this.trace("patch.multiselect.rest", { candidateId: internal?.candidate?.id, leafFound: !!leaf, publicId: id });
      if (!leaf) continue;
      await this.addFannedOutPatch(leaf, parentCompressions);
    }
  }

  private refreshPreparedInputMetadataForStage(stage: StagedSource<TSource> | undefined) {
    if (!(stage && stage.state.role === "input" && stage.preparedInputAssets?.length)) return;
    applyPreparedInputMetadata(stage);
  }

  private refreshPreparedInputMetadata(session: InputSession<TSource> | undefined) {
    if (!session) return;
    for (const stage of session.stages) this.refreshPreparedInputMetadataForStage(stage as StagedSource<TSource>);
    if (!session.stages.includes(session.view)) this.refreshPreparedInputMetadataForStage(session.view);
    if (session.synthetic) this.syncInputSessionView();
  }

  private async parsePatch(stage: StagedSource<TSource>): Promise<void> {
    // Already described - nothing to re-ingest.
    if (stage.parsedPatch) return;
    // The eager stageSource parse and setInput's readiness pass both reach here while the input is
    // still staging; share the one in-flight ingest instead of describing the same patch twice.
    if (stage.parsePatchInFlight) return stage.parsePatchInFlight;
    const run = this.runParsePatch(stage);
    stage.parsePatchInFlight = run;
    try {
      await run;
    } finally {
      stage.parsePatchInFlight = undefined;
    }
  }

  private async runParsePatch(stage: StagedSource<TSource>): Promise<void> {
    const patchFile = stage.preparedPatchFile;
    if (!patchFile) {
      stage.state.status = "needsSelection";
      stage.state.requirements = undefined;
      stage.state.checksumPreflight = undefined;
      stage.state.patchValidation = undefined;
      return;
    }
    if (isDcpPatchStage(stage)) {
      // The ingest surfaced a .dcp (bare, or a leaf of an archive) as one patch; see apply-dcp-patch.ts.
      markDcpPatchUnsupported(stage);
      return;
    }
    const parsed = await parsePatchForApply(patchFile, this.runtime);
    if (!parsed) {
      // An unreadable patch is a per-card failure (like a checksum mismatch), not a workflow error:
      // keep the card and mark it invalid so it shows a plain-language fault and blocks Apply.
      stage.state.requirements = undefined;
      stage.state.checksumPreflight = undefined;
      stage.state.patchValidation = {
        message: `Validation failed: Invalid patch file: ${patchFile.fileName || stage.state.fileName}`,
        status: "invalid",
        unreadable: true,
      };
      return;
    }
    stage.parsedPatch = parsed;
    stage.state.requirements = clonePatchRequirements(getPatchProbeRequirements(parsed));
    stage.state.checksumPreflight = undefined;
    stage.state.patchValidation = undefined;
  }

  private addCandidateRequest(stage: StagedSource<TSource>, request: CandidateSelectionRequest) {
    stage.state.multiSelect = !!request.multiSelect;
    const projected = projectSelectionCandidates({
      createPublicId: () => `${this.id}:${stage.state.role}:${++this.nextCandidateSequence}`,
      owner: stage,
      request,
    });
    for (const [id, candidate] of projected.internalCandidates) stage.internalCandidates.set(id, candidate);
    stage.state.candidates = projected.candidates;
  }

  private addDirectCandidate(stage: StagedSource<TSource>, role: SourceRole, index: number, internalId: string) {
    const publicId = `${this.id}:${role}:${++this.nextCandidateSequence}`;
    const candidate: SelectionCandidate = {
      fileName: stage.state.fileName || `${role}-${index + 1}`,
      id: publicId,
      kind: role === "patch" ? "patch" : "rom",
      patchable: role === "input",
      selectable: true,
      size: stage.state.size,
      type: "file",
    };
    stage.state.candidates = [candidate];
    stage.internalCandidates.set(publicId, {
      candidate: { ...candidate, id: internalId },
      owner: stage,
    });
  }

  private syncInputSessionView() {
    const session = this.inputSession;
    if (!session?.synthetic) return;
    this.inputStages.syncSessionView(session);
    session.view.state.romProbe = cloneChecksumRomProbe(session.view.state.romProbe);
    session.view.state.romType = session.view.state.romType ? { ...session.view.state.romType } : undefined;
  }

  /** Compare the active weave's `rom.checks` with the supplied ROM file, hashing any declared
   * algorithm staging did not compute. A transient hashing failure, or a hash cancelled because
   * the ROM changed, yields a retryable `unavailable` result instead of a verdict. */
  private async verifyWeaveRom(options?: { skipHash?: boolean }): Promise<WeaveRomRunCheck | undefined> {
    const expectation = this.weaveRom;
    if (!expectation) return undefined;
    if (options?.skipHash) {
      this.trace("weave.rom.verify-skipped", { member: expectation.member ?? "" });
      return {
        message: "The weave's ROM is being replaced; it is checked again once the new ROM is staged",
        missing: [],
        status: "unavailable",
      };
    }
    const workflowSignal = this.abortController.signal;
    const hashAbort = new AbortController();
    this.weaveRomHashAbort = hashAbort;
    const forwardAbort = () => hashAbort.abort(workflowSignal.reason);
    workflowSignal.addEventListener("abort", forwardAbort, { once: true });
    try {
      const verdict = await verifyWeaveRom(
        expectation,
        this.getPatchableInputAssets(),
        this.weaveRomChecksums,
        async (asset, algorithms) => {
          try {
            const result = await calculateInputChecksumsForFile({
              algorithms,
              emitProgress: (event) => this.emitProgress(event),
              file: asset.file,
              identify: false,
              logLevel: this.settings.logging?.level,
              onLog: this.settings.logging?.sink,
              progressId: `${this.id}:weave-rom:${asset.id}`,
              role: "input",
              runtime: this.runtime,
              signal: hashAbort.signal,
              state: { fileName: asset.fileName, id: asset.id, size: asset.size },
              workflow: "apply",
            });
            return { checksums: result.checksums, variants: result.variants };
          } catch (error) {
            if (hashAbort.signal.aborted || isTransientValidationError(error)) throw error;
            // Not transient: the algorithm cannot be computed here, which fails verification.
            this.trace("weave.rom.checksum-failed", { algorithms: algorithms.join(","), assetId: asset.id });
            return { checksums: {} };
          }
        },
      );
      this.trace("weave.rom.verify", {
        assetId: verdict.assetId ?? "",
        member: expectation.member ?? "",
        missing: verdict.missing.join(","),
        status: verdict.status,
        variant: verdict.variant ?? "",
      });
      return verdict;
    } catch (error) {
      if (workflowSignal.aborted) throw error;
      const message = toRomWeaverError(error).message;
      this.trace("weave.rom.verify-unavailable", { message, superseded: hashAbort.signal.aborted });
      return {
        message: `The weave's ROM checksum could not be computed yet (${message}); it is checked again on the next pass`,
        missing: [],
        status: "unavailable",
      };
    } finally {
      workflowSignal.removeEventListener("abort", forwardAbort);
      if (this.weaveRomHashAbort === hashAbort) this.weaveRomHashAbort = undefined;
    }
  }

  /** Record the layout variant a weave-ROM verdict matched; true when it changed. A transient
   * `unavailable` verdict keeps the previous layout. */
  private updateWeaveRomLayout(verdict: WeaveRomRunCheck | undefined): boolean {
    if (verdict?.status === "unavailable") return false;
    const asset =
      verdict?.status === "match" && verdict.variant
        ? this.getPatchableInputAssets().find((candidate) => candidate.id === verdict.assetId)
        : undefined;
    const crc32 = asset?.checksumVariants?.find((variant) => variant.id === verdict?.variant)?.checksums?.crc32;
    const next = asset && crc32 ? { assetId: asset.id, crc32 } : undefined;
    const previous = this.weaveRomLayout;
    if (previous?.assetId === next?.assetId && previous?.crc32 === next?.crc32) return false;
    this.weaveRomLayout = next;
    this.trace("weave.rom.layout", {
      assetId: next?.assetId ?? "",
      crc32: next?.crc32 ?? "",
      variant: verdict?.variant ?? "",
    });
    return true;
  }

  /** Cancel an in-flight weave-ROM hash: its file is about to be replaced. Callers that queue an
   * input change behind other work (the apply form) SHOULD call this before queueing it. */
  cancelWeaveRomHash(): void {
    this.weaveRomHashAbort?.abort(new RomWeaverError("CANCELLED", "The ROM changed"));
    this.weaveRomHashAbort = undefined;
  }

  private getSelectedInputOwner(): StagedSource<TSource> | undefined {
    return this.inputStages.getSelectedOwner(this.inputSession) as StagedSource<TSource> | undefined;
  }

  private async finalizeInputStableState(): Promise<boolean> {
    return finalizeApplyInputChecksums(this.inputSession, {
      emitProgress: (event) => this.emitProgress(event),
      getSelectedInputOwner: () => this.getSelectedInputOwner(),
      runtime: this.runtime,
      settings: this.settings,
      syncInputSessionView: () => this.syncInputSessionView(),
      workflowId: this.id,
    });
  }

  private getPreparedInputAssets(): InputAsset[] {
    const session = this.inputSession;
    if (!session) return [];
    // A synthetic session weaves several separately-provided ROMs. Apply keeps only the chosen one
    // ("ask which one"), so once a pick is made expose just that stage's assets - patch targeting,
    // checksums, and the run all operate on the single selected ROM, not every uploaded file.
    if (session.synthetic) {
      const selectedOwner = this.getSelectedInputOwner();
      if (selectedOwner) return selectedOwner.preparedInputAssets ? [...selectedOwner.preparedInputAssets] : [];
    }
    return session.view.preparedInputAssets ? [...session.view.preparedInputAssets] : [];
  }

  private getPatchableInputAssets(): InputAsset[] {
    return this.getPreparedInputAssets().filter((asset) => asset.patchable);
  }

  /** Update a blocked patch's row to say it's waiting on the ROM, replacing the stale staging label
   * ("checking nested archives in extracted outputs") that lingers while the input is still loading. */
  private emitPatchAwaitingInputProgress(stage: StagedSource<TSource>): void {
    const status = this.inputSession?.view.state.status;
    // Only when a ROM is actually being prepared - if none was provided the row's normal "target
    // selection required" warning is the right message, not a "waiting" one.
    if (status !== "loading") return;
    this.emitProgress({
      details: {
        fileName: stage.state.fileName,
        order: stage.state.order,
        sourceId: stage.state.id,
      },
      hasProgress: true,
      id: `${this.id}:${stage.state.id}:patch-awaiting-input`,
      indeterminate: true,
      label: "Waiting for the ROM to finish so the patch can be verified…",
      percent: null,
      role: "patch",
      stage: "verify",
      workflow: "apply",
    });
  }

  /** Whether `stage` runs first on `targetId`: each target is its own engine run, and a toggled-off
   * patch is excluded from the run. */
  private isFirstEnabledPatchOn(stage: StagedSource<TSource>, targetId: string | undefined): boolean {
    const first = this.patches.find(
      (patch) => !this.disabledPatches.has(patch) && (patch === stage || patch.state.targetInputId === targetId),
    );
    return first === stage && !this.disabledPatches.has(stage);
  }

  /** The patches that currently run first on their target. */
  private getFirstEnabledPatches(): Set<StagedSource<TSource>> {
    return new Set(this.patches.filter((patch) => this.isFirstEnabledPatchOn(patch, patch.state.targetInputId)));
  }

  private async evaluatePatchReadiness(
    stage: StagedSource<TSource>,
    declaredInputChecks?: string,
    previousLayout?: StagedSource<TSource>["state"],
  ): Promise<boolean> {
    const inputRef = stage.state.patchTarget || stage.state.patchInput;
    return evaluateApplyPatchReadiness(stage, {
      declaredInputChecks,
      memberRef: inputRef && !("patch" in inputRef) ? inputRef.member : undefined,
      filenameCrc32AppliesTo: (target) =>
        this.isFirstEnabledPatchOn(stage, target.id) && !(inputRef && "patch" in inputRef),
      previousLayout,
      getPatchableInputAssets: () => this.getPatchableInputAssets(),
      getWeaveLayoutCrc32: (target) =>
        this.weaveRomLayout?.assetId === target.id ? this.weaveRomLayout.crc32 : undefined,
      notifyAwaitingInputTarget: (patchStage) => this.emitPatchAwaitingInputProgress(patchStage),
      parsePatch: (patchStage) => this.parsePatch(patchStage),
      prepareSelectedSource: (patchStage) => this.prepareSelectedSource(patchStage),
      pushWarning: (patchStage, error) => this.pushWarning(patchStage, error),
    });
  }

  /** The checks a bare file must satisfy to stand in for a patch's member: the patch's own input
   * checks, else the weave's `rom.checks` when the weave names no `rom.member` (those checks then
   * describe the root ROM rather than a member). */
  private memberChecksFor(stage: StagedSource<TSource>): string | undefined {
    if (stage.state.inputChecks) return stage.state.inputChecks;
    return this.weaveRom && !this.weaveRom.member ? this.weaveRom.checks : undefined;
  }

  /** Every distinct ROM member the staged patches name as their input or target. */
  private getPatchMemberRefs() {
    return collectMemberRefs(this.patches.flatMap((patch) => [patch.state.patchInput, patch.state.patchTarget]));
  }

  private async refreshPatchReadiness() {
    for (const [index, patch] of this.patches.entries()) {
      const targetRef = patch.state.patchTarget || patch.state.patchInput;
      if (targetRef && "patch" in targetRef) {
        const producer = this.patches.find(
          (candidate, producerIndex) => producerIndex < index && candidate.state.patchId === targetRef.patch,
        );
        const target = producer
          ? this.getPatchableInputAssets().find((asset) => asset.id === producer.state.targetInputId)
          : undefined;
        if (target) assignApplyPatchTarget(patch, target);
        else clearApplyPatchTarget(patch);
      } else if (targetRef?.member) {
        const matches = findMemberAssets(
          targetRef.member,
          this.getPatchableInputAssets(),
          this.memberChecksFor(patch),
          this.getPatchMemberRefs(),
        );
        if (matches.length === 1) assignApplyPatchTarget(patch, matches[0] as InputAsset);
        else clearApplyPatchTarget(patch);
      }
      await this.evaluatePatchReadiness(patch);
    }
  }

  /**
   * Deep-validates staged, targeted patches after the cheap readiness preflight.
   * Disabled patches wait until they are re-enabled.
   */
  async validatePatches(options?: {
    /** Index-aligned declared chain metadata (weave/user basis + checks) per staged patch. */
    chainMeta?: ReadonlyMap<
      number,
      { basis?: "auto" | "base" | "previous"; inputChecks?: string; outputChecks?: string }
    >;
    defaultPatchBasis?: "auto" | "base" | "previous";
    disabledIndexes?: ReadonlySet<number>;
    /** The active weave's expected ROM; present (even undefined) replaces the stored one. */
    weaveRom?: WeaveRomExpectation;
    /** Set when a newer input change is queued behind this pass: the ROM about to be replaced is
     * not hashed for the weave's checks, and its patches stay a retryable "unknown". */
    skipWeaveRomHash?: boolean;
  }): Promise<void> {
    return this.mutate("validatePatches", async () => {
      if (options && "weaveRom" in options) this.setWeaveRom(options.weaveRom);
      const weaveRomVerdict = await this.verifyWeaveRom({ skipHash: options?.skipWeaveRomHash === true });
      if (this.updateWeaveRomLayout(weaveRomVerdict)) await this.refreshPatchReadiness();
      const disabledIndexes = options?.disabledIndexes;
      // A toggle can change which patch runs first, and only that patch's file-name crc32 applies:
      // the patches gaining or losing that role re-run their preflight below.
      const firstEnabledBefore = this.getFirstEnabledPatches();
      this.disabledPatches = new Set(this.patches.filter((_, index) => disabledIndexes?.has(index)));
      const firstEnabledAfter = this.getFirstEnabledPatches();
      const firstEnabledMoved = new Set(
        [...firstEnabledBefore, ...firstEnabledAfter].filter(
          (patch) => firstEnabledBefore.has(patch) !== firstEnabledAfter.has(patch),
        ),
      );
      const assets = this.getPatchableInputAssets();
      const pending: Array<{
        chain?: { basis?: "auto" | "base" | "previous"; inputChecks?: string; outputChecks?: string };
        chainFingerprint?: string;
        preflight: InternalPatchChecksumPreflight;
        stage: StagedSource<TSource>;
        target: InputAsset;
      }> = [];
      const previousByTarget = new Map<string, StagedSource<TSource>>();
      let skippedDisabled = 0;
      for (const [index, stage] of this.patches.entries()) {
        if (disabledIndexes?.has(index)) {
          skippedDisabled += 1;
          continue;
        }
        if (!(stage.state.status === "ready" && stage.state.targetInputId && stage.state.checksumPreflight)) continue;
        if (!(stage.parsedPatch && stage.preparedPatchFile)) continue;
        // The planner receives a linear patch list. An explicit named producer is resolved by
        // apply-time execution, so planning it against the current visual order would report a
        // false predecessor mismatch after a reorder or partial selection.
        if (stage.state.patchInput && "patch" in stage.state.patchInput) continue;
        const target = assets.find(
          (asset) => asset.id === stage.state.targetInputId || asset.fileName === stage.state.targetInputId,
        );
        if (!target) continue;
        const chain = options?.chainMeta?.get(index);
        const basis = chain?.basis ?? stage.state.basisChoice ?? options?.defaultPatchBasis ?? this.defaultPatchBasis;
        if (
          basis !== "auto" ||
          !previousByTarget.has(target.id) ||
          !target.checksumVariants?.some(isTransformVariant) ||
          firstEnabledMoved.has(stage)
        ) {
          await this.evaluatePatchReadiness(
            stage,
            chain?.inputChecks,
            basis === "previous" ? previousByTarget.get(target.id)?.state : undefined,
          );
        }
        const preflight = stage.state.checksumPreflight;
        if (!preflight) continue;
        pending.push({ chain, preflight, stage, target });
        previousByTarget.set(target.id, stage);
      }
      // Plan-mode verdicts depend on chain position, so each target chain gets a fingerprint of
      // its ordered enabled members + declarations; any order/enablement/declaration change
      // invalidates every member's cached verdict.
      const chainsByTarget = new Map<string, typeof pending>();
      for (const entry of pending) {
        const bucket = chainsByTarget.get(entry.target.id);
        if (bucket) bucket.push(entry);
        else chainsByTarget.set(entry.target.id, [entry]);
      }
      const unresolvedLayout = new Set<StagedSource<TSource>>();
      for (const targetId of this.chainLayoutBases.keys()) {
        if (!chainsByTarget.has(targetId)) this.chainLayoutBases.delete(targetId);
      }
      for (const [targetId, chain] of chainsByTarget) {
        const target = chain[0]?.target;
        const defaultBasis = options?.defaultPatchBasis ?? this.defaultPatchBasis;
        const hasAuto = chain
          .slice(1)
          .some((entry) => (entry.chain?.basis ?? entry.stage.state.basisChoice ?? defaultBasis) === "auto");
        if (
          target?.checksumVariants?.some(isTransformVariant) &&
          hasAuto &&
          weaveRomVerdict?.status !== "unavailable" &&
          !options?.skipWeaveRomHash
        ) {
          const sources = [target.file, ...chain.map((entry) => entry.stage.preparedPatchFile)];
          const layoutFingerprint = JSON.stringify({
            target: [target.id, target.size, target.checksums, target.checksumVariants],
            defaultBasis,
            chain: chain.map((entry) => [
              entry.stage.state.id,
              entry.stage.state.selectedCandidateId,
              entry.stage.state.requirements,
              entry.chain,
              entry.stage.state.basisChoice,
              entry.stage.state.inputChecks,
              entry.stage.state.outputChecks,
              entry.stage.state.validateInputChecksum,
              entry.stage.state.validateOutputChecksum,
              entry.stage.state.headerChoice,
              entry.stage.state.n64ByteOrderChoice,
            ]),
          });
          let cached = this.chainLayoutBases.get(targetId);
          if (
            cached?.fingerprint !== layoutFingerprint ||
            sources.some((source, index) => cached?.sources[index] !== source)
          ) {
            // AUTO basis MUST come from the engine's endpoint planner, including embedded
            // evidence. Probe original bytes on isolated states before grouping by layout.
            const probes: typeof chain = chain.map((entry) => ({
              ...entry,
              stage: {
                ...entry.stage,
                state: {
                  ...entry.stage.state,
                  headerChoice: "keep" as const,
                  n64ByteOrderChoice: "keep" as const,
                  patchValidation: undefined,
                  chainVerdict: undefined,
                },
              },
            }));
            let bases: Array<"base" | "previous"> | undefined;
            const started = Date.now();
            await validateApplyPatchTargets(probes, {
              defaultPatchBasis: defaultBasis,
              emitProgress: () => undefined,
              onChainPlan: (_id, plan) => {
                if (
                  plan.per_patch.length === chain.length &&
                  plan.per_patch.every((entry, index) => entry.index === index)
                )
                  bases = plan.per_patch.map((entry) => entry.basis);
              },
              runtime: this.runtime,
              settings: {
                ...this.settings,
                compatibility: { ...this.settings.compatibility, removeHeader: false },
              },
              signal: this.abortController.signal,
              workflowId: this.id,
            });
            this.trace("patch.layout.plan", {
              targetId,
              patches: chain.length,
              elapsedMs: Date.now() - started,
              resolved: !!bases,
            });
            if (bases && !this.abortController.signal.aborted) {
              cached = { fingerprint: layoutFingerprint, sources, bases };
              this.chainLayoutBases.set(targetId, cached);
            } else {
              this.chainLayoutBases.delete(targetId);
              for (const [index, entry] of chain.entries()) {
                const verdict = probes[index]?.stage.state.patchValidation;
                entry.stage.state.patchValidation = verdict ? { ...verdict, status: "unknown" } : undefined;
                unresolvedLayout.add(entry.stage);
              }
              continue;
            }
          }
          for (const [index, entry] of chain.entries()) {
            await this.evaluatePatchReadiness(
              entry.stage,
              entry.chain?.inputChecks,
              cached.bases[index] === "previous" ? chain[index - 1]?.stage.state : undefined,
            );
            if (entry.stage.state.checksumPreflight) entry.preflight = entry.stage.state.checksumPreflight;
          }
        }
        const fingerprint = JSON.stringify({
          chain: chain.map((entry) => [
            entry.stage.state.id,
            entry.chain?.basis ?? "auto",
            entry.chain?.inputChecks ?? "",
            entry.chain?.outputChecks ?? "",
          ]),
          defaultPatchBasis: options?.defaultPatchBasis ?? "auto",
          targetId,
          // The ROM verdict joins the key so a retried hash that now resolves re-runs the chain.
          weaveRom: this.weaveRom ? { ...this.weaveRom, status: weaveRomVerdict?.status ?? "unknown" } : null,
        });
        for (const entry of chain) entry.chainFingerprint = fingerprint;
      }
      // Plans for targets with no live chain are stale (target removed / patches retargeted);
      // targets whose chain is fully cached keep their still-valid plan (the group call skips).
      for (const targetId of this.latestChainPlans.keys()) {
        if (!chainsByTarget.has(targetId)) this.latestChainPlans.delete(targetId);
      }
      if (skippedDisabled > 0) {
        this.trace("patch.validate.skip-disabled", {
          pendingCount: pending.length,
          skippedCount: skippedDisabled,
        });
      }
      const adapters: PatchTargetValidationAdapters = {
        defaultPatchBasis: options?.defaultPatchBasis ?? "auto",
        emitProgress: (event) => this.emitProgress(event),
        onChainPlan: (targetId, plan) => {
          this.latestChainPlans.set(targetId, plan);
          this.trace("patch.validate.plan", {
            failed: plan.failed_count,
            passed: plan.passed_count,
            status: plan.status,
            suggestedOrder: plan.suggested_order?.join(",") ?? "",
            targetId,
          });
        },
        runtime: this.runtime,
        settings: this.settings,
        signal: this.abortController.signal,
        ...(weaveRomVerdict?.status === "mismatch" || weaveRomVerdict?.status === "unavailable"
          ? {
              weaveRom: {
                message: weaveRomVerdict.message || "Input checksum mismatch",
                status: weaveRomVerdict.status,
              },
            }
          : {}),
        workflowId: this.id,
      };
      // Batch patches by input and header decision to share one runner boot and mount. Independent
      // groups still run concurrently; transient failures become retryable unknown verdicts.
      await validateApplyPatchTargets(
        pending.filter((entry) => !unresolvedLayout.has(entry.stage)),
        adapters,
      );
      this.recomputeOutputState();
    });
  }

  protected computeSnapshot(): ApplyWorkflowSnapshot {
    if (
      this.publishedChainPlans.size !== this.latestChainPlans.size ||
      [...this.latestChainPlans].some(([target, plan]) => this.publishedChainPlans.get(target) !== plan)
    ) {
      this.publishedChainPlans = new Map(this.latestChainPlans);
    }
    return {
      busy: this.isBusy(),
      chainPlans: this.publishedChainPlans,
      id: this.id,
      input: this.getInput(),
      output: {
        manualOutputFormat: this.outputState.manualOutputFormat,
        manualOutputName: this.outputState.manualOutputName,
        outputFormat: this.outputState.outputFormat,
        outputName: this.outputState.outputName,
      },
      patches: this.getPatches(),
      ready: this.computeReady(),
    };
  }

  /** Mirror the preconditions enforced by {@link run}: input ready+selected, every patch ready,
   * and an output name resolved. */
  private computeReady(): boolean {
    const input = this.inputSession;
    if (!input) return false;
    if (input.view.state.status !== "ready" || !input.view.state.selectedCandidateId) return false;
    if (this.patches.some((patch) => patch.state.status !== "ready")) return false;
    return !!this.outputState.outputName;
  }

  private recomputeOutputState() {
    recomputeApplyOutputState(this.outputState, this.settings, {
      input: this.getInput(),
      inputSession: this.inputSession as InputSession<unknown> | undefined,
      patchOutputNames: this.patches.map((patch, index) => resolvePatchOutputName(patch, index)),
      cheatNames: this.cheatRecords.map((record) => record.description),
    });
  }

  private createExecutionOptions(onProgress?: ApplyWorkflowOptions["onProgress"]): ApplyWorkflowOptions {
    const output = this.settings.output || {};
    return {
      compatibility: cloneValue(this.settings.compatibility || {}),
      input: cloneValue(this.settings.input || {}),
      logging: cloneValue(this.settings.logging || {}),
      onLog: this.settings.logging?.sink,
      onProgress,
      output: {
        ...cloneValue(output),
        compression: this.outputState.outputFormat,
        outputName:
          getApplyExecutionOutputName(this.outputState, this.settings, this.getInput()?.fileName) || output.outputName,
      },
      ...(this.retainUncompressedOutput ? { retainUncompressedOutput: this.retainUncompressedOutput } : {}),
      signal: this.abortController.signal,
      validation: cloneValue(this.settings.validation || {}),
      workers: cloneValue(this.settings.workers || {}),
    };
  }

  private getEffectiveInputSources(): TSource[] {
    const session = this.inputSession;
    // Synthetic sessions weave several separately-provided ROMs; apply keeps only the chosen one,
    // so the run (and its size accounting) sees just that source rather than every uploaded file.
    if (session?.synthetic) {
      const selectedOwner = this.getSelectedInputOwner();
      if (selectedOwner) return [selectedOwner.source];
    }
    return this.inputs;
  }

  private createPatchInput(onProgress?: ApplyWorkflowOptions["onProgress"]): PatchInput {
    return {
      cheatRecords: this.cheatRecords.map((record) => cloneValue(record)),
      ...(this.cheatPositions.length ? { cheatPositions: [...this.cheatPositions] } : {}),
      defaultPatchBasis: this.defaultPatchBasis,
      inputs: this.getEffectiveInputSources() as never,
      options: this.createExecutionOptions(onProgress),
      parsedPatches: this.patches.map((patch) => patch.parsedPatch).filter(Boolean) as ParsedPatchLike[],
      patches: this.patches.map((patch) => patch.source) as never,
      patchOptions: this.patches.map((patch) => ({
        ...(patch.state.patchId ? { id: patch.state.patchId } : {}),
        ...(patch.state.patchInput ? { input: patch.state.patchInput } : {}),
        ...(patch.state.patchTarget ? { target: patch.state.patchTarget } : {}),
        ...(patch.state.inputChecks ? { inputChecks: patch.state.inputChecks } : {}),
        ...(patch.state.outputChecks ? { outputChecks: patch.state.outputChecks } : {}),
        basis: patch.state.basisChoice,
        // User drawer choice wins; otherwise only a checksum-proven decision acts.
        // An undecided one is left unset so the engine's own inference runs.
        header:
          patch.state.headerChoice ??
          (patch.state.headerResolution?.decided ? patch.state.headerResolution.mode : undefined),
        n64ByteOrder: patch.state.n64ByteOrderChoice,
        resolvedN64ByteOrder: patch.state.n64Resolution?.decided ? patch.state.n64Resolution.mode : undefined,
        validateInputChecksum: patch.state.validateInputChecksum,
        validateOutputChecksum: patch.state.validateOutputChecksum,
      })),
      patchTargets: this.patches.map((patch) => patch.state.targetInputId || "auto"),
      preparedInputAssets: this.getPreparedInputAssets(),
      preparedPatchFiles: this.patches.map((patch) => patch.preparedPatchFile).filter(Boolean) as PatchFileInstance[],
    };
  }

  private getRuntimeSourcesForStage(stage?: StagedSource<TSource>): unknown[] {
    if (!stage) return [];
    return [
      ...(stage.preparedInputAssets || []).map((asset) => asset.file),
      ...(stage.preparedPatchFile ? [stage.preparedPatchFile] : []),
    ];
  }

  private async releaseRuntimeSources(sources: unknown[]): Promise<void> {
    await this.runtime.workerIo?.releaseSources?.(sources).catch(() => undefined);
  }

  // The source registry starts with one owner. The first workflow owner transfers that reference;
  // only a later owner needs to reacquire it after a real release.
  private retainOwnedSources(sources: unknown[]): void {
    for (const source of sources) {
      const pendingRelease = this.pendingOwnedSourceReleases.get(source);
      if (pendingRelease) {
        clearTimeout(pendingRelease);
        this.pendingOwnedSourceReleases.delete(source);
      } else if (
        !this.ownedSourceRefCounts.has(source) &&
        source &&
        typeof source === "object" &&
        this.releasedOwnedSources.has(source as object)
      ) {
        this.runtime.workerIo?.retainOwnedSources?.([source]);
      }
      this.ownedSourceRefCounts.set(source, (this.ownedSourceRefCounts.get(source) || 0) + 1);
    }
  }

  private async replaceOwnedStageSource(stage: StagedSource<TSource>, replacement: TSource): Promise<void> {
    const previous = stage.source;
    if (previous === replacement) return;
    // Retain first so replacement is atomic from the ownership ledger's perspective. Otherwise a
    // clear/dispose racing the swap can release neither the old archive nor the extracted leaf.
    this.retainOwnedSources([replacement]);
    stage.source = replacement;
    await this.releaseOwnedSources([previous]);
  }

  private async releaseOwnedSources(sources: unknown[]): Promise<void> {
    for (const source of sources) {
      const refCount = this.ownedSourceRefCounts.get(source) || 0;
      if (refCount > 1) this.ownedSourceRefCounts.set(source, refCount - 1);
      else if (refCount === 1) {
        this.ownedSourceRefCounts.delete(source);
        if (source && typeof source === "object") this.releasedOwnedSources.add(source);
        if (!this.pendingOwnedSourceReleases.has(source)) {
          this.pendingOwnedSourceReleases.set(
            source,
            setTimeout(() => {
              this.pendingOwnedSourceReleases.delete(source);
              void this.runtime.workerIo?.releaseOwnedSources?.([source]).catch(() => undefined);
            }, 0),
          );
        }
      }
    }
  }

  private async flushPendingOwnedSourceReleases(): Promise<void> {
    const sources = [...this.pendingOwnedSourceReleases.keys()];
    for (const timer of this.pendingOwnedSourceReleases.values()) clearTimeout(timer);
    this.pendingOwnedSourceReleases.clear();
    if (sources.length) await this.runtime.workerIo?.releaseOwnedSources?.(sources).catch(() => undefined);
  }

  private async releasePatchSources(): Promise<void> {
    const ownedSources = this.patches.map((patch) => patch.source);
    const sources = this.patches.flatMap((patch) => [patch.source, ...this.getRuntimeSourcesForStage(patch)]);
    await Promise.all(this.patches.map((patch) => releasePreparedSourceAndWait(patch)));
    await this.releaseRuntimeSources(sources);
    await this.releaseOwnedSources(ownedSources);
  }

  private async releaseInputSession() {
    const session = this.inputSession;
    this.inputSession = undefined;
    // Drop any early sidecar picks tied to the released session so a fresh input never reuses them.
    this.earlySidecarSelections.clear();
    this.earlySidecarSelectionInFlight.clear();
    await this.inputStages.releaseSession(session);
    await this.releaseOwnedSources(session?.sources || []);
  }
}

export { ApplyWorkflowController };
