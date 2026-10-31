import { ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY } from "../../wasm/generated/rom-weaver-format-metadata.ts";

type CreatePatchFormatPreferenceInput = {
  automaticFormatSelection?: boolean;
  candidateDefaultFormat?: string | null;
  candidateFormats?: readonly string[] | null;
  modifiedSize?: number | null;
  originalSize?: number | null;
  requestedFormat?: string | null;
};
type CreatePatchFormatList = readonly [string, ...string[]];

const CREATE_IPS_SIZE_LIMIT_BYTES = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.limits.ipsSizeLimitBytes;
const CREATE_BPS_DEFAULT_LIMIT_BYTES = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.limits.bpsDefaultSizeBytes;
const CREATE_BPS_MAX_COMBINED_INPUT_BYTES = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.limits.bpsMaxCombinedInputBytes;
const CREATE_LEGACY_PATCH_SIZE_LIMIT_BYTES = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.limits.legacySizeLimitBytes;
const CREATE_PATCH_DEFAULT_FORMAT = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.defaultFormat;
// The CLI treats `vcdiff` as plain VCDIFF, but browser Create only offers xdelta, so a caller-supplied
// `vcdiff` still means xdelta here.
const CREATE_PATCH_FORMAT_ALIASES: Readonly<Record<string, string>> = {
  ...(ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.aliases as Readonly<Record<string, string>>),
  vcdiff: "xdelta",
};

const NO_SHRINK_CREATE_PATCH_FORMATS: readonly string[] = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.noShrinkFormats;
const SOURCE_RESTRICTED_CREATE_PATCH_FORMATS: readonly string[] =
  ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.sourceRestrictedFormats;

const SMALL_CREATE_PATCH_FORMATS: CreatePatchFormatList = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.formats.small;
const MEDIUM_CREATE_PATCH_FORMATS: CreatePatchFormatList = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.formats.medium;
const MID_LARGE_CREATE_PATCH_FORMATS: CreatePatchFormatList = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.formats.midLarge;
const LARGE_CREATE_PATCH_FORMATS: CreatePatchFormatList = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.formats.large;

const normalizeCreatePatchFormat = (format: string | null | undefined) => {
  const normalized = String(format || "")
    .trim()
    .toLowerCase();
  return CREATE_PATCH_FORMAT_ALIASES[normalized] || normalized;
};

const getFiniteCreateSourceSize = (size?: number | null) =>
  typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : 0;

const getMaxCreateRomSize = (...sizes: Array<number | null | undefined>) => {
  let maxSize = 0;
  for (const size of sizes) maxSize = Math.max(maxSize, getFiniteCreateSourceSize(size));
  return maxSize;
};

const getCreatePatchFormatsForSizeBucket = (...sizes: Array<number | null | undefined>) => {
  const maxSize = getMaxCreateRomSize(...sizes);
  if (maxSize > CREATE_LEGACY_PATCH_SIZE_LIMIT_BYTES) return LARGE_CREATE_PATCH_FORMATS;
  if (maxSize >= CREATE_BPS_DEFAULT_LIMIT_BYTES) return MID_LARGE_CREATE_PATCH_FORMATS;
  if (maxSize >= CREATE_IPS_SIZE_LIMIT_BYTES) return MEDIUM_CREATE_PATCH_FORMATS;
  return SMALL_CREATE_PATCH_FORMATS;
};

/** True when the target is known to be smaller than the source, which some formats cannot encode. */
const isShrinkingCreate = (originalSize?: number | null, modifiedSize?: number | null) =>
  typeof originalSize === "number" &&
  typeof modifiedSize === "number" &&
  Number.isFinite(originalSize) &&
  Number.isFinite(modifiedSize) &&
  modifiedSize < originalSize;

const withoutNoShrinkFormats = <T extends string>(
  formats: readonly T[],
  originalSize?: number | null,
  modifiedSize?: number | null,
): readonly T[] =>
  isShrinkingCreate(originalSize, modifiedSize)
    ? formats.filter((format) => !NO_SHRINK_CREATE_PATCH_FORMATS.includes(format))
    : formats;

