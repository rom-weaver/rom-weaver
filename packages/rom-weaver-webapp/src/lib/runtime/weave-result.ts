// Parse the `details.weave` / `details.weave_create` payloads of terminal `weave` events
// into webapp-facing results, following the `ingest-result.ts` conventions: snake_case wire fields
// coerce into camelCase `number`-based shapes and `null`/absent optionals are dropped. This is the
// single boundary between the Rust weave contract and the webapp's weave session/export flows.
import type {
  WeaveHeaderMode,
  WeaveSourceKind,
  ParsedWeave,
  ParsedWeaveChecks,
  ParsedWeaveCreateResult,
  ParsedWeaveOutput,
  ParsedWeaveParseResult,
  ParsedWeavePatchEntry,
  ParsedWeavePatchInput,
  ParsedWeavePatchSource,
  ParsedWeaveRom,
  ParsedWeaveSourceRef,
} from "../../types/weave.ts";
import type {
  WeaveCreateResult,
  WeaveOutput,
  WeaveParseResult,
  WeavePatchEntry,
  WeavePatchSource,
  WeaveRom,
  RomWeaverWeave,
} from "../../wasm/generated/rom-weaver-rust-types.d.ts";
import { parsePatchDescriptor } from "./ingest-result.ts";
import type { WireRecord } from "./run-result-parsing.ts";
import { asRecord, toNumberValue, toStringValue } from "./strict-wire-values.ts";

const toChecksumRecord = (value: unknown): Record<string, string> | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const checksums: Record<string, string> = {};
  for (const [algorithm, raw] of Object.entries(record)) {
    if (typeof raw === "string" && raw) checksums[algorithm.toLowerCase()] = raw;
  }
  return Object.keys(checksums).length ? checksums : undefined;
};

const parseHeaderMode = (value: unknown): WeaveHeaderMode | undefined =>
  value === "keep" || value === "strip" || value === "auto" ? value : undefined;

const parseChecks = (value: unknown): ParsedWeaveChecks | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const checks: ParsedWeaveChecks = {};
  const checksums = toChecksumRecord(record.checksums);
  if (checksums) checks.checksums = checksums;
  const size = toNumberValue(record.size);
  if (size !== undefined) checks.size = size;
  return Object.keys(checks).length ? checks : undefined;
};

const parsePatchInput = (value: unknown): ParsedWeavePatchInput | undefined => {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  if (record?.rom === true && record.patch === undefined) {
    const member = toStringValue(record.member);
    return { rom: true, ...(member ? { member } : {}) };
  }
  const patch = toStringValue(record?.patch);
  if (patch && record?.rom === undefined) {
    const member = toStringValue(record?.member);
    return { patch, ...(member ? { member } : {}) };
  }
  throw new Error("Weave patch input is invalid");
};

