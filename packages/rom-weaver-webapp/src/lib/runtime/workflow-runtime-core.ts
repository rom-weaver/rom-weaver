import {
  forwardCreatePatchProgress,
  forwardRomSpecificProgress,
} from "../../platform/shared/workflow-runtime-progress.ts";
import type { PatchApplySummary } from "../../types/workflow-internal.ts";
import type {
  PatchValidateResult,
  RuntimePatchApplyWorkerInput,
  RuntimePatchCreateCandidatesWorkerInput,
  RuntimePatchCreateFormatCandidates,
  RuntimePatchCreateWorkerInput,
  RuntimePatchValidateWorkerInput,
  RuntimePatchWorkerProgress,
  RuntimeRomSpecificCreateChdInput,
  RuntimeRomSpecificCreateRvzInput,
  RuntimeRomSpecificCreateZ3dsInput,
  RuntimeRomSpecificExtractChdInput,
  RuntimeRomSpecificExtractRvzInput,
  RuntimeRomSpecificExtractZ3dsInput,
  RuntimeTrimWorkerInput,
  RuntimeWorkerIo,
  RuntimeWorkerPathSource,
  WorkflowRuntime,
  WorkflowRuntimeLog,
  WorkflowRuntimePreload,
  WorkflowRuntimePreloadEvent,
} from "../../types/workflow-runtime-adapter.ts";
import type { CompressionExtractResult, PublicOutput } from "../../types/workflow-runtime-types.ts";
import { warmupRomWeaverRunner } from "../../workers/rom-weaver/rom-weaver-runner.ts";
import {
  getRomSpecificCompressionFormatRegistration,
  type RomSpecificCompressionFormat,
  type RomSpecificCompressionFormatRegistration,
} from "../compression/container-format-registry.ts";
import { emitTraceLog } from "../logging.ts";
import { getPathBaseName } from "../path-utils.ts";
import { roundElapsedMs } from "../workflow/source-preparation.ts";
import { getNamedSourceFileName, toWorkerMetadata } from "./source-normalization.ts";
import { createCompressionExtractResult, transferRetainedOutputOwnership } from "./workflow-runtime-worker-helpers.ts";

const CUE_FILE_REGEX = /\.cue$/i;
const LEGACY_ROM_SPECIFIC_CREATE_FIELDS = [
  "chdSourceMode",
  "compressionCodecs",
  "cueFilePath",
  "imageFiles",
  "mode",
  "rvzBlockSize",
  "rvzCodec",
  "rvzCompressionLevel",
  "rvzMode",
  "rvzScrub",
  "rvzSourceFileName",
  "z3dsCompressionLevel",
  "z3dsMetadata",
  "z3dsSourceFileName",
  "z3dsUnderlyingMagic",
] as const;

const isCueOutput = (output: PublicOutput) => CUE_FILE_REGEX.test(output.fileName || output.path || "");

const withOutputFileName = (output: PublicOutput, fileName: string): PublicOutput =>
  output.fileName === fileName ? output : { ...output, fileName };

const assertNoLegacyRomSpecificCreateFields = (request: object) => {
  const legacyFields = LEGACY_ROM_SPECIFIC_CREATE_FIELDS.filter((field) => Object.hasOwn(request, field));
  if (!legacyFields.length) return;
  throw new Error(
    `Legacy compression create option fields are unsupported; use romSpecific.<format> instead: ${legacyFields.join(
      ", ",
    )}`,
  );
};

