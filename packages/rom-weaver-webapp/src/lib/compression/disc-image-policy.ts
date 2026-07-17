import { ROM_WEAVER_DISC_IMAGE_POLICY } from "../../wasm/generated/rom-weaver-format-metadata.ts";

// Single consumption point for the Rust-owned disc-image policy (the canonical sector sizes +
// ambiguous-extension list surfaced via typegen). The webapp used to carry two copies of this
// size heuristic (output-compression-manager + container-format-registry); both now read this.
//
// `.bin` doubles as a CD/DVD disc image (bin/cue) and a bare console ROM dump. An ambiguous-extension
// source whose size is not a whole number of CD/DVD sectors is treated as a plain ROM, not a disc
// image; an unknown/non-positive size keeps the extension-based resolution (returns `true`).

const AMBIGUOUS_DISC_IMAGE_EXTENSIONS: readonly string[] = ROM_WEAVER_DISC_IMAGE_POLICY.ambiguousDiscImageExtensions;
const CD_SECTOR_SIZES: readonly number[] = ROM_WEAVER_DISC_IMAGE_POLICY.cdSectorSizes;

const normalizeDiscImageExtension = (extension: string | null | undefined): string =>
  String(extension ?? "")
    .trim()
    .replace(/^\./, "")
    .toLowerCase();

/** Whether `extension` is one of the disc-image/ROM ambiguous extensions (currently `.bin`). */
const isAmbiguousDiscImageExtension = (extension: string | null | undefined): boolean =>
  AMBIGUOUS_DISC_IMAGE_EXTENSIONS.includes(normalizeDiscImageExtension(extension));

/** Whether `size` is a whole number of CD/DVD logical sectors (or unknown - then assume disc). */
const isLikelyDiscImageSize = (size: number | null | undefined): boolean => {
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return true;
  return CD_SECTOR_SIZES.some((sectorSize) => size % sectorSize === 0);
};

/**
 * Whether a source with the given `extension` and `size` is a disc image rather than a bare ROM dump.
 * Non-ambiguous extensions are always disc images; an ambiguous extension is a disc image only when
 * its size is sector-aligned (or its size is unknown).
 */
const isLikelyDiscImageSource = (extension: string | null | undefined, size: number | null | undefined): boolean => {
  if (!isAmbiguousDiscImageExtension(extension)) return true;
  return isLikelyDiscImageSize(size);
};

export { isAmbiguousDiscImageExtension, isLikelyDiscImageSize, isLikelyDiscImageSource };
