// Webapp-facing result shapes for the `bundle parse` / `bundle create` commands. The generated
// wire types carry snake_case fields (and `u64` values that `JSON.parse` yields as plain `number`s);
// these camelCase, `number`-based types are what the webapp consumes. Kept in `types/` (not `lib/`)
// so the runtime adapter type can reference them without an import cycle (mirrors `types/ingest.ts`).
import type { ParsedPatchDescriptor } from "./ingest.ts";

type BundleHeaderMode = "keep" | "strip" | "auto";
type BundleSourceKind = "json" | "compressed-json" | "archive";

/** One resolved bundle source: a verbatim URL, a leaf extracted from a bundled
 * archive (already materialized under the parse call's extract dir), or an
 * unresolved bundle-relative path (plain rom-weaver-bundle.json siblings the host fetches). */
type ParsedBundleSourceRef =
  | { kind: "url"; url: string }
  | { kind: "extracted"; extractedPath: string }
  | { kind: "path"; path: string };

type ParsedBundleChecks = {
  checksums?: Record<string, string>;
  size?: number;
};

type ParsedBundleRom = {
  name?: string;
  url?: string;
  path?: string;
  checks?: ParsedBundleChecks;
};

type ParsedBundlePatchEntry = {
  /** Stable patch-slot identity retained across source replacements (schema v3). */
  id?: string;
  /** Author-controlled release version; distinct from the bundle schema version (schema v3). */
  version?: string;
  /** Patch author credit (schema v3). */
  author?: string;
  name?: string;
  description?: string;
  /** An optional patch starts deselected; absent/false means applied by default. */
  optional?: boolean;
  label?: string;
  url?: string;
  path?: string;
  /** Expected pre-apply ROM state, only when it differs from `rom.checks` (mid-chain). */
  inputChecks?: ParsedBundleChecks;
  /** Expected post-apply state, only when it differs from the final `output.checks`. */
  outputChecks?: ParsedBundleChecks;
  header?: BundleHeaderMode;
  /** What this patch's input checks were authored against: the bundle's rom (`base`, verified
   * once up front) or the previous selected patch's output (`previous`, the default). Absent
   * means previous/inferred. (schema v2) */
  basis?: "base" | "previous";
};

type ParsedBundleOutput = {
  name?: string;
  header?: BundleHeaderMode;
  /** Expected checksums/size of the final output once the full patch chain is applied. */
  checks?: ParsedBundleChecks;
};

type ParsedBundle = {
  version: number;
  rom?: ParsedBundleRom;
  /** Ordered: array order is the apply order. */
  patches: ParsedBundlePatchEntry[];
  output?: ParsedBundleOutput;
};

type ParsedBundlePatchSource = {
  source: ParsedBundleSourceRef;
  /** Ingest-grade descriptor for entries extracted from a bundled archive. */
  descriptor?: ParsedPatchDescriptor;
};

type ParsedBundleParseResult = {
  bundle: ParsedBundle;
  sourceKind: BundleSourceKind;
  archiveMember?: string;
  romSource?: ParsedBundleSourceRef;
  /** Index-aligned with `bundle.patches`. */
  patchSources: ParsedBundlePatchSource[];
  warnings: string[];
};

type ParsedBundleCreateResult = {
  bundlePath: string;
  archivePath?: string;
  bundle: ParsedBundle;
  warnings: string[];
};

export type {
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
};
