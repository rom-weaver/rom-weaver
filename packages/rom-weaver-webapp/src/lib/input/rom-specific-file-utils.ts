import type { SourceMetadata } from "../../types/workflow-source.ts";
import { parseCueFile, replaceCuePatchFileName } from "../../workers/protocol/cue-file-utils.ts";

const BIN_EXTENSION_REGEX = /\.bin$/i;

// Map the engine's `disc_format` verdict (Rust `rom_identity::DiscFormat::label()`
// - "CD"/"GD-ROM"/"DVD") to the optical-media label the CHD output panel shows.
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

type ChdCodecMode = "cd" | "dvd";

/** Map the engine's `disc_format` verdict ("CD"/"GD-ROM"/"DVD") to the CHD create/recompress mode, or
 * `undefined` when the source is not a recognized optical medium. */
const discFormatToChdMode = (discFormat: string | null | undefined): ChdCodecMode | undefined => {
  const lower = String(discFormat || "").toLowerCase();
  if (lower === "dvd") return "dvd";
  if (lower === "cd" || lower.includes("gd")) return "cd";
  return undefined;
};

/** Coarse CHD codec mode for a source's metadata: the pre-identity `mode` if it is a CHD mode
 * ("cd"/"dvd"), else the Rust identity verdict (`format`). A non-CHD `mode` (e.g. rvz "iso"/"rvz")
 * is ignored so it can't be misread as a CHD mode. Never consults the display label. */
const chdModeFromMetadata = (metadata: SourceMetadata | null | undefined): ChdCodecMode | undefined => {
  const mode = metadata?.mode;
  if (mode === "cd" || mode === "dvd") return mode;
  return discFormatToChdMode(metadata?.format);
};

type ByteProbeableSource = {
  _u8array?: Uint8Array;
  _browserFileBacked?: boolean;
  fileName?: string;
  fileSize?: number;
  size?: number;
  getExtension?: () => string;
  readIntoAt?: (buffer: Uint8Array, bufferOffset?: number, len?: number, fileOffset?: number) => number | undefined;
};

const matchesSourceBytes = (source: ByteProbeableSource, offset: number, expected: readonly number[]): boolean => {
  if (source._u8array) return expected.every((byte, index) => source._u8array?.[offset + index] === byte);
  if (source._browserFileBacked || !source.readIntoAt) return false;
  const bytes = new Uint8Array(expected.length);
  try {
    source.readIntoAt(bytes, 0, bytes.length, offset);
    return expected.every((byte, index) => bytes[index] === byte);
  } catch {
    return false;
  }
};

const getChdAutoCreateMode = (source: ByteProbeableSource & { metadata?: SourceMetadata }): string => {
  const mode = chdModeFromMetadata(source.metadata);
  if (mode) return mode;
  if (source.metadata?.cuePath) return "cd";
  const fileName = String(source.fileName || "");
  if (/\.(cue|gdi)$/i.test(fileName)) return "cd";
  const size = source.fileSize ?? source.size;
  const sectorSized = typeof size === "number" && size > 0 && (size % 2048 === 0 || size % 2352 === 0);
  if (/\.iso$/i.test(fileName)) return sectorSized && size <= 450_000 * 2048 ? "cd" : "dvd";
  // Ambiguous inputs MUST carry the same CD signatures used by the native CHD inference.
  if (sectorSized && (BIN_EXTENSION_REGEX.test(fileName) || !/\.[^./\\]+$/.test(fileName))) {
    const isoId = [67, 68, 48, 48, 49];
    if (
      (size % 2352 === 0 &&
        (matchesSourceBytes(source, 0, [0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0]) ||
          matchesSourceBytes(source, 16 * 2352 + 17, isoId))) ||
      (size % 2048 === 0 && matchesSourceBytes(source, 16 * 2048 + 1, isoId))
    )
      return "cd";
  }
  return "raw";
};

export {
  chdModeFromMetadata,
  discFormatToChdMode,
  getChdAutoCreateMode,
  getDiscFormatLabel,
  parseCueFile,
  replaceCuePatchFileName,
};
