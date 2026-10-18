import type { InputAsset } from "../input/input-assets.ts";
import { compareWeaveRomChecks } from "../weave/weave-targets.ts";

const baseName = (value: string) => value.split(/[\\/]/).pop()?.toLowerCase() ?? "";

/**
 * Assets a weave `member` reference resolves to. A member reference normally selects an archive
 * member or disc track; when the only patchable input is a bare file (not extracted from an
 * archive), that file stands in for the member when its name or the patch's input checks match,
 * the same way the CLI accepts a bare member file.
 */
const findMemberAssets = (member: string, patchableAssets: readonly InputAsset[], inputChecks?: string) => {
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
  return nameMatches || checksMatch ? [only] : matches;
};

export { findMemberAssets };
