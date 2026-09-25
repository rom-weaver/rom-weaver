import type { ParsedIngestResult } from "../../types/ingest.ts";
import type { LogLevel } from "../../types/logging.ts";
import type { RuntimeThreadBudgetInput, WorkflowRuntimeLog } from "../../types/workflow-runtime-adapter.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import { getRomWeaverRunEventDetails } from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { withRomWeaverFailureKind } from "../../workers/rom-weaver/runner-errors.ts";
import { getPathBaseName } from "../path-utils.ts";
import { toThreadBudget } from "./compression-thread-budget.ts";
import { parseIdentifyCommandResult, parseIdentifyTitleSearchResult, parseIngestResult } from "./ingest-result.ts";
import type { ParsedIdentifyCommandResult, ParsedIdentifyTitleSearchResult } from "./ingest-result.ts";
import { emitRuntimeTrace, toRomWeaverOptions } from "./run-options.ts";
import {
  asRecord,
  ensureRomWeaverSuccess,
  getLastEvent,
  getRunResultTiming,
  getTerminalEvent,
} from "./run-result-parsing.ts";
import type { RomWeaverRunJsonResult } from "./run-result-parsing.ts";
import {
  runRomWeaverJson,
  relaySimpleProgress,
  throwRomWeaverFailureWithBrowserOutputContext,
  toTrimmedList,
} from "./wasm-command-shared.ts";

type LibretroSidecarMatch = { name: string; order: number };

const getSidecarMatchesFromResult = (result: RomWeaverRunJsonResult): LibretroSidecarMatch[] => {
  const terminal = getTerminalEvent(result);
  const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null);
  const raw = details?.sidecar_matches;
  if (!Array.isArray(raw)) return [];
  const matches: LibretroSidecarMatch[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const name = typeof record?.name === "string" ? record.name : "";
    if (!name) continue;
    const order = Number(record?.order);
    matches.push({ name, order: Number.isFinite(order) ? order : 0 });
  }
  return matches;
};

