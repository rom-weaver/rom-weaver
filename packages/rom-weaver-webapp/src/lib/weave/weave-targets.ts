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
};

/**
 * The weave's expected-ROM checks (`rom.checks`) and the entry whose run carries them: the first
 * enabled entry that reads the supplied ROM. They describe the supplied file, so they are compared
 * once with that file and never become a per-patch declaration. A first patch's own `inputChecks`
 * stay with the engine's per-patch verification, which also covers a headerless or byte-swapped
 * basis. Undefined when no entry reads the ROM or the weave declares no ROM checks.
 */
const resolveWeaveRootRomChecks = (
  entries: readonly WeaveRootRomEntry[],
  rom: { checks?: ParsedWeaveChecks; member?: string },
): { index: number; tokens: string } | undefined => {
  const tokens = weaveCheckTokens(rom.checks);
  if (!tokens) return undefined;
  const index = entries.findIndex((entry) => entry.enabled && readsWeaveRootRom(entry, rom.member));
  return index < 0 ? undefined : { index, tokens };
};

/**
 * Compare a weave's expected-ROM tokens (`algo=hex`, `size=N`) with the supplied ROM file's own
 * checksums and size. The weave's checks describe the file as supplied (weave export and
 * `weave create` hash the source bytes), so they are compared with the untransformed file rather
 * than handed to the engine, which would verify them after a header strip or N64 byte-order
 * conversion and would let them steer its automatic header decision. `unknown` means no token
 * could be compared (for example a weave that declares only an algorithm the browser does not
 * compute while staging).
 */
const compareWeaveRomChecks = (
  tokens: string,
  actual: { checksums?: Readonly<Record<string, string | undefined>>; size?: number },
): { status: "match" | "mismatch" | "unknown"; message?: string } => {
  let compared = 0;
  for (const token of tokens.split(",")) {
    const [rawKey = "", rawValue = ""] = token.split("=");
    const key = rawKey.trim().toLowerCase();
    const expected = rawValue.trim().toLowerCase();
    if (!(key && expected)) continue;
    if (key === "size") {
      if (actual.size === undefined) continue;
      compared += 1;
      if (String(actual.size) !== expected)
        return { message: `Input size mismatch; expected ${expected}, actual ${actual.size}`, status: "mismatch" };
      continue;
    }
    const value = actual.checksums?.[key]?.trim().toLowerCase().replace(/^0x/, "");
    if (!value) continue;
    compared += 1;
    if (value !== expected)
      return {
        message: `Input checksum mismatch for ${key}; expected ${expected}, actual ${value}`,
        status: "mismatch",
      };
  }
  return { status: compared ? "match" : "unknown" };
};

export {
  compareWeaveRomChecks,
  gateWeaveChainChecks,
  readsWeaveRootRom,
  resolveWeaveRootRomChecks,
  weaveCheckTokens,
  resolveWeaveChecks,
  selectWeaveMembers,
  validatePatchDependencies,
};
