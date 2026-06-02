import { forwardCreatePatchProgress, forwardDiscProgress } from "../../platform/shared/workflow-runtime-progress.ts";
import type { ChecksumResult } from "../../types/checksum.ts";
import type { CompressionExtractResult, PublicOutput } from "../../types/workflow-runtime.ts";
import type {
  RuntimeDiscCreateChdInput,
  RuntimeDiscCreateRvzInput,
  RuntimeDiscCreateZ3dsInput,
  RuntimeDiscExtractChdInput,
  RuntimeDiscExtractRvzInput,
  RuntimeDiscExtractZ3dsInput,
  RuntimePatchApplyWorkerInput,
  RuntimePatchCreateWorkerInput,
  RuntimePatchWorkerProgress,
  RuntimeWorkerIo,
  RuntimeWorkerPathSource,
  WorkflowRuntime,
  WorkflowRuntimeLog,
  WorkflowRuntimePreload,
  WorkflowRuntimePreloadEvent,
  WorkflowRuntimeProgress,
} from "../../types/workflow-runtime-adapter.ts";
import {
  type DiscCompressionFormat,
  type DiscCompressionFormatRegistration,
  getDiscCompressionFormatRegistration,
} from "../compression/container-format-registry.ts";
import { getPathBaseName } from "../path-utils.ts";
import { getNamedSourceFileName, toWorkerMetadata } from "./source-normalization.ts";
import { createCompressionExtractResult } from "./workflow-runtime-worker-helpers.ts";

const CUE_FILE_REGEX = /\.cue$/i;

const isCueOutput = (output: PublicOutput) => CUE_FILE_REGEX.test(output.fileName || output.path || "");

const withOutputFileName = (output: PublicOutput, fileName: string): PublicOutput =>
  output.fileName === fileName ? output : { ...output, fileName };

type DiscRuntimeAdapter = {
  createChd?: (input: RuntimeDiscCreateChdInput) => Promise<Awaited<ReturnType<RuntimeWorkerIo["createWorkerOutput"]>>>;
  createRvz?: (input: RuntimeDiscCreateRvzInput) => Promise<Awaited<ReturnType<RuntimeWorkerIo["createWorkerOutput"]>>>;
  createZ3ds?: (
    input: RuntimeDiscCreateZ3dsInput,
  ) => Promise<Awaited<ReturnType<RuntimeWorkerIo["createWorkerOutput"]>>>;
  listChd?: (
    input: RuntimeDiscExtractChdInput,
  ) => Promise<Awaited<ReturnType<NonNullable<WorkflowRuntime["compression"]["list"]>>>["entries"]>;
  listRvz?: (
    input: RuntimeDiscExtractRvzInput,
  ) => Promise<Awaited<ReturnType<NonNullable<WorkflowRuntime["compression"]["list"]>>>["entries"]>;
  listZ3ds?: (
    input: RuntimeDiscExtractZ3dsInput,
  ) => Promise<Awaited<ReturnType<NonNullable<WorkflowRuntime["compression"]["list"]>>>["entries"]>;
  extractChd?: (input: RuntimeDiscExtractChdInput) => Promise<CompressionExtractResult>;
  extractRvz?: (
    input: RuntimeDiscExtractRvzInput,
  ) => Promise<Awaited<ReturnType<RuntimeWorkerIo["createWorkerOutput"]>>>;
  extractZ3ds?: (
    input: RuntimeDiscExtractZ3dsInput,
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
  workerIo: RuntimeWorkerIo;
  workerOutputFailureMessage?: string;
};

type InternalPatchApplySummary = {
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

type ChecksumWorkerRunner = (
  input: {
    checksumAlgorithms: string[];
    checksumStartOffset?: number;
    fileName?: string;
    filePath?: string;
    fileSize?: number;
    logLevel?: string;
  },
  onProgress?: (progress: WorkflowRuntimeProgress) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
) => Promise<{ checksums: ChecksumResult }>;

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
) => {
  if (context.logLevel !== "trace") return;
  context.onLog?.({
    details,
    level: "trace",
    message,
    namespace: "runtime:patch",
    timestamp: new Date().toISOString(),
  });
};

const summarizeRuntimeWorkerPathSource = (source: RuntimeWorkerPathSource | undefined, index?: number) =>
  source
    ? {
        fileName: source.fileName,
        filePath: source.filePath,
        index,
        size: source.size,
      }
    : null;

const toPatchWorkerFiles = (sources: RuntimeWorkerPathSource[]) =>
  sources.map((patchSource) => ({
    patchFileName: patchSource.fileName,
    patchFilePath: patchSource.filePath,
  }));

const attachApplySummary = <TOutput extends PublicOutput>(
  output: TOutput,
  summary: InternalPatchApplySummary | null,
) => (summary ? Object.assign(output, { _applySummary: summary }) : output);

const createSharedPatchRuntime = (adapter: PatchRuntimeAdapter): WorkflowRuntime["patch"] => ({
  applyPatch: async ({ input, patches, options, logLevel, onLog, onProgress }) => {
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
      if (!inputSource) throw new Error("Apply patch worker input was not staged");
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
            logLevel,
            options,
            patchFileName: patchSources[0]?.fileName || "patch.bin",
            patchFilePath: patchSources[0]?.filePath,
            patchFiles: toPatchWorkerFiles(patchSources),
            romFileName: inputSource.fileName,
            romFilePath: inputSource.filePath,
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
          ? (result.applySummary as InternalPatchApplySummary)
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
    workerThreads,
    logLevel,
    onLog,
    onProgress,
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
          format,
          logLevel,
          metadata: toWorkerMetadata(metadata),
          modifiedFileName: modifiedSource.fileName,
          modifiedFilePath: modifiedSource.filePath,
          originalFileName: originalSource.fileName,
          originalFilePath: originalSource.filePath,
          outputName,
          workerThreads: workerThreads ?? undefined,
        },
        onProgress ? forwardCreatePatchProgress(onProgress) : undefined,
        onLog,
      );
      return {
        format,
        output: await adapter.workerIo.createWorkerOutput(result, outputName, adapter.workerOutputFailureMessage),
      };
    } finally {
      await cleanupWorkerSources(workerSources);
    }
  },
});

