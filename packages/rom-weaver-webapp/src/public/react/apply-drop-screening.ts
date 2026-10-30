import { isArchiveFileName, isPatchFileName, isRomFileName, isWeaveFileName } from "./file-classification.ts";

/**
 * Drop screening for the Apply tab: files that can never become the ROM or a patch are held back
 * with a reason instead of being offered as an alternative ROM or failing after Apply.
 */

type DropRejection = {
  kind: "splitWbfs" | "unsupportedPatch";
  names: string[];
};

const SPLIT_WBFS_PART_REGEX = /\.wbf[1-9]\d*$/i;
const FILE_EXTENSION_REGEX = /\.[a-z0-9]{1,8}$/i;
const JSON_NAME_REGEX = /\.json$/i;

const stemOf = (name: string) => name.replace(/\.[^./\\]*$/, "").toLowerCase();

/**
 * Apply reads one `.wbfs` file; only Extract joins a split set (`Disc.wbfs` + `Disc.wbf1` ...).
 * Dropping the parts would otherwise offer each part as a separate ROM and fail once Apply runs.
 */
const separateSplitWbfs = (files: File[]): { rejection: DropRejection | null; remaining: File[] } => {
  const splitStems = new Set(
    files.filter((file) => SPLIT_WBFS_PART_REGEX.test(file.name)).map((file) => stemOf(file.name)),
  );
  if (!splitStems.size) return { rejection: null, remaining: files };
  const isPart = (file: File) =>
    SPLIT_WBFS_PART_REGEX.test(file.name) || (/\.wbfs$/i.test(file.name) && splitStems.has(stemOf(file.name)));
  return {
    rejection: { kind: "splitWbfs", names: files.filter(isPart).map((file) => file.name) },
    remaining: files.filter((file) => !isPart(file)),
  };
};

const isRecognisedEntryName = (name: string) =>
  isRomFileName(name) ||
  isPatchFileName(name) ||
  isArchiveFileName(name) ||
  isWeaveFileName(name) ||
  JSON_NAME_REGEX.test(name);

type RomCandidates = {
  /** Archives routed to the ROM bucket, with their entry listing (empty when the listing failed). */
  archives: ReadonlyMap<File, readonly string[]>;
  /** Bare files that are not patches or archives. */
  inputs: readonly File[];
  /** Bare files a dropped disc sheet references as tracks; never screened out whatever their name. */
  sheetReferenced?: ReadonlySet<File>;
};

const hasExtension = (name: string) => FILE_EXTENSION_REGEX.test(name);

/**
 * Sort the ROM-bucket candidates of a drop that already holds a recognised ROM. Held back: a candidate
 * whose name carries an extension that matches no ROM, patch, or archive name (a `.rnp` file, or an
 * archive holding only `readme.txt`). It is neither a patch nor ROM-like, so it is not
 * offered as a second ROM. Extension-less names are left alone, as is an archive with any
 * extension-less entry (Rust ignores common files such as `readme.txt` next to it);
 * {@link separateIngestPatches} decides.
 */
const screenRomCandidates = (
  candidates: RomCandidates,
): { archives: File[]; inputs: File[]; rejection: DropRejection | null } => {
  const archives = [...candidates.archives.keys()];
  const inputs = [...candidates.inputs];
  const hasRecognisedRom =
    inputs.some((file) => isRomFileName(file.name)) ||
    archives.some((file) =>
      (candidates.archives.get(file) ?? []).some((name) => isRomFileName(name) || isArchiveFileName(name)),
    );
  if (!hasRecognisedRom) return { archives, inputs, rejection: null };
  const unsupportedInputs = inputs.filter(
    (file) => !isRomFileName(file.name) && hasExtension(file.name) && !candidates.sheetReferenced?.has(file),
  );
  const unsupportedArchives = archives.filter((file) => {
    const names = candidates.archives.get(file) ?? [];
    return names.length > 0 && !names.some(isRecognisedEntryName) && names.every(hasExtension);
  });
  const rejected = new Set<File>([...unsupportedInputs, ...unsupportedArchives]);
  if (!rejected.size) return { archives, inputs, rejection: null };
  return {
    archives: archives.filter((file) => !rejected.has(file)),
    inputs: inputs.filter((file) => !rejected.has(file)),
    rejection: { kind: "unsupportedPatch", names: [...rejected].map((file) => file.name) },
  };
};

type DroppedKindProbe = (file: File) => Promise<"patch" | "rom" | undefined>;

/**
 * Extension-less names (a bare `patch`, or `patch.gz` whose only entry is `patch`) say nothing about
 * what they hold, and a raw ROM dump has no extension either. When several ROM candidates would make
 * the user pick one, ask Rust ingest (signature classification) about each ambiguous one: a patch goes
 * to the patch bucket, anything else (including a failed or unavailable probe) stays a ROM candidate.
 * A lone candidate is never probed; staging reclassifies it from the same ingest verdict.
 */
const separateIngestPatches = async (
  candidates: RomCandidates,
  probe: DroppedKindProbe,
  isCancelled?: () => boolean,
): Promise<{ archives: File[]; inputs: File[]; patches: File[] }> => {
  const archives = [...candidates.archives.keys()];
  const inputs = [...candidates.inputs];
  if (archives.length + inputs.length < 2) return { archives, inputs, patches: [] };
  const ambiguousArchives = archives.filter((file) => {
    const names = candidates.archives.get(file) ?? [];
    return names.length > 0 && !names.some(isRecognisedEntryName) && names.some((name) => !hasExtension(name));
  });
  const ambiguousInputs = inputs.filter((file) => !hasExtension(file.name));
  const patches = new Set<File>();
  for (const file of [...ambiguousInputs, ...ambiguousArchives]) {
    if (isCancelled?.()) break;
    if ((await probe(file)) === "patch") patches.add(file);
  }
  return {
    archives: archives.filter((file) => !patches.has(file)),
    inputs: inputs.filter((file) => !patches.has(file)),
    patches: [...patches],
  };
};

export { type DropRejection, separateIngestPatches, separateSplitWbfs, screenRomCandidates };
