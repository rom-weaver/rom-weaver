import { reportProgress } from "../progress/progress-reporting.ts";
import {
  findArchiveEntryByFileName,
  isCueEntryFileName,
  isGdiEntryFileName,
  parseCueFileReferences,
} from "./archive.ts";
import { decodeUtf8, type PatchFileInstance } from "./binary-service.ts";
import {
  type ArchiveEntryLike,
  type ChdCodecMode,
  type CompressionEntryKindFilter,
  type CompressionRomCueGroup,
  type CompressionRomProbe,
  type CueGroupSelectionMatch,
  describeArchiveFileForTrace,
  extractArchiveEntryBytes,
  filterNestedContainerEntries,
  type InputPreparationOptions,
  type InputPreparationRuntimeLike,
  listCompressionEntryResult,
  traceArchivePreparation,
} from "./input-preparation-archive.ts";
import { DEFAULT_INPUT_PREPARATION_RUNTIME } from "./input-preparation-compression.ts";
import { getBaseFileName, getDirectoryPath } from "./path-utils.ts";

const CHD_MERGED_SELECTION_PREFIX = "rom-weaver:chd-merged:";
const CHD_SPLIT_SELECTION_PREFIX = "rom-weaver:chd-split:";

const isCueGroupSelectionMatch = (group: CueGroupSelectionMatch, selectedEntryName: string) =>
  group.cueFileName === selectedEntryName ||
  group.trackFileNames.indexOf(selectedEntryName) !== -1 ||
  getBaseFileName(group.cueFileName).toLowerCase() === getBaseFileName(selectedEntryName).toLowerCase();

const isCompleteCueGroup = (group: Pick<CompressionRomCueGroup, "missingReferences" | "trackFileNames">) =>
  group.missingReferences.length === 0 &&
  group.trackFileNames.length > 0 &&
  group.trackFileNames.some((fileName) => !isCueEntryFileName(fileName));

const getSyntheticCueTrackEntries = (entries: ArchiveEntryLike[], cueFileName: string) =>
  entries.filter(
    (entry) =>
      entry.archiveEntryType === "track" &&
      !isCueEntryFileName(entry.filename) &&
      !isGdiEntryFileName(entry.filename) &&
      (!getDirectoryPath(cueFileName) || getDirectoryPath(entry.filename) === getDirectoryPath(cueFileName)),
  );

const isBinEntryFileName = (fileName: string) => /\.bin$/i.test(getBaseFileName(fileName));

const parseChdSplitSelection = (
  entryName: string | undefined,
): { chdSplitBin?: boolean; selectedEntryName?: string } => {
  const value = String(entryName || "");
  if (value.startsWith(CHD_SPLIT_SELECTION_PREFIX)) {
    return { chdSplitBin: true };
  }
  if (value.startsWith(CHD_MERGED_SELECTION_PREFIX)) {
    return { chdSplitBin: false };
  }
  return { selectedEntryName: value || undefined };
};

// A CHD disc lists its sheet as a `.cue` (CD-ROM) or `.gdi` (GD-ROM); both mark a
// multi-track disc that should auto-resolve to whole-disc split-bin extraction
// instead of prompting per track.
const getChdDiscSheetEntryName = (entries: ArchiveEntryLike[]) =>
  entries.find((entry) => isCueEntryFileName(entry.filename) || isGdiEntryFileName(entry.filename))?.filename || "";

const getChdBinEntries = (entries: ArchiveEntryLike[]) => entries.filter((entry) => isBinEntryFileName(entry.filename));

const reportChdCodecMode = (
  archiveFile: PatchFileInstance,
  options: InputPreparationOptions,
  chdMode: ChdCodecMode | null,
) => {
  if (!chdMode) return;
  reportProgress(options, {
    details: { chdMode },
    label: "Preparing CHD extraction...",
    percent: null,
    stage: "input",
  });
  traceArchivePreparation(options, "input.archive.chd-mode", {
    chdMode,
    file: describeArchiveFileForTrace(archiveFile),
  });
};

