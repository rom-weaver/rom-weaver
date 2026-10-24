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

const getChdStructuralMode = (source: { fileName?: string; metadata?: SourceMetadata }): ChdCodecMode | undefined => {
  const metadata = source.metadata;
  if (metadata?.mode === "cd" || metadata?.mode === "dvd") return metadata.mode;
  if (
    metadata?.cuePath ||
    metadata?.cueText ||
    metadata?.gdiText ||
    /\.(cue|gdi)$/i.test(source.fileName || "") ||
    /\.(cue|gdi)$/i.test(metadata?.sourceFileName || "")
  )
    return "cd";
  return undefined;
};

const isLooseChdAutoSource = (source: { fileName?: string; metadata?: SourceMetadata }): boolean =>
  !getChdStructuralMode(source) &&
  (BIN_EXTENSION_REGEX.test(source.fileName || "") || !/\.[^./\\]+$/.test(source.fileName || ""));

/**
 * CHD create mode for a source: the structural/metadata verdicts, then the Rust ingest/probe verdict
 * (`metadata.chdCreateMode`, read from the file's bytes by native `chd` auto-inference). Without any
 * verdict a loose image stays "raw".
 */
const getChdAutoCreateMode = (source: { fileName?: string; metadata?: SourceMetadata }): string => {
  const structuralMode = getChdStructuralMode(source);
  if (structuralMode) return structuralMode;
  const mode = chdModeFromMetadata(source.metadata);
  if (mode && !isLooseChdAutoSource(source)) return mode;
  return source.metadata?.chdCreateMode || mode || "raw";
};

/** Codec-mode hint for a Rust create-mode verdict: DVD and hard-disk images take the DVD codec set. */
const chdCodecModeFromCreateMode = (createMode: string | null | undefined): "dvd" | undefined =>
  createMode === "dvd" || createMode === "hd" ? "dvd" : undefined;

export {
  chdCodecModeFromCreateMode,
  chdModeFromMetadata,
  discFormatToChdMode,
  getChdAutoCreateMode,
  getDiscFormatLabel,
  isLooseChdAutoSource,
  parseCueFile,
  replaceCuePatchFileName,
};
