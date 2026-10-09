import type { WeaveHeaderMode, ParsedWeaveCreateResult, ParsedWeaveParseResult } from "../../types/weave.ts";
import type { LogLevel } from "../../types/logging.ts";
import type { WorkflowRuntimeLog } from "../../types/workflow-runtime-adapter.ts";
import type { PatchInputRef } from "../../types/workflow-runtime-types.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import type { RomWeaverCommandBranchArgs } from "../../wasm/index.ts";
import { getRomWeaverRunEventDetails } from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { withRomWeaverFailureKind } from "../../workers/rom-weaver/runner-errors.ts";
import { parseWeaveCreateResult, parseWeaveParseResult } from "./weave-result.ts";
import { emitRuntimeTrace, toRomWeaverOptions } from "./run-options.ts";
import { ensureRomWeaverSuccess, getLastEvent } from "./run-result-parsing.ts";
import { runRomWeaverJson, relaySimpleProgress, toTrimmedList } from "./wasm-command-shared.ts";

/** Output naming and header choice; "auto" is the CLI default, so it is omitted. */
const weaveOutputNamingArgs = (input: { outputHeader?: WeaveHeaderMode; outputName?: string; romName?: string }) => ({
  ...(input.outputName ? { output_name: input.outputName } : {}),
  ...(input.romName === undefined ? {} : { rom_name: input.romName.trim() }),
  ...(input.outputHeader && input.outputHeader !== "auto" ? { output_header: input.outputHeader } : {}),
});

/** The weave's declared base-ROM identity, as the CLI's `assume_in` tokens. */
const weaveRomExpectationArgs = (romChecksums: string | undefined, romSize: number | undefined) => {
  const tokens = [
    ...(romChecksums
      ? romChecksums
          .split(",")
          .map((token) => token.trim())
          .filter(Boolean)
      : []),
    ...(typeof romSize === "number" ? [`size=${romSize}`] : []),
  ];
  return tokens.length ? { assume_in: tokens } : {};
};

