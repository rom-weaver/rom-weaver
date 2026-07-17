import type { WorkflowProgress } from "../../types/progress.ts";
import type { ApplySettings } from "../../types/settings.ts";
import type { PatchValidatePerPatchVerdict, WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { toRomWeaverError } from "../errors.ts";
import { getPatchFileExternalSource } from "../input/binary-service.ts";
import type { InputAsset } from "../input/input-assets.ts";
import { createApplyPatchValidationKey } from "./apply-patch-readiness-state-machine.ts";
import type { InternalPatchChecksumPreflight, StagedSource } from "./apply-workflow-state.ts";
import { getInputAssetChecksums } from "./staged-source-checksums.ts";

// An aborted or transient worker failure is not a verdict on the patch. Caching one as a terminal
// "invalid" (keyed on the stable inputs) would pin the poisoned result forever, because the
// short-circuit in validateApplyPatchTarget only skips re-validation for terminal statuses. Treat
// these as a retryable "unknown" so the next readiness pass re-validates.
const TRANSIENT_VALIDATION_ERROR_CODES = new Set(["CANCELLED", "WORKER_FAILED", "WORKER_UNAVAILABLE"]);

type PatchTargetValidationAdapters = {
  emitProgress: (event: {
    details?: Record<string, unknown>;
    id: string;
    label: string;
    percent?: number | null;
    role: WorkflowProgress["role"];
    stage: WorkflowProgress["stage"];
    workflow: WorkflowProgress["workflow"];
  }) => void;
  runtime: WorkflowRuntime;
  settings: Partial<ApplySettings>;
  signal: AbortSignal;
  workflowId: string;
};

type PatchTargetValidationEntry<TSource> = {
  preflight: InternalPatchChecksumPreflight;
  stage: StagedSource<TSource>;
  target: InputAsset;
};

const isHeaderRemoved = <TSource>(stage: StagedSource<TSource>, settings: Partial<ApplySettings>): boolean =>
  !!settings.compatibility?.removeHeader ||
  (stage.state.headerChoice ?? (stage.state.headerResolution?.decided ? stage.state.headerResolution.mode : "keep")) ===
    "strip";

const getStageChecksumCache = <TSource>(stage: StagedSource<TSource>, target: InputAsset, headerRemoved: boolean) =>
  headerRemoved ? stage.state.headerResolution?.headerlessChecksums : getInputAssetChecksums(target);

// Write a resolved verdict onto a stage. A cancelled/transient failure is not a "patch does not
// apply" verdict; storing it as terminal "invalid" against the stable validationKey would make the
// short-circuit reuse it forever, so those become a non-terminal "unknown" that is retried.
const applyPatchVerdict = <TSource>(
  stage: StagedSource<TSource>,
  target: InputAsset,
  validationKey: string,
  startedAt: number,
  verdict: { message: string; status: "valid" | "invalid" | "unknown" },
) => {
  stage.state.patchValidation = {
    message: verdict.message,
    status: verdict.status,
    targetInputId: target.id,
    validationKey,
  };
  stage.state.checksumTimeMs = Date.now() - startedAt;
};

// A prepared, runnable validation entry: the stage/target plus its resolved sources and the shared
// per-input options. `null` means the entry resolved to a terminal state (short-circuited cache hit,
// or an "unavailable" verdict) and needs no worker call.
type PreparedValidation<TSource> = {
  entry: PatchTargetValidationEntry<TSource>;
  headerRemoved: boolean;
  inputSource: unknown;
  patchFile: NonNullable<StagedSource<TSource>["preparedPatchFile"]>;
  patchSource: unknown;
  startedAt: number;
  validationKey: string;
};

const prepareValidation = <TSource>(
  entry: PatchTargetValidationEntry<TSource>,
  adapters: PatchTargetValidationAdapters,
): PreparedValidation<TSource> | null => {
  const { stage, target, preflight } = entry;
  const validationKey = createApplyPatchValidationKey(stage, target, preflight);
  const existingValidation = stage.state.patchValidation;
  if (
    existingValidation?.validationKey === validationKey &&
    (existingValidation.status === "valid" || existingValidation.status === "invalid")
  ) {
    return null;
  }
  const startedAt = Date.now();
  const validatePatch = adapters.runtime.patch.validatePatch;
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
    stage.state.checksumTimeMs = Date.now() - startedAt;
    return null;
  }
  const patchSource = getPatchFileExternalSource(patchFile, patchFile.fileName || stage.state.fileName || "patch.bin");
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
    stage.state.checksumTimeMs = Date.now() - startedAt;
    return null;
  }
  stage.state.patchValidation = {
    message: "Validating patch against selected target",
    status: "pending",
    targetInputId: target.id,
    validationKey,
  };
  return {
    entry,
    headerRemoved: isHeaderRemoved(stage, adapters.settings),
    inputSource,
    patchFile,
    patchSource,
    startedAt,
    validationKey,
  };
};

// Group runnable validations that share one input mount + option set (target + header decision +
// worker threads), so each group runs as a single independent-mode batched worker call instead of
// one cold-boot per patch.
const groupKeyFor = <TSource>(prepared: PreparedValidation<TSource>, settings: Partial<ApplySettings>): string =>
  JSON.stringify({
    headerRemoved: prepared.headerRemoved,
    sourcePath: (prepared.entry.target.file as { filePath?: string } | undefined)?.filePath,
    targetId: prepared.entry.target.id,
    workerThreads: settings.workers?.threads ?? null,
  });

