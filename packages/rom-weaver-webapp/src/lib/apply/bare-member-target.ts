import type { InputAsset } from "../input/input-assets.ts";
import type { PatchInputRef } from "../../types/workflow-runtime-types.ts";
import { compareWeaveRomChecks } from "../weave/weave-targets.ts";

const baseName = (value: string) => value.split(/[\\/]/).pop()?.toLowerCase() ?? "";

/** The distinct member references in `refs`, in first-seen order. */
const collectMemberRefs = (refs: ReadonlyArray<{ member?: string } | null | undefined>) => [
  ...new Set(refs.flatMap((ref) => (ref?.member ? [ref.member] : []))),
];

/**
 * Every distinct member the patches name, plus the weave's `rom.member` when any patch reads the
 * root lane (no input/target, or a ROM reference without a member): a bare file serving that lane
 * already stands in for the root member.
 */
const collectPatchMemberRefs = (
  options: ReadonlyArray<{ input?: PatchInputRef; target?: PatchInputRef } | null | undefined>,
  rootMember?: string,
) => {
  const readsRoot = options.some(
    (option) =>
      !(option?.input || option?.target) ||
      [option.input, option.target].some((ref) => ref && "rom" in ref && !ref.member),
  );
  return collectMemberRefs([
    ...options.flatMap((option) => [option?.input, option?.target]),
    ...(readsRoot && rootMember ? [{ member: rootMember }] : []),
  ]);
};

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

export { bareFileMemberConflicts, collectMemberRefs, collectPatchMemberRefs, findMemberAssets };
