import { parseGdiFileReferences as parseGdiReferences } from "../../workers/protocol/gdi-file-utils.ts";
import { normalizeArchiveEntryPath, stripFileNameQuery } from "./path-utils.ts";
import { parseCueFile } from "./rom-specific-file-utils.ts";

const PATCHABLE_DISC_MODE_REGEX = /^MODE\d\//i;
const CUE_EXTENSION_REGEX = /\.cue$/i;

type CueReference = {
  fileName: string;
  type: string;
  trackNumber?: number;
  mode?: string;
  patchable: boolean;
};

const isPatchableDiscTrack = (mode?: string | null) => !mode || PATCHABLE_DISC_MODE_REGEX.test(String(mode));

type ArchivePathValue = string | number | boolean | null | undefined;

const isCueEntryFileName = (fileName: ArchivePathValue): boolean =>
  CUE_EXTENSION_REGEX.test(stripFileNameQuery(fileName));

const GDI_EXTENSION_REGEX = /\.gdi$/i;

const isGdiEntryFileName = (fileName: ArchivePathValue): boolean =>
  GDI_EXTENSION_REGEX.test(stripFileNameQuery(fileName));

const parseGdiFileReferences = (gdiText: string): string[] =>
  parseGdiReferences(gdiText).map(normalizeArchiveEntryPath);

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

export { isCueEntryFileName, isGdiEntryFileName, parseCueFileReferences, parseGdiFileReferences };
