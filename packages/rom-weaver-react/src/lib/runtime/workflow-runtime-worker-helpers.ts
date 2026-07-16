import { createCleanupOnce } from "../../storage/shared/disposal.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { CompressionExtractResult, PublicOutput } from "../../types/workflow-runtime-types.ts";
import { getArchiveEntryArrayBuffer, getArchiveEntryUint8Array } from "./source-normalization.ts";

type SevenZipZstdCreateRequest = Extract<
  Parameters<NonNullable<WorkflowRuntime["compression"]["create"]>>[0],
  { entries: unknown }
>;

const attachRomSpecificOutputMetadata = <TOutput extends PublicOutput>(
  output: TOutput,
  metadata: {
    chdCuePath?: string;
  },
) => Object.assign(output, metadata);

const normalizeCompressionWorkerEntries = (entries: SevenZipZstdCreateRequest["entries"]) =>
  entries.map((entry) => ({
    arrayBuffer: entry.arrayBuffer || getArchiveEntryArrayBuffer(entry.data),
    file: entry.file,
    fileName: entry.fileName || entry.filename || entry.name,
    filename: entry.filename || entry.fileName || entry.name,
    filePath: entry.filePath,
    lastModified: entry.lastModified || entry.mtime,
    name: entry.name || entry.fileName || entry.filename,
    text: entry.text,
    u8array: entry.u8array || getArchiveEntryUint8Array(entry.data),
  }));

const isCueOutput = (output: PublicOutput) => /\.cue$/i.test(output.fileName || output.path || "");

const createCompressionExtractResult = (outputs: CompressionExtractResult["outputs"]): CompressionExtractResult => ({
  entries: outputs.map((output) => ({
    fileName: output.fileName,
    filename: output.fileName,
    size: output.size,
  })),
  output: (outputs.find((output) => !isCueOutput(output)) || outputs[0]) as CompressionExtractResult["output"],
  outputs,
});

const sharesOutputLifetime = (left: PublicOutput, right: PublicOutput): boolean =>
  left === right ||
  (!!left.path &&
    left.path === right.path &&
    (left.dispose === right.dispose || (!!left.cleanup && left.cleanup === right.cleanup)));

const transferRetainedOutputOwnership = (
  sourceOutputs: readonly PublicOutput[],
  retainedOutputs: readonly PublicOutput[],
): { cleanup: () => Promise<void>; outputs: PublicOutput[] } => {
  const uniqueSourceOutputs: PublicOutput[] = [];
  for (const output of sourceOutputs) {
    if (!uniqueSourceOutputs.some((candidate) => sharesOutputLifetime(output, candidate))) {
      uniqueSourceOutputs.push(output);
    }
  }
  const cleanup = createCleanupOnce(async () => {
    await Promise.all(uniqueSourceOutputs.map((output) => output.dispose().catch(() => undefined)));
  });
  const hasOmittedOutputs = uniqueSourceOutputs.some(
    (output) => !retainedOutputs.some((retained) => sharesOutputLifetime(output, retained)),
  );
  if (!hasOmittedOutputs) return { cleanup, outputs: [...retainedOutputs] };

  let remainingOwners = retainedOutputs.length;
  const outputs = retainedOutputs.map((output) => {
    const release = createCleanupOnce(async () => {
      remainingOwners -= 1;
      if (!remainingOwners) await cleanup();
    });
    return { ...output, cleanup: release, dispose: release };
  });
  return { cleanup, outputs };
};

export {
  attachRomSpecificOutputMetadata,
  createCompressionExtractResult,
  normalizeCompressionWorkerEntries,
  transferRetainedOutputOwnership,
};