type RomSpecificRuntimeAdapter = {
  createChd?: (
    input: RuntimeRomSpecificCreateChdInput,
  ) => Promise<Awaited<ReturnType<RuntimeWorkerIo["createWorkerOutput"]>>>;
  createRvz?: (
    input: RuntimeRomSpecificCreateRvzInput,
  ) => Promise<Awaited<ReturnType<RuntimeWorkerIo["createWorkerOutput"]>>>;
  createZ3ds?: (
    input: RuntimeRomSpecificCreateZ3dsInput,
  ) => Promise<Awaited<ReturnType<RuntimeWorkerIo["createWorkerOutput"]>>>;
  extractChd?: (input: RuntimeRomSpecificExtractChdInput) => Promise<CompressionExtractResult>;
  extractRvz?: (
    input: RuntimeRomSpecificExtractRvzInput,
  ) => Promise<Awaited<ReturnType<RuntimeWorkerIo["createWorkerOutput"]>>>;
  extractZ3ds?: (
    input: RuntimeRomSpecificExtractZ3dsInput,
  ) => Promise<Awaited<ReturnType<RuntimeWorkerIo["createWorkerOutput"]>>>;
};

type PatchRuntimeAdapter = {
  invokeApplyPatchWorker: (
    input: RuntimePatchApplyWorkerInput,
    onProgress: ((progress: RuntimePatchWorkerProgress) => void) | undefined,
    onLog: Parameters<NonNullable<WorkflowRuntime["patch"]["applyPatch"]>>[0]["onLog"],
  ) => Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0]>;
  invokeCreatePatchWorker: (
    input: RuntimePatchCreateWorkerInput,
    onProgress: ((progress: RuntimePatchWorkerProgress) => void) | undefined,
    onLog: Parameters<NonNullable<WorkflowRuntime["patch"]["createPatch"]>>[0]["onLog"],
  ) => Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0]>;
  invokeCreatePatchCandidatesWorker: (
    input: RuntimePatchCreateCandidatesWorkerInput,
    onProgress: ((progress: RuntimePatchWorkerProgress) => void) | undefined,
    onLog: Parameters<NonNullable<WorkflowRuntime["patch"]["createPatchCandidates"]>>[0]["onLog"],
  ) => Promise<RuntimePatchCreateFormatCandidates>;
  invokeValidatePatchWorker: (
    input: RuntimePatchValidateWorkerInput,
    onProgress: ((progress: RuntimePatchWorkerProgress) => void) | undefined,
    onLog: Parameters<NonNullable<WorkflowRuntime["patch"]["validatePatch"]>>[0]["onLog"],
  ) => Promise<PatchValidateResult>;
  workerIo: RuntimeWorkerIo;
  workerOutputFailureMessage?: string;
};

type RuntimePatchTraceContext = {
  logLevel?: string;
  onLog?: (log: WorkflowRuntimeLog) => void;
};

const cleanupWorkerSources = async (workerSources: RuntimeWorkerPathSource[]) => {
  await Promise.all(workerSources.map((workerSource) => workerSource.cleanup().catch(() => undefined)));
};

const traceRuntimePatchApply = (
  context: RuntimePatchTraceContext,
  message: string,
  details: Record<string, unknown> = {},
) => emitTraceLog({ logLevel: context.logLevel, namespace: "runtime:patch", onLog: context.onLog }, message, details);

const summarizeRuntimeWorkerPathSource = (source: RuntimeWorkerPathSource | undefined, index?: number) =>
  source
    ? {
        fileName: source.fileName,
        filePath: source.filePath,
        index,
        size: source.size,
      }
    : null;

const toPatchWorkerFiles = (sources: RuntimeWorkerPathSource[], patchMetadata: Array<{ patchFormat?: string }> = []) =>
  sources.map((patchSource, index) => ({
    patchFileName: patchSource.fileName,
    patchFilePath: patchSource.filePath,
    patchFormat: patchMetadata[index]?.patchFormat,
  }));

const attachApplySummary = <TOutput extends PublicOutput>(output: TOutput, summary: PatchApplySummary | null) =>
  summary ? Object.assign(output, { _applySummary: summary }) : output;

