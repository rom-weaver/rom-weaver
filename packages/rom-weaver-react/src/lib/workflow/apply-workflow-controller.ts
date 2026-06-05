import type {
  ApplyWorkflowChecksums,
  ApplyWorkflowInputState,
  ApplyWorkflowParentCompression,
  ApplyWorkflowPatchState,
  ApplyWorkflowResolvedInput,
} from "../../types/apply-workflow.ts";
import type { ChecksumRomProbe } from "../../types/checksum.ts";
import type { WorkflowProgress } from "../../types/progress.ts";
import type { ApplyResult } from "../../types/public.ts";
import type { CandidateSelectionRequest, SelectionCandidate, SelectionFileCandidate } from "../../types/selection.ts";
import type { ApplySettings, CompressionFormat } from "../../types/settings.ts";
import type { WorkflowOptions, WorkflowWarning } from "../../types/workflow-controller.ts";
import type { ApplyWorkflowOptions, PatchInput } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { ParsedPatchLike, PatchFileInstance } from "../../workers/protocol/patch-engine.ts";
import { getPatchProbeRequirements } from "../apply/patch-apply-service.ts";
import { patchWorkflowDeps, runApplyWorkflow } from "../apply/workflow.ts";
import {
  getCompressionOutputExtension,
  isCompressionFormat,
  resolveAutomaticCompressionFormat,
} from "../compression/container-format-registry.ts";
import { RomWeaverError, throwIfAborted, toRomWeaverError, withAbortSignal } from "../errors.ts";
import { getPatchFileCleanup, getPatchFileExternalSource } from "../input/binary-service.ts";
import { getInputPreparationMetrics, type InputAsset, type InputParentCompression } from "../input/input-assets.ts";
import { prepareInputFile } from "../input/input-preparation-service.ts";
import {
  appendFileNameExtension,
  getBaseFileName,
  getFileNameWithoutExtension,
  stripFileNameQuery,
} from "../input/path-utils.ts";
import { selectionToArchiveEntry } from "../input/selection.ts";
import { wrapPublicOutput } from "../output/index.ts";
import { buildPatchedOutputBaseName } from "../output/output-name-composition.ts";
import { getFileNameExtension } from "../path-utils.ts";
import {
  cloneCandidate,
  cloneValue,
  cloneWarning,
  createWorkflowId,
  createWorkflowProgress,
  getPreparationProgressStage,
  getSourceFileName,
  getSourceSize,
  isRecord,
} from "./controller-utils.ts";
import {
  type SharedInternalCandidate,
  type SharedRomSourceSession,
  type SharedRomStagedSource,
  StagedRomSourceController,
} from "./staged-rom-source.ts";
import {
  calculateStandardInputChecksumsForFile,
  cloneChecksumRomProbe,
  getAssetDecompressionTimeMs,
  getAssetParentCompressions,
  getAssetSourceSize,
  getInputAssetChecksums,
  getPatchFilePrecomputedChecksums,
  getPrimaryInputAsset,
  isChecksummableInputAsset,
} from "./staged-source-checksums.ts";
import { WorkflowController } from "./workflow-controller.ts";
import { traceWorkflowControllerEvent } from "./workflow-tracing.ts";

type SourceValidator<TSource> = (sources: TSource | TSource[] | undefined) => void;
type SourceRole = "input" | "patch";
type SourceStatus = ApplyWorkflowInputState["status"];
type InternalPatchRequirements = NonNullable<ApplyWorkflowPatchState["requirements"]>;
type InternalPatchChecksumPreflight = NonNullable<ApplyWorkflowPatchState["checksumPreflight"]>;
type InternalPatchValidation = NonNullable<ApplyWorkflowPatchState["patchValidation"]>;
type InternalSourceState = {
  id: string;
  fileName?: string;
  order: number;
  status: SourceStatus;
  candidates: SelectionCandidate[];
  selectedCandidateId?: string;
  targetInputId?: string;
  targetInputFileName?: string;
  size?: number;
  sourceSize?: number;
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
  warnings: WorkflowWarning[];
  checksums?: ApplyWorkflowChecksums;
  checksumTimeMs?: number;
  romProbe?: ChecksumRomProbe;
  requirements?: InternalPatchRequirements;
  checksumPreflight?: InternalPatchChecksumPreflight;
  patchValidation?: InternalPatchValidation;
  role: SourceRole;
};
type InternalCandidate<TSource> = SharedInternalCandidate<TSource, InternalSourceState>;
type StagedSource<TSource> = SharedRomStagedSource<TSource, InternalSourceState> & {
  preparedInputAssets?: InputAsset[];
  preparedPatchFile?: PatchFileInstance;
  parsedPatch?: ParsedPatchLike;
  selectedArchiveEntry?: string;
  outputLabel?: string;
};
type InputSession<TSource> = SharedRomSourceSession<TSource, InternalSourceState>;
const toNormalizedCrc32 = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return (value >>> 0).toString(16).padStart(8, "0");
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  if (!normalized) return undefined;
  if (/^[0-9a-f]+$/i.test(normalized) && normalized.length <= 8)
    return Number.parseInt(normalized, 16).toString(16).padStart(8, "0");
  if (/^\d+$/.test(normalized)) return (Number.parseInt(normalized, 10) >>> 0).toString(16).padStart(8, "0");
  return undefined;
};

const clonePatchRequirements = (
  requirements: InternalPatchRequirements | undefined,
): InternalPatchRequirements | undefined => (requirements ? { ...requirements } : undefined);

const clonePatchChecksumPreflight = (
  preflight: InternalPatchChecksumPreflight | undefined,
): InternalPatchChecksumPreflight | undefined => (preflight ? { ...preflight } : undefined);

const clonePatchValidation = (validation: InternalPatchValidation | undefined): InternalPatchValidation | undefined =>
  validation ? { ...validation } : undefined;

const PATCH_OUTPUT_LABEL_PATTERN = /\[([^\]]+)\](?:\.[^.]+)?\d*$/;
const PATCH_TARGET_SELECTION_ERROR_CODES = new Set(["AMBIGUOUS_SELECTION", "PATCH_TARGET_MISMATCH"]);

