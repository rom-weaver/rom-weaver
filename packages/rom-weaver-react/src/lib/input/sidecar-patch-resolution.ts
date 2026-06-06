import { getDirectoryPath } from "./path-utils.ts";

const PATH_DIRECTORY_PREFIX_REGEX = /^.*[/\\]/;

type SidecarPatchEntry = {
  filename?: string;
  fileName?: string;
  name?: string;
};

type ResolvedSidecarPatch<TEntry extends SidecarPatchEntry> = {
  entry: TEntry;
  fileName: string;
  order: number;
  outputLabel?: string;
};
type IndexedResolvedSidecarPatch<TEntry extends SidecarPatchEntry> = ResolvedSidecarPatch<TEntry> & {
  index: number;
};

const PATCH_EXTENSION_PATTERN = /\.(ips|ups|bps|aps|rup|ppf|ebp|bdf|bsp|bspatch|mod|xdelta|delta|dat|vcdiff)(\d*)$/i;
const BRACKET_LABEL_PATTERN = /\[([^\]]+)\](?:\.[^.]+)?\d*$/;
const BRACKET_LABEL_SUFFIX_PATTERN = /\s*\[[^\]]+\]\s*$/;

const getSidecarEntryFileName = (entry: SidecarPatchEntry | string | null | undefined): string => {
  if (typeof entry === "string") return entry;
  if (!entry) return "";
  return String(entry.filename || entry.fileName || entry.name || "");
};

const getSidecarPatchOrder = (fileName: string): number | null => {
  const match = String(fileName || "").match(PATCH_EXTENSION_PATTERN);
  if (!match) return null;
  const suffix = match[2] || "";
  if (!suffix) return 0;
  const order = Number.parseInt(suffix, 10);
  return Number.isFinite(order) ? order : null;
};

const getSidecarPatchOutputLabel = (fileName: string): string | undefined => {
  const baseName = String(fileName || "").replace(PATH_DIRECTORY_PREFIX_REGEX, "");
  const match = baseName.match(BRACKET_LABEL_PATTERN);
  const label = match?.[1]?.trim();
  return label || undefined;
};

const getSidecarPatchBaseName = (fileName: string): string | null => {
  const baseName = String(fileName || "").replace(PATH_DIRECTORY_PREFIX_REGEX, "");
  const match = baseName.match(PATCH_EXTENSION_PATTERN);
  if (!match?.index) return null;
  const patchBaseName = baseName.slice(0, match.index).replace(BRACKET_LABEL_SUFFIX_PATTERN, "").trim();
  return patchBaseName || null;
};

const getRomSidecarBaseNames = (romFileName: string): Set<string> => {
  const baseName = String(romFileName || "")
    .replace(PATH_DIRECTORY_PREFIX_REGEX, "")
    .trim();
  if (!baseName) return new Set();
  const extensionIndex = baseName.lastIndexOf(".");
  const stem = extensionIndex > 0 ? baseName.slice(0, extensionIndex) : baseName;
  return new Set([baseName, stem].filter(Boolean));
};

const isMatchingSidecarPatch = (romFileName: string, patchFileName: string): boolean => {
  const patchBaseName = getSidecarPatchBaseName(patchFileName);
  if (!patchBaseName) return false;
  return getRomSidecarBaseNames(romFileName).has(patchBaseName);
};

const resolveSidecarPatchEntries = <TEntry extends SidecarPatchEntry>(
  romFileName: string,
  entries: TEntry[],
): Array<ResolvedSidecarPatch<TEntry>> => {
  const romDirectory = getDirectoryPath(romFileName);
  return entries
    .reduce<Array<IndexedResolvedSidecarPatch<TEntry>>>((patches, entry, index) => {
      const fileName = getSidecarEntryFileName(entry);
      if (!fileName || getDirectoryPath(fileName) !== romDirectory) return patches;
      const order = getSidecarPatchOrder(fileName);
      if (order === null) return patches;
      if (!isMatchingSidecarPatch(romFileName, fileName)) return patches;
      patches.push({
        entry,
        fileName,
        index,
        order,
        outputLabel: getSidecarPatchOutputLabel(fileName),
      });
      return patches;
    }, [])
    .sort(
      (left, right) =>
        left.order - right.order || left.fileName.localeCompare(right.fileName) || left.index - right.index,
    )
    .map(({ index: _index, ...entry }) => entry);
};

const applySidecarPatchOutputLabel = <TFile extends { fileName?: string }>(
  file: TFile,
  outputLabel?: string,
): TFile => {
  if (outputLabel) (file as TFile & { _generatedPatchName?: string })._generatedPatchName = outputLabel;
  return file;
};

export { applySidecarPatchOutputLabel, resolveSidecarPatchEntries };
