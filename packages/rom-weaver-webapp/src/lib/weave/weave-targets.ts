import type { ParsedWeave, ParsedWeaveChecks, ParsedWeavePatchInput } from "../../types/weave.ts";
import type { SelectionCandidate, SelectionChoice } from "../../types/selection.ts";

const selectWeaveMembers = (
  members: readonly string[],
  candidates: readonly SelectionCandidate[],
): SelectionChoice | undefined => {
  if (!members.length) return undefined;
  const ids = new Set<string>();
  for (const member of members) {
    const matches = candidates.filter(
      (candidate) =>
        candidate.id === member ||
        candidate.path === member ||
        (candidate.type === "file" && candidate.fileName === member),
    );
    if (matches.length !== 1) return undefined;
    const match = matches[0];
    if (!match) return undefined;
    if (match.selectable) {
      ids.add(match.id);
      continue;
    }
    const groups = candidates.filter(
      (candidate) => candidate.type === "group" && candidate.selectable && candidate.candidateIds.includes(match.id),
    );
    if (groups.length !== 1 || !groups[0]) return undefined;
    ids.add(groups[0].id);
  }
  const selected = [...ids];
  return selected[0] ? { id: selected[0], ids: selected } : undefined;
};

const weaveCheckTokens = (checks: ParsedWeaveChecks | undefined): string | undefined => {
  const tokens = Object.entries(checks?.checksums || {}).map(([algorithm, hex]) => `${algorithm}=${hex}`);
  if (checks?.size !== undefined) tokens.push(`size=${checks.size}`);
  return tokens.length ? tokens.join(",") : undefined;
};

const resolveWeaveChecks = (
  weave: ParsedWeave,
  inline: ParsedWeaveChecks | undefined,
  reference: string | undefined,
): ParsedWeaveChecks | undefined => {
  if (!reference) return inline;
  if (inline) throw new Error(`Weave checks cannot declare both values and a reference: ${reference}`);
  const states = weave.checkStates?.filter((state) => state.id === reference) || [];
  if (states.length !== 1) throw new Error(`Weave check state is missing or duplicated: ${reference}`);
  return states[0]?.checks;
};

type PatchDependency = {
  id: string;
  input?: ParsedWeavePatchInput;
  target?: ParsedWeavePatchInput;
  enabled: boolean;
};

const validatePatchDependencies = (patches: readonly PatchDependency[]): string | undefined => {
  const ids = new Set<string>();
  for (const patch of patches) {
    if (!patch.id || ids.has(patch.id)) return `Patch identity is missing or duplicated: ${patch.id}`;
    ids.add(patch.id);
  }
  const available = new Set<string>();
  for (const patch of patches) {
    if (!patch.enabled) continue;
    for (const reference of [patch.input, patch.target]) {
      if (reference && "patch" in reference && !available.has(reference.patch)) {
        return `Patch ${patch.id} requires output from ${reference.patch}. Enable that patch and place it first.`;
      }
    }
    available.add(patch.id);
  }
  return undefined;
};

type ChainCheckEntry = {
  target?: ParsedWeavePatchInput;
  /** Explicit execution input (`input`); its declared states describe the bytes it names. */
  input?: ParsedWeavePatchInput;
  enabled: boolean;
  /** The input checks came from the weave/user rather than the identify-database member fill. */
  authoredInputChecks: boolean;
  inputChecks?: string;
  outputChecks?: string;
};

const chainLaneKey = (target: ParsedWeavePatchInput | undefined): string =>
  target ? `${"patch" in target ? target.patch : ""}:${target.member ?? ""}` : "";

/**
 * Drops declared checks that no longer describe real bytes, mirroring the CLI weave apply
 * (`is_chain_prefix` in weave_apply.rs, the chain loop's input gate, and its output gate). The
 * engine enforces every check the browser sends, so a declared state travels only when every
 * earlier entry in its own target lane is enabled, or when the entry names its own `input` (the
 * final root-lane output excepted: the CLI gates that on the chain prefix alone). Authored input
 * checks are otherwise verified regardless, except at a ROM-member lane start. Disabled entries
 * pass through untouched.
 */
const gateWeaveChainChecks = (
  entries: readonly ChainCheckEntry[],
): Array<{ inputChecks?: string; outputChecks?: string }> => {
  const brokenLanes = new Set<string>();
  const startedLanes = new Set<string>();
  const lastEnabled = entries.findLastIndex((entry) => entry.enabled);
  return entries.map(({ target, input, enabled, authoredInputChecks, inputChecks, outputChecks }, index) => {
    const lane = chainLaneKey(target);
    if (!enabled) {
      brokenLanes.add(lane);
      return { inputChecks, outputChecks };
    }
    const isChainPrefix = !brokenLanes.has(lane);
    const memberLaneStart = !startedLanes.has(lane) && !!target && "rom" in target && !!target.member;
    startedLanes.add(lane);
    return {
      inputChecks: !(isChainPrefix || input) && memberLaneStart && authoredInputChecks ? undefined : inputChecks,
      outputChecks: isChainPrefix || (input && (target || index !== lastEnabled)) ? outputChecks : undefined,
    };
  });
};

/**
 * True when a weave entry reads the supplied ROM: it names no `target` lane and either no
 * `input` or a ROM `input` on the weave's own ROM member. Mirrors `input_is_root_rom` in the CLI
 * weave apply (`weave_apply.rs`).
 */
const readsWeaveRootRom = (
  entry: { input?: ParsedWeavePatchInput; target?: ParsedWeavePatchInput },
  romMember: string | undefined,
): boolean => !entry.target && (!entry.input || ("rom" in entry.input && entry.input.member === romMember));

type WeaveRootRomEntry = {
  input?: ParsedWeavePatchInput;
  target?: ParsedWeavePatchInput;
  enabled: boolean;
  /** The entry's own authored input checks as `algo=hex` tokens. */
  inputChecks?: string;
};

/**
 * The run's expected-ROM checks, as the CLI weave apply folds them into its expected input
 * (`--expect-in`): the weave's `rom.checks`, plus the first selected entry's own input checks when
 * that entry reads the supplied ROM. They are verified once against the ROM the chain starts from,
 * never as a per-patch declaration. `index` is the first enabled entry that reads the supplied ROM
 * (the entry whose run carries the check); undefined when no entry reads it or nothing is declared.
 */
const resolveWeaveRootRomChecks = (
  entries: readonly WeaveRootRomEntry[],
  rom: { checks?: ParsedWeaveChecks; member?: string },
): { index: number; tokens: string } | undefined => {
  const firstEnabled = entries.findIndex((entry) => entry.enabled);
  const index = entries.findIndex((entry) => entry.enabled && readsWeaveRootRom(entry, rom.member));
  if (index < 0) return undefined;
  const tokens = [weaveCheckTokens(rom.checks), index === firstEnabled ? entries[index]?.inputChecks : undefined]
    .filter(Boolean)
    .join(",");
  return tokens ? { index, tokens } : undefined;
};

export {
  gateWeaveChainChecks,
  readsWeaveRootRom,
  resolveWeaveRootRomChecks,
  weaveCheckTokens,
  resolveWeaveChecks,
  selectWeaveMembers,
  validatePatchDependencies,
};