const cloneInputState = (
  state: InternalSourceState | null | undefined,
  parentCompressions: ApplyWorkflowParentCompression[],
  resolvedInputs?: ApplyWorkflowResolvedInput[],
) =>
  state
    ? ({
        candidates: state.candidates.map(cloneCandidate),
        checksums: state.checksums ? cloneValue(state.checksums) : undefined,
        checksumTimeMs: state.checksumTimeMs,
        decompressionTimeMs: state.decompressionTimeMs,
        fileName: (() => {
          if (!(state.status === "needsSelection" && !state.selectedCandidateId)) return state.fileName;
          const selectableGroups = state.candidates.filter(
            (candidate) => candidate.type === "group" && candidate.selectable,
          );
          const selectableGroupIds = new Set(selectableGroups.map((candidate) => candidate.id));
          const romCandidates = state.candidates.filter(
            (candidate): candidate is SelectionFileCandidate =>
              candidate.type === "file" &&
              candidate.kind === "rom" &&
              candidate.selectable &&
              !selectableGroupIds.has(candidate.parentCandidateId || ""),
          );
          return romCandidates.length === 1 ? romCandidates[0]?.fileName || state.fileName : state.fileName;
        })(),
        id: state.id,
        parentCompressions: parentCompressions.map((entry) => ({ ...entry })),
        resolvedInputs: resolvedInputs?.map((entry) => ({
          ...entry,
          checksums: entry.checksums ? cloneValue(entry.checksums) : undefined,
          parentCompressions: entry.parentCompressions.map((parent) => ({
            ...parent,
          })),
          romProbe: cloneChecksumRomProbe(entry.romProbe),
        })),
        romProbe: cloneChecksumRomProbe(state.romProbe),
        selectedCandidateId: state.selectedCandidateId,
        size: state.size,
        sourceSize: state.sourceSize,
        status: state.status,
        warnings: state.warnings.map(cloneWarning),
        wasDecompressed: state.wasDecompressed,
      } satisfies ApplyWorkflowInputState)
    : null;

const clonePatchState = (
  state: InternalSourceState,
  parentCompressions: ApplyWorkflowParentCompression[],
): ApplyWorkflowPatchState => ({
  candidates: state.candidates.map(cloneCandidate),
  checksumPreflight: clonePatchChecksumPreflight(state.checksumPreflight),
  checksumTimeMs: state.checksumTimeMs,
  decompressionTimeMs: state.decompressionTimeMs,
  fileName: state.fileName,
  id: state.id,
  parentCompressions: parentCompressions.map((entry) => ({ ...entry })),
  patchValidation: clonePatchValidation(state.patchValidation),
  requirements: clonePatchRequirements(state.requirements),
  selectedCandidateId: state.selectedCandidateId,
  size: state.size,
  sourceSize: state.sourceSize,
  status: state.status,
  targetInputFileName: state.targetInputFileName,
  targetInputId: state.targetInputId,
  warnings: state.warnings.map(cloneWarning),
  wasDecompressed: state.wasDecompressed,
});

const cloneResolvedInputState = (
  state: InternalSourceState,
  parentCompressions: ApplyWorkflowParentCompression[],
  selected: boolean,
): ApplyWorkflowResolvedInput => ({
  checksums: state.checksums ? cloneValue(state.checksums) : undefined,
  checksumTimeMs: state.checksumTimeMs,
  decompressionTimeMs: state.decompressionTimeMs,
  fileName: state.fileName,
  groupId: (() => {
    const selectedCandidate = state.candidates.find(
      (candidate) => candidate.id === state.selectedCandidateId && "parentCandidateId" in candidate,
    );
    return selectedCandidate && "parentCandidateId" in selectedCandidate
      ? selectedCandidate.parentCandidateId || undefined
      : undefined;
  })(),
  id: state.id,
  order: state.order,
  parentCompressions: parentCompressions.map((entry) => ({ ...entry })),
  romProbe: cloneChecksumRomProbe(state.romProbe),
  selected,
  selectedCandidateId: state.selectedCandidateId,
  size: state.size,
  sourceSize: state.sourceSize,
  wasDecompressed: state.wasDecompressed,
});

const cloneResolvedInputAssetState = (
  asset: InputAsset,
  order: number,
  parentCompressions: ApplyWorkflowParentCompression[],
  selected: boolean,
  selectedCandidateId?: string,
): ApplyWorkflowResolvedInput => {
  const checksums = getInputAssetChecksums(asset);
  return {
    checksums: checksums ? cloneValue(checksums) : undefined,
    checksumTimeMs: asset.checksumTimeMs,
    decompressionTimeMs: getAssetDecompressionTimeMs(asset),
    fileName: asset.fileName,
    groupId: asset.groupId,
    id: asset.id,
    kind: asset.kind,
    order,
    parentCompressions: getAssetParentCompressions(asset, parentCompressions),
    patchable: asset.patchable,
    romProbe: cloneChecksumRomProbe(asset.romProbe),
    selected,
    selectedCandidateId,
    size: asset.size,
    sourceSize: getAssetSourceSize(asset),
    splitBinAvailable: asset.disc?.splitBinAvailable,
    wasDecompressed: asset.preparation?.wasDecompressed,
  };
};

const cloneResolvedInputStatesForStage = <TSource>(
  stage: StagedSource<TSource>,
  selectedStage: boolean,
): ApplyWorkflowResolvedInput[] => {
  const assets = stage.preparedInputAssets || [];
  if (!assets.length) return [cloneResolvedInputState(stage.state, stage.parentCompressions, selectedStage)];
  const primaryAsset = getPrimaryInputAsset(assets);
  return assets.map((asset, index) =>
    cloneResolvedInputAssetState(
      asset,
      index,
      stage.parentCompressions,
      selectedStage && asset.id === primaryAsset?.id,
      stage.state.selectedCandidateId,
    ),
  );
};

const createPatchOutputLabel = (fileName: string | undefined) => {
  const label = String(fileName || "")
    .match(PATCH_OUTPUT_LABEL_PATTERN)?.[1]
    ?.trim();
  return label || undefined;
};

const getCompressionExtension = (
  format: CompressionFormat,
  inputFileName: string | undefined,
  settings: Partial<ApplySettings>,
): string => getCompressionOutputExtension(format, { inputFileName, settings });

const resolveAutomaticFormat = (
  input: InputSession<unknown> | undefined,
  _settings: Partial<ApplySettings>,
): CompressionFormat => {
  const sourceName = input?.sources[0] ? getSourceFileName(input.sources[0], "input") : "";
  return resolveAutomaticCompressionFormat({
    parentCompressions: input?.view?.parentCompressions,
    sourceFileName: stripFileNameQuery(sourceName),
  });
};

