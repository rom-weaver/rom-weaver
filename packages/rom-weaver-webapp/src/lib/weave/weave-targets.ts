import type { ParsedWeaveChecks, ParsedWeavePatchInput } from "../../types/weave.ts";
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
 * True when a weave entry reads the supplied ROM itself: no `target` lane (or a `rom` target
 * without a member, the shape the browser export writes) and either no `input` or a ROM `input`
 * on the weave's own ROM member.
 */
const readsWeaveRootRom = (
  entry: { input?: ParsedWeavePatchInput; target?: ParsedWeavePatchInput },
  romMember: string | undefined,
): boolean =>
  (!entry.target || ("rom" in entry.target && !entry.target.member)) &&
  (!entry.input || ("rom" in entry.input && entry.input.member === romMember));

type WeaveRomVerdict = {
  status: "match" | "mismatch" | "unknown";
  message?: string;
  /** Declared algorithms the supplied checksums could not answer. */
  missing: string[];
};

/**
 * Compare a weave's expected-ROM tokens (`algo=hex`, `size=N`) with the supplied ROM file's own
 * checksums and size. The weave's checks describe the file as supplied (weave export and
 * `weave create` hash the source bytes), so they are compared with the untransformed file rather
 * than handed to the engine, which would verify them after a header strip or N64 byte-order
 * conversion and would let them steer its automatic header decision. Algorithms the checksums do
 * not carry are listed in `missing` for the caller to compute; `unknown` means nothing compared.
 */
const compareWeaveRomChecks = (
  tokens: string,
  actual: { checksums?: Readonly<Record<string, string | undefined>>; size?: number },
): WeaveRomVerdict => {
  let compared = 0;
  const missing: string[] = [];
  for (const token of tokens.split(",")) {
    const [rawKey = "", rawValue = ""] = token.split("=");
    const key = rawKey.trim().toLowerCase();
    const expected = rawValue.trim().toLowerCase();
    if (!(key && expected)) continue;
    if (key === "size") {
      if (actual.size === undefined) continue;
      compared += 1;
      if (String(actual.size) !== expected)
        return {
          message: `Input size mismatch; expected ${expected}, actual ${actual.size}`,
          missing,
          status: "mismatch",
        };
      continue;
    }
    const value = actual.checksums?.[key]?.trim().toLowerCase().replace(/^0x/, "");
    if (!value) {
      if (!missing.includes(key)) missing.push(key);
      continue;
    }
    compared += 1;
    if (value !== expected)
      return {
        message: `Input checksum mismatch for ${key}; expected ${expected}, actual ${value}`,
        missing,
        status: "mismatch",
      };
  }
  return { missing, status: compared ? "match" : "unknown" };
};

export type { WeaveRomVerdict };
export {
  compareWeaveRomChecks,
  gateWeaveChainChecks,
  readsWeaveRootRom,
  weaveCheckTokens,
  selectWeaveMembers,
  validatePatchDependencies,
};