const createSharedPatchRuntime = (adapter: PatchRuntimeAdapter): WorkflowRuntime["patch"] => ({
  applyPatch: async ({ input, patches, options, logLevel, onLog, onProgress, signal }) => {
    const traceContext = { logLevel, onLog };
    const stageStartedAt = Date.now();
    traceRuntimePatchApply(traceContext, "patch.apply.stage.start", {
      patchCount: patches.length,
    });
    let workerSources: RuntimeWorkerPathSource[];
    try {
      workerSources = await adapter.workerIo.stageSources([
        {
          fallbackFileName: "input.bin",
          pathBucket: "input",
          pathPrefix: "apply-input",
          scope: "apply",
          source: input,
          trace: traceContext,
        },
        ...patches.map((patch, index) => ({
          fallbackFileName: patch.patchFileName || `patch-${index + 1}.bin`,
          pathBucket: "patches" as const,
          pathPrefix: `apply-patch-${index + 1}`,
          scope: "apply" as const,
          source: patch.patchFile,
          trace: traceContext,
        })),
      ]);
      const [inputSource, ...patchSources] = workerSources;
      traceRuntimePatchApply(traceContext, "patch.apply.stage.finish", {
        durationMs: Date.now() - stageStartedAt,
        input: summarizeRuntimeWorkerPathSource(inputSource),
        patches: patchSources.map((source, index) => summarizeRuntimeWorkerPathSource(source, index)),
      });
    } catch (error) {
      traceRuntimePatchApply(traceContext, "patch.apply.stage.fail", {
        durationMs: Date.now() - stageStartedAt,
        error,
        patchCount: patches.length,
      });
      throw error;
    }
    try {
      const [inputSource, ...patchSources] = workerSources;
      if (!inputSource) throw new Error("Patch worker input was not staged for weaving");
      const workerStartedAt = Date.now();
      traceRuntimePatchApply(traceContext, "patch.apply.worker.dispatch", {
        input: summarizeRuntimeWorkerPathSource(inputSource),
        patchCount: patchSources.length,
        patches: patchSources.map((source, index) => summarizeRuntimeWorkerPathSource(source, index)),
      });
      let result: Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0];
      try {
        result = await adapter.invokeApplyPatchWorker(
          {
            inputSize: inputSource.size,
            logLevel,
            options,
            patchFileName: patchSources[0]?.fileName || "patch.bin",
            patchFilePath: patchSources[0]?.filePath,
            patchFiles: toPatchWorkerFiles(patchSources, patches),
            patchFormat: patches[0]?.patchFormat,
            romFileName: inputSource.fileName,
            romFilePath: inputSource.filePath,
            signal,
          },
          onProgress ? forwardCreatePatchProgress(onProgress) : undefined,
          onLog,
        );
      } catch (error) {
        traceRuntimePatchApply(traceContext, "patch.apply.worker.fail", {
          durationMs: Date.now() - workerStartedAt,
          error,
          input: summarizeRuntimeWorkerPathSource(inputSource),
          patchCount: patchSources.length,
        });
        throw error;
      }
      traceRuntimePatchApply(traceContext, "patch.apply.worker.finish", {
        durationMs: Date.now() - workerStartedAt,
        fileName: result.fileName,
        outputSize: result.size,
        timing: result.applySummary && typeof result.applySummary === "object" ? result.applySummary.timing : undefined,
      });
      return attachApplySummary(
        await adapter.workerIo.createWorkerOutput(
          result,
          result.fileName || "patched.bin",
          adapter.workerOutputFailureMessage,
        ),
        result.applySummary && typeof result.applySummary === "object"
          ? (result.applySummary as PatchApplySummary)
          : null,
      );
    } finally {
      await cleanupWorkerSources(workerSources);
    }
  },
  createPatch: async ({
    original,
    modified,
    format,
    metadata,
    outputName,
    checksumName,
    sourceCrc32,
    workerThreads,
    logLevel,
    onLog,
    onProgress,
    signal,
  }) => {
    const traceContext = { logLevel, onLog };
    const workerSources = await adapter.workerIo.stageSources([
      {
        fallbackFileName: "original.bin",
        pathBucket: "input",
        pathPrefix: "create-patch-original",
        scope: "create-patch",
        source: original,
        trace: traceContext,
      },
      {
        fallbackFileName: "modified.bin",
        pathBucket: "input",
        pathPrefix: "create-patch-modified",
        scope: "create-patch",
        source: modified,
        trace: traceContext,
      },
    ]);
    try {
      const [originalSource, modifiedSource] = workerSources;
      if (!(originalSource && modifiedSource)) throw new Error("Create patch worker inputs were not staged");
      const result = await adapter.invokeCreatePatchWorker(
        {
          checksumName,
          format,
          logLevel,
          metadata: toWorkerMetadata(metadata),
          modifiedFileName: modifiedSource.fileName,
          modifiedFilePath: modifiedSource.filePath,
          originalFileName: originalSource.fileName,
          originalFilePath: originalSource.filePath,
          outputName,
          signal,
          sourceCrc32,
          workerThreads: workerThreads ?? undefined,
        },
        onProgress ? forwardCreatePatchProgress(onProgress) : undefined,
        onLog,
      );
      const createTimeMs = roundElapsedMs(result.timing);
      return {
        format,
        output: await adapter.workerIo.createWorkerOutput(result, outputName, adapter.workerOutputFailureMessage),
        sizeSummary: createTimeMs === undefined ? {} : { createTimeMs },
      };
    } finally {
      await cleanupWorkerSources(workerSources);
    }
  },
  createPatchCandidates: async ({ original, modified, workerThreads, logLevel, onLog, onProgress, signal }) => {
    const traceContext = { logLevel, onLog };
    const workerSources = await adapter.workerIo.stageSources([
      {
        fallbackFileName: "original.bin",
        pathBucket: "input",
        pathPrefix: "create-patch-candidates-original",
        scope: "create-patch",
        source: original,
        trace: traceContext,
      },
      {
        fallbackFileName: "modified.bin",
        pathBucket: "input",
        pathPrefix: "create-patch-candidates-modified",
        scope: "create-patch",
        source: modified,
        trace: traceContext,
      },
    ]);
    try {
      const [originalSource, modifiedSource] = workerSources;
      if (!(originalSource && modifiedSource)) throw new Error("Create patch candidate inputs were not staged");
      return await adapter.invokeCreatePatchCandidatesWorker(
        {
          logLevel,
          modifiedFileName: modifiedSource.fileName,
          modifiedFilePath: modifiedSource.filePath,
          originalFileName: originalSource.fileName,
          originalFilePath: originalSource.filePath,
          signal,
          workerThreads: workerThreads ?? undefined,
        },
        onProgress ? forwardCreatePatchProgress(onProgress) : undefined,
        onLog,
      );
    } finally {
      await cleanupWorkerSources(workerSources);
    }
  },
  validatePatch: async ({ input, patches, options, logLevel, onLog, onProgress, signal }) => {
    const traceContext = { logLevel, onLog };
    const workerSources = await adapter.workerIo.stageSources([
      {
        fallbackFileName: "input.bin",
        pathBucket: "input",
        pathPrefix: "validate-input",
        scope: "patch-validate",
        source: input,
        trace: traceContext,
      },
      ...patches.map((patch, index) => ({
        fallbackFileName: patch.patchFileName || `patch-${index + 1}.bin`,
        pathBucket: "patches" as const,
        pathPrefix: `validate-patch-${index + 1}`,
        scope: "patch-validate" as const,
        source: patch.patchFile,
        trace: traceContext,
      })),
    ]);
    try {
      const [inputSource, ...patchSources] = workerSources;
      if (!inputSource) throw new Error("Validate patch worker input was not staged");
      traceRuntimePatchApply(traceContext, "patch.validate.worker.dispatch", {
        input: summarizeRuntimeWorkerPathSource(inputSource),
        patchCount: patchSources.length,
        patches: patchSources.map((source, index) => summarizeRuntimeWorkerPathSource(source, index)),
      });
      const validationRequirements = patches
        .map((patch) => patch.requirements)
        .filter((requirements): requirements is NonNullable<(typeof patches)[number]["requirements"]> =>
          Boolean(requirements),
        );
      const validationOptions = {
        ...options,
        ...(validationRequirements.length ? { validationRequirements } : {}),
      };
      return await adapter.invokeValidatePatchWorker(
        {
          inputSize: inputSource.size,
          logLevel,
          options: validationOptions,
          patchFiles: toPatchWorkerFiles(patchSources, patches),
          romFileName: inputSource.fileName,
          romFilePath: inputSource.filePath,
          signal,
        },
        onProgress ? forwardCreatePatchProgress(onProgress) : undefined,
        onLog,
      );
    } finally {
      await cleanupWorkerSources(workerSources);
    }
  },
});