const parseSourceRef = (value: unknown): ParsedWeaveSourceRef | undefined => {
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

const parseWeaveRom = (value: unknown): ParsedWeaveRom | undefined => {
  const record = asRecord(value) as WireRecord<WeaveRom> | undefined;
  if (!record) return undefined;
  const rom: ParsedWeaveRom = {};
  const member = toStringValue(record.member);
  if (member) rom.member = member;
  const checksRef = toStringValue(record.checksRef);
  if (checksRef) rom.checksRef = checksRef;
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

const parseWeavePatchEntry = (value: unknown): ParsedWeavePatchEntry => {
  const record = (asRecord(value) || {}) as WireRecord<WeavePatchEntry>;
  const entry: ParsedWeavePatchEntry = {};
  const input = parsePatchInput(record.input);
  if (input) entry.input = input;
  const target = parsePatchInput(record.target);
  if (target) entry.target = target;
  const inputChecksRef = toStringValue(record.inputChecksRef);
  if (inputChecksRef) entry.inputChecksRef = inputChecksRef;
  const outputChecksRef = toStringValue(record.outputChecksRef);
  if (outputChecksRef) entry.outputChecksRef = outputChecksRef;
  const id = toStringValue(record.id);
  if (id !== undefined) entry.id = id;
  const version = toStringValue(record.version);
  if (version !== undefined) entry.version = version;
  if (record.optional === true) entry.optional = true;
  const name = toStringValue(record.name);
  if (name !== undefined) entry.name = name;
  const description = toStringValue(record.description);
  if (description !== undefined) entry.description = description;
  const author = toStringValue(record.author);
  if (author !== undefined) entry.author = author;
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

const parseWeaveOutput = (value: unknown): ParsedWeaveOutput | undefined => {
  const record = asRecord(value) as WireRecord<WeaveOutput> | undefined;
  if (!record) return undefined;
  const output: ParsedWeaveOutput = {};
  const checksRef = toStringValue(record.checksRef);
  if (checksRef) output.checksRef = checksRef;
  const name = toStringValue(record.name);
  if (name !== undefined) output.name = name;
  const header = parseHeaderMode(record.header);
  if (header !== undefined) output.header = header;
  const checks = parseChecks(record.checks);
  if (checks) output.checks = checks;
  return Object.keys(output).length ? output : undefined;
};

const parseWeave = (value: unknown): ParsedWeave | undefined => {
  const record = asRecord(value) as WireRecord<RomWeaverWeave> | undefined;
  if (!record) return undefined;
  const version = toNumberValue(record.version);
  if (version === undefined) return undefined;
  const weave: ParsedWeave = {
    patches: Array.isArray(record.patches) ? record.patches.map(parseWeavePatchEntry) : [],
    version,
  };
  if (Array.isArray(record.checkStates)) {
    weave.checkStates = record.checkStates.map((value) => {
      const state = asRecord(value);
      const id = toStringValue(state?.id);
      const checks = parseChecks(state?.checks);
      if (!(id && checks)) throw new Error("Weave check state is invalid");
      return { id, checks };
    });
  }
  if (record.patchBasis === "auto" || record.patchBasis === "base" || record.patchBasis === "previous") {
    weave.patchBasis = record.patchBasis;
  }
  const rom = parseWeaveRom(record.rom);
  if (rom) weave.rom = rom;
  const output = parseWeaveOutput(record.output);
  if (output) weave.output = output;
  return weave;
};

const parsePatchSource = (value: unknown): ParsedWeavePatchSource | undefined => {
  const record = asRecord(value) as WireRecord<WeavePatchSource> | undefined;
  if (!record) return undefined;
  const source = parseSourceRef(record.source);
  if (!source) return undefined;
  const descriptor = parsePatchDescriptor(record.descriptor);
  return { source, ...(descriptor ? { descriptor } : {}) };
};

const toWarnings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((warning) => String(warning || "")).filter((warning) => !!warning) : [];

/**
 * A weave may record cheat selections. `ParsedWeave` does not carry them yet, so parsing drops
 * them; say so rather than reduce the weave silently. The CLI reproduces such a weave in full.
 */
const cheatWarnings = (weaveRecord: unknown): string[] => {
  const cheats = asRecord(weaveRecord)?.cheats;
  if (!Array.isArray(cheats) || cheats.length === 0) return [];
  return [
    `this weave records ${cheats.length} cheat selection${cheats.length === 1 ? "" : "s"}, which this app does not apply yet; apply it with the rom-weaver CLI to include them`,
  ];
};

/**
 * Parse the `weave` object from a terminal event's `details`. Returns `undefined` when the
 * payload is missing or malformed (so callers can fail loudly rather than route on a half-formed
 * result).
 */
const parseWeaveParseResult = (details: unknown): ParsedWeaveParseResult | undefined => {
  const record = asRecord(asRecord(details)?.weave) as WireRecord<WeaveParseResult> | undefined;
  if (!record) return undefined;
  const weave = parseWeave(record.weave);
  if (!weave) return undefined;
  const sourceKindRaw = record.source_kind;
  const sourceKind: WeaveSourceKind =
    sourceKindRaw === "compressed-json" || sourceKindRaw === "archive" ? sourceKindRaw : "json";
  const patchSources = Array.isArray(record.patch_sources)
    ? record.patch_sources
        .map(parsePatchSource)
        .filter((source): source is ParsedWeavePatchSource => source !== undefined)
    : [];
  const result: ParsedWeaveParseResult = {
    weave,
    patchSources,
    sourceKind,
    warnings: [...toWarnings(record.warnings), ...cheatWarnings(record.weave)],
  };
  const archiveMember = toStringValue(record.archive_member);
  if (archiveMember !== undefined) result.archiveMember = archiveMember;
  const romSource = parseSourceRef(record.rom_source);
  if (romSource) result.romSource = romSource;
  return result;
};

/** Parse the `weave_create` object from a terminal event's `details`. */
const parseWeaveCreateResult = (details: unknown): ParsedWeaveCreateResult | undefined => {
  const record = asRecord(asRecord(details)?.weave_create) as WireRecord<WeaveCreateResult> | undefined;
  if (!record) return undefined;
  const weavePath = toStringValue(record.weave_path);
  const weave = parseWeave(record.weave);
  if (!(weavePath && weave)) return undefined;
  const result: ParsedWeaveCreateResult = {
    weave,
    weavePath,
    warnings: [...toWarnings(record.warnings), ...cheatWarnings(record.weave)],
  };
  const archivePath = toStringValue(record.archive_path);
  if (archivePath !== undefined) result.archivePath = archivePath;
  return result;
};

export { parseWeaveCreateResult, parseWeaveParseResult };
