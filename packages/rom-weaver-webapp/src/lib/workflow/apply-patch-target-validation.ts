import type { WorkflowProgress } from "../../types/progress.ts";
import type { ApplySettings } from "../../types/settings.ts";
import type {
  PatchValidatePerPatchVerdict,
  PatchValidateResult,
  WorkflowRuntime,
} from "../../types/workflow-runtime-adapter.ts";
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
  /** Receives each target chain's verification plan as its batched call resolves. */
  onChainPlan?: (targetId: string, plan: NonNullable<PatchValidateResult["plan"]>) => void;
  runtime: WorkflowRuntime;
  settings: Partial<ApplySettings>;
  signal: AbortSignal;
  workflowId: string;
};

/** Declared chain metadata for one patch, forwarded verbatim into the plan-mode call. */
type PatchChainDeclaration = {
  /** Declared basis (`auto` defers to the engine's checksum inference). */
  basis?: "auto" | "base" | "previous";
  /** Declared input checks as comma-separable `algo=hex` tokens. */
  inputChecks?: string;
  /** Declared output checks as comma-separable `algo=hex` tokens. */
  outputChecks?: string;
};

type PatchTargetValidationEntry<TSource> = {
  /** This patch's declared chain metadata (bundle/user), when any. */
  chain?: PatchChainDeclaration;
  /** Fingerprint of the enabled chain this entry belongs to (ordered ids + declarations +
   * target). Order/enablement/check changes change it, invalidating every member's cached
   * verdict - chain position determines a plan-mode verdict, so per-patch caching alone is
   * not sound. */
  chainFingerprint?: string;
  preflight: InternalPatchChecksumPreflight;
  stage: StagedSource<TSource>;
  target: InputAsset;
};

const isHeaderRemoved = <TSource>(stage: StagedSource<TSource>, settings: Partial<ApplySettings>): boolean =>
  !!settings.compatibility?.removeHeader ||
  (stage.state.headerChoice ?? (stage.state.headerResolution?.decided ? stage.state.headerResolution.mode : "keep")) ===
    "strip";

const getEffectiveN64ByteOrder = <TSource>(stage: StagedSource<TSource>) =>
  stage.state.n64ByteOrderChoice ?? stage.state.n64Resolution?.mode;

const getStageChecksumCache = <TSource>(
  stage: StagedSource<TSource>,
  target: InputAsset,
  headerRemoved: boolean,
  n64ByteOrder: ReturnType<typeof getEffectiveN64ByteOrder>,
) => {
  if (headerRemoved) return stage.state.headerResolution?.headerlessChecksums;
  if (!(n64ByteOrder && n64ByteOrder !== "keep")) return getInputAssetChecksums(target);
  return target.checksumVariants?.find(
    (variant) =>
      (variant.applyCompatibility?.n64ByteOrder || variant.applyCompatibility?.n64_byte_order) === n64ByteOrder,
  )?.checksums;
};

// Write a resolved verdict onto a stage. A cancelled/transient failure is not a "patch does not
// apply" verdict; storing it as terminal "invalid" against the stable validationKey would make the
// short-circuit reuse it forever, so those become a non-terminal "unknown" that is retried.
const applyPatchVerdict = <TSource>(
  stage: StagedSource<TSource>,
  target: InputAsset,
  validationKey: string,
  startedAt: number,
  verdict: { message: string; status: "valid" | "invalid" | "unknown" | "deferred" },
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
  /** Terminal verdict already cached for this exact chain state: the entry still rides in its
   * group's patch list (plan verdicts are position-dependent) but a group of only cached entries
   * skips the worker call entirely. */
  cached: boolean;
  entry: PatchTargetValidationEntry<TSource>;
  headerRemoved: boolean;
  inputSource: unknown;
  n64ByteOrder?: "keep" | "big-endian" | "little-endian" | "byte-swapped";
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
  const validationKey = `${createApplyPatchValidationKey(stage, target, preflight)}${
    entry.chainFingerprint ? `|chain:${entry.chainFingerprint}` : ""
  }`;
  const existingValidation = stage.state.patchValidation;
  const cached =
    existingValidation?.validationKey === validationKey &&
    (existingValidation.status === "valid" ||
      existingValidation.status === "invalid" ||
      existingValidation.status === "deferred");
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
  if (!cached) {
    stage.state.patchValidation = {
      message: "Validating patch against selected target",
      status: "pending",
      targetInputId: target.id,
      validationKey,
    };
  }
  return {
    cached,
    entry,
    headerRemoved: isHeaderRemoved(stage, adapters.settings),
    inputSource,
    n64ByteOrder: getEffectiveN64ByteOrder(stage),
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
    n64ByteOrder: prepared.n64ByteOrder,
    sourcePath: (prepared.entry.target.file as { filePath?: string } | undefined)?.filePath,
    targetId: prepared.entry.target.id,
    threads: settings.workers?.threads ?? null,
  });

