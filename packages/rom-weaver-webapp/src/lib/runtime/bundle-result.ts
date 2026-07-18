// Parse the `details.bundle` / `details.bundle_create` payloads of terminal `bundle` events
// into webapp-facing results, following the `ingest-result.ts` conventions: snake_case wire fields
// coerce into camelCase `number`-based shapes and `null`/absent optionals are dropped. This is the
// single boundary between the Rust bundle contract and the webapp's bundle session/export flows.
import type {
  BundleHeaderMode,
  BundleSourceKind,
  ParsedBundle,
  ParsedBundleChecks,
  ParsedBundleCreateResult,
  ParsedBundleOutput,
  ParsedBundleParseResult,
  ParsedBundlePatchEntry,
  ParsedBundlePatchSource,
  ParsedBundleRom,
  ParsedBundleSourceRef,
} from "../../types/bundle.ts";
import type {
  BundleCreateResult,
  BundleOutput,
  BundleParseResult,
  BundlePatchEntry,
  BundlePatchSource,
  BundleRom,
  RomWeaverBundle,
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

const parseHeaderMode = (value: unknown): BundleHeaderMode | undefined =>
  value === "keep" || value === "strip" || value === "auto" ? value : undefined;

const parseChecks = (value: unknown): ParsedBundleChecks | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const checks: ParsedBundleChecks = {};
  const checksums = toChecksumRecord(record.checksums);
  if (checksums) checks.checksums = checksums;
  const size = toNumberValue(record.size);
  if (size !== undefined) checks.size = size;
  return Object.keys(checks).length ? checks : undefined;
};

const parseSourceRef = (value: unknown): ParsedBundleSourceRef | undefined => {
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

const parseBundleRom = (value: unknown): ParsedBundleRom | undefined => {
  const record = asRecord(value) as WireRecord<BundleRom> | undefined;
  if (!record) return undefined;
  const rom: ParsedBundleRom = {};
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

const parseBundlePatchEntry = (value: unknown): ParsedBundlePatchEntry => {
  const record = (asRecord(value) || {}) as WireRecord<BundlePatchEntry>;
  const entry: ParsedBundlePatchEntry = {};
  const id = toStringValue(record.id);
  if (id !== undefined) entry.id = id;
  const version = toStringValue(record.version);
  if (version !== undefined) entry.version = version;
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
  if (record.basis === "base" || record.basis === "previous") entry.basis = record.basis;
  return entry;
};

const parseBundleOutput = (value: unknown): ParsedBundleOutput | undefined => {
  const record = asRecord(value) as WireRecord<BundleOutput> | undefined;
  if (!record) return undefined;
  const output: ParsedBundleOutput = {};
  const name = toStringValue(record.name);
  if (name !== undefined) output.name = name;
  const header = parseHeaderMode(record.header);
  if (header !== undefined) output.header = header;
  const checks = parseChecks(record.checks);
  if (checks) output.checks = checks;
  return Object.keys(output).length ? output : undefined;
};

const parseBundle = (value: unknown): ParsedBundle | undefined => {
  const record = asRecord(value) as WireRecord<RomWeaverBundle> | undefined;
  if (!record) return undefined;
  const version = toNumberValue(record.version);
  if (version === undefined) return undefined;
  const bundle: ParsedBundle = {
    patches: Array.isArray(record.patches) ? record.patches.map(parseBundlePatchEntry) : [],
    version,
  };
  const rom = parseBundleRom(record.rom);
  if (rom) bundle.rom = rom;
  const output = parseBundleOutput(record.output);
  if (output) bundle.output = output;
  return bundle;
};

const parsePatchSource = (value: unknown): ParsedBundlePatchSource | undefined => {
  const record = asRecord(value) as WireRecord<BundlePatchSource> | undefined;
  if (!record) return undefined;
  const source = parseSourceRef(record.source);
  if (!source) return undefined;
  const descriptor = parsePatchDescriptor(record.descriptor);
  return { source, ...(descriptor ? { descriptor } : {}) };
};

const toWarnings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((warning) => String(warning || "")).filter((warning) => !!warning) : [];

/**
 * Parse the `bundle` object from a terminal event's `details`. Returns `undefined` when the
 * payload is missing or malformed (so callers can fail loudly rather than route on a half-formed
 * result).
 */
const parseBundleParseResult = (details: unknown): ParsedBundleParseResult | undefined => {
  const record = asRecord(asRecord(details)?.bundle) as WireRecord<BundleParseResult> | undefined;
  if (!record) return undefined;
  const bundle = parseBundle(record.bundle);
  if (!bundle) return undefined;
  const sourceKindRaw = record.source_kind;
  const sourceKind: BundleSourceKind =
    sourceKindRaw === "compressed-json" || sourceKindRaw === "archive" ? sourceKindRaw : "json";
  const patchSources = Array.isArray(record.patch_sources)
    ? record.patch_sources
        .map(parsePatchSource)
        .filter((source): source is ParsedBundlePatchSource => source !== undefined)
    : [];
  const result: ParsedBundleParseResult = {
    bundle,
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

/** Parse the `bundle_create` object from a terminal event's `details`. */
const parseBundleCreateResult = (details: unknown): ParsedBundleCreateResult | undefined => {
  const record = asRecord(asRecord(details)?.bundle_create) as WireRecord<BundleCreateResult> | undefined;
  if (!record) return undefined;
  const bundlePath = toStringValue(record.bundle_path);
  const bundle = parseBundle(record.bundle);
  if (!(bundlePath && bundle)) return undefined;
  const result: ParsedBundleCreateResult = {
    bundle,
    bundlePath,
    warnings: toWarnings(record.warnings),
  };
  const archivePath = toStringValue(record.archive_path);
  if (archivePath !== undefined) result.archivePath = archivePath;
  return result;
};

export { parseBundleCreateResult, parseBundleParseResult };
