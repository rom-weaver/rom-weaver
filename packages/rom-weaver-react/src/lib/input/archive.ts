import { getBaseFileName, getDirectoryPath, normalizeArchiveEntryPath, stripFileNameQuery } from "./path-utils.ts";
import { parseCueFile } from "./rom-specific-file-utils.ts";

const PATCHABLE_DISC_MODE_REGEX = /^MODE\d\//i;
const CUE_EXTENSION_REGEX = /\.cue$/i;

type ArchiveEntry = {
  filename?: string;
};

type CueReference = {
  fileName: string;
  type: string;
  trackNumber?: number;
  mode?: string;
  patchable: boolean;
};

const isPatchableDiscTrack = (mode?: string | null) => !mode || PATCHABLE_DISC_MODE_REGEX.test(String(mode));

type ArchivePathValue = string | number | boolean | null | undefined;

const getArchiveEntryBaseName = (fileName: ArchivePathValue): string => getBaseFileName(fileName);

const getArchiveEntryDirectory = (fileName: ArchivePathValue): string => getDirectoryPath(fileName);

const isCueEntryFileName = (fileName: ArchivePathValue): boolean =>
  CUE_EXTENSION_REGEX.test(stripFileNameQuery(fileName));

const GDI_EXTENSION_REGEX = /\.gdi$/i;

const isGdiEntryFileName = (fileName: ArchivePathValue): boolean =>
  GDI_EXTENSION_REGEX.test(stripFileNameQuery(fileName));

// A `.gdi` track line is `num lba type sectorSize filename fileOffset`; the
// filename (5th column) may be quoted. The first non-empty line is the track
// count. Returns the referenced data-file names in order.
const parseGdiFileReferences = (gdiText: string): string[] => {
  const lines = gdiText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const references: string[] = [];
  for (const line of lines.slice(1)) {
    const match = line.match(/^\S+\s+\S+\s+\S+\s+\S+\s+(?:"([^"]+)"|(\S+))/);
    const name = match?.[1] ?? match?.[2];
    if (name) references.push(normalizeArchiveEntryPath(name));
  }
  return references;
};

const parseCueFileReferences = (cueText: string): CueReference[] => {
  const parsed = parseCueFile(cueText);
  return parsed.files.map((file) => {
    const tracks = parsed.tracks.filter((track) => track.file === file);
    return {
      fileName: normalizeArchiveEntryPath(file.name),
      mode: tracks[0]?.mode,
      patchable: isPatchableDiscTrack(tracks[0]?.mode),
      trackNumber: tracks[0]?.number,
      type: file.type,
    };
  });
};

const findArchiveEntryByFileName = (
  archiveEntries: ArchiveEntry[],
  parentEntryName: ArchivePathValue,
  referencedFileName: ArchivePathValue,
): ArchiveEntry | undefined => {
  const parentDirectory = getArchiveEntryDirectory(parentEntryName);
  const normalizedReference = normalizeArchiveEntryPath(referencedFileName);
  const expectedEntryName = parentDirectory + normalizedReference;
  const expectedBaseName = getArchiveEntryBaseName(normalizedReference).toLowerCase();
  return (
    archiveEntries.find((candidate) => candidate.filename === expectedEntryName) ||
    archiveEntries.find(
      (candidate) =>
        String(candidate.filename || "").slice(0, parentDirectory.length) === parentDirectory &&
        getArchiveEntryBaseName(candidate.filename).toLowerCase() === expectedBaseName,
    )
  );
};

export {
  findArchiveEntryByFileName,
  isCueEntryFileName,
  isGdiEntryFileName,
  parseCueFileReferences,
  parseGdiFileReferences,
};