const validatePreparedGroup = async <TSource>(
  prepared: PreparedValidation<TSource>[],
  adapters: PatchTargetValidationAdapters,
): Promise<void> => {
  const first = prepared[0];
  if (!first) return;
  // Every member's verdict is cached for this exact chain state: nothing to run. When any member
  // needs work the WHOLE chain rides in one plan-mode call - verdicts depend on chain position.
  if (prepared.every((preparedEntry) => preparedEntry.cached)) return;
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
  // Preflight usually reports no incremental percent, so start indeterminate and only switch to a
  // determinate bar once real forward progress (> 0%) arrives. One shared worker call feeds every
  // patch in the group, so its progress is broadcast to each stage's row.
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
        // preflight too: a headerless-targeting patch validates against the stripped bytes - strip in
        // the engine and cache the headerless checksums, not the raw file's. All grouped patches
        // share the same target + header decision, so one cache/mode applies to the whole batch.
        checksumCache: getStageChecksumCache(
          first.entry.stage,
          first.entry.target,
          first.headerRemoved,
          first.n64ByteOrder,
        ),
        n64ByteOrder: first.n64ByteOrder,
        ...(prepared.some(({ entry }) => entry.chain?.basis && entry.chain.basis !== "auto")
          ? { patchBasis: prepared.map(({ entry }) => entry.chain?.basis ?? "auto") }
          : {}),
        ...(prepared.some(({ entry }) => entry.chain?.inputChecks)
          ? { patchInputChecks: prepared.map(({ entry }) => entry.chain?.inputChecks ?? "") }
          : {}),
        ...(prepared.some(({ entry }) => entry.chain?.outputChecks)
          ? { patchOutputChecks: prepared.map(({ entry }) => entry.chain?.outputChecks ?? "") }
          : {}),
        plan: true,
        removeHeader: first.headerRemoved,
        threads: adapters.settings.workers?.threads,
      },
      patches: prepared.map(({ entry, patchFile, patchSource }) => ({
        patchFile: patchSource as never,
        patchFileName: patchFile.fileName || entry.stage.state.fileName || "patch.bin",
        patchFormat: entry.stage.state.requirements?.format,
        requirements: entry.stage.state.requirements,
      })),
      signal: adapters.signal,
    });
    if (result.plan) adapters.onChainPlan?.(first.entry.target.id, result.plan);
    const planVerdicts = new Map<number, NonNullable<PatchValidateResult["plan"]>["per_patch"][number]>();
    for (const verdict of result.plan?.per_patch || []) planVerdicts.set(verdict.index, verdict);
    const perPatch = new Map<number, PatchValidatePerPatchVerdict>();
    for (const verdict of result.perPatch || []) perPatch.set(verdict.index, verdict);
    for (const [index, { entry, startedAt, validationKey }] of prepared.entries()) {
      const planVerdict = planVerdicts.get(index);
      if (planVerdict) {
        const status =
          planVerdict.input_verdict === "passed"
            ? "valid"
            : planVerdict.input_verdict === "failed"
              ? "invalid"
              : planVerdict.input_verdict === "chain_deferred"
                ? "deferred"
                : "unknown";
        applyPatchVerdict(entry.stage, entry.target, validationKey, startedAt, {
          message:
            planVerdict.message ||
            (status === "valid"
              ? "Patch validation passed"
              : status === "invalid"
                ? "Patch cannot be woven into this ROM"
                : "Input state is only provable during the weave"),
          status,
        });
        entry.stage.state.chainVerdict = {
          basis: planVerdict.basis,
          basisSource: planVerdict.basis_source,
          matched:
            planVerdict.matched.kind === "patch_output"
              ? { index: planVerdict.matched.index, kind: "patch_output" }
              : planVerdict.matched.kind === "base"
                ? { kind: "base", variant: planVerdict.matched.variant }
                : { kind: "none" },
          ...(planVerdict.expected_predecessor === undefined
            ? {}
            : { expectedPredecessor: planVerdict.expected_predecessor }),
        };
        continue;
      }
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
      // No index-aligned verdict (a non-plan runtime, or a mock): a resolved call means the
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
