// Apply-time fill of per-track input checks for bundle v2 ROM-member lanes: the
// bundle's own rom identification names one database component per disc track,
// so the first patch of each member lane can verify its track before patching.
// Mirrors the CLI fill in `rom-weaver-cli`; it is never written back into the
// bundle metadata, so exporting a bundle does not persist it.
import type { BundleApplySession } from "./bundle-session-model.ts";
import type { ParsedBundleChecks } from "../../types/bundle.ts";
import type { ParsedIdentifyExpectedComponent, ParsedIdentifyResolution } from "../../types/identify.ts";

/** Checksum algorithms a member lane check can carry (sha256 is not a patch check). */
const MEMBER_CHECK_ALGORITHMS = ["crc32", "md5", "sha1"] as const;

/** Last path segment of a member path, for either separator. */
const memberBaseName = (name: string): string => name.split(/[/\\]/).pop() || name;

/**
 * Track number a member or component file name declares: the digits after the
 * first case-insensitive `track` word, ignoring spaces, `_` and `-` between the
 * word and the number. `data.bin` names no track.
 */
const memberTrackNumber = (name: string): number | undefined => {
  const match = /track[\s_-]*(\d+)/i.exec(memberBaseName(name));
  if (!match?.[1]) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : undefined;
};

/**
 * The database component that describes a bundle member: an exact file-name
 * match (case-insensitive, basename only) wins; otherwise the component whose
 * track number equals the member's. A member with no track number and no name
 * match resolves to nothing.
 */
const memberComponent = (
  components: readonly ParsedIdentifyExpectedComponent[],
  member: string,
): ParsedIdentifyExpectedComponent | undefined => {
  const base = memberBaseName(member).toLowerCase();
  const named = components.find(
    (component) => !!component.filename && memberBaseName(component.filename).toLowerCase() === base,
  );
  if (named) return named;
  const track = memberTrackNumber(member);
  if (track === undefined) return undefined;
  return components.find(
    (component) =>
      component.track === track ||
      (component.track === undefined && !!component.filename && memberTrackNumber(component.filename) === track),
  );
};

/** The checks a component can prove a staged track against. */
const componentChecks = (component: ParsedIdentifyExpectedComponent): ParsedBundleChecks | undefined => {
  const checksums: Record<string, string> = {};
  for (const algorithm of MEMBER_CHECK_ALGORITHMS) {
    const value = component[algorithm];
    if (value) checksums[algorithm] = value;
  }
  const size = component.size > 0 ? component.size : undefined;
  if (!(Object.keys(checksums).length || size !== undefined)) return undefined;
  return {
    ...(Object.keys(checksums).length ? { checksums } : {}),
    ...(size === undefined ? {} : { size }),
  };
};

/** Lane identity: the target selector decides which entries share a lane. */
const laneKey = (target: NonNullable<BundleApplySession["entries"][number]["target"]>): string =>
  JSON.stringify(target);

/**
 * Checks to hand the FIRST patch of every ROM-member lane that declares no
 * input and no input checks of its own, keyed by entry index. Only a matched
 * record with 2+ expected components describes a multi-track disc; a
 * single-component record says nothing about individual members.
 */
const fillMemberLaneChecks = (
  entries: BundleApplySession["entries"],
  identification: ParsedIdentifyResolution | undefined,
): Map<number, ParsedBundleChecks> => {
  const fills = new Map<number, ParsedBundleChecks>();
  if (identification?.status !== "matched") return fills;
  const components = identification.matches[0]?.expectedComponents || [];
  if (components.length < 2) return fills;
  const seenLanes = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const target = entry.target;
    if (!(target && "rom" in target && target.member)) continue;
    const key = laneKey(target);
    if (seenLanes.has(key)) continue;
    seenLanes.add(key);
    if (entry.input || entry.inputChecks) continue;
    const component = memberComponent(components, target.member);
    if (!component) continue;
    const checks = componentChecks(component);
    if (checks) fills.set(index, checks);
  }
  return fills;
};

export { componentChecks, fillMemberLaneChecks, memberComponent, memberTrackNumber };