const resolveChdSplitBinSelection = async ({
  archiveFile,
  compressionFormat,
  kindFilter,
  options,
  runtime,
  selectedEntryName,
}: {
  archiveFile: PatchFileInstance;
  compressionFormat: string;
  kindFilter: CompressionEntryKindFilter;
  options: InputPreparationOptions;
  runtime: InputPreparationRuntimeLike;
  selectedEntryName?: string;
}): Promise<{ selectedEntryName?: string; chdMode?: ChdCodecMode; chdSplitBin?: boolean }> => {
  const parsedSelection = parseChdSplitSelection(selectedEntryName);
  if (parsedSelection.chdSplitBin !== undefined) return { ...parsedSelection, chdMode: "cd" };
  if (parsedSelection.selectedEntryName) return parsedSelection;
  if (compressionFormat !== "chd" || !kindFilter.romFilter || typeof options?.onCandidatesFound !== "function") {
    return parsedSelection;
  }

  const mergedResult = await listCompressionEntryResult(archiveFile, options, runtime, kindFilter, {
    chdSplitBin: false,
  });
  const splitResult = await listCompressionEntryResult(archiveFile, options, runtime, kindFilter, {
    chdSplitBin: true,
  });
  const chdMode = mergedResult.chdMode || splitResult.chdMode;
  reportChdCodecMode(archiveFile, options, chdMode);
  const mergedEntries = mergedResult.entries;
  const splitEntries = splitResult.entries;
  const mergedBinEntries = getChdBinEntries(mergedEntries);
  const splitBinEntries = getChdBinEntries(splitEntries);
  const cueEntryName = getChdDiscSheetEntryName(mergedEntries) || getChdDiscSheetEntryName(splitEntries);
  if (!(cueEntryName && mergedBinEntries.length === 1 && splitBinEntries.length > 1))
    return { ...parsedSelection, ...(chdMode ? { chdMode } : {}) };

  // A multi-track CD/GD disc is one logical ROM. Default to per-track split bins
  // — so each track gets its own checksums and can be patch-targeted, matching
  // how loose bin+cue discs are handled — instead of prompting Merged vs Split.
  return { chdMode: chdMode || "cd", chdSplitBin: true };
};

