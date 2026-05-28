import { getInputPreparationMetrics, type InputAsset } from "../../lib/input/input-assets.ts";
import { getInputSourceFileName } from "../../lib/input/input-classification.ts";
import {
  getBinarySourceSize,
  prepareAutoPatchInputs,
  prepareInput,
  prepareInputAssets,
  prepareMultipleDirectInputAssets,
} from "../../lib/input/input-preparation-service.ts";
import { getBaseFileName } from "../../lib/input/path-utils.ts";
import { applySidecarPatchOutputLabel, resolveSidecarPatchEntries } from "../../lib/input/sidecar-patch-resolution.ts";
import { buildSessionOutputFiles } from "../../lib/output/output-build-service.ts";
import { requireOutputName } from "../../lib/output/output-name-validation.ts";
import { reportProgress } from "../../lib/progress/progress-reporting.ts";
import { getNamedSourcePath } from "../../storage/shared/binary/source-file-utils.ts";
import { isVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { SourceRef } from "../../types/source.ts";
import type { PatchFileInstance, PatchWorkflowDeps } from "../../types/workflow-internal.ts";
import type { ApplyWorkflowResult, PatchInput } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { ParsedPatchLike } from "../../workers/protocol/patch-engine.ts";
import { createPatchFile, getPatchFileExternalSource } from "../input/binary-service.ts";
import { createPatchFileFromPublicOutput } from "../runtime/public-output-bin-file.ts";
import { createWorkflowTracer } from "../workflow/workflow-tracing.ts";
import {
  normalizePatchOptions,
  parsePatchForApply,
  resolvePatchTargets,
  toPublicOutput,
  verifyPatchedOutputIfRequired,
} from "./patch-apply-service.ts";

type InternalWorkerApplySummary = {
  outputSize?: number;
  patches?: Array<{
    fileName: string;
    format: string;
    size?: number;
  }>;
  patchSize?: number;
  rom?: {
    fileName: string;
    size?: number;
  };
  timing?: {
    elapsedMs?: number;
    elapsedSeconds?: number;
  } | null;
};

type PublicOutputWithApplySummary = ApplyWorkflowResult["output"] & {
  _applySummary?: InternalWorkerApplySummary;
};

const getApplyLogLevel = (options: PatchInput["options"]) => options?.logging?.level;
const getApplyWorkerThreads = (options: PatchInput["options"]) => options?.workers?.threads;
const getApplyPatchTargets = (options: PatchInput["options"]) => options?.patchTargets;
const { traceWorkflowStage, traceWorkflowStageBlock } = createWorkflowTracer("apply");

const getRuntimeExternalPath = (
  sourceRef: ReturnType<typeof getPatchFileExternalSource>,
  runtime: WorkflowRuntime,
): string | null => {
  if (!(sourceRef && sourceRef.source)) return null;
  if (typeof sourceRef.source === "string" && sourceRef.source.trim()) return sourceRef.source.trim();
  if (isVfsFileRef(sourceRef.source) && sourceRef.source.vfs === runtime.vfs) {
    const path = String(sourceRef.source.path || "").trim();
    if (path) return path;
  }
  return null;
};

const hasMissingPreparedInputPaths = async (assets: InputAsset[], runtime: WorkflowRuntime) => {
  for (const asset of assets) {
    const sourceRef = getPatchFileExternalSource(asset.file, asset.fileName);
    const externalPath = getRuntimeExternalPath(sourceRef, runtime);
    if (!externalPath) continue;
    if (await runtime.vfs.stat(externalPath)) continue;
    return true;
  }
  return false;
};

const toWorkerSourceRef = (file: PatchFileInstance, fallbackFileName: string): SourceRef => {
  const sourceRef = getPatchFileExternalSource(file, fallbackFileName);
  if (sourceRef) return sourceRef;
  throw new Error(`Patch worker source is not file-backed: ${file.fileName || fallbackFileName || "input.bin"}`);
};

const summarizePreparedInputMetrics = (assets: InputAsset[]) => {
  const seen = new Set<string>();
  let inputSourceSize = 0;
  let inputDecompressionTimeMs = 0;
  let hasInputSourceSize = false;
  let wasDecompressed = false;
  for (const asset of assets) {
    const key = asset.groupId || asset.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const metrics = getInputPreparationMetrics([asset]);
    if (!metrics) continue;
    if (typeof metrics.sourceSize === "number" && Number.isFinite(metrics.sourceSize)) {
      inputSourceSize += metrics.sourceSize;
      hasInputSourceSize = true;
    }
    if (metrics.wasDecompressed) {
      wasDecompressed = true;
      if (typeof metrics.decompressionTimeMs === "number" && Number.isFinite(metrics.decompressionTimeMs))
        inputDecompressionTimeMs += metrics.decompressionTimeMs;
    }
  }
  return {
    inputDecompressionTimeMs: wasDecompressed ? inputDecompressionTimeMs : undefined,
    inputSourceSize: hasInputSourceSize ? inputSourceSize : undefined,
  };
};

const createWorkerApplyOptions = (options: PatchInput["options"]) => ({
  addHeader: !!options?.compatibility?.addHeader,
  appendOutputSuffix: !!options?.output?.suffix,
  fixChecksum: !!options?.compatibility?.fixChecksum,
  outputExtension: options?.output?.extension,
  outputName: options?.output?.outputName,
  removeHeader: !!options?.compatibility?.removeHeader,
  requireInputChecksumMatch:
    typeof options?.validation?.requireInputChecksumMatch === "boolean"
      ? options.validation.requireInputChecksumMatch
      : false,
  workerThreads: getApplyWorkerThreads(options),
});

const runApplyWorkflow = async (
  input: PatchInput,
  runtime: WorkflowRuntime,
  deps: PatchWorkflowDeps,
): Promise<ApplyWorkflowResult> => {
  const options = input.options || {};
  requireOutputName(options.output?.outputName);
  const patchSources = Array.isArray(input.patches) ? input.patches : [];
  if (!Array.isArray(input.patches) && input.patches) patchSources.push(input.patches);
  const inputSources = Array.isArray(input.inputs) ? input.inputs : [input.inputs];
  const inputCompressedSize = inputSources.reduce(
    (total, source) => total + (deps.getBinarySourceSize(source) || 0),
    0,
  );
  if (!inputSources.length) throw new Error("No input file provided");
  const patchCompressedSize = patchSources.reduce(
    (total, source) => total + (deps.getBinarySourceSize(source) || 0),
    0,
  );
  const preparationWork: Promise<void>[] = [];
  const inputAssets = input.preparedInputAssets ? [...input.preparedInputAssets] : [];
  const shouldReprepareInputs =
    !!input.preparedInputAssets?.length &&
    inputSources.some((source) => !!source) &&
    (await hasMissingPreparedInputPaths(inputAssets, runtime));
  if (input.preparedInputAssets && !shouldReprepareInputs) {
    traceWorkflowStage(options, "stage.skip", "input.prepare", "input", {
      preparedAssetCount: inputAssets.length,
      reason: "prepared input assets supplied",
    });
  } else {
    inputAssets.length = 0;
    preparationWork.push(
      traceWorkflowStageBlock(
        options,
        "input.prepare",
        "input",
        async () => {
          const directAssets =
            inputSources.length > 1 ? await deps.prepareMultipleDirectInputAssets(inputSources, options) : null;
          inputAssets.push(...(directAssets || []));
          if (!directAssets) {
            for (let index = 0; index < inputSources.length; index++) {
              const inputSource = inputSources[index];
              if (!inputSource) throw new Error(`Input ${index + 1} was not provided`);
              inputAssets.push(
                ...(await deps.prepareInputAssets(inputSource, options, index, runtime, input.selectedInputEntryName, {
                  allowLazyBrowserRomSource: inputSources.length === 1,
                })),
              );
            }
          }
        },
        () => ({
          inputCount: inputSources.length,
          preparedAssetCount: inputAssets.length,
          reprepare: shouldReprepareInputs,
          selectedEntryName: input.selectedInputEntryName,
        }),
      ),
    );
  }

  let patchFiles: PatchFileInstance[] = input.preparedPatchFiles ? [...input.preparedPatchFiles] : [];
  if (input.preparedPatchFiles) {
    traceWorkflowStage(options, "stage.skip", "patch.prepare", "patch", {
      patchCount: patchFiles.length,
      reason: "prepared patch files supplied",
    });
  } else {
    preparationWork.push(
      traceWorkflowStageBlock(
        options,
        "patch.prepare",
        "patch",
        async () => {
          const preparedPatchFiles = await Promise.all(
            patchSources.map(async (patchSource, index) => {
              if (!patchSource) throw new Error(`Patch ${index + 1} was not provided`);
              const patchFile = await deps.prepareInput(
                patchSource,
                "patch",
                options,
                runtime,
                input.selectedPatchEntryNames?.[index],
                index,
              );
              applySidecarPatchOutputLabel(patchFile, options.sidecarPatchOutputLabels?.[index]);
              return patchFile;
            }),
          );
          patchFiles.push(...preparedPatchFiles);
        },
        () => ({
          patchCount: patchFiles.length,
          patchSourceCount: patchSources.length,
          selectedEntryNames: input.selectedPatchEntryNames,
        }),
      ),
    );
  }
  await Promise.all(preparationWork);

  const shouldDiscoverImplicitPatches =
    input.patches === undefined && input.preparedPatchFiles === undefined && input.parsedPatches === undefined;
  const listSiblingFiles = runtime.sidecars.list;
  if (patchFiles.length) {
    traceWorkflowStage(options, "stage.skip", "patch.autodiscover", "patch", {
      patchCount: patchFiles.length,
      reason: "patch files already prepared",
    });
    traceWorkflowStage(options, "stage.skip", "patch.sidecar", "patch", {
      patchCount: patchFiles.length,
      reason: "patch files already prepared",
    });
  } else if (shouldDiscoverImplicitPatches) {
    await traceWorkflowStageBlock(
      options,
      "patch.autodiscover",
      "patch",
      async () => {
        for (const inputSource of inputSources) {
          patchFiles = patchFiles.concat(await deps.prepareAutoPatchInputs(inputSource, options));
        }
      },
      () => ({
        inputCount: inputSources.length,
        patchCount: patchFiles.length,
      }),
    );
    if (!patchFiles.length && inputSources.length === 1 && listSiblingFiles) {
      await traceWorkflowStageBlock(
        options,
        "patch.sidecar",
        "patch",
        async () => {
          const source = inputSources[0];
          const sourcePath = getNamedSourcePath(source as Parameters<typeof getNamedSourcePath>[0]);
          if (sourcePath) {
            const siblingSources = await listSiblingFiles(sourcePath);
            const sidecarPatches = resolveSidecarPatchEntries(
              getBaseFileName(getInputSourceFileName(source) || sourcePath),
              siblingSources.map((siblingSource) => ({
                fileName: getBaseFileName(getInputSourceFileName(siblingSource)),
                source: siblingSource,
              })),
            );
            for (const sidecarPatch of sidecarPatches) {
              const patchFile = await deps.prepareInput(
                sidecarPatch.entry.source as SourceRef,
                "patch",
                options,
                runtime,
              );
              applySidecarPatchOutputLabel(patchFile, sidecarPatch.outputLabel);
              patchFiles.push(patchFile);
            }
          }
        },
        () => ({
          patchCount: patchFiles.length,
        }),
      );
    } else if (patchFiles.length) {
      traceWorkflowStage(options, "stage.skip", "patch.sidecar", "patch", {
        patchCount: patchFiles.length,
        reason: "patch files already prepared",
      });
    } else {
      traceWorkflowStage(options, "stage.skip", "patch.sidecar", "patch", {
        inputCount: inputSources.length,
        reason: listSiblingFiles ? "requires single input source" : "sidecar capability unavailable",
      });
    }
  } else {
    traceWorkflowStage(options, "stage.skip", "patch.autodiscover", "patch", {
      patchCount: 0,
      reason: "explicit patch list provided",
    });
    traceWorkflowStage(options, "stage.skip", "patch.sidecar", "patch", {
      patchCount: 0,
      reason: "explicit patch list provided",
    });
  }
  const preparedInputSize = inputAssets.reduce((total, asset) => total + asset.size, 0);
  const preparedInputMetrics = summarizePreparedInputMetrics(inputAssets);
  const patchSize = patchFiles.reduce((total, patchFile) => total + patchFile.fileSize, 0);

  const suppliedParsedPatches = input.parsedPatches ? [...input.parsedPatches] : [];
  if (!patchFiles.length && suppliedParsedPatches.length)
    throw new Error("Parsed patches were provided without patch files");
  const patches = patchFiles.length
    ? suppliedParsedPatches.length === patchFiles.length
      ? suppliedParsedPatches
      : await traceWorkflowStageBlock(
          options,
          "parse",
          "patch",
          () =>
            Promise.all(
              patchFiles.map(async (patchFile) => {
                const patch = await deps.parsePatchForApply(patchFile, runtime);
                if (!patch) throw new Error(`Invalid patch file: ${patchFile.fileName}`);
                return patch;
              }),
            ),
          () => ({ patchCount: patchFiles.length }),
        )
    : [];
  if (patches.length && suppliedParsedPatches.length === patchFiles.length) {
    traceWorkflowStage(options, "stage.skip", "parse", "patch", {
      patchCount: patches.length,
      reason: "parsed patches supplied",
    });
  } else if (!patches.length) {
    traceWorkflowStage(options, "stage.skip", "parse", "patch", {
      patchCount: 0,
      reason: "no patches provided",
    });
  }

  const patchTargets = input.patchTargets || getApplyPatchTargets(options);
  const targets: InputAsset[] = [];
  const patchedById = new Map<string, PatchFileInstance>();
  if (patches.length) {
    deps.reportProgress(options, {
      label: "Applying patch...",
      percent: null,
      stage: "apply",
    });
    const resolvedTargets = await traceWorkflowStageBlock(
      options,
      "patch.target.resolve",
      "patch",
      () => deps.resolvePatchTargets(inputAssets, patches, patchTargets),
      () => ({
        inputCount: inputAssets.length,
        patchCount: patches.length,
        strategy: patchTargets?.length ? "explicit" : "auto",
      }),
    );
    targets.push(...resolvedTargets);
    const patchesByTarget = new Map<string, ParsedPatchLike[]>();
    for (let index = 0; index < patches.length; index++) {
      const target = targets[index];
      if (!target) throw new Error(`Patch ${index + 1} target was not resolved`);
      const targetPatches = patchesByTarget.get(target.id) || [];
      const patch = patches[index];
      if (!patch) throw new Error(`Patch ${index + 1} was not parsed`);
      targetPatches.push(patch);
      patchesByTarget.set(target.id, targetPatches);
    }
    const applyPatchInRuntime = runtime.patch.applyPatch;
    if (!applyPatchInRuntime) throw new Error("Patch worker support is required for apply workflows");
    for (const asset of inputAssets) {
      const assetPatches = patchesByTarget.get(asset.id);
      if (!assetPatches?.length) continue;
      const patched = await traceWorkflowStageBlock(
        options,
        "apply",
        "output",
        async () =>
          await (async () => {
            const selectedPatches = assetPatches.map((patch) => {
              const patchIndex = patches.indexOf(patch);
              const patchFile = patchFiles[patchIndex];
              if (!patchFile) throw new Error("Patch worker source was not found");
              return {
                patchFile: toWorkerSourceRef(patchFile, `patch-${patchIndex + 1}.bin`),
                patchFileName: patchFile.fileName || `patch-${patchIndex + 1}.bin`,
              };
            });
            const workerOutput = (await applyPatchInRuntime({
              input: toWorkerSourceRef(asset.file, asset.fileName || "input.bin"),
              logLevel: getApplyLogLevel(options),
              onLog: options.onLog,
              onProgress: (progress) =>
                deps.reportProgress(options, {
                  label: typeof progress.label === "string" && progress.label ? progress.label : "Applying patch...",
                  percent:
                    typeof progress.percent === "number" && Number.isFinite(progress.percent) ? progress.percent : null,
                  stage: "apply",
                }),
              options: {
                ...createWorkerApplyOptions(options),
                requireOutputChecksumMatch:
                  typeof options.validation?.requireOutputChecksumMatch === "boolean"
                    ? options.validation.requireOutputChecksumMatch
                    : false,
              },
              patches: selectedPatches,
            })) as PublicOutputWithApplySummary;
            const canReuseWorkerOutputPath = !!(
              workerOutput &&
              typeof workerOutput === "object" &&
              "path" in workerOutput &&
              typeof workerOutput.path === "string" &&
              workerOutput.path &&
              "vfs" in workerOutput &&
              workerOutput.vfs
            );
            return createPatchFileFromPublicOutput(
              workerOutput as unknown as Parameters<typeof createPatchFile>[0],
              workerOutput.fileName || asset.fileName || "patched.bin",
              canReuseWorkerOutputPath
                ? {
                    materializeBlob: false,
                    preferExternalFilePath: true,
                  }
                : undefined,
            );
          })(),
        () => ({
          patchCount: assetPatches.length,
          patchFormats: assetPatches.map((patch) => patch.constructor?.name || "patch"),
          sourceName: asset.fileName,
          sourceSize: asset.size,
          workerReason: "worker apply required",
        }),
      );
      await traceWorkflowStageBlock(
        options,
        "verify",
        "output",
        () => deps.verifyPatchedOutputIfRequired(patched, assetPatches, options, runtime),
        () => ({
          patchCount: assetPatches.length,
          sourceName: asset.fileName,
        }),
      );
      if (inputAssets.length > 1) patched.fileName = asset.fileName;
      patchedById.set(asset.id, patched);
    }
  } else {
    traceWorkflowStage(options, "stage.skip", "patch.target.resolve", "patch", {
      inputCount: inputAssets.length,
      reason: "no patches provided",
    });
    traceWorkflowStage(options, "stage.skip", "apply", "output", {
      inputCount: inputAssets.length,
      reason: "no patches provided",
    });
  }

  const { files: outputFiles, rawOutputSize } = await traceWorkflowStageBlock(
    options,
    "output.materialization",
    "output",
    () => deps.buildSessionOutputFiles(inputAssets, patchedById, options, runtime),
    () => ({
      inputCount: inputAssets.length,
      patchedCount: patchedById.size,
    }),
  );
  const outputs = await Promise.all(outputFiles.map((file) => deps.toPublicOutput(file, runtime)));
  traceWorkflowStage(options, "stage.finish", "result", "output", {
    inputCount: inputAssets.length,
    outputCount: outputs.length,
    patchCount: patches.length,
    patchedCount: patchedById.size,
    rawOutputSize,
  });
  const primaryInput = targets[0] || inputAssets.find((asset) => asset.patchable) || inputAssets[0];
  if (!primaryInput) throw new Error("No input file provided");

  return {
    inputs: inputAssets.map((asset) => ({
      fileName: asset.fileName,
      id: asset.id,
      kind: asset.kind,
      patchable: asset.patchable,
      size: asset.size,
    })),
    output: outputs[0] as ApplyWorkflowResult["output"],
    outputs,
    patches: patches.map((patch, index) => ({
      fileName: patchFiles[index]?.fileName || `patch-${index + 1}`,
      format: patch.constructor?.name || "patch",
      targetInputId: targets[index]?.id,
    })),
    rom: {
      fileName: primaryInput.fileName,
      size: primaryInput.size,
    },
    sizeSummary: outputs[0]
      ? {
          inputCompressedSize: inputCompressedSize || preparedInputMetrics.inputSourceSize || preparedInputSize,
          inputDecompressionTimeMs: preparedInputMetrics.inputDecompressionTimeMs,
          inputSize: preparedInputSize,
          outputSize: outputs[0].size || 0,
          patchCompressedSize: patchCompressedSize || patchSize,
          patchSize,
          rawSize: rawOutputSize,
        }
      : undefined,
  };
};

const patchWorkflowDeps = {
  buildSessionOutputFiles,
  createPatchFile,
  getBinarySourceSize,
  normalizePatchOptions,
  parsePatchForApply,
  prepareAutoPatchInputs,
  prepareInput,
  prepareInputAssets,
  prepareMultipleDirectInputAssets,
  reportProgress,
  resolvePatchTargets,
  toPublicOutput,
  verifyPatchedOutputIfRequired,
};

export { patchWorkflowDeps, runApplyWorkflow };