/** BPS indexes both files in memory, so the cap applies to their combined size, not the larger one. */
const withoutBpsAboveMemoryCap = <T extends string>(
  formats: readonly T[],
  originalSize?: number | null,
  modifiedSize?: number | null,
): readonly T[] =>
  getFiniteCreateSourceSize(originalSize) + getFiniteCreateSourceSize(modifiedSize) >
  CREATE_BPS_MAX_COMBINED_INPUT_BYTES
    ? formats.filter((format) => format !== "bps")
    : formats;

/**
 * Formats Create accepts for the sizes (original first). Source-restricted formats stay allowed here
 * because only the resolved candidates can say whether the original is the one ROM they target.
 */
const getCreatePatchFormatsForSizes = (originalSize?: number | null, modifiedSize?: number | null) =>
  withoutBpsAboveMemoryCap(
    withoutNoShrinkFormats(getCreatePatchFormatsForSizeBucket(originalSize, modifiedSize), originalSize, modifiedSize),
    originalSize,
    modifiedSize,
  );

const normalizeCandidateCreatePatchFormats = (formats?: readonly string[] | null): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const format of Array.isArray(formats) ? formats : []) {
    const normalized = normalizeCreatePatchFormat(format);
    if (!(normalized && !seen.has(normalized))) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

/**
 * Planned candidates MUST respect prepared ROM sizes: archive plans measure compressed inputs.
 * Source-restricted formats MUST stay hidden without resolved candidates. Prepared sizes MUST
 * enforce shrinking restrictions even when the plan only measured compressed inputs.
 */
const getSelectableCreatePatchFormats = ({
  candidateFormats,
  modifiedSize,
  originalSize,
}: {
  candidateFormats?: readonly string[] | null;
  modifiedSize?: number | null;
  originalSize?: number | null;
}): readonly string[] => {
  const candidates = normalizeCandidateCreatePatchFormats(candidateFormats);
  const sizeFormats = getCreatePatchFormatsForSizes(originalSize, modifiedSize);
  const formats = candidates.length
    ? candidates.filter((format) => sizeFormats.includes(format))
    : sizeFormats.filter((format) => !SOURCE_RESTRICTED_CREATE_PATCH_FORMATS.includes(format));
  return formats;
};

const getPreferredCreatePatchFormat = ({
  automaticFormatSelection = true,
  candidateDefaultFormat,
  candidateFormats,
  modifiedSize,
  originalSize,
  requestedFormat,
}: CreatePatchFormatPreferenceInput) => {
  const formats = getSelectableCreatePatchFormats({ candidateFormats, modifiedSize, originalSize });
  const normalizedRequestedFormat = normalizeCreatePatchFormat(requestedFormat);
  const normalizedCandidateDefaultFormat = normalizeCreatePatchFormat(candidateDefaultFormat);
  // The default comes from Rust: the resolved candidate default already accounts
  // for archive/special-compression inputs. Before candidates resolve, fall back
  // to the preferred-first entry of the size-bucket list (the generated table is
  // ordered best-first) rather than re-deriving the default policy here.
  const supportedDefaultFormat =
    normalizedCandidateDefaultFormat && formats.includes(normalizedCandidateDefaultFormat)
      ? normalizedCandidateDefaultFormat
      : (formats[0] ?? CREATE_PATCH_DEFAULT_FORMAT);
  if (!normalizedRequestedFormat) return supportedDefaultFormat;
  if (
    automaticFormatSelection &&
    normalizedRequestedFormat === CREATE_PATCH_DEFAULT_FORMAT &&
    formats.includes(supportedDefaultFormat)
  )
    return supportedDefaultFormat;
  return formats.includes(normalizedRequestedFormat) ? normalizedRequestedFormat : supportedDefaultFormat;
};

export {
  CREATE_BPS_DEFAULT_LIMIT_BYTES,
  CREATE_BPS_MAX_COMBINED_INPUT_BYTES,
  CREATE_IPS_SIZE_LIMIT_BYTES,
  CREATE_LEGACY_PATCH_SIZE_LIMIT_BYTES,
  getCreatePatchFormatsForSizes,
  getSelectableCreatePatchFormats,
  getPreferredCreatePatchFormat,
  normalizeCreatePatchFormat,
};
