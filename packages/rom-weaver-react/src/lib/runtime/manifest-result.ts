// Parse the `details.manifest` / `details.manifest_create` payloads of terminal `manifest` events
// into webapp-facing results, following the `ingest-result.ts` conventions: snake_case wire fields
// coerce into camelCase `number`-based shapes and `null`/absent optionals are dropped. This is the
// single boundary between the Rust manifest contract and the webapp's manifest session/export flows.
import type {
  ManifestHeaderMode,
  ManifestSourceKind,
  ParsedManifest,
  ParsedManifestChecks,
  ParsedManifestCreateResult,
  ParsedManifestOutput,
  ParsedManifestParseResult,
  ParsedManifestPatchEntry,
  ParsedManifestPatchSource,
  ParsedManifestRom,
  ParsedManifestSourceRef,
} from "../../types/manifest.ts";
import type {
  ManifestCreateResult,
  ManifestOutput,
  ManifestParseResult,
  ManifestPatchEntry,
  ManifestPatchSource,
  ManifestRom,
  RomWeaverManifest,
} from "../../wasm/generated/rom-weaver-rust-types.d.ts";
import { parsePatchDescriptor } from "./ingest-result.ts";
import type { WireRecord } from "./run-result-parsing.ts";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const toStringValue = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const toNumberValue = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") return Number(value);
  return undefined;
};

const toChecksumRecord = (value: unknown): Record<string, string> | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const checksums: Record<string, string> = {};
  for (const [algorithm, raw] of Object.entries(record)) {
    if (typeof raw === "string" && raw) checksums[algorithm.toLowerCase()] = raw;
  }
  return Object.keys(checksums).length ? checksums : undefined;
};

const parseHeaderMode = (value: unknown): ManifestHeaderMode | undefined =>
  value === "keep" || value === "strip" || value === "auto" ? value : undefined;

const parseChecks = (value: unknown): ParsedManifestChecks | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const checks: ParsedManifestChecks = {};
  const checksums = toChecksumRecord(record.checksums);
  if (checksums) checks.checksums = checksums;
  const size = toNumberValue(record.size);
  if (size !== undefined) checks.size = size;
  return Object.keys(checks).length ? checks : undefined;
};

const parseSourceRef = (value: unknown): ParsedManifestSourceRef | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const url = toStringValue(record.url);
  if (url) return { kind: "url", url };
  const extractedPath = toStringValue(record.extracted_path);
  if (extractedPath) return { extractedPath, kind: "extracted" };
  const path = toStringValue(record.path);
  if (path) return { kind: "path", path };
  return undefined;
};

const parseManifestRom = (value: unknown): ParsedManifestRom | undefined => {
  const record = asRecord(value) as WireRecord<ManifestRom> | undefined;
  if (!record) return undefined;
  const rom: ParsedManifestRom = {};
  const name = toStringValue(record.name);
  if (name !== undefined) rom.name = name;
  const url = toStringValue(record.url);
  if (url !== undefined) rom.url = url;
  const path = toStringValue(record.path);
  if (path !== undefined) rom.path = path;
  const checks = parseChecks(record.checks);
  if (checks) rom.checks = checks;
  return rom;
};

const parseManifestPatchEntry = (value: unknown): ParsedManifestPatchEntry => {
  const record = (asRecord(value) || {}) as WireRecord<ManifestPatchEntry>;
  const entry: ParsedManifestPatchEntry = {};
  if (record.optional === true) entry.optional = true;
  const name = toStringValue(record.name);
  if (name !== undefined) entry.name = name;
  const description = toStringValue(record.description);
  if (description !== undefined) entry.description = description;
  const label = toStringValue(record.label);
  if (label !== undefined) entry.label = label;
  const url = toStringValue(record.url);
  if (url !== undefined) entry.url = url;
  const path = toStringValue(record.path);
  if (path !== undefined) entry.path = path;
  const inputChecks = parseChecks(record.inputChecks);
  if (inputChecks) entry.inputChecks = inputChecks;
  const outputChecks = parseChecks(record.outputChecks);
  if (outputChecks) entry.outputChecks = outputChecks;
  const header = parseHeaderMode(record.header);
  if (header !== undefined) entry.header = header;
  return entry;
};

