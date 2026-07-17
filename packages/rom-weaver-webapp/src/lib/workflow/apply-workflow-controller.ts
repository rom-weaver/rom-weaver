import { createVfsFileRef, isVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type {
  ApplyWorkflowBundleSources,
  ApplyWorkflowInputState,
  ApplyWorkflowPatchState,
} from "../../types/apply-workflow.ts";
import type { ApplyResult } from "../../types/public.ts";
import type { CandidateSelectionRequest, SelectionCandidate } from "../../types/selection.ts";
import type { ApplySettings, CompressionFormat } from "../../types/settings.ts";
import type { SourceRef } from "../../types/source.ts";
import type { WorkflowOptions } from "../../types/workflow-controller.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { ApplyWorkflowOptions, PatchInput } from "../../types/workflow-runtime-types.ts";
import type { ParsedPatchLike, PatchFileInstance } from "../../workers/protocol/patch-engine.ts";
import { getPatchProbeRequirements } from "../apply/patch-apply-service.ts";
import { patchWorkflowDeps, runApplyWorkflow } from "../apply/workflow.ts";
import { isCompressionFormat } from "../compression/container-format-registry.ts";
import { RomWeaverError, toRomWeaverError, withAbortSignal } from "../errors.ts";
import { getPatchFileBlob, getPatchFileBytes, getPatchFileExternalSource } from "../input/binary-service.ts";
import type { InputAsset, InputParentCompression, PreparedSidecarPatch } from "../input/input-assets.ts";
import {
  getPatchLeafFileForSelection,
  getPatchLeafParentCompressionsForSelection,
  prepareInputFile,
} from "../input/input-preparation-service.ts";
import { selectionToArchiveEntry } from "../input/selection.ts";
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
import { type PatchTargetValidationAdapters, validateApplyPatchTargets } from "./apply-patch-target-validation.ts";
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
  InternalCandidate,
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
import type { StagedRomSourceController } from "./staged-rom-source.ts";
import { cloneChecksumRomProbe, getPrimaryInputAsset } from "./staged-source-checksums.ts";

/** Side-channel chain attached to a fanned-out leaf patch File so a re-stage (which sees only the
 * raw patch, not its parent archive) can still render the archive-nesting "extract section". */
type NestedPatchSourceMetadata = { __nestedParentCompressions?: InputParentCompression[] };

/** Reactive snapshot of the apply workflow's staged state (see {@link BaseWorkflowController.getSnapshot}). */
type ApplyWorkflowSnapshot = BaseWorkflowSnapshot & {
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
  private readonly pendingOwnedSourceReleases = new Map<unknown, ReturnType<typeof setTimeout>>();
  private readonly inputStages: StagedRomSourceController<TSource, InternalSourceState>;
  private nextCandidateSequence = 0;
  private nextInputSequence = 0;
  private nextPatchSequence = 0;
  private outputState: ApplyOutputState;
  private inputSession?: InputSession<TSource>;
  private patches: Array<StagedSource<TSource>> = [];
  private inputs: TSource[] = [];
  /** Picks captured by an early sidecar patch dialog opened from the streamed `patch-manifest`
   * event (before the ROM finished hashing), keyed by the input stage id. `discoverImplicitPatches`
   * applies these instead of re-opening the dialog. A non-empty entry lists the chosen patch file
   * names in apply order; an empty array means the early dialog ran but the user picked nothing. */
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
    // A synthetic session bundles several separately-provided ROMs. Once one is chosen, expose only
    // it - the unchosen ROMs are discarded ("ask which one" keeps a single input). Until a choice is
    // made, surface every ready stage so the selection prompt can list them.
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

  /**
   * Export the exact leaves that staging prepared for apply. Keeping this on the controller avoids
   * a second archive extraction/ingest pass when the user exports a bundle immediately afterward.
   */
  getBundleExportSources(): ApplyWorkflowBundleSources {
    const session = this.inputSession;
    const selectedOwner = this.getSelectedInputOwner();
    const inputStage = selectedOwner || session?.view;
    const primaryAsset = getPrimaryInputAsset(inputStage?.preparedInputAssets || []);
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
    const rom =
      primaryAsset && inputStage
        ? {
            fileName: primaryAsset.file.fileName || primaryAsset.fileName || inputStage.state.fileName || "rom.bin",
            originalSource: inputStage.source as unknown as SourceRef,
            size: primaryAsset.size,
            source: sourceForFile(
              primaryAsset.file,
              inputStage.source,
              primaryAsset.file.fileName || primaryAsset.fileName,
            ),
            ...(inputStage.state.checksums ? { checksums: { ...inputStage.state.checksums } } : {}),
            ...(inputStage.state.romType?.recommendedFormat
              ? { recommendedFormat: inputStage.state.romType.recommendedFormat }
              : {}),
          }
        : null;
    const patches = this.patches.map((stage) => {
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
      };
    });
    return { patches, rom };
  }

  async setInput(
    input: TSource | TSource[],
    options?: { onFinalized?: (input: ApplyWorkflowInputState | null) => void },
  ): Promise<void> {
    return this.mutate("setInput", async () => {
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
        // The input is fully checksummed here - surface its terminal state now so the ROM row stops
        // showing "checksumming" while the patch (re)validation below runs. That validation is a patch
        // concern and reports only on the patch row, so it must not keep the ROM row busy.
        options?.onFinalized?.(this.getInput());
        const endImplicit = startStageSpan("setInput:discoverImplicitPatches");
        await this.discoverImplicitPatches();
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
    return this.mutate("clearInput", async () => {
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
    // Eager staging runs OUTSIDE the mutation queue so the patch's I/O overlaps the ROM's setInput.
    // The interactive pick is surfaced here too (not deferred to the queued mutation), gated only by
    // the single-modal mutex so it can't race setInput's ROM prompt - but it does NOT wait for the
    // ROM's extract/checksum. The user picks while the ROM is still hashing; the state-mutating apply
    // + validation still run in the queued addPatch mutation below, serialized after setInput.
    const stagedPromise = this.stageSource(stage, { deferBlockingSelection: true })
      .then((staged) => {
        // The patch is extracted, but its addPatch mutation is queued behind the ROM's setInput
        // (mutations run serially). Until that mutation runs and validation begins, the row would keep
        // showing the patch's last staging label ("checking nested archives in extracted outputs"),
        // so replace it with an accurate "waiting on the ROM" status while the input is still loading.
        this.emitPatchAwaitingInputProgress(staged);
        return staged;
      })
      .then(async (staged) => {
        // Open the multi-select dialog as soon as the patch archive is staged (mutex-gated behind any
        // ROM prompt). The pick is stashed for the queued mutation; re-emit the "waiting on the ROM"
        // status so the row reflects that the apply is now blocked on the input, not on a pending pick.
        await this.resolvePatchSelectionChoice(staged);
        this.emitPatchAwaitingInputProgress(staged);
        return staged;
      })
      .catch((error) => {
        throw toRomWeaverError(error);
      });
    void stagedPromise.catch(() => undefined);
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

  // Sidecar patches the ROM-staging `ingest` already extracted from this stage's source archive,
  // harvested off the same pass (no separate scan). Empty unless the source was a mixed ROM+patch
  // archive.
  private stageSidecarPatches(stage: StagedSource<TSource>): PreparedSidecarPatch[] {
    return (stage.preparedInputAssets ?? []).flatMap((asset) => asset.sidecarPatches ?? []);
  }

  /** Intercept staging progress for the streamed `patch-manifest` event - the ingest enumerates a
   * mixed archive's sidecar patches BEFORE it hashes the ROM and streams them here - and open the
   * multi-select dialog right away. The user picks while the ROM checksum is still running; the pick
   * is reconciled in {@link discoverImplicitPatches} once the input session finishes staging. */
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
    // Surface once per input stage: ignore a repeated/re-emitted manifest for a stage already handled.
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
      // The candidate ids ARE the patch file names (see buildSidecarManifestRequest); keep them in
      // pick order. A null selection (no handler) records an empty pick so the reconcile step does not
      // re-open a fallback dialog.
      const selectedIds = selection
        ? Array.isArray(selection.ids) && selection.ids.length
          ? selection.ids
          : [selection.id]
        : [];
      const picked = selectedIds.filter((id): id is string => typeof id === "string" && patchFileNames.includes(id));
      this.earlySidecarSelections.set(stageId, picked);
      this.trace("patch.implicit.early-surface.resolved", { picked, stageId });
    } catch (error) {
      // A failed/cancelled early dialog leaves no recorded pick, so discoverImplicitPatches falls back
      // to surfacing the dialog the normal way.
      this.trace("patch.implicit.early-surface.failed", { error, stageId });
    } finally {
      this.earlySidecarSelectionInFlight.delete(stageId);
    }
  }

  /** A synthetic multi-select request over the streamed sidecar patch file names. The chosen leaf
   * files are applied later from the staged `sidecarPatches`, so this request only needs ids/labels
   * for the dialog; each candidate id is its patch file name. */
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

  /** Apply a pick captured by an early `patch-manifest` dialog: wait for an in-flight dialog, then
   * fan the chosen sidecars out from the already-materialized leaves (no second dialog, no re-ingest).
   * Returns whether an early pick was handled (including an empty pick - the user chose nothing). */
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

  private async discoverImplicitPatches(): Promise<void> {
    if (this.patches.length || !this.inputSession) return;
    const stages = this.inputSession.stages.length ? this.inputSession.stages : [this.inputSession.view];
    // No interactive selection handler - headless / libretro-style automatic soft-patching - so apply
    // only the sidecar patch(es) whose name matches the ROM, with no prompt. With a handler (the webapp)
    // every sidecar patch the archive carried is surfaced through the selection flow instead.
    if (!this.selectFile) {
      await this.discoverNameMatchedSidecarPatches(stages);
      return;
    }
    for (const stage of stages) {
      const sidecarPatches = this.stageSidecarPatches(stage);
      if (!sidecarPatches.length) continue;
      // Preferred path: the dialog was already opened from the streamed `patch-manifest` while the ROM
      // was hashing; apply that pick directly off the materialized leaves - no second dialog, no
      // re-ingest of the archive.
      if (await this.applyEarlySidecarSelection(stage, sidecarPatches)) continue;
      // A lone sidecar patch auto-adds (no prompt), reusing the leaf the ROM-staging ingest already
      // extracted. (The apply execution skips its own discovery once rows exist.)
      if (sidecarPatches.length === 1) {
        const only = sidecarPatches[0];
        if (only) {
          this.trace("patch.implicit.sidecar-auto-add", { fileName: only.file.fileName });
          await this.addFannedOutPatch(only.file, only.parentCompressions);
        }
        continue;
      }
      // Fallback (the early streamed dialog never ran - e.g. the sidecar event was missed): surface
      // the multi-select now by re-staging the archive as a patch source.
      this.trace("patch.implicit.sidecar-surface", { count: sidecarPatches.length, fileName: stage.state.fileName });
      // The staging cache is reference-counted, so the patch flow can share the exact source object
      // with the input flow without conflating a same-metadata but different File.
      await this.surfaceArchivePatchSelection(stage.source);
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
      this.recomputeOutputState();
      this.trace("patches.clear", { patchCount });
    });
  }

  async setSettings(settings: Partial<ApplySettings>): Promise<void> {
    return this.mutate("setSettings", async () => {
      this.trace("settings.set.start", {
        hasInputSession: !!this.inputSession,
      });
      this.settings = cloneValue(settings || {});
      applyOutputSettings(this.outputState, this.settings, this.inputSession as InputSession<unknown> | undefined);
      this.preloadRuntimeCapability("compression");
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
        throw new RomWeaverError("INVALID_SETTINGS", `Unsupported output format: ${format}`);
      setApplyOutputFormat(this.outputState, this.settings, format);
      this.recomputeOutputState();
    });
  }

  async setPatchTarget(index: number, targetInputId: string | "auto"): Promise<void> {
    return this.mutate("setPatchTarget", async () => {
      const stage = this.patches[index];
      if (!stage) throw new RomWeaverError("INVALID_INPUT", `Patch ${index + 1} was not found`);
      if (targetInputId === "auto") {
        clearApplyPatchTarget(stage);
        await this.evaluatePatchReadiness(stage);
        this.recomputeOutputState();
        return;
      }
      const target = this.getPatchableInputAssets().find(
        (asset) => asset.id === targetInputId || asset.fileName === targetInputId,
      );
      if (!target) throw new RomWeaverError("SELECTION_NOT_FOUND", `Patch target was not found: ${targetInputId}`);
      assignApplyPatchTarget(stage, target);
      await this.evaluatePatchReadiness(stage);
      this.recomputeOutputState();
    });
  }

  async setPatchOption(
    index: number,
    option: {
      validateInputChecksum?: string;
      validateOutputChecksum?: string;
      header?: "keep" | "strip";
    },
  ): Promise<void> {
    return this.mutate("setPatchOption", async () => {
      const stage = this.patches[index];
      if (!stage) throw new RomWeaverError("INVALID_INPUT", `Patch ${index + 1} was not found`);
      let verificationChanged = false;
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
          throw new RomWeaverError(
            "AMBIGUOUS_SELECTION",
            `${pendingPatch.state.fileName || "Patch"} requires selection`,
          );
        throw new RomWeaverError(
          "AMBIGUOUS_SELECTION",
          pendingPatch.state.warnings.at(-1)?.message || `${pendingPatch.state.fileName || "Patch"} is not ready`,
        );
      }
      const outputName = this.outputState.outputName;
      if (!outputName) throw new RomWeaverError("INVALID_SETTINGS", "Output name is required");
      const result = await withAbortSignal(
        runApplyWorkflow(
          this.createPatchInput((progress) => {
            const stage = progress.stage === "output" ? "compress" : "apply";
            const role = progress.stage === "output" ? "output" : "worker";
            this.emitProgress({
              details: {
                ...(isRecord(progress.details) ? progress.details : {}),
              },
              hasProgress: progress.hasProgress,
              id: `${this.id}:${role}:${stage}`,
              label: progress.label || (stage === "compress" ? "Compressing output..." : "Weaving patch..."),
              percent:
                typeof progress.percent === "number" && Number.isFinite(progress.percent) ? progress.percent : null,
              role,
              stage,
              workflow: "apply",
            });
          }),
          this.runtime,
          patchWorkflowDeps as never,
        ),
        this.abortController.signal,
      );
      const outputs = result.outputs.map((output, index) =>
        wrapPublicOutput<TDestination>(output, this.runtime, index),
      );
      const publicResult: ApplyResult<TDestination> = {
        inputs: result.inputs,
        output: outputs[0] as ApplyResult<TDestination>["output"],
        outputs,
        patches: result.patches,
        sizeSummary: result.sizeSummary,
      };
      return publicResult;
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.abort();
    await this.releaseInputSession();
    await this.releasePatchSources();
    await this.flushPendingOwnedSourceReleases();
    await this.runtime.workerIo?.releaseOwnedSources?.([...this.ownedSourceRefCounts.keys()]).catch(() => undefined);
    this.ownedSourceRefCounts.clear();
    this.patches = [];
    this.clearListeners();
    this.disposed = true;
  }

  private preloadRuntimeCapability(capability: "checksum" | "compression" | "patch"): void {
    const preload = this.runtime.preload?.preloadCapability;
    if (!preload) return;
    this.trace("runtime.preload.start", {
      capability,
      workerThreads: this.settings.workers?.threads,
    });
    void preload(capability, () => undefined, {
      workerThreads: this.settings.workers?.threads,
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
    const requests: CandidateSelectionRequest[] = [];
    const options = createSourceStagingOptions({
      base: this.createExecutionOptions(),
      emitProgress: (event) => this.emitProgress(event),
      onCandidatesFound: (request) => requests.push(request),
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
    const parsed = await patchWorkflowDeps.parsePatchForApply(patchFile, this.runtime);
    if (!parsed)
      throw new RomWeaverError("INVALID_INPUT", `Invalid patch file: ${patchFile.fileName || stage.state.fileName}`);
    stage.parsedPatch = parsed;
    stage.state.requirements = clonePatchRequirements(getPatchProbeRequirements(parsed));
    stage.state.checksumPreflight = undefined;
    stage.state.patchValidation = undefined;
  }

  private addCandidateRequest(stage: StagedSource<TSource>, request: CandidateSelectionRequest) {
    stage.state.multiSelect = !!request.multiSelect;
    const publicIdByCandidateId = new Map(
      request.candidates.map((candidate) => [
        candidate.id,
        `${this.id}:${stage.state.role}:${++this.nextCandidateSequence}`,
      ]),
    );
    const candidates = request.candidates.map((candidate) => {
      const publicId = publicIdByCandidateId.get(candidate.id) as string;
      const publicCandidate = cloneCandidate(candidate);
      const internal = {
        archiveEntry: candidate.selectable ? selectionToArchiveEntry(request, { id: candidate.id }) : undefined,
        candidate,
        owner: stage,
        request,
      } satisfies InternalCandidate<TSource>;
      stage.internalCandidates.set(publicId, internal);
      return {
        ...publicCandidate,
        id: publicId,
        ...(publicCandidate.type === "group"
          ? {
              candidateIds: (publicCandidate.candidateIds || []).map(
                (candidateId) => publicIdByCandidateId.get(candidateId) || candidateId,
              ),
            }
          : publicCandidate.parentCandidateId
            ? {
                parentCandidateId: publicIdByCandidateId.get(publicCandidate.parentCandidateId),
              }
            : {}),
      } as SelectionCandidate;
    });
    stage.state.candidates = candidates;
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
    // A synthetic session bundles several separately-provided ROMs. Apply keeps only the chosen one
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

  private async evaluatePatchReadiness(stage: StagedSource<TSource>): Promise<boolean> {
    return evaluateApplyPatchReadiness(stage, {
      getPatchableInputAssets: () => this.getPatchableInputAssets(),
      notifyAwaitingInputTarget: (patchStage) => this.emitPatchAwaitingInputProgress(patchStage),
      parsePatch: (patchStage) => this.parsePatch(patchStage),
      prepareSelectedSource: (patchStage) => this.prepareSelectedSource(patchStage),
      pushWarning: (patchStage, error) => this.pushWarning(patchStage, error),
    });
  }

  private async refreshPatchReadiness() {
    for (const patch of this.patches) await this.evaluatePatchReadiness(patch);
  }

  /** Run the deferred deep dry-run validation for every patch that is staged, targeted, and not yet
   * verified against its current target. Readiness only computes the cheap checksum preflight; this
   * heavier pass runs afterward (driven by the form once the card is already showing) so a slow
   * full-ROM validation does not make a freshly-dropped patch look like it is stuck.
   *
   * `disabledIndexes` (index-aligned with the staged patch list) marks patches the user toggled off:
   * they are excluded from the run, so their dry-run is skipped too - it runs when (and if) the
   * patch is toggled back on, via the form's enablement-change revalidation pass. */
  async validatePatches(options?: { disabledIndexes?: ReadonlySet<number> }): Promise<void> {
    return this.mutate("validatePatches", async () => {
      const assets = this.getPatchableInputAssets();
      const disabledIndexes = options?.disabledIndexes;
      const pending: Array<{
        preflight: InternalPatchChecksumPreflight;
        stage: StagedSource<TSource>;
        target: InputAsset;
      }> = [];
      let skippedDisabled = 0;
      for (const [index, stage] of this.patches.entries()) {
        if (disabledIndexes?.has(index)) {
          skippedDisabled += 1;
          continue;
        }
        const preflight = stage.state.checksumPreflight;
        if (!(stage.state.status === "ready" && stage.state.targetInputId && preflight)) continue;
        if (!(stage.parsedPatch && stage.preparedPatchFile)) continue;
        const target = assets.find(
          (asset) => asset.id === stage.state.targetInputId || asset.fileName === stage.state.targetInputId,
        );
        if (!target) continue;
        pending.push({ preflight, stage, target });
      }
      if (skippedDisabled > 0) {
        this.trace("patch.validate.skip-disabled", {
          pendingCount: pending.length,
          skippedCount: skippedDisabled,
        });
      }
      const adapters: PatchTargetValidationAdapters = {
        emitProgress: (event) => this.emitProgress(event),
        runtime: this.runtime,
        settings: this.settings,
        signal: this.abortController.signal,
        workflowId: this.id,
      };
      // Validate every staged patch in ONE independent-mode call per input group. The Rust
      // `patch-validate` command now validates each --patch independently against the original input
      // (no chaining) and reports an index-aligned per-patch verdict, so all patches targeting the
      // same input + header decision share a single runner boot + input mount instead of paying N
      // cold boots (a real risk of the ~1GiB-per-worker OOM tab reload on iOS when several fire at
      // once). Distinct groups still run concurrently; the batched call never throws (transient
      // failures/aborts become retryable "unknown").
      await validateApplyPatchTargets(pending, adapters);
      this.recomputeOutputState();
    });
  }

  protected computeSnapshot(): ApplyWorkflowSnapshot {
    return {
      busy: this.isBusy(),
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
      signal: this.abortController.signal,
      validation: cloneValue(this.settings.validation || {}),
      workers: cloneValue(this.settings.workers || {}),
    };
  }

  private getEffectiveInputSources(): TSource[] {
    const session = this.inputSession;
    // Synthetic sessions bundle several separately-provided ROMs; apply keeps only the chosen one,
    // so the run (and its size accounting) sees just that source rather than every uploaded file.
    if (session?.synthetic) {
      const selectedOwner = this.getSelectedInputOwner();
      if (selectedOwner) return [selectedOwner.source];
    }
    return this.inputs;
  }

  private createPatchInput(onProgress?: ApplyWorkflowOptions["onProgress"]): PatchInput {
    return {
      inputs: this.getEffectiveInputSources() as never,
      options: this.createExecutionOptions(onProgress),
      parsedPatches: this.patches.map((patch) => patch.parsedPatch).filter(Boolean) as ParsedPatchLike[],
      patches: this.patches.map((patch) => patch.source) as never,
      patchOptions: this.patches.map((patch) => ({
        // User drawer choice wins; otherwise only a checksum-proven auto decision acts.
        // Ambiguous (undecided) defaults to keep, matching RomPatcher.js.
        header:
          patch.state.headerChoice ??
          (patch.state.headerResolution?.decided ? patch.state.headerResolution.mode : undefined),
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

  private retainOwnedSources(sources: unknown[]): void {
    for (const source of sources) {
      const pendingRelease = this.pendingOwnedSourceReleases.get(source);
      if (pendingRelease) {
        clearTimeout(pendingRelease);
        this.pendingOwnedSourceReleases.delete(source);
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
