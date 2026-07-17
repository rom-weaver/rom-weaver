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
const CREATE_LEGACY_PATCH_SIZE_LIMIT_BYTES = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.limits.legacySizeLimitBytes;
const CREATE_PATCH_DEFAULT_FORMAT = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.defaultFormat;
const CREATE_PATCH_FORMAT_ALIASES = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.aliases as Readonly<Record<string, string>>;

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

const getCreatePatchFormatsForSizes = (...sizes: Array<number | null | undefined>) => {
  const maxSize = getMaxCreateRomSize(...sizes);
  if (maxSize > CREATE_LEGACY_PATCH_SIZE_LIMIT_BYTES) return LARGE_CREATE_PATCH_FORMATS;
  if (maxSize >= CREATE_BPS_DEFAULT_LIMIT_BYTES) return MID_LARGE_CREATE_PATCH_FORMATS;
  if (maxSize >= CREATE_IPS_SIZE_LIMIT_BYTES) return MEDIUM_CREATE_PATCH_FORMATS;
  return SMALL_CREATE_PATCH_FORMATS;
};

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
}: CreatePatchFormatPreferenceInput) => {
  const candidateFormatList = normalizeCandidateCreatePatchFormats(candidateFormats);
  const formats = candidateFormatList.length
    ? candidateFormatList
    : getCreatePatchFormatsForSizes(originalSize, modifiedSize);
  const normalizedRequestedFormat = normalizeCreatePatchFormat(requestedFormat);
  const normalizedCandidateDefaultFormat = normalizeCreatePatchFormat(candidateDefaultFormat);
  // The default comes from Rust: the resolved candidate default already accounts
  // for archive/special-compression inputs. Before candidates resolve, fall back
  // to the preferred-first entry of the size-bucket list (the generated table is
  // ordered best-first) rather than re-deriving the default policy here.
  const supportedDefaultFormat =
    normalizedCandidateDefaultFormat && formats.includes(normalizedCandidateDefaultFormat)
      ? normalizedCandidateDefaultFormat
      : formats[0];
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
  normalizeCreatePatchFormat,
};
