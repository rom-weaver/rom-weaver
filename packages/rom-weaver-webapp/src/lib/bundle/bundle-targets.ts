import type { ParsedBundle, ParsedBundleChecks, ParsedBundlePatchInput } from "../../types/bundle.ts";
import type { SelectionCandidate, SelectionChoice } from "../../types/selection.ts";

const selectBundleMembers = (
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

const bundleCheckTokens = (checks: ParsedBundleChecks | undefined): string | undefined => {
  const tokens = Object.entries(checks?.checksums || {}).map(([algorithm, hex]) => `${algorithm}=${hex}`);
  if (checks?.size !== undefined) tokens.push(`size=${checks.size}`);
  return tokens.length ? tokens.join(",") : undefined;
};

const resolveBundleChecks = (
  bundle: ParsedBundle,
  inline: ParsedBundleChecks | undefined,
  reference: string | undefined,
): ParsedBundleChecks | undefined => {
  if (!reference) return inline;
  if (inline) throw new Error(`Bundle checks cannot declare both values and a reference: ${reference}`);
  const states = bundle.checkStates?.filter((state) => state.id === reference) || [];
  if (states.length !== 1) throw new Error(`Bundle check state is missing or duplicated: ${reference}`);
  return states[0]?.checks;
};

type PatchDependency = {
  id: string;
  input?: ParsedBundlePatchInput;
  target?: ParsedBundlePatchInput;
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

export { bundleCheckTokens, resolveBundleChecks, selectBundleMembers, validatePatchDependencies };
