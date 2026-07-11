import { createLogger } from "../../lib/logging.ts";
import { ROM_WEAVER_FILE_FILTERS } from "../../wasm/generated/rom-weaver-format-metadata.ts";

/**
 * Single source of truth for classifying a dropped file by name into a patch,
 * an archive/container, or a ROM/input. The unified dropzone routes files to
 * buckets based on these predicates, and `file-input-accept.ts` derives its
 * `accept` attributes from the same extension sets so the picker and the
 * drop-time classifier never drift apart.
 */

const logger = createLogger("file-classification");

const stripLeadingExtensionDot = (extension: string) => extension.replace(/^\./, "");
const unique = <TValue>(values: readonly TValue[]) => [...new Set(values)];

/** Patch extensions (e.g. `ips`, `bps`), no leading dot. */
const PATCH_FILE_EXTENSIONS = ROM_WEAVER_FILE_FILTERS.patchExtensions.map(stripLeadingExtensionDot);
/**
 * Patch extensions plus their numbered soft-patch variants (`ips` → `ips1`),
 * which tools emit when a single ROM ships multiple stacked patches.
 */
const PATCH_FILE_EXTENSION_VARIANTS = unique([
  ...PATCH_FILE_EXTENSIONS,
  ...PATCH_FILE_EXTENSIONS.map((extension) => `${extension}1`),
]);
/** Archive/container extensions (e.g. `zip`, `7z`, `chd`), no leading dot. */
const ARCHIVE_FILE_EXTENSIONS = ROM_WEAVER_FILE_FILTERS.containerExtensions.map(stripLeadingExtensionDot);
/** ROM/input extensions (e.g. `sfc`, `iso`, `nds`), no leading dot. */
const ROM_FILE_EXTENSIONS = ROM_WEAVER_FILE_FILTERS.romExtensions.map(stripLeadingExtensionDot);

const hasKnownExtension = (fileName: string, extensions: readonly string[]) => {
  const normalized = fileName.trim().toLowerCase();
  return extensions.some((extension) => normalized.endsWith(`.${extension.toLowerCase()}`));
};

const isPatchFileName = (fileName: string) => hasKnownExtension(fileName, PATCH_FILE_EXTENSION_VARIANTS);
const isArchiveFileName = (fileName: string) => hasKnownExtension(fileName, ARCHIVE_FILE_EXTENSIONS);
const isRomFileName = (fileName: string) => hasKnownExtension(fileName, ROM_FILE_EXTENSIONS);

type DroppedFileClass = "patch" | "archive" | "rom" | "unknown";

/**
 * Classify a single name with a fixed precedence: patch wins over archive wins
 * over ROM. The precedence matters because some extensions overlap (`.chd` and
 * `.cso` are both containers and ROMs); treating them as archives lets the
 * extract pipeline probe them. Unknown names fall through to the input bucket.
 */
const classifyFileName = (fileName: string): DroppedFileClass => {
  if (isPatchFileName(fileName)) return "patch";
  if (isArchiveFileName(fileName)) return "archive";
  if (isRomFileName(fileName)) return "rom";
  return "unknown";
};

type DroppedFileClassification = {
  /** ROMs and unknown files - routed to a tab's input bucket(s). */
  inputs: File[];
  /** Patch files - routed to a tab's patch bucket when it has one. */
  patches: File[];
  /** Archives/containers - surfaced separately so callers can decide whether to extract or treat as a patch container. */
  archives: File[];
};

/**
 * Split a dropped `File[]` into patches, archives, and inputs (ROM/unknown).
 * Each file lands in exactly one group by {@link classifyFileName} precedence.
 */
const classifyDroppedFiles = (files: File[]): DroppedFileClassification => {
  const result: DroppedFileClassification = { archives: [], inputs: [], patches: [] };
  for (const file of files) {
    const classification = classifyFileName(file.name);
    logger.trace("classified dropped file", { classification, name: file.name });
    if (classification === "patch") {
      result.patches.push(file);
    } else if (classification === "archive") {
      result.archives.push(file);
    } else {
      if (classification === "unknown") {
        logger.warn("dropped file matched no known extension - defaulting to input", { name: file.name });
      }
      result.inputs.push(file);
    }
  }
  logger.trace("classified dropped files", {
    archiveCount: result.archives.length,
    inputCount: result.inputs.length,
    patchCount: result.patches.length,
  });
  return result;
};

export {
  ARCHIVE_FILE_EXTENSIONS,
  classifyDroppedFiles,
  classifyFileName,
  isArchiveFileName,
  isPatchFileName,
  isRomFileName,
  PATCH_FILE_EXTENSION_VARIANTS,
  PATCH_FILE_EXTENSIONS,
  ROM_FILE_EXTENSIONS,
};