// Match loose RetroArch/libretro sidecar patches through ingest, so archive-bundled and sibling files
// share the same Rust matcher and report shape.
const runRomWeaverIngestSidecarsWorker = async (
  input: { romName: string; patchNames: string[]; logLevel?: LogLevel | string; signal?: AbortSignal },
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<LibretroSidecarMatch[]> => {
  const romName = String(input.romName || "").trim();
  if (!(romName && input.patchNames.length)) return [];
  const command = createRomWeaverCommand("ingest", {
    output: "/work/sidecar-match",
    sidecar_names: input.patchNames,
    sidecar_only: true,
    input: romName,
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson ingest sidecar dispatch", {
    patchCount: input.patchNames.length,
    romName,
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({ logLevel: input.logLevel, onLog, signal: input.signal }),
  );
  ensureRomWeaverSuccess(result, "Sidecar match failed");
  return getSidecarMatchesFromResult(result);
};

// Classify a dropped source as ROM or patch, nested-extract + checksum ROMs (in place for bare
// ROMs), and describe patches - the consolidated `ingest` command. One round-trip replaces the
// webapp's separate classify → descend → checksum (ROM) and classify → describe (patch) calls.
const invokeRomWeaverIngestWorker = async (
  input: {
    checksumAlgorithms?: string[];
    databasePaths?: string[];
    interactiveSelectionEnabled?: boolean;
    invalidateMountCacheBeforeRun?: boolean;
    knownInputPaths?: string[];
    logLevel?: LogLevel | string;
    noIgnore?: boolean;
    noNestedExtract?: boolean;
    outDirPath: string;
    select?: string[];
    signal?: AbortSignal;
    sourcePath: string;
    // For a multi-track CHD CD: force per-track split BIN (true) or a single merged BIN (false).
    // Omit to let the ingest command ask the host interactively when the disc offers the choice.
    splitBin?: boolean;
    threads?: RuntimeThreadBudgetInput;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<ParsedIngestResult & { timing: ReturnType<typeof getRunResultTiming> }> => {
  const sourcePath = String(input.sourcePath || "").trim();
  if (!sourcePath) throw new Error("Ingest source path is required");
  const outDirPath = String(input.outDirPath || "").trim();
  if (!outDirPath) throw new Error("Ingest output directory is required");
  const select = toTrimmedList(input.select);
  const checksum = toTrimmedList(input.checksumAlgorithms).map((value) => value.toLowerCase());
  const database = toTrimmedList(input.databasePaths);
  const threadArg = toThreadBudget(input.threads);
  const command = createRomWeaverCommand("ingest", {
    output: outDirPath,
    input: sourcePath,
    ...(database.length ? { database } : {}),
    ...(select.length ? { select } : {}),
    ...(input.noIgnore ? { no_ignore: true } : {}),
    ...(input.noNestedExtract ? { no_nested_extract: true } : {}),
    ...(typeof input.splitBin === "boolean" ? { split_bin: input.splitBin } : {}),
    ...(checksum.length ? { checksum } : {}),
    ...(threadArg ? { threads: threadArg } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson ingest dispatch", {
    checksum,
    command,
    databaseCount: database.length,
    outDirPath,
    selectCount: select.length,
    sourcePath,
    threadArg,
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      ...(typeof input.interactiveSelectionEnabled === "boolean"
        ? { interactiveSelectionEnabled: input.interactiveSelectionEnabled }
        : {}),
      invalidateMountCacheBeforeRun: input.invalidateMountCacheBeforeRun,
      knownInputPaths: input.knownInputPaths,
      logLevel: input.logLevel,
      onEvent: relaySimpleProgress(onProgress),
      onLog,
      signal: input.signal,
    }),
  );
  if (!(result.ok && result.exitCode === 0)) {
    await throwRomWeaverFailureWithBrowserOutputContext(
      result,
      "Ingest failed",
      `ingest \`${getPathBaseName(sourcePath)}\``,
    );
  }
  const terminal = getLastEvent(result);
  const details = terminal ? getRomWeaverRunEventDetails(terminal) : undefined;
  const parsed = parseIngestResult(details);
  if (!parsed) {
    throw withRomWeaverFailureKind(new Error("Ingest result was missing or malformed"), result);
  }
  return { ...parsed, timing: getRunResultTiming(result) };
};

// Identify by a bare checksum via the `identify` command's --hash path. No ROM source is staged;
// the staged database packs are the only file inputs.
const invokeRomWeaverIdentifyHashWorker = async (
  input: {
    databasePaths?: string[];
    hash: string | string[];
    knownInputPaths?: string[];
    logLevel?: LogLevel | string;
    signal?: AbortSignal;
    /** Exact byte size, narrowing the lookup to records of that size. */
    size?: number;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<ParsedIdentifyCommandResult & { timing: ReturnType<typeof getRunResultTiming> }> => {
  const hash = toTrimmedList(Array.isArray(input.hash) ? input.hash : [input.hash]).map((value) => value.toLowerCase());
  if (!hash.length) throw new Error("Identify hash is required");
  const database = toTrimmedList(input.databasePaths);
  // The command contract carries u64 fields as bigint; the run-request
  // serializer narrows them back to JSON-safe numbers.
  const size = typeof input.size === "number" && Number.isFinite(input.size) ? Math.floor(input.size) : undefined;
  const command = createRomWeaverCommand("identify", {
    hash,
    ...(size === undefined ? {} : { size: BigInt(size) }),
    ...(database.length ? { database } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson identify dispatch", {
    command,
    databaseCount: database.length,
    hash,
    size,
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      knownInputPaths: input.knownInputPaths,
      logLevel: input.logLevel,
      onEvent: relaySimpleProgress(onProgress),
      onLog,
      signal: input.signal,
    }),
  );
  if (!(result.ok && result.exitCode === 0)) {
    await throwRomWeaverFailureWithBrowserOutputContext(result, "Identify failed", `identify \`${hash.join(" ")}\``);
  }
  const terminal = getLastEvent(result);
  const details = terminal ? getRomWeaverRunEventDetails(terminal) : undefined;
  const parsed = parseIdentifyCommandResult(details);
  if (!parsed) {
    throw withRomWeaverFailureKind(new Error("Identify result was missing or malformed"), result);
  }
  return { ...parsed, timing: getRunResultTiming(result) };
};

/**
 * Search one staged pack by game name through the `identify` command. Pack
 * selection is the caller's: a name cannot be routed to a pack the way a
 * checksum can, so `databasePaths` MUST already name the single pack of the
 * platform the user chose. The result is the same shape the hash path returns,
 * with the matches sorted best-first and cut to `limit`.
 */
const invokeRomWeaverIdentifyNameWorker = async (
  input: {
    databasePaths?: string[];
    knownInputPaths?: string[];
    /** Most matches to return; the command defaults to 50. */
    limit?: number;
    logLevel?: LogLevel | string;
    name: string;
    signal?: AbortSignal;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<ParsedIdentifyCommandResult & { timing: ReturnType<typeof getRunResultTiming> }> => {
  const name = input.name.trim();
  if (!name) throw new Error("Identify name is required");
  const database = toTrimmedList(input.databasePaths);
  if (!database.length) throw new Error("Identify by name needs a database pack");
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0
      ? Math.floor(input.limit)
      : undefined;
  const command = createRomWeaverCommand("identify", {
    database,
    ...(limit === undefined ? {} : { limit }),
    name,
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson identify name dispatch", {
    command,
    databaseCount: database.length,
    limit,
    name,
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      knownInputPaths: input.knownInputPaths,
      logLevel: input.logLevel,
      onEvent: relaySimpleProgress(onProgress),
      onLog,
      signal: input.signal,
    }),
  );
  if (!(result.ok && result.exitCode === 0)) {
    await throwRomWeaverFailureWithBrowserOutputContext(result, "Identify failed", `identify \`${name}\``);
  }
  const terminal = getLastEvent(result);
  const details = terminal ? getRomWeaverRunEventDetails(terminal) : undefined;
  const parsed = parseIdentifyCommandResult(details);
  if (!parsed) {
    throw withRomWeaverFailureKind(new Error("Identify result was missing or malformed"), result);
  }
  return { ...parsed, timing: getRunResultTiming(result) };
};

/**
 * Search the validated cross-platform title index through WASM. The index is
 * staged by the browser API because it owns fetch, checksum, and cleanup.
 */
const invokeRomWeaverIdentifyTitlesWorker = async (
  input: {
    knownInputPaths?: string[];
    limit?: number;
    logLevel?: LogLevel | string;
    name: string;
    signal?: AbortSignal;
    titleIndexPath: string;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<ParsedIdentifyTitleSearchResult & { timing: ReturnType<typeof getRunResultTiming> }> => {
  const name = input.name.trim();
  if (!name) throw new Error("Identify name is required");
  const titleIndexPath = input.titleIndexPath.trim();
  if (!titleIndexPath) throw new Error("Identify title index path is required");
  const requestedLimit = input.limit;
  let limit: number | undefined;
  if (requestedLimit === Infinity) limit = 0xffff_ffff;
  else if (typeof requestedLimit === "number" && Number.isFinite(requestedLimit) && requestedLimit >= 0) {
    limit = Math.min(Math.floor(requestedLimit), 0xffff_ffff);
  }
  const command = createRomWeaverCommand("identify", {
    name,
    title_index: titleIndexPath,
    ...(limit === undefined ? {} : { limit }),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson identify title search dispatch", {
    command,
    limit,
    name,
    titleIndexPath,
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      knownInputPaths: input.knownInputPaths,
      logLevel: input.logLevel,
      onEvent: relaySimpleProgress(onProgress),
      onLog,
      signal: input.signal,
    }),
  );
  if (!(result.ok && result.exitCode === 0)) {
    await throwRomWeaverFailureWithBrowserOutputContext(result, "Identify failed", `identify \`${name}\``);
  }
  const terminal = getLastEvent(result);
  const details = terminal ? getRomWeaverRunEventDetails(terminal) : undefined;
  const parsed = parseIdentifyTitleSearchResult(details);
  if (!parsed) {
    throw withRomWeaverFailureKind(new Error("Identify title search result was missing or malformed"), result);
  }
  return { ...parsed, timing: getRunResultTiming(result) };
};

export {
  runRomWeaverIngestSidecarsWorker,
  invokeRomWeaverIngestWorker,
  invokeRomWeaverIdentifyHashWorker,
  invokeRomWeaverIdentifyNameWorker,
  invokeRomWeaverIdentifyTitlesWorker,
};
