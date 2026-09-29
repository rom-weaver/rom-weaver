import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import {
  getRomWeaverRunEventDetails,
  isRomWeaverTerminalRunEvent,
} from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { toThreadBudget } from "./compression-thread-budget.ts";
import { emitRuntimeTrace, toRomWeaverOptions } from "./run-options.ts";
import { ensureRomWeaverSuccess, normalizeEmittedFileChecksums, parseChecksumVariants } from "./run-result-parsing.ts";
import { runRomWeaverJson, relaySimpleProgress } from "./wasm-command-shared.ts";

type ChecksumInput = Omit<Parameters<NonNullable<WorkflowRuntime["checksum"]>["run"]>[0], "source" | "fileName"> & {
  sourcePath: string;
};

const invokeRomWeaverChecksumWorker = async (input: ChecksumInput) => {
  const command = createRomWeaverCommand("checksum", {
    input: input.sourcePath,
    algo: input.algorithms,
    no_extract: !input.autoExtract,
    no_ignore: true,
    threads: toThreadBudget(input.threads) ?? undefined,
  });
  emitRuntimeTrace(input, "runJson checksum dispatch", { command });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      knownInputPaths: [input.sourcePath],
      logLevel: input.logLevel,
      onEvent: relaySimpleProgress(input.onProgress),
      onLog: input.onLog,
      signal: input.signal,
    }),
  );
  ensureRomWeaverSuccess(result, "Checksum failed");
  const terminal = result.events.findLast(isRomWeaverTerminalRunEvent);
  const details = terminal ? getRomWeaverRunEventDetails(terminal) : undefined;
  if (!details || typeof details !== "object" || Array.isArray(details)) throw new Error("Checksum result is missing");
  const record = details as Record<string, unknown>;
  const size = Number(record.size);
  if (!Number.isFinite(size) || size < 0) throw new Error("Checksum result has no file size");
  const fileName = record.file_name;
  if (typeof fileName !== "string" || !fileName) throw new Error("Checksum result has no file name");
  return {
    fileName,
    checksums: normalizeEmittedFileChecksums(record.checksums) || {},
    variants: parseChecksumVariants(record),
    size,
  };
};

export { invokeRomWeaverChecksumWorker };