const releasePreparedFile = (file?: PatchFileInstance) => {
  const cleanup = file ? getPatchFileCleanup(file) : undefined;
  if (cleanup) void Promise.resolve(cleanup()).catch(() => undefined);
};

const releasePreparedSource = (source?: StagedSource<unknown>) => {
  if (!source) return;
  for (const asset of source.preparedInputAssets || []) releasePreparedFile(asset.file);
  releasePreparedFile(source.preparedPatchFile);
  source.preparedInputAssets = undefined;
  source.preparedPatchFile = undefined;
  source.parsedPatch = undefined;
  source.state.requirements = undefined;
  source.state.checksumPreflight = undefined;
  source.state.patchValidation = undefined;
};

const releasePreparedFileAndWait = async (file?: PatchFileInstance) => {
  const cleanup = file ? getPatchFileCleanup(file) : undefined;
  if (cleanup) await Promise.resolve(cleanup()).catch(() => undefined);
};

const releasePreparedSourceAndWait = async (source?: StagedSource<unknown>) => {
  if (!source) return;
  await Promise.all((source.preparedInputAssets || []).map((asset) => releasePreparedFileAndWait(asset.file)));
  await releasePreparedFileAndWait(source.preparedPatchFile);
  source.preparedInputAssets = undefined;
  source.preparedPatchFile = undefined;
  source.parsedPatch = undefined;
  source.state.requirements = undefined;
  source.state.checksumPreflight = undefined;
  source.state.patchValidation = undefined;
};

const getPreparedAssetFileName = (asset: InputAsset | undefined, fallback?: string) =>
  getBaseFileName(asset?.file.fileName || asset?.fileName || fallback || "input.bin");

const canRecoverWithCandidateSelection = (error: unknown, requests: CandidateSelectionRequest[]) => {
  if (!requests.length) return false;
  const normalized = toRomWeaverError(error);
  if (normalized.code === "AMBIGUOUS_SELECTION") return true;
  return false;
};

class ApplyWorkflowController<TSource, TDestination> extends WorkflowController<{ progress: WorkflowProgress }> {
  readonly id: string;
  protected readonly runtime: WorkflowRuntime;
  protected readonly validateSources?: SourceValidator<TSource>;
  private readonly abortController = new AbortController();
  private readonly constructorSignal?: AbortSignal;
  private readonly selectFile?: WorkflowOptions<ApplySettings>["selectFile"];
  private readonly inputStages: StagedRomSourceController<TSource, InternalSourceState>;
  private disposed = false;
  private progressSequence = 0;
  private nextCandidateSequence = 0;
  private nextInputSequence = 0;
  private nextPatchSequence = 0;
  private manualOutputName = false;
  private manualOutputFormat = false;
  private outputName = "";
  private outputFormat: CompressionFormat = "7z";
  private settings: Partial<ApplySettings>;
  private inputSession?: InputSession<TSource>;
  private mutationQueue: Promise<void> | null = null;
  private patches: Array<StagedSource<TSource>> = [];
  private inputs: TSource[] = [];

  constructor(
    runtime: WorkflowRuntime,
    options: WorkflowOptions<ApplySettings> = {},
    validateSources?: SourceValidator<TSource>,
  ) {
    super();
    this.runtime = runtime;
    this.validateSources = validateSources;
    this.id = options.id || createWorkflowId();
    this.settings = cloneValue(options.settings || {});
    this.constructorSignal = options.signal;
    this.selectFile = options.selectFile;
    const initialCompression = this.settings.output?.compression;
    if (initialCompression && initialCompression !== "auto" && isCompressionFormat(initialCompression)) {
      this.manualOutputFormat = true;
      this.outputFormat = initialCompression;
    }
    if (typeof this.settings.output?.outputName === "string") {
      this.manualOutputName = true;
      this.outputName = this.settings.output.outputName;
    }
    if (!this.manualOutputFormat) this.outputFormat = resolveAutomaticFormat(undefined, this.settings);
    this.inputStages = new StagedRomSourceController<TSource, InternalSourceState>({
      clearRequestsWhenSinglePatchableAsset: true,
      emitProgress: (event) => this.emitProgress(event),
      getExecutionOptions: () => this.createExecutionOptions(),
      getPreparedFileName: getPreparedAssetFileName,
      getSessionId: () => "input-session",
      getSourceId: () => `input-${++this.nextInputSequence}`,
      id: this.id,
      releasePreparedOnSelection: "when-empty",
      runtime: this.runtime,
      selectFile: this.selectFile,
      trace: (message, details) => this.trace(message, details),
      workflow: "apply",
    });
    if (options.signal?.aborted) this.abortController.abort(options.signal.reason);
    else options.signal?.addEventListener("abort", () => this.abort(options.signal?.reason), { once: true });
  }

  getInput(): ApplyWorkflowInputState | null {
    const session = this.inputSession;
    if (!session) return null;
    const selectedOwner = this.getSelectedInputOwner();
    const resolvedInputs = session.synthetic
      ? session.stages
          .filter((stage) => stage.state.status === "ready")
          .flatMap((stage) => cloneResolvedInputStatesForStage(stage, stage === selectedOwner))
      : cloneResolvedInputStatesForStage(session.view, true);
    return cloneInputState(session.view.state, session.view.parentCompressions || [], resolvedInputs);
  }

  getPatches(): ApplyWorkflowPatchState[] {
    return this.patches.map((patch) => clonePatchState(patch.state, patch.parentCompressions));
  }