type TrimRuntimeAdapter = {
  invokeTrimWorker: (
    input: RuntimeTrimWorkerInput,
    onProgress: ((progress: RuntimePatchWorkerProgress) => void) | undefined,
    onLog: Parameters<NonNullable<WorkflowRuntime["trim"]["trim"]>>[0]["onLog"],
  ) => Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0]>;
  workerIo: RuntimeWorkerIo;
  workerOutputFailureMessage?: string;
};

const createSharedTrimRuntime = (adapter: TrimRuntimeAdapter): WorkflowRuntime["trim"] => ({
  trim: async ({ source, extension, outputName, workerThreads, logLevel, onLog, onProgress, signal }) => {
    const traceContext = { logLevel, onLog };
    const workerSource = await adapter.workerIo.stageSource({
      fallbackFileName: "input.bin",
      pathBucket: "input",
      pathPrefix: "trim-input",
      scope: "create-patch",
      source,
      trace: traceContext,
    });
    try {
      const result = await adapter.invokeTrimWorker(
        {
          extension,
          logLevel,
          outputName,
          signal,
          sourceFileName: workerSource.fileName,
          sourceFilePath: workerSource.filePath,
          workerThreads: workerThreads ?? undefined,
        },
        onProgress ? forwardCreatePatchProgress(onProgress) : undefined,
        onLog,
      );
      const trimTimeMs = roundElapsedMs(result.timing);
      return {
        output: await adapter.workerIo.createWorkerOutput(
          result,
          result.fileName || outputName || "trimmed.bin",
          adapter.workerOutputFailureMessage,
        ),
        sizeSummary: trimTimeMs === undefined ? {} : { trimTimeMs },
      };
    } finally {
      await workerSource.cleanup().catch(() => undefined);
    }
  },
});

