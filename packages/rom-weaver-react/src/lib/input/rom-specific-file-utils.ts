import { parseCueFile, replaceCuePatchFileName } from "../../workers/protocol/cue-file-utils.ts";

const BIN_EXTENSION_REGEX = /\.bin$/i;
const CUE_EXTENSION_REGEX = /\.cue$/i;

// Map the engine's `disc_format` verdict (Rust `rom_identity::DiscFormat::label()`
// — "CD"/"GD-ROM"/"DVD") to the optical-media label the CHD output panel shows.
// The verdict is computed once by the Rust ingest/checksum identity pass from
// disc signatures (not a TS filename/cue regex), so the UI mirrors exactly the
// media the CHD create produces. Returns `null` for a non-disc/unknown source.
const DISC_FORMAT_LABELS: Record<string, string> = {
  cd: "CD-ROM",
  dvd: "DVD",
  "gd-rom": "GD-ROM",
};

/** Display label for the engine-derived `disc_format` (e.g. "GD-ROM" → "GD-ROM"), or `null`. */
const getDiscFormatLabel = (discFormat: string | null | undefined): string | null => {
  const normalized = String(discFormat || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  return DISC_FORMAT_LABELS[normalized] ?? null;
};

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

export { getChdAutoCreateMode, getDiscFormatLabel, parseCueFile, replaceCuePatchFileName };
