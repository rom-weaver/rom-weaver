import {
  CREATE_ARCHIVE_COMPRESSION_FORMATS,
  CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS,
  getCompressionOutputExtension,
} from "../compression/container-format-registry.ts";
import { isZ3dsCompressedExtension } from "../compression/z3ds-subtypes.ts";
import { ROM_WEAVER_FILE_FILTERS } from "../../wasm/generated/rom-weaver-format-metadata.ts";
import { appendFileNameExtension } from "../input/path-utils.ts";
import { sanitizeTypedOutputName, stripLeadingExtensionDot } from "../path-utils.ts";

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

// Index of the last dot in a typed or manifest file name, or -1. Unlike the URL-aware
// path helpers, `#` and `?` are literal here: `Kaizo Mario #2.sfc` ends in `.sfc`.
const findLiteralExtensionDotIndex = (fileName: string): number => {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 && dotIndex < fileName.length - 1 ? dotIndex : -1;
};

const getLiteralFileNameExtension = (fileName: string | null | undefined): string => {
  const text = fileName ?? "";
  const dotIndex = findLiteralExtensionDotIndex(text);
  return dotIndex < 0 ? "" : text.slice(dotIndex + 1).toLowerCase();
};

/**
 * The trailing extension of `outputName` when it looks like one the output
 * format selector adds itself. The filename field is meant to be entered
 * without an extension, so a name that already carries an output-looking
 * extension would double up (`game.zip` + zip -> `game.zip.zip`). Returns the
 * matched extension (lower-cased, no dot) for the warning, else null.
 */
const detectOutputLikeExtension = (outputName: string | null | undefined): string | null => {
  const extension = getLiteralFileNameExtension(outputName);
  if (!extension) return null;
  if (KNOWN_OUTPUT_EXTENSIONS.has(extension) || isZ3dsCompressedExtension(extension)) return extension;
  return null;
};

// Every extension the app reads or writes, lower-cased without the dot.
const KNOWN_FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  [
    ...ROM_WEAVER_FILE_FILTERS.romExtensions,
    ...ROM_WEAVER_FILE_FILTERS.containerExtensions,
    ...ROM_WEAVER_FILE_FILTERS.patchExtensions,
  ].map((extension) => stripLeadingExtensionDot(extension).toLowerCase()),
);

/**
 * Whether `fileName` already ends in a real file extension: the source's own
 * or one the app knows. The last dot alone is not enough - in a versioned stem
 * such as `Practice 3.5.1`, `.1` belongs to the name.
 */
const hasKnownOutputExtension = (fileName: string, sourceExtension?: string | null): boolean => {
  const extension = getLiteralFileNameExtension(fileName);
  if (!extension) return false;
  return extension === stripLeadingExtensionDot(sourceExtension).toLowerCase() || KNOWN_FILE_EXTENSIONS.has(extension);
};

/** `fileName` without its trailing extension when that extension is a known one; the stem stays whole. */
const removeKnownOutputExtension = (fileName: string): string => {
  if (!hasKnownOutputExtension(fileName)) return fileName;
  return fileName.slice(0, findLiteralExtensionDotIndex(fileName));
};

/** `fileName` with `sourceExtension` appended unless it already ends in a known extension. */
const withOutputExtension = (fileName: string, sourceExtension: string | null | undefined): string =>
  sourceExtension && !hasKnownOutputExtension(fileName, sourceExtension)
    ? appendFileNameExtension(fileName, sourceExtension)
    : fileName;

export {
  detectOutputLikeExtension,
  getLiteralFileNameExtension,
  hasKnownOutputExtension,
  removeKnownOutputExtension,
  requireOutputName,
  withOutputExtension,
};
