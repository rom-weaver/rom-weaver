import type { WorkflowProgress } from "../../types/progress.ts";
import type { ApplySettings } from "../../types/settings.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { toRomWeaverError } from "../errors.ts";
import { getPatchFileExternalSource } from "../input/binary-service.ts";
import type { InputAsset } from "../input/input-assets.ts";
import { createApplyPatchValidationKey } from "./apply-patch-readiness-state-machine.ts";
import type { InternalPatchChecksumPreflight, StagedSource } from "./apply-workflow-state.ts";
import { getInputAssetChecksums } from "./staged-source-checksums.ts";

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

const validateApplyPatchTarget = async <TSource>(
  stage: StagedSource<TSource>,
  target: InputAsset,
  preflight: InternalPatchChecksumPreflight,
  adapters: PatchTargetValidationAdapters,
): Promise<void> => {
  const validationKey = createApplyPatchValidationKey(stage, target, preflight);
  const existingValidation = stage.state.patchValidation;
  if (
    existingValidation?.validationKey === validationKey &&
    (existingValidation.status === "valid" || existingValidation.status === "invalid")
  ) {
    return;
  }
  const validationStartedAt = Date.now();
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
    stage.state.checksumTimeMs = Date.now() - validationStartedAt;
    return;
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
    stage.state.checksumTimeMs = Date.now() - validationStartedAt;
    return;
  }

  stage.state.patchValidation = {
    message: "Validating patch against selected target",
    status: "pending",
    targetInputId: target.id,
    validationKey,
  };
  const validateProgressId = `${adapters.workflowId}:${stage.state.id}:patch-validate`;
  const validateProgressDetails = {
    fileName: stage.state.fileName,
    order: stage.state.order,
    sourceId: stage.state.id,
    targetInputId: target.id,
    targetInputName: target.fileName,
  };
  // Most patch formats validate via a dry-run apply that reports no incremental
  // percent (only 100% at completion), so a numeric percent would pin the bar at
  // 0% until done. Start indeterminate and only switch to a determinate bar once
  // real forward progress (> 0%) actually arrives (e.g. BPS).
  adapters.emitProgress({
    details: validateProgressDetails,
    id: validateProgressId,
    label: "Validating patch against selected target",
    percent: null,
    role: "patch",
    stage: "verify",
    workflow: "apply",
  });
  try {
    const result = await validatePatch({
      input: inputSource as never,
      logLevel: adapters.settings.logging?.level,
      onLog: adapters.settings.logging?.sink,
      onProgress: (progress) =>
        adapters.emitProgress({
          details: validateProgressDetails,
          id: validateProgressId,
          label: String(progress.label || progress.message || "Validating patch..."),
          percent:
            typeof progress.percent === "number" && Number.isFinite(progress.percent) && progress.percent > 0
              ? progress.percent
              : null,
          role: "patch",
          stage: "verify",
          workflow: "apply",
        }),
      options: {
        checksumCache: getInputAssetChecksums(target),
        removeHeader: !!adapters.settings.compatibility?.removeHeader,
        workerThreads: adapters.settings.workers?.threads,
      },
      patches: [
        {
          patchFile: patchSource as never,
          patchFileName: patchFile.fileName || stage.state.fileName || "patch.bin",
          patchFormat: stage.state.requirements?.format,
          requirements: stage.state.requirements,
        },
      ],
      signal: adapters.signal,
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
};

export { validateApplyPatchTarget };
