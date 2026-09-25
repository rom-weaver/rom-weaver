import type { BundleHeaderMode, ParsedBundleCreateResult, ParsedBundleParseResult } from "../../types/bundle.ts";
import type { LogLevel } from "../../types/logging.ts";
import type { WorkflowRuntimeLog } from "../../types/workflow-runtime-adapter.ts";
import type { PatchInputRef } from "../../types/workflow-runtime-types.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import type { PatchBasisMode } from "../../wasm/index.ts";
import { getRomWeaverRunEventDetails } from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { withRomWeaverFailureKind } from "../../workers/rom-weaver/runner-errors.ts";
import { parseBundleCreateResult, parseBundleParseResult } from "./bundle-result.ts";
import { emitRuntimeTrace, toRomWeaverOptions } from "./run-options.ts";
import { ensureRomWeaverSuccess, getLastEvent } from "./run-result-parsing.ts";
import { runRomWeaverJson, relaySimpleProgress, toTrimmedList } from "./wasm-command-shared.ts";

/** Output naming and header choice; "auto" is the CLI default, so it is omitted. */
const bundleOutputNamingArgs = (input: { outputHeader?: BundleHeaderMode; outputName?: string; romName?: string }) => ({
  ...(input.outputName ? { output_name: input.outputName } : {}),
  ...(input.romName === undefined ? {} : { rom_name: input.romName.trim() }),
  ...(input.outputHeader && input.outputHeader !== "auto" ? { output_header: input.outputHeader } : {}),
});

