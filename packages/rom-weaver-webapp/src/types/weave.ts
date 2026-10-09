// Webapp-facing result shapes for the `weave parse` / `weave create` commands. The generated
// wire types carry snake_case fields (and `u64` values that `JSON.parse` yields as plain `number`s);
// these camelCase, `number`-based types are what the webapp consumes. Kept in `types/` (not `lib/`)
// so the runtime adapter type can reference them without an import cycle (mirrors `types/ingest.ts`).
import type { ParsedPatchDescriptor } from "./ingest.ts";
import type { PatchInputRef } from "./workflow-runtime-types.ts";

type WeaveHeaderMode = "keep" | "strip" | "auto";
type WeaveSourceKind = "json" | "compressed-json" | "archive";

/** One resolved weave source: a verbatim URL, a leaf extracted from a bundled
 * archive (already materialized under the parse call's extract dir), or an
 * unresolved weave-relative path (plain rom-weaver-weave.json siblings the host fetches). */
type ParsedWeaveSourceRef =
  | { kind: "url"; url: string }
  | { kind: "extracted"; extractedPath: string }
  | { kind: "path"; path: string };

type ParsedWeaveChecks = {
  checksums?: Record<string, string>;
  size?: number;
};

type ParsedWeavePatchInput = PatchInputRef;

type ParsedWeaveCheckState = { id: string; checks: ParsedWeaveChecks };

type ParsedWeaveRom = {
  member?: string;
  checksRef?: string;
  name?: string;
  url?: string;
  path?: string;
  checks?: ParsedWeaveChecks;
};

type ParsedWeavePatchEntry = {
  input?: ParsedWeavePatchInput;
  /** Cumulative output lane. It does not replace the entry's fixed input. */
  target?: ParsedWeavePatchInput;
  inputChecksRef?: string;
  outputChecksRef?: string;
  /** Stable patch-slot identity retained across source replacements. */
  id?: string;
  /** Author-controlled release version; distinct from the weave schema version. */
  version?: string;
  /** Patch author credit. */
  author?: string;
  name?: string;
  description?: string;
  /** An optional patch starts deselected; absent/false means applied by default. */
  optional?: boolean;
  label?: string;
  url?: string;
  path?: string;
  /** Expected pre-apply ROM state, only when it differs from `rom.checks` (mid-chain). */
  inputChecks?: ParsedWeaveChecks;
  /** Expected post-apply state, only when it differs from the final `output.checks`. */
  outputChecks?: ParsedWeaveChecks;
  header?: WeaveHeaderMode;
  /** Per-entry override of the weave's shared patch input rule. */
  basis?: "base" | "previous";
};

type ParsedWeaveOutput = {
  checksRef?: string;
  name?: string;
  header?: WeaveHeaderMode;
  /** Expected checksums/size of the final output once the full patch chain is applied. */
  checks?: ParsedWeaveChecks;
};

type ParsedWeave = {
  checkStates?: ParsedWeaveCheckState[];
  version: number;
  /** v2 shared patch input rule. v1 weaves omit this and preserve automatic inference. */
  patchBasis?: "auto" | "base" | "previous";
  rom?: ParsedWeaveRom;
  /** Ordered: array order is the apply order. */
  patches: ParsedWeavePatchEntry[];
  output?: ParsedWeaveOutput;
};

type ParsedWeavePatchSource = {
  source: ParsedWeaveSourceRef;
  /** Ingest-grade descriptor for entries extracted from a bundled archive. */
  descriptor?: ParsedPatchDescriptor;
};

type ParsedWeaveParseResult = {
  weave: ParsedWeave;
  sourceKind: WeaveSourceKind;
  archiveMember?: string;
  romSource?: ParsedWeaveSourceRef;
  /** Index-aligned with `weave.patches`. */
  patchSources: ParsedWeavePatchSource[];
  warnings: string[];
};

type ParsedWeaveCreateResult = {
  weavePath: string;
  archivePath?: string;
  weave: ParsedWeave;
  warnings: string[];
};

export type {
  ParsedWeavePatchInput,
  WeaveHeaderMode,
  WeaveSourceKind,
  ParsedWeave,
  ParsedWeaveChecks,
  ParsedWeaveCreateResult,
  ParsedWeaveOutput,
  ParsedWeaveParseResult,
  ParsedWeavePatchEntry,
  ParsedWeavePatchSource,
  ParsedWeaveRom,
  ParsedWeaveSourceRef,
};
