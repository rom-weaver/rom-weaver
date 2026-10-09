// Pure mapping from a parsed rom-weaver-weave.json weave to the webapp's apply-session plan: which sources to
// acquire (URLs resolved against the weave's own URL, or leaves already extracted from a bundled
// archive), the per-patch enablement seed, and the one-shot output defaults. No I/O here - the
// url-session boot flow feeds this into fetch/materialize and the apply form consumes the result.
import type {
  WeaveHeaderMode,
  ParsedWeave,
  ParsedWeaveChecks,
  ParsedWeavePatchInput,
  ParsedWeaveParseResult,
  ParsedWeaveSourceRef,
} from "../../types/weave.ts";

import { resolveWeaveChecks } from "./weave-targets.ts";

type WeaveAcquisition = { kind: "url"; url: string } | { kind: "extracted"; extractedPath: string };

type WeavePlanEntry = {
  input?: ParsedWeavePatchInput;
  target?: ParsedWeavePatchInput;
  acquisition: WeaveAcquisition;
  id?: string;
  version?: string;
  author?: string;
  name?: string;
  description?: string;
  label?: string;
  /** Optional patches start deselected; everything else starts on. */
  optional: boolean;
  /** Only checks the patch itself declared - chain-endpoint verification (rom/output checks) is session-level. */
  inputChecks?: ParsedWeaveChecks;
  outputChecks?: ParsedWeaveChecks;
  header?: WeaveHeaderMode;
  /** Declared input basis (`base` = authored against the weave's rom; absent = previous/inferred). */
  basis?: "base" | "previous";
};

type WeaveOutputDefaults = {
  name?: string;
  header?: WeaveHeaderMode;
};

/** What ROM the weave expects the user to supply when it ships none itself. */
type WeaveRomExpectation = {
  name?: string;
  checks?: ParsedWeaveChecks;
};

type WeaveApplySessionPlan = {
  /** Identity key for run-once guards (the weave URL; the boot flow may suffix an attempt). */
  key: string;
  /** v1 weaves use inference. v2 carries an explicit shared rule. */
  patchBasis: "auto" | "base" | "previous";
  name?: string;
  warnings: string[];
  romAcquisition?: WeaveAcquisition;
  romMember?: string;
  /** Set when the weave ships no ROM: the expected ROM the user must supply. */
  romExpectation?: WeaveRomExpectation;
  /** Weave order = apply order; index-aligned with the acquired patch files. */
  entries: WeavePlanEntry[];
  /** ROM/final-output verification for the run (seeds the input/output validation checksums). */
  chainEndpointChecks: WeaveChainEndpointChecks;
  outputDefaults: WeaveOutputDefaults;
};

/** A plan entry decorated with the acquired file's name (the drop-pipeline matching key). */
type WeaveApplySessionEntry = WeavePlanEntry & { fileName: string };

/** The plan after acquisition, as handed to the apply form. */
type WeaveApplySession = Omit<WeaveApplySessionPlan, "entries" | "romAcquisition"> & {
  romFileName?: string;
  entries: WeaveApplySessionEntry[];
};

/** The verification endpoints of the full patch chain. */
type WeaveChainEndpointChecks = {
  input?: ParsedWeaveChecks;
  output?: ParsedWeaveChecks;
};

/**
 * The chain's verification endpoints: what the base ROM must be (the first
 * patch's own `inputChecks`, else the weave's `rom.checks`) and what the
 * final result must be (the last patch's own `outputChecks`, else
 * `output.checks`). These verify the ROM and the run's output - they are NOT
 * attributed to individual patches: a patch's card only shows checks the
 * patch itself declared.
 *
 * A last patch that declares a `target` writes into one lane (a ROM member or
 * track), so its `outputChecks` describe that lane's raw bytes and not the
 * reassembled run output. The endpoint MUST then come from `output.checks`
 * alone; the lane checks stay per-step verification. `weave_apply.rs`
 * (`resolve_selected_weave_output_check`) makes the same distinction.
 */
const weaveChainEndpointChecks = (weave: ParsedWeave): WeaveChainEndpointChecks => {
  const first = weave.patches[0];
  const last = weave.patches.at(-1);
  const input =
    resolveWeaveChecks(weave, first?.inputChecks, first?.inputChecksRef) ||
    resolveWeaveChecks(weave, weave.rom?.checks, weave.rom?.checksRef);
  const weaveOutput = resolveWeaveChecks(weave, weave.output?.checks, weave.output?.checksRef);
  const output = last?.target
    ? weaveOutput
    : resolveWeaveChecks(weave, last?.outputChecks, last?.outputChecksRef) || weaveOutput;
  return { ...(input ? { input } : {}), ...(output ? { output } : {}) };
};

/** Display name for a weave session, derived from its output/rom naming. */
const weaveSessionDisplayName = (weave: ParsedWeave): string | undefined => weave.output?.name || weave.rom?.name;

