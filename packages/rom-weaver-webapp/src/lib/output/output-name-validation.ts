import {
  CREATE_ARCHIVE_COMPRESSION_FORMATS,
  CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS,
  getCompressionOutputExtension,
} from "../compression/container-format-registry.ts";
import { isZ3dsCompressedExtension } from "../compression/z3ds-subtypes.ts";
import { getFileNameExtension, sanitizeTypedOutputName } from "../path-utils.ts";

const normalizeRequiredOutputName = (outputName: string | null | undefined) => sanitizeTypedOutputName(outputName);

const requireOutputName = (outputName: string | null | undefined) => {
  const normalized = normalizeRequiredOutputName(outputName);
  if (!normalized) throw new Error("output.outputName is required");
  return normalized;
};

// The extensions the format selector produces (`zip`/`7z`/`chd`/`rvz`/`z3ds`).
// z3ds subtype extensions (`zcia`/`zcci`/...) are matched separately via
// `isZ3dsCompressedExtension` since they are context-dependent.
const KNOWN_OUTPUT_EXTENSIONS: ReadonlySet<string> = new Set(
  [...CREATE_ARCHIVE_COMPRESSION_FORMATS, ...CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS].map((format) =>
    getCompressionOutputExtension(format).toLowerCase(),
  ),
);

/**
 * The trailing extension of `outputName` when it looks like one the output
 * format selector adds itself. The filename field is meant to be entered
 * without an extension, so a name that already carries an output-looking
 * extension would double up (`game.zip` + zip -> `game.zip.zip`). Returns the
 * matched extension (lower-cased, no dot) for the warning, else null.
 */
const detectOutputLikeExtension = (outputName: string | null | undefined): string | null => {
  const extension = getFileNameExtension(outputName);
  if (!extension) return null;
  if (KNOWN_OUTPUT_EXTENSIONS.has(extension) || isZ3dsCompressedExtension(extension)) return extension;
  return null;
};

export { detectOutputLikeExtension, requireOutputName };