const createWorkerChecksumRuntime = (
  workerIo: RuntimeWorkerIo,
  runChecksumWorker: ChecksumWorkerRunner,
): WorkflowRuntime["checksum"] => ({
  calculate: async ({ source, algorithms, startOffset, logLevel, onLog, onProgress }) => {
    const workerSource = await workerIo.stageSource({
      fallbackFileName: "file.bin",
      pathPrefix: "checksum-input",
      scope: "checksum",
      source,
      trace: { logLevel, onLog },
    });
    try {
      const result = await runChecksumWorker(
        {
          checksumAlgorithms: algorithms,
          checksumStartOffset: startOffset,
          fileName: workerSource.fileName || "file.bin",
          filePath: workerSource.filePath,
          fileSize: workerSource.size,
          logLevel,
        },
        onProgress,
        onLog,
      );
      return result.checksums;
    } finally {
      await workerSource.cleanup().catch(() => undefined);
    }
  },
});

const createSharedCompressionRuntime = (
  archiveRuntime: Partial<WorkflowRuntime["compression"]>,
  discRuntime: DiscRuntimeAdapter,
  input: {
    archiveRuntimeOptional?: boolean;
  } = {},
): WorkflowRuntime["compression"] => {
  const requireOutput = <TOutput>(output: TOutput | undefined, message: string): TOutput => {
    if (output === undefined) throw new Error(message);
    return output;
  };
  const getSourceFileName = (source: RuntimeDiscExtractChdInput["source"], fallbackFileName: string) =>
    getNamedSourceFileName(source, { fallback: fallbackFileName }) || fallbackFileName;
  type DiscCreateRequest = Extract<
    Parameters<NonNullable<WorkflowRuntime["compression"]["create"]>>[0],
    { source: unknown }
  >;
  type DiscExtractRequest = Parameters<NonNullable<WorkflowRuntime["compression"]["extract"]>>[0];
  type DiscListRequest = Parameters<NonNullable<WorkflowRuntime["compression"]["list"]>>[0];
  type DiscCreateInput = RuntimeDiscCreateChdInput | RuntimeDiscCreateRvzInput | RuntimeDiscCreateZ3dsInput;
  type DiscExtractInput = RuntimeDiscExtractChdInput | RuntimeDiscExtractRvzInput | RuntimeDiscExtractZ3dsInput;
  type DiscListInput = RuntimeDiscExtractChdInput | RuntimeDiscExtractRvzInput | RuntimeDiscExtractZ3dsInput;
  type DiscCreateOutput = Awaited<ReturnType<RuntimeWorkerIo["createWorkerOutput"]>>;
  type DiscListEntries = Awaited<ReturnType<NonNullable<WorkflowRuntime["compression"]["list"]>>>["entries"];
  const createDiscInputs = {
    chd: (request: DiscCreateRequest): RuntimeDiscCreateChdInput => ({
      chdSourceMode: request.chdSourceMode,
      compressionCodecs: request.compressionCodecs,
      cueFilePath: request.cueFilePath,
      fileName: request.fileName,
      imageFiles: request.imageFiles,
      logLevel: request.options?.logLevel,
      mode: request.mode,
      onLog: request.options?.onLog,
      onProgress: forwardDiscProgress("output", request.options?.onProgress),
      outputName: request.outputName,
      source: request.source,
      threads: request.options?.workerThreads,
    }),
    rvz: (request: DiscCreateRequest): RuntimeDiscCreateRvzInput => ({
      fileName: request.fileName,
      logLevel: request.options?.logLevel,
      onLog: request.options?.onLog,
      onProgress: forwardDiscProgress("output", request.options?.onProgress),
      outputName: request.outputName,
      rvzBlockSize: request.rvzBlockSize,
      rvzCompression: request.rvzCompression,
      rvzCompressionLevel: request.rvzCompressionLevel,
      rvzMode: request.rvzMode,
      rvzScrub: request.rvzScrub,
      rvzSourceFileName: request.rvzSourceFileName,
      source: request.source,
      threads: request.options?.workerThreads,
    }),
    z3ds: (request: DiscCreateRequest): RuntimeDiscCreateZ3dsInput => ({
      fileName: request.fileName,
      logLevel: request.options?.logLevel,
      onLog: request.options?.onLog,
      onProgress: forwardDiscProgress("output", request.options?.onProgress),
      outputName: request.outputName,
      source: request.source,
      threads: request.options?.workerThreads,
      z3dsCompressionLevel: request.z3dsCompressionLevel,
      z3dsMetadata: request.z3dsMetadata as Record<
        string,
        string | number | boolean | Uint8Array | null | undefined
      > | null,
      z3dsSourceFileName: request.z3dsSourceFileName,
      z3dsUnderlyingMagic: request.z3dsUnderlyingMagic,
    }),
  } satisfies Record<DiscCompressionFormat, (request: DiscCreateRequest) => DiscCreateInput>;
  const createDiscOutput = async (registration: DiscCompressionFormatRegistration, input: DiscCreateInput) => {
    const create = discRuntime[registration.create] as
      | ((input: DiscCreateInput) => Promise<DiscCreateOutput>)
      | undefined;
    return create?.(input);
  };
  const extractDiscOutput = async (registration: DiscCompressionFormatRegistration, input: DiscExtractInput) => {
    const extract = discRuntime[registration.extract] as
      | ((input: DiscExtractInput) => Promise<CompressionExtractResult | DiscCreateOutput>)
      | undefined;
    return extract?.(input);
  };
  const listDiscEntries = async (registration: DiscCompressionFormatRegistration, input: DiscListInput) => {
    const list = discRuntime[registration.list] as ((input: DiscListInput) => Promise<DiscListEntries>) | undefined;
    return list?.(input);
  };
  const getDiscListInput = (
    registration: DiscCompressionFormatRegistration,
    request: DiscListRequest,
  ): DiscListInput => ({
    fileName: getSourceFileName(request.source, registration.fallbackFileName),
    logLevel: request.options?.logLevel,
    mode: undefined,
    onLog: request.options?.onLog,
    onProgress: forwardDiscProgress("input", request.options?.onProgress),
    source: request.source,
    threads: request.options?.workerThreads,
  });
  const extractChd = async (request: DiscExtractRequest) => {
    const registration = getDiscCompressionFormatRegistration("chd");
    if (!registration) throw new Error("CHD compression extraction is unavailable");
    const selectedEntries = request.entries.filter((entryName) => typeof entryName === "string" && entryName);
    const cueEntryName = selectedEntries.find((entryName) => CUE_FILE_REGEX.test(entryName));
    const trackEntryName = selectedEntries.find((entryName) => !CUE_FILE_REGEX.test(entryName));
    const extracted = requireOutput(
      (await extractDiscOutput(registration, {
        fileName: getSourceFileName(request.source, registration.fallbackFileName),
        logLevel: request.options?.logLevel,
        mode: cueEntryName ? "cd" : undefined,
        onLog: request.options?.onLog,
        onProgress: forwardDiscProgress("input", request.options?.onProgress),
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
      return createCompressionExtractResult([
        ...(cueOutput && cueEntryName
          ? [withOutputFileName(cueOutput, getPathBaseName(cueEntryName, cueEntryName))]
          : []),
        ...dataOutputs,
      ]);
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
    return createCompressionExtractResult(outputs.length ? outputs : extracted.outputs);
  };
  const extractSingleOutputDisc = async (
    registration: DiscCompressionFormatRegistration,
    request: DiscExtractRequest,
  ) => {
    if (request.entries.length !== 1)
      throw new Error(`${registration.label} compression extraction requires exactly one synthetic output entry`);
    return createCompressionExtractResult([
      requireOutput(
        (await extractDiscOutput(registration, {
          fileName: getSourceFileName(request.source, registration.fallbackFileName),
          logLevel: request.options?.logLevel,
          onLog: request.options?.onLog,
          onProgress: forwardDiscProgress("input", request.options?.onProgress),
          outputName: request.entries[0] || request.outputName,
          source: request.source,
          threads: request.options?.workerThreads,
        })) as DiscCreateOutput | undefined,
        `${registration.label} compression extraction is unavailable`,
      ),
    ]);
  };
  const extractDiscHandlers = {
    chd: (_registration: DiscCompressionFormatRegistration, request: DiscExtractRequest) => extractChd(request),
    rvz: (registration: DiscCompressionFormatRegistration, request: DiscExtractRequest) =>
      extractSingleOutputDisc(registration, request),
    z3ds: (registration: DiscCompressionFormatRegistration, request: DiscExtractRequest) =>
      extractSingleOutputDisc(registration, request),
  } satisfies Record<
    DiscCompressionFormat,
    (registration: DiscCompressionFormatRegistration, request: DiscExtractRequest) => Promise<CompressionExtractResult>
  >;
  const runtime: WorkflowRuntime["compression"] = {
    create: async (request) => {
      if ("entries" in request) {
        if (!archiveRuntime.create) throw new Error("Archive compression creation is unavailable");
        return archiveRuntime.create(request);
      }
      const registration = getDiscCompressionFormatRegistration(request.format);
      if (registration)
        return {
          output: requireOutput(
            await createDiscOutput(registration, createDiscInputs[registration.format](request)),
            `${registration.label} compression creation is unavailable`,
          ),
        };
      throw new Error(
        `Unsupported compression create format: ${String((request as { format?: unknown }).format || "")}`,
      );
    },
  };
  const extract = async (request: Parameters<NonNullable<WorkflowRuntime["compression"]["extract"]>>[0]) => {
    const registration = getDiscCompressionFormatRegistration(request.format);
    if (registration) return extractDiscHandlers[registration.format](registration, request);
    if (!archiveRuntime.extract) throw new Error("Archive compression extraction is unavailable");
    return archiveRuntime.extract(request);
  };
  if (!input.archiveRuntimeOptional || archiveRuntime.extract) runtime.extract = extract;
  runtime.list = async (request) => {
    const registration = getDiscCompressionFormatRegistration(request.format);
    if (registration)
      return {
        entries: requireOutput(
          await listDiscEntries(registration, getDiscListInput(registration, request)),
          `${registration.label} compression listing is unavailable`,
        ),
      };
    const listRuntime = archiveRuntime.list;
    if (!listRuntime) throw new Error("Archive compression listing is unavailable");
    return listRuntime(request);
  };
  return runtime;
};

const createRuntimePreload = (): WorkflowRuntimePreload => ({
  preloadCapability: async (capability, emit, options) => {
    const workerKind = getPreloadWorkerKind(capability);
    const tool = getPreloadWasmTool(capability);
    try {
      emitPreloadLog(emit, capability, `Preloading ${capability} capability`);
      emit({ data: { capability, status: "created", workerKind }, kind: "worker" });
      emit({ data: { capability, status: "loading", workerKind }, kind: "worker" });
      emit({ data: { capability, status: "loading", tool }, kind: "wasm" });
      emit({ data: { capability, status: "busy", workerKind }, kind: "worker" });
      const { warmupRomWeaverRunner } = await import("../../workers/rom-weaver/rom-weaver-runner.ts");
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

const getPreloadWorkerKind = (capability: Parameters<NonNullable<WorkflowRuntimePreload["preloadCapability"]>>[0]) => {
  if (capability === "compression" || capability === "checksum" || capability === "patch") return "rom-weaver";
  return "rom-weaver";
};

const getPreloadWasmTool = (capability: Parameters<NonNullable<WorkflowRuntimePreload["preloadCapability"]>>[0]) => {
  if (capability === "compression" || capability === "checksum" || capability === "patch") return "rom-weaver";
  return undefined;
};

export type { DiscRuntimeAdapter };
export { createRuntimePreload, createSharedCompressionRuntime, createSharedPatchRuntime, createWorkerChecksumRuntime };