const parseManifestOutput = (value: unknown): ParsedManifestOutput | undefined => {
  const record = asRecord(value) as WireRecord<ManifestOutput> | undefined;
  if (!record) return undefined;
  const output: ParsedManifestOutput = {};
  const name = toStringValue(record.name);
  if (name !== undefined) output.name = name;
  const header = parseHeaderMode(record.header);
  if (header !== undefined) output.header = header;
  const checks = parseChecks(record.checks);
  if (checks) output.checks = checks;
  return Object.keys(output).length ? output : undefined;
};

const parseManifest = (value: unknown): ParsedManifest | undefined => {
  const record = asRecord(value) as WireRecord<RomWeaverManifest> | undefined;
  if (!record) return undefined;
  const version = toNumberValue(record.version);
  if (version === undefined) return undefined;
  const manifest: ParsedManifest = {
    patches: Array.isArray(record.patches) ? record.patches.map(parseManifestPatchEntry) : [],
    version,
  };
  const rom = parseManifestRom(record.rom);
  if (rom) manifest.rom = rom;
  const output = parseManifestOutput(record.output);
  if (output) manifest.output = output;
  return manifest;
};

const parsePatchSource = (value: unknown): ParsedManifestPatchSource | undefined => {
  const record = asRecord(value) as WireRecord<ManifestPatchSource> | undefined;
  if (!record) return undefined;
  const source = parseSourceRef(record.source);
  if (!source) return undefined;
  const descriptor = parsePatchDescriptor(record.descriptor);
  return { source, ...(descriptor ? { descriptor } : {}) };
};

const toWarnings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((warning) => String(warning || "")).filter((warning) => !!warning) : [];

/**
 * Parse the `manifest` object from a terminal event's `details`. Returns `undefined` when the
 * payload is missing or malformed (so callers can fail loudly rather than route on a half-formed
 * result).
 */
const parseManifestParseResult = (details: unknown): ParsedManifestParseResult | undefined => {
  const record = asRecord(asRecord(details)?.manifest) as WireRecord<ManifestParseResult> | undefined;
  if (!record) return undefined;
  const manifest = parseManifest(record.manifest);
  if (!manifest) return undefined;
  const sourceKindRaw = record.source_kind;
  const sourceKind: ManifestSourceKind =
    sourceKindRaw === "compressed-json" || sourceKindRaw === "archive" ? sourceKindRaw : "json";
  const patchSources = Array.isArray(record.patch_sources)
    ? record.patch_sources
        .map(parsePatchSource)
        .filter((source): source is ParsedManifestPatchSource => source !== undefined)
    : [];
  const result: ParsedManifestParseResult = {
    manifest,
    patchSources,
    sourceKind,
    warnings: toWarnings(record.warnings),
  };
  const archiveMember = toStringValue(record.archive_member);
  if (archiveMember !== undefined) result.archiveMember = archiveMember;
  const romSource = parseSourceRef(record.rom_source);
  if (romSource) result.romSource = romSource;
  return result;
};

/** Parse the `manifest_create` object from a terminal event's `details`. */
const parseManifestCreateResult = (details: unknown): ParsedManifestCreateResult | undefined => {
  const record = asRecord(asRecord(details)?.manifest_create) as WireRecord<ManifestCreateResult> | undefined;
  if (!record) return undefined;
  const manifestPath = toStringValue(record.manifest_path);
  const manifest = parseManifest(record.manifest);
  if (!(manifestPath && manifest)) return undefined;
  const result: ParsedManifestCreateResult = {
    manifest,
    manifestPath,
    warnings: toWarnings(record.warnings),
  };
  const bundlePath = toStringValue(record.bundle_path);
  if (bundlePath !== undefined) result.bundlePath = bundlePath;
  return result;
};

export { parseManifestCreateResult, parseManifestParseResult };