const createSharedCompressionRuntime = (
  archiveRuntime: Partial<WorkflowRuntime["compression"]>,
  romSpecificRuntime: RomSpecificRuntimeAdapter,
  input: {
    archiveRuntimeOptional?: boolean;
  } = {},
): WorkflowRuntime["compression"] => {
  const requireOutput = <TOutput>(output: TOutput | undefined, message: string): TOutput => {
    if (output === undefined) throw new Error(message);
    return output;
  };
  const getSourceFileName = (source: RuntimeRomSpecificExtractChdInput["source"], fallbackFileName: string) =>
    getNamedSourceFileName(source, { fallback: fallbackFileName }) || fallbackFileName;
  type RomSpecificCreateRequest = Extract<
    Parameters<NonNullable<WorkflowRuntime["compression"]["create"]>>[0],
    { source: unknown }
  >;
  type RomSpecificExtractRequest = Parameters<NonNullable<WorkflowRuntime["compression"]["extract"]>>[0];
  type RomSpecificCreateInput =
    | RuntimeRomSpecificCreateChdInput
    | RuntimeRomSpecificCreateRvzInput
    | RuntimeRomSpecificCreateZ3dsInput;
  type RomSpecificExtractInput =
    | RuntimeRomSpecificExtractChdInput
    | RuntimeRomSpecificExtractRvzInput
    | RuntimeRomSpecificExtractZ3dsInput;
  type RomSpecificCreateOutput = Awaited<ReturnType<RuntimeWorkerIo["createWorkerOutput"]>>;
  const createRomSpecificInputs = {
    chd: (request: RomSpecificCreateRequest): RuntimeRomSpecificCreateChdInput => ({
      compressionCodecs: request.romSpecific?.chd?.compressionCodecs,
      cueFilePath: request.romSpecific?.chd?.cueFilePath,
      fileName: request.fileName,
      imageFiles: request.romSpecific?.chd?.imageFiles,
      logLevel: request.options?.logLevel,
      mode: request.romSpecific?.chd?.mode,
      onLog: request.options?.onLog,
      onProgress: forwardRomSpecificProgress(
        "output",
        request.options?.onProgress,
        `Compressing ${request.fileName} to CHD`,
      ),
      outputName: request.outputName,
      source: request.source,
      sourceMode: request.romSpecific?.chd?.sourceMode,
      threads: request.options?.workerThreads,
    }),
    rvz: (request: RomSpecificCreateRequest): RuntimeRomSpecificCreateRvzInput => ({
      blockSize: request.romSpecific?.rvz?.blockSize,
      codec: request.romSpecific?.rvz?.codec,
      compressionLevel: request.romSpecific?.rvz?.compressionLevel,
      fileName: request.fileName,
      logLevel: request.options?.logLevel,
      mode: request.romSpecific?.rvz?.mode,
      onLog: request.options?.onLog,
      onProgress: forwardRomSpecificProgress(
        "output",
        request.options?.onProgress,
        `Compressing ${request.fileName} to RVZ`,
      ),
      outputName: request.outputName,
      scrub: request.romSpecific?.rvz?.scrub,
      source: request.source,
      sourceFileName: request.romSpecific?.rvz?.sourceFileName,
      threads: request.options?.workerThreads,
    }),
    z3ds: (request: RomSpecificCreateRequest): RuntimeRomSpecificCreateZ3dsInput => ({
      compressionLevel: request.romSpecific?.z3ds?.compressionLevel,
      fileName: request.fileName,
      logLevel: request.options?.logLevel,
      metadata: request.romSpecific?.z3ds?.metadata as Record<
        string,
        string | number | boolean | Uint8Array | null | undefined
      > | null,
      onLog: request.options?.onLog,
      onProgress: forwardRomSpecificProgress(
        "output",
        request.options?.onProgress,
        `Compressing ${request.fileName} to Z3DS`,
      ),
      outputName: request.outputName,
      source: request.source,
      sourceFileName: request.romSpecific?.z3ds?.sourceFileName,
      threads: request.options?.workerThreads,
      underlyingMagic: request.romSpecific?.z3ds?.underlyingMagic,
    }),
  } satisfies Record<RomSpecificCompressionFormat, (request: RomSpecificCreateRequest) => RomSpecificCreateInput>;
  const createRomSpecificOutput = async (
    registration: RomSpecificCompressionFormatRegistration,
    input: RomSpecificCreateInput,
  ) => {
    const create = romSpecificRuntime[registration.create] as
      | ((input: RomSpecificCreateInput) => Promise<RomSpecificCreateOutput>)
      | undefined;
    return create?.(input);
  };
  const extractRomSpecificOutput = async (
    registration: RomSpecificCompressionFormatRegistration,
    input: RomSpecificExtractInput,
  ) => {
    const extract = romSpecificRuntime[registration.extract] as
      | ((input: RomSpecificExtractInput) => Promise<CompressionExtractResult | RomSpecificCreateOutput>)
      | undefined;
    return extract?.(input);
  };
  const extractChd = async (request: RomSpecificExtractRequest) => {
    const registration = getRomSpecificCompressionFormatRegistration("chd");
    if (!registration) throw new Error("CHD compression extraction is unavailable");
    const selectedEntries = request.entries.filter((entryName) => typeof entryName === "string" && entryName);
    const cueEntryName = selectedEntries.find((entryName) => CUE_FILE_REGEX.test(entryName));
    const trackEntryName = selectedEntries.find((entryName) => !CUE_FILE_REGEX.test(entryName));
    const sourceFileName = getSourceFileName(request.source, registration.fallbackFileName);
    const extracted = requireOutput(
      (await extractRomSpecificOutput(registration, {
        fileName: sourceFileName,
        logLevel: request.options?.logLevel,
        mode: cueEntryName ? "cd" : undefined,
        onLog: request.options?.onLog,
        onProgress: forwardRomSpecificProgress("input", request.options?.onProgress, `Extracting ${sourceFileName}...`),
        outputName: trackEntryName || request.outputName,
        source: request.source,
        splitBin: typeof request.options?.chdSplitBin === "boolean" ? request.options.chdSplitBin : undefined,
        threads: request.options?.workerThreads,
      })) as CompressionExtractResult | undefined,
      `${registration.label} compression extraction is unavailable`,
    );
    if (!cueEntryName) return extracted;
    const cueOutput = extracted.outputs.find(isCueOutput) || null;
    const dataOutputs = extracted.outputs.filter((output) => !isCueOutput(output));
    if (dataOutputs.length > 1) {
      const outputs = [
        ...(cueOutput && cueEntryName
          ? [withOutputFileName(cueOutput, getPathBaseName(cueEntryName, cueEntryName))]
          : []),
        ...dataOutputs,
      ];
      return createCompressionExtractResult(transferRetainedOutputOwnership(extracted.outputs, outputs).outputs);
    }
    const outputs = request.entries
      .map((entryName) => {
        const normalizedEntryName = getPathBaseName(entryName, entryName).toLowerCase();
        const exactOutput =
          extracted.outputs.find((output) => {
            const outputName = getPathBaseName(output.fileName || output.path || "", "").toLowerCase();
            return outputName === normalizedEntryName;
          }) || null;
        const fallbackOutput = CUE_FILE_REGEX.test(entryName)
          ? cueOutput
          : dataOutputs.length === 1
            ? dataOutputs[0]
            : null;
        const output = exactOutput || fallbackOutput;
        return output ? withOutputFileName(output, getPathBaseName(entryName, entryName)) : null;
      })
      .filter((output): output is PublicOutput => !!output);
    const retainedOutputs = outputs.length ? outputs : extracted.outputs;
    return createCompressionExtractResult(transferRetainedOutputOwnership(extracted.outputs, retainedOutputs).outputs);
  };
  const extractSingleOutputRomSpecific = async (
    registration: RomSpecificCompressionFormatRegistration,
    request: RomSpecificExtractRequest,
  ) => {
    if (request.entries.length !== 1)
      throw new Error(`${registration.label} compression extraction requires exactly one synthetic output entry`);
    const sourceFileName = getSourceFileName(request.source, registration.fallbackFileName);
    return createCompressionExtractResult([
      requireOutput(
        (await extractRomSpecificOutput(registration, {
          fileName: sourceFileName,
          logLevel: request.options?.logLevel,
          onLog: request.options?.onLog,
          onProgress: forwardRomSpecificProgress(
            "input",
            request.options?.onProgress,
            `Extracting ${sourceFileName}...`,
          ),
          outputName: request.entries[0] || request.outputName,
          source: request.source,
          threads: request.options?.workerThreads,
        })) as RomSpecificCreateOutput | undefined,
        `${registration.label} compression extraction is unavailable`,
      ),
    ]);
  };
  const extractRomSpecificHandlers = {
    chd: (_registration: RomSpecificCompressionFormatRegistration, request: RomSpecificExtractRequest) =>
      extractChd(request),
    rvz: (registration: RomSpecificCompressionFormatRegistration, request: RomSpecificExtractRequest) =>
      extractSingleOutputRomSpecific(registration, request),
    z3ds: (registration: RomSpecificCompressionFormatRegistration, request: RomSpecificExtractRequest) =>
      extractSingleOutputRomSpecific(registration, request),
  } satisfies Record<
    RomSpecificCompressionFormat,
    (
      registration: RomSpecificCompressionFormatRegistration,
      request: RomSpecificExtractRequest,
    ) => Promise<CompressionExtractResult>
  >;
  const runtime: WorkflowRuntime["compression"] = {
    create: async (request) => {
      if ("entries" in request) {
        if (!archiveRuntime.create) throw new Error("Archive compression creation is unavailable");
        return archiveRuntime.create(request);
      }
      assertNoLegacyRomSpecificCreateFields(request);
      const registration = getRomSpecificCompressionFormatRegistration(request.format);
      if (registration)
        return {
          output: requireOutput(
            await createRomSpecificOutput(registration, createRomSpecificInputs[registration.format](request)),
            `${registration.label} compression creation is unavailable`,
          ),
        };
      throw new Error(
        `Unsupported compression create format: ${String((request as { format?: unknown }).format || "")}`,
      );
    },
  };
  const extract = async (request: Parameters<NonNullable<WorkflowRuntime["compression"]["extract"]>>[0]) => {
    // A single-payload recursive descent always uses the generic archive extract: the Rust core
    // extracts chd/rvz/z3ds discs and descends nested containers uniformly, so disc inputs need no
    // separate list + per-format extract step.
    if (request.descendSinglePayload && archiveRuntime.extract) return archiveRuntime.extract(request);
    const registration = getRomSpecificCompressionFormatRegistration(request.format);
    if (registration) return extractRomSpecificHandlers[registration.format](registration, request);
    if (!archiveRuntime.extract) throw new Error("Archive compression extraction is unavailable");
    return archiveRuntime.extract(request);
  };
  if (!input.archiveRuntimeOptional || archiveRuntime.extract) runtime.extract = extract;
  // Entry enumeration is handler-agnostic: the Rust `probe` command auto-detects chd/z3ds/zip/etc and
  // reports the container's entries (no per-format dispatch, no decompression).
  const archiveProbe = archiveRuntime.probe;
  if (archiveProbe) runtime.probe = (request) => archiveProbe(request);
  return runtime;
};