/** The bundle's declared base-ROM identity, as the CLI's `assume_in` tokens. */
const bundleRomExpectationArgs = (romChecksums: string | undefined, romSize: number | undefined) => {
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

/**
 * Index-aligned per-patch metadata. `createAlignedBundleMetadata` returns
 * undefined for a field nothing declared, and an absent flag is what tells Rust
 * to skip that array entirely.
 */
const perPatchMetadataArgs = (fields: {
  patchAuthors?: string[];
  patchBases?: PatchBasisMode[];
  patchDescriptions?: string[];
  patchHeaders?: BundleHeaderMode[];
  patchIds?: string[];
  patchInputs?: Array<PatchInputRef | null>;
  patchTargets?: Array<PatchInputRef | null>;
  patchInputChecks?: string[];
  patchLabels?: string[];
  patchNames?: string[];
  patchOptionals?: boolean[];
  patchOutputChecks?: string[];
  patchVersions?: string[];
}) => ({
  ...(fields.patchNames ? { patch_name: fields.patchNames } : {}),
  ...(fields.patchIds ? { patch_id: fields.patchIds } : {}),
  ...(fields.patchInputs ? { patch_input: fields.patchInputs } : {}),
  ...(fields.patchTargets ? { patch_target: fields.patchTargets } : {}),
  ...(fields.patchDescriptions ? { patch_description: fields.patchDescriptions } : {}),
  ...(fields.patchVersions ? { patch_version: fields.patchVersions } : {}),
  ...(fields.patchAuthors ? { patch_author: fields.patchAuthors } : {}),
  ...(fields.patchLabels ? { patch_label: fields.patchLabels } : {}),
  ...(fields.patchOptionals ? { patch_optional: fields.patchOptionals } : {}),
  ...(fields.patchHeaders ? { patch_header: fields.patchHeaders } : {}),
  ...(fields.patchBases ? { patch_basis: fields.patchBases } : {}),
  ...(fields.patchInputChecks ? { patch_input_check: fields.patchInputChecks } : {}),
  ...(fields.patchOutputChecks ? { patch_output_check: fields.patchOutputChecks } : {}),
});

// Parse a rom-weaver-bundle.json bundle (plain, compressed, or bundled in an archive) via the `bundle parse`
// command. Bundled ROM/patch members are extracted into `extractDirPath`; the parsed result's
// `extracted` source refs point at those leaves.
const invokeRomWeaverBundleParseWorker = async (
  input: {
    extractDirPath?: string;
    knownInputPaths?: string[];
    logLevel?: LogLevel | string;
    signal?: AbortSignal;
    sourcePath: string;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<ParsedBundleParseResult> => {
  const sourcePath = String(input.sourcePath || "").trim();
  if (!sourcePath) throw new Error("Bundle parse source path is required");
  const extractDirPath = String(input.extractDirPath || "").trim();
  const command = createRomWeaverCommand("bundle-parse", {
    input: sourcePath,
    ...(extractDirPath ? { output: extractDirPath } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson bundle-parse dispatch", {
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
  ensureRomWeaverSuccess(result, "Bundle parse failed");
  const terminal = getLastEvent(result);
  const details = terminal ? getRomWeaverRunEventDetails(terminal) : undefined;
  const parsed = parseBundleParseResult(details);
  if (!parsed) {
    throw withRomWeaverFailureKind(new Error("Bundle parse result was missing or malformed"), result);
  }
  return parsed;
};

// Write a rom-weaver-bundle.json bundle (and optional everything-bundle archive) from staged session files via
// the `bundle create` command. Cached ROM checks are forwarded when available;
// Rust hashes only as a compatibility fallback. Per-patch metadata arrays are
// index-aligned with `patchPaths` (or empty).
const getAlignedOptionalFlags = (values: boolean[] | undefined, length: number) => {
  if (!values || values.length !== length || !values.some(Boolean)) return undefined;
  return values;
};

type BundleCreateMetadataInput = {
  patchBasis?: "auto" | "base" | "previous";
  patchAuthors?: string[];
  patchBases?: Array<"auto" | "base" | "previous">;
  patchDescriptions?: string[];
  patchHeaders?: BundleHeaderMode[];
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

const createAlignedBundleMetadata = (input: BundleCreateMetadataInput, patchCount: number) => {
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
  return {
    patchAuthors: alignedStrings(input.patchAuthors),
    patchBases,
    patchDescriptions: alignedStrings(input.patchDescriptions),
    patchHeaders,
    patchIds: alignedStrings(input.patchIds),
    patchInputs:
      input.patchInputs?.length === patchCount && input.patchInputs.some(Boolean) ? input.patchInputs : undefined,
    patchTargets:
      input.patchTargets?.length === patchCount && input.patchTargets.some(Boolean) ? input.patchTargets : undefined,
    patchInputChecks: alignedStrings(input.patchInputChecks),
    patchLabels: alignedStrings(input.patchLabels),
    patchNames: alignedStrings(input.patchNames),
    patchOptionals: getAlignedOptionalFlags(input.patchOptionals, patchCount),
    patchOutputChecks: alignedStrings(input.patchOutputChecks),
    patchVersions: alignedStrings(input.patchVersions),
  };
};

const invokeRomWeaverBundleCreateWorker = async (
  input: {
    bundlePath?: string;
    bundleRomPath?: string;
    knownInputPaths?: string[];
    logLevel?: LogLevel | string;
    noBundleRom?: boolean;
    /** Expected final-output checksums once the full chain is applied ("algo=hex", comma-separable). */
    outputCheck?: string;
    outputHeader?: BundleHeaderMode;
    romChecksums?: string;
    romMember?: string;
    romName?: string;
    romSize?: number;
    outputName?: string;
    outputPath: string;
    /** Shared v2 bundle input rule. */
    patchBasis?: "auto" | "base" | "previous";
    /** Index-aligned declared input basis per patch ("auto" entries stay unwritten). */
    patchBases?: Array<"auto" | "base" | "previous">;
    patchAuthors?: string[];
    patchDescriptions?: string[];
    patchHeaders?: BundleHeaderMode[];
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
): Promise<ParsedBundleCreateResult> => {
  const outputPath = String(input.outputPath || "").trim();
  if (!outputPath) throw new Error("Bundle create output path is required");
  const patchPaths = toTrimmedList(input.patchPaths);
  if (!patchPaths.length) throw new Error("Bundle create requires at least one patch path");
  const [romPath, bundlePath, bundleRomPath] = [input.romPath, input.bundlePath, input.bundleRomPath].map((value) =>
    String(value || "").trim(),
  ) as [string, string, string];
  // The Rust side requires each metadata array to match the patch count exactly (or be empty), so a
  // partially-filled array is padded with empty strings; empty values round-trip as absent metadata.
  const {
    patchAuthors,
    patchBases,
    patchDescriptions,
    patchHeaders,
    patchIds,
    patchInputs,
    patchTargets,
    patchInputChecks,
    patchLabels,
    patchNames,
    patchOptionals,
    patchOutputChecks,
    patchVersions,
  } = createAlignedBundleMetadata(input, patchPaths.length);
  const outputCheck = String(input.outputCheck || "").trim();
  const command = createRomWeaverCommand("bundle-create", {
    output: outputPath,
    patch: patchPaths,
    ...(romPath ? { rom: romPath } : {}),
    ...(input.romMember ? { rom_member: input.romMember } : {}),
    ...(bundlePath ? { bundle: bundlePath } : {}),
    ...(bundleRomPath ? { bundle_rom: bundleRomPath } : {}),
    ...bundleOutputNamingArgs(input),
    ...bundleRomExpectationArgs(input.romChecksums, input.romSize),
    ...(outputCheck ? { output_check: [outputCheck] } : {}),
    ...perPatchMetadataArgs({
      patchAuthors,
      patchBases,
      patchDescriptions,
      patchHeaders,
      patchIds,
      patchInputs,
      patchTargets,
      patchInputChecks,
      patchLabels,
      patchNames,
      patchOptionals,
      patchOutputChecks,
      patchVersions,
    }),
    ...(input.patchBasis ? { default_patch_basis: input.patchBasis } : {}),
    ...(input.noBundleRom ? { no_bundle_rom: true } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson bundle-create dispatch", {
    bundlePath,
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
  ensureRomWeaverSuccess(result, "Bundle create failed");
  const terminal = getLastEvent(result);
  const details = terminal ? getRomWeaverRunEventDetails(terminal) : undefined;
  const parsed = parseBundleCreateResult(details);
  if (!parsed) {
    throw withRomWeaverFailureKind(new Error("Bundle create result was missing or malformed"), result);
  }
  return parsed;
};

export { invokeRomWeaverBundleParseWorker, invokeRomWeaverBundleCreateWorker };