const probeCompressionRomEntriesForSource = async (
  archiveFile: PatchFileInstance,
  entries: ArchiveEntryLike[],
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
): Promise<CompressionRomProbe> => {
  const nestedCompressionEntries = filterNestedContainerEntries(entries);
  const directRomEntries = entries.filter(
    (entry) => !nestedCompressionEntries.some((candidate) => candidate.filename === entry.filename),
  );
  const romEntries = entries;
  const cueGroups: CompressionRomCueGroup[] = [];
  const referencedTrackNames = new Set<string>();
  for (const entry of romEntries) {
    const cueFileName = String(entry.filename || "");
    const sheetIsCue = isCueEntryFileName(cueFileName);
    const sheetIsGdi = isGdiEntryFileName(cueFileName);
    // A CHD CD/GD-ROM lists a `.cue`/`.gdi` sheet plus per-track `.bin`s; both
    // describe one disc, so group the tracks under the sheet (a GD-ROM `.gdi`
    // gets a synthetic disc group exactly like a `.cue`).
    if (!(sheetIsCue || sheetIsGdi)) continue;
    const syntheticTrackEntries =
      entry.archiveEntryType === "cue" || entry.archiveEntryType === "gdi"
        ? getSyntheticCueTrackEntries(entries, cueFileName)
        : [];
    if (syntheticTrackEntries.length) {
      const references = syntheticTrackEntries.map((trackEntry, index) => ({
        fileName: trackEntry.filename,
        mode: "MODE1/2048",
        patchable: true,
        trackNumber: index + 1,
        type: "BINARY",
      }));
      cueGroups.push({
        cueFileName,
        missingReferences: [],
        references,
        trackFileNames: syntheticTrackEntries.map((trackEntry) => {
          referencedTrackNames.add(trackEntry.filename);
          return trackEntry.filename;
        }),
      });
      continue;
    }
    // Only `.cue` text is read+parsed for references; a `.gdi` without synthetic
    // track entries is left for standalone handling rather than mis-parsed.
    if (!sheetIsCue) continue;
    try {
      const cueText = decodeUtf8(
        await extractArchiveEntryBytes(archiveFile, cueFileName, options, runtime, undefined, {
          romFilter: true,
        }),
      );
      const references = parseCueFileReferences(cueText);
      const trackFileNames: string[] = [];
      const missingReferences: string[] = [];
      for (const reference of references) {
        const trackEntry = findArchiveEntryByFileName(entries, cueFileName, reference.fileName) as
          | { filename: string }
          | undefined;
        if (!trackEntry) {
          missingReferences.push(reference.fileName);
          continue;
        }
        trackFileNames.push(trackEntry.filename);
        referencedTrackNames.add(trackEntry.filename);
      }
      cueGroups.push({
        cueFileName,
        cueText,
        missingReferences,
        references,
        trackFileNames,
      });
    } catch (_error) {
      cueGroups.push({
        cueFileName,
        missingReferences: ["Invalid or unreadable CUE"],
        trackFileNames: [],
      });
    }
  }
  // A single disc can ship both a `.cue` and a `.gdi` describing the same tracks
  // (e.g. a GD-ROM with a low-density CUE alongside its GDI). Each sheet builds its
  // own group above, so collapse sheets covering an identical track set into one
  // disc group — otherwise the disc reads as two competing candidates and prompts.
  const trackSetKey = (group: CompressionRomCueGroup) => JSON.stringify([...group.trackFileNames].sort());
  const dedupedCueGroups: CompressionRomCueGroup[] = [];
  const seenTrackSets = new Set<string>();
  for (const group of cueGroups) {
    const key = trackSetKey(group);
    if (key && seenTrackSets.has(key)) continue;
    if (key) seenTrackSets.add(key);
    dedupedCueGroups.push(group);
  }
  const standaloneEntries = romEntries.filter(
    (entry) =>
      !(
        isCueEntryFileName(entry.filename) ||
        isGdiEntryFileName(entry.filename) ||
        referencedTrackNames.has(entry.filename)
      ),
  );
  return {
    cueGroups: dedupedCueGroups,
    directRomEntries,
    nestedCompressionEntries,
    referencedTrackNames,
    romEntries,
    standaloneEntries,
  };
};

const resolveCompressionRomCueGroup = (
  cueGroups: CompressionRomCueGroup[],
  selectedEntryName: string,
): CompressionRomCueGroup | null =>
  cueGroups.find((group) => isCueGroupSelectionMatch(group, selectedEntryName)) || null;

const resolveCompressionRomAutoPickEntryName = (
  archiveFileName: string | undefined,
  probe: CompressionRomProbe,
  selectedEntryName: string,
): string | null => {
  const completeCueGroups = probe.cueGroups.filter((group) => isCompleteCueGroup(group));
  if (selectedEntryName) {
    const selectedGroup = resolveCompressionRomCueGroup(completeCueGroups, selectedEntryName);
    if (selectedGroup) return selectedGroup.cueFileName;
    const selectedEntry = probe.romEntries.find((entry) => entry.filename === selectedEntryName);
    return selectedEntry?.filename || selectedEntryName;
  }
  if (!probe.romEntries.length) return null;
  if (completeCueGroups.length === 1 && probe.standaloneEntries.length === 0)
    return completeCueGroups[0]?.cueFileName || null;
  if (completeCueGroups.length === 0 && probe.standaloneEntries.length === 1)
    return probe.standaloneEntries[0]?.filename || null;
  if (completeCueGroups.length === 0 && probe.romEntries.length === 1) return probe.romEntries[0]?.filename || null;
  throw new Error(`${archiveFileName || "Archive"} contains multiple input candidates`);
};

export { probeCompressionRomEntriesForSource, resolveChdSplitBinSelection, resolveCompressionRomAutoPickEntryName };