const validatePreparedGroup = async <TSource>(
  prepared: PreparedValidation<TSource>[],
  adapters: PatchTargetValidationAdapters,
): Promise<void> => {
  const first = prepared[0];
  if (!first) return;
  const validatePatch = adapters.runtime.patch.validatePatch;
  if (!validatePatch) return;

  const progressTargets = prepared.map(({ entry }) => ({
    details: {
      fileName: entry.stage.state.fileName,
      order: entry.stage.state.order,
      sourceId: entry.stage.state.id,
      targetInputId: entry.target.id,
      targetInputName: entry.target.fileName,
    },
    id: `${adapters.workflowId}:${entry.stage.state.id}:patch-validate`,
  }));
  // Most patch formats validate via a dry-run apply that reports no incremental percent (only 100%
  // at completion), so start indeterminate and only switch to a determinate bar once real forward
  // progress (> 0%) arrives (e.g. BPS). One shared worker call feeds every patch in the group, so
  // its progress is broadcast to each stage's row.
  const emitToAll = (label: string, percent: number | null) => {
    for (const progressTarget of progressTargets) {
      adapters.emitProgress({
        details: progressTarget.details,
        id: progressTarget.id,
        label,
        percent,
        role: "patch",
        stage: "verify",
        workflow: "apply",
      });
    }
  };
  emitToAll("Validating patch against selected target", null);

  try {
    const result = await validatePatch({
      input: first.inputSource as never,
      logLevel: adapters.settings.logging?.level,
      onLog: adapters.settings.logging?.sink,
      onProgress: (progress) =>
        emitToAll(
          String(progress.label || progress.message || "Validating patch..."),
          typeof progress.percent === "number" && Number.isFinite(progress.percent) && progress.percent > 0
            ? progress.percent
            : null,
        ),
      options: {
        // The effective header decision (drawer choice, else checksum-proven auto) must reach the
        // dry-run too: a headerless-targeting patch validates against the stripped bytes - strip in
        // the engine and cache the headerless checksums, not the raw file's. All grouped patches
        // share the same target + header decision, so one cache/mode applies to the whole batch.
        checksumCache: getStageChecksumCache(first.entry.stage, first.entry.target, first.headerRemoved),
        independent: true,
        removeHeader: first.headerRemoved,
        workerThreads: adapters.settings.workers?.threads,
      },
      patches: prepared.map(({ entry, patchFile, patchSource }) => ({
        patchFile: patchSource as never,
        patchFileName: patchFile.fileName || entry.stage.state.fileName || "patch.bin",
        patchFormat: entry.stage.state.requirements?.format,
        requirements: entry.stage.state.requirements,
      })),
      signal: adapters.signal,
    });
    const perPatch = new Map<number, PatchValidatePerPatchVerdict>();
    for (const verdict of result.perPatch || []) perPatch.set(verdict.index, verdict);
    for (const [index, { entry, startedAt, validationKey }] of prepared.entries()) {
      const verdict = perPatch.get(index);
      if (verdict) {
        applyPatchVerdict(entry.stage, entry.target, validationKey, startedAt, {
          message:
            verdict.message ||
            (verdict.status === "passed" ? "Patch validation passed" : "Patch cannot be woven into this ROM"),
          status: verdict.status === "passed" ? "valid" : "invalid",
        });
        continue;
      }
      // No index-aligned verdict (a non-independent runtime, or a mock): a resolved call means the
      // batch passed, so mark valid - unless the aggregate is explicitly "mixed" and this patch's
      // fate is genuinely unknown.
      applyPatchVerdict(entry.stage, entry.target, validationKey, startedAt, {
        message: result.message || "Patch validation passed",
        status: result.status === "mixed" ? "unknown" : "valid",
      });
    }
  } catch (error) {
    const normalized = toRomWeaverError(error);
    // A cancelled run or transient worker failure marks the WHOLE batch retryable "unknown"; a real
    // non-transient failure (e.g. the shared input mismatches its requirements) fails every grouped
    // patch as "invalid" - they all target the same input.
    const transient = adapters.signal.aborted || TRANSIENT_VALIDATION_ERROR_CODES.has(normalized.code);
    for (const { entry, startedAt, validationKey } of prepared) {
      applyPatchVerdict(entry.stage, entry.target, validationKey, startedAt, {
        message: normalized.message,
        status: transient ? "unknown" : "invalid",
      });
    }
  }
};

// Validate a batch of staged patches. Entries sharing an input mount + option set run as ONE
// independent-mode worker call (one runner, one input mount); distinct groups run concurrently. A
// single failing patch never fails the others - the engine reports a per-patch verdict.
const validateApplyPatchTargets = async <TSource>(
  entries: PatchTargetValidationEntry<TSource>[],
  adapters: PatchTargetValidationAdapters,
): Promise<void> => {
  const groups = new Map<string, PreparedValidation<TSource>[]>();
  for (const entry of entries) {
    const prepared = prepareValidation(entry, adapters);
    if (!prepared) continue;
    const key = groupKeyFor(prepared, adapters.settings);
    const bucket = groups.get(key);
    if (bucket) bucket.push(prepared);
    else groups.set(key, [prepared]);
  }
  await Promise.all(Array.from(groups.values()).map((group) => validatePreparedGroup(group, adapters)));
};

const validateApplyPatchTarget = async <TSource>(
  stage: StagedSource<TSource>,
  target: InputAsset,
  preflight: InternalPatchChecksumPreflight,
  adapters: PatchTargetValidationAdapters,
): Promise<void> => validateApplyPatchTargets([{ preflight, stage, target }], adapters);

export type { PatchTargetValidationAdapters };
export { validateApplyPatchTarget, validateApplyPatchTargets };
