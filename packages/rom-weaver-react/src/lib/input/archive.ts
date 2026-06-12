import { getBaseFileName, getDirectoryPath, normalizeArchiveEntryPath, stripFileNameQuery } from "./path-utils.ts";
import { getSingleTrackCdExtractionPlan, parseCueFile } from "./rom-specific-file-utils.ts";

const TAR_BZ2_EXTENSION_REGEX = /(\.tar\.bz2|\.tbz|\.tbz2)$/i;
const RAR_EXTENSION_REGEX = /\.rar$/i;
const TAR_GZ_EXTENSION_REGEX = /(\.tar\.gz|\.tgz)$/i;
const PATCHABLE_DISC_MODE_REGEX = /^MODE\d\//i;
const TAR_XZ_EXTENSION_REGEX = /(\.tar\.xz|\.txz)$/i;
const TAR_LZMA_EXTENSION_REGEX = /(\.tar\.lzma|\.tlz)$/i;
const TAR_EXTENSION_REGEX = /\.tar$/i;
const CUE_EXTENSION_REGEX = /\.cue$/i;
const SEVEN_ZIP_EXTENSION_REGEX = /\.7z$/i;
const FILE_QUERY_OR_HASH_REGEX = /[?#].*$/;
const ZIPX_EXTENSION_REGEX = /\.zipx$/i;
const ZIP_EXTENSION_REGEX = /\.zip$/i;

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

type ArchiveLabelValue = string | number | boolean | null | undefined;

const isPatchableDiscTrack = (mode?: string | null) => !mode || PATCHABLE_DISC_MODE_REGEX.test(String(mode));

const getArchiveLabelFromFileName = (fileName: ArchiveLabelValue): string => {
  const normalized = String(fileName || "")
    .toLowerCase()
    .replace(FILE_QUERY_OR_HASH_REGEX, "");
  if (ZIPX_EXTENSION_REGEX.test(normalized)) return "ZIPX";
  if (ZIP_EXTENSION_REGEX.test(normalized)) return "ZIP";
  if (SEVEN_ZIP_EXTENSION_REGEX.test(normalized)) return "7z";
  if (RAR_EXTENSION_REGEX.test(normalized)) return "RAR";
  if (TAR_GZ_EXTENSION_REGEX.test(normalized)) return "TAR.GZ";
  if (TAR_BZ2_EXTENSION_REGEX.test(normalized)) return "TAR.BZ2";
  if (TAR_XZ_EXTENSION_REGEX.test(normalized)) return "TAR.XZ";
  if (TAR_LZMA_EXTENSION_REGEX.test(normalized)) return "TAR.LZMA";
  if (TAR_EXTENSION_REGEX.test(normalized)) return "TAR";
  return "archive";
};

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

const findCueBinEntry = (cueEntryName: ArchivePathValue, cueText: string, archiveEntries: ArchiveEntry[]) => {
  const plan = getSingleTrackCdExtractionPlan(cueText);
  const entry = findArchiveEntryByFileName(archiveEntries, cueEntryName, plan.fileName);

  if (!entry) throw new Error(`CUE file references missing archive entry: ${plan.fileName}`);
  return {
    binEntry: entry,
    cueText: cueText,
    plan: plan,
  };
};

export {
  findArchiveEntryByFileName,
  findCueBinEntry,
  getArchiveEntryBaseName,
  getArchiveEntryDirectory,
  getArchiveLabelFromFileName,
  isCueEntryFileName,
  isGdiEntryFileName,
  parseCueFileReferences,
  parseGdiFileReferences,
};
