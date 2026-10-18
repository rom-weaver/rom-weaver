import type { InputAsset } from "../input/input-assets.ts";
import { compareWeaveRomChecks } from "../weave/weave-targets.ts";

const baseName = (value: string) => value.split(/[\\/]/).pop()?.toLowerCase() ?? "";

/** The distinct member references in `refs`, in first-seen order. */
const collectMemberRefs = (refs: ReadonlyArray<{ member?: string } | null | undefined>) => [
  ...new Set(refs.flatMap((ref) => (ref?.member ? [ref.member] : []))),
];

/**
 * Other weave members the bare `asset` would also satisfy by file name. One bare file stands in for
 * a single member only; binding it to several would apply a patch to the wrong member.
 */
const bareFileMemberConflicts = (member: string, asset: InputAsset, memberRefs: readonly string[]) =>
  memberRefs.filter((other) => other !== member && baseName(other) === baseName(asset.fileName));

/**
 * Assets a weave `member` reference resolves to. A member reference normally selects an archive
 * member or disc track; when the only patchable input is a bare file (not extracted from an
 * archive), that file stands in for the member when its name or the patch's input checks match,
 * the same way the CLI accepts a bare member file.
 */
const findMemberAssets = (
  member: string,
  patchableAssets: readonly InputAsset[],
  inputChecks?: string,
  memberRefs: readonly string[] = [],
) => {
  const matches = patchableAssets.filter((asset) => {
    if (asset.member === member) return true;
    if (asset.discGroupId && asset.trackNumber !== undefined)
      return `${asset.discGroupId}:${asset.trackNumber}` === member;
    return false;
  });
  if (matches.length || patchableAssets.length !== 1) return matches;
  const [only] = patchableAssets;
  if (!only || only.member !== undefined || only.discGroupId) return matches;
  const nameMatches = baseName(only.fileName) === baseName(member);
  const checksMatch =
    !!inputChecks &&
    compareWeaveRomChecks(inputChecks, { checksums: only.checksums, size: only.size }).status === "match";
  if (!(nameMatches || checksMatch)) return matches;
  return bareFileMemberConflicts(member, only, memberRefs).length ? matches : [only];
};

export { bareFileMemberConflicts, collectMemberRefs, findMemberAssets };
