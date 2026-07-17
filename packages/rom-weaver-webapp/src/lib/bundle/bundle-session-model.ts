// Pure mapping from a parsed rom-weaver-bundle.json bundle to the webapp's apply-session plan: which sources to
// acquire (URLs resolved against the bundle's own URL, or leaves already extracted from a bundled
// archive), the per-patch enablement seed, and the one-shot output defaults. No I/O here - the
// url-session boot flow feeds this into fetch/materialize and the apply form consumes the result.
import type {
  BundleHeaderMode,
  ParsedBundle,
  ParsedBundleChecks,
  ParsedBundleParseResult,
  ParsedBundleSourceRef,
} from "../../types/bundle.ts";

type BundleAcquisition = { kind: "url"; url: string } | { kind: "extracted"; extractedPath: string };

type BundlePlanEntry = {
  acquisition: BundleAcquisition;
  name?: string;
  description?: string;
  label?: string;
  /** Optional patches start deselected; everything else starts on. */
  optional: boolean;
  /** Only checks the patch itself declared - chain-endpoint verification (rom/output checks) is session-level. */
  inputChecks?: ParsedBundleChecks;
  outputChecks?: ParsedBundleChecks;
  header?: BundleHeaderMode;
  /** Declared input basis (`base` = authored against the bundle's rom; absent = previous/inferred). */
  basis?: "base" | "previous";
};

type BundleOutputDefaults = {
  name?: string;
  header?: BundleHeaderMode;
};

/** What ROM the bundle expects the user to supply when it ships none itself. */
type BundleRomExpectation = {
  name?: string;
  checks?: ParsedBundleChecks;
};

type BundleApplySessionPlan = {
  /** Identity key for run-once guards (the bundle URL; the boot flow may suffix an attempt). */
  key: string;
  name?: string;
  warnings: string[];
  romAcquisition?: BundleAcquisition;
  /** Set when the bundle ships no ROM: the expected ROM the user must supply. */
  romExpectation?: BundleRomExpectation;
  /** Bundle order = apply order; index-aligned with the acquired patch files. */
  entries: BundlePlanEntry[];
  /** ROM/final-output verification for the run (seeds the input/output validation checksums). */
  chainEndpointChecks: BundleChainEndpointChecks;
  outputDefaults: BundleOutputDefaults;
};

/** A plan entry decorated with the acquired file's name (the drop-pipeline matching key). */
type BundleApplySessionEntry = BundlePlanEntry & { fileName: string };

/** The plan after acquisition, as handed to the apply form. */
type BundleApplySession = Omit<BundleApplySessionPlan, "entries" | "romAcquisition"> & {
  romFileName?: string;
  entries: BundleApplySessionEntry[];
};

/** The verification endpoints of the full patch chain. */
type BundleChainEndpointChecks = {
  input?: ParsedBundleChecks;
  output?: ParsedBundleChecks;
};

/**
 * The chain's verification endpoints: what the base ROM must be (the first
 * patch's own `inputChecks`, else the bundle's `rom.checks`) and what the
 * final result must be (the last patch's own `outputChecks`, else
 * `output.checks`). These verify the ROM and the run's output - they are NOT
 * attributed to individual patches: a patch's card only shows checks the
 * patch itself declared.
 */
const bundleChainEndpointChecks = (bundle: ParsedBundle): BundleChainEndpointChecks => {
  const input = bundle.patches[0]?.inputChecks || bundle.rom?.checks;
  const output = bundle.patches.at(-1)?.outputChecks || bundle.output?.checks;
  return { ...(input ? { input } : {}), ...(output ? { output } : {}) };
};

/** Display name for a bundle session, derived from its output/rom naming. */
const bundleSessionDisplayName = (bundle: ParsedBundle): string | undefined => bundle.output?.name || bundle.rom?.name;

/** The expected-ROM details to surface when the bundle ships no ROM source. */
const bundleRomExpectation = (bundle: ParsedBundle): BundleRomExpectation | undefined => {
  const rom = bundle.rom;
  if (!rom || rom.url || rom.path) return undefined;
  const expectation: BundleRomExpectation = {
    ...(rom.name ? { name: rom.name } : {}),
    ...(rom.checks ? { checks: rom.checks } : {}),
  };
  return Object.keys(expectation).length ? expectation : undefined;
};

const resolveBundleRelativeUrl = (raw: string, bundleUrl: string, label: string): string => {
  try {
    // URL values are verbatim in the bundle; relative ones (and plain `path` entries, which are
    // siblings of the fetched rom-weaver-bundle.json) resolve against the bundle's own URL.
    return new URL(raw, bundleUrl).toString();
  } catch {
    throw new Error(`Bundle ${label} URL is not resolvable: ${raw}`);
  }
};

const toAcquisition = (source: ParsedBundleSourceRef, bundleUrl: string, label: string): BundleAcquisition => {
  if (source.kind === "extracted") return { extractedPath: source.extractedPath, kind: "extracted" };
  if (source.kind === "url") return { kind: "url", url: resolveBundleRelativeUrl(source.url, bundleUrl, label) };
  return { kind: "url", url: resolveBundleRelativeUrl(source.path, bundleUrl, label) };
};

const toOutputDefaults = (parsed: ParsedBundleParseResult): BundleOutputDefaults => {
  const output = parsed.bundle.output;
  if (!output) return {};
  const defaults: BundleOutputDefaults = {};
  if (output.name) defaults.name = output.name;
  if (output.header) defaults.header = output.header;
  return defaults;
};

/**
 * Build the acquisition + session plan from a `bundle parse` result. Every patch is acquired and
 * remains toggleable; `optional` only seeds its initial on/off state.
 */
const buildBundleApplySessionPlan = (parsed: ParsedBundleParseResult, bundleUrl: string): BundleApplySessionPlan => {
  const entries: BundlePlanEntry[] = [];
  parsed.bundle.patches.forEach((patch, index) => {
    const patchSource = parsed.patchSources[index];
    if (!patchSource) throw new Error(`Bundle patch ${index + 1} has no resolved source`);
    entries.push({
      acquisition: toAcquisition(patchSource.source, bundleUrl, `patch ${index + 1}`),
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.description ? { description: patch.description } : {}),
      ...(patch.label ? { label: patch.label } : {}),
      optional: patch.optional === true,
      ...(patch.inputChecks ? { inputChecks: patch.inputChecks } : {}),
      ...(patch.outputChecks ? { outputChecks: patch.outputChecks } : {}),
      ...(patch.header ? { header: patch.header } : {}),
      ...(patch.basis ? { basis: patch.basis } : {}),
    });
  });
  const name = bundleSessionDisplayName(parsed.bundle);
  const romExpectation = parsed.romSource ? undefined : bundleRomExpectation(parsed.bundle);
  return {
    chainEndpointChecks: bundleChainEndpointChecks(parsed.bundle),
    entries,
    key: bundleUrl,
    ...(name ? { name } : {}),
    outputDefaults: toOutputDefaults(parsed),
    ...(parsed.romSource ? { romAcquisition: toAcquisition(parsed.romSource, bundleUrl, "rom") } : {}),
    ...(romExpectation ? { romExpectation } : {}),
    warnings: parsed.warnings.slice(),
  };
};

export type { BundleApplySession, BundleApplySessionEntry, BundleRomExpectation };
export { buildBundleApplySessionPlan, bundleChainEndpointChecks, bundleRomExpectation, bundleSessionDisplayName };