  async setInput(input: TSource | TSource[]): Promise<void> {
    return this.mutate("setInput", async () => {
      this.trace("input.set.start", {
        inputCount: Array.isArray(input) ? input.length : input ? 1 : 0,
      });
      try {
        await this.releaseInputSession();
        this.inputs = [];
        this.validateSources?.(input);
        this.inputs = Array.isArray(input) ? [...input] : [input];
        if (!this.inputs.length) throw new RomWeaverError("INVALID_INPUT", "Input source is required");
        const initial = this.createInitialInputView(this.inputs);
        this.inputSession = {
          role: "input",
          sources: this.inputs,
          stages: [],
          synthetic: false,
          view: initial,
        };
        this.trace("input.set.initialized", {
          fileName: initial.state.fileName,
          inputCount: this.inputs.length,
        });
        this.inputSession = await this.stageInputSession(this.inputs);
        this.trace("input.set.staged", {
          selectedCandidateId: this.inputSession.view.state.selectedCandidateId,
          stageCount: this.inputSession.stages.length,
          status: this.inputSession.view.state.status,
          synthetic: this.inputSession.synthetic,
        });
        await this.maybeResolveBlockingInputSelection();
        this.trace("input.set.selection-resolved", {
          selectedCandidateId: this.inputSession.view.state.selectedCandidateId,
          status: this.inputSession.view.state.status,
        });
        await this.finalizeInputStableState();
        this.trace("input.set.finalized", {
          hasChecksums: !!this.inputSession.view.state.checksums,
          status: this.inputSession.view.state.status,
        });
        await this.refreshPatchReadiness();
        this.recomputeOutputState();
        this.trace("input.set.finish", {
          status: this.inputSession.view.state.status,
        });
      } catch (error) {
        await this.releaseInputSession();
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
    const stage = this.createInitialSource("patch", patch, patchIndex);
    stage.outputLabel = createPatchOutputLabel(stage.state.fileName);
    this.patches.push(stage);
    const stagedPromise = this.stageSource(stage).catch((error) => {
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
        this.recomputeOutputState();
        throw error;
      }
    });
  }

  async clearPatches(): Promise<void> {
    return this.mutate("clearPatches", async () => {
      this.trace("patches.clear.start", {
        patchCount: this.patches.length,
      });
      await this.releasePatchSources();
      this.patches = [];
      this.recomputeOutputState();
      this.trace("patches.clear.finish");
    });
  }

  async setSettings(settings: Partial<ApplySettings>): Promise<void> {
    return this.mutate("setSettings", async () => {
      this.trace("settings.set.start", {
        hasInputSession: !!this.inputSession,
      });
      this.settings = cloneValue(settings || {});
      const output = this.settings.output || {};
      const initialCompression = output.compression;
      this.manualOutputFormat = !!(
        initialCompression &&
        initialCompression !== "auto" &&
        isCompressionFormat(initialCompression)
      );
      if (this.manualOutputFormat) {
        this.outputFormat = initialCompression as CompressionFormat;
      } else {
        this.outputFormat = resolveAutomaticFormat(
          this.inputSession as InputSession<unknown> | undefined,
          this.settings,
        );
      }
      this.manualOutputName = typeof output.outputName === "string" && !!output.outputName.trim();
      this.outputName = this.manualOutputName ? output.outputName || "" : "";
      this.preloadRuntimeCapability("compression");
      await this.refreshPatchReadiness();
      this.recomputeOutputState();
      this.trace("settings.set.finish", {
        outputFormat: this.outputFormat,
      });
    });
  }

  async setOutputName(name: string): Promise<void> {
    return this.mutate("setOutputName", async () => {
      const normalizedName = name.trim();
      this.manualOutputName = !!normalizedName;
      if (this.manualOutputName) {
        this.outputName = name;
        this.settings.output = {
          ...(this.settings.output || {}),
          outputName: name,
        };
      } else {
        if (this.settings.output) delete this.settings.output.outputName;
        this.recomputeOutputState();
      }
    });
  }

  async setOutputFormat(format: CompressionFormat): Promise<void> {
    return this.mutate("setOutputFormat", async () => {
      if (!isCompressionFormat(format))
        throw new RomWeaverError("INVALID_SETTINGS", `Unsupported output format: ${format}`);
      this.manualOutputFormat = true;
      this.outputFormat = format;
      this.settings.output = {
        ...(this.settings.output || {}),
        compression: format,
      };
      this.recomputeOutputState();
    });
  }

  async setPatchTarget(index: number, targetInputId: string | "auto"): Promise<void> {
    return this.mutate("setPatchTarget", async () => {
      const stage = this.patches[index];
      if (!stage) throw new RomWeaverError("INVALID_INPUT", `Patch ${index + 1} was not found`);
      if (targetInputId === "auto") {
        this.clearPatchTarget(stage);
        await this.evaluatePatchReadiness(stage);
        this.recomputeOutputState();
        return;
      }
      const target = this.getPatchableInputAssets().find(
        (asset) => asset.id === targetInputId || asset.fileName === targetInputId,
      );
      if (!target) throw new RomWeaverError("SELECTION_NOT_FOUND", `Patch target was not found: ${targetInputId}`);
      this.assignPatchTarget(stage, target);
      await this.evaluatePatchReadiness(stage);
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
      const outputName = this.outputName;
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
              label: progress.label || (stage === "compress" ? "Compressing output..." : "Applying patch..."),
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

  abort(reason?: unknown): void {
    if (!this.abortController.signal.aborted) this.abortController.abort(reason);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.abort();
    await this.releaseInputSession();
    await this.releasePatchSources();
    this.patches = [];
    this.clearListeners();
    this.disposed = true;
  }

  protected traceTriggerEvent(event: "progress", payload: WorkflowProgress, listenerCount: number): void {
    traceWorkflowControllerEvent(
      {
        logLevel: this.settings.logging?.level,
        onLog: this.settings.logging?.sink,
        workflow: "apply",
        workflowId: this.id,
      },
      "trigger",
      {
        event,
        listenerCount,
        payload,
      },
    );
  }

  private trace(message: string, details: Record<string, unknown> = {}): void {
    traceWorkflowControllerEvent(
      {
        logLevel: this.settings.logging?.level,
        onLog: this.settings.logging?.sink,
        workflow: "apply",
        workflowId: this.id,
      },
      message,
      details,
    );
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

  private emitProgress(event: {
    current?: number;
    details?: Record<string, unknown>;
    hasProgress?: boolean;
    id: string;
    label: string;
    percent?: number | null;
    role: WorkflowProgress["role"];
    stage: WorkflowProgress["stage"];
    total?: number;
    workflow: WorkflowProgress["workflow"];
  }) {
    this.trigger("progress", createWorkflowProgress(++this.progressSequence, event));
  }

  private async mutate<TValue>(_operation: string, callback: () => Promise<TValue>): Promise<TValue> {
    const execute = async () => {
      this.assertCanStartOperation();
      try {
        return await callback();
      } catch (error) {
        throw toRomWeaverError(error);
      }
    };
    const previousMutation = this.mutationQueue;
    const run = previousMutation ? previousMutation.catch(() => undefined).then(execute) : execute();
    const queued = run.then(
      () => undefined,
      () => undefined,
    );
    this.mutationQueue = queued;
    queued.finally(() => {
      if (this.mutationQueue === queued) this.mutationQueue = null;
    });
    return run;
  }

  private assertCanStartOperation(): void {
    if (this.disposed) throw new RomWeaverError("WORKFLOW_DISPOSED", "Workflow has been disposed");
    throwIfAborted(this.abortController.signal);
    throwIfAborted(this.constructorSignal);
  }

  private createInitialSource(
    role: SourceRole,
    source: TSource,
    index: number,
    options: { allowLazyBrowserRomSource?: boolean } = {},
  ): StagedSource<TSource> {
    const fileName = getSourceFileName(source, `${role}-${index + 1}`);
    const sourceSize = getSourceSize(source);
    return {
      allowLazyBrowserRomSource: options.allowLazyBrowserRomSource,
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
    const session = (await this.inputStages.stageSession("input", sources, {
      allowLazyBrowserRomSource: true,
    })) as InputSession<TSource>;
    this.inputSession = session;
    this.refreshPreparedInputMetadata(session);
    return session;
  }

  private async stageSource(stage: StagedSource<TSource>): Promise<StagedSource<TSource>> {
    if (stage.state.role === "input") {
      const staged = (await this.inputStages.stageSource(stage)) as StagedSource<TSource>;
      this.refreshPreparedInputMetadataForStage(staged);
      return staged;
    }
    this.trace("source.stage.start", {
      allowLazyBrowserRomSource: !!stage.allowLazyBrowserRomSource,
      fileName: stage.state.fileName,
      order: stage.state.order,
      role: stage.state.role,
      sourceSize: stage.state.sourceSize,
    });
    const requests: CandidateSelectionRequest[] = [];
    const options = {
      ...this.createExecutionOptions(),
      onCandidatesFound: (request: CandidateSelectionRequest) => requests.push(request),
      onProgress: (progress: {
        current?: number;
        details?: unknown;
        hasProgress?: boolean;
        label?: string;
        message?: string;
        percent?: number | null;
        total?: number;
      }) => {
        const progressStage = getPreparationProgressStage(progress, stage.state.role);
        this.emitProgress({
          current: progress.current,
          details: {
            ...(isRecord(progress.details) ? progress.details : {}),
            fileName: stage.state.fileName,
            order: stage.state.order,
            sourceId: stage.state.id,
          },
          hasProgress: progress.hasProgress,
          id: `${this.id}:${stage.state.id}:${progressStage}`,
          label: progress.label || progress.message || "Preparing input...",
          percent: typeof progress.percent === "number" && Number.isFinite(progress.percent) ? progress.percent : null,
          role: stage.state.role,
          stage: progressStage,
          total: progress.total,
          workflow: "apply",
        });
      },
    } satisfies Partial<ApplyWorkflowOptions>;
    try {
      this.trace("source.stage.prepare-patch.start", {
        fileName: stage.state.fileName,
        order: stage.state.order,
      });
      const prepared = await prepareInputFile(
        stage.source as never,
        "patch",
        options as never,
        this.runtime,
        undefined,
        stage.index,
      );
      stage.preparedPatchFile = prepared.file;
      this.applyPreparedPatchMetadata(stage, prepared);
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
    if (!stage.state.candidates.length)
      this.addDirectCandidate(
        stage,
        stage.state.role,
        stage.index,
        stage.state.role === "patch" ? stage.state.id : stage.state.id,
      );
    const selectable = stage.state.candidates.filter((candidate) => candidate.selectable);
    if (selectable.length === 1) {
      stage.state.selectedCandidateId = selectable[0]?.id;
      stage.selectedArchiveEntry = stage.internalCandidates.get(selectable[0]?.id || "")?.archiveEntry;
      this.trace("source.stage.prepare-selected.start", {
        fileName: stage.state.fileName,
        order: stage.state.order,
        selectedCandidateId: stage.state.selectedCandidateId,
      });
      await this.prepareSelectedSource(stage);
      this.trace("source.stage.prepare-selected.finish", {
        fileName: stage.state.fileName,
        order: stage.state.order,
        status: stage.state.status,
      });
      await this.parsePatch(stage);
    } else {
      stage.state.status = "needsSelection";
      await this.maybeResolveBlockingPatchSelection(stage);
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

  private async prepareSelectedSource(stage: StagedSource<TSource>): Promise<void> {
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
    const options = {
      ...this.createExecutionOptions(),
      onCandidatesFound: (request: CandidateSelectionRequest) => requests.push(request),
      onProgress: (progress: {
        current?: number;
        details?: unknown;
        hasProgress?: boolean;
        label?: string;
        message?: string;
        percent?: number | null;
        total?: number;
      }) => {
        const progressStage = getPreparationProgressStage(progress, stage.state.role);
        this.emitProgress({
          current: progress.current,
          details: {
            ...(isRecord(progress.details) ? progress.details : {}),
            fileName: stage.state.fileName,
            order: stage.state.order,
            sourceId: stage.state.id,
          },
          hasProgress: progress.hasProgress,
          id: `${this.id}:${stage.state.id}:${progressStage}`,
          label: progress.label || progress.message || "Preparing input...",
          percent: typeof progress.percent === "number" && Number.isFinite(progress.percent) ? progress.percent : null,
          role: stage.state.role,
          stage: progressStage,
          total: progress.total,
          workflow: "apply",
        });
      },
    } satisfies Partial<ApplyWorkflowOptions>;
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
      this.applyPreparedPatchMetadata(stage, prepared);
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
        await this.maybeResolveBlockingPatchSelection(stage);
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

  private async maybeResolveBlockingPatchSelection(stage: StagedSource<TSource>): Promise<boolean> {
    if (!(stage.state.status === "needsSelection" && !stage.state.selectedCandidateId && stage.state.candidates.length))
      return false;
    const selection = await this.resolveSelectionRequest(this.createSelectionRequest(stage.state), this.selectFile);
    if (!selection) return false;
    if (!stage.internalCandidates.has(selection.id))
      throw new RomWeaverError("SELECTION_NOT_FOUND", `Selection candidate was not found: ${selection.id}`);
    releasePreparedSource(stage);
    stage.state.selectedCandidateId = selection.id;
    stage.selectedArchiveEntry = stage.internalCandidates.get(selection.id)?.archiveEntry;
    await this.prepareSelectedSource(stage);
    return true;
  }

  private applyPreparedInputMetadata(stage: StagedSource<TSource>) {
    const assets = stage.preparedInputAssets || [];
    const preparation = getInputPreparationMetrics(assets);
    stage.parentCompressions = this.normalizeParentCompressions(preparation?.parentCompressions);
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
  }

  private refreshPreparedInputMetadataForStage(stage: StagedSource<TSource> | undefined) {
    if (!(stage && stage.state.role === "input" && stage.preparedInputAssets?.length)) return;
    this.applyPreparedInputMetadata(stage);
  }

  private refreshPreparedInputMetadata(session: InputSession<TSource> | undefined) {
    if (!session) return;
    for (const stage of session.stages) this.refreshPreparedInputMetadataForStage(stage as StagedSource<TSource>);
    if (!session.stages.includes(session.view)) this.refreshPreparedInputMetadataForStage(session.view);
    if (session.synthetic) this.syncInputSessionView();
  }

  private applyPreparedPatchMetadata(
    stage: StagedSource<TSource>,
    prepared: Awaited<ReturnType<typeof prepareInputFile>>,
  ) {
    stage.parentCompressions = this.normalizeParentCompressions(prepared.parentCompressions);
    stage.state.fileName = getBaseFileName(prepared.file.fileName || stage.state.fileName || stage.state.id);
    stage.state.size = prepared.file.fileSize;
    stage.state.sourceSize = prepared.sourceSize || prepared.file.fileSize;
    stage.state.decompressionTimeMs = prepared.wasDecompressed ? prepared.decompressionTimeMs : undefined;
    stage.state.wasDecompressed = prepared.wasDecompressed;
  }

  private normalizeParentCompressions(
    parentCompressions: InputParentCompression[] | undefined,
  ): ApplyWorkflowParentCompression[] {
    return (parentCompressions || []).map((entry) => ({
      decompressionTimeMs: entry.decompressionTimeMs,
      depth: entry.depth,
      fileName: entry.fileName,
      kind: entry.kind,
      outputSize: entry.outputSize,
      sourceSize: entry.sourceSize,
    }));
  }

  private async parsePatch(stage: StagedSource<TSource>): Promise<void> {
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
          : {
              ...(publicCandidate.parentCandidateId
                ? {
                    parentCandidateId: publicIdByCandidateId.get(publicCandidate.parentCandidateId),
                  }
                : {}),
            }),
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
  }

  private getSelectedInputOwner(): StagedSource<TSource> | undefined {
    return this.inputStages.getSelectedOwner(this.inputSession) as StagedSource<TSource> | undefined;
  }

  private async finalizeInputStableState(): Promise<boolean> {
    const session = this.inputSession;
    const selected = this.getSelectedInputOwner();
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
          asset.checksumTimeMs = 0;
          continue;
        }
        const checksumFileName = getPreparedAssetFileName(asset, stage.state.fileName);
        const checksumStartedAt = Date.now();
        const checksumResult = await calculateStandardInputChecksumsForFile({
          emitProgress: (event) => this.emitProgress(event),
          file: asset.file,
          logLevel: this.settings.logging?.level,
          onLog: this.settings.logging?.sink,
          progressId: session.synthetic
            ? `${this.id}:${stage.state.id}:${index}:${assetIndex}`
            : `${this.id}:${stage.state.id}:${assetIndex}`,
          role: "input",
          runtime: this.runtime,
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
        asset.romProbe = checksumResult.romProbe;
        asset.checksumTimeMs = Date.now() - checksumStartedAt;
      }
      const primaryAsset = getPrimaryInputAsset(assets);
      const primaryChecksums = getInputAssetChecksums(primaryAsset);
      if (primaryChecksums) {
        stage.state.checksums = primaryChecksums;
        stage.state.checksumTimeMs = primaryAsset?.checksumTimeMs;
        stage.state.romProbe = cloneChecksumRomProbe(primaryAsset?.romProbe);
      }
    }
    if (session.synthetic) this.syncInputSessionView();
    return !!(selected && session.view.state.status === "ready" && selected.preparedInputAssets?.[0]?.file);
  }

  private getPreparedInputAssets(): InputAsset[] {
    return this.inputSession?.view.preparedInputAssets ? [...this.inputSession.view.preparedInputAssets] : [];
  }

  private getPatchableInputAssets(): InputAsset[] {
    return this.getPreparedInputAssets().filter((asset) => asset.patchable);
  }

  private clearPatchTarget(stage: StagedSource<TSource>) {
    stage.state.checksumTimeMs = undefined;
    stage.state.targetInputId = undefined;
    stage.state.targetInputFileName = undefined;
    stage.state.checksumPreflight = undefined;
    stage.state.patchValidation = undefined;
  }

  private assignPatchTarget(stage: StagedSource<TSource>, target: InputAsset) {
    stage.state.targetInputId = target.id;
    stage.state.targetInputFileName = target.fileName;
  }

  private createPatchChecksumPreflight(
    stage: StagedSource<TSource>,
    target: InputAsset,
  ): InternalPatchChecksumPreflight {
    const requirements = stage.state.requirements;
    const actualSize = typeof target.size === "number" && Number.isFinite(target.size) ? target.size : undefined;
    const actualCrc32 = toNormalizedCrc32(getInputAssetChecksums(target)?.crc32);
    const requiredSize =
      typeof requirements?.sourceSize === "number" && Number.isFinite(requirements.sourceSize)
        ? requirements.sourceSize
        : undefined;
    const minimumSourceSize =
      typeof requirements?.minimumSourceSize === "number" && Number.isFinite(requirements.minimumSourceSize)
        ? requirements.minimumSourceSize
        : undefined;
    const requiredCrc32 = toNormalizedCrc32(requirements?.sourceCrc32);
    if (requiredSize === undefined && minimumSourceSize === undefined && !requiredCrc32) {
      return {
        actualCrc32,
        actualSize,
        status: "unknown",
      };
    }
    const sizeMismatch = requiredSize !== undefined && actualSize !== undefined && actualSize !== requiredSize;
    const minimumSizeMismatch =
      minimumSourceSize !== undefined && actualSize !== undefined && actualSize < minimumSourceSize;
    const crcMismatch = !!(requiredCrc32 && actualCrc32 && actualCrc32 !== requiredCrc32);
    if (sizeMismatch || minimumSizeMismatch || crcMismatch) {
      const hasSizeMismatch = sizeMismatch || minimumSizeMismatch;
      const mismatchReason = hasSizeMismatch && crcMismatch ? "size+crc32" : hasSizeMismatch ? "size" : "crc32";
      return {
        actualCrc32,
        actualSize,
        minimumSourceSize,
        mismatchReason,
        requiredCrc32,
        requiredSize,
        status: "invalid",
      };
    }
    const missingActual =
      ((requiredSize !== undefined || minimumSourceSize !== undefined) && actualSize === undefined) ||
      (requiredCrc32 && !actualCrc32);
    if (missingActual) {
      return {
        actualCrc32,
        actualSize,
        minimumSourceSize,
        requiredCrc32,
        requiredSize,
        status: "pending",
      };
    }
    return {
      actualCrc32,
      actualSize,
      minimumSourceSize,
      requiredCrc32,
      requiredSize,
      status: "valid",
    };
  }

  private createPatchValidationKey(
    stage: StagedSource<TSource>,
    target: InputAsset,
    preflight: InternalPatchChecksumPreflight,
  ): string {
    return JSON.stringify({
      patch: {
        fileName: stage.preparedPatchFile?.fileName || stage.state.fileName,
        size: stage.preparedPatchFile?.fileSize ?? stage.state.size,
      },
      preflight: {
        actualCrc32: preflight.actualCrc32,
        actualSize: preflight.actualSize,
        minimumSourceSize: preflight.minimumSourceSize,
        requiredCrc32: preflight.requiredCrc32,
        requiredSize: preflight.requiredSize,
      },
      requirements: stage.state.requirements || null,
      target: {
        fileName: target.fileName,
        id: target.id,
        size: target.size,
      },
    });
  }

  private async validatePatchTarget(
    stage: StagedSource<TSource>,
    target: InputAsset,
    preflight: InternalPatchChecksumPreflight,
  ): Promise<void> {
    const validationKey = this.createPatchValidationKey(stage, target, preflight);
    const existingValidation = stage.state.patchValidation;
    if (
      existingValidation?.validationKey === validationKey &&
      (existingValidation.status === "valid" || existingValidation.status === "invalid")
    ) {
      return;
    }
    const validationStartedAt = Date.now();
    const validatePatch = this.runtime.patch.validatePatch;
    const patchFile = stage.preparedPatchFile;
    if (!(validatePatch && patchFile && stage.parsedPatch)) {
      stage.state.patchValidation =
        preflight.status === "invalid"
          ? {
              message: "Patch source requirements failed",
              status: "invalid",
              targetInputId: target.id,
              validationKey,
            }
          : undefined;
      stage.state.checksumTimeMs = Date.now() - validationStartedAt;
      return;
    }
    const patchSource = getPatchFileExternalSource(
      patchFile,
      patchFile.fileName || stage.state.fileName || "patch.bin",
    );
    const inputSource = getPatchFileExternalSource(target.file, target.fileName || "input.bin");
    if (!(patchSource && inputSource)) {
      stage.state.patchValidation = {
        message:
          preflight.status === "invalid"
            ? "Patch source requirements failed"
            : "Patch validation is unavailable for this source",
        status: preflight.status === "invalid" ? "invalid" : "unknown",
        targetInputId: target.id,
        validationKey,
      };
      stage.state.checksumTimeMs = Date.now() - validationStartedAt;
      return;
    }

    stage.state.patchValidation = {
      message: "Validating patch against selected target",
      status: "pending",
      targetInputId: target.id,
      validationKey,
    };
    try {
      const result = await validatePatch({
        input: inputSource as never,
        logLevel: this.settings.logging?.level,
        onLog: this.settings.logging?.sink,
        onProgress: (progress) =>
          this.emitProgress({
            details: {
              fileName: stage.state.fileName,
              order: stage.state.order,
              sourceId: stage.state.id,
              targetInputId: target.id,
              targetInputName: target.fileName,
            },
            id: `${this.id}:${stage.state.id}:patch-validate`,
            label: String(progress.label || progress.message || "Validating patch..."),
            percent:
              typeof progress.percent === "number" && Number.isFinite(progress.percent) ? progress.percent : null,
            role: "patch",
            stage: "verify",
            workflow: "apply",
          }),
        options: {
          checksumCache: getInputAssetChecksums(target),
          removeHeader: !!this.settings.compatibility?.removeHeader,
          workerThreads: this.settings.workers?.threads,
        },
        patches: [
          {
            patchFile: patchSource as never,
            patchFileName: patchFile.fileName || stage.state.fileName || "patch.bin",
            patchFormat: stage.state.requirements?.format,
            requirements: stage.state.requirements,
          },
        ],
      });
      stage.state.patchValidation = {
        message: result.message || "Patch validation passed",
        status: "valid",
        targetInputId: target.id,
        validationKey,
      };
      stage.state.checksumTimeMs = Date.now() - validationStartedAt;
    } catch (error) {
      stage.state.patchValidation = {
        message: toRomWeaverError(error).message,
        status: "invalid",
        targetInputId: target.id,
        validationKey,
      };
      stage.state.checksumTimeMs = Date.now() - validationStartedAt;
    }
  }

  private async resolvePatchTargetForStage(
    stage: StagedSource<TSource>,
    assets: InputAsset[],
  ): Promise<InputAsset | null> {
    if (!assets.length) {
      this.clearPatchTarget(stage);
      return null;
    }
    if (assets.length === 1) {
      const [target] = assets;
      if (!target) return null;
      this.assignPatchTarget(stage, target);
      return target;
    }
    if (stage.state.targetInputId) {
      const existing = assets.find(
        (asset) => asset.id === stage.state.targetInputId || asset.fileName === stage.state.targetInputId,
      );
      if (existing) {
        this.assignPatchTarget(stage, existing);
        return existing;
      }
    }
    this.clearPatchTarget(stage);
    return null;
  }

  private async evaluatePatchReadiness(stage: StagedSource<TSource>): Promise<boolean> {
    const previousStatus = stage.state.status;
    stage.state.warnings = stage.state.warnings.filter(
      (warning) => !PATCH_TARGET_SELECTION_ERROR_CODES.has(String(warning.code || "")),
    );
    if (stage.state.status === "loading" && !stage.preparedPatchFile && !stage.state.candidates.length) return false;
    if (!stage.state.selectedCandidateId) {
      this.clearPatchTarget(stage);
      stage.state.status = "needsSelection";
      return previousStatus !== stage.state.status;
    }
    if (!stage.preparedPatchFile) await this.prepareSelectedSource(stage);
    if (!stage.parsedPatch) await this.parsePatch(stage);
    const assets = this.getPatchableInputAssets();
    if (!(assets.length && stage.parsedPatch)) {
      this.clearPatchTarget(stage);
      stage.state.status = "needsSelection";
      return previousStatus !== stage.state.status;
    }
    try {
      const target = await this.resolvePatchTargetForStage(stage, assets);
      stage.state.status = target ? "ready" : "needsSelection";
      const preflight = target ? this.createPatchChecksumPreflight(stage, target) : undefined;
      stage.state.checksumPreflight = preflight;
      if (target && preflight) await this.validatePatchTarget(stage, target, preflight);
      else stage.state.patchValidation = undefined;
      if (!target) {
        this.pushWarning(
          stage,
          new RomWeaverError("AMBIGUOUS_SELECTION", `${stage.state.fileName || "Patch"} target selection is required`),
        );
      }
    } catch (error) {
      const normalized = toRomWeaverError(error);
      if (normalized.code === "AMBIGUOUS_SELECTION" || normalized.code === "PATCH_TARGET_MISMATCH") {
        this.clearPatchTarget(stage);
        stage.state.status = "needsSelection";
        this.pushWarning(stage, normalized);
      } else {
        throw normalized;
      }
    }
    return previousStatus !== stage.state.status;
  }

  private async refreshPatchReadiness() {
    for (const patch of this.patches) await this.evaluatePatchReadiness(patch);
  }

  private recomputeOutputState() {
    if (!this.manualOutputFormat)
      this.outputFormat = resolveAutomaticFormat(this.inputSession as InputSession<unknown> | undefined, this.settings);
    if (!this.manualOutputName) this.outputName = this.buildAutomaticOutputName();
  }

  private buildAutomaticOutputName() {
    const input = this.getInput();
    if (!input?.fileName) return this.outputName;
    const inputName = input.fileName;
    const inputBase = getFileNameWithoutExtension(inputName) || "patched";
    const patchNames = this.patches
      .map((patch, index) => getFileNameWithoutExtension(this.resolvePatchOutputName(patch, index)))
      .filter(Boolean);
    return buildPatchedOutputBaseName(inputBase, patchNames);
  }

  private resolvePatchOutputName(patch: StagedSource<TSource>, index: number): string {
    if (patch.state.selectedCandidateId) {
      const selectedCandidate = patch.state.candidates.find(
        (candidate) => candidate.id === patch.state.selectedCandidateId,
      );
      if (selectedCandidate?.type === "file" && selectedCandidate.fileName) return selectedCandidate.fileName;
    }
    if (patch.state.status === "needsSelection" && !patch.state.selectedCandidateId) {
      const selectableGroups = patch.state.candidates.filter(
        (candidate) => candidate.type === "group" && candidate.selectable,
      );
      const selectableGroupIds = new Set(selectableGroups.map((candidate) => candidate.id));
      const selectablePatches = patch.state.candidates.filter(
        (candidate): candidate is SelectionFileCandidate =>
          candidate.type === "file" &&
          candidate.kind === "patch" &&
          candidate.selectable &&
          !selectableGroupIds.has(candidate.parentCandidateId || ""),
      );
      if (selectablePatches.length === 1 && selectablePatches[0]?.fileName) return selectablePatches[0].fileName;
    }
    return patch.state.fileName || patch.outputLabel || `patch ${index + 1}`;
  }

  private getExecutionOutputName() {
    const outputName = this.outputName || this.settings.output?.outputName || "";
    if (this.manualOutputName || !outputName) return outputName;
    if (this.outputFormat === "none") {
      const extension = getCompressionExtension(this.outputFormat, this.getInput()?.fileName, this.settings);
      return extension ? appendFileNameExtension(outputName, extension) : outputName;
    }
    const outputExtension = getFileNameExtension(stripFileNameQuery(outputName));
    const compressionExtension = getCompressionExtension(
      this.outputFormat,
      this.getInput()?.fileName,
      this.settings,
    ).toLowerCase();
    if (outputExtension && compressionExtension && outputExtension === compressionExtension) {
      return getFileNameWithoutExtension(outputName) || outputName;
    }
    return outputName;
  }

  private createExecutionOptions(onProgress?: ApplyWorkflowOptions["onProgress"]): ApplyWorkflowOptions {
    const output = this.settings.output || {};
    return {
      compatibility: cloneValue(this.settings.compatibility || {}),
      input: cloneValue(this.settings.input || {}),
      limits: cloneValue(this.settings.limits || {}),
      logging: cloneValue(this.settings.logging || {}),
      onLog: this.settings.logging?.sink,
      onProgress,
      output: {
        ...cloneValue(output),
        compression: this.outputFormat,
        outputName: this.getExecutionOutputName() || output.outputName,
      },
      validation: cloneValue(this.settings.validation || {}),
      workers: cloneValue(this.settings.workers || {}),
    };
  }

  private createPatchInput(onProgress?: ApplyWorkflowOptions["onProgress"]): PatchInput {
    return {
      inputs: this.inputs as never,
      options: this.createExecutionOptions(onProgress),
      parsedPatches: this.patches.map((patch) => patch.parsedPatch).filter(Boolean) as ParsedPatchLike[],
      patches: this.patches.map((patch) => patch.source) as never,
      patchTargets: this.patches.map((patch) => patch.state.targetInputId || "auto"),
      preparedInputAssets: this.getPreparedInputAssets(),
      preparedPatchFiles: this.patches.map((patch) => patch.preparedPatchFile).filter(Boolean) as PatchFileInstance[],
    };
  }

  private pushWarning(
    stage: StagedSource<TSource>,
    error: Error & { code?: string; details?: Record<string, unknown> },
  ) {
    const warning: WorkflowWarning = {
      code: error.code,
      details: error.details,
      message: error.message,
      role: stage.state.role,
    };
    stage.state.warnings.push(warning);
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

  private async releasePatchSources(): Promise<void> {
    const sources = this.patches.flatMap((patch) => [patch.source, ...this.getRuntimeSourcesForStage(patch)]);
    await Promise.all(this.patches.map((patch) => releasePreparedSourceAndWait(patch)));
    await this.releaseRuntimeSources(sources);
  }

  private async releaseInputSession() {
    const session = this.inputSession;
    this.inputSession = undefined;
    await this.inputStages.releaseSession(session);
  }
}

export type { ApplyWorkflowInputState, ApplyWorkflowPatchState };
export { ApplyWorkflowController };
