type CreatePatchFormatPreferenceInput = {
  automaticFormatSelection?: boolean;
  candidateDefaultFormat?: string | null;
  candidateFormats?: readonly string[] | null;
  modifiedSize?: number | null;
  originalSize?: number | null;
  requestedFormat?: string | null;
};
type CreatePatchFormatList = readonly [string, ...string[]];

const CREATE_IPS_SIZE_LIMIT_BYTES = 16 * 1024 * 1024;
const CREATE_BPS_DEFAULT_LIMIT_BYTES = 128 * 1024 * 1024;
const CREATE_LEGACY_PATCH_SIZE_LIMIT_BYTES = 256 * 1024 * 1024;
const CREATE_PATCH_DEFAULT_FORMAT = "bps";
const CREATE_PATCH_LARGE_DEFAULT_FORMAT = "xdelta";

const SMALL_CREATE_PATCH_FORMATS: CreatePatchFormatList = [
  "bps",
  "xdelta",
  "aps",
  "bdf",
  "ebp",
  "ips",
  "pmsr",
  "ppf",
  "rup",
  "ups",
];
const MEDIUM_CREATE_PATCH_FORMATS: CreatePatchFormatList = ["bps", "xdelta", "aps", "bdf", "pmsr", "ppf", "rup", "ups"];
const MID_LARGE_CREATE_PATCH_FORMATS: CreatePatchFormatList = [
  "xdelta",
  "bps",
  "aps",
  "bdf",
  "pmsr",
  "ppf",
  "rup",
  "ups",
];
const LARGE_CREATE_PATCH_FORMATS: CreatePatchFormatList = ["xdelta", "ppf"];

const normalizeCreatePatchFormat = (format: string | null | undefined) => {
  const normalized = String(format || "")
    .trim()
    .toLowerCase();
  return normalized === "vcdiff" ? "xdelta" : normalized;
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

const createPatchFormatSupportsCreateSizes = (format: string, ...sizes: Array<number | null | undefined>) =>
  getCreatePatchFormatsForSizes(...sizes).includes(normalizeCreatePatchFormat(format));

const getDefaultCreatePatchFormatForSources = ({
  originalSize,
  modifiedSize,
}: CreatePatchFormatPreferenceInput = {}) => {
  return getMaxCreateRomSize(originalSize, modifiedSize) < CREATE_BPS_DEFAULT_LIMIT_BYTES
    ? CREATE_PATCH_DEFAULT_FORMAT
    : CREATE_PATCH_LARGE_DEFAULT_FORMAT;
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
  const formats = candidateFormatList.length ? candidateFormatList : getCreatePatchFormatsForSizes(originalSize, modifiedSize);
  const normalizedRequestedFormat = normalizeCreatePatchFormat(requestedFormat);
  const normalizedCandidateDefaultFormat = normalizeCreatePatchFormat(candidateDefaultFormat);
  const defaultFormat =
    normalizedCandidateDefaultFormat && formats.includes(normalizedCandidateDefaultFormat)
      ? normalizedCandidateDefaultFormat
      : getDefaultCreatePatchFormatForSources({
          automaticFormatSelection,
          modifiedSize,
          originalSize,
        });
  const supportedDefaultFormat = formats.includes(defaultFormat) ? defaultFormat : formats[0];
  if (!normalizedRequestedFormat) return supportedDefaultFormat;
  if (
    automaticFormatSelection &&
    normalizedRequestedFormat === CREATE_PATCH_DEFAULT_FORMAT &&
    formats.includes(supportedDefaultFormat)
  )
    return supportedDefaultFormat;
  return formats.includes(normalizedRequestedFormat) ? normalizedRequestedFormat : supportedDefaultFormat;
};

const getCreatePatchFormatSizeErrorMessage = (
  format: string,
  ...sizes: Array<number | null | undefined>
): string | null => {
  if (createPatchFormatSupportsCreateSizes(format, ...sizes)) return null;
  const normalizedFormat = normalizeCreatePatchFormat(format);
  const maxSize = getMaxCreateRomSize(...sizes);
  if ((normalizedFormat === "ips" || normalizedFormat === "ebp") && maxSize >= CREATE_IPS_SIZE_LIMIT_BYTES) {
    return `Create inputs at or above 16 MiB should use BPS, XDelta, or another large-capable patch type; selected patch type: ${normalizedFormat}`;
  }
  if (maxSize > CREATE_LEGACY_PATCH_SIZE_LIMIT_BYTES) {
    return `Create inputs above 256 MiB require xdelta or PPF patches; selected patch type: ${normalizedFormat}`;
  }
  return `Unsupported patch type for create input sizes: ${normalizedFormat}`;
};

export {
  CREATE_BPS_DEFAULT_LIMIT_BYTES,
  CREATE_IPS_SIZE_LIMIT_BYTES,
  CREATE_LEGACY_PATCH_SIZE_LIMIT_BYTES,
  CREATE_PATCH_DEFAULT_FORMAT,
  createPatchFormatSupportsCreateSizes,
  getCreatePatchFormatSizeErrorMessage,
  getCreatePatchFormatsForSizes,
  getDefaultCreatePatchFormatForSources,
  getPreferredCreatePatchFormat,
  LARGE_CREATE_PATCH_FORMATS,
  normalizeCreatePatchFormat,
};
