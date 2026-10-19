import type { InputAsset } from "../input/input-assets.ts";
import type { PatchInput, PatchInputRef } from "../../types/workflow-runtime-types.ts";
import { compareWeaveRomChecks } from "../weave/weave-targets.ts";

const baseName = (value: string) => value.split(/[\\/]/).pop()?.toLowerCase() ?? "";

/**
 * The members a weave asks a lone bare input to stand in for: its `rom.member`, plus every member a
 * selected patch names as its input or target, each with the checks those patches declare for it.
 */
type BareMemberRule = {
  rootMember?: string;
  memberChecks: ReadonlyMap<string, readonly string[]>;
};

/**
 * How a lone bare file relates to one member: it stands in for it, it matches but also matches
 * other members (`members` lists them all), or it matches neither by name nor by checks.
 */
type BareMemberBinding = { status: "bound" } | { status: "conflict"; members: string[] } | { status: "mismatch" };

/** Build the rule from the selected patches; `checks` is the checks a patch declares for its member. */
const createBareMemberRule = (
  options: ReadonlyArray<{ input?: PatchInputRef; target?: PatchInputRef; checks?: string } | null | undefined>,
  rootMember?: string,
): BareMemberRule => {
  const memberChecks = new Map<string, string[]>();
  for (const option of options) {
    for (const ref of [option?.input, option?.target]) {
      if (!(ref && "rom" in ref && ref.member)) continue;
      const checks = memberChecks.get(ref.member) ?? [];
      if (option?.checks) checks.push(option.checks);
      memberChecks.set(ref.member, checks);
    }
  }
  return { memberChecks, ...(rootMember ? { rootMember } : {}) };
};

/** The rule for a run's patch list (enabled patches only), matching what readiness checked. */
const createRunBareMemberRule = (patchOptions: PatchInput["patchOptions"], rootMember: string | undefined) =>
  createBareMemberRule(
    (patchOptions ?? []).map((option) => ({ ...option, checks: option?.inputChecks || option?.memberChecks })),
    rootMember,
  );

const isBareFile = (asset: InputAsset) => asset.member === undefined && !asset.discGroupId;

/** The bare file stands in for `rom.member` unconditionally, and for any other member by name or checks. */
const bareFileMatchesMember = (member: string, asset: InputAsset, rule: BareMemberRule) =>
  member === rule.rootMember ||
  baseName(asset.fileName) === baseName(member) ||
  (rule.memberChecks.get(member) ?? []).some(
    (checks) => compareWeaveRomChecks(checks, { checksums: asset.checksums, size: asset.size }).status === "match",
  );

/**
 * Whether the bare `asset` stands in for `member`. One bare file MUST NOT stand in for more than one
 * distinct member: binding it to several would apply one member's patches to another's bytes.
 */
const bindBareFile = (member: string, asset: InputAsset, rule: BareMemberRule): BareMemberBinding => {
  if (!bareFileMatchesMember(member, asset, rule)) return { status: "mismatch" };
  const claimed = [...(rule.rootMember ? [rule.rootMember] : []), ...rule.memberChecks.keys()];
  const members = [...new Set([...claimed, member])].filter((other) => bareFileMatchesMember(other, asset, rule));
  return members.length > 1 ? { members, status: "conflict" } : { status: "bound" };
};

/** The lone bare file among `patchableAssets`, which may stand in for a weave member. */
const loneBareFile = (patchableAssets: readonly InputAsset[]) => {
  const [only] = patchableAssets;
  return patchableAssets.length === 1 && only && isBareFile(only) ? only : undefined;
};

/**
 * Assets a weave `member` reference resolves to. A member reference normally selects an archive
 * member or disc track; when the only patchable input is a bare file (not extracted from an
 * archive), that file stands in for the member under `rule`, the same way the CLI does.
 */
const findMemberAssets = (member: string, patchableAssets: readonly InputAsset[], rule: BareMemberRule) => {
  const matches = patchableAssets.filter((asset) => {
    if (asset.member === member) return true;
    if (asset.discGroupId && asset.trackNumber !== undefined)
      return `${asset.discGroupId}:${asset.trackNumber}` === member;
    return false;
  });
  if (matches.length) return matches;
  const bare = loneBareFile(patchableAssets);
  return bare && bindBareFile(member, bare, rule).status === "bound" ? [bare] : matches;
};

/** The reason a lone bare file does not stand in for `member`, worded like the CLI's error. */
const describeBareMemberFailure = (member: string, asset: InputAsset, rule: BareMemberRule) => {
  const binding = bindBareFile(member, asset, rule);
  if (binding.status === "conflict")
    return `the bare input file \`${asset.fileName}\` matches several weave ROM members (${binding.members.map((name) => `\`${name}\``).join(", ")}) and can stand in for only one; provide an archive or disc containing them`;
  return `weave ROM member \`${member}\` was not found in \`${asset.fileName}\`: the input is not an archive and neither its file name nor its checks match the member`;
};

export { createBareMemberRule, createRunBareMemberRule, describeBareMemberFailure, findMemberAssets, loneBareFile };
export type { BareMemberRule };
