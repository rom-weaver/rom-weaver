import type { ChecksumVariant } from "../../types/checksum.ts";
import type { ParsedIdentifyResolution } from "../../types/identify.ts";
import type { SelectionCandidate } from "../../types/selection.ts";
import type { CommonSettings } from "../../types/settings.ts";
import type { WorkflowOptions, WorkflowWarning } from "../../types/workflow-controller.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { STANDARD_CHECKSUM_ALGORITHMS } from "../checksum-algorithms.ts";
import { RomWeaverError } from "../errors.ts";
import { BaseWorkflowController, type BaseWorkflowSnapshot, type SourceValidator } from "./base-workflow-controller.ts";
import { cloneValue, getSourceFileName, getSourceSize } from "./controller-utils.ts";
import type { SharedParentCompression } from "./staged-source-types.ts";
import { cloneChecksumVariants } from "./staged-source-checksums.ts";

type ChecksumWorkflowSourceStatus = "empty" | "failed" | "loading" | "needsSelection" | "ready";

/** The file resolved by the checksum command. */
type ChecksumWorkflowFile = {
  id: string;
  fileName: string;
  size: number;
  /** Lowercase hex digest per algorithm; an algorithm the runtime could not produce is absent. */
  checksums: Record<string, string>;
  checksumVariants?: ChecksumVariant[];
  trackNumber?: number;
};

type ChecksumWorkflowSourceState = {
  id: string;
  fileName?: string;
  status: ChecksumWorkflowSourceStatus;
  candidates: SelectionCandidate[];
  selectedCandidateId?: string;
  size?: number;
  sourceSize?: number;
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
  parentCompressions: SharedParentCompression[];
  identification?: ParsedIdentifyResolution;
  /** Checksums of the resolved input. */
  files: ChecksumWorkflowFile[];
  warnings: WorkflowWarning[];
};

type ChecksumWorkflowSnapshot = BaseWorkflowSnapshot & { input: ChecksumWorkflowSourceState | null };

class ChecksumWorkflowController<TSource> extends BaseWorkflowController<
  TSource,
  CommonSettings,
  ChecksumWorkflowSnapshot
> {
  private source?: TSource;
  private input?: ChecksumWorkflowSourceState;
  private autoExtract = true;

  constructor(
    runtime: WorkflowRuntime,
    options: WorkflowOptions<CommonSettings> = {},
    validateSources?: SourceValidator<TSource>,
  ) {
    super("checksum", runtime, options, validateSources);
  }

  getInput(): ChecksumWorkflowSourceState | null {
    return this.input ? cloneValue(this.input) : null;
  }

  async setInput(
    source: TSource,
    options: { autoExtract?: boolean; algorithms?: readonly string[] } = {},
  ): Promise<void> {
    return this.runExclusiveMutation("setInput", async () => {
      this.validateSources?.(source);
      await this.releaseSource();
      this.source = source;
      this.autoExtract = options.autoExtract ?? true;
      const fileName = getSourceFileName(source, "input.bin");
      const size = getSourceSize(source);
      this.input = {
        candidates: [],
        fileName,
        files: [],
        id: "input-1",
        parentCompressions: [],
        selectedCandidateId: "input",
        size,
        sourceSize: size,
        status: "ready",
        warnings: [],
      };
      try {
        await this.hashInput(options.algorithms ?? STANDARD_CHECKSUM_ALGORITHMS);
      } catch (error) {
        this.input.status = "failed";
        throw error;
      }
    });
  }

  async calculate(algorithms: readonly string[]): Promise<ChecksumWorkflowSourceState> {
    if (!(this.activeMutation || this.mutationQueue)) this.rearmAbortController(this.abortController.signal);
    return this.runQueuedMutation(
      "calculate",
      async () => {
        if (!this.input || this.source === undefined)
          throw new RomWeaverError("INVALID_INPUT", "A file is required before calculating checksums");
        await this.hashInput(algorithms);
        return this.getInput() as ChecksumWorkflowSourceState;
      },
      { rearmAbort: true },
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.abort();
    await this.settleMutations();
    await this.releaseSource();
    this.clearListeners();
    this.disposed = true;
  }

  protected computeSnapshot(): ChecksumWorkflowSnapshot {
    return { busy: this.isBusy(), id: this.id, input: this.getInput(), ready: this.input?.status === "ready" };
  }

  private async hashInput(algorithms: readonly string[]) {
    const input = this.input;
    if (!input || this.source === undefined) return;
    const known = input.files[0];
    const missing = algorithms.filter((algorithm) => !known?.checksums[algorithm]);
    if (!missing.length) return;
    if (!this.runtime.checksum) throw new RomWeaverError("INVALID_INPUT", "The checksum runtime is unavailable");
    this.trace("checksum.calculate.start", {
      algorithms: missing,
      autoExtract: this.autoExtract,
      fileName: input.fileName,
    });
    const result = await this.runtime.checksum.run({
      algorithms: [...new Set([...Object.keys(known?.checksums || {}), ...algorithms])],
      autoExtract: this.autoExtract,
      fileName: getSourceFileName(this.source, "input.bin"),
      logLevel: this.settings.logging?.level,
      onLog: this.settings.logging?.sink,
      onProgress: (event) =>
        this.emitProgress({
          details: { fileName: input.fileName, sourceId: input.id, size: input.size },
          id: `${this.id}:input:checksum`,
          label: event.label || event.message || "Calculating checksums...",
          percent: event.percent,
          role: "input",
          stage: "checksum",
          workflow: "checksum",
        }),
      signal: this.abortController.signal,
      source: this.source,
      threads: this.settings.workers?.threads,
    });
    input.files = [
      {
        checksums: result.checksums,
        checksumVariants: cloneChecksumVariants(result.variants),
        fileName: result.fileName,
        id: "input",
        size: result.size,
      },
    ];
    input.fileName = result.fileName;
    input.size = result.size;
    input.status = "ready";
    this.trace("checksum.calculate.finish", { algorithms: Object.keys(result.checksums), size: result.size });
  }

  private async releaseSource() {
    if (this.source !== undefined) await this.runtime.workerIo?.releaseSources?.([this.source]);
    this.source = undefined;
    this.input = undefined;
  }
}

export { ChecksumWorkflowController };
export type { ChecksumWorkflowFile, ChecksumWorkflowSourceState };
