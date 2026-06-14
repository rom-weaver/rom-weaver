import { parseCueFile, replaceCuePatchFileName } from "../../workers/protocol/cue-file-utils.ts";

const BIN_EXTENSION_REGEX = /\.bin$/i;
const CUE_EXTENSION_REGEX = /\.cue$/i;
const GDI_EXTENSION_REGEX = /\.gdi$/i;
// GD-ROM cue sheets mark the inner program area with `REM HIGH-DENSITY AREA`;
// this mirrors the engine's GD-vs-CD auto-detection so the UI label matches the
// media the CHD create actually produces.
const GDROM_DENSITY_MARKER_REGEX = /^\s*REM\b[^\n]*HIGH-DENSITY AREA/im;

type DiscKind = "gd" | "cd";

const DISC_KIND_LABELS: Record<DiscKind, string> = { cd: "CD-ROM", gd: "GD-ROM" };

/** Detect GD-ROM vs CD-ROM media for a disc source from its name and cue text. */
const getDiscKind = ({ fileName, cueText }: { fileName?: string; cueText?: string }): DiscKind | null => {
  const name = String(fileName || "");
  if (GDI_EXTENSION_REGEX.test(name)) return "gd";
  if (cueText && GDROM_DENSITY_MARKER_REGEX.test(cueText)) return "gd";
  if (CUE_EXTENSION_REGEX.test(name) || BIN_EXTENSION_REGEX.test(name) || (cueText ?? "").trim().length > 0) {
    return "cd";
  }
  return null;
};

const getDiscKindLabel = (kind: DiscKind | null | undefined): string | null => (kind ? DISC_KIND_LABELS[kind] : null);

type ByteProbeableSource = {
  _u8array?: Uint8Array;
  fileName?: string;
  getExtension?: () => string;
  readIntoAt?: (buffer: Uint8Array, bufferOffset?: number, len?: number, fileOffset?: number) => number | undefined;
};

const getChdAutoCreateMode = (
  source: ByteProbeableSource & { _chdCuePath?: string; _chdCueText?: string; _chdMode?: string },
): string => {
  if (source._chdMode === "cd" || source._chdCuePath || source._chdCueText) return "cd";
  if (source._chdMode === "dvd") return "dvd";
  const fileName = String(source.fileName || "");
  return CUE_EXTENSION_REGEX.test(fileName) || BIN_EXTENSION_REGEX.test(fileName) ? "cd" : "dvd";
};

export { getChdAutoCreateMode, getDiscKind, getDiscKindLabel, parseCueFile, replaceCuePatchFileName };
