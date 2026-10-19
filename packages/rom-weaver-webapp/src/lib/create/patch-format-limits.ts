import { ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY } from "../../wasm/generated/rom-weaver-format-metadata.ts";

type CreatePatchFormatPreferenceInput = {
  automaticFormatSelection?: boolean;
  candidateDefaultFormat?: string | null;
  candidateFormats?: readonly string[] | null;
  modifiedSize?: number | null;
  originalSize?: number | null;
  requestedFormat?: string | null;
  requireKnownModifiedSize?: boolean;
};
type CreatePatchFormatList = readonly [string, ...string[]];

const CREATE_IPS_SIZE_LIMIT_BYTES = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.limits.ipsSizeLimitBytes;
const CREATE_BPS_DEFAULT_LIMIT_BYTES = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.limits.bpsDefaultSizeBytes;
const CREATE_LEGACY_PATCH_SIZE_LIMIT_BYTES = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.limits.legacySizeLimitBytes;
const CREATE_PATCH_DEFAULT_FORMAT = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.defaultFormat;
const CREATE_PATCH_FORMAT_ALIASES = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.aliases as Readonly<Record<string, string>>;

const SMALL_CREATE_PATCH_FORMATS: CreatePatchFormatList = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.formats.small;
const MEDIUM_CREATE_PATCH_FORMATS: CreatePatchFormatList = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.formats.medium;
const MID_LARGE_CREATE_PATCH_FORMATS: CreatePatchFormatList = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.formats.midLarge;
const LARGE_CREATE_PATCH_FORMATS: CreatePatchFormatList = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.formats.large;

// Formats the CLI accepts but never recommends (see EXTENDED_*_CREATE_PATCH_FORMATS in
// patch_commands.rs). They trail the recommended entries so defaults never change.
const EXTENDED_SMALL_CREATE_PATCH_FORMATS: readonly string[] =
  ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.extendedFormats.small;
const EXTENDED_LEGACY_CREATE_PATCH_FORMATS: readonly string[] =
  ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.extendedFormats.legacy;

// PAT create requires equal input lengths, so it is only offered when the known sizes match.
const CREATE_EQUAL_LENGTH_ONLY_FORMAT = "pat";

// IPS32 and EBP cannot encode a truncate footer, so a smaller Modified ROM would apply at the Original length.
const CREATE_NO_SHRINK_FORMATS: readonly string[] = ["ips32", "ebp"];

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

const getRecommendedCreatePatchFormatsForSizes = (maxSize: number): CreatePatchFormatList => {
  if (maxSize > CREATE_LEGACY_PATCH_SIZE_LIMIT_BYTES) return LARGE_CREATE_PATCH_FORMATS;
  if (maxSize >= CREATE_BPS_DEFAULT_LIMIT_BYTES) return MID_LARGE_CREATE_PATCH_FORMATS;
  if (maxSize >= CREATE_IPS_SIZE_LIMIT_BYTES) return MEDIUM_CREATE_PATCH_FORMATS;
  return SMALL_CREATE_PATCH_FORMATS;
};

const getExtendedCreatePatchFormatsForSizes = (maxSize: number): readonly string[] => {
  if (maxSize > CREATE_LEGACY_PATCH_SIZE_LIMIT_BYTES) return [];
  if (maxSize >= CREATE_IPS_SIZE_LIMIT_BYTES) return EXTENDED_LEGACY_CREATE_PATCH_FORMATS;
  return EXTENDED_SMALL_CREATE_PATCH_FORMATS;
};

// Appends the extended formats allowed for these sizes after the recommended `formats`, and drops the
// formats that cannot truncate when the Modified ROM is smaller than the Original. With
// `requireKnownModifiedSize` (combined patches, whose output size comes from parsed patches and can be
// unknown), an unknown size also drops them, because a shrink cannot be ruled out.
const withExtendedCreatePatchFormats = (
  formats: readonly string[],
  originalSize?: number | null,
  modifiedSize?: number | null,
  requireKnownModifiedSize = false,
): string[] => {
  const extended = getExtendedCreatePatchFormatsForSizes(getMaxCreateRomSize(originalSize, modifiedSize));
  const knownSizes = [originalSize, modifiedSize].filter(
    (size): size is number => typeof size === "number" && size > 0,
  );
  const lengthsDiffer = knownSizes.some((size) => size !== knownSizes[0]);
  const modifiedKnown = typeof modifiedSize === "number" && modifiedSize > 0;
  const shrinks = typeof originalSize === "number" && modifiedKnown && modifiedSize < originalSize;
  const mayShrink = shrinks || (requireKnownModifiedSize && !modifiedKnown);
  const keepsFormat = (format: string) => !(mayShrink && CREATE_NO_SHRINK_FORMATS.includes(format));
  const isOffered = (format: string) => {
    if (formats.includes(format)) return false;
    return keepsFormat(format) && !(lengthsDiffer && format === CREATE_EQUAL_LENGTH_ONLY_FORMAT);
  };
  return [...formats.filter(keepsFormat), ...extended.filter(isOffered)];
};

const getCreatePatchFormatsForSizes = (
  originalSize?: number | null,
  modifiedSize?: number | null,
  requireKnownModifiedSize = false,
): string[] =>
  withExtendedCreatePatchFormats(
    getRecommendedCreatePatchFormatsForSizes(getMaxCreateRomSize(originalSize, modifiedSize)),
    originalSize,
    modifiedSize,
    requireKnownModifiedSize,
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

const getPreferredCreatePatchFormat = ({
  automaticFormatSelection = true,
  candidateDefaultFormat,
  candidateFormats,
  modifiedSize,
  originalSize,
  requestedFormat,
  requireKnownModifiedSize = false,
}: CreatePatchFormatPreferenceInput) => {
  const candidateFormatList = normalizeCandidateCreatePatchFormats(candidateFormats);
  const formats = candidateFormatList.length
    ? withExtendedCreatePatchFormats(candidateFormatList, originalSize, modifiedSize, requireKnownModifiedSize)
    : getCreatePatchFormatsForSizes(originalSize, modifiedSize, requireKnownModifiedSize);
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
  CREATE_IPS_SIZE_LIMIT_BYTES,
  CREATE_LEGACY_PATCH_SIZE_LIMIT_BYTES,
  getCreatePatchFormatsForSizes,
  getPreferredCreatePatchFormat,
  withExtendedCreatePatchFormats,
  normalizeCreatePatchFormat,
};
