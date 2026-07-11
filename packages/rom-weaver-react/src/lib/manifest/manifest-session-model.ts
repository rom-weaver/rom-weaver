// Pure mapping from a parsed rw.json manifest to the webapp's apply-session plan: which sources to
// acquire (URLs resolved against the manifest's own URL, or leaves already extracted from a bundled
// archive), the per-patch enablement seed, and the one-shot output defaults. No I/O here — the
// url-session boot flow feeds this into fetch/materialize and the apply form consumes the result.
import type {
  ManifestHeaderMode,
  ParsedManifest,
  ParsedManifestChecks,
  ParsedManifestParseResult,
  ParsedManifestSourceRef,
} from "../../types/manifest.ts";

type ManifestAcquisition = { kind: "url"; url: string } | { kind: "extracted"; extractedPath: string };

type ManifestPlanEntry = {
  acquisition: ManifestAcquisition;
  name?: string;
  description?: string;
  label?: string;
  /** Optional patches start deselected; everything else starts on. */
  optional: boolean;
  /** Only checks the patch itself declared — chain-endpoint verification (rom/output checks) is session-level. */
  inputChecks?: ParsedManifestChecks;
  outputChecks?: ParsedManifestChecks;
  header?: ManifestHeaderMode;
};

type ManifestOutputDefaults = {
  name?: string;
  header?: ManifestHeaderMode;
};

/** What ROM the manifest expects the user to supply when it ships none itself. */
type ManifestRomExpectation = {
  name?: string;
  checks?: ParsedManifestChecks;
};

type ManifestApplySessionPlan = {
  /** Identity key for run-once guards (the manifest URL; the boot flow may suffix an attempt). */
  key: string;
  name?: string;
  warnings: string[];
  romAcquisition?: ManifestAcquisition;
  /** Set when the manifest ships no ROM: the expected ROM the user must supply. */
  romExpectation?: ManifestRomExpectation;
  /** Manifest order = apply order; index-aligned with the acquired patch files. */
  entries: ManifestPlanEntry[];
  /** ROM/final-output verification for the run (seeds the input/output validation checksums). */
  chainEndpointChecks: ManifestChainEndpointChecks;
  outputDefaults: ManifestOutputDefaults;
};

/** A plan entry decorated with the acquired file's name (the drop-pipeline matching key). */
type ManifestApplySessionEntry = ManifestPlanEntry & { fileName: string };

/** The plan after acquisition, as handed to the apply form. */
type ManifestApplySession = Omit<ManifestApplySessionPlan, "entries" | "romAcquisition"> & {
  romFileName?: string;
  entries: ManifestApplySessionEntry[];
};

/** The verification endpoints of the full patch chain. */
type ManifestChainEndpointChecks = {
  input?: ParsedManifestChecks;
  output?: ParsedManifestChecks;
};

/**
 * The chain's verification endpoints: what the base ROM must be (the first
 * patch's own `inputChecks`, else the manifest's `rom.checks`) and what the
 * final result must be (the last patch's own `outputChecks`, else
 * `output.checks`). These verify the ROM and the run's output — they are NOT
 * attributed to individual patches: a patch's card only shows checks the
 * patch itself declared.
 */
const manifestChainEndpointChecks = (manifest: ParsedManifest): ManifestChainEndpointChecks => {
  const input = manifest.patches[0]?.inputChecks || manifest.rom?.checks;
  const output = manifest.patches.at(-1)?.outputChecks || manifest.output?.checks;
  return { ...(input ? { input } : {}), ...(output ? { output } : {}) };
};

/** Display name for a manifest session, derived from its output/rom naming. */
const manifestSessionDisplayName = (manifest: ParsedManifest): string | undefined =>
  manifest.output?.name || manifest.rom?.name;

/** The expected-ROM details to surface when the manifest ships no ROM source. */
const manifestRomExpectation = (manifest: ParsedManifest): ManifestRomExpectation | undefined => {
  const rom = manifest.rom;
  if (!rom || rom.url || rom.path) return undefined;
  const expectation: ManifestRomExpectation = {
    ...(rom.name ? { name: rom.name } : {}),
    ...(rom.checks ? { checks: rom.checks } : {}),
  };
  return Object.keys(expectation).length ? expectation : undefined;
};

const resolveManifestRelativeUrl = (raw: string, manifestUrl: string, label: string): string => {
  try {
    // URL values are verbatim in the manifest; relative ones (and plain `path` entries, which are
    // siblings of the fetched rw.json) resolve against the manifest's own URL.
    return new URL(raw, manifestUrl).toString();
  } catch {
    throw new Error(`Manifest ${label} URL is not resolvable: ${raw}`);
  }
};

const toAcquisition = (source: ParsedManifestSourceRef, manifestUrl: string, label: string): ManifestAcquisition => {
  if (source.kind === "extracted") return { extractedPath: source.extractedPath, kind: "extracted" };
  if (source.kind === "url") return { kind: "url", url: resolveManifestRelativeUrl(source.url, manifestUrl, label) };
  return { kind: "url", url: resolveManifestRelativeUrl(source.path, manifestUrl, label) };
};

const toOutputDefaults = (parsed: ParsedManifestParseResult): ManifestOutputDefaults => {
  const output = parsed.manifest.output;
  if (!output) return {};
  const defaults: ManifestOutputDefaults = {};
  if (output.name) defaults.name = output.name;
  if (output.header) defaults.header = output.header;
  return defaults;
};

/**
 * Build the acquisition + session plan from a `manifest parse` result. Every patch is acquired and
 * remains toggleable; `optional` only seeds its initial on/off state.
 */
const buildManifestApplySessionPlan = (
  parsed: ParsedManifestParseResult,
  manifestUrl: string,
): ManifestApplySessionPlan => {
  const entries: ManifestPlanEntry[] = [];
  parsed.manifest.patches.forEach((patch, index) => {
    const patchSource = parsed.patchSources[index];
    if (!patchSource) throw new Error(`Manifest patch ${index + 1} has no resolved source`);
    entries.push({
      acquisition: toAcquisition(patchSource.source, manifestUrl, `patch ${index + 1}`),
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.description ? { description: patch.description } : {}),
      ...(patch.label ? { label: patch.label } : {}),
      optional: patch.optional === true,
      ...(patch.inputChecks ? { inputChecks: patch.inputChecks } : {}),
      ...(patch.outputChecks ? { outputChecks: patch.outputChecks } : {}),
      ...(patch.header ? { header: patch.header } : {}),
    });
  });
  const name = manifestSessionDisplayName(parsed.manifest);
  const romExpectation = parsed.romSource ? undefined : manifestRomExpectation(parsed.manifest);
  return {
    chainEndpointChecks: manifestChainEndpointChecks(parsed.manifest),
    entries,
    key: manifestUrl,
    ...(name ? { name } : {}),
    outputDefaults: toOutputDefaults(parsed),
    ...(parsed.romSource ? { romAcquisition: toAcquisition(parsed.romSource, manifestUrl, "rom") } : {}),
    ...(romExpectation ? { romExpectation } : {}),
    warnings: parsed.warnings.slice(),
  };
};

export type { ManifestApplySession, ManifestApplySessionEntry, ManifestRomExpectation };
export {
  buildManifestApplySessionPlan,
  manifestChainEndpointChecks,
  manifestRomExpectation,
  manifestSessionDisplayName,
};