/** The expected-ROM details to surface when the weave ships no ROM source. */
const weaveRomExpectation = (weave: ParsedWeave): WeaveRomExpectation | undefined => {
  const rom = weave.rom;
  if (!rom || rom.url || rom.path) return undefined;
  const checks = resolveWeaveChecks(weave, rom.checks, rom.checksRef);
  const expectation: WeaveRomExpectation = {
    ...(rom.name ? { name: rom.name } : {}),
    ...(checks ? { checks } : {}),
  };
  return Object.keys(expectation).length ? expectation : undefined;
};

const resolveWeaveRelativeUrl = (raw: string, weaveUrl: string, label: string): string => {
  try {
    // URL values are verbatim in the weave; relative ones (and plain `path` entries, which are
    // siblings of the fetched rom-weaver-weave.json) resolve against the weave's own URL.
    return new URL(raw, weaveUrl).toString();
  } catch {
    throw new Error(`Weave ${label} URL is not resolvable: ${raw}`);
  }
};

const toAcquisition = (source: ParsedWeaveSourceRef, weaveUrl: string, label: string): WeaveAcquisition => {
  if (source.kind === "extracted") return { extractedPath: source.extractedPath, kind: "extracted" };
  if (source.kind === "url") return { kind: "url", url: resolveWeaveRelativeUrl(source.url, weaveUrl, label) };
  return { kind: "url", url: resolveWeaveRelativeUrl(source.path, weaveUrl, label) };
};

const toOutputDefaults = (parsed: ParsedWeaveParseResult): WeaveOutputDefaults => {
  const output = parsed.weave.output;
  if (!output) return {};
  const defaults: WeaveOutputDefaults = {};
  if (output.name) defaults.name = output.name;
  if (output.header) defaults.header = output.header;
  return defaults;
};

const toWeavePlanEntry = (
  patch: ParsedWeaveParseResult["weave"]["patches"][number],
  source: ParsedWeaveSourceRef,
  weaveUrl: string,
  index: number,
): WeavePlanEntry => ({
  acquisition: toAcquisition(source, weaveUrl, `patch ${index + 1}`),
  ...(patch.id ? { id: patch.id } : {}),
  ...(patch.input ? { input: patch.input } : {}),
  ...(patch.target ? { target: patch.target } : {}),
  ...(patch.version ? { version: patch.version } : {}),
  ...(patch.author ? { author: patch.author } : {}),
  ...(patch.name ? { name: patch.name } : {}),
  ...(patch.description ? { description: patch.description } : {}),
  ...(patch.label ? { label: patch.label } : {}),
  optional: patch.optional === true,
  ...(patch.inputChecks ? { inputChecks: patch.inputChecks } : {}),
  ...(patch.outputChecks ? { outputChecks: patch.outputChecks } : {}),
  ...(patch.header ? { header: patch.header } : {}),
  ...(patch.basis ? { basis: patch.basis } : {}),
});

/**
 * Build the acquisition + session plan from a `weave parse` result. Every patch is acquired and
 * remains toggleable; `optional` only seeds its initial on/off state.
 */
const buildWeaveApplySessionPlan = (parsed: ParsedWeaveParseResult, weaveUrl: string): WeaveApplySessionPlan => {
  const entries: WeavePlanEntry[] = [];
  parsed.weave.patches.forEach((patch, index) => {
    const patchSource = parsed.patchSources[index];
    if (!patchSource) throw new Error(`Weave patch ${index + 1} has no resolved source`);
    entries.push(
      toWeavePlanEntry(
        {
          ...patch,
          inputChecks: resolveWeaveChecks(parsed.weave, patch.inputChecks, patch.inputChecksRef),
          outputChecks: resolveWeaveChecks(parsed.weave, patch.outputChecks, patch.outputChecksRef),
        },
        patchSource.source,
        weaveUrl,
        index,
      ),
    );
  });
  const name = weaveSessionDisplayName(parsed.weave);
  const romExpectation = parsed.romSource ? undefined : weaveRomExpectation(parsed.weave);
  return {
    chainEndpointChecks: weaveChainEndpointChecks(parsed.weave),
    ...(parsed.weave.rom?.member ? { romMember: parsed.weave.rom.member } : {}),
    entries,
    key: weaveUrl,
    patchBasis: parsed.weave.version >= 2 ? parsed.weave.patchBasis || "auto" : "auto",
    ...(name ? { name } : {}),
    outputDefaults: toOutputDefaults(parsed),
    ...(parsed.romSource ? { romAcquisition: toAcquisition(parsed.romSource, weaveUrl, "rom") } : {}),
    ...(romExpectation ? { romExpectation } : {}),
    warnings: parsed.warnings.slice(),
  };
};

export type { WeaveApplySession, WeaveApplySessionEntry, WeaveRomExpectation };
export { buildWeaveApplySessionPlan, weaveChainEndpointChecks, weaveRomExpectation, weaveSessionDisplayName };