const createRuntimePreload = (): WorkflowRuntimePreload => ({
  preloadCapability: async (capability, emit, options) => {
    const workerKind = "rom-weaver";
    const tool = "rom-weaver";
    try {
      emitPreloadLog(emit, capability, `Preloading ${capability} capability`);
      emit({ data: { capability, status: "created", workerKind }, kind: "worker" });
      emit({ data: { capability, status: "loading", workerKind }, kind: "worker" });
      emit({ data: { capability, status: "loading", tool }, kind: "wasm" });
      emit({ data: { capability, status: "busy", workerKind }, kind: "worker" });
      await warmupRomWeaverRunner(options?.workerThreads);
      emit({ data: { capability, status: "loaded", tool }, kind: "wasm" });
      emit({ data: { capability, status: "instantiated", tool }, kind: "wasm" });
      emit({ data: { capability, status: "ready", workerKind }, kind: "worker" });
      emit({ data: { capability, status: "idle", workerKind }, kind: "worker" });
    } catch (error) {
      emit({ data: { capability, status: "failed", tool }, kind: "wasm" });
      emit({ data: { capability, status: "failed", workerKind }, kind: "worker" });
      throw error;
    }
  },
});

const emitPreloadLog = (
  emit: (event: WorkflowRuntimePreloadEvent) => void,
  capability: Parameters<NonNullable<WorkflowRuntimePreload["preloadCapability"]>>[0],
  message: string,
) => {
  emit({
    data: {
      capability,
      level: "debug",
      message,
    },
    kind: "log",
  });
};

export type { RomSpecificRuntimeAdapter };
export { createRuntimePreload, createSharedCompressionRuntime, createSharedPatchRuntime, createSharedTrimRuntime };