// Parse a rom-weaver-weave.json weave (plain, compressed, or bundled in an archive) via the `weave parse`
// command. Weaved ROM/patch members are extracted into `extractDirPath`; the parsed result's
// `extracted` source refs point at those leaves.
const invokeRomWeaverWeaveParseWorker = async (
  input: {
    extractDirPath?: string;
    knownInputPaths?: string[];
    logLevel?: LogLevel | string;
    signal?: AbortSignal;
    sourcePath: string;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<ParsedWeaveParseResult> => {
  const sourcePath = String(input.sourcePath || "").trim();
  if (!sourcePath) throw new Error("Weave parse source path is required");
  const extractDirPath = String(input.extractDirPath || "").trim();
  const command = createRomWeaverCommand("weave-parse", {
    input: sourcePath,
    ...(extractDirPath ? { output: extractDirPath } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson weave-parse dispatch", {
    command,
    extractDirPath,
    sourcePath,
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
  ensureRomWeaverSuccess(result, "Weave parse failed");
  const terminal = getLastEvent(result);
  const details = terminal ? getRomWeaverRunEventDetails(terminal) : undefined;
  const parsed = parseWeaveParseResult(details);
  if (!parsed) {
    throw withRomWeaverFailureKind(new Error("Weave parse result was missing or malformed"), result);
  }
  return parsed;
};

// Write a rom-weaver-weave.json weave (and optional everything-weave archive) from staged session files via
// the `weave create` command. Cached ROM checks are forwarded when available;
// Rust hashes only as a compatibility fallback. Per-patch metadata arrays are
// index-aligned with `patchPaths` (or empty).
const getAlignedOptionalFlags = (values: boolean[] | undefined, length: number) => {
  if (!values || values.length !== length || !values.some(Boolean)) return undefined;
  return values;
};

type WeaveCreateMetadataInput = {
  patchBasis?: "auto" | "base" | "previous";
  patchAuthors?: string[];
  patchBases?: Array<"auto" | "base" | "previous">;
  patchDescriptions?: string[];
  patchHeaders?: WeaveHeaderMode[];
  patchIds?: string[];
  patchInputs?: Array<PatchInputRef | null>;
  patchTargets?: Array<PatchInputRef | null>;
  patchInputChecks?: string[];
  patchLabels?: string[];
  patchNames?: string[];
  patchOptionals?: boolean[];
  patchOutputChecks?: string[];
  patchVersions?: string[];
};

const createAlignedWeaveMetadata = (input: WeaveCreateMetadataInput, patchCount: number) => {
  const alignedStrings = (values: string[] | undefined): string[] | undefined => {
    const normalized = (values || []).map((value) => String(value ?? "").trim());
    if (!normalized.some((value) => !!value)) return undefined;
    while (normalized.length < patchCount) normalized.push("");
    return normalized.slice(0, patchCount);
  };
  const patchHeaders =
    input.patchHeaders?.length && input.patchHeaders.some((mode) => mode !== "auto")
      ? Array.from({ length: patchCount }, (_, index) => input.patchHeaders?.[index] || "auto")
      : undefined;
  const patchBases =
    input.patchBases?.length && input.patchBases.some((mode) => mode !== "auto")
      ? Array.from({ length: patchCount }, (_, index) => input.patchBases?.[index] || "auto")
      : undefined;
  const args: Partial<RomWeaverCommandBranchArgs<"weave-create">> = {
    patch_author: alignedStrings(input.patchAuthors),
    patch_basis: patchBases,
    patch_description: alignedStrings(input.patchDescriptions),
    patch_header: patchHeaders,
    patch_id: alignedStrings(input.patchIds),
    patch_input:
      input.patchInputs?.length === patchCount && input.patchInputs.some(Boolean) ? input.patchInputs : undefined,
    patch_target:
      input.patchTargets?.length === patchCount && input.patchTargets.some(Boolean) ? input.patchTargets : undefined,
    patch_input_check: alignedStrings(input.patchInputChecks),
    patch_label: alignedStrings(input.patchLabels),
    patch_name: alignedStrings(input.patchNames),
    patch_optional: getAlignedOptionalFlags(input.patchOptionals, patchCount),
    patch_output_check: alignedStrings(input.patchOutputChecks),
    patch_version: alignedStrings(input.patchVersions),
  };
  for (const key of Object.keys(args) as Array<keyof typeof args>) {
    if (args[key] === undefined) delete args[key];
  }
  return args;
};

const invokeRomWeaverWeaveCreateWorker = async (
  input: {
    weavePath?: string;
    weaveRomPath?: string;
    knownInputPaths?: string[];
    logLevel?: LogLevel | string;
    noWeaveRom?: boolean;
    /** Expected final-output checksums once the full chain is applied ("algo=hex", comma-separable). */
    outputCheck?: string;
    outputHeader?: WeaveHeaderMode;
    romChecksums?: string;
    romMember?: string;
    romName?: string;
    romSize?: number;
    outputName?: string;
    outputPath: string;
    /** Shared v2 weave input rule. */
    patchBasis?: "auto" | "base" | "previous";
    /** Index-aligned declared input basis per patch ("auto" entries stay unwritten). */
    patchBases?: Array<"auto" | "base" | "previous">;
    patchAuthors?: string[];
    patchDescriptions?: string[];
    patchHeaders?: WeaveHeaderMode[];
    patchIds?: string[];
    patchInputs?: Array<PatchInputRef | null>;
    patchTargets?: Array<PatchInputRef | null>;
    /** Index-aligned per-patch expected pre-apply checksums ("algo=hex", comma-separable; empty for none). */
    patchInputChecks?: string[];
    patchLabels?: string[];
    patchNames?: string[];
    patchPaths: string[];
    patchOptionals?: boolean[];
    patchOutputChecks?: string[];
    patchVersions?: string[];
    romPath?: string;
    signal?: AbortSignal;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<ParsedWeaveCreateResult> => {
  const outputPath = String(input.outputPath || "").trim();
  if (!outputPath) throw new Error("Weave create output path is required");
  const patchPaths = toTrimmedList(input.patchPaths);
  if (!patchPaths.length) throw new Error("Weave create requires at least one patch path");
  const [romPath, weavePath, weaveRomPath] = [input.romPath, input.weavePath, input.weaveRomPath].map((value) =>
    String(value || "").trim(),
  ) as [string, string, string];
  // The Rust side requires each metadata array to match the patch count exactly (or be empty), so a
  // partially-filled array is padded with empty strings; empty values round-trip as absent metadata.
  const outputCheck = String(input.outputCheck || "").trim();
  const command = createRomWeaverCommand("weave-create", {
    output: outputPath,
    patch: patchPaths,
    ...(romPath ? { rom: romPath } : {}),
    ...(input.romMember ? { rom_member: input.romMember } : {}),
    ...(weavePath ? { weave: weavePath } : {}),
    ...(weaveRomPath ? { weave_rom: weaveRomPath } : {}),
    ...weaveOutputNamingArgs(input),
    ...weaveRomExpectationArgs(input.romChecksums, input.romSize),
    ...(outputCheck ? { output_check: [outputCheck] } : {}),
    ...createAlignedWeaveMetadata(input, patchPaths.length),
    ...(input.patchBasis ? { default_patch_basis: input.patchBasis } : {}),
    ...(input.noWeaveRom ? { no_weave_rom: true } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson weave-create dispatch", {
    weavePath,
    command,
    outputPath,
    patchCount: patchPaths.length,
    romPath,
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      invalidateMountCacheBeforeRun: true,
      knownInputPaths: input.knownInputPaths,
      logLevel: input.logLevel,
      onEvent: relaySimpleProgress(onProgress),
      onLog,
      signal: input.signal,
    }),
  );
  ensureRomWeaverSuccess(result, "Weave create failed");
  const terminal = getLastEvent(result);
  const details = terminal ? getRomWeaverRunEventDetails(terminal) : undefined;
  const parsed = parseWeaveCreateResult(details);
  if (!parsed) {
    throw withRomWeaverFailureKind(new Error("Weave create result was missing or malformed"), result);
  }
  return parsed;
};

export { invokeRomWeaverWeaveParseWorker, invokeRomWeaverWeaveCreateWorker };
